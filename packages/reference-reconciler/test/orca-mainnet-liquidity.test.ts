// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createConcentratedLiquidityNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as devnet, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, base58Encode, createMockedSolanaDevnetOrca, createMockedSolanaWallet,
  fromBase64, parseTransaction, serializeSignedTransaction, simulateOrcaLiquidity, toBase64, type MockedOrcaOptions, type OrcaLiquidityProfile, type OrcaLiquidityReview,
  type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { createOrcaLiquidityRun, prepareOrcaLiquidityAttempt, validateOrcaLiquidityRun } from '../../reference-executor/src/orca-liquidity.js';
import { buildOrcaLiquidityEvidence, classifyOrcaLiquidityEvidence, reconcileOrcaLiquidityAttempt } from '../src/index.js';

/** BUILD-SOLANA-MAINNET-001: reconciliation and evidence of a mainnet-beta Orca position on a MOCKED loopback of the verified pool. */
const workflow = (profile: OrcaLiquidityProfile): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
  nodes: [createConcentratedLiquidityNode('node-002', { chain: profile.chain,
    token0: { chainId: profile.chain, address: profile.token0.mint, decimals: 9 }, token1: { chainId: profile.chain, address: profile.token1.mint, decimals: 6 },
    amount0Max: '10000000', amount1Max: '300000', amount0Min: '0', amount1Min: '0', tickLower: -39104, tickUpper: -36992, feeTier: profile.feeTier, slippageBps: 100,
    protocols: ['orca-whirlpools'], recipient: null, positionAsset: { chainId: profile.chain, address: profile.programs.whirlpool, decimals: 0 } })] });
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
async function landedOpen(profile: OrcaLiquidityProfile, options: MockedOrcaOptions = {}) {
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: profile, ...options }), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  const secret = ed25519.utils.randomSecretKey(), mint = base58Encode(ed25519.getPublicKey(secret));
  const open = await simulateOrcaLiquidity(workflow(profile), wallet.owner, { operation: 'OPEN', positionMint: mint }, env.rpc, NOW);
  const { signatures, message } = parseTransaction(fromBase64(wallet.sign(open.unsignedTransaction), 2048));
  const transaction = toBase64(serializeSignedTransaction([signatures[0]!, ed25519.sign(message, secret)], message));
  const signature = await env.rpc('sendTransaction', [transaction, {}]) as string;
  return { env, wallet, open, attempt: { signature, transaction } };
}

