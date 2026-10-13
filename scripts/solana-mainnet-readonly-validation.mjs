// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-SOLANA-MAINNET-001 public Solana mainnet-beta READ-ONLY validation. Evidence class: PUBLIC_READ_ONLY.
 * Reads the cluster genesis, the Jupiter v6 and Orca Whirlpools program deployments, the SOL/USDC/USDT mints, and the verified Orca
 * SOL/USDC 0.30% Whirlpool (config, mints, vaults, fee rate, tick spacing, reward emission rates, current price and the tick arrays of the
 * aligned ±10% range). When a public mainnet address holding SOL and USDC is given, it uses that address only as a hypothetical taker / fee
 * payer to (1) fetch a real Jupiter Swap V2 `/build` route for 1 USDC → SOL, compile the exact Gryloo message and simulate it, and (2) build
 * the exact Gryloo Orca OPEN message for a 0.01 SOL / 1 USDC ±10% position and simulate it, then one composite message that also removes all
 * liquidity, collects fees and closes the position. Signature verification is off in every simulation.
 * It holds no key, signs nothing and can never broadcast: the transport refuses every method outside the read-only allowlist, including
 * sendTransaction. The position-mint address is random public-key bytes with no secret.
 *
 *   pnpm build && node scripts/solana-mainnet-readonly-validation.mjs [publicMainnetAddress] [output.json]
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { JUPITER_SOLANA_MAINNET as jupiter, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as profile, SOLANA_MAINNET_TOKENS as T } from '../packages/action-registry/dist/index.js';
import { assertJupiterReview, assertOrcaLiquidityReview, base58Encode, compileMessageV0, fromBase64, orcaLiquidityAccounts, orcaLiquidityInstructions, orcaLiquidityTickArray,
  orcaPoolEmittingRewardMints, orcaPoolRewardMints, parseOrcaLiquidityEvents, readOrcaLiquidityPool, readOrcaLiquidityPrice, serializeMessageV0, serializeSignedTransaction,
  setComputeUnitLimit, simulateJupiterSwap, simulateOrcaLiquidity, toBase64 } from '../packages/reference-compiler/dist/index.js';
import { createConcentratedLiquidityNode, createExactInputSwapNode } from '../packages/workflow-contracts/dist/index.js';

