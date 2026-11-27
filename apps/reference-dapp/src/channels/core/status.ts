// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: what a conversation may learn about its own proposals — read from the shared platform, written by FloFi.
 *
 * The approval's state is always visible to the conversation that created it. Runs started from it are visible ONLY while the wallet
 * owner shares them (their explicit choice on /approve, default off for channels), and then only as public facts: the run id is not
 * exposed as a separate fact — its owner-scoped receipt link, status, reconciliation, evidence environment and outcome are shared
 * exactly as FloFi recorded them (MOCKED stays MOCKED). Never the claiming wallet, transaction bytes, calldata or a signature.
 */
import { createHash } from 'node:crypto';
import { composeWorkflowBound } from '../../engine/strategy-engine';
import { batchPaymentViews, type HandoffRecord } from '../../platform/index.ts';
import type { channelApprovalProgress } from './approval.ts';
import type { ChannelLanguage } from './config.ts';
import { channelCopy, runLandedKind, shorten, type RunFacts } from './copy.ts';
import type { ChannelReply } from './types.ts';

type Progress = NonNullable<Awaited<ReturnType<typeof channelApprovalProgress>>>['progress'];
const text = (value: string): ChannelReply => ({ text: shorten(value), choices: [], link: null });
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
export const ENDED = new Set(['EXPIRED', 'SUPERSEDED', 'REVOKED', 'STALE']);
/** BUILD-CHAT-E2E-001: a run the conversation can still hear about (a halted one may resume). */
export const OPEN_RUN = new Set(['PENDING', 'RUNNING', 'ATTENTION', 'HALTED']);
type WorkflowRunProgress = NonNullable<Progress['workflowRun']>;
/**
 * The step/group code of a wallet batch handed to the owner's wallet whose answer never reached FloFi before the run stopped at its expiry
 * (BLOCKED) or ended (SKIPPED) (`workflow-runs/state-machine.ts`; named here because Channel Core reads runs only through the shared platform's
 * view, `boundaries.test.ts`). The wallet may have executed that batch before its on-chain deadline: FloFi cannot know.
 */
const WALLET_BATCH_OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
/** Whether a batch of the run may have executed without FloFi knowing (a step or group carries WALLET_BATCH_OUTCOME_UNKNOWN). */
const batchOutcomeUnknown = (run: WorkflowRunProgress) => [...run.groups ?? [], ...run.steps].some(item => item.code === WALLET_BATCH_OUTCOME_UNKNOWN);
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: in a user-funded run a grouped step is DELEGATED from the start (its group, not FloFi, holds it): it reads
 * "signed in your wallet" once the owner's wallet answered for its group — never "authorized" before that — and, until then, "waiting for your
 * wallet" only while the run can still ask for it (RUNNING or ATTENTION). In a halted or ended run nothing waits for the wallet any more: an
 * unsigned grouped step reads a neutral "not signed".
 */
const stepState = (run: WorkflowRunProgress, step: WorkflowRunProgress['steps'][number], unprovable: readonly [number, number] | null = null) => {
  // A step stopped at the run's expiry (BLOCKED) or skipped when the run ended (SKIPPED) while its wallet batch was in the owner's wallet without
  // an answer may have executed: never "stopped before submission", never "not run".
  if ((step.state === 'BLOCKED' || step.state === 'SKIPPED') && step.code === WALLET_BATCH_OUTCOME_UNKNOWN) return 'OUTCOME_UNKNOWN';
  if (run.mode !== 'USER_FUNDED' || step.state !== 'DELEGATED') return step.state;
  const group = (run.groups ?? []).find(g => g.steps[0] <= step.index && step.index <= g.steps[1]);
  if (group?.signed) return 'GROUP_SIGNED';
  // Review SEC-3: once the owner decides about an unprovable Batch Payment request (`unprovableBatchRequest`), nothing waits for the wallet any more:
  // that request's legs may have executed, and every other unsigned leg reads "not signed".
  if (unprovable) return unprovable[0] <= step.index && step.index <= unprovable[1] ? 'OUTCOME_UNKNOWN' : 'GROUP_NOT_SIGNED';
  return run.state === 'RUNNING' || run.state === 'ATTENTION' ? 'GROUP_WAITING' : 'GROUP_NOT_SIGNED';
};
/**
 * A HALTED run is worded by how it stopped (the server decides from its records): partial, nothing sent, or neither claimed. Without the
 * server's word (an older view, an unknown value) it is a plain HALTED, worded neutrally: never "partially completed", never "nothing was sent".
 * A batch whose outcome is unknown may have executed, so such a run is never "stopped before anything was sent", whatever the view says.
 */
