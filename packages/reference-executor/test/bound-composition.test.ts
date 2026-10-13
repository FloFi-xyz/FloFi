// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { bindConcentratedLiquidityNode, createConcentratedLiquidityNode, createExactInputSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, ORCA_WHIRLPOOLS_DEVNET, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as lp, simulateOrcaDevnetSwap, simulateSolanaComposition,
  SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS, SOLANA_DEVNET_TOKENS } from '@defi-workflow-engine/reference-compiler';
import { attentionBoundComposition, authorizeBoundComposition, bindBoundComposition, boundCompositionOpen, boundCompositionPhase, completeBoundComposition,
  createBoundCompositionRun, endBoundComposition, expireBoundComposition, failBoundCompositionProducer, pauseBoundCompositionConsumer, startBoundCompositionConsumer,
  startBoundCompositionProducer, submittedBoundCompositionConsumer, submittedBoundCompositionProducer, validateBoundCompositionRun, type BoundCompositionRun } from '../src/index.js';

type Node = SemanticWorkflow['nodes'][number];
const chain = ORCA_WHIRLPOOLS_DEVNET.chain, NOW = Date.parse('2026-10-01T12:00:00.000Z');
const token = (t: { mint: string; decimals: number }) => ({ chainId: chain, address: t.mint, decimals: t.decimals });
const swap = createExactInputSwapNode('node-002', { chain, input: token(SOLANA_DEVNET_TOKENS.SOL), output: token(SOLANA_DEVNET_TOKENS.devUSDC), amount: '100000000', slippageBps: 50,
  protocols: [ORCA_WHIRLPOOLS_DEVNET.protocol], maximumAmount: SOLANA_DEVNET_TOKENS.SOL.maximumAmount }) as Node;
const pool = (cap = '2000000') => bindConcentratedLiquidityNode(createConcentratedLiquidityNode('node-003', { chain, token0: token(lp.token0), token1: token(lp.token1),
  amount0Max: '50000000', amount1Max: cap, amount0Min: '0', amount1Min: '0', tickLower: -39104, tickUpper: -36992, feeTier: lp.feeTier, slippageBps: 100, protocols: [lp.protocol],
  recipient: null, positionAsset: { chainId: chain, address: lp.programs.whirlpool, decimals: 0 } }), { token: 1, nodeId: 'node-002', outputId: 'amount-out' }) as Node;
const workflow = (cap?: string): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'w-composition', revision: 3, nodes: [swap, pool(cap)],
  resourceEdges: [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source' }] });
const ID = 'solcomp-' + 'a'.repeat(32), SWAP_ID = 'orca-' + 'b'.repeat(32), LP = (n: number) => 'orcalp-' + String(n).repeat(32);
const SIGNATURE = '5'.repeat(88), EVIDENCE = '0x' + 'c'.repeat(64);
async function created(cap?: string): Promise<BoundCompositionRun> {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 0n);
  const w = workflow(cap);
  const review = await simulateOrcaDevnetSwap({ ...w, nodes: [swap], resourceEdges: [] }, wallet.owner, env.rpc, NOW);
  return createBoundCompositionRun(ID, await simulateSolanaComposition(w, wallet.owner, { runId: SWAP_ID, review }, env.rpc, NOW), SWAP_ID, 'MOCKED');
}
const valid = (run: BoundCompositionRun) => { validateBoundCompositionRun(JSON.parse(JSON.stringify(run))); return run; };
const authorized = async (cap?: string) => { const run = await created(cap); return authorizeBoundComposition(run, run.review.commitment); };
const bound = async (cap?: string) => bindBoundComposition(submittedBoundCompositionProducer(startBoundCompositionProducer(await authorized(cap))),
  { signature: SIGNATURE, slot: 1, received: '2226000', evidenceHash: EVIDENCE });

