// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindCompositionConsumer } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction, toBase64 } from '@defi-workflow-engine/reference-compiler';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaDevnetService } from '../server/jupiter-service';
import { createOrcaLiquidityService } from '../server/orca-liquidity-service';
import { createSolanaCompositionService, type SolanaCompositionView } from '../server/solana-composition-service';
import { createPositionMintSigner } from '../wallet/position-mint-signer';
import { createSolanaSwapNode } from './jupiter-authoring';
import { createSolanaLiquidityNode } from './solana-liquidity-authoring';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { projectSimulation } from './simulation-presentation';
import type { Workflow } from './initial-workflow';

/** MOCKED Solana Devnet loopback: what the existing Canvas timeline and Simulate summary show at each phase of a composed run. */
const context = createBaseSepoliaReviewContext();
const swap = createSolanaSwapNode('node-002', { network: 'Solana Devnet', from: 'SOL', to: 'devUSDC', amount: '0.1', slippage: '50' });
const position = bindCompositionConsumer(createSolanaLiquidityNode('node-003', { network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '1000', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100' }), swap);
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'presentation', revision: 2, nodes: [swap, position],
  resourceEdges: [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source' }] };
async function run() {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 0n);
  const dir = await mkdtemp(join(tmpdir(), 'gryloo-solcomp-presentation-'));
  const now = () => Date.parse('2026-10-01T12:00:00.000Z');
  const swaps = createSolanaDevnetService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now });
  const liquidity = createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now });
  const service = createSolanaCompositionService({ rpc: env.rpc, storage: createFileExecutionStorage(dir, 'SOLANA_COMPOSITION_BUSY'), swap: swaps, liquidity, provenance: 'MOCKED',
    executionEnabled: true, now });
  return { env, wallet, service };
}
const source = (record: SolanaCompositionView | null): ExecutionLifecycleSource => ({ kind: 'solana-composition',
  state: { record, busy: false, error: null, retired: false, recovered: false, executionEnabled: true, signing: false, owner: null, authorized: false } });
const steps = (view: SolanaCompositionView) => projectExecutionLifecycle(workflow as unknown as Workflow, context, source(view)).steps.map(step => [step.id, step.state]);

describe('Solana Devnet composition in the existing Canvas timeline and Simulate summary (MOCKED loopback)', () => {
  it('shows each operation separately, and never offers the swap again once it is done', async () => {
    const { env, wallet, service } = await run();
    const simulated = await service.simulate(workflow, wallet.owner), id = simulated.record.id;
    expect(steps(simulated)).toEqual([['node-002', 'waiting'], ['node-003', 'waiting']]);
    // MOCKED is never presented as a simulation that can authorize; the same view from a public Devnet run renders its plan.
    const summary = (view: SolanaCompositionView) => projectSimulation(workflow as unknown as Workflow, context, { kind: 'solana-composition', state: source(view).state } as never, Date.parse('2026-10-01T12:00:00.000Z'));
    expect(summary(simulated).status).not.toBe('ready');
    const live = (view: SolanaCompositionView): SolanaCompositionView => ({ ...view, record: { ...view.record, provenance: 'PUBLIC_DEVNET' } });
    expect(summary(live(simulated)).steps.find(step => step.id === 'node-003')?.details).toContainEqual({ label: 'Funded by', value: '100% of the swap’s reconciled output' });
    expect(summary(live(simulated)).warnings.map(w => w.message)).toContain('The swap and the position are separate transactions. If the position is not opened, the swapped tokens stay in your wallet; the swap is never repeated.');
    await service.review(id, simulated.record.review.commitment, workflow);
    const begin = await service.beginSwap(id, wallet.owner, workflow);
    await service.submitSwap(id, wallet.sign(begin.unsignedTransaction));
    const bound = await service.observe(id);
    expect(steps(bound)).toEqual([['node-002', 'confirmed'], ['node-003', 'waiting']]);
    const key = await createPositionMintSigner();
    const prepared = await service.prepareLiquidity(id, wallet.owner, workflow, key.address);
    expect(steps(prepared)).toEqual([['node-002', 'confirmed'], ['node-003', 'waiting']]);
    expect(summary(live(prepared)).steps.find(step => step.id === 'node-003')?.resultLabel).toBe('Expected pool contribution');
    await service.reviewLiquidity(id, prepared.liquidity!.review.commitment, workflow);
    const lp = await service.beginLiquidity(id, wallet.owner, workflow);
    const { signatures, message } = parseTransaction(fromBase64(wallet.sign(lp.unsignedTransaction), 2048));
    await service.submitLiquidity(id, toBase64(serializeSignedTransaction([signatures[0]!, await key.sign(message)], message)));
    const done = await service.observe(id);
    const lifecycle = projectExecutionLifecycle(workflow as unknown as Workflow, context, source(done));
    expect([lifecycle.state, lifecycle.completed, steps(done)]).toEqual(['complete', 2, [['node-002', 'confirmed'], ['node-003', 'confirmed']]]);
    expect(env.state.sent).toHaveLength(2);
  });
  it('marks an ended run as ended after the swap, keeping the swapped tokens', async () => {
    const { wallet, service } = await run();
    const simulated = await service.simulate(workflow, wallet.owner), id = simulated.record.id;
    await service.review(id, simulated.record.review.commitment, workflow);
    const begin = await service.beginSwap(id, wallet.owner, workflow);
    await service.submitSwap(id, wallet.sign(begin.unsignedTransaction));
    await service.observe(id);
    const ended = await service.end(id);
    const lifecycle = projectExecutionLifecycle(workflow as unknown as Workflow, context, source(ended));
    expect(lifecycle.steps.map(step => [step.state, step.operations[0]?.label])).toEqual([['confirmed', 'Confirmed'], ['cancelled', 'Ended: swapped tokens kept']]);
  });
});
