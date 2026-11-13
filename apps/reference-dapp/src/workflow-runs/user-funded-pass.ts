// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: how a USER_FUNDED run advances, one execution group at a time (`execution-groups.ts`). Safe to run any
 * number of times, concurrently, after any crash: every move is a compare-and-set on the run, the group or the step, and every submission
 * is the exact artifact the owner authorized (a resend is the same bytes / the same user operation, never a new one).
 *
 *   owner-step group      exactly the confirm-each-step rules for its step (its own flow, the owner's wallet confirms, observed and reconciled)
 *   PLANNED               waits for its owner (signed when due, or upfront at the start): nothing is ever prepared or signed by FloFi
 *   PREPARED              waits for the owner's wallet; past its validity it is EXPIRED and prepared again on request — except a wallet batch,
 *                         which the wallet itself sends when the owner confirms: it is never dropped silently (a late answer is still taken)
 *   run expiry            a PLANNED or PREPARED group is BLOCKED — a wallet batch only once its validity passed (until then the wallet may still
 *                         confirm it before its on-chain deadline); a batch handed out and never answered HALTS the run, never FAILS it, and
 *                         its group and steps carry WALLET_BATCH_OUTCOME_UNKNOWN (it may have executed)
 *   AUTHORIZED            wallet batch: the wallet already sent it; FloFi waits for the hashes the owner's browser reports.
 *                         user operation: due when the previous group reconciled; simulated by the bundler, then relayed (owner-paid).
 *                         Solana: started only while the signed blockhash leaves the send budget (else BLOCKED, nothing sent); every
 *                         signature is recorded, then each transaction is sent after its predecessor confirmed.
 *   SUBMITTED/UNCERTAIN   reconciled from the chain only; per-step spent/received and the gas the owner paid become the steps' outcomes.
 *                         P0 hotfix (E1): a batch that carried a bridge reconciles its source steps at once, while its bridge step (and the group)
 *                         waits for the verified destination delivery (`bridge-delivery.ts`): AWAITING_DESTINATION until the Across fill of THIS
 *                         deposit is final, then RECONCILED (its received = the fill's output); no fill past the fill deadline: the group is
 *                         UNCERTAIN and the run needs ATTENTION (observed again, never resent); a verified refund FAILS the bridge step
 *
 * A group that cannot start (a refused simulation, a signer mismatch, a delivery below what was signed) is BLOCKED before anything is sent:
 * the run HALTS after earlier reconciled steps (funds rest in the owner's wallet), else FAILS. A reverted group FAILS its steps.
 */
import { composeWorkflowBound, type WorkflowComposition } from '../engine/strategy-engine';
import { boundStrategy } from '../engine/workflow-bindings';
import { assetKey } from '../delegation/steps.ts';
import { advanceSolanaSubmission, checkUserOperation, koraGroupProgress, koraGroupSubmission, reconcileEvmGroup, reconcileSolanaGroup, relayUserOperation, solanaSendBudget,
  solanaSubmission, type Prepared, type Reconciled, type UserFundedDeps } from '../user-funded/groups.ts';
import type { EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { bridgeOf, bridgeProgressOf, observeBridgeDelivery, type BridgeDelivery } from '../user-funded/bridge-delivery.ts';
import type { BoundResolution, GroupRecord, RunRecord, RunStepRecord, StepOutcome, WorkflowRunStore } from './pg-store.ts';
import { ADVANCE_RETRY_MS, TERMINAL_RUN, WALLET_BATCH_OUTCOME_UNKNOWN, WALLET_BATCH_SETTLE_MS, groupInFlight, walletBatchUnanswered, type RunState } from './state-machine.ts';
import { executionRefusal } from '../server/execution-guard.ts';
import { plannedStrategyOf } from '../user-funded/circle-gas.ts';

export type Pass = { readonly state: RunState; readonly code: string | null; readonly retryMs: number | null; readonly progressed: boolean };
export type UserFundedPassDeps = {
  readonly store: WorkflowRunStore; readonly userFunded: UserFundedDeps | null; readonly now: () => Date;
  readonly log: (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
  /** The confirm-each-step pass (owner-step groups run exactly as confirm mode). */
  readonly confirmPass: (run: RunRecord) => Promise<Pass>;
};
const OWNER_WAIT_MS = 5 * 60_000, SUBMIT_RETRY_MS = 15_000;
const TRANSIENT = new Set(['USER_FUNDED_RPC_UNAVAILABLE', 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE', 'USER_OPERATION_BUNDLER_UNAVAILABLE', 'DELEGATION_RPC_UNAVAILABLE',
  'SOLANA_RPC_UNAVAILABLE', 'SOLANA_RPC_RATE_LIMITED']);
const settled = (run: RunRecord, retryMs: number | null = null, progressed = false, code: string | null = run.code): Pass => ({ state: run.state, code, retryMs, progressed });
/** A code stored on a group, its steps and its run: the runs/steps/events grammar (a detail after `:` is dropped, never the whole code). */
const stored = (code: string) => { const head = code.split(':')[0]!; return /^[A-Z][A-Z0-9_]{2,80}$/.test(head) ? head : 'USER_FUNDED_GROUP_REFUSED'; };
const ownerStep = (g: GroupRecord) => g.strategy === 'EVM_OWNER_STEP' || g.strategy === 'SOLANA_OWNER_STEP';

/** The strategy a grouped step actually executed (its bound amount fixed to what it spent), for its RECONCILED record. */
function executedStrategy(composed: WorkflowComposition, index: number, spent: string | null) {
  const base = composed.steps[index]!.strategy, binding = composed.bindings.find(b => b.step === index);
  return binding && spent ? boundStrategy(base, BigInt(spent), binding.asset.decimals, binding.inputAsset) : base;
}

/**
 * Stops an open run after the caller's own group write won: from the run's CURRENT version (it may have moved while the group was read, e.g. a
 * status poll advanced it), a few attempts, never from a terminal or HALTED run. Null when the run was no longer RUNNING or ATTENTION.
 */
export async function stopRunFromCurrent(deps: { readonly store: Pick<WorkflowRunStore, 'byId' | 'transition'> }, runId: string, to: 'HALTED' | 'FAILED',
  code: string): Promise<RunRecord | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await deps.store.byId(runId);
    if (!current || !['RUNNING', 'ATTENTION'].includes(current.state)) return null;
    const moved = await deps.store.transition(runId, { version: current.version, from: ['RUNNING', 'ATTENTION'] }, to, { code });
    if (moved) return moved;
  }
  return null;
}

export async function userFundedPass(deps: UserFundedPassDeps, run: RunRecord): Promise<Pass> {
  if (run.state === 'PENDING' || run.state === 'CANCELLED' || run.state === 'EXPIRED') return settled(run);
  await syncOwnerGroups(deps, run.runId);
  const groups = await deps.store.groups(run.runId), steps = await deps.store.steps(run.runId);
  if (TERMINAL_RUN.includes(run.state) || run.state === 'HALTED') return settled(run);
  const k = run.currentStep, g = groups.find(x => x.stepFrom <= k && k <= x.stepTo);
  if (!g) return settled(run);
  if (ownerStep(g)) { const pass = await deps.confirmPass(run); await syncOwnerGroups(deps, run.runId); return pass; }
  const now = deps.now();
  const block = async (refusal: string): Promise<Pass> => {
    const code = stored(refusal);
    // A wallet batch handed to the owner's wallet and never answered may have executed (its answer lost on the way): the run HALTS (its owner
    // ends it, and is told to check the wallet's activity), never FAILED, which would say nothing irreversible happened. Its group and steps
    // carry WALLET_BATCH_OUTCOME_UNKNOWN, never the bare stop reason, so no surface words them as "not run" or the run as stopped before any
    // step completed; the run itself keeps the reason it stopped (e.g. WORKFLOW_RUN_EXPIRED).
    const unanswered = walletBatchUnanswered(g), marked = unanswered ? WALLET_BATCH_OUTCOME_UNKNOWN : code;
    // Only the pass whose write blocked the group moves its steps and the run, and only from exactly the group state and row version this pass
    // read: a group that moved on elsewhere meanwhile (an authorization that landed, a concurrent pass that submitted it, its transactions may be
    // on their way) is never reported blocked, and never leaves a run failed with a send in flight. Once that write won, the run stops from its
    // CURRENT version (a status poll may have moved it since this pass read it), never left RUNNING behind a blocked group and blocked steps.
    if (!await deps.store.groupTransition(run.runId, g.groupIndex, [g.state], 'BLOCKED', { code: marked }, 'GROUP_STATE', g.version)) return { ...settled(run), progressed: true };
    for (let i = g.stepFrom; i <= g.stepTo; i++) await deps.store.stepTransition(run.runId, i, ['DELEGATED'], 'BLOCKED', { code: marked });
    const partial = steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
    const moved = await stopRunFromCurrent(deps, run.runId, partial || unanswered ? 'HALTED' : 'FAILED', code);
    deps.log('workflow_run.group_blocked', { run: run.runId, group: g.groupIndex, code, partial, unanswered });
    return moved ? settled(moved) : { ...settled(run), progressed: true };
  };
  // At the run's expiry a group nobody signed yet is blocked — never one the owner's wallet may still be confirming: a wallet batch inside its
  // validity (`groupInFlight`) executes if the owner confirms before its on-chain deadline, and that answer must still be taken. It is blocked
  // only once its validity passed (the deadline then reverts any late confirmation). Nothing AUTHORIZED is blocked for expiry (already signed).
  if ((g.state === 'PLANNED' || g.state === 'PREPARED') && run.expiresAt <= now && !groupInFlight(g, now)) return block('WORKFLOW_RUN_EXPIRED');
  switch (g.state) {
    case 'PLANNED': return settled(run, OWNER_WAIT_MS, false, 'OWNER_SIGNS_GROUP');
    case 'PREPARED':
      // A wallet batch may already be on its way: the wallet sends it the moment the owner confirms, whenever that is. It stays PREPARED (its
      // late answer is accepted; a new preparation keeps the same EIP-5792 id) instead of being dropped and offered again as new.
      if (g.validUntil && g.validUntil <= now && g.strategy !== 'EVM_WALLET_BATCH') {
        const expired = await deps.store.groupTransition(run.runId, g.groupIndex, ['PREPARED'], 'EXPIRED', { code: 'USER_FUNDED_PREPARED_EXPIRED' });
        // ADR-0010: an expired Circle-paid preparation gives the group back its planned strategy (native gas is decided afresh when prepared again).
        const planned = expired ? plannedStrategyOf(expired.prepared) : null;
        if (expired) await deps.store.groupTransition(run.runId, g.groupIndex, ['EXPIRED'], 'PLANNED', { prepared: null, validUntil: null, code: null,
          ...planned && planned !== expired.strategy ? { strategy: planned } : {} });
        return { ...settled(run, OWNER_WAIT_MS, false, 'OWNER_SIGNS_GROUP'), progressed: expired !== null };
      }
      // An expired run waiting on a wallet batch is looked at again as soon as that batch's validity has passed.
      return settled(run, run.expiresAt <= now && g.validUntil ? Math.max(1_000, Math.min(OWNER_WAIT_MS, g.validUntil.getTime() + WALLET_BATCH_SETTLE_MS - now.getTime())) : OWNER_WAIT_MS,
        false, 'OWNER_SIGNS_GROUP');
    case 'AUTHORIZED': return authorizedGroup(deps, run, g, block);
    case 'SUBMITTED': case 'UNCERTAIN': return submittedGroup(deps, run, g, steps);
    case 'RECONCILED': return afterGroup(deps, run, g);
    case 'FAILED': {
      // A group that failed on chain while its run is still open (the process stopped between the group's FAILED write and the run's stop,
      // or every stop attempt lost a race): this pass stops the run, so it is never left RUNNING or ATTENTION behind it. Only FAILED heals
      // here — a BLOCKED group is moved back to PLANNED by Resume after the run, so a pass between those two writes must not halt it again.
      const partial = steps.some(s => s.stepIndex <= g.stepTo && s.state === 'RECONCILED');
      const moved = await stopRunFromCurrent(deps, run.runId, partial ? 'HALTED' : 'FAILED', g.code ?? 'USER_FUNDED_GROUP_REFUSED');
      if (moved) deps.log('workflow_run.group_failed_run_stopped', { run: run.runId, group: g.groupIndex, code: g.code, partial });
      return moved ? settled(moved) : settled(run);
    }
    case 'BLOCKED': case 'SKIPPED': case 'EXPIRED': return settled(run);
  }
}

async function authorizedGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord, block: (code: string) => Promise<Pass>): Promise<Pass> {
  const prepared = g.prepared as Prepared, authorization = g.authorization!;
  if (g.strategy === 'EVM_WALLET_BATCH') return settled(run, SUBMIT_RETRY_MS, false, 'OWNER_REPORTS_BATCH');
  // A pause holds an authorized group durably for an operator's resume; it never converts a pause into a permanent execution failure.
  const paused = executionRefusal() ?? await deps.userFunded?.submissionRefusal?.({
    namespace: g.chain.startsWith('solana:') ? 'solana' : 'eip155', address: g.feePayer }, run.owner);
  if (paused) return settled(run, SUBMIT_RETRY_MS, false, paused);
  if (!deps.userFunded) return settled(run, ADVANCE_RETRY_MS, false, 'USER_FUNDED_NOT_ENABLED');
  if (g.strategy === 'SOLANA_SIGN_ALL') {
    // P0 universal execution: while the group is AUTHORIZED provably nothing of it was sent, so this is the only point where a signed group
    // may be stopped for lack of blockhash budget: BLOCKED with nothing sent (the run FAILS, or HALTS after earlier reconciled steps and the
    // owner ends it; the signed transactions are never sent and die with their blockhash). Once SUBMITTED, only a provable expiry stops it.
    // An unreadable height decides nothing: the group stays AUTHORIZED and is looked at again.
    const budget = await solanaSendBudget(deps.userFunded, prepared);
    if (budget === 'UNAVAILABLE') return settled(run, SUBMIT_RETRY_MS, false, 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE');
    if (budget === 'SHORT') return block('SOLANA_GROUP_SIGNED_TOO_LATE');
    const submitted = await deps.store.groupTransition(run.runId, g.groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: solanaSubmission(authorization, deps.now()) });
    return { ...settled(run, 1_000), progressed: submitted !== null };
  }
  // EVM_USER_OPERATION, due now (its previous group reconciled, which for a delayed group means the delivery reconciled). The due-time
  // simulation runs first (nothing is relayed if it refuses); then the submission is RECORDED, and only the one process whose write won
  // relays it — a status poll and the worker can never both send, and a lost relay is resent by reconciliation (same signed bytes).
  const r = await checkUserOperation(deps.userFunded, prepared, authorization, g.feePayer);
  if (!r.ok) {
    if (TRANSIENT.has(r.code)) return settled(run, SUBMIT_RETRY_MS, false, r.code);
    return block(r.code);
  }
  const submitted = await deps.store.groupTransition(run.runId, g.groupIndex, ['AUTHORIZED'], 'SUBMITTED', { submission: r.value });
  if (!submitted) return { ...settled(run, SUBMIT_RETRY_MS), progressed: true };
  const relayed = await relayUserOperation(deps.userFunded, prepared, authorization, run.owner);
  deps.log(relayed.ok ? 'workflow_run.user_operation_relayed' : 'workflow_run.user_operation_relay_retry', { run: run.runId, group: g.groupIndex, code: relayed.ok ? null : relayed.code });
  return { ...settled(run, SUBMIT_RETRY_MS), progressed: true };
}

async function submittedGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord, steps: readonly RunStepRecord[]): Promise<Pass> {
  if (!deps.userFunded) return settled(run, ADVANCE_RETRY_MS, false, 'USER_FUNDED_NOT_ENABLED');
  const prepared = g.prepared as Prepared, submission = g.submission!;
  let r: Reconciled;
  try {
    if (g.strategy === 'SOLANA_SIGN_ALL') {
      // ADR-0010 §4: a Kora group records each Kora call before it is made and each verified answer (the transaction id) as it arrives. The
      // submission was written once (0023 never lets it change): the progress is kept on the group's outcome while it is in flight, from the
      // group's current state (SUBMITTED, or UNCERTAIN after a failed pass) and by compare-and-set on its version — a concurrent pass never
      // overwrites what it did not see, and only a monotonic step is ever written (attempts never fall, a recorded id never changes).
      const live = koraGroupSubmission(submission, g.outcome);
      let latest = live, version = g.version;
      const persist = async (next: Readonly<Record<string, unknown>>) => {
        const progress = koraGroupProgress(latest, next);
        if (!progress) return false;
        const written = await deps.store.groupTransition(run.runId, g.groupIndex, [g.state], g.state, { outcome: progress }, 'GROUP_KORA_RELAY', version);
        if (!written) return false;
        latest = next; version = written.version;
        return true;
      };
      const step = await advanceSolanaSubmission(deps.userFunded, prepared, g.authorization!, g.feePayer, run.owner, live, persist);
      if (step.state === 'SENT' || step.state === 'WAITING') return settled(run, 2_000, latest !== live, step.code);
      if (step.state === 'EXPIRED' || step.state === 'FAILED') r = await reconcileSolanaGroup(deps.userFunded, prepared, { ...latest, hashes: (latest.hashes as (string | null)[]).slice(0, step.index! + (step.state === 'FAILED' ? 1 : 0)) },
        g.chain, g.feePayer).then(x => x.status === 'RECONCILED' ? { status: 'FAILED' as const, code: step.code!, gasPaid: x.gasPaid, transactions: x.transactions, steps: x.steps } : x);
      else r = await reconcileSolanaGroup(deps.userFunded, prepared, latest, g.chain, g.feePayer);
    } else r = await reconcileEvmGroup(deps.userFunded, prepared, submission, g.authorization, run.owner);
  } catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'RECONCILIATION_FAILED';
    if (g.state === 'SUBMITTED') await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED'], 'UNCERTAIN', { code });
    if (run.state === 'RUNNING') await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING'] }, 'ATTENTION', { code });
    return { state: 'ATTENTION', code, retryMs: ADVANCE_RETRY_MS, progressed: false };
  }
  if (r.status === 'PENDING') return settled(run, SUBMIT_RETRY_MS);
  // Final review (P1): the chain did not revert what was reported, yet it does not match what the owner signed — funds may have moved. Never
  // FAILED (nothing irreversible happened): the group and its steps are UNCERTAIN and the run needs ATTENTION, observed again, never resent.
  if (r.status === 'UNMATCHED') return attention(deps, run, g, stored(r.code));
  // P0 hotfix (E1): a batch that carried a bridge: its source side reconciled above; the bridge step needs its verified destination delivery.
  const sentGroup = r.status === 'RECONCILED' ? r.group ?? (prepared as { group?: EvmGroupCalls }).group ?? null : null;
  const bridge = sentGroup ? bridgeOf(sentGroup) : null;
  let delivery: BridgeDelivery | null = null;
  if (r.status === 'RECONCILED' && sentGroup && bridge) {
    delivery = await observeBridgeDelivery(deps.userFunded, sentGroup, r.receipts ?? [], bridgeProgressOf(g.outcome));
    if (delivery.status === 'UNREADABLE') return settled(run, SUBMIT_RETRY_MS, false, 'BRIDGE_AWAITING_DELIVERY');
  }
  // The bridge step waits (its delivery is not final, not observed, or divergent): the other steps of the batch are recorded now.
  const waiting = delivery !== null && delivery.status !== 'DELIVERED' && delivery.status !== 'REFUNDED';
  // Final review (P1): recording what the chain already decided never depends on the workflow still composing to the run's hash (a deploy may
  // change the canonical bytes while a group is in flight): the run's own strategy is composed without that binding for the per-step records.
  const bound = composeWorkflowBound(run.strategy, run.workflowHash);
  const composed = bound.ok ? bound : composeWorkflowBound(run.strategy, undefined);
  if (!bound.ok) deps.log('workflow_run.reconciled_unbound', { run: run.runId, group: g.groupIndex, composes: composed.ok });
  const observedAt = deps.now().toISOString(), chain = g.chain;
  // A delivered bridge step received the fill's output on its destination chain (what its later consumers are funded by).
  const facts = (r.status === 'RECONCILED' ? r.steps : r.steps ?? []).map(f => bridge && f.stepIndex === bridge.step && delivery?.status === 'DELIVERED'
    ? { ...f, received: [...f.received, delivery.received] } : f);
  /** Transactions on another chain a step's outcome lists too: a bridge's destination fill, or its refund. */
  const extra = (index: number) => bridge && index === bridge.step && (delivery?.status === 'DELIVERED' || delivery?.status === 'REFUNDED') ? [delivery.transaction] : [];
  const evidence = { environment: 'PUBLIC_UNVERIFIED', outcome: r.status, bundleHash: null };
  const gasPaid = r.gasPaid ? { ...r.gasPaid, group: g.groupIndex } : undefined;
  const outcomeOf = (index: number, status: string): StepOutcome => {
    const f = facts.find(x => x.stepIndex === index);
    return { kind: 'USER_FUNDED_GROUP', executionId: `${run.runId}:g${g.groupIndex}`, flow: null, status, transactions: [...r.transactions.map(hash => ({ chain, hash })), ...extra(index)], evidence,
      spent: f?.spent ?? [], received: f?.received ?? [], observedAt, ...gasPaid ? { gasPaid } : {} };
  };
  const spentOf = (index: number) => {
    // The artifact the batch was actually sent from (an earlier preparation, when it reconciled against one), else the group's own.
    const group = r.group ?? (prepared as { group?: EvmGroupCalls }).group, stepCalls = group?.steps.find(s => s.stepIndex === index);
    if (stepCalls) return stepCalls.spend.amount;
    const sol = (prepared.transactions as readonly { stepIndex: number; spend: { amount: string } }[] | undefined)?.find(t => t.stepIndex === index);
    return sol?.spend.amount ?? null;
  };
  // A grouped step bound to an earlier output records what it was signed to spend from it, exactly as a confirm-mode step does: a later
  // consumer of the same delivery (in a later group or confirmed step by step) is funded only by what is left of it.
  // A producer recorded in an earlier pass (a batched swap whose bridge was still waiting for its delivery) counts once: its record, else this pass's facts.
  const receivedOf = (producer: number, asset: string) => (steps[producer]?.outcome?.received ?? facts.find(f => f.stepIndex === producer)?.received ?? [])
    .filter(x => x.asset === asset).reduce((sum, x) => sum + BigInt(x.amount), 0n);
  const boundOf = (index: number): BoundResolution | null => {
    const spent = spentOf(index), all = composed.ok ? composed.bindings.filter(b => b.step === index) : [];
    if (!spent || !all.length) return null;
    const resolutions = all.map(b => ({ amountFrom: b.amountFrom, asset: b.asset, cap: b.cap,
      received: receivedOf(b.amountFrom, assetKey({ chain: b.asset.chainId, address: b.asset.address })).toString(), used: spent }));
    return { ...resolutions[0]!, ...resolutions.length > 1 ? { additional: resolutions.slice(1) } : {} };
  };
  let unrecorded = false;
  for (let i = g.stepFrom; i <= g.stepTo; i++) {
    if (bridge && i === bridge.step && waiting) continue;
    if (bridge && i === bridge.step && delivery?.status === 'REFUNDED') {
      // Refunded on the source chain: the bridge step FAILED (nothing was delivered); what it spent came back to the owner's wallet.
      const f = facts.find(x => x.stepIndex === i);
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'FAILED', { outcome: { ...outcomeOf(i, 'FAILED'), spent: f?.spent ?? [], received: [delivery.returned] },
        code: 'BRIDGE_REFUNDED' });
      continue;
    }
    const done = facts.some(f => f.stepIndex === i);
    if (r.status === 'RECONCILED' || done) {
      // A step is RECONCILED only with the strategy it executed (0015); one that no longer composes at all is left for ATTENTION below.
      const strategy = composed.ok ? executedStrategy(composed, i, spentOf(i)) : null, alone = strategy ? composeWorkflowBound(strategy, undefined) : null;
      if (!strategy || !alone?.ok) { unrecorded = true; continue; }
      const resolution = steps[i]!.bound ? null : boundOf(i);
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'RECONCILED', { outcome: outcomeOf(i, 'RECONCILED'), code: null, strategy,
        workflowHash: alone.workflowHash, ...resolution ? { bound: resolution } : {} });
    } else if (steps[i]!.state === 'DELEGATED' || steps[i]!.state === 'UNCERTAIN')
      await deps.store.stepTransition(run.runId, i, ['DELEGATED', 'UNCERTAIN'], 'FAILED', { outcome: outcomeOf(i, 'FAILED'), code: r.status === 'FAILED' ? stored(r.code) : null });
  }
  // Reconciled against an earlier preparation (the one the wallet sent): what ITS steps were signed to spend and receive, for the owner's view.
  const preparedFrom = r.group ? { preparedFrom: { steps: r.group.steps, calls: r.group.calls.length,
    approvals: r.group.calls.filter(c => c.kind === 'ERC20_APPROVE').length } } : {};
  const groupOutcome = { status: r.status, transactions: [...r.transactions, ...bridge ? extra(bridge.step) : []], gasPaid: r.gasPaid, steps: facts, observedAt, ...preparedFrom,
    ...delivery?.progress ? { bridge: delivery.progress } : {} };
  // Executed steps FloFi cannot record any more (their strategy no longer composes): the run needs attention, never advances past them.
  if (unrecorded) return attention(deps, run, g, 'WORKFLOW_RUN_STALE');
  if (delivery && waiting) {
    // The group stays open while its bridge waits: its progress (deposit id, scan cursor, fill) is kept on its outcome when it changed.
    const progress = delivery.progress;
    if (progress && (delivery.status === 'DIVERGENT' || ('changed' in delivery && delivery.changed) || !bridgeProgressOf(g.outcome)))
      await deps.store.groupTransition(run.runId, g.groupIndex, [g.state], g.state, { outcome: { ...groupOutcome, status: 'AWAITING_DESTINATION' } }, 'GROUP_BRIDGE_OBSERVED');
    if (delivery.status === 'PENDING') {
      deps.log('workflow_run.bridge_awaiting_delivery', { run: run.runId, group: g.groupIndex, sourceFinal: delivery.progress.sourceSafe, filled: delivery.progress.fill !== null });
      return settled(run, SUBMIT_RETRY_MS, false, 'BRIDGE_AWAITING_DELIVERY');
    }
    // Not observed past its fill deadline, or a deposit / fill that disagrees with what was signed: observed again on every pass, never resent.
    return attention(deps, run, g, stored((delivery as { code: string }).code));
  }
  if (delivery?.status === 'REFUNDED') {
    await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'FAILED', { outcome: { ...groupOutcome, status: 'FAILED' }, code: 'BRIDGE_REFUNDED' });
    const partial = steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED') || g.stepFrom < delivery.progress.step;
    const moved = await stopRunFromCurrent(deps, run.runId, partial ? 'HALTED' : 'FAILED', 'BRIDGE_REFUNDED');
    deps.log('workflow_run.bridge_refunded', { run: run.runId, group: g.groupIndex });
    return moved ? settled(moved) : { ...settled(run), progressed: true };
  }
  if (r.status === 'RECONCILED') {
    await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'RECONCILED', { outcome: groupOutcome, code: null });
    deps.log('workflow_run.group_reconciled', { run: run.runId, group: g.groupIndex, gasPaid: r.gasPaid.amount, ...r.gasPaid.sponsored ? { gasSponsored: true } : {} });
    return afterGroup(deps, (await deps.store.byId(run.runId))!, g);
  }
  await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED', 'UNCERTAIN'], 'FAILED', { outcome: groupOutcome, code: stored(r.code) });
  const partial = facts.length > 0 || steps.some(s => s.stepIndex < g.stepFrom && s.state === 'RECONCILED');
  // From the run's CURRENT version, re-read on every attempt (a status poll, or a concurrent pass moving it to ATTENTION, may move it between a
  // read and the write). Should it still not move (the process stops here, or every attempt loses), the next pass stops it (case 'FAILED').
  const moved = await stopRunFromCurrent(deps, run.runId, partial ? 'HALTED' : 'FAILED', stored(r.code));
  deps.log('workflow_run.group_failed', { run: run.runId, group: g.groupIndex, code: r.code });
  return moved ? settled(moved) : { ...settled(run), progressed: true };
}

