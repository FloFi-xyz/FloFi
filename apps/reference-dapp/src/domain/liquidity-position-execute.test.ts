// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 within BUILD-FLOFI-UX-EDITOR-FINOPS-001's Execute stage: what the Editor footer's ONE lifecycle action, its
 * status line and the Assistant's expired-Review note read for a position run — from real Reviews and runs of the Uniswap position service (MOCKED
 * in-process Base chain) and the Orca service (MOCKED Solana mainnet loopback). C1: "Review valid for m:ss" + Authorize (the shell words it
 * "Authorize workflow"); C2: the Review expired, the action is Simulate again (worded "Refresh review"); then waiting for the wallet, checking an
 * existing request, an uncertain outcome that is only observed (never resent), a reconciled run, a divergence and a request never sent.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { projectSimulation, simulationStatusPresentation, type SimulationSource } from './simulation-presentation';
import { simulateFooterStatus } from './approved-ux';
import { projectExecution, type ExecutionStart } from './execution-presentation';
import { AUTHORIZE_LABEL, projectCanvasAction, REFRESH_AND_REVIEW_LABEL } from './canvas-lifecycle';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { projectExecutionRecovery } from './execution-recovery';
import { projectExecutionStepEvidence } from './execution-step-evidence';
import { projectExecutionResult } from './execution-result';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import type { Workflow } from './initial-workflow';
import type { UniswapPositionRecord } from '../server/uniswap-position-service';
import { asMainnet, ORCA_CLOCK, ORCA_OWNER_WALLET, orcaPositionRun, orcaSource, positionAuthorization, positionCatalog, positionContext as context, positionWallet,
  UNI_OWNER, uniswapPositionRun, uniswapSource } from './liquidity-position-editor.test-harness';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';

beforeAll(() => registerNetworkCatalog(positionCatalog));
afterAll(() => resetNetworkCatalogs());

const BASE = 'eip155:8453';
const idle: ExecutionStart = { ready: false, started: false, start: null, prompt: null, expiresAt: null };
/** The Execute footer as the shell composes it for the single-action (step) path: its status line and its ONE lifecycle action. */
function footer(workflow: Workflow, source: SimulationSource, owner: string, chain: string, key: string, now: number, execution: ExecutionStart = idle) {
  const view = projectSimulation(workflow, context, source, now);
  const status = simulateFooterStatus({ busy: false, status: view.status === 'blocked' ? 'blocked' : view.status === 'ready' ? 'ready' : 'attention',
    label: simulationStatusPresentation(view, false, false).label, expiresAt: view.expiresAt, now, executionStarted: false, subject: 'review' });
  const props = { workflow, context, source, authorization: positionAuthorization(key, owner, chain), wallet: positionWallet(owner, chain), execution };
  return { status, action: projectCanvasAction(props, { requesting: false, verifying: false, canContinue: false, canCheck: false }, now),
    authorizationLabel: projectExecution(props, now).authorizationLabel };
}

describe('Execute footer of a position Review (C1 valid, C2 expired)', () => {
  it('Uniswap: the Review\'s validity and ONE Authorize; once expired, the Review is "Expired" (Assistant note) and the one action refreshes it', async () => {
    const { record, workflow } = await uniswapPositionRun({ operation: 'DECREASE', partBps: 5_000, close: false });
    const live = asMainnet(record), key = `${live.id}:${live.review.commitment}`, source = uniswapSource(live);
    const valid = footer(workflow, source, UNI_OWNER, BASE, key, Date.parse(record.review.observedAt));
    expect(valid.status).toMatchObject({ tone: 'ready', text: 'Review valid for {0}' });
    expect(valid.action).toEqual({ kind: 'approve', label: AUTHORIZE_LABEL, disabled: false });
    expect(valid.authorizationLabel).toBe('Approval required');
    const expired = footer(workflow, source, UNI_OWNER, BASE, key, Date.parse(record.review.expiresAt) + 1_000);
    expect(expired.action).toEqual({ kind: 'simulate', label: 'Simulate again', disabled: false });
    expect(expired.authorizationLabel).toBe('Expired');
    expect(expired.status).toMatchObject({ tone: 'blocked', detail: 'Nothing was sent' });
    // A Review read on the MOCKED chain is never presented as live: no validity countdown, and its Authorize stays disabled.
    const mocked = footer(workflow, uniswapSource(record), UNI_OWNER, BASE, key, Date.parse(record.review.observedAt));
    expect(mocked.status).toBeNull();
    expect(mocked.action).toMatchObject({ kind: 'approve', disabled: true });
  });
  it('Orca: the same C1 / C2 contract for a mainnet position Review', async () => {
    const { record, workflow } = await orcaPositionRun('EXIT');
    const key = `${record.id}:${record.review.commitment}`, source = orcaSource(record), owner = ORCA_OWNER_WALLET.owner;
    const valid = footer(workflow, source, owner, ORCA.chain, key, ORCA_CLOCK);
    expect(valid.status).toMatchObject({ text: 'Review valid for {0}' });
    expect(valid.action).toMatchObject({ kind: 'approve', label: AUTHORIZE_LABEL, disabled: false });
    const expired = footer(workflow, source, owner, ORCA.chain, key, Date.parse(record.review.expiresAt) + 1_000);
    expect(expired.action).toMatchObject({ kind: 'simulate', label: 'Simulate again' });
    expect(expired.authorizationLabel).toBe('Expired');
  });
});

