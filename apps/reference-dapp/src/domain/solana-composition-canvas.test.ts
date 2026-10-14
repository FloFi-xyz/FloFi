// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bindCompositionConsumer } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaDevnetService } from '../server/jupiter-service';
import { createOrcaLiquidityService } from '../server/orca-liquidity-service';
import { createSolanaCompositionService, type SolanaCompositionView } from '../server/solana-composition-service';
import { createPositionMintSigner } from '../wallet/position-mint-signer';
import type { ExecutionControlsState } from '../state/execution-controls';
import { createSolanaSwapNode } from './jupiter-authoring';
import { createSolanaLiquidityNode } from './solana-liquidity-authoring';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { projectReview, reviewedManifest, type ReviewAuthorization } from './review-presentation';
import type { SimulationSource } from './simulation-presentation';
import { projectCanvasAction } from './canvas-lifecycle';
import type { Workflow } from './initial-workflow';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';

/**
 * P0 (owner run solcomp-895069…, real Phantom on Devnet): the swap was reconciled and bound, but the Canvas never offered the position's
 * approval. The position Review's manifest binds the server-derived position workflow, and the Canvas compared it with the composed
 * workflow, so the Review always read "Review required again" and the CTA only re-prepared the position ("Simulate again").
 */
const context = createBaseSepoliaReviewContext();
const swap = createSolanaSwapNode('node-002', { network: 'Solana Devnet', from: 'SOL', to: 'devUSDC', amount: '0.1', slippage: '50' });
const position = bindCompositionConsumer(createSolanaLiquidityNode('node-003', { network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '1000', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100' }), swap);
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'p0-canvas', revision: 2, nodes: [swap, position],
  resourceEdges: [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source' }] };
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
async function boundRun() {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 0n);
  const dir = await mkdtemp(join(tmpdir(), 'gryloo-solcomp-canvas-'));
  const now = () => NOW;
  const service = createSolanaCompositionService({ rpc: env.rpc, storage: createFileExecutionStorage(dir, 'SOLANA_COMPOSITION_BUSY'), provenance: 'MOCKED', executionEnabled: true, now,
    swap: createSolanaDevnetService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now }),
    liquidity: createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now }) });
  const simulated = await service.simulate(workflow, wallet.owner), id = simulated.record.id;
  await service.review(id, simulated.record.review.commitment, workflow);
  const begin = await service.beginSwap(id, wallet.owner, workflow);
  await service.submitSwap(id, wallet.sign(begin.unsignedTransaction));
  return { env, wallet, service, id, bound: await service.observe(id) };
}
// The MOCKED provenance can never authorize; these projections use the same view as a public Devnet run (as the owner's run is).
const live = (view: SolanaCompositionView): SolanaCompositionView => ({ ...view, record: { ...view.record, provenance: 'PUBLIC_DEVNET' } });
const source = (record: SolanaCompositionView, authorized = false): ExecutionLifecycleSource => ({ kind: 'solana-composition',
  state: { record, busy: false, error: null, retired: false, recovered: false, executionEnabled: true, signing: false, owner: record.record.review.owner, authorized } });
/** The same composition store snapshot, as the Review projection reads it. */
const reviewSource = (record: SolanaCompositionView, authorized = false) => source(record, authorized) as unknown as SimulationSource;
/** Exactly what useReviewAuthorization attaches for the composition's position step. */
function positionAuthorization(view: SolanaCompositionView, bound: boolean): ReviewAuthorization {
  const q = view.liquidity!.review, manifest = reviewedManifest(q.manifest);
  return { key: `${view.record.id}:${q.commitment}`, manifest: q.manifest, policy: q.policy, owner: manifest?.owner.address ?? null, chain: manifest?.owner.chainId ?? null,
    ready: true, accepted: view.liquidity!.authorization === q.commitment, approve: vi.fn(), approvals: [], tokens: [], limits: [], technical: q,
    ...bound ? { boundWorkflow: view.liquidityWorkflow } : {} };
}
const wallet = (view: SolanaCompositionView) => ({ account: view.record.review.owner, chain: view.record.review.chain, environment: 'testnet' as const, changed: false });
function canvasAction(view: SolanaCompositionView, authorization: ReviewAuthorization, canContinue = false) {
  const s = source(view, authorization.accepted);
  const props = { workflow: workflow as unknown as Workflow, context, source: s, authorization, wallet: wallet(view), invalidWorkflow: false,
    progress: projectExecutionLifecycle(workflow as unknown as Workflow, context, s), recovery: null,
    execution: { ready: true, started: true, start: vi.fn(), prompt: '', expiresAt: null, requiresMainnetAcknowledgement: false, nextLabel: 'Continue to add liquidity' } };
  return projectCanvasAction(props as unknown as ExecutionControlsState, { requesting: false, verifying: false, canContinue, canCheck: false }, NOW + 1_000);
}