const haltedState = (run: WorkflowRunProgress) => run.state !== 'HALTED' ? run.state : run.halted === 'PARTIAL' ? 'HALTED_PARTIAL'
  : batchOutcomeUnknown(run) ? 'HALTED' : run.halted === 'NOTHING_SENT' || run.halted === 'STOPPED' ? `HALTED_${run.halted}` : 'HALTED';

/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review CH-3): a run's steps are its executable legs, and a Batch Payment runs as one leg per recipient,
 * yet it is ONE step of what the person authored. Each `Unit` is one of the person's steps: a Batch Payment's legs reported (and announced) as that
 * one step, named as the Batch Payment with its recipients and total; every other leg is its own step, numbered as the person authored it. A run
 * whose approval's strategy names no Batch Payment (or no longer composes to the run's own hash) is reported leg by leg, exactly as before.
 */
type RunStep = WorkflowRunProgress['steps'][number];
type Unit = { readonly index: number; readonly legs: readonly RunStep[]; readonly batch: string | null };
type PersonSteps = { readonly stepOf: (leg: number) => number; readonly units: (run: WorkflowRunProgress) => readonly Unit[];
  /** Whether a leg is one payment of a Batch Payment (never, for a run reported leg by leg). */
  readonly batchLeg: (leg: number) => boolean };
const LEG_BY_LEG: PersonSteps = { stepOf: leg => leg, units: run => run.steps.map(step => ({ index: step.index, legs: [step], batch: null })), batchLeg: () => false };
const BATCH_LABEL: Readonly<Record<ChannelLanguage, (total: string | null, asset: string, recipients: readonly string[]) => string>> = {
  EN: (total, asset, r) => `Batch Payment${total ? ` of ${total} ${asset}` : ''} to ${r.length} recipients (${r.join(', ')})`,
  PT: (total, asset, r) => `Pagamento em lote${total ? ` de ${total} ${asset}` : ''} para ${r.length} destinatários (${r.join(', ')})`,
};
function personSteps(language: ChannelLanguage, handoff: HandoffRecord, run: WorkflowRunProgress): PersonSteps {
  // A status read or a notification sweep never fails on presentation: anything that does not compose is reported leg by leg.
  let composed: ReturnType<typeof composeWorkflowBound>, views: ReturnType<typeof batchPaymentViews>;
  try {
    composed = composeWorkflowBound(handoff.strategy, run.workflowHash);
    views = composed.ok ? batchPaymentViews(composed) : [];
  } catch { return LEG_BY_LEG; }
  const batches = composed.ok ? composed.batches ?? [] : [];
  if (!composed.ok || !batches.length) return LEG_BY_LEG;
  const stepOf = (leg: number) => {
    let shift = 0;
    for (const b of batches) {
      if (b.from <= leg && leg <= b.to) return b.step;
      if (b.to < leg) shift += b.to - b.from;
    }
    return leg - shift;
  };
  const label = (b: (typeof batches)[number]) => {
    const view = views.find(v => v.step === b.step), strategy = b.composition.strategy as { recipients?: readonly { recipient?: unknown }[] };
    const recipients = (strategy.recipients ?? []).map(line => String(line.recipient ?? ''));
    return BATCH_LABEL[language](view?.total ?? null, b.asset, recipients);
  };
  return { stepOf, batchLeg: leg => batches.some(b => b.from <= leg && leg <= b.to), units: run => {
    const out: Unit[] = [];
    for (const step of run.steps) {
      const b = batches.find(x => x.from <= step.index && step.index <= x.to);
      const last = out.at(-1);
      if (b && last?.batch !== null && last?.index === b.step) { out[out.length - 1] = { ...last, legs: [...last.legs, step] }; continue; }
      out.push({ index: stepOf(step.index), legs: [step], batch: b ? label(b) : null });
    }
    return out;
  } };
}
/**
 * The one state a Batch Payment's legs are reported with. They run as ONE atomic authorization, so they normally agree; when they do not, the
 * least final state wins (an unknown or pending outcome over a failure, anything over "reconciled"): never a better word than its worst leg.
 */
