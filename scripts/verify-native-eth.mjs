// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003 — native ETH READ-ONLY verification on Base, Arbitrum One, Ethereum and Robinhood Chain. No keys, signing,
 * submission or deployment: only eth_chainId / eth_getCode / eth_call (with state overrides for a synthetic, codeless account) against the
 * networks' public RPCs. It verifies the pinned SwapRouter02 and WETH9 identities FloFi already uses (WETH9(), factory(), the dispatcher
 * selectors of multicall(uint256,bytes[]), exactInputSingle and unwrapWETH9(uint256,address); deposit()/withdraw(uint256)), quotes native-in
 * and native-out swaps with QuoterV2, and simulates the exact calldata FloFi builds (encodeNativeSwap, WETH9 deposit/withdraw).
 * Results are PUBLIC_READ_ONLY evidence, never MAINNET_EXECUTED or execution authority. Build the workspace packages first.
 * Usage: node scripts/verify-native-eth.mjs output.json
 */
import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { keccak_256 } from '../packages/reference-compiler/node_modules/@noble/hashes/sha3.js';
import { encodeNativeSwap, encodeWethDeposit, encodeWethWithdraw, toHex, ROUTER_ADDRESS_THIS } from '../packages/reference-compiler/dist/index.js';
import { UNISWAP_V3_BASE, UNISWAP_V3_ARBITRUM, UNISWAP_V3_ETHEREUM, UNISWAP_V3_ROBINHOOD } from '../packages/action-registry/dist/index.js';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw Error('Usage: node scripts/verify-native-eth.mjs output.json');
const NETWORKS = [
  { key: 'base', chainId: 8453, rpc: 'https://mainnet.base.org', uni: UNISWAP_V3_BASE, token: UNISWAP_V3_BASE.usdc, symbol: 'USDC', decimals: 6 },
  { key: 'arbitrum-one', chainId: 42161, rpc: 'https://arb1.arbitrum.io/rpc', uni: UNISWAP_V3_ARBITRUM, token: UNISWAP_V3_ARBITRUM.usdc, symbol: 'USDC', decimals: 6 },
  { key: 'ethereum', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', uni: UNISWAP_V3_ETHEREUM, token: UNISWAP_V3_ETHEREUM.usdc, symbol: 'USDC', decimals: 6 },
  { key: 'robinhood', chainId: 4663, rpc: UNISWAP_V3_ROBINHOOD.rpc, uni: UNISWAP_V3_ROBINHOOD, token: UNISWAP_V3_ROBINHOOD.usdg, symbol: 'USDG', decimals: 6 },
];
/** A synthetic account with no code: only state overrides give it a balance; nothing it "does" exists outside these eth_calls. */
const SUBJECT = '0x00000000000000000000000000000000f10f1003';
const READ_ONLY = new Set(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getBlockByNumber']);
const hex = bytes => '0x' + Buffer.from(bytes).toString('hex');
const keccak = data => hex(keccak_256(Buffer.from(data.slice(2), 'hex')));
const word = value => BigInt(value).toString(16).padStart(64, '0');
const addr = value => value.slice(2).toLowerCase().padStart(64, '0');
const selector = signature => hex(keccak_256(new globalThis.TextEncoder().encode(signature))).slice(0, 10);

async function verify(network) {
  let id = 0;
  const rpc = async (method, params) => {
    if (!READ_ONLY.has(method)) throw Error('READ_ONLY');
    const response = await globalThis.fetch(network.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: globalThis.AbortSignal.timeout(30_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = await response.json();
    if (body.error) throw Object.assign(Error(body.error.message ?? 'RPC_ERROR'), { rpc: body.error });
    return body.result;
  };
  const result = { network: network.key, chainId: network.chainId, evidence: 'PUBLIC_READ_ONLY', rpc: new URL(network.rpc).host, router: network.uni.router,
    weth: network.uni.weth, token: { symbol: network.symbol, address: network.token }, checks: {}, simulations: {} };
  if (BigInt(await rpc('eth_chainId', [])) !== BigInt(network.chainId)) throw Error('WRONG_CHAIN');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  result.block = { number: Number(BigInt(block.number)), hash: block.hash, timestamp: Number(BigInt(block.timestamp)) };
  const at = block.number, call = (to, data, extra = {}, overrides) => rpc('eth_call', overrides ? [{ to, data, ...extra }, at, overrides] : [{ to, data, ...extra }, at]);
  const addressOf = value => '0x' + value.slice(-40);
  const routerCode = (await rpc('eth_getCode', [network.uni.router, at])).toLowerCase(), wethCode = (await rpc('eth_getCode', [network.uni.weth, at])).toLowerCase();
  const dispatches = (code, signature) => code.includes('63' + selector(signature).slice(2));
  result.checks = {
    routerWeth9: addressOf(await call(network.uni.router, selector('WETH9()'))) === network.uni.weth,
    routerFactory: addressOf(await call(network.uni.router, selector('factory()'))) === network.uni.factory,
    routerMulticallDeadline: dispatches(routerCode, 'multicall(uint256,bytes[])'),
    routerExactInputSingle: dispatches(routerCode, 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'),
    routerUnwrapWeth9: dispatches(routerCode, 'unwrapWETH9(uint256,address)'),
    wethDecimals18: BigInt(await call(network.uni.weth, selector('decimals()'))) === 18n,
    // A proxied WETH (e.g. Arbitrum's aeWETH) dispatches in its implementation; the simulations below prove deposit/withdraw either way.
    wethDispatchesDepositWithdraw: dispatches(wethCode, 'deposit()') && dispatches(wethCode, 'withdraw(uint256)'),
  };
  // Quote both directions on every standard fee tier with QuoterV2 (read-only) and keep the best tier.
  const quoter = selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))');
  const best = async (tokenIn, tokenOut, amount) => {
    let chosen = null;
    for (const fee of [100, 500, 3000, 10000]) {
      try { const out = BigInt((await call(network.uni.quoter, quoter + addr(tokenIn) + addr(tokenOut) + word(amount) + word(fee) + word(0))).slice(0, 66));
        if (out > 0n && (!chosen || out > chosen.out)) chosen = { fee, out }; } catch { /* no usable pool on this tier */ }
    }
    return chosen;
  };
  const ethIn = 10n ** 15n, tokenIn = 5n * 10n ** BigInt(network.decimals), deadline = BigInt(result.block.timestamp + 600);
  const funded = { [SUBJECT]: { balance: '0x' + (10n ** 18n).toString(16) } };
  // Find the token's balance and allowance mapping slots by override probing (no assumption about its storage layout).
  const probe = async (token, slotOf, read, value) => {
    for (let slot = 0; slot < 64; slot++) {
      const stateDiff = { [slotOf(slot)]: '0x' + word(value) };
      try { if (BigInt(await call(token, read, {}, { [token]: { stateDiff } })) === value) return stateDiff; } catch { /* keep probing */ }
    }
    return null;
  };
  const balanceSlot = (owner, slot) => keccak('0x' + addr(owner) + word(slot));
  const allowanceSlot = (owner, spender, slot) => keccak('0x' + addr(spender) + balanceSlot(owner, slot).slice(2));
  // A: native ETH in → token, recipient = the subject; value = amountIn exactly.
  const inQuote = await best(network.uni.weth, network.token, ethIn);
  if (inQuote) {
    const min = inQuote.out * 99n / 100n;
    const data = toHex(encodeNativeSwap({ native: 'INPUT', weth: network.uni.weth, tokenIn: network.uni.weth, tokenOut: network.token, fee: inQuote.fee, recipient: SUBJECT,
      amountIn: ethIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n, deadline }));
    try { const out = await call(network.uni.router, data, { from: SUBJECT, value: '0x' + ethIn.toString(16) }, funded);
      result.simulations.nativeIn = { ok: true, amountIn: ethIn.toString(), fee: inQuote.fee, quoted: inQuote.out.toString(), minimum: min.toString(), returned: BigInt('0x' + out.slice(2 + 64 * 4, 2 + 64 * 5)).toString() }; }
    catch (cause) { result.simulations.nativeIn = { ok: false, error: cause.message }; }
  } else result.simulations.nativeIn = { ok: false, error: 'NO_POOL' };
  // B: token → native ETH out: the swap pays the router (ADDRESS_THIS), unwrapWETH9 pays at least the minimum to the subject.
  const outQuote = await best(network.token, network.uni.weth, tokenIn);
  const balances = await probe(network.token, slot => balanceSlot(SUBJECT, slot), selector('balanceOf(address)') + addr(SUBJECT), tokenIn);
  const allowances = await probe(network.token, slot => allowanceSlot(SUBJECT, network.uni.router, slot), selector('allowance(address,address)') + addr(SUBJECT) + addr(network.uni.router), tokenIn);
  if (outQuote && balances && allowances) {
    const min = outQuote.out * 99n / 100n;
    const data = toHex(encodeNativeSwap({ native: 'OUTPUT', weth: network.uni.weth, tokenIn: network.token, tokenOut: network.uni.weth, fee: outQuote.fee, recipient: SUBJECT,
      amountIn: tokenIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n, deadline }));
    try { await call(network.uni.router, data, { from: SUBJECT }, { ...funded, [network.token]: { stateDiff: { ...balances, ...allowances } } });
      result.simulations.nativeOut = { ok: true, amountIn: tokenIn.toString(), fee: outQuote.fee, quoted: outQuote.out.toString(), minimum: min.toString(), recipientIntermediate: ROUTER_ADDRESS_THIS }; }
    catch (cause) { result.simulations.nativeOut = { ok: false, error: cause.message }; }
  } else result.simulations.nativeOut = { ok: false, error: !outQuote ? 'NO_POOL' : 'TOKEN_STORAGE_NOT_FOUND' };
  // C/D: WETH9 deposit (wrap) and withdraw (unwrap) of 0.01 ETH by the subject.
  const wrap = 10n ** 16n;
  try { await call(network.uni.weth, toHex(encodeWethDeposit()), { from: SUBJECT, value: '0x' + wrap.toString(16) }, funded); result.simulations.wrap = { ok: true, amount: wrap.toString() }; }
  catch (cause) { result.simulations.wrap = { ok: false, error: cause.message }; }
  const wethBalance = await probe(network.uni.weth, slot => balanceSlot(SUBJECT, slot), selector('balanceOf(address)') + addr(SUBJECT), wrap);
  if (wethBalance) {
    try { await call(network.uni.weth, toHex(encodeWethWithdraw(wrap)), { from: SUBJECT }, { ...funded, [network.uni.weth]: { stateDiff: wethBalance } }); result.simulations.unwrap = { ok: true, amount: wrap.toString() }; }
    catch (cause) { result.simulations.unwrap = { ok: false, error: cause.message }; }
  } else result.simulations.unwrap = { ok: false, error: 'WETH_STORAGE_NOT_FOUND' };
  return result;
}

const results = [];
for (const network of NETWORKS) {
  try { results.push(await verify(network)); } catch (cause) { results.push({ network: network.key, evidence: 'PUBLIC_READ_ONLY', error: cause.message }); }
}
const output = { build: 'BUILD-FLOFI-BRIDGE-LIVE-FIX-003', kind: 'native-eth-read-only-verification', verifiedAt: new Date().toISOString(), subject: SUBJECT,
  note: 'eth_call simulations with state overrides on a synthetic codeless account; nothing was signed or sent.', results };
await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
for (const r of results) console.log(r.network, r.error ?? JSON.stringify({ checks: r.checks, simulations: Object.fromEntries(Object.entries(r.simulations).map(([k, v]) => [k, v.ok ? 'OK' : v.error])) }));
