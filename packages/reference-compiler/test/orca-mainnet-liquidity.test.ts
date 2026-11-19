// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createConcentratedLiquidityNode, type ConcentratedLiquidityFields, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_LIQUIDITY_OPERATIONS, ORCA_LIQUIDITY_PROFILES, ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY as devnet, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, assertOrcaLiquidityReview,
  associatedTokenAddress, base58Encode, compileMessageV0, createMockedSolanaDevnetOrca, createMockedSolanaWallet, decodeSplTokenAccount, decodeToken2022Account,
  encodeOrcaUpdateFeesAndRewards, fromBase64, inspectOrcaPosition, orcaLiquidityAccounts,
  orcaLiquidityInstructions, orcaLiquidityProfile, orcaPositionAddress, orcaPositionTokenAccount, parseTransaction, readOrcaLiquidityPrice, requireOrcaLiquidityProfile,
  serializeMessageV0, serializeSignedTransaction, simulateOrcaLiquidity, solanaSwapHash, summarizeOrcaLiquidityInstructions, toBase64, verifySignedOrcaLiquidityTransaction,
  type OrcaLiquidityPlan, type OrcaLiquidityProfile, type OrcaLiquidityReview } from '../src/index.js';

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
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: every pinned Whirlpools discriminator is Anchor's own sha256 rule, recomputed here rather than copied.
  it('recomputes every pinned Whirlpool discriminator from Anchor’s sha256 rule', () => {
    const anchor = (namespace: string, name: string) => createHash('sha256').update(`${namespace}:${name}`).digest('hex').slice(0, 16);
    const snake = (name: string) => name.replace(/[A-Z0-9]+/g, part => '_' + part.toLowerCase());
    expect(Object.keys(mainnet.instructions).sort()).toEqual(['closePositionWithTokenExtensions', 'collectFeesV2', 'decreaseLiquidityV2', 'increaseLiquidityV2',
      'openPositionWithTokenExtensions', 'updateFeesAndRewards']);
    for (const [name, pinned] of Object.entries(mainnet.instructions)) expect([snake(name), pinned]).toEqual([snake(name), anchor('global', snake(name))]);
    expect(mainnet.instructions.updateFeesAndRewards).toBe('9ae6fa0decd14bdf');
    expect(anchor('global', 'update_fees_and_rewards')).toBe('9ae6fa0decd14bdf');
    expect(mainnet.events).toEqual({ positionOpened: anchor('event', 'PositionOpened'), liquidityIncreased: anchor('event', 'LiquidityIncreased'),
      liquidityDecreased: anchor('event', 'LiquidityDecreased') });
    expect([mainnet.positionDiscriminator, mainnet.tickArrayDiscriminator]).toEqual([anchor('account', 'Position'), anchor('account', 'TickArray')]);
    expect(Buffer.from(encodeOrcaUpdateFeesAndRewards()).toString('hex')).toBe('9ae6fa0decd14bdf');
    expect(ORCA_LIQUIDITY_OPERATIONS).toEqual(['OPEN', 'DECREASE_PARTIAL', 'EXIT', 'COLLECT']);
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

/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the position lifecycle on the MOCKED mainnet loopback (partial removal, collect-only, exit), plus positions written
 * straight into the MOCKED chain state as if another app had opened them. Nothing here is public or mainnet evidence.
 */
const POSITION_RENT = 2_885_440n, MINT_RENT = 1_676_400n, POSITION_TOKEN_RENT = 1_513_840n;
type Setup = ReturnType<typeof setup>;
async function landOpen(s: Setup) {
  const mint = mintKey();
  const review = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'OPEN', positionMint: mint.address }, s.env.rpc, NOW);
  await s.env.rpc('sendTransaction', [fullySigned(s.wallet, review, mint), {}]);
  return { mint: mint.address, review };
}
const land = (s: Setup, review: OrcaLiquidityReview) => s.env.rpc('sendTransaction', [fullySigned(s.wallet, review, null), {}]);
/** A position on the verified pool whose token the owner holds, written into the MOCKED chain state directly (not opened through FloFi). */
function externalPosition(s: Setup, options: { liquidity?: bigint; feeOwedA?: bigint; feeOwedB?: bigint; rewardOwed?: bigint[]; legacyToken?: boolean; delegate?: string } = {}) {
  const mint = mintKey().address, position = orcaPositionAddress(mint), owner = s.wallet.owner;
  s.env.state.positions.set(position, { mint, liquidity: options.liquidity ?? 0n, lower: -39104, upper: -36992, feeOwedA: options.feeOwedA ?? 0n, feeOwedB: options.feeOwedB ?? 0n,
    ...options.rewardOwed ? { rewardOwed: options.rewardOwed } : {} });
  s.env.state.lamportsOf.set(position, POSITION_RENT); s.env.state.mints.add(mint); s.env.state.lamportsOf.set(mint, MINT_RENT);
  // A legacy (SPL Token) position token sits in the owner's SPL-Token associated account, not in the Token-2022 one.
  const tokenAccount = options.legacyToken ? associatedTokenAddress(owner, mint, mainnet.programs.token, mainnet.programs.associatedToken) : orcaPositionTokenAccount(owner, mint);
  (options.legacyToken ? s.env.state.tokens : s.env.state.tokens2022).set(tokenAccount, { mint, owner, amount: 1n, ...options.delegate ? { delegate: options.delegate } : {} });
  s.env.state.lamportsOf.set(tokenAccount, POSITION_TOKEN_RENT);
  return { mint, position };
}
const names = (review: OrcaLiquidityReview) => review.instructionSummary.map(i => i.name);
const usdcOf = (s: Setup) => s.env.state.tokens.get(s.env.ata(s.wallet.owner, mainnet.token1.mint))!.amount;
const functions = (review: OrcaLiquidityReview) => review.policy.allowlists.functions.map(f => f.functionId);

