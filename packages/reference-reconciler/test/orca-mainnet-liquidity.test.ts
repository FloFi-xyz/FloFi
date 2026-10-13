// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createConcentratedLiquidityNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as devnet, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, base58Encode, createMockedSolanaDevnetOrca, createMockedSolanaWallet,
  fromBase64, parseTransaction, serializeSignedTransaction, simulateOrcaLiquidity, toBase64, type OrcaLiquidityProfile } from '@defi-workflow-engine/reference-compiler';
import { createOrcaLiquidityRun, prepareOrcaLiquidityAttempt, validateOrcaLiquidityRun } from '../../reference-executor/src/orca-liquidity.js';
import { buildOrcaLiquidityEvidence, classifyOrcaLiquidityEvidence, reconcileOrcaLiquidityAttempt } from '../src/index.js';

/** BUILD-SOLANA-MAINNET-001: reconciliation and evidence of a mainnet-beta Orca position on a MOCKED loopback of the verified pool. */
const workflow = (profile: OrcaLiquidityProfile): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
  nodes: [createConcentratedLiquidityNode('node-002', { chain: profile.chain,
    token0: { chainId: profile.chain, address: profile.token0.mint, decimals: 9 }, token1: { chainId: profile.chain, address: profile.token1.mint, decimals: 6 },
    amount0Max: '10000000', amount1Max: '300000', amount0Min: '0', amount1Min: '0', tickLower: -39104, tickUpper: -36992, feeTier: profile.feeTier, slippageBps: 100,
    protocols: ['orca-whirlpools'], recipient: null, positionAsset: { chainId: profile.chain, address: profile.programs.whirlpool, decimals: 0 } })] });
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
async function landedOpen(profile: OrcaLiquidityProfile) {
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: profile }), wallet = createMockedSolanaWallet();
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
});