describe('Orca liquidity on Solana mainnet-beta: reconciliation and evidence (MOCKED loopback)', () => {
  it('reconciles a mainnet OPEN and classifies an owner-initiated public mainnet run as PUBLIC_EXECUTED with MAINNET_EXECUTED bundle environment', async () => {
    const s = await landedOpen(mainnet);
    const observation = await reconcileOrcaLiquidityAttempt(s.open, s.attempt, s.env.rpc);
    expect(observation).toMatchObject({ verdict: 'RECONCILED', explorer: `https://solscan.io/tx/${s.attempt.signature}` });
    expect(classifyOrcaLiquidityEvidence({ provenance: 'PUBLIC_MAINNET', ownerInitiated: true, observation })).toBe('PUBLIC_EXECUTED');
    expect(classifyOrcaLiquidityEvidence({ provenance: 'PUBLIC_MAINNET', ownerInitiated: false, observation })).toBe('PUBLIC_READ_ONLY');
    expect(classifyOrcaLiquidityEvidence({ provenance: 'PUBLIC_MAINNET', ownerInitiated: true, observation: { ...observation, verdict: 'DIVERGENT' } })).toBe('PUBLIC_READ_ONLY');
    expect(classifyOrcaLiquidityEvidence({ provenance: 'MOCKED', ownerInitiated: true, observation })).toBe('MOCKED');
    const run = prepareOrcaLiquidityAttempt({ ...createOrcaLiquidityRun('orcalp-' + 'b'.repeat(32), s.open, 'PUBLIC_MAINNET'), authorization: s.open.commitment }, 1);
    const evidence = buildOrcaLiquidityEvidence({ id: run.id, review: s.open, journal: run.journal, provenance: 'PUBLIC_MAINNET', ownerInitiated: true, observation, lifecycle: null });
    expect(evidence.evidenceClass).toBe('PUBLIC_EXECUTED');
    expect(evidence.bundle.environment).toBe('MAINNET_EXECUTED');
    expect(evidence.publicExecution).toMatchObject({ network: 'Solana', cluster: 'mainnet-beta', genesisHash: mainnet.genesisHash, realFunds: true,
      provider: 'Orca Whirlpools (Solana)', pool: mainnet.pool.address });
    // MOCKED loopback evidence of the same run is never real funds or mainnet evidence.
    const mocked = buildOrcaLiquidityEvidence({ id: run.id, review: s.open, journal: run.journal, provenance: 'MOCKED', ownerInitiated: true, observation, lifecycle: null });
    expect([mocked.evidenceClass, mocked.bundle.environment, mocked.publicExecution.realFunds]).toEqual(['MOCKED', 'MOCKED', false]);
  });
  it('refuses a public provenance that does not match the reviewed cluster', async () => {
    const s = await landedOpen(mainnet), observation = await reconcileOrcaLiquidityAttempt(s.open, s.attempt, s.env.rpc);
    expect(() => createOrcaLiquidityRun('orcalp-' + 'c'.repeat(32), s.open, 'PUBLIC_DEVNET')).toThrow('ORCA_LIQUIDITY_AUTHORIZATION_INVALID');
    const run = createOrcaLiquidityRun('orcalp-' + 'c'.repeat(32), s.open, 'PUBLIC_MAINNET');
    expect(() => validateOrcaLiquidityRun({ ...run, provenance: 'PUBLIC_DEVNET' })).toThrow('ORCA_LIQUIDITY_STORE_CORRUPT');
    expect(() => buildOrcaLiquidityEvidence({ id: run.id, review: s.open, journal: run.journal, provenance: 'PUBLIC_DEVNET', ownerInitiated: true, observation, lifecycle: null }))
      .toThrow('ORCA_LIQUIDITY_EVIDENCE_CLUSTER_MISMATCH');
    const d = await landedOpen(devnet);
    expect(() => createOrcaLiquidityRun('orcalp-' + 'd'.repeat(32), d.open, 'PUBLIC_MAINNET')).toThrow('ORCA_LIQUIDITY_AUTHORIZATION_INVALID');
  });
  it('never reconciles a mainnet Review against a Devnet cluster', async () => {
    const s = await landedOpen(mainnet), devnetRpc = createMockedSolanaDevnetOrca();
    const observation = await reconcileOrcaLiquidityAttempt(s.open, s.attempt, devnetRpc.rpc);
    expect(observation.verdict).not.toBe('RECONCILED');
    expect(observation.reason).toBe('SOLANA_WRONG_CLUSTER');
  });
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: every lifecycle operation after OPEN, reconciled from finalized transaction facts only.
  it('reconciles a mainnet DECREASE_PARTIAL, COLLECT and EXIT from finalized facts; MOCKED provenance stays MOCKED evidence', async () => {
    const s = await landedOpen(mainnet, { accrueFees: { a: '777', b: '33' } }), mint = s.open.accounts.positionMint, owner = s.wallet.owner;
    const decrease = await simulateOrcaLiquidity(workflow(mainnet), owner, { operation: 'DECREASE_PARTIAL', positionMint: mint, partBps: 5000 }, s.env.rpc, NOW);
    const d = await reconcileOrcaLiquidityAttempt(decrease, await send(s, decrease), s.env.rpc);
    expect(d).toMatchObject({ verdict: 'RECONCILED', confirmation: 'finalized', instructions: decrease.instructionSummary.map(i => i.name), positionAuthority: { owner, amount: '1' } });
    // Principal from the LiquidityDecreased event; fees are only the extra vault outflow.
    expect(d.effects).toMatchObject({ withdrawnPrincipalA: d.events[0]!.tokenA, withdrawnPrincipalB: d.events[0]!.tokenB, collectedFeesA: '777', collectedFeesB: '33', closedAccounts: [] });
    s.env.trade();
    const collect = await simulateOrcaLiquidity(workflow(mainnet), owner, { operation: 'COLLECT', positionMint: mint }, s.env.rpc, NOW);
    const collectAttempt = await send(s, collect), c = await reconcileOrcaLiquidityAttempt(collect, collectAttempt, s.env.rpc);
    expect(c).toMatchObject({ verdict: 'RECONCILED', reason: 'ORCA_LIQUIDITY_TRANSACTION_AND_BALANCES_VERIFIED', events: [],
      instructions: ['set_compute_unit_limit', 'create_idempotent', 'create_idempotent', 'update_fees_and_rewards', 'collect_fees_v2', 'close_account'],
      // The position stays open: the owner still holds its single Token-2022 position token after the collect.
      positionAuthority: { tokenAccount: collect.accounts.positionTokenAccount, owner, amount: '1' },
      effects: { withdrawnPrincipalA: '0', withdrawnPrincipalB: '0', collectedFeesA: '777', collectedFeesB: '33', depositedA: '0', depositedB: '0', closedAccounts: [], rentRefundedLamports: '0' } });
    expect(c.owner).toMatchObject({ tokenBAfter: (BigInt(c.owner!.tokenBBefore!) + 33n).toString() });
    expect(classifyOrcaLiquidityEvidence({ provenance: 'MOCKED', ownerInitiated: true, observation: c })).toBe('MOCKED');
    const run = prepareOrcaLiquidityAttempt({ ...createOrcaLiquidityRun('orcalp-' + 'e'.repeat(32), collect, 'MOCKED'), authorization: collect.commitment }, 1);
    expect(run.journal.entries.find(e => e.level === 'step')?.entityId).toBe('orca-liquidity-collect');
    expect(() => validateOrcaLiquidityRun(run)).not.toThrow();
    const evidence = buildOrcaLiquidityEvidence({ id: run.id, review: collect, journal: run.journal, provenance: 'MOCKED', ownerInitiated: true, observation: c, lifecycle: null });
    expect([evidence.evidenceClass, evidence.bundle.environment, evidence.publicExecution.realFunds]).toEqual(['MOCKED', 'MOCKED', false]);
    expect(evidence.publicExecution).toMatchObject({ operation: 'COLLECT', liquidityDelta: '0', withdrawnPrincipal: { a: '0', b: '0' }, collectedFees: { a: '777', b: '33' } });
    expect(evidence.bundle.reconciliation.positions).toEqual([{ asset: { chainId: mainnet.chain, address: mainnet.programs.whirlpool, decimals: 0 }, amount: '1' }]);
    expect(evidence.bundle.receipts[0]!.receiptId).toBe('orca-liquidity-collect-transaction');
    expect(evidence.bundleHash).toMatch(/^0x[0-9a-f]{64}$/);
    // A liquidity event inside a collect is never read as principal: the observation fails closed instead.
    const decreasedLog = (await s.env.rpc('getTransaction', [d.signature, {}]) as { meta: { logMessages: string[] } }).meta.logMessages.find(l => l.startsWith('Program data:'))!;
    const withEvent: SolanaRpc = async (method, params) => {
      const value = await s.env.rpc(method, params);
      if (method !== 'getTransaction' || !value) return value;
      const copy = structuredClone(value) as { meta: { logMessages: string[] } }; copy.meta.logMessages.push(decreasedLog); return copy;
    };
    expect(await reconcileOrcaLiquidityAttempt(collect, collectAttempt, withEvent)).toMatchObject({ verdict: 'DIVERGENT', reason: 'ORCA_LIQUIDITY_EVENT_MISMATCH', effects: null });
    const exit = await simulateOrcaLiquidity(workflow(mainnet), owner, { operation: 'EXIT', positionMint: mint }, s.env.rpc, NOW);
    const e = await reconcileOrcaLiquidityAttempt(exit, await send(s, exit), s.env.rpc);
    expect(e).toMatchObject({ verdict: 'RECONCILED', effects: { collectedFeesA: '0', collectedFeesB: '0', closedAccounts: [exit.accounts.position, mint, exit.accounts.positionTokenAccount] } });
    expect(e.effects!.rentRefundedLamports).toBe(s.open.simulationResult.rentPaidLamports);
    const exitRun = prepareOrcaLiquidityAttempt({ ...createOrcaLiquidityRun('orcalp-' + 'f'.repeat(32), exit, 'MOCKED'), authorization: exit.commitment }, 1);
    const exitEvidence = buildOrcaLiquidityEvidence({ id: exitRun.id, review: exit, journal: exitRun.journal, provenance: 'MOCKED', ownerInitiated: true, observation: e, lifecycle: null });
    expect([exitEvidence.evidenceClass, exitEvidence.bundle.reconciliation.positions]).toEqual(['MOCKED', []]);
  });
});
async function send(s: Awaited<ReturnType<typeof landedOpen>>, review: OrcaLiquidityReview) {
  const transaction = s.wallet.sign(review.unsignedTransaction);
  return { signature: await s.env.rpc('sendTransaction', [transaction, {}]) as string, transaction };
}