describe('Orca position lifecycle on Solana mainnet-beta: partial removal, collect-only and exit (MOCKED loopback)', () => {
  it('partially removes 50% of the liquidity with fee collection and keeps the position open', async () => {
    const s = setup(mainnet, { accrueFees: { a: '777', b: '33' } }), open = await landOpen(s);
    const review = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'DECREASE_PARTIAL', positionMint: open.mint, partBps: 5000 }, s.env.rpc, NOW);
    const liquidity = BigInt(open.review.expected.liquidity);
    expect(review).toMatchObject({ operation: 'DECREASE_PARTIAL', partBps: 5000, signers: [s.wallet.owner],
      operationPlan: { operation: 'DECREASE_PARTIAL', liquidityDelta: (liquidity / 2n).toString(), decrease: true, close: false },
      expected: { positionLiquidityAfter: (liquidity - liquidity / 2n).toString() } });
    expect('refreshFees' in review.operationPlan).toBe(false);
    expect(names(review)).toEqual(['set_compute_unit_limit', 'create_idempotent', 'create_idempotent', 'decrease_liquidity_v2', 'collect_fees_v2', 'close_account']);
    // Principal from the LiquidityDecreased event; the fees the decrease checkpointed are the remaining vault outflow.
    expect(review.simulationResult).toMatchObject({ withdrawnPrincipalA: review.expected.amountA, withdrawnPrincipalB: review.expected.amountB, collectedFeesA: '777', collectedFeesB: '33' });
    expect(functions(review)).toEqual(['decrease-liquidity-v2', 'collect-fees-v2']);
    assertOrcaLiquidityReview(review, workflow(mainnet), s.wallet.owner, 380_000_000, NOW);
    await land(s, review);
    expect(s.env.state.positions.get(orcaPositionAddress(open.mint))).toMatchObject({ liquidity: liquidity - liquidity / 2n, feeOwedA: 0n, feeOwedB: 0n });
  });
  it('exits: removes all liquidity, collects fees, closes the position and refunds every deposit', async () => {
    const s = setup(mainnet), open = await landOpen(s);
    const exit = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'EXIT', positionMint: open.mint }, s.env.rpc, NOW);
    expect(names(exit)).toEqual(['set_compute_unit_limit', 'create_idempotent', 'create_idempotent', 'decrease_liquidity_v2', 'collect_fees_v2',
      'close_position_with_token_extensions', 'close_account']);
    expect(exit).toMatchObject({ operationPlan: { operation: 'EXIT', liquidityDelta: open.review.expected.liquidity, close: true }, expected: { positionLiquidityAfter: '0' } });
    expect(exit.simulationResult.closedAccounts).toEqual([exit.accounts.position, open.mint, exit.accounts.positionTokenAccount]);
    expect(exit.simulationResult.rentRefundedLamports).toBe((POSITION_RENT + MINT_RENT + POSITION_TOKEN_RENT).toString());
    expect(exit.simulationResult.rentRefundedLamports).toBe(open.review.simulationResult.rentPaidLamports);
    const before = s.env.state.lamports.get(s.wallet.owner)!;
    await land(s, exit);
    expect(s.env.state.positions.has(exit.accounts.position)).toBe(false);
    expect(s.env.state.lamports.get(s.wallet.owner)! - before)
      .toBe(BigInt(exit.simulationResult.withdrawnPrincipalA) + POSITION_RENT + MINT_RENT + POSITION_TOKEN_RENT - BigInt(exit.estimatedFeeLamports));
  });
  it('collects fees only: checkpoint then collect; liquidity, range and position unchanged; nothing is principal', async () => {
    const s = setup(mainnet, { accrueFees: { a: '777', b: '33' } }), open = await landOpen(s);
    const collect = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: open.mint }, s.env.rpc, NOW);
    // The mainnet profile reviews no compute-unit price (0), so the head is the limit and the owner's two token accounts.
    expect(names(collect)).toEqual(['set_compute_unit_limit', 'create_idempotent', 'create_idempotent', 'update_fees_and_rewards', 'collect_fees_v2', 'close_account']);
    expect(collect.instructionSummary[3]).toEqual({ programId: mainnet.programs.whirlpool, name: 'update_fees_and_rewards', args: {} });
    expect(collect).toMatchObject({ operation: 'COLLECT', partBps: null, signers: [s.wallet.owner],
      operationPlan: { operation: 'COLLECT', liquidityDelta: '0', tokenA: '0', tokenB: '0', wrapLamports: '0', decrease: false, close: false, refreshFees: true },
      expected: { liquidity: '0', amountA: '0', amountB: '0', positionLiquidityAfter: open.review.expected.liquidity },
      simulationResult: { events: [], withdrawnPrincipalA: '0', withdrawnPrincipalB: '0', collectedFeesA: '777', collectedFeesB: '33', depositedA: '0', depositedB: '0',
        rentPaidLamports: '0', rentRefundedLamports: '0', closedAccounts: [] } });
    expect(collect.simulationResult.post.position).toMatchObject({ liquidity: open.review.expected.liquidity, feeOwedA: '0', feeOwedB: '0', tickLowerIndex: -39104, tickUpperIndex: -36992 });
    const asset0 = { chainId: mainnet.chain, address: mainnet.token0.mint, decimals: 9 }, asset1 = { chainId: mainnet.chain, address: mainnet.token1.mint, decimals: 6 };
    expect(collect.simulation.outputs).toEqual([
      { nodeId: 'node-002', outputId: 'collected-fee-token0', expected: { asset: asset0, amount: '777' }, minimum: { asset: asset0, amount: '0' }, adverse: { asset: asset0, amount: '0' } },
      { nodeId: 'node-002', outputId: 'collected-fee-token1', expected: { asset: asset1, amount: '33' }, minimum: { asset: asset1, amount: '0' }, adverse: { asset: asset1, amount: '0' } }]);
    expect(functions(collect)).toEqual(['update-fees-and-rewards', 'collect-fees-v2']);
    expect(collect.policy.spendLimits).toEqual([]);
    expect(collect.plan.segments[0]!.steps[0]).toMatchObject({ stepId: 'orca-liquidity-collect', payloadHash: collect.messageHash });
    assertOrcaLiquidityReview(collect, workflow(mainnet), s.wallet.owner, 380_000_000, NOW);
    expect(verifySignedOrcaLiquidityTransaction(collect, fullySigned(s.wallet, collect, null)).signature).toBeTruthy();
    // The refresh is part of the Review: a re-committed Review whose plan drops it, or names another operation, no longer rebuilds the reviewed bytes.
    for (const operationPlan of [{ ...collect.operationPlan, refreshFees: undefined }, { ...collect.operationPlan, operation: 'DECREASE_PARTIAL' as const }]) {
      const content: Partial<OrcaLiquidityReview> = { ...collect, operationPlan: JSON.parse(JSON.stringify(operationPlan)) as OrcaLiquidityPlan }; delete content.commitment;
      expect(() => assertOrcaLiquidityReview({ ...content, commitment: solanaSwapHash(content) } as OrcaLiquidityReview, workflow(mainnet), s.wallet.owner, 380_000_000, NOW))
        .toThrow('ORCA_LIQUIDITY_TRANSACTION_CHANGED');
    }
    const usdc = usdcOf(s);
    await land(s, collect);
    expect(usdcOf(s) - usdc).toBe(33n);
    expect(s.env.state.positions.get(orcaPositionAddress(open.mint))).toMatchObject({ liquidity: BigInt(open.review.expected.liquidity), feeOwedA: 0n, feeOwedB: 0n });
    expect(s.env.state.tokens2022.get(orcaPositionTokenAccount(s.wallet.owner, open.mint))).toMatchObject({ owner: s.wallet.owner, amount: 1n });
    // Everything earned was collected: a second collect would pay nothing and is refused before any wallet is asked.
    await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: open.mint }, s.env.rpc, NOW))
      .rejects.toThrow('ORCA_POSITION_NOTHING_TO_COLLECT');
    // More trading accrues more fees, which the next collect checkpoints and pays.
    s.env.trade();
    const again = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: open.mint }, s.env.rpc, NOW);
    expect(again.simulationResult).toMatchObject({ collectedFeesA: '777', collectedFeesB: '33' });
  });
  it('collects the stored fees of a position without liquidity, without a refresh (the program refuses one)', async () => {
    const s = setup(mainnet), held = externalPosition(s, { liquidity: 0n, feeOwedA: 500n, feeOwedB: 70n });
    const collect = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: held.mint }, s.env.rpc, NOW);
    expect(names(collect)).toEqual(['set_compute_unit_limit', 'create_idempotent', 'create_idempotent', 'collect_fees_v2', 'close_account']);
    expect('refreshFees' in collect.operationPlan).toBe(false);
    expect(collect).toMatchObject({ expected: { positionLiquidityAfter: '0' },
      simulationResult: { collectedFeesA: '500', collectedFeesB: '70', withdrawnPrincipalA: '0', withdrawnPrincipalB: '0' } });
    expect(functions(collect)).toEqual(['collect-fees-v2']);
    assertOrcaLiquidityReview(collect, workflow(mainnet), s.wallet.owner, 380_000_000, NOW);
    await land(s, collect);
    expect(s.env.state.positions.get(held.position)).toMatchObject({ liquidity: 0n, feeOwedA: 0n, feeOwedB: 0n });
    await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: held.mint }, s.env.rpc, NOW))
      .rejects.toThrow('ORCA_POSITION_NOTHING_TO_COLLECT');
  });
  it('refuses an empty collect, a portion on a collect, owed rewards and a position token that is not the owner’s own Token-2022 token', async () => {
    const s = setup(mainnet), open = await landOpen(s);
    // No trading since the deposit: the checkpoint credits nothing, so the owner is never asked to pay a network fee for an empty collect.
    await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: open.mint }, s.env.rpc, NOW))
      .rejects.toThrow('ORCA_POSITION_NOTHING_TO_COLLECT');
    await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: open.mint, partBps: 5000 }, s.env.rpc, NOW))
      .rejects.toThrow('ORCA_LIQUIDITY_PART_INVALID');
    const rewarded = externalPosition(s, { liquidity: 1_000_000n, feeOwedB: 5n, rewardOwed: [0n, 9n, 0n] });
    for (const request of [{ operation: 'COLLECT' as const }, { operation: 'DECREASE_PARTIAL' as const, partBps: 5000 }, { operation: 'EXIT' as const }])
      await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { ...request, positionMint: rewarded.mint }, s.env.rpc, NOW)).rejects.toThrow('ORCA_POSITION_REWARDS_UNSUPPORTED');
    const legacy = externalPosition(s, { liquidity: 1_000_000n, feeOwedB: 5n, legacyToken: true });
    const delegated = externalPosition(s, { liquidity: 1_000_000n, feeOwedB: 5n, delegate: createMockedSolanaWallet().owner });
    for (const held of [legacy, delegated])
      await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: held.mint }, s.env.rpc, NOW)).rejects.toThrow('ORCA_POSITION_AUTHORITY_MISMATCH');
  });
  it('refuses a partial withdrawal whose checkpoint would leave a reward owed (it would block every later operation, the exit included)', async () => {
    // A slot that emitted in the past still owes an older position a reward; decrease_liquidity_v2 checkpoints it like update_fees_and_rewards.
    const s = setup(mainnet, { accrueRewards: 7n }), held = externalPosition(s, { liquidity: 1_000_000n, feeOwedB: 5n });
    await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'DECREASE_PARTIAL', positionMint: held.mint, partBps: 5000 }, s.env.rpc, NOW))
      .rejects.toThrow('ORCA_POSITION_REWARDS_UNSUPPORTED');
    await expect(simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: held.mint }, s.env.rpc, NOW))
      .rejects.toThrow('ORCA_POSITION_REWARDS_UNSUPPORTED');
    // Nothing was executed: the position is unchanged.
    expect(s.env.state.positions.get(held.position)).toMatchObject({ liquidity: 1_000_000n });
  });
  it('the MOCKED program pays only checkpointed fees: a bare collect pays the stored owed only, and update_fees_and_rewards refuses an empty position', async () => {
    const s = setup(mainnet, { accrueFees: { a: '777', b: '33' } }), open = await landOpen(s);
    const message = async (accounts: ReturnType<typeof orcaLiquidityAccounts>, plan: OrcaLiquidityPlan) => {
      const latest = await s.env.rpc('getLatestBlockhash', [{}]) as { value: { blockhash: string } };
      const bytes = serializeMessageV0(compileMessageV0(s.wallet.owner, orcaLiquidityInstructions(accounts, plan, 200_000, mainnet), latest.value.blockhash, {}));
      return s.wallet.sign(toBase64(serializeSignedTransaction([null], bytes)));
    };
    const accounts = orcaLiquidityAccounts(s.wallet.owner, open.mint, -39104, -36992, mainnet);
    const bare: OrcaLiquidityPlan = { operation: 'COLLECT', liquidityDelta: '0', tokenA: '0', tokenB: '0', wrapLamports: '0', tickLower: -39104, tickUpper: -36992, decrease: false, close: false };
    expect(summarizeOrcaLiquidityInstructions(orcaLiquidityInstructions(accounts, bare, 200_000, mainnet)).map(i => i.name)).not.toContain('update_fees_and_rewards');
    const usdc = usdcOf(s), vaultB = s.env.state.tokens.get(mainnet.pool.tokenVaultB)!.amount;
    await s.env.rpc('sendTransaction', [await message(accounts, bare), {}]);
    // The fees earned since the deposit were never checkpointed: the bare collect paid nothing, and they are still owed to the next checkpoint.
    expect([usdcOf(s), s.env.state.tokens.get(mainnet.pool.tokenVaultB)!.amount]).toEqual([usdc, vaultB]);
    expect(s.env.state.positions.get(accounts.position)).toMatchObject({ feeOwedA: 0n, feeOwedB: 0n });
    const collect = await simulateOrcaLiquidity(workflow(mainnet), s.wallet.owner, { operation: 'COLLECT', positionMint: open.mint }, s.env.rpc, NOW);
    expect(collect.simulationResult).toMatchObject({ collectedFeesA: '777', collectedFeesB: '33' });
    // The program's LiquidityZero refusal: a refresh on a position without liquidity fails the whole transaction.
    const empty = externalPosition(s, { liquidity: 0n, feeOwedB: 70n });
    const refreshed = await message(orcaLiquidityAccounts(s.wallet.owner, empty.mint, -39104, -36992, mainnet), { ...bare, refreshFees: true });
    const result = await s.env.rpc('simulateTransaction', [refreshed, {}]) as { value: { err: unknown } };
    expect(result.value.err).toEqual({ InstructionError: [3, { Custom: 6012 }] });
    // A refresh belongs to COLLECT only, and a COLLECT plan moves no liquidity: anything else is refused before an instruction is built.
    expect(() => orcaLiquidityInstructions(accounts, { ...bare, operation: 'DECREASE_PARTIAL', liquidityDelta: '1', decrease: true, refreshFees: true }, 200_000, mainnet))
      .toThrow('ORCA_LIQUIDITY_PLAN_MISMATCH');
    expect(() => orcaLiquidityInstructions(accounts, { ...bare, liquidityDelta: '1', decrease: true }, 200_000, mainnet)).toThrow('ORCA_LIQUIDITY_PLAN_MISMATCH');
  });
});