describe('Execute lifecycle of a Uniswap position run (Execute view and footer status)', () => {
  let executed: { record: UniswapPositionRecord; workflow: Workflow };
  beforeAll(async () => { executed = await uniswapPositionRun({ operation: 'DECREASE', partBps: 5_000, close: false }, true); });
  const HASH = '0x' + '1'.repeat(64);
  function lifecycle(change: (record: UniswapPositionRecord) => UniswapPositionRecord, state: { signing?: boolean } = {}) {
    const record = asMainnet(change(executed.record)), source = { ...uniswapSource(record), state: { ...uniswapSource(record).state, ...state } } as unknown as ExecutionLifecycleSource;
    const progress = projectExecutionLifecycle(executed.workflow, context, source);
    const recovery = projectExecutionRecovery(source, progress, positionWallet(UNI_OWNER, BASE));
    const stepEvidence = projectExecutionStepEvidence(source, progress);
    const props = { workflow: executed.workflow, context, source: source as SimulationSource, wallet: positionWallet(UNI_OWNER, BASE),
      authorization: positionAuthorization(`${record.id}:${record.review.commitment}`, UNI_OWNER, BASE, true), execution: { ...idle, started: true },
      progress: { ...progress, stepEvidence }, recovery: { ...recovery, check: () => undefined } };
    const canCheck = Boolean(recovery.action);
    return { progress, recovery, stepEvidence, result: projectExecutionResult({ ...progress, stepEvidence }),
      action: (requesting = false) => projectCanvasAction(props, { requesting, verifying: false, canContinue: false, canCheck: canCheck && !requesting }) };
  }
  const attempt = (patch: Partial<UniswapPositionRecord['attempts'][number]>, verdict: UniswapPositionRecord['verdict'] = 'PENDING') => (record: UniswapPositionRecord) =>
    ({ ...record, verdict, attempts: [{ ...record.attempts[0]!, ...patch }] });

  it('the wallet request: "Waiting for wallet…" while the owner\'s wallet is asked, named by the operation', () => {
    const view = lifecycle(attempt({ state: 'SUBMITTING', transactionHash: null, receipt: null, reconciled: false }), { signing: true });
    expect(view.progress.steps[0]).toMatchObject({ action: 'Remove liquidity', provider: 'Uniswap V3' });
    expect(view.progress.steps[0]!.operations).toMatchObject([{ id: 'DECREASE', title: 'Remove liquidity', state: 'wallet', approval: false }]);
    expect(view.action(true)).toMatchObject({ kind: 'status', label: 'Waiting for wallet…', processing: true });
  });
  it('a sent request is only observed ("Check status"); an unknown wallet outcome is "Recover execution" and never resent or re-authorized', () => {
    const pending = lifecycle(attempt({ state: 'PENDING', transactionHash: HASH, receipt: null, reconciled: false }));
    expect(pending.progress.state).toBe('active');
    expect(pending.recovery.action).toBe('observe');
    expect(pending.action()).toMatchObject({ kind: 'recover', label: 'Check status' });
    const unknown = lifecycle(attempt({ state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null, receipt: null, reconciled: false }));
    expect(unknown.progress.state).toBe('uncertain');
    expect(unknown.recovery).toMatchObject({ action: 'observe', label: 'Unable to confirm execution' });
    expect(unknown.recovery.message).toContain('No transaction is repeated.');
    expect(unknown.action()).toMatchObject({ kind: 'recover', label: 'Recover execution' });
    for (const view of [pending, unknown]) expect(['approve', 'execute', 'simulate', 'continue']).not.toContain(view.action().kind);
  });
  it('a reconciled run: "Execution completed", the step reconciled with its principal compared; a divergence is unresolved, never simulated again', () => {
    const reconciled = lifecycle(record => record);
    expect(executed.record.verdict).toBe('RECONCILED');
    expect(reconciled.progress.state).toBe('complete');
    expect(reconciled.action()).toMatchObject({ kind: 'status', label: 'Execution completed' });
    const step = Object.values(reconciled.stepEvidence)[0]!;
    expect(step).toMatchObject({ label: 'Reconciled', reconciled: true });
    expect(step.comparisons.map(c => c.label)).toEqual(['Principal returned · Token 1', 'Principal returned · Token 2']);
    const divergent = lifecycle(attempt({ reconciled: false }, 'DIVERGENT'));
    expect(divergent.progress.state).toBe('uncertain');
    expect(divergent.result).toMatchObject({ label: 'Execution status unresolved', tone: 'attention' });
    expect(Object.values(divergent.stepEvidence)[0]).toMatchObject({ reconciled: false });
    expect(['approve', 'execute', 'simulate']).not.toContain(divergent.action().kind);
  });
  it('a request refused before the wallet was asked is "not submitted" and refreshed by the owner; a declined one is never retried automatically', () => {
    const unsent = lifecycle(attempt({ state: 'CANCELLED', transactionHash: null, receipt: null, reconciled: false, note: 'UNISWAP_REVIEW_EXPIRED' }));
    expect(unsent.progress.steps[0]!.operations[0]!.state).toBe('not-submitted');
    expect(unsent.action()).toMatchObject({ kind: 'simulate', label: REFRESH_AND_REVIEW_LABEL });
    const declined = lifecycle(attempt({ state: 'CANCELLED', transactionHash: null, receipt: null, reconciled: false, note: 'UNISWAP_REJECTED' }));
    expect(declined.progress.state).toBe('attention');
    expect(declined.recovery.message).toContain('Nothing is retried automatically.');
    expect(['approve', 'execute']).not.toContain(declined.action().kind);
  });
});