const UNIT_STATE_ORDER = ['OUTCOME_UNKNOWN', 'UNCERTAIN', 'AWAITING_OWNER', 'FAILED', 'BLOCKED', 'GROUP_WAITING', 'GROUP_SIGNED', 'GROUP_NOT_SIGNED', 'DELEGATED', 'READY',
  'PENDING', 'SKIPPED', 'RECONCILED'];
const unitState = (states: readonly string[]) => states.every(s => s === states[0]) ? states[0]!
  : states.find(s => !UNIT_STATE_ORDER.includes(s)) ?? UNIT_STATE_ORDER.find(s => states.includes(s))!;
const unitFact = (run: WorkflowRunProgress, unit: Unit, unprovable: readonly [number, number] | null = null): RunFacts['steps'][number] => unit.batch === null
  ? { index: unit.index, action: unit.legs[0]!.action, state: stepState(run, unit.legs[0]!, unprovable), transaction: unit.legs[0]!.outcome?.submissions[0]?.hash ?? null }
  : { index: unit.index, action: unit.batch, state: unitState(unit.legs.map(leg => stepState(run, leg, unprovable))),
    transaction: unit.legs.map(leg => leg.outcome?.submissions[0]?.hash ?? null).find(Boolean) ?? null };
const runFacts = (run: WorkflowRunProgress, people: PersonSteps = LEG_BY_LEG): RunFacts => {
  const unprovable = unprovableBatchRequest(run, people);
  return { state: haltedState(run), steps: people.units(run).map(unit => unitFact(run, unit, unprovable)) };
};

/**
 * Review CH-4: the code a wallet batch group and its steps carry when the wallet split the batch into several transactions and only some succeeded
 * (`user-funded/evm-reconcile.ts`, named here as `WALLET_BATCH_OUTCOME_UNKNOWN` is). Part of it executed: never "no final outcome yet".
 */
const WALLET_BATCH_PARTIALLY_EXECUTED = 'WALLET_BATCH_PARTIALLY_EXECUTED';
const batchPartlyExecuted = (run: WorkflowRunProgress) => run.code === WALLET_BATCH_PARTIALLY_EXECUTED
  || [...run.groups ?? [], ...run.steps].some(item => item.code === WALLET_BATCH_PARTIALLY_EXECUTED);
const PARTLY_EXECUTED: Readonly<Record<ChannelLanguage, string>> = {
  EN: 'Part of a batch executed: your wallet sent it as several transactions and only some of them succeeded. FloFi never sends it again. Check each of its '
    + 'transactions in your wallet\'s activity.',
  PT: 'Parte de um lote foi executada: a sua carteira o enviou como várias transações e só algumas tiveram sucesso. O FloFi nunca o envia de novo. Confira cada '
    + 'uma das transações dele na atividade da sua carteira.',
};
/**
 * Review SEC-3: the code a wallet batch group carries once the owner's wallet refused its request (`workflow-runs/state-machine.ts`, named here as
 * `WALLET_BATCH_OUTCOME_UNKNOWN` is). Its own OWNER_DECIDES is not an unprovable request: the wallet answered.
 */
const WALLET_BATCH_REFUSAL_RECORDED = 'WALLET_BATCH_REFUSAL_RECORDED';
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review SEC-3): the legs [from, to] of a Batch Payment request handed to the owner's wallet that was never
 * answered and that the chain can never prove unsent. The server never hands it out again and says the owner decides (`nextAction` OWNER_DECIDES
 * while the run is RUNNING or ATTENTION, for its unsigned group that is no recorded refusal). Null otherwise, and for a run reported leg by leg.
 */