/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the MOCKED mainnet loopback as the Dashboard's position scan and the browser suite use it — a position opened
 * outside FloFi (`seedPosition`) and the owner's token accounts listed per token program (`getTokenAccountsByOwner`), encoded exactly as
 * getMultipleAccounts encodes them. Nothing here is public or mainnet evidence.
 */
describe('MOCKED mainnet loopback: positions opened outside FloFi and the owner\'s token accounts', () => {
  const list = async (s: ReturnType<typeof setup>, owner: string, programId: string) =>
    await s.env.rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64', commitment: 'confirmed' }]) as
      { context: { slot: number }; value: { pubkey: string; account: { owner: string; data: [string, string] } }[] };
  it('seeds a Token-2022 position the engine inspects as the owner\'s own (amount 1, no delegate), with its recorded fees', async () => {
    const s = setup(mainnet), owner = s.wallet.owner;
    const mint = s.env.seedPosition({ owner, liquidity: 40_000_000n, tickLower: -39104, tickUpper: -36992, feeOwedA: 1_234n, feeOwedB: 56n });
    const inspected = await inspectOrcaPosition(s.env.rpc, owner, mint, mainnet);
    expect(inspected).toMatchObject({ exists: true, position: { address: orcaPositionAddress(mint), whirlpool: mainnet.pool.address, positionMint: mint, liquidity: '40000000',
      tickLowerIndex: -39104, tickUpperIndex: -36992, feeOwedA: '1234', feeOwedB: '56' }, tokenAccount: { address: orcaPositionTokenAccount(owner, mint), owner, amount: '1', delegate: null } });
    const token2022 = await list(s, owner, mainnet.programs.token2022);
    expect(token2022.context.slot).toBe(s.env.state.slot);
    expect(token2022.value.map(item => item.pubkey)).toEqual([orcaPositionTokenAccount(owner, mint)]);
    const data = fromBase64(token2022.value[0]!.account.data[0], 1_000);
    expect(token2022.value[0]!.account.owner).toBe(mainnet.programs.token2022);
    expect(decodeSplTokenAccount(data, true)).toMatchObject({ mint, owner, amount: 1n, state: 1, extensions: [] });
    // The listing and getMultipleAccounts encode the same account identically.
    const read = await s.env.rpc('getMultipleAccounts', [[orcaPositionTokenAccount(owner, mint)], { encoding: 'base64' }]) as { value: { data: [string, string] }[] };
    expect(read.value[0]!.data).toEqual(token2022.value[0]!.account.data);
    // The classic SPL Token program lists the owner's USDC account; another owner holds nothing.
    expect((await list(s, owner, mainnet.programs.token)).value.map(item => item.pubkey)).toEqual([associatedTokenAddress(owner, mainnet.token1.mint, mainnet.programs.token,
      mainnet.programs.associatedToken)]);
    expect((await list(s, createMockedSolanaWallet().owner, mainnet.programs.token2022)).value).toEqual([]);
  });
  it('seeds a delegated position token, which the engine refuses to manage', async () => {
    const s = setup(mainnet), owner = s.wallet.owner, delegate = createMockedSolanaWallet().owner;
    const mint = s.env.seedPosition({ owner, liquidity: 1_000n, tickLower: -39104, tickUpper: -36992, delegate });
    const data = fromBase64((await list(s, owner, mainnet.programs.token2022)).value[0]!.account.data[0], 1_000);
    expect(decodeToken2022Account(data)).toMatchObject({ mint, owner, amount: 1n, delegate });
    await expect(inspectOrcaPosition(s.env.rpc, owner, mint, mainnet)).rejects.toThrow('ORCA_POSITION_AUTHORITY_MISMATCH');
  });
  it('refuses an unknown token program, a mint filter, a parsed encoding and an invalid or duplicate seed', async () => {
    const s = setup(mainnet), owner = s.wallet.owner;
    for (const params of [[owner, { programId: mainnet.programs.whirlpool }, { encoding: 'base64' }], [owner, { mint: mainnet.token1.mint }, { encoding: 'base64' }],
      [owner, { programId: mainnet.programs.token, mint: mainnet.token1.mint }], [owner, { programId: mainnet.programs.token }, { encoding: 'jsonParsed' }], [owner]])
      await expect(s.env.rpc('getTokenAccountsByOwner', params)).rejects.toMatchObject({ rpc: -32602 });
    const valid = { owner, liquidity: 1n, tickLower: -39104, tickUpper: -36992 };
    for (const invalid of [{ ...valid, tickLower: -39100 }, { ...valid, tickUpper: -39104 }, { ...valid, liquidity: -1n }, { ...valid, liquidity: 1n << 128n },
      { ...valid, feeOwedA: 1n << 64n }, { ...valid, rewardOwed: [1n, 1n, 1n, 1n] }])
      expect(() => s.env.seedPosition(invalid)).toThrow('MOCK_POSITION_INVALID');
    expect(() => s.env.seedPosition({ ...valid, owner: 'not-a-key' })).toThrow('SOLANA_ADDRESS_INVALID');
    const mint = s.env.seedPosition(valid);
    expect(() => s.env.seedPosition({ ...valid, mint })).toThrow('MOCK_POSITION_EXISTS');
    // Each seed is a distinct position at its own mint.
    expect(s.env.seedPosition(valid)).not.toBe(mint);
  });
});
