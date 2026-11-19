// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a Uniswap position run whose ONE wallet request the owner declined in the wallet (CANCELLED before any
 * broadcast, no hash). Nothing was sent, so the Editor's one lifecycle action (Create and Execute) is "Refresh & review" — the SAME run's Review
 * refreshed in place, exactly like a request refused before the wallet (#219, EXEC-01) — never a dead "Execution needs attention" and never a
 * resend. Real runs of the real service on the closed MOCKED in-process Base chain (`liquidity-position-editor.test-harness.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { projectCanvasAction, REFRESH_AND_REVIEW_LABEL, refreshableRun } from './canvas-lifecycle';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { nothingSubmitted, projectExecutionResult, refreshableAfterNothingSent } from './execution-result';
import { uniswapPositionRefreshInPlace, uniswapPositionReviewAuthorizable } from './uniswap-liquidity-continuation';
import { positionAuthorization, positionCatalog, positionContext as context, positionWallet, UNI_OWNER, uniswapPositionRun, uniswapSource }
  from './liquidity-position-editor.test-harness';
import type { UniswapPositionRecord } from '../server/uniswap-position-service';
import type { Workflow } from './initial-workflow';
import type { ExecutionControlsState } from '../state/execution-controls';

beforeAll(() => registerNetworkCatalog(positionCatalog));
afterAll(() => resetNetworkCatalogs());

const controls = { requesting: false, verifying: false, canContinue: false, canCheck: false };
/** The Editor's lifecycle state for a position run, as the shell builds it (the position store serves the workflow, recovered after a reload). */
function state(record: UniswapPositionRecord, workflow: Workflow): ExecutionControlsState {
  const source = uniswapSource(record, {}), recovered = { ...source, state: { ...source.state, recovered: true } } as unknown as typeof source;
  const progress = projectExecutionLifecycle(workflow, context, recovered as unknown as ExecutionLifecycleSource);
  return { workflow, context, source: recovered, authorization: positionAuthorization(`${record.id}:${record.review.commitment}`, UNI_OWNER, 'eip155:8453'),
    wallet: positionWallet(UNI_OWNER, 'eip155:8453'), execution: { ready: true, started: false, start: vi.fn(), prompt: '', expiresAt: null }, progress };
}

describe('a declined Uniswap position request', () => {
  it('is final, sent nothing, and offers Refresh & review (Create and Execute) instead of a dead "Execution needs attention"', async () => {
    const { record, workflow } = await uniswapPositionRun({ operation: 'DECREASE', partBps: 5_000, close: false }, 'decline');
    expect(record.attempts.map(a => [a.state, a.note, a.transactionHash, a.replacementHash])).toEqual([['CANCELLED', 'UNISWAP_REJECTED', null, null]]);
    const f = state(record, workflow);
    expect(f.progress).toMatchObject({ started: true, state: 'attention', label: 'Execution needs attention' });
    expect(f.progress!.steps[0]!.operations.map(op => [op.state, op.label, op.hash])).toEqual([['failed', 'Wallet request declined', null]]);
    expect(projectExecutionResult(f.progress)).toMatchObject({ label: 'Transaction not submitted' });
    // Declined is "nothing submitted", not "not submitted" by FloFi: the shared rule alone would leave the run without an action.
    expect(nothingSubmitted(f.progress)).toBe(true);
    expect(refreshableAfterNothingSent(f.progress)).toBe(false);
    expect(refreshableRun(f.source, f.progress)).toBe(true);
    expect(projectCanvasAction(f, controls)).toEqual({ kind: 'simulate', label: REFRESH_AND_REVIEW_LABEL, disabled: false });
    expect(projectCanvasAction({ ...f, invalidWorkflow: true }, controls)).toMatchObject({ kind: 'simulate', disabled: true });
    // The shell's action for it refreshes the SAME run in place (the owner is connected and the run stands for this workflow).
    expect(uniswapPositionRefreshInPlace(record, false, UNI_OWNER)).toBe(true);
    expect(uniswapPositionRefreshInPlace(record, true, UNI_OWNER)).toBe(false);
    expect(uniswapPositionRefreshInPlace(record, false, '0x2222222222222222222222222222222222222222')).toBe(false);
    // The declined Review is never authorized again as it is.
    expect(uniswapPositionReviewAuthorizable(record)).toBe(false);
  });

  it('the refreshed Review of the same run waits for a new authorization; the declined attempt stays recorded and nothing is resent', async () => {
    const { record, workflow, service, advance } = await uniswapPositionRun({ operation: 'COLLECT', partBps: null, close: false }, 'decline');
    advance(4);
    const refreshed = await service.positionRefresh(record.id);
    expect(refreshed.id).toBe(record.id);
    expect(refreshed.review.commitment).not.toBe(record.review.commitment);
    expect(refreshed).toMatchObject({ verdict: 'PENDING', authorization: null, error: null });
    expect(refreshed.attempts.map(a => [a.state, a.transactionHash, a.reviewCommitment])).toEqual([['CANCELLED', null, record.review.commitment]]);
    expect(uniswapPositionReviewAuthorizable(refreshed)).toBe(true);
    const f = state(refreshed, workflow);
    // The superseded never-sent attempt no longer holds the step: nothing was requested under the refreshed Review yet.
    expect(f.progress).toMatchObject({ started: false, state: 'idle',
      message: 'An earlier wallet request was not sent and the Review was refreshed. Check the updated Review and authorize it again.' });
    expect(f.progress!.steps[0]).toMatchObject({ action: 'Collect fees', label: 'Awaiting authorization' });
    expect(refreshableRun(f.source, f.progress)).toBe(false);
    expect(projectCanvasAction(f, controls).label).not.toBe(REFRESH_AND_REVIEW_LABEL);
  });

  it('a request that may have reached the network is never offered Refresh & review (observed only)', async () => {
    const { record, workflow } = await uniswapPositionRun({ operation: 'DECREASE', partBps: 2_500, close: false }, 'decline');
    const attempt = record.attempts[0]!;
    const unknown = { ...record, error: 'UNISWAP_SUBMISSION_UNKNOWN', attempts: [{ ...attempt, state: 'SUBMISSION_RESULT_UNKNOWN' as const, note: 'UNISWAP_SUBMISSION_UNKNOWN' }] };
    const sent = { ...record, attempts: [{ ...attempt, state: 'PENDING' as const, note: null, transactionHash: `0x${'a'.repeat(64)}` }] };
    for (const run of [unknown, sent]) {
      const f = state(run, workflow);
      expect(refreshableRun(f.source, f.progress)).toBe(false);
      expect(projectCanvasAction(f, controls).label).not.toBe(REFRESH_AND_REVIEW_LABEL);
      expect(uniswapPositionRefreshInPlace(run, false, UNI_OWNER)).toBe(false);
    }
  });
});