describe('bound composition run (frozen v1 journal, MOCKED inputs)', () => {
  it('walks Simulated → Authorized → swap → bound → position → completed with a valid journal at every step', async () => {
    let run = valid(await created());
    expect(boundCompositionPhase(run)).toBe('SIMULATED');
    expect(boundCompositionOpen(run)).toBe(false);
    run = valid(authorizeBoundComposition(run, run.review.commitment));
    expect(boundCompositionPhase(run)).toBe('AUTHORIZED');
    run = valid(startBoundCompositionProducer(run));
    expect([boundCompositionPhase(run), boundCompositionOpen(run)]).toEqual(['PRODUCING', true]);
    run = valid(submittedBoundCompositionProducer(run));
    run = valid(bindBoundComposition(run, { signature: SIGNATURE, slot: 9, received: '2226000', evidenceHash: EVIDENCE }));
    expect(run.binding).toMatchObject({ producerRunId: SWAP_ID, received: '2226000', cap: '2000000', bound: '2000000', token: 1 });
    expect(boundCompositionPhase(run)).toBe('BOUND');
    run = valid(startBoundCompositionConsumer(run, LP(1)));
    expect(boundCompositionPhase(run)).toBe('CONSUMING');
    run = valid(completeBoundComposition(submittedBoundCompositionConsumer(run)));
    expect([boundCompositionPhase(run), boundCompositionOpen(run)]).toEqual(['COMPLETED', false]);
    expect(run.journal.entries.filter(e => e.level === 'workflow').map(e => e.toState)).toEqual(['DRAFT', 'REVIEWED', 'SIMULATED', 'AUTHORIZED', 'EXECUTING', 'RECONCILING', 'COMPLETED']);
  });
  it('binds 100% of the received output when the cap is above it, and never more than the cap', async () => {
    expect((await bound(lp.token1.maximumAmount)).binding).toMatchObject({ received: '2226000', bound: '2226000' });
    expect((await bound('1000000')).binding).toMatchObject({ bound: '1000000' });
  });
  it('never starts the swap twice and never binds a swap that was not reconciled', async () => {
    const producing = startBoundCompositionProducer(await authorized());
    expect(() => startBoundCompositionProducer(producing)).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    expect(() => bindBoundComposition(producing, { signature: SIGNATURE, slot: 1, received: '1', evidenceHash: EVIDENCE })).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    expect(() => startBoundCompositionConsumer(producing, LP(1))).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    const b = await bound();
    expect(() => startBoundCompositionProducer(b)).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    expect(() => authorizeBoundComposition(b, b.review.commitment)).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    expect(() => bindBoundComposition(submittedBoundCompositionProducer(producing), { signature: SIGNATURE, slot: 1, received: '0', evidenceHash: EVIDENCE }))
      .toThrow('SOLANA_COMPOSITION_BINDING_INVALID');
  });
  it('ends an unsigned or unexecuted swap as not executed, and a reverted one as failed, without ever starting the position', async () => {
    const producing = startBoundCompositionProducer(await authorized());
    const unsigned = valid(failBoundCompositionProducer(producing, false));
    expect([boundCompositionPhase(unsigned), boundCompositionOpen(unsigned)]).toEqual(['NOT_EXECUTED', false]);
    expect(() => failBoundCompositionProducer(producing, true)).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    const reverted = valid(failBoundCompositionProducer(submittedBoundCompositionProducer(producing), true));
    expect(boundCompositionPhase(reverted)).toBe('FAILED');
    expect(() => startBoundCompositionConsumer(reverted, LP(1))).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
    const unknown = valid(attentionBoundComposition(submittedBoundCompositionProducer(producing), 'producer'));
    expect([boundCompositionPhase(unknown), boundCompositionOpen(unknown)]).toEqual(['ATTENTION', true]);
  });
  it('keeps the swap done across failed position attempts, bounds the attempts, and lets the owner end with the swapped tokens', async () => {
    let run = await bound();
    for (let n = 1; n <= SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS; n++) {
      run = startBoundCompositionConsumer(run, LP(n));
      expect(() => startBoundCompositionConsumer(run, LP(9))).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
      run = valid(pauseBoundCompositionConsumer(n % 2 ? run : submittedBoundCompositionConsumer(run)));
      expect(boundCompositionPhase(run)).toBe('BOUND');
    }
    expect(() => startBoundCompositionConsumer(run, LP(9))).toThrow('SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS_EXHAUSTED');
    const ended = valid(endBoundComposition(run));
    expect([boundCompositionPhase(ended), boundCompositionOpen(ended)]).toEqual(['PARTIAL', false]);
    const consuming = startBoundCompositionConsumer(await bound(), LP(1));
    expect(() => endBoundComposition(consuming)).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
  });
  it('expires only before the swap starts', async () => {
    const run = await created();
    expect(boundCompositionPhase(valid(expireBoundComposition(run)))).toBe('EXPIRED');
    expect(boundCompositionPhase(valid(expireBoundComposition(authorizeBoundComposition(run, run.review.commitment))))).toBe('EXPIRED');
    expect(() => expireBoundComposition(startBoundCompositionProducer(authorizeBoundComposition(run, run.review.commitment)))).toThrow('SOLANA_COMPOSITION_STATE_INVALID');
  });
  it('rejects tampered records', async () => {
    const b = await bound();
    for (const tampered of [{ ...b, binding: { ...b.binding!, bound: '2226000' } }, { ...b, binding: null }, { ...b, authorization: null }, { ...b, producerRunId: 'orca-' + 'd'.repeat(32) },
      { ...b, consumerRunIds: ['orcalp-x'] }, { ...b, review: { ...b.review, liquidity: { ...b.review.liquidity, cap: '1' } } }, { ...b, id: 'solcomp-1' }])
      expect(() => validateBoundCompositionRun(tampered as BoundCompositionRun)).toThrow('SOLANA_COMPOSITION_STORE_CORRUPT');
  });
});