/**
 * A submitted group whose outcome FloFi cannot record (the chain did not revert it, yet it does not match what was signed; or its executed
 * steps no longer compose): the group and its still-open steps are UNCERTAIN, the run needs ATTENTION — observation only, never a resend.
 */
async function attention(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord, code: string): Promise<Pass> {
  if (g.state === 'SUBMITTED') await deps.store.groupTransition(run.runId, g.groupIndex, ['SUBMITTED'], 'UNCERTAIN', { code });
  for (let i = g.stepFrom; i <= g.stepTo; i++) await deps.store.stepTransition(run.runId, i, ['DELEGATED'], 'UNCERTAIN', { code });
  const current = await deps.store.byId(run.runId);
  if (current?.state === 'RUNNING') await deps.store.transition(run.runId, { version: current.version, from: ['RUNNING'] }, 'ATTENTION', { code });
  deps.log('workflow_run.group_unmatched', { run: run.runId, group: g.groupIndex, code });
  return { state: 'ATTENTION', code, retryMs: ADVANCE_RETRY_MS, progressed: false };
}

/**
 * Bookkeeping only: an owner-step group (one or more steps, each through its own flow) becomes FAILED when one of its steps failed, and
 * RECONCILED only once EVERY step reconciled; its steps' own flows carry the evidence.
 */
