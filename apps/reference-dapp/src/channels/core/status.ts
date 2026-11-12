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
import type { HandoffRecord } from '../../platform/index.ts';
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
const stepState = (run: WorkflowRunProgress, step: WorkflowRunProgress['steps'][number]) => {
  // A step stopped at the run's expiry (BLOCKED) or skipped when the run ended (SKIPPED) while its wallet batch was in the owner's wallet without
  // an answer may have executed: never "stopped before submission", never "not run".
  if ((step.state === 'BLOCKED' || step.state === 'SKIPPED') && step.code === WALLET_BATCH_OUTCOME_UNKNOWN) return 'OUTCOME_UNKNOWN';
  if (run.mode !== 'USER_FUNDED' || step.state !== 'DELEGATED') return step.state;
  const group = (run.groups ?? []).find(g => g.steps[0] <= step.index && step.index <= g.steps[1]);
  return group?.signed ? 'GROUP_SIGNED' : run.state === 'RUNNING' || run.state === 'ATTENTION' ? 'GROUP_WAITING' : 'GROUP_NOT_SIGNED';
};
/**
 * A HALTED run is worded by how it stopped (the server decides from its records): partial, nothing sent, or neither claimed. Without the
 * server's word (an older view, an unknown value) it is a plain HALTED, worded neutrally: never "partially completed", never "nothing was sent".
 * A batch whose outcome is unknown may have executed, so such a run is never "stopped before anything was sent", whatever the view says.
 */
const haltedState = (run: WorkflowRunProgress) => run.state !== 'HALTED' ? run.state : run.halted === 'PARTIAL' ? 'HALTED_PARTIAL'
  : batchOutcomeUnknown(run) ? 'HALTED' : run.halted === 'NOTHING_SENT' || run.halted === 'STOPPED' ? `HALTED_${run.halted}` : 'HALTED';
const runFacts = (run: WorkflowRunProgress): RunFacts => ({ state: haltedState(run),
  steps: run.steps.map(step => ({ index: step.index, action: step.action, state: stepState(run, step), transaction: step.outcome?.submissions[0]?.hash ?? null })) });
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
    lines.push(m.workflowRun(runFacts(run.stepsVisible ? run : { ...run, steps: run.steps.map(s => ({ ...s, outcome: null })) })));
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
export function plannedNotifications(language: ChannelLanguage, handoff: HandoffRecord, progress: Progress, origin?: string, now: Date = new Date()):
  { readonly due: readonly PlannedNotification[]; readonly done: boolean } {
  const m = channelCopy(language), due: PlannedNotification[] = [];
  // BUILD-CHAT-E2E-001: a running workflow outlives its approval link's own window, so its run decides (not the link's expiry).
  if (progress.workflowRun) return workflowNotifications(language, handoff, progress.workflowRun, now, origin);
  if (ENDED.has(progress.status)) return { due, done: true };
  if (!handoff.shareStatus || (progress.status !== 'CLAIMED' && progress.status !== 'APPLIED')) return { due, done: false };
  due.push({ key: `notify:${handoff.handoffId}:loaded`, text: m.loaded });
  for (const run of progress.runs) {
    const id = createHash('sha256').update(run.executionId).digest('hex').slice(0, 16);
    // Preparation creates a run too. Keep its notice distinct so it cannot consume a later authorization/submission notice.
    // A landed label keys its own notice by what it means (not sent, pending, failed, unresolved, …), so a later outcome under the same summary
    // status (e.g. Uniswap falling back to AUTHORIZED after a reverted mint) is still sent once, and never shadowed by an earlier notice.
    const landed = runLandedKind(run);
    if (!run.terminal) due.push({ key: `notify:${handoff.handoffId}:run:${id}:state:${run.status.toLowerCase()}${landed ? `:landed:${landed}` : ''}`, text: shorten(m.run(run)) });
    else due.push({ key: `notify:${handoff.handoffId}:run:${id}:${run.reconciled ? 'reconciled' : 'ended'}`, text: shorten(m.run(run)) });
  }
  // An incomplete run read never ends the follow-up (an unread run may still be in flight).
  return { due, done: progress.runsComplete !== false && progress.runs.length > 0 && progress.runs.every(r => r.terminal) };
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
  const done = !OPEN_RUN.has(run.state), unknown = batchOutcomeUnknown(run);
  if (!handoff.shareStatus || !run.stepsVisible) return { due, done };
  for (const step of run.steps) if (['RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED'].includes(step.state))
    due.push({ key: key(`step:${step.index}:${step.state.toLowerCase()}${step.state === 'BLOCKED' ? `:${keyPart(step.code)}` : ''}`),
      text: shorten(m.workflowRun(runFacts({ ...run, steps: [step] }))) });
  if (run.nextAction === 'OWNER_SIGNS_STEP' && run.currentStep > 0 && origin)
    due.push({ key: key(`ready:${run.currentStep}`), text: m.stepReady(run.currentStep + 1, continuationUrl(origin, handoff.handoffId)) });
  // A later user-funded group that became due (e.g. after a bridge delivered) is announced like a step: the owner's wallet signs it in FloFi.
  if (run.nextAction === 'OWNER_SIGNS_GROUP' && run.currentStep > 0 && origin)
    due.push({ key: key(`ready-group:${run.currentStep}`), text: m.stepReady(run.currentStep + 1, continuationUrl(origin, handoff.handoffId)) });
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
      due.push({ key: key(`batch-answered:${from}`), text: m.batchAnswered(from + 1, to + 1, continuationUrl(origin, handoff.handoffId)) });
  }
  if (run.state === 'COMPLETED') due.push({ key: key('done'), text: m.runDone });
  else if (run.state === 'HALTED') {
    const entered = Date.parse(run.updatedAt);
    // A halt with a batch whose outcome is unknown is keyed apart, so its "may have executed" notice is never shadowed by a plain halt notice.
    due.push({ key: key(`halted:${run.currentStep}:${keyPart(run.halted)}:${keyPart(run.code)}${unknown ? ':unknown' : ''}${Number.isFinite(entered) ? `:${entered}` : ''}`),
      text: unknown ? m.runHaltedBatchUnknown(run.halted === 'PARTIAL') : run.halted === 'PARTIAL' ? m.runHalted
        : run.halted === 'NOTHING_SENT' ? m.runHaltedNothingSent(run.resumable === true) : run.halted === 'STOPPED' ? m.runHaltedStopped : m.runHaltedUnclassified });
  } else if (run.state === 'ATTENTION') {
    // Once per step: a later step's submission without a final outcome is a new fact (the run goes back to RUNNING when a step settles).
    due.push({ key: key(`attention:${run.currentStep}`), text: m.runAttention });
  } else if (done) due.push({ key: key('ended'), text: unknown ? m.runEndedBatchUnknown : m.runEnded(run.code ?? run.state) });
  return { due, done };
}