const READ_ONLY = new Set(['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getBlockHeight', 'simulateTransaction', 'getSlot']);
const endpoint = process.env.GRYLOO_SOLANA_RPC_URL ?? profile.rpc;
if (new URL(endpoint).protocol !== 'https:') throw new Error('HTTPS RPC required');
async function rpc(method, params) {
  if (!READ_ONLY.has(method)) throw new Error('READ_ONLY_VALIDATION_DENIES_' + method);
  for (let attempt = 0; ; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 400 + attempt * 1500));
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (response.status === 429 && attempt < 4) continue;
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
    return body.result;
  }
}
/** Jupiter Swap V2 `/build` (a read: it returns instructions, never executes). `JUPITER_API_KEY` is sent only as a header when present. */
async function http(query) {
  const response = await fetch(jupiter.api + jupiter.endpoint + '?' + new URLSearchParams(query), { signal: AbortSignal.timeout(20_000),
    headers: process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {} });
  const text = await response.text();
  if (!response.ok) throw new Error(`JUPITER_${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
const check = (ok, label) => { if (!ok) throw new Error('VALIDATION_FAILED: ' + label); return label; };
const report = { evidence: 'PUBLIC_READ_ONLY', broadcast: false, signed: false, endpoint: new URL(endpoint).origin, jupiter: jupiter.api + jupiter.endpoint,
  checkedAt: new Date().toISOString(), checks: [] };

const genesis = await rpc('getGenesisHash', []);
report.checks.push(check(genesis === profile.genesisHash && genesis === jupiter.genesisHash, `cluster genesis ${genesis} = Solana mainnet-beta`));
report.programs = {};
for (const [name, id] of [['jupiter', jupiter.programs.jupiter], ['whirlpool', profile.programs.whirlpool]]) {
  const account = (await rpc('getAccountInfo', [id, { encoding: 'jsonParsed' }])).value;
  check(account?.executable === true && account.owner === 'BPFLoaderUpgradeab1e11111111111111111111111', `${name} program ${id} is executable (upgradeable loader)`);
  const data = (await rpc('getAccountInfo', [account.data.parsed.info.programData, { encoding: 'base64', dataSlice: { offset: 0, length: 13 } }])).value;
  const header = fromBase64(data.data[0]);
  report.programs[name] = { id, programData: account.data.parsed.info.programData, lastDeploySlot: Number(new DataView(header.buffer, header.byteOffset).getBigUint64(4, true)) };
}
report.checks.push('Jupiter v6 and Orca Whirlpools programs are deployed and executable on mainnet-beta');
report.mints = {};
for (const token of Object.values(T)) {
  const mint = (await rpc('getAccountInfo', [token.mint, { encoding: 'jsonParsed' }])).value;
  check(mint?.owner === jupiter.programs.token && mint.data.parsed.type === 'mint' && mint.data.parsed.info.decimals === token.decimals, `${token.symbol} mint ${token.mint}: SPL Token, ${token.decimals} decimals`);
  report.mints[token.symbol] = { mint: token.mint, decimals: token.decimals, program: mint.owner };
}
report.checks.push('SOL (wrapped), USDC and USDT mints are classic SPL Token mints with the profile decimals');

const pool = await readOrcaLiquidityPool(rpc, profile);
const raw = (await rpc('getAccountInfo', [pool.address, { encoding: 'base64' }])).value;
const poolData = fromBase64(raw.data[0], 4096);
report.pool = { address: pool.address, config: pool.whirlpoolsConfig, tokenMintA: pool.tokenMintA, tokenMintB: pool.tokenMintB, tokenVaultA: pool.tokenVaultA,
  tokenVaultB: pool.tokenVaultB, tickSpacing: pool.tickSpacing, feeRate: pool.feeRate, liquidity: pool.liquidity, sqrtPrice: pool.sqrtPrice, tickCurrentIndex: pool.tickCurrentIndex,
  slot: pool.slot, rewardMints: orcaPoolRewardMints(poolData), emittingRewardMints: orcaPoolEmittingRewardMints(poolData) };
check(report.pool.emittingRewardMints.length === 0, 'no initialized reward slot emits');
report.checks.push(`pool ${pool.address} matches config, SOL/USDC mints, vaults, tick spacing ${pool.tickSpacing}, fee ${pool.feeRate}; ${report.pool.rewardMints.length} initialized reward slot(s), none emitting`);
const price = await readOrcaLiquidityPrice(rpc, profile);
report.range = price;
report.checks.push(`±10% band ${price.lowerPrice}–${price.upperPrice} USDC/SOL aligned outward to ticks ${price.tickLower}..${price.tickUpper}`);
const arrays = [orcaLiquidityTickArray(pool.address, price.tickLower, pool.tickSpacing), orcaLiquidityTickArray(pool.address, price.tickUpper, pool.tickSpacing),
  orcaLiquidityTickArray(pool.address, -443584, pool.tickSpacing), orcaLiquidityTickArray(pool.address, 443584, pool.tickSpacing)];
const arrayAccounts = (await rpc('getMultipleAccounts', [arrays, { encoding: 'base64', dataSlice: { offset: 0, length: 8 } }])).value;
check(arrayAccounts.every(a => a?.owner === profile.programs.whirlpool && Buffer.from(a.data[0], 'base64').toString('hex') === profile.tickArrayDiscriminator),
  'range and full-range tick arrays are initialized fixed-size TickArray accounts owned by Whirlpools');
report.tickArrays = arrays;
report.checks.push('±10% and full-range tick arrays initialized (fixed-size)');

const owner = process.argv[2];
if (owner) {
  // 1. Jupiter: 1 USDC → SOL, 50 bps, the exact Gryloo message simulated with the hypothetical taker.
  const c = t => ({ chainId: jupiter.chain, address: t.mint, decimals: t.decimals });
  const swapWorkflow = { schemaVersion: '1.0.0', workflowId: 'solana-mainnet-readonly', revision: 1, resourceEdges: [], nodes: [createExactInputSwapNode('node-002', {
    chain: jupiter.chain, input: c(T.USDC), output: c(T.SOL), amount: '1000000', slippageBps: 50, protocols: ['jupiter'], maximumAmount: T.USDC.maximumAmount })] };
  try {
    const swap = await simulateJupiterSwap(swapWorkflow, owner, http, rpc);
    assertJupiterReview(swap, swapWorkflow, owner, await rpc('getBlockHeight', [{ commitment: 'confirmed' }]));
    report.jupiter = { owner, request: '1 USDC → SOL, 50 bps', route: swap.quote.routePlan?.map(step => step.label ?? step.ammKey ?? null) ?? null, quotedOut: swap.quote.outAmount,
      minimumOut: swap.quote.otherAmountThreshold, simulated: { inputSpent: swap.simulationResult?.inputSpent ?? null, outputReceived: swap.simulationResult?.outputReceived ?? null },
      feeLamports: swap.estimatedFeeLamports, messageHash: swap.messageHash, instructions: swap.instructionSummary?.map(i => i.name) ?? null };
    report.checks.push(`Jupiter /build route for 1 USDC → SOL compiled into the exact Gryloo message and simulated; Review guard PASS`);
  } catch (cause) { report.jupiter = { owner, error: String(cause?.message ?? cause).slice(0, 300) }; report.checks.push(`Jupiter simulation not completed: ${report.jupiter.error}`); }

  // 2. Orca: OPEN 0.01 SOL / 1 USDC, ±10%, 100 bps; then the full lifecycle in one composite read-only message.
  const t = token => ({ chainId: profile.chain, address: token.mint, decimals: token.decimals });
  const fields = { chain: profile.chain, token0: t(profile.token0), token1: t(profile.token1), amount0Max: '10000000', amount1Max: '1000000', amount0Min: '0', amount1Min: '0',
    tickLower: price.tickLower, tickUpper: price.tickUpper, feeTier: profile.feeTier, slippageBps: 100, protocols: [profile.protocol], recipient: null,
    positionAsset: { chainId: profile.chain, address: profile.programs.whirlpool, decimals: 0 } };
  const workflow = { schemaVersion: '1.0.0', workflowId: 'solana-mainnet-readonly', revision: 1, resourceEdges: [], nodes: [createConcentratedLiquidityNode('node-002', fields)] };
  const positionMint = base58Encode(randomBytes(32));
  try {
    const review = await simulateOrcaLiquidity(workflow, owner, { operation: 'OPEN', positionMint }, rpc);
    assertOrcaLiquidityReview(review, workflow, owner, await rpc('getBlockHeight', [{ commitment: 'confirmed' }]));
    const s = review.simulationResult;
    report.orcaOpen = { owner, profile: { maxSol: '0.01', maxUsdc: '1', rangeBps: 1000, slippageBps: 100 }, rangeState: review.range.state,
      alignedRange: { tickLower: review.range.tickLower, tickUpper: review.range.tickUpper, lowerPrice: review.range.lowerPrice, upperPrice: review.range.upperPrice },
      expected: review.expected, tokenBounds: { maxA: review.operationPlan.tokenA, maxB: review.operationPlan.tokenB }, simulatedDeposit: { a: s.depositedA, b: s.depositedB },
      rentPaidLamports: s.rentPaidLamports, feeLamports: review.estimatedFeeLamports, unitsConsumed: s.unitsConsumed, computeUnitLimit: review.computeUnitLimit,
      messageBytes: fromBase64(review.message).length, signers: review.signers.length, programs: review.programs, instructions: review.instructionSummary.map(i => i.name),
      messageHash: review.messageHash };
    check(s.depositedA === review.expected.amountA && s.depositedB === review.expected.amountB, 'deployed program deposit equals Gryloo integer math');
    report.checks.push(`exact Orca OPEN message simulated: deposit ${s.depositedA} lamports + ${s.depositedB} USDC units, liquidity ${review.expected.liquidity}; Review guard PASS`);
    const accounts = orcaLiquidityAccounts(owner, positionMint, review.range.tickLower, review.range.tickUpper, profile);
    const open = orcaLiquidityInstructions(accounts, review.operationPlan, 600_000, profile);
    const exit = orcaLiquidityInstructions(accounts, { ...review.operationPlan, operation: 'EXIT', tokenA: '0', tokenB: '0', wrapLamports: '0', decrease: true, close: true }, 600_000, profile);
    const instructions = [setComputeUnitLimit(600_000), ...open.slice(1, -1), ...exit.slice(2)];
    const latest = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const message = serializeMessageV0(compileMessageV0(owner, instructions, latest.blockhash, {}));
    const sim = (await rpc('simulateTransaction', [toBase64(serializeSignedTransaction([null, null], message)), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false,
      commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [owner, accounts.position, accounts.positionMint, accounts.positionTokenAccount] } }])).value;
    check(sim.err === null, 'composite lifecycle simulation succeeded');
    const events = parseOrcaLiquidityEvents(sim.logs);
    check(events.map(e => e.kind).join() === 'PositionOpened,LiquidityIncreased,LiquidityDecreased' && events.every(e => e.position === accounts.position),
      'PositionOpened, LiquidityIncreased and LiquidityDecreased events for the new position');
    check(sim.accounts.slice(1).every(a => a === null || a.lamports === 0), 'position, position mint and position token account are closed');
    report.orcaLifecycle = { instructions: ['open_position_with_token_extensions', 'increase_liquidity_v2', 'decrease_liquidity_v2', 'collect_fees_v2', 'close_position_with_token_extensions'],
      events: events.map(e => ({ kind: e.kind, liquidity: e.liquidity, tokenA: e.tokenA, tokenB: e.tokenB })), unitsConsumed: sim.unitsConsumed, messageBytes: message.length };
    report.checks.push('all five Orca lifecycle instructions accepted by the deployed mainnet program in one read-only simulation; the position closes');
  } catch (cause) { report.orcaOpen = { owner, error: String(cause?.message ?? cause).slice(0, 300), cause: JSON.stringify(cause?.cause ?? null).slice(0, 600) };
    report.checks.push(`Orca simulation not completed: ${report.orcaOpen.error}`); }
}
const out = process.argv[3];
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
