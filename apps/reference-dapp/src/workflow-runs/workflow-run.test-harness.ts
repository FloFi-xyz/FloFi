// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001 test harness: conversational workflow runs on a disposable loopback PostgreSQL, through the REAL approval service
 * (request → claim → apply), the real run store and runner, and the real BUILD-AUTOMATION-002 delegated executor on its MOCKED loopback chain
 * doubles (Base Sepolia EVM + Solana Devnet). The only test double of FloFi itself is the deployment's flow runtime for OWNER-SIGNED steps:
 * the test records the owner's flow runs (as FloFi's flows would after the owner's wallet signature) so the runner's observation, ordering and
 * recovery can be exercised without a browser wallet. Evidence from it is MOCKED; nothing here reaches a public network.
 */
import { randomBytes } from 'node:crypto';
import { createPostgresWorkQueue, createWorker, type Database, type Logger } from '@defi-workflow-engine/cloud-runtime';
import type { FlowName } from '../../backend/flows.ts';
import { delegationHarness } from '../delegation/delegation.test-harness.ts';
import { delegationHandlers } from '../delegation/executor-runtime.ts';
import { DELEGATION_EXECUTE_RUN_KIND } from '../delegation/run-source.ts';
import type { Owner } from '../delegation/pg-store.ts';
import { composeWorkflowBound } from '../engine/strategy-engine';
import { readHandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { approvalLinkScheme, assembleApprovalSurface, createPgHandoffStore, fixedWindow, requestApproval, typedId, type ApprovalDeps, type ApprovalRequester,
  type WalletRef } from '../platform/index.ts';
import type { WorkflowRunSurface } from '../platform/workflow-run-approvals.ts';
import type { DelegationFacts } from './authorization-plan.ts';
import { createPgWorkflowRunStore } from './pg-store.ts';
import { advanceRun } from './runner.ts';
import { WORKFLOW_RUN_ADVANCE_KIND } from './state-machine.ts';
import { workflowRunHandlers } from './worker.ts';

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silent } as unknown as Logger;
type FakeRun = { runId: string; flow: FlowName; owner: string; workflow: unknown; createdAt: string; updatedAt: string; status: string; errorCode: string | null;
  needsObservation: boolean; hasEvidence: boolean; attempts: { transactionHash: string; state: string }[];
  evidence: { bundleHash: string; environment: string; outcome: string; content: unknown } | null;
  /** Durable facts observeOwnerStep reads for confirm-mode bindings (optional; defaults empty). */
  recordExtras?: Record<string, unknown> };

/**
 * TEST DOUBLE (isolated tests only): the deployment's flow runtime for owner-signed steps. `ownerRuns` are what FloFi's flows would have recorded
 * after the owner's own wallet signature; `mode` reports the enabled flows; `sequences` reports this deployment's workflow-run facts.
 */
export function ownerFlowRuntime(enabled: readonly FlowName[], sequences: { readonly enabled: boolean; readonly delegation: DelegationFacts }, clock: () => Date) {
  const ownerRuns: FakeRun[] = [];
  const find = (runId: string, owner: string) => ownerRuns.find(r => r.runId === runId && r.owner === owner) ?? null;
  const runtime: McpRuntime = {
    kind: 'embedded', mode: async flow => enabled.includes(flow) ? 'harness' : 'off', info: async () => ({ executionEnabled: true }),
    preview: async () => ({ ok: false, code: 'PREVIEW_NOT_USED' }),
    run: async (runId, owner) => ({ ok: true, value: find(runId, owner) ? { ...find(runId, owner)!, workflowId: 'wf', provenance: 'MOCKED', ownerAccount: owner,
      attentionRequired: false } : null }),
    journal: async () => ({ ok: true, value: null }),
    evidence: async (_flow, runId, owner) => ({ ok: true, value: find(runId, owner)?.evidence ?? null }),
    runs: async (flow, owner) => ({ ok: true, value: ownerRuns.filter(r => r.flow === flow && r.owner === owner).map(r => ({ runId: r.runId, flow: r.flow, status: r.status,
      ownerAccount: r.owner, hasEvidence: r.hasEvidence, updatedAt: r.updatedAt })) }),
    record: async (_flow, runId, owner) => {
      const found = find(runId, owner);
      return { ok: true, value: found ? { review: { workflow: found.workflow }, ...found.recordExtras } : null };
    },
    sequences: async () => sequences,
  };
  /**
   * The owner's flow run of a loaded step, as its flow records it: reconciled, submitted-but-unknown, reverted, or refused before submission.
   * `amounts` (optional) are the durable spent/received facts confirm-mode bindings resolve from (asset keys as `${chain}/erc20:${address}`).
   */
  function ownerExecutes(flow: FlowName, owner: string, workflow: unknown, outcome: 'RECONCILED' | 'PENDING' | 'REVERTED' | 'REFUSED_BEFORE_SUBMISSION',
    amounts?: { readonly received?: readonly { readonly asset: string; readonly amount: string }[]; readonly spent?: readonly { readonly asset: string; readonly amount: string }[] }) {
    const at = clock().toISOString(), hash = '0x' + randomBytes(32).toString('hex'), submitted = outcome !== 'REFUSED_BEFORE_SUBMISSION';
    const run: FakeRun = { runId: `run-${randomBytes(6).toString('hex')}`, flow, owner, workflow, createdAt: at, updatedAt: at,
      status: outcome === 'RECONCILED' ? 'RECONCILED' : outcome === 'PENDING' ? 'SUBMITTED' : 'FAILED', errorCode: outcome === 'RECONCILED' || outcome === 'PENDING' ? null
        : outcome === 'REVERTED' ? 'SUBMISSION_REVERTED' : 'SIMULATION_FAILED', needsObservation: outcome === 'PENDING', hasEvidence: outcome === 'RECONCILED',
      attempts: submitted ? [{ transactionHash: hash, state: outcome }] : [],
      evidence: outcome === 'RECONCILED' ? { bundleHash: '0x' + randomBytes(32).toString('hex'), environment: 'MOCKED', outcome: 'RECONCILED', content: {} } : null,
      recordExtras: amounts ? { receivedAmounts: amounts.received ?? [], spentAmounts: amounts.spent ?? [] } : undefined };
    ownerRuns.push(run);
    return run;
  }
  /** The flow finished observing a submitted run (the transaction confirmed and reconciled). */
  function reconcile(run: FakeRun) {
    Object.assign(run, { status: 'RECONCILED', needsObservation: false, hasEvidence: true, updatedAt: clock().toISOString(),
      evidence: { bundleHash: '0x' + randomBytes(32).toString('hex'), environment: 'MOCKED', outcome: 'RECONCILED', content: {} } });
  }
  return { runtime, ownerRuns, ownerExecutes, reconcile };
}

