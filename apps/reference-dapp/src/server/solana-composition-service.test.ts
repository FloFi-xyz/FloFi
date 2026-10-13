// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindCompositionConsumer } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction, toBase64,
  type MockedOrcaOptions } from '@defi-workflow-engine/reference-compiler';
import { boundCompositionNeedsObservation, createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { buildSolanaCompositionEvidence } from '@defi-workflow-engine/reference-reconciler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaSwapNode } from '../domain/jupiter-authoring';
import { createSolanaLiquidityNode, type SolanaLiquidityInput } from '../domain/solana-liquidity-authoring';
import { createPositionMintSigner, type PositionMintSigner } from '../wallet/position-mint-signer';
import { createSolanaDevnetService } from './jupiter-service';
import { createOrcaLiquidityService } from './orca-liquidity-service';
import { createSolanaCompositionService, type SolanaCompositionView } from './solana-composition-service';

/** MOCKED Solana Devnet + Orca loopback only: the owner key and the position-mint keys live only in this test process; nothing is public. */
const pool = (patch: Partial<SolanaLiquidityInput> = {}): SolanaLiquidityInput => ({ network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '1000', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100', ...patch });
function composed(patch: Partial<SolanaLiquidityInput> = {}, swapAmount = '0.1', revision = 3): SemanticWorkflow {
  const swap = createSolanaSwapNode('node-002', { network: 'Solana Devnet', from: 'SOL', to: 'devUSDC', amount: swapAmount, slippage: '50' });
  const position = bindCompositionConsumer(createSolanaLiquidityNode('node-003', pool(patch)), swap);
  return { schemaVersion: '1.0.0', workflowId: 'solana-composition', revision, nodes: [swap, position],
    resourceEdges: [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source' }] };
}
async function setup(options: MockedOrcaOptions = {}, lamports = 3_000_000_000n, devUsdc = 0n) {
  const env = createMockedSolanaDevnetOrca(options), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, lamports, devUsdc);
  const dir = await mkdtemp(join(tmpdir(), 'gryloo-solcomp-'));
  let clock = Date.parse('2026-10-01T12:00:00.000Z');
  const now = () => clock;
  const make = () => {
    const swap = createSolanaDevnetService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now });
    const liquidity = createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now });
    return { swap, liquidity, composition: createSolanaCompositionService({ rpc: env.rpc, storage: createFileExecutionStorage(dir, 'SOLANA_COMPOSITION_BUSY'), swap, liquidity,
      provenance: 'MOCKED', executionEnabled: true, now }) };
  };
  return { env, wallet, dir, options, ...make(), make, tick: (ms: number) => { clock += ms; } };
}
type S = Awaited<ReturnType<typeof setup>>;
const swapsSent = (s: S) => s.env.state.sent.length;
async function authorized(s: S, wf = composed()) {
  const simulated = await s.composition.simulate(wf, s.wallet.owner);
  return s.composition.review(simulated.record.id, simulated.record.review.commitment, wf);
}
async function swapped(s: S, wf = composed(), beforeSubmit?: () => void) {
  const view = await authorized(s, wf);
  const begin = await s.composition.beginSwap(view.record.id, s.wallet.owner, wf);
  beforeSubmit?.();
  await s.composition.submitSwap(view.record.id, s.wallet.sign(begin.unsignedTransaction));
  return s.composition.observe(view.record.id);
}
async function signLiquidity(s: S, begin: { unsignedTransaction: string; signers: string[] }, key: PositionMintSigner) {
  const { signatures, message } = parseTransaction(fromBase64(s.wallet.sign(begin.unsignedTransaction), 2048));
  return toBase64(serializeSignedTransaction([signatures[0]!, await key.sign(message)], message));
}
async function position(s: S, id: string, wf = composed(), sign = true, beforeSubmit?: () => void): Promise<SolanaCompositionView> {
  const key = await createPositionMintSigner();
  const prepared = await s.composition.prepareLiquidity(id, s.wallet.owner, wf, key.address);
  await s.composition.reviewLiquidity(id, prepared.liquidity!.review.commitment, wf);
  const begin = await s.composition.beginLiquidity(id, s.wallet.owner, wf);
  if (!sign) return begin.view;
  beforeSubmit?.();
  await s.composition.submitLiquidity(id, await signLiquidity(s, begin, key));
  return s.composition.observe(id);
}

