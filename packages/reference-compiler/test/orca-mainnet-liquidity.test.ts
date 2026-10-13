// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createConcentratedLiquidityNode, type ConcentratedLiquidityFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_LIQUIDITY_PROFILES, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as devnet, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, assertOrcaLiquidityReview, base58Encode,
  createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, orcaLiquidityProfile, parseTransaction, readOrcaLiquidityPrice, requireOrcaLiquidityProfile,
  serializeSignedTransaction, simulateOrcaLiquidity, toBase64, verifySignedOrcaLiquidityTransaction, type OrcaLiquidityProfile, type OrcaLiquidityReview } from '../src/index.js';

/**
 * BUILD-SOLANA-MAINNET-001: the Orca liquidity engine on Solana mainnet-beta, on a MOCKED loopback of the verified SOL/USDC 0.30% pool
 * (genesis, pool, mints, vaults and fee rate of the mainnet profile; synthetic price). Nothing here is public or mainnet evidence.
 */
const fieldsOf = (profile: OrcaLiquidityProfile): ConcentratedLiquidityFields => ({ chain: profile.chain,
  token0: { chainId: profile.chain, address: profile.token0.mint, decimals: profile.token0.decimals },
  token1: { chainId: profile.chain, address: profile.token1.mint, decimals: profile.token1.decimals }, amount0Max: '10000000', amount1Max: '300000', amount0Min: '0',
  amount1Min: '0', tickLower: -39104, tickUpper: -36992, feeTier: profile.feeTier, slippageBps: 100, protocols: ['orca-whirlpools'], recipient: null,
  positionAsset: { chainId: profile.chain, address: profile.programs.whirlpool, decimals: 0 } });
const workflow = (profile: OrcaLiquidityProfile): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
  nodes: [createConcentratedLiquidityNode('node-002', fieldsOf(profile))] });
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const mintKey = () => { const secret = ed25519.utils.randomSecretKey(); return { secret, address: base58Encode(ed25519.getPublicKey(secret)) }; };
function setup(profile: OrcaLiquidityProfile, options: Parameters<typeof createMockedSolanaDevnetOrca>[0] = {}) {
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: profile, ...options }), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  return { env, wallet };
}
function fullySigned(wallet: ReturnType<typeof createMockedSolanaWallet>, review: OrcaLiquidityReview, mint: ReturnType<typeof mintKey> | null) {
  const { signatures, message } = parseTransaction(fromBase64(wallet.sign(review.unsignedTransaction), 2048));
  return toBase64(serializeSignedTransaction(mint ? [signatures[0]!, ed25519.sign(message, mint.secret)] : [signatures[0]!], message));
}

describe('Orca liquidity profiles', () => {
  it('resolves each cluster to its own profile and nothing else', () => {
    expect(ORCA_LIQUIDITY_PROFILES.map(p => [p.network, p.chain, p.cluster, p.walletChain])).toEqual([
      ['Solana Devnet', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'devnet', 'solana:devnet'],
      ['Solana', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'mainnet-beta', 'solana:mainnet'],
    ]);
    expect(orcaLiquidityProfile(mainnet.chain)).toBe(mainnet);
    expect(orcaLiquidityProfile(devnet.chain)).toBe(devnet);
    for (const chain of ['solana:devnet', 'solana:mainnet', 'eip155:8453', '', null]) expect(orcaLiquidityProfile(chain)).toBeNull();
    expect(() => requireOrcaLiquidityProfile('solana:testnet')).toThrow('SOLANA_CLUSTER_UNSUPPORTED');
  });
  it('pins the verified mainnet pool, real mints and evidence identity', () => {
    expect(mainnet.genesisHash).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    expect(mainnet.whirlpoolsConfig).toBe('2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ');
    expect(mainnet.pool).toEqual({ address: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ', tokenMintA: 'So11111111111111111111111111111111111111112',
      tokenMintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenVaultA: '3YQm7ujtXWJU2e9jhp2QGHpnn1ShXn12QjvzMvDgabpX',
      tokenVaultB: '2JTw1fE2wz1SymWUQ7UqpVtrTuKjcd6mWwYwUJUCh2rq', tickSpacing: 64 });
    expect([mainnet.token0.symbol, mainnet.token0.decimals, mainnet.token1.symbol, mainnet.token1.decimals, mainnet.feeTier]).toEqual(['SOL', 9, 'USDC', 6, 3000]);
    expect([mainnet.environment, mainnet.provenance, mainnet.executedEvidence, mainnet.bundleEnvironment, mainnet.realFunds]).toEqual(['MAINNET', 'PUBLIC_MAINNET', 'PUBLIC_EXECUTED', 'MAINNET_EXECUTED', true]);
    expect([devnet.environment, devnet.provenance, devnet.executedEvidence, devnet.bundleEnvironment, devnet.realFunds]).toEqual(['PUBLIC_TESTNET', 'PUBLIC_DEVNET', 'DEVNET_EXECUTED', 'TESTNET_EXECUTED', false]);
    // Devnet mints never appear on mainnet and the reverse.
    expect(mainnet.token1.mint).not.toBe(devnet.token1.mint);
    expect(mainnet.explorerTx('sig')).toBe('https://solscan.io/tx/sig');
    expect(devnet.explorerTx('sig')).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
  });
  it('shares the deployed program’s own constants across clusters', () => {
    for (const key of ['programs', 'instructions', 'events', 'positionDiscriminator', 'tickArrayDiscriminator', 'tickArraySize', 'minTick', 'maxTick', 'metadataUpdateAuth'] as const)
      expect(mainnet[key]).toEqual(devnet[key]);
  });
});