function unprovableBatchRequest(run: WorkflowRunProgress, people: PersonSteps): readonly [number, number] | null {
  if (run.mode !== 'USER_FUNDED' || run.nextAction !== 'OWNER_DECIDES' || (run.state !== 'RUNNING' && run.state !== 'ATTENTION')) return null;
  const group = (run.groups ?? []).find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]);
  if (!group || group.strategy !== 'EVM_WALLET_BATCH' || group.signed || group.code === WALLET_BATCH_REFUSAL_RECORDED) return null;
  for (let leg = group.steps[0]; leg <= group.steps[1]; leg++) if (people.batchLeg(leg)) return group.steps;
  return null;
}
const OWNER_DECIDES_BATCH: Readonly<Record<ChannelLanguage, string>> = {
  EN: 'FloFi never recorded your wallet\'s answer to this Batch Payment request, and the chain cannot prove it was never sent, so FloFi never hands it to '
    + 'your wallet again: it may have executed. Check your wallet\'s activity, then end the run in FloFi and start a new Review.',
  PT: 'O FloFi nunca registrou a resposta da sua carteira a este pedido de Pagamento em lote, e a rede não consegue provar que ele nunca foi enviado, então o '
    + 'FloFi nunca o entrega de novo à sua carteira: ele pode ter sido executado. Confira a atividade da sua carteira, depois encerre o fluxo no FloFi e comece '
    + 'uma nova Revisão.',
};
/** The non-secret continuation link of a multi-step approval: only the run owner's proven wallet can open it. */
export const continuationUrl = (origin: string, approvalId: string) => `${origin}/approve#${approvalId}`;

/** The reply to STATUS for this conversation's most recent proposal. */
export function statusReplies(language: ChannelLanguage, found: { readonly handoff: HandoffRecord; readonly progress: Progress } | null): ChannelReply[] {
  const m = channelCopy(language);
  if (!found) return [text(m.noApproval)];
  const { progress } = found, run = progress.workflowRun;
  // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: once a run was authorized (it left PENDING), the approval link's own expiry no longer describes the
  // workflow, so an ended approval is not reported above a live or finished run ("Proposal expired" over "Workflow: running" would contradict it).
  const lines = run && run.state !== 'PENDING' && ENDED.has(progress.status) ? [] : [m.approval(progress.status, hhmm(progress.expiresAt))];
  // BUILD-CHAT-E2E-001: a multi-step approval reports its run: step states always, transactions only while the owner shares status.
  if (run) {
    const people = personSteps(language, found.handoff, run);
    lines.push(m.workflowRun(runFacts(run.stepsVisible ? run : { ...run, steps: run.steps.map(s => ({ ...s, outcome: null })) }, people)));
    // Review CH-4: a batch that executed in part says so (the step reads "outcome pending", which alone would understate it).
    if (batchPartlyExecuted(run)) lines.push(PARTLY_EXECUTED[language]);
    // Review SEC-3: an unprovable Batch Payment request is the owner's decision, never "waiting for your wallet".
    if (unprovableBatchRequest(run, people)) lines.push(OWNER_DECIDES_BATCH[language]);
    if (!run.stepsVisible) lines.push(m.notShared);
    return [text(lines.join('\n'))];
  }
  if (progress.status === 'APPLIED') {
    if (!progress.runsVisible) lines.push(m.notShared);
    // BUILD-FLOFI-E2E-RELIABILITY-001: a failed run read is never "no record" — the runs read so far are listed, then the unknown remainder.
    else if (progress.runsComplete === false) lines.push(...progress.runs.map(m.run), m.runsUnknown);
    // Older runs of the wallet were not examined: no run found among the recent ones is never "no record".
    else if (!progress.runs.length) lines.push(progress.runsTruncated ? m.runsOlder : m.noRuns);
    else lines.push(...progress.runs.map(m.run));
  }
  return [text(lines.join('\n'))];
}

export type PlannedNotification = { readonly key: string; readonly text: string };
/**
 * Notifications due for a handoff's progress, each with a stable key (so a repeated check never sends twice): "loaded in FloFi" once
 * the owner claimed it and shares status, then each recorded lifecycle state once and its terminal outcome once. `done` once nothing more can
 * follow. `now`: the moment of this check (a wallet batch's answer is announced only once its validity has passed).
 */
/**
 * `native` (BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001): the approval is signed in the owner's wallet app with its Review in this conversation, which
 * already told each step: "loaded in FloFi" and the pre-submission run states ("waiting for your review and wallet authorization in FloFi") would
 * send the person to FloFi, so they are left out (and a run still before submission neither ends nor extends the follow-up). Every run from its
 * submission on — sent, pending, reconciled with its receipt, failed — is notified as for every approval.
 */