describe('Solana Devnet Swap → Orca liquidity composition (MOCKED loopback, no public submission)', () => {
  it('runs one reviewed swap, binds 100% of its reconciled output, then one freshly reviewed position, with composed MOCKED evidence', async () => {
    const s = await setup();
    const simulated = await s.composition.simulate(composed(), s.wallet.owner);
    expect(simulated).toMatchObject({ phase: 'SIMULATED', record: { authorization: null, binding: null, consumerRunIds: [] }, liquidity: null,
      swap: { attempt: null, review: { workflow: { nodes: [{ nodeId: 'node-002' }] } } } });
    expect(simulated.record.review.liquidity.preflight.every(c => c.ok)).toBe(true);
    expect(swapsSent(s)).toBe(0);
    await expect(s.composition.beginSwap(simulated.record.id, s.wallet.owner, composed())).rejects.toThrow('SOLANA_COMPOSITION_REVIEW_REQUIRED');
    const reviewed = await s.composition.review(simulated.record.id, simulated.record.review.commitment, composed());
    expect(reviewed).toMatchObject({ phase: 'AUTHORIZED', swap: { authorization: simulated.swap.review.commitment } });
    const begin = await s.composition.beginSwap(simulated.record.id, s.wallet.owner, composed());
    expect(begin).toMatchObject({ walletChain: 'solana:devnet', view: { phase: 'PRODUCING', swap: { attempt: { state: 'PREPARED' } } } });
    // A prepared, unsigned swap is never observed in the background: the owner may still be confirming it.
    expect(boundCompositionNeedsObservation(begin.view.record)).toBe(false);
    const submitted = await s.composition.submitSwap(simulated.record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(swapsSent(s)).toBe(1);
    expect(boundCompositionNeedsObservation(submitted.record)).toBe(true);
    const bound = await s.composition.observe(simulated.record.id);
    const received = bound.swap.observations.at(-1)!.outputReceived!;
    expect(bound).toMatchObject({ phase: 'BOUND', swap: { verdict: 'RECONCILED' },
      record: { binding: { received, cap: '1000000000', bound: received, token: 1, evidenceHash: bound.swap.evidence!.bundleHash } } });
    expect(bound.liquidityWorkflow!.nodes).toHaveLength(1);
    const done = await position(s, simulated.record.id);
    expect(swapsSent(s)).toBe(2);
    expect(done).toMatchObject({ phase: 'COMPLETED', liquidity: { verdict: 'RECONCILED', review: { operation: 'OPEN', intent: { amount1Max: received, amount0Max: '50000000' } } } });
    const effects = done.liquidity!.observations.at(-1)!.effects!;
    expect(BigInt(effects.depositedB)).toBeLessThanOrEqual(BigInt(received));
    expect(done.record.evidence).toMatchObject({ evidenceClass: 'MOCKED', bundle: { environment: 'MOCKED', outcome: 'RECONCILED',
      receipts: [{ receiptId: 'solana-composition-swap', contentHash: done.swap.evidence!.bundleHash }, { receiptId: 'solana-composition-liquidity', contentHash: done.liquidity!.evidence!.bundleHash }] },
      composition: { received, bound: received, depositedFromSwapOutput: effects.depositedB } });
    expect((await s.liquidity.positions(s.wallet.owner))[0]).toMatchObject({ status: 'ACTIVE' });
  });
  it('respects a lower owner cap: the position is reviewed with min(cap, received)', async () => {
    const s = await setup(), bound = await swapped(s, composed({ maxDevUsdc: '1' }));
    expect(bound.record.binding).toMatchObject({ cap: '1000000', bound: '1000000' });
    const done = await position(s, bound.record.id, composed({ maxDevUsdc: '1' }));
    expect(done.liquidity!.review.intent.amount1Max).toBe('1000000');
  });
  it('binds the actual reconciled output, not the quote', async () => {
    // The pool pays more on chain than the reviewed quote (the mock applies it only after Review).
    const s = await setup(), bound = await swapped(s, composed(), () => { s.options.actualOutput = quoted => quoted + 1234n; });
    expect(BigInt(bound.record.binding!.received)).toBe(BigInt(bound.record.review.swap.expectedOutput) + 1234n);
    expect(bound.liquidityWorkflow!.nodes[0]!.inputs.find(i => i.name === 'amount1-max')).toMatchObject({ value: { amount: bound.record.binding!.received } });
  });
  it('never repeats the confirmed swap: failed or unsigned positions leave the swap done and allow only a new reviewed position', async () => {
    const s = await setup(), bound = await swapped(s), id = bound.record.id;
    await expect(s.composition.beginSwap(id, s.wallet.owner, composed())).rejects.toThrow('SOLANA_COMPOSITION_EXISTING_ATTEMPT_OBSERVE_ONLY');
    // Wallet declines the position: nothing is sent and the run returns to the bound state.
    const pending = await position(s, id, composed(), false);
    const declined = await s.composition.walletFailure(id, { step: 'LIQUIDITY', diagnostic: { stage: 'SIGN', code: 'ORCA_LIQUIDITY_WALLET_REJECTED', error: { message: 'declined' } } });
    expect([pending.phase, declined.phase, declined.liquidity!.attempt!.state, declined.record.error]).toEqual(['CONSUMING', 'BOUND', 'CANCELLED', 'ORCA_LIQUIDITY_WALLET_REJECTED']);
    // The position transaction reverts on chain: still no second swap.
    const reverted = await position(s, id, composed(), true, () => { s.options.failLiquidity = true; });
    expect([reverted.phase, reverted.liquidity!.verdict, reverted.liquidity!.attempt!.state]).toEqual(['BOUND', 'DIVERGENT', 'REVERTED']);
    s.options.failLiquidity = false;
    const done = await position(s, id);
    expect([done.phase, done.record.consumerRunIds.length]).toEqual(['COMPLETED', 3]);
    expect(swapsSent(s)).toBe(3); // one swap and two position transactions (one reverted); the swap was never sent again
    expect(done.record.journal.entries.filter(e => e.entityId === 'solana-composition-swap').map(e => e.toState)).toEqual(['PLANNED', 'READY', 'EXECUTING', 'RECONCILING', 'COMPLETED']);
  });
  it('lets the owner end a bound run keeping the swapped tokens, and blocks new runs until then', async () => {
    const s = await setup(), bound = await swapped(s);
    await expect(s.composition.simulate(composed(), s.wallet.owner)).rejects.toThrow('SOLANA_COMPOSITION_CONTINUE_EXISTING_RUN');
    const ended = await s.composition.end(bound.record.id);
    expect([ended.phase, ended.record.evidence]).toEqual(['PARTIAL', null]);
    await expect(s.composition.prepareLiquidity(bound.record.id, s.wallet.owner, composed(), (await createPositionMintSigner()).address)).rejects.toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    expect((await s.composition.simulate(composed(), s.wallet.owner)).phase).toBe('SIMULATED');
  });
  it('follows the step runs after a restart, at every point', async () => {
    const s = await setup(), view = await authorized(s), id = view.record.id;
    const begin = await s.composition.beginSwap(id, s.wallet.owner, composed());
    // The process stops after the wallet signed but before the composition learned anything; the swap run alone broadcast it.
    await s.swap.submit(view.record.producerRunId, s.wallet.sign(begin.unsignedTransaction));
    await s.swap.observe(view.record.producerRunId);
    const restarted = s.make();
    expect((await restarted.composition.status(id)).phase).toBe('PRODUCING');
    expect((await restarted.composition.observe(id))).toMatchObject({ phase: 'BOUND', record: { binding: { token: 1 } } });
    expect(swapsSent(s)).toBe(1);
    const again = s.make();
    const done = await position({ ...s, ...again }, id);
    expect(done.phase).toBe('COMPLETED');
    expect(await again.composition.runIds()).toEqual([id]);
  });
  it('ends an unsigned or reverted swap without any position, and allows a new run afterwards', async () => {
    const s = await setup(), view = await authorized(s);
    await s.composition.beginSwap(view.record.id, s.wallet.owner, composed());
    const declined = await s.composition.walletFailure(view.record.id, { step: 'SWAP', diagnostic: { stage: 'SIGN', code: 'DEVNET_SWAP_WALLET_REJECTED', error: { message: 'no' } } });
    expect([declined.phase, swapsSent(s)]).toEqual(['NOT_EXECUTED', 0]);
    await expect(s.composition.prepareLiquidity(view.record.id, s.wallet.owner, composed(), (await createPositionMintSigner()).address)).rejects.toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    s.tick(1_000);
    const second = await authorized(s);
    const begin = await s.composition.beginSwap(second.record.id, s.wallet.owner, composed());
    s.options.failSwap = true;
    await s.composition.submitSwap(second.record.id, s.wallet.sign(begin.unsignedTransaction));
    const failed = await s.composition.observe(second.record.id);
    expect([failed.phase, failed.swap.attempt!.state, failed.record.binding]).toEqual(['FAILED', 'REVERTED', null]);
  });
  it('blocks before the swap when the position is already known to be impossible', async () => {
    const opened = await setup({}, 3_000_000_000n, 50_000_000n);
    const key = await createPositionMintSigner(), isolated = { schemaVersion: '1.0.0' as const, workflowId: 'iso', revision: 1, resourceEdges: [],
      nodes: [createSolanaLiquidityNode('node-002', pool({ maxDevUsdc: '0.3' }))] };
    const lp = await opened.liquidity.simulate(isolated, opened.wallet.owner, { operation: 'OPEN', positionMint: key.address });
    await opened.liquidity.review(lp.id, lp.review.commitment, isolated);
    const begin = await opened.liquidity.begin(lp.id, opened.wallet.owner, isolated);
    await opened.liquidity.submit(lp.id, await signLiquidity(opened, begin, key));
    await opened.liquidity.observe(lp.id);
    await expect(opened.composition.simulate(composed(), opened.wallet.owner)).rejects.toThrow('SOLANA_COMPOSITION_PREFLIGHT_POSITION_ALREADY_OPEN');
    const poor = await setup({}, 120_000_000n);
    await expect(poor.composition.simulate(composed(), poor.wallet.owner)).rejects.toThrow('SOLANA_COMPOSITION_PREFLIGHT_SOL_SUFFICIENT');
    expect([swapsSent(opened), swapsSent(poor)]).toEqual([1, 0]);
  });
  it('never re-centres or changes the authorized position: a changed workflow is refused, and an edit before the swap retires the run', async () => {
    const s = await setup(), bound = await swapped(s);
    const moved = composed({ lower: '-39168' });
    await expect(s.composition.prepareLiquidity(bound.record.id, s.wallet.owner, moved, (await createPositionMintSigner()).address)).rejects.toThrow('SOLANA_COMPOSITION_SEMANTIC_REVISION_CHANGED');
    const t = await setup(), view = await authorized(t);
    const retired = await t.composition.invalidate(view.record.id);
    expect([retired.phase, retired.swap.authorization]).toEqual(['EXPIRED', null]);
    await expect(t.composition.beginSwap(view.record.id, t.wallet.owner, composed())).rejects.toThrow('SOLANA_COMPOSITION_EXISTING_ATTEMPT_OBSERVE_ONLY');
    await expect(t.composition.review(view.record.id, view.record.review.commitment, composed(undefined, '0.2'))).rejects.toThrow('SOLANA_COMPOSITION_SEMANTIC_REVISION_CHANGED');
  });
  it('keeps the isolated runtimes closed to the composed workflow', async () => {
    const s = await setup();
    // The composed workflow is valid authoring, but the isolated compile guard itself still refuses it.
    await expect(s.swap.simulate(composed(), s.wallet.owner)).rejects.toThrow('SOLANA_SWAP_ISOLATED_ONLY');
    await expect(s.liquidity.simulate(composed(), s.wallet.owner, { operation: 'OPEN', positionMint: (await createPositionMintSigner()).address }))
      .rejects.toThrow('SOLANA_LIQUIDITY_ISOLATED_ONLY');
  });
  it('refuses composed evidence that does not match the reconciled steps', async () => {
    const s = await setup(), done = await position(s, (await swapped(s)).record.id);
    const base = { id: done.record.id, review: done.record.review, journal: done.record.journal, provenance: 'MOCKED' as const, binding: done.record.binding!,
      swap: { runId: done.swap.id, evidence: done.swap.evidence!, observation: done.swap.observations.at(-1)! },
      liquidity: { runId: done.liquidity!.id, review: done.liquidity!.review, evidence: done.liquidity!.evidence!, observation: done.liquidity!.observations.at(-1)!, attempts: 1 } };
    expect(buildSolanaCompositionEvidence(base).bundle.outcome).toBe('RECONCILED');
    expect(() => buildSolanaCompositionEvidence({ ...base, binding: { ...base.binding, received: '1', bound: '1' } })).toThrow('SOLANA_COMPOSITION_EVIDENCE_SWAP_OUTPUT_MISMATCH');
    expect(() => buildSolanaCompositionEvidence({ ...base, binding: { ...base.binding, bound: '2' } })).toThrow('SOLANA_COMPOSITION_EVIDENCE_BOUND_MISMATCH');
    expect(() => buildSolanaCompositionEvidence({ ...base, binding: { ...base.binding, signature: '4'.repeat(88) } })).toThrow('SOLANA_COMPOSITION_EVIDENCE_SWAP_SIGNATURE_MISMATCH');
    expect(() => buildSolanaCompositionEvidence({ ...base, provenance: 'PUBLIC_DEVNET' })).toThrow('SOLANA_COMPOSITION_EVIDENCE_NOT_RECONCILED');
    const effects = { ...base.liquidity.observation.effects!, depositedB: (BigInt(base.binding.bound) + 1n).toString() };
    expect(() => buildSolanaCompositionEvidence({ ...base, liquidity: { ...base.liquidity, observation: { ...base.liquidity.observation, effects } } }))
      .toThrow('SOLANA_COMPOSITION_EVIDENCE_POSITION_DEPOSIT_MISMATCH');
  });
});
