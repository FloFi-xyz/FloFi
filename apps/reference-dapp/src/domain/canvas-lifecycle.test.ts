// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, templateEditor } from './editor';
import { canvasAddCommand } from './canvas-authoring';
import { createCryptoActionNode, selectCryptoNetwork } from './crypto-action-picker';
import { projectReview } from './review-presentation';
import { projectCanvasAction } from './canvas-lifecycle';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { currentExecution, isFinalExecutionResult, nothingSubmitted, projectExecutionResult, refreshableAfterNothingSent } from './execution-result';
import { reviewFixture, reviewNow, reviewExpiry } from '../test-utils/review-fixture';
import type { SimulationSource } from './simulation-presentation';
import type { ExecutionControlsState } from '../state/execution-controls';

const controls = { requesting: false, verifying: false, canContinue: false, canCheck: false };
function fixture(kind: 'public' | 'router' | 'supply' | 'solana-swap'): ExecutionControlsState {
  const f = reviewFixture();
  if (kind === 'supply' || kind === 'router') f.workflow = editorReducer(templateEditor(), canvasAddCommand(kind === 'supply' ? 'supply' : 'bridge', 0, f.wallet.account, '100'), f.context).workflow;
  if (kind === 'solana-swap') {
    f.workflow = { ...f.workflow, nodes: [createCryptoActionNode('solana-swap', { selection: selectCryptoNetwork('swap', 'Solana Devnet'), amount: '1', slippage: '50' })]  };
    const chain = f.workflow.nodes[0]!.chainId;
    f.wallet.chain = chain; f.authorization.chain = chain; f.manifest.owner = { ...f.manifest.owner, chainId: chain };
  }
  const digest = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(f.workflow)));
  f.manifest.semanticWorkflowRevision = f.workflow.revision; f.policy.semanticWorkflowHash = digest; f.manifest.semanticWorkflowHash = digest;
  f.manifest.policyHash = hashArtifactBytes('authorization-policy', new TextEncoder().encode(JSON.stringify(f.policy)));
  const q = { workflow: f.workflow, expiresAt: reviewExpiry };
  const states = {
    public: f.source.state,
    supply: { record: { provenance: 'PUBLIC_TESTNET', verdict: 'PENDING', error: null, review: { ...q, amount: '100000000', approvalRequired: false, manifest: f.manifest } } },
    'solana-swap': { record: { provenance: 'PUBLIC_DEVNET', verdict: 'PENDING', error: null, review: { ...q, cluster: 'devnet', input: { symbol: 'USDC', decimals: 6 }, output: { symbol: 'SOL', decimals: 9 }, slippageBps: 50, quote: { outAmount: '100000000', otherAmountThreshold: '99500000', priceImpactPct: '0', routePlan: [] }, estimatedFeeLamports: '5000', simulationResult: { inputSpent: '100000000', outputReceived: '100000000', accountCreationLamports: '0', feeLamports: '5000' } } } },
    router: { record: { workflow: f.workflow, provenance: 'PUBLIC_TESTNET', verdict: 'PENDING', error: null, requote: false, review: { workflowHash: f.manifest.semanticWorkflowHash, revision: f.workflow.revision, nodeId: f.workflow.nodes.at(-1)!.nodeId, expiresAt: reviewExpiry, selection: { selected: 'lifi' }, route: { inputToken: { symbol: 'USDC', decimals: 6 }, outputToken: { symbol: 'USDC', decimals: 6 }, inputAmount: '100000000', underlyingProtocol: 'across', slippageBps: 50, fees: [] }, quote: { expectedOutput: '99000000', minimumOutput: '98500000', feeTotal: '1000000', expiresAt: reviewExpiry }, deadlines: { depositMustLandBy: (reviewNow + 100000) / 1000 }, approvals: [], fees: { totalUpperBoundWei: '1', executionFeeUpperBoundWei: '1', l1FeeUpperBoundWei: '0' } } } },
  };
  return { ...f, source: { kind, state: { busy: false, error: null, retired: false, ...states[kind] } } as unknown as SimulationSource,
    execution: { ready: true, started: false, start: vi.fn(), prompt: '', expiresAt: null } };
}
describe('shared Canvas lifecycle across runtime projections', () => {
  // BUILD-FIX-UX-001: (1) declined before submission, (2) submitted and failed, (3) confirmed, (4) unknown outcome.
  function publicRun(attempts: { step: string; state: string; txHash: string | null }[], options: { restored?: boolean; workflowId?: string } = {}) {
    const f = fixture('public');
    const run = { workflow: f.workflow, quote: { executionId: 'pub-run', nodeId: f.workflow.nodes.at(-1)!.nodeId, chainId: 84532 }, attempts };
    const state = { ...f.source.state, recoveryOnly: Boolean(options.restored), retired: Boolean(options.restored), run };
    if (options.workflowId) f.workflow = { ...f.workflow, workflowId: options.workflowId };
    f.source = { kind: 'public', state } as unknown as SimulationSource;
    f.progress = projectExecutionLifecycle(f.workflow, f.context, { kind: 'public', state } as unknown as ExecutionLifecycleSource);
    return f;
  }
  const hash = (c: string) => `0x${c.repeat(64)}`;
  it('BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a Review refused at the execution boundary (requote) offers a fresh simulation, never a dead disabled approval', () => {
    // Production: begin deauthorized the Router run (ROUTE_CHANGED, requote) and the Canvas kept a disabled "Authorize in wallet", so the chat
    // re-presented that dead Review on every "Review workflow" instead of simulating again.
    const f = fixture('router'), record = (f.source.state as unknown as { record: Record<string, unknown> }).record;
    const refused = { ...f, source: { ...f.source, state: { ...f.source.state, error: 'ROUTE_CHANGED', record: { ...record, requote: true, error: 'ROUTE_CHANGED' } } } as unknown as SimulationSource };
    expect(projectCanvasAction(refused, controls)).toEqual({ kind: 'simulate', label: 'Simulate again', disabled: false });
    expect(projectCanvasAction({ ...refused, invalidWorkflow: true }, controls)).toMatchObject({ kind: 'simulate', disabled: true });
  });
  // BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident D): a bridge request FloFi refused before the wallet (its transaction number disagreed) is
  // "not submitted" and continues the same workflow with Refresh & review — never "needs attention" with only "Create new workflow". (The record →
  // lifecycle projection of these notes is covered on real universal records in server/universal-router/service.test.ts.)
  type Op = { id: string; state: string; hash?: string | null; approval?: boolean; reason?: string };
  function bridgeRun(kind: 'router' | 'universal' | 'public' | 'uniswap-pool', ops: Op[]): ExecutionControlsState {
    const f = fixture('router'), operations = ops.map(o => ({ nodeId: 'n1', title: o.id, label: o.state, hash: null, chain: 'eip155:8453', explorer: null, fee: null, approval: false,
      intent: false, wallet: o.id !== 'destination', ...o }));
    const step = { id: 's1', number: 1, action: 'Bridge', input: '1 USDC', pair: null, network: 'Base', provider: 'Relay', tokens: [], state: 'not-submitted', label: '', operations };
    const progress = { started: true, restored: false, local: false, matchesWorkflow: true, steps: [step], active: step, completed: 0, label: 'Execution needs attention', message: '',
      state: 'attention', runKey: 'xuni-1', fingerprint: '', busy: false };
    return { ...f, source: { ...f.source, kind } as unknown as SimulationSource, progress } as unknown as ExecutionControlsState;
  }
  it.each(['UNIVERSAL_WALLET_NONCE_AHEAD', 'ROUTER_WALLET_NONCE_BEHIND', 'ROUTER_NONCE_CHANGED'])('a %s refusal before the wallet offers Refresh & review on the same workflow', reason => {
    for (const kind of ['router', 'universal'] as const) {
      const f = bridgeRun(kind, [{ id: 'APPROVAL', state: 'not-submitted', approval: true, reason }, { id: 'DEPOSIT', state: 'waiting' }, { id: 'destination', state: 'waiting' }]);
      expect(refreshableAfterNothingSent(f.progress)).toBe(true);
      expect(projectExecutionResult(f.progress)).toMatchObject({ label: 'Transaction not submitted' });
      expect(projectCanvasAction(f, controls)).toEqual({ kind: 'simulate', label: 'Refresh & review', disabled: false });
      expect(projectCanvasAction({ ...f, invalidWorkflow: true }, controls)).toMatchObject({ kind: 'simulate', disabled: true });
    }
  });
  it('words a wallet nonce refusal plainly in the result (nothing was sent by FloFi)', () => {
    const f = bridgeRun('universal', [{ id: 'APPROVAL', state: 'not-submitted', approval: true, reason: 'UNIVERSAL_WALLET_NONCE_MISMATCH' }, { id: 'DEPOSIT', state: 'waiting' }]);
    expect(projectExecutionResult(f.progress)?.message).toBe('Your wallet and the network reported different transaction numbers. No transaction was sent by FloFi. Check pending wallet transactions, then refresh and review this step again.');
  });
  it('a confirmed approval followed by a refused deposit keeps the approval and continues with Refresh & review (re-quote in place)', () => {
    const f = bridgeRun('universal', [{ id: 'APPROVAL', state: 'confirmed', approval: true, hash: hash('a') }, { id: 'DEPOSIT', state: 'not-submitted', reason: 'UNIVERSAL_WALLET_NONCE_AHEAD' },
      { id: 'destination', state: 'waiting' }]);
    expect(projectExecutionResult(f.progress)).toMatchObject({ label: 'Execution partially completed' });
    expect(projectCanvasAction(f, controls)).toEqual({ kind: 'simulate', label: 'Refresh & review', disabled: false });
  });
  it.each([
    ['an unknown submission result', [{ id: 'APPROVAL', state: 'uncertain', approval: true }]],
    ['a submitted deposit', [{ id: 'APPROVAL', state: 'confirmed', approval: true, hash: hash('a') }, { id: 'DEPOSIT', state: 'pending', hash: hash('b') }]],
    ['a confirmed deposit then a refused later request', [{ id: 'DEPOSIT', state: 'confirmed', hash: hash('b') }, { id: 'destination', state: 'not-submitted' }]],
  ] as [string, Op[]][])('%s is never offered Refresh & review', (_label, ops) => {
    const f = bridgeRun('universal', ops);
    expect(refreshableAfterNothingSent(f.progress)).toBe(false);
    expect(projectCanvasAction(f, controls).label).not.toBe('Refresh & review');
  });
  // BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): the incident's run (WETH approval confirmed, USDC approval not submitted because its Review
  // expired) continues the same run with Refresh & review — never a disabled "Execution needs attention" (also after a reload).
  it('a Uniswap position whose next approval was not sent because the Review expired continues with Refresh & review', () => {
    const f = bridgeRun('uniswap-pool', [{ id: 'APPROVE_TOKEN0', state: 'confirmed', approval: true, hash: hash('a') },
      { id: 'APPROVE_TOKEN1', state: 'not-submitted', approval: true, reason: 'UNISWAP_REVIEW_EXPIRED' }, { id: 'MINT', state: 'waiting' }]);
    expect(projectExecutionResult(f.progress)).toMatchObject({ label: 'Execution partially completed' });
    expect(projectCanvasAction(f, controls)).toEqual({ kind: 'simulate', label: 'Refresh & review', disabled: false });
    const sent = bridgeRun('uniswap-pool', [{ id: 'APPROVE_TOKEN0', state: 'confirmed', approval: true, hash: hash('a') }, { id: 'APPROVE_TOKEN1', state: 'uncertain', approval: true }]);
    expect(projectCanvasAction(sent, controls).label).not.toBe('Refresh & review');
  });
  it('other runtimes keep their own wording (Refresh & review is the in-place continuation of bridges and Uniswap liquidity only)', () => {
    const f = bridgeRun('public', [{ id: 'swap', state: 'not-submitted' }]);
    expect(projectCanvasAction(f, controls).label).not.toBe('Refresh & review');
  });
  it('a wallet request declined before submission concludes the attempt: Simulate again, also after a reload, never "Recover execution"', () => {
    for (const restored of [false, true]) {
      const f = publicRun([{ step: 'approval', state: 'REJECTED', txHash: null }], { restored });
      expect(projectExecutionResult(f.progress)).toMatchObject({ label: 'Transaction not submitted' });
      expect(isFinalExecutionResult(f.progress)).toBe(true); expect(nothingSubmitted(f.progress)).toBe(true);
      expect(currentExecution(f.progress)).toBe(f.progress);
      expect(projectCanvasAction(f, controls, reviewNow)).toEqual({ kind: 'simulate', label: 'Simulate again', disabled: false });
    }
  });
  it('a new workflow (fresh identity, even the same swap) is not bound to a final earlier run, which stays recorded', () => {
    for (const attempts of [[{ step: 'approval', state: 'REJECTED', txHash: null }],
      [{ step: 'approval', state: 'CONFIRMED', txHash: hash('a') }, { step: 'swap', state: 'REVERTED', txHash: hash('b') }],
      [{ step: 'approval', state: 'CONFIRMED', txHash: hash('a') }, { step: 'swap', state: 'CONFIRMED', txHash: hash('b') }]]) {
      for (const restored of [false, true]) {
        const f = publicRun(attempts, { restored, workflowId: 'workflow-00000000-0000-4000-8000-000000000000' });
        expect(f.progress!.started).toBe(true); expect(f.progress!.matchesWorkflow).toBe(false);
        expect(currentExecution(f.progress)).toBeNull();
        expect(projectCanvasAction(f, controls, reviewNow)).toMatchObject({ kind: 'simulate', disabled: false });
      }
    }
  });
  it('a submitted run that failed or confirmed is not "nothing submitted": its own workflow shows the result, never a retry', () => {
    const reverted = publicRun([{ step: 'approval', state: 'CONFIRMED', txHash: hash('a') }, { step: 'swap', state: 'REVERTED', txHash: hash('b') }]);
    expect(isFinalExecutionResult(reverted.progress)).toBe(true); expect(nothingSubmitted(reverted.progress)).toBe(false);
    expect(projectCanvasAction(reverted, controls, reviewNow)).toMatchObject({ kind: 'status', disabled: true });
    const declinedAfterApproval = publicRun([{ step: 'approval', state: 'CONFIRMED', txHash: hash('a') }, { step: 'swap', state: 'REJECTED', txHash: null }]);
    expect(nothingSubmitted(declinedAfterApproval.progress)).toBe(false);
    expect(projectCanvasAction(declinedAfterApproval, controls, reviewNow)).toMatchObject({ kind: 'status', disabled: true });
  });
  it('an unknown or pending submission stays attached to every workflow: recovery only, never a new simulation', () => {
    for (const attempts of [[{ step: 'approval', state: 'UNKNOWN', txHash: null }], [{ step: 'approval', state: 'PENDING', txHash: hash('a') }],
      [{ step: 'approval', state: 'HASH', txHash: hash('a') }]]) {
      for (const workflowId of [undefined, 'workflow-00000000-0000-4000-8000-000000000000']) {
        const f = publicRun(attempts, workflowId ? { restored: true, workflowId } : {});
        expect(isFinalExecutionResult(f.progress)).toBe(false); expect(nothingSubmitted(f.progress)).toBe(false);
        expect(currentExecution(f.progress)).toBe(f.progress);
        expect(projectCanvasAction(f, controls, reviewNow).kind).not.toBe('simulate');
        expect(projectCanvasAction(f, { ...controls, canCheck: true }, reviewNow)).toMatchObject({ kind: 'recover' });
      }
    }
  });
  it('allows a new edited workflow after completion, while preserving recovery for an unresolved old run', () => {
    const f = fixture('public');
    const state = { ...f.source.state, recoveryOnly: true, retired: true, run: {
      workflow: f.workflow, quote: { executionId: 'saved', nodeId: f.workflow.nodes.at(-1)!.nodeId, chainId: 84532 },
      attempts: [{ step: 'swap', state: 'CONFIRMED', txHash: `0x${'a'.repeat(64)}` }],
    } };
    const source = { kind: 'public', state } as unknown as ExecutionLifecycleSource;
    f.progress = projectExecutionLifecycle(f.workflow, f.context, source);
    expect(projectCanvasAction(f, controls, reviewNow)).toMatchObject({ kind: 'status', label: 'Execution completed' });
    f.workflow = { ...f.workflow, revision: f.workflow.revision + 1 };
    f.source = { kind: 'public', state } as unknown as SimulationSource;
    f.progress = projectExecutionLifecycle(f.workflow, f.context, source);
    expect(projectCanvasAction(f, controls, reviewNow)).toMatchObject({ kind: 'simulate', label: 'Simulate again' });
    state.run.attempts[0]!.state = 'UNKNOWN';
    f.progress = projectExecutionLifecycle(f.workflow, f.context, source);
    expect(projectCanvasAction(f, { ...controls, canCheck: true }, reviewNow)).toMatchObject({ kind: 'recover' });
  });
  it('shows completion without a financial action, and unresolved recovery without a simulation retry', () => {
    const f = fixture('public');
    f.progress = { started: true, restored: true, local: false, steps: [], active: null, completed: 1,
      label: 'Execution completed', message: '', state: 'complete', runKey: 'recorded', fingerprint: 'complete', busy: false };
    expect(projectCanvasAction(f, controls, reviewNow)).toEqual({ kind: 'status', label: 'Execution completed', disabled: true });
    // A legacy saved record without its canonical plan cannot prove that the
    // editor represents a new workflow; keep its completed result closed.
    f.progress.planUnavailable = true; f.progress.matchesWorkflow = false;
    expect(projectCanvasAction(f, controls, reviewNow)).toEqual({ kind: 'status', label: 'Execution completed', disabled: true });
    f.progress.state = 'uncertain'; f.progress.completed = 0;
    expect(projectCanvasAction(f, { ...controls, canCheck: true }, reviewNow)).toEqual({ kind: 'recover', label: 'Recover execution', disabled: false });
    expect(projectCanvasAction(f, controls, reviewNow)).toEqual({ kind: 'status', label: 'Recover execution', disabled: true });
  });
  it.each(['public', 'router', 'supply', 'solana-swap'] as const)('%s uses Simulate → Authorize in wallet without invoking authority', kind => {
    const f = fixture(kind), approve = vi.fn(); f.authorization.approve = approve;
    const key = f.authorization.key; f.authorization.key = null;
    expect(projectCanvasAction(f, controls, reviewNow)).toMatchObject({ kind: 'simulate', label: 'Simulate workflow', disabled: false });
    f.authorization.key = key;
    expect(projectCanvasAction(f, controls, reviewNow), projectReview(f.workflow, f.context, f.source, f.authorization, f.wallet, reviewNow).message).toEqual({ kind: 'approve', label: 'Authorize in wallet', disabled: false });
    f.authorization.accepted = true;
    expect(projectCanvasAction(f, controls, reviewNow)).toEqual({ kind: 'execute', label: 'Authorize in wallet', disabled: false });
    expect(projectCanvasAction(f, { ...controls, requesting: true }, reviewNow)).toMatchObject({ kind: 'status', label: 'Waiting for wallet…' });
    expect(projectCanvasAction(f, { ...controls, verifying: true }, reviewNow)).toMatchObject({ kind: 'status', label: 'Reconciling…' });
    expect(projectCanvasAction(f, controls, reviewNow + 120001)).toMatchObject({ kind: 'simulate', label: 'Simulate again' });
    expect(approve).not.toHaveBeenCalled(); expect(f.execution.start).not.toHaveBeenCalled();
  });
});