describe('Orca Whirlpools liquidity on Solana mainnet-beta (MOCKED loopback)', () => {
  it('opens, reviews and verifies a mainnet position against the mainnet pool, mints and evidence identity', async () => {
    const s = setup(mainnet), mint = mintKey();
    const review = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'OPEN', positionMint: mint.address }, s.env.rpc, NOW);
    expect({ chain: review.chain, cluster: review.cluster, genesis: review.genesisHash, pool: review.pool.address, config: review.whirlpoolsConfig })
      .toEqual({ chain: mainnet.chain, cluster: 'mainnet-beta', genesis: mainnet.genesisHash, pool: mainnet.pool.address, config: mainnet.whirlpoolsConfig });
    expect([review.token0, review.token1]).toEqual([{ symbol: 'SOL', mint: mainnet.token0.mint, decimals: 9 }, { symbol: 'USDC', mint: mainnet.token1.mint, decimals: 6 }]);
    expect(review.simulation.adapters).toEqual([{ id: 'orca.whirlpools-mainnet-liquidity', version: '1.0.0' }]);
    expect(review.simulation.contracts).toEqual([{ chainId: mainnet.chain, address: mainnet.programs.whirlpool, version: 'orca-whirlpools-mainnet' }]);
    expect(review.accounts.vaultA).toBe(mainnet.pool.tokenVaultA);
    expect(review.instructionSummary.map(i => i.name)).toEqual(['set_compute_unit_limit', 'create_idempotent', 'transfer', 'sync_native', 'create_idempotent',
      'open_position_with_token_extensions', 'increase_liquidity_v2', 'close_account']);
    assertOrcaLiquidityReview(review, workflow(mainnet), s.wallet.owner, 380_000_000, NOW);
    expect(verifySignedOrcaLiquidityTransaction(review, fullySigned(s.wallet, review, mint)).signature).toBeTruthy();
  });
  it('quotes the mainnet pool price for the authoring helper on the mainnet profile', async () => {
    const s = setup(mainnet);
    const price = await readOrcaLiquidityPrice(s.env.rpc, mainnet);
    expect(price.pool).toBe(mainnet.pool.address);
    expect(Math.abs(price.tickLower % 64)).toBe(0);
  });
  it('never crosses clusters: a mainnet workflow on a Devnet RPC, a Devnet workflow on a mainnet RPC, or a Review moved to another cluster', async () => {
    const devnetRpc = setup(devnet), mainnetRpc = setup(mainnet);
    await expect(simulateOrcaLiquidity(workflow(mainnet), devnetRpc.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, devnetRpc.env.rpc, NOW))
      .rejects.toThrow('SOLANA_WRONG_CLUSTER');
    await expect(simulateOrcaLiquidity(workflow(devnet), mainnetRpc.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, mainnetRpc.env.rpc, NOW))
      .rejects.toThrow('SOLANA_WRONG_CLUSTER');
    const review = await simulateOrcaLiquidity(workflow(mainnet), mainnetRpc.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, mainnetRpc.env.rpc, NOW);
    expect(() => assertOrcaLiquidityReview(review, workflow(devnet), mainnetRpc.wallet.owner, 380_000_000, NOW)).toThrow('ORCA_LIQUIDITY_SEMANTIC_REVISION_CHANGED');
    expect(() => assertOrcaLiquidityReview({ ...review, chain: devnet.chain }, workflow(mainnet), mainnetRpc.wallet.owner, 380_000_000, NOW))
      .toThrow('ORCA_LIQUIDITY_AUTHORIZATION_INVALID');
  });
  it('refuses a Devnet mint, fee tier or pool on the mainnet cluster', async () => {
    const s = setup(mainnet);
    const devnetToken = { ...workflow(mainnet), nodes: [createConcentratedLiquidityNode('node-002', { ...fieldsOf(mainnet),
      token1: { chainId: mainnet.chain, address: devnet.token1.mint, decimals: 6 } })] };
    await expect(simulateOrcaLiquidity(devnetToken, s.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, s.env.rpc, NOW)).rejects.toThrow('SOLANA_MINT_UNSUPPORTED');
    const devnetFee = { ...workflow(mainnet), nodes: [createConcentratedLiquidityNode('node-002', { ...fieldsOf(mainnet), feeTier: devnet.feeTier })] };
    await expect(simulateOrcaLiquidity(devnetFee, s.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, s.env.rpc, NOW)).rejects.toThrow('SOLANA_LIQUIDITY_POOL_UNSUPPORTED');
    const emitting = setup(mainnet, { poolRewardMint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', poolRewardEmissionsX64: 1n });
    await expect(simulateOrcaLiquidity(workflow(mainnet), emitting.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, emitting.env.rpc, NOW))
      .rejects.toThrow('ORCA_POOL_REWARDS_UNSUPPORTED');
  });
  it('accepts the mainnet pool’s initialized ORCA reward slot only while it emits nothing', async () => {
    const s = setup(mainnet, { poolRewardMint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' });
    const review = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, s.env.rpc, NOW);
    expect(review.pool.address).toBe(mainnet.pool.address);
  });
  it('names the missing mainnet token in an insufficient-balance failure', async () => {
    const env = createMockedSolanaDevnetOrca({ liquidityProfile: mainnet }), wallet = createMockedSolanaWallet();
    env.fund(wallet.owner, 3_000_000_000n, 1n);
    await expect(simulateOrcaLiquidity(workflow(mainnet), wallet.owner, { operation: 'OPEN', positionMint: mintKey().address }, env.rpc, NOW)).rejects.toThrow('ORCA_LIQUIDITY_INSUFFICIENT_USDC');
  });
});