const BEFORE_SUBMISSION = new Set(['SIMULATED', 'AUTHORIZED', 'PREPARED', 'CANCELLED']);
export function plannedNotifications(language: ChannelLanguage, handoff: HandoffRecord, progress: Progress, origin?: string, now: Date = new Date(), native = false):
  { readonly due: readonly PlannedNotification[]; readonly done: boolean } {
  const m = channelCopy(language), due: PlannedNotification[] = [];
  // BUILD-CHAT-E2E-001: a running workflow outlives its approval link's own window, so its run decides (not the link's expiry).
  if (progress.workflowRun) return workflowNotifications(language, handoff, progress.workflowRun, now, origin);
  if (ENDED.has(progress.status)) return { due, done: true };
  if (!handoff.shareStatus || (progress.status !== 'CLAIMED' && progress.status !== 'APPLIED')) return { due, done: false };
  if (!native) due.push({ key: `notify:${handoff.handoffId}:loaded`, text: m.loaded });
  const runs = native ? progress.runs.filter(r => !BEFORE_SUBMISSION.has(r.status) || r.landed) : progress.runs;
  for (const run of runs) {
    const id = createHash('sha256').update(run.executionId).digest('hex').slice(0, 16);
    // Preparation creates a run too. Keep its notice distinct so it cannot consume a later authorization/submission notice.
    // A landed label keys its own notice by what it means (not sent, pending, failed, unresolved, …), so a later outcome under the same summary
    // status (e.g. Uniswap falling back to AUTHORIZED after a reverted mint) is still sent once, and never shadowed by an earlier notice.
    const landed = runLandedKind(run);
    if (!run.terminal) due.push({ key: `notify:${handoff.handoffId}:run:${id}:state:${run.status.toLowerCase()}${landed ? `:landed:${landed}` : ''}`, text: shorten(m.run(run)) });
    else due.push({ key: `notify:${handoff.handoffId}:run:${id}:${run.reconciled ? 'reconciled' : 'ended'}`, text: shorten(m.run(run)) });
  }
  // An incomplete run read never ends the follow-up (an unread run may still be in flight).
  return { due, done: progress.runsComplete !== false && runs.length > 0 && runs.every(r => r.terminal) };
}

/** A code or classification as a notification key part: the outbox accepts only `[a-z0-9_.:-]` (and at most 160 characters in all). */
const keyPart = (value: string | null | undefined) => (value ?? 'none').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
/**
 * BUILD-CHAT-E2E-001: notifications of a multi-step workflow's run, while its owner shares status: each step's outcome once (reconciled, failed,
 * uncertain, stopped), "step N is ready for your signature" once per step (with the continuation link), and the run's end once. `done` once the run
 * is over (a halted run may still resume, so it is followed until it ends).
 *
 * A run can halt, be resumed and halt again (the outbox sends each key once): a halt's key names that halt — the step, how it stopped, its code
 * and the moment the run entered HALTED (a halted run's row changes only when it leaves HALTED, so `updatedAt` is that moment until it resumes or
 * ends) — a step stopped again after a resume is keyed by its code too, and "needs attention" by its step, so a later stop is announced instead of
 * shadowed by the first one.
 *
 * A run with a wallet batch whose outcome is unknown (WALLET_BATCH_OUTCOME_UNKNOWN) halts or ends (by its owner, expired or failed) saying that
 * batch may have executed and the owner should check the wallet's activity: never "stopped before any step completed", "nothing was sent",
 * "not run" or only the code it ended with.
 */