describe('P0: the Canvas continues a reconciled Solana composition to its Orca position', () => {
  it('reproduces the stuck state, then offers Continue to liquidity → Approve & Continue → Continue to add liquidity on the same run', async () => {
    const { wallet: owner, service, id, bound } = await boundRun();
    expect(bound.phase).toBe('BOUND');
    // After the reconciled swap: one clear next action, which prepares the position (read-only), never the swap.
    const empty: ReviewAuthorization = { key: null, manifest: null, owner: null, chain: null, ready: false, accepted: false, approve: null, approvals: [], tokens: [], limits: [], technical: null };
    expect(canvasAction(live(bound), empty)).toEqual({ kind: 'simulate', label: 'Continue to liquidity', disabled: false });

    const key = await createPositionMintSigner();
    const prepared = live(await service.prepareLiquidity(id, owner.owner, workflow, key.address));
    expect(prepared.record.id).toBe(id);
    expect(prepared.phase).toBe('CONSUMING');
    // The defect: compared with the composed Canvas workflow, the position manifest always mismatched.
    expect(projectReview(workflow as unknown as Workflow, context, reviewSource(prepared), positionAuthorization(prepared, false), wallet(prepared), NOW + 1_000))
      .toMatchObject({ status: 'invalidated', canApprove: false });
    expect(canvasAction(prepared, positionAuthorization(prepared, false))).toMatchObject({ kind: 'simulate' });
    // The fix: the position manifest is checked against the workflow it binds; the owner can approve it.
    expect(projectReview(workflow as unknown as Workflow, context, reviewSource(prepared), positionAuthorization(prepared, true), wallet(prepared), NOW + 1_000))
      .toMatchObject({ status: 'ready', canApprove: true });
    expect(canvasAction(prepared, positionAuthorization(prepared, true))).toEqual({ kind: 'approve', label: 'Approve & Continue', disabled: false });

    const reviewed = live(await service.reviewLiquidity(id, prepared.liquidity!.review.commitment, workflow));
    const accepted = positionAuthorization(reviewed, true);
    expect(accepted.accepted).toBe(true);
    expect(projectReview(workflow as unknown as Workflow, context, reviewSource(reviewed, true), accepted, wallet(reviewed), NOW + 1_000)).toMatchObject({ status: 'approved', bindingValid: true });
    expect(canvasAction(reviewed, accepted, true)).toEqual({ kind: 'continue', label: 'Continue to add liquidity', disabled: false });
  });

  it('still refuses a position Review when the Canvas no longer shows the authorized composition', async () => {
    const { wallet: owner, service, id } = await boundRun();
    const key = await createPositionMintSigner();
    const prepared = live(await service.prepareLiquidity(id, owner.owner, workflow, key.address));
    const edited = { ...workflow, revision: 3, nodes: [swap, { ...position, inputs: position.inputs.map(input => input) }] } as unknown as Workflow;
    expect(projectReview(edited, context, reviewSource(prepared), positionAuthorization(prepared, true), wallet(prepared), NOW + 1_000)).toMatchObject({ canApprove: false });
    const retired = { ...source(prepared), state: { ...source(prepared).state, retired: true } } as never;
    expect(projectReview(workflow as unknown as Workflow, context, retired, positionAuthorization(prepared, true), wallet(prepared), NOW + 1_000)).toMatchObject({ canApprove: false });
    // An expired position Review is prepared again (still the position, never the swap).
    expect(projectReview(workflow as unknown as Workflow, context, reviewSource(prepared), positionAuthorization(prepared, true), wallet(prepared), NOW + 120_000)).toMatchObject({ status: 'expired' });
  });

  it('a recovered run that still owes its position shows its authorized workflow on the untouched Canvas again, and nothing else', () => {
    const initial = initialEditorHistory();
    const restored = editorHistoryReducer(initial, { type: 'RESTORE_SOLANA_COMPOSITION_CANVAS', workflow });
    expect(restored.editor.workflow).toEqual(workflow);
    expect(restored.past).toEqual([]);
    // Never over an owner's own Canvas, and never a workflow that is not a bound Swap → liquidity composition.
    expect(editorHistoryReducer(restored, { type: 'RESTORE_SOLANA_COMPOSITION_CANVAS', workflow: { ...workflow, revision: 9 } })).toBe(restored);
    expect(editorHistoryReducer(initial, { type: 'RESTORE_SOLANA_COMPOSITION_CANVAS', workflow: { ...workflow, nodes: [swap], resourceEdges: [] } })).toBe(initial);
  });
});