export type RunHarness = Awaited<ReturnType<typeof workflowRunHarness>>;
/** Everything a conversational workflow run touches, on one disposable database. `flows`: the enabled owner-execution flows. */
export async function workflowRunHarness(db: Database, options: {
  readonly flows?: readonly FlowName[]; readonly sequences?: boolean; readonly delegation?: boolean;
  /** Handoff policy env (e.g. mainnet networks for Swap→Bridge→Swap). Defaults to test-funds only. */
  readonly policyEnv?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const d = await delegationHarness(db);
  const facts: DelegationFacts = options.delegation === false ? null : { mode: 'MOCKED_HARNESS', unavailable: null };
  const flows = ownerFlowRuntime(options.flows ?? ['base-sepolia-swap', 'solana-devnet-swap'], { enabled: options.sequences ?? true, delegation: facts }, d.now);
  const handoffs = createPgHandoffStore(db, d.tenantId), store = createPgWorkflowRunStore(db, d.tenantId);
  const scheme = approvalLinkScheme('flofi_chs_', randomBytes(32), ['CHANNEL_CONVERSATION']);
  const policy = readHandoffPolicy(options.policyEnv ?? {});
  const lines: string[] = [];
  const log = (event: string, fields: Readonly<Record<string, unknown>>) => { lines.push(JSON.stringify({ event, ...fields })); };
  const runs: WorkflowRunSurface = { store, runtime: flows.runtime, delegation: d.store, now: d.now, log, policyFor: () => policy, delegationFacts: facts,
    grantsOf: owner => d.store.grants(owner as Owner), newId: typedId,
    delegationOps: facts ? {
      review: (owner, run) => d.service.workflowRunAuthorizationReview(owner as Owner, run as never),
      sign: (owner, runId, revision, assertion) => d.service.workflowRunAuthorizationSign(owner as Owner, runId, revision, assertion,
        (tx, authorizationId) => store.activateDelegatedWithin(tx, runId, authorizationId, DELEGATION_EXECUTE_RUN_KIND)),
      revoke: (owner, runId) => d.service.workflowRunAuthorizationRevoke(owner as Owner, runId),
    } : null };
  const surface = assembleApprovalSurface([{ scheme, profiles: { CHANNEL_CONVERSATION: { policy } } }], handoffs, flows.runtime, runs);
  const requester: ApprovalRequester = { kind: 'CHANNEL_CONVERSATION', ref: 'cnv_workflowrunharness0001', clientId: 'telegram-test-bot', displayName: 'Telegram', context: {} };
  const deps = (): ApprovalDeps => ({ origin: 'http://localhost:3999', scheme, handoffs, allow: fixedWindow(db, d.tenantId).allow, runtime: flows.runtime, policy,
    rules: { handoffSeconds: 900, maxPending: 5, rate: [50, 3_600], supersedeSameWorkflow: false }, now: d.now() });
  const evm: WalletRef = { namespace: 'eip155', address: d.evmOwner.address }, sol: WalletRef = { namespace: 'solana', address: d.solOwner.address };
  /** Composes and hands a workflow to its owner exactly as a channel or MCP requester does; returns the approval and its secret. */
  async function request(strategy: unknown) {
    const composed = composeWorkflowBound(strategy, undefined);
    if (!composed.ok) throw new Error(composed.code);
    const result = await requestApproval(deps(), requester, composed.strategy, composed.workflowHash);
    if (!result.ok) throw new Error(result.code);
    return { ...result.value, secret: decodeURIComponent(new URL(result.value.approvalUrl).hash.slice(1)), composed };
  }
  /** Drains delegated run executions and run advances with the real worker loop (fenced leases, settle semantics), then advances once more. */
  async function drain(runId?: string): Promise<number> {
    const queue = createPostgresWorkQueue({ db, ownerId: 'run-test-worker', tenantId: d.tenantId });
    const handlers = { ...delegationHandlers(d.deps as never), ...workflowRunHandlers({ store, runtime: flows.runtime, delegation: d.store, policyFor: () => null, now: d.now,
      log }) };
    const worker = createWorker({ queue: { ...queue, claim: limit => queue.claim(limit, [DELEGATION_EXECUTE_RUN_KIND, WORKFLOW_RUN_ADVANCE_KIND]) }, handlers, logger: silent,
      workerId: 'run-test-worker', concurrency: 4 });
    let total = 0;
    for (;;) { const n = await worker.drainOnce(); total += n; if (n === 0) break; }
    if (runId) await advanceRun({ store, runtime: flows.runtime, delegation: d.store, policyFor: () => null, now: d.now, log }, runId);
    return total;
  }
  return { d, flows, handoffs, store, runs, surface, requester, deps, evm, sol, request, drain, lines, policy };
}