async function syncOwnerGroups(deps: UserFundedPassDeps, runId: string): Promise<void> {
  const groups = await deps.store.groups(runId), steps = await deps.store.steps(runId);
  for (const og of groups.filter(x => ownerStep(x) && x.state === 'PLANNED')) {
    const mine = steps.filter(s => s.stepIndex >= og.stepFrom && s.stepIndex <= og.stepTo);
    const failed = mine.some(s => s.state === 'FAILED'), all = mine.length === og.stepTo - og.stepFrom + 1 && mine.every(s => s.state === 'RECONCILED' && s.outcome);
    if (!failed && !all) continue;
    const state = failed ? 'FAILED' : 'RECONCILED';
    await deps.store.groupTransition(runId, og.groupIndex, ['PLANNED'], state, { outcome: { status: state,
      transactions: mine.flatMap(s => s.outcome?.transactions ?? []), steps: mine.filter(s => s.outcome).map(s => s.stepIndex) } });
  }
}
/** A reconciled group: the run moves past its last step, or completes (written once). */
async function afterGroup(deps: UserFundedPassDeps, run: RunRecord, g: GroupRecord): Promise<Pass> {
  if (run.currentStep > g.stepTo) return settled(run);
  const last = g.stepTo + 1 >= run.stepCount;
  const moved = await deps.store.transition(run.runId, { version: run.version, from: ['RUNNING', 'ATTENTION'] }, last ? 'COMPLETED' : 'RUNNING',
    last ? { completedAt: deps.now(), code: null } : { currentStep: g.stepTo + 1, code: null }, last ? 'RUN_COMPLETED' : 'RUN_STEP_ADVANCED');
  if (moved) deps.log(last ? 'workflow_run.completed' : 'workflow_run.advanced', { run: run.runId, step: g.stepTo, mode: 'USER_FUNDED' });
  return moved ? { ...settled(moved), progressed: !last } : { ...settled(run), progressed: true };
}