function workflowNotifications(language: ChannelLanguage, handoff: HandoffRecord, run: WorkflowRunProgress, now: Date, origin?: string) {
  const m = channelCopy(language), due: PlannedNotification[] = [], key = (suffix: string) => `notify:${handoff.handoffId}:wfr:${suffix}`;
  const done = !OPEN_RUN.has(run.state), unknown = batchOutcomeUnknown(run), partly = batchPartlyExecuted(run);
  if (!handoff.shareStatus || !run.stepsVisible) return { due, done };
  // Review CH-3: numbered as the person's steps (a Batch Payment is one step, announced once for all its legs); keyed by that step.
  const people = personSteps(language, handoff, run), current = people.stepOf(run.currentStep), unprovable = unprovableBatchRequest(run, people);
  for (const unit of people.units(run)) {
    const state = unitState(unit.legs.map(leg => leg.state)), code = unit.legs.find(leg => leg.state === state)?.code ?? null;
    if (['RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED'].includes(state))
      due.push({ key: key(`step:${unit.index}:${state.toLowerCase()}${state === 'BLOCKED' ? `:${keyPart(code)}` : ''}`),
        text: shorten(m.workflowRun({ state: haltedState(run), steps: [unitFact(run, unit, unprovable)] })) });
  }
  if (run.nextAction === 'OWNER_SIGNS_STEP' && current > 0 && origin)
    due.push({ key: key(`ready:${run.currentStep}`), text: m.stepReady(current + 1, continuationUrl(origin, handoff.handoffId)) });
  // A later user-funded group that became due (e.g. after a bridge delivered) is announced like a step: the owner's wallet signs it in FloFi.
  if (run.nextAction === 'OWNER_SIGNS_GROUP' && current > 0 && origin)
    due.push({ key: key(`ready-group:${run.currentStep}`), text: m.stepReady(current + 1, continuationUrl(origin, handoff.handoffId)) });
  // The owner's wallet answered a batch (FloFi recorded its id) but no browser reported its transactions yet: only the owner's FloFi page can read
  // them back from the wallet, so the run waits for it — announced once per group (a signed group is never resumed or answered again), even for
  // the first group (the owner may have closed FloFi right after the wallet answered). It may have executed: never "sent", never "not sent".
  // Every ordinary confirmation passes through this state too (the group stays AUTHORIZED until the open page reports the batch final, and
  // /approve pings notifications meanwhile), so it is announced only once the group's validity (`validUntil`, the batch's on-chain deadline,
  // visible to requesters) has passed: by then no late confirmation can execute it and an open page would normally have reported it. A group
  // without a readable validity (an older view) is announced as before: the conservative side is never staying silent about an answered batch.
  if (run.nextAction === 'OWNER_CONFIRMS_BATCH' && origin) {
    const group = (run.groups ?? []).find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]);
    const [from, to] = group?.steps ?? [run.currentStep, run.currentStep], validUntil = group?.validUntil ? Date.parse(group.validUntil) : Number.NaN;
    if (!Number.isFinite(validUntil) || validUntil <= now.getTime())
      due.push({ key: key(`batch-answered:${from}`), text: m.batchAnswered(people.stepOf(from) + 1, people.stepOf(to) + 1, continuationUrl(origin, handoff.handoffId)) });
  }
  if (run.state === 'COMPLETED') due.push({ key: key('done'), text: m.runDone });
  else if (run.state === 'HALTED') {
    const entered = Date.parse(run.updatedAt);
    // A halt with a batch whose outcome is unknown is keyed apart, so its "may have executed" notice is never shadowed by a plain halt notice.
    // Review CH-4: so is a halt with a batch that executed in part (never "stopped before any step completed").
    due.push({ key: key(`halted:${run.currentStep}:${keyPart(run.halted)}:${keyPart(run.code)}${unknown ? ':unknown' : ''}${!unknown && partly ? ':partial' : ''}`
      + `${Number.isFinite(entered) ? `:${entered}` : ''}`),
      text: unknown ? m.runHaltedBatchUnknown(run.halted === 'PARTIAL') : partly ? PARTLY_EXECUTED[language] : run.halted === 'PARTIAL' ? m.runHalted
        : run.halted === 'NOTHING_SENT' ? m.runHaltedNothingSent(run.resumable === true) : run.halted === 'STOPPED' ? m.runHaltedStopped : m.runHaltedUnclassified });
  } else if (run.state === 'ATTENTION') {
    // Once per step: a later step's submission without a final outcome is a new fact (the run goes back to RUNNING when a step settles).
    // Review CH-4: a batch that executed in part is keyed apart and said as such, never "no final outcome yet".
    due.push(partly ? { key: key(`attention:${run.currentStep}:partial`), text: PARTLY_EXECUTED[language] } : { key: key(`attention:${run.currentStep}`), text: m.runAttention });
  } else if (done) due.push(!unknown && partly ? { key: key('ended:partial'), text: PARTLY_EXECUTED[language] }
    : { key: key('ended'), text: unknown ? m.runEndedBatchUnknown : m.runEnded(run.code ?? run.state) });
  return { due, done };
}
