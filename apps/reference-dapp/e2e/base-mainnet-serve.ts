// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001 loopback harness (127.0.0.1:8562), MOCKED and loopback only.
 *
 * - `/token-list`: FloFi's own Base token-list fixture (packages/action-registry/test/fixtures: token-list format, Base assets read from
 *   chain; the GPL-3.0 Uniswap list itself is never committed) at the path the MOCKED mode reads, so the Canvas search runs over a validated
 *   Base catalog with no public network. `POST /__harness/token-list` switches it between `ok`, `unavailable` (HTTP 503) and `slow`
 *   (answers after 1.5 s).
 * - `/rpc`: the MOCKED in-memory Base mainnet chain (8453) of the unit tests (src/server/robinhood-mainnet.test-harness.ts, Base mode: OP
 *   Stack L1 fee, Uniswap/USDC code) at the URL the MOCKED mode reads and sends to (`BASE_MAINNET_HARNESS.rpc`). Its one write method,
 *   `eth_sendRawTransaction`, takes only a canonical owner-signed EIP-1559 transaction for chain 8453 at the sender's next nonce that the
 *   sender can pay for, includes it in a new block under its real hash, and never forwards anything: there is no public transport here.
 *   The chain exists only once a test starts it: `POST /__harness/chain` `reset` (optionally funding one address with MOCKED ETH); until
 *   then `/rpc` answers 503 and every read fails closed, so a suite that never starts it (Base authoring) sees what it saw before there was one.
 *   `mine` adds empty blocks (confirmations) and `sent` reports how many raw transactions it accepted. The auth-wallets suite uses it for
 *   FloFi Wallet's MOCKED Base mainnet signing journey.
 * - Aave V3 (base-mainnet-aave.ts): once the chain is started, `/rpc` also answers the MOCKED Aave V3 Base market's reads (every registered
 *   reserve; Multicall3 deployed) for the Canvas lending cards' live reserve catalog. `POST /__harness/aave` patches that market and its MOCKED
 *   account (the patch format is documented there) and `GET /__harness/aave` reports it; a chain `reset` restores its defaults.
 *
 * - Uniswap v3 positions (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001): `POST /__harness/uniswap` `reset` replaces the chain behind `/rpc` with the
 *   MOCKED Base Uniswap v3 chain of the liquidity suites (e2e/uniswap-liquidity-harness.ts: the catalog USDC/WETH 0.05% pool, its
 *   NonfungiblePositionManager, `eth_simulateV1`) with positions seeded for one owner as if opened in another interface (and fees accrued since),
 *   so the Dashboard discovers them and the in-process MOCKED liquidity runtime manages them. Its one transaction path is `send`: the
 *   scripted owner wallet (the owner's own browser wallet in a real deployment); `/rpc` never accepts a transaction. `sends`, `advance`,
 *   `position` and `balances` report or move that chain. A chain `reset` (above) or a new `reset` here leaves this mode.
 *
 * `node e2e/base-mainnet-serve.ts` serves it on 127.0.0.1:8562 (playwright.config.ts); a test may run `createBaseMainnetHarness()` in-process.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { createRobinhoodMockChain } from '../src/server/robinhood-mainnet.test-harness.ts';
import { baseCatalog } from '../src/server/base-mainnet.test-harness.ts';
import { createBaseAaveMarket } from './base-mainnet-aave.ts';
import { catalogPoolOn, UNISWAP_V3_BASE } from '@defi-workflow-engine/action-registry';
import { createUniswapLiquidityChain, type UniswapLiquidityChain } from './uniswap-liquidity-harness.ts';

const LIST = readFileSync(new URL('../../../packages/action-registry/test/fixtures/base-token-list-fixture.json', import.meta.url), 'utf8');
const BASE_CHAIN_ID = 8453n, ADDRESS = /^0x[0-9a-f]{40}$/;
const hex = (value: bigint) => `0x${value.toString(16)}`;
const newChain = () => createRobinhoodMockChain(baseCatalog(), { now: Date.now, network: 'base' });
const rpcError = (message: string) => Object.assign(new Error(message), { rpc: -32000 });

/** A node's acceptance rules for one raw transaction, then inclusion in a new block under the transaction's own hash. */
async function sendRawTransaction(chain: ReturnType<typeof newChain>, raw: unknown, counter: { accepted: number }): Promise<string> {
  let decoded: ReturnType<typeof erc7710.decodeSignedEip1559>;
  try { decoded = erc7710.decodeSignedEip1559(String(raw)); } catch { throw rpcError('invalid transaction'); }
  const { tx } = decoded, from = decoded.from.toLowerCase(), hash = decoded.hash.toLowerCase();
  if (tx.chainId !== BASE_CHAIN_ID) throw rpcError('invalid chain id');
  if (chain.state.transactions.has(hash)) return hash; // already known: never a second inclusion
  const nonce = BigInt(String(await chain.rpc('eth_getTransactionCount', [from, 'latest'])));
  if (tx.nonce !== nonce) throw rpcError(tx.nonce < nonce ? 'nonce too low' : 'nonce too high');
  const balance = BigInt(String(await chain.rpc('eth_getBalance', [from, 'latest'])));
  if (tx.value + tx.gasLimit * tx.maxFeePerGas > balance) throw rpcError('insufficient funds for gas * price + value');
  const mocked = chain.apply({ from, to: tx.to.toLowerCase(), data: tx.data.toLowerCase(), value: hex(tx.value), gas: hex(tx.gasLimit), maxFeePerGas: hex(tx.maxFeePerGas) });
  // The in-memory chain names its records by a synthetic id; a node names them by the signed transaction's hash.
  const included = chain.state.transactions.get(mocked)!, receipt = chain.state.receipts.get(mocked)!;
  chain.state.transactions.delete(mocked); chain.state.receipts.delete(mocked);
  chain.state.transactions.set(hash, { ...included, hash, maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas) });
  chain.state.receipts.set(hash, { ...receipt, transactionHash: hash });
  counter.accepted += 1;
  return hash;
}
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the Base catalog pool the position suite manages — USDC/WETH 0.05% (token0 WETH, token1 USDC) — at a
 * MOCKED price of about 3,000 USDC per WETH (tick −196,250).
 */
export const BASE_POSITION_POOL = catalogPoolOn('eip155:8453', { symbol: 'USDC', address: UNISWAP_V3_BASE.usdc, decimals: 6 },
  { symbol: 'WETH', address: UNISWAP_V3_BASE.weth, decimals: 18 }, 500);
export const BASE_POSITION_TICK = -196_250;
const UINT = /^(0|[1-9][0-9]{0,37})$/;
export type SeededPosition = { tickLower: number; tickUpper: number; liquidity: string; owed0?: string; owed1?: string; fees0?: string; fees1?: string };
const tickOf = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) % BASE_POSITION_POOL.tickSpacing !== 0 || Math.abs(value as number) > 887_270) throw new Error('MOCK_CONTROL_DENIED');
  return value as number;
};
const units = (value: unknown, fallback = '0') => { const text = value ?? fallback; if (typeof text !== 'string' || !UINT.test(text)) throw new Error('MOCK_CONTROL_DENIED'); return BigInt(text); };
/**
 * The MOCKED Base Uniswap v3 chain with `positions` opened for `owner` outside FloFi (recorded owed tokens, then fees accrued that only a
 * collect or decrease pokes into the record). Every input is validated (loopback test control only).
 */
export function createBasePositionChain(owner: unknown, positions: unknown): { chain: UniswapLiquidityChain; tokenIds: string[] } {
  if (typeof owner !== 'string' || !ADDRESS.test(owner) || !Array.isArray(positions) || positions.length > 4) throw new Error('MOCK_CONTROL_DENIED');
  // The chain's `usdc`/`weth` options fund token0/token1: here 5 WETH and 10,000 USDC, and 0.1 ETH for network fees.
  const chain = createUniswapLiquidityChain({ owner, profile: BASE_POSITION_POOL, tick: BASE_POSITION_TICK, catalogTokenCode: true,
    usdc: 5n * 10n ** 18n, weth: 10_000_000_000n, eth: 10n ** 17n });
  const tokenIds = (positions as SeededPosition[]).map(position => {
    if (!position || typeof position !== 'object') throw new Error('MOCK_CONTROL_DENIED');
    const tickLower = tickOf(position.tickLower), tickUpper = tickOf(position.tickUpper), liquidity = units(position.liquidity);
    if (tickLower >= tickUpper || liquidity === 0n || liquidity >= 1n << 128n) throw new Error('MOCK_CONTROL_DENIED');
    const id = chain.seedPosition({ tickLower, tickUpper, liquidity, owed0: units(position.owed0), owed1: units(position.owed1) });
    const fees0 = units(position.fees0), fees1 = units(position.fees1);
    if (fees0 > 0n || fees1 > 0n) chain.accrueFees(id, fees0, fees1);
    return id;
  });
  return { chain, tokenIds };
}
/** One control of the Uniswap position chain (loopback test control only). */
function uniswapControl(state: { uniswap: UniswapLiquidityChain | null }, control: Record<string, unknown>): unknown {
  if (control.action === 'reset') {
    const { chain, tokenIds } = createBasePositionChain(control.owner, control.positions);
    state.uniswap = chain;
    return { tokenIds, pool: BASE_POSITION_POOL.pool, positionManager: BASE_POSITION_POOL.positionManager, token0: BASE_POSITION_POOL.token0.address,
      token1: BASE_POSITION_POOL.token1.address };
  }
  const chain = state.uniswap;
  if (!chain) throw new Error('MOCK_CHAIN_NOT_STARTED');
  if (control.action === 'send') return chain.wallet.send(control.tx as Parameters<UniswapLiquidityChain['wallet']['send']>[0]);
  if (control.action === 'sends') return chain.counters.sends;
  if (control.action === 'advance') {
    if (!Number.isSafeInteger(control.seconds) || (control.seconds as number) < 1 || (control.seconds as number) > 3_600) throw new Error('MOCK_CONTROL_DENIED');
    chain.advance(control.seconds as number);
    return true;
  }
  if (control.action === 'position') {
    if (typeof control.tokenId !== 'string' || !UINT.test(control.tokenId)) throw new Error('MOCK_CONTROL_DENIED');
    const p = chain.snapshot.positions[control.tokenId], owner = chain.snapshot.owners[control.tokenId];
    return p ? { owner: owner ?? null, liquidity: p.liquidity.toString(), owed0: p.owed0.toString(), owed1: p.owed1.toString(),
      pending0: p.pending0.toString(), pending1: p.pending1.toString() } : null;
  }
  if (control.action === 'balances') {
    const owner = chain.owner, b = chain.snapshot.balances;
    return { token0: (b[BASE_POSITION_POOL.token0.address]?.[owner] ?? 0n).toString(), token1: (b[BASE_POSITION_POOL.token1.address]?.[owner] ?? 0n).toString() };
  }
  throw new Error('MOCK_CONTROL_DENIED');
}
async function read(request: AsyncIterable<unknown>): Promise<string> {
  let body = '';
  for await (const chunk of request) { body += String(chunk); if (body.length > 1_048_576) throw new Error('MOCK_INPUT_TOO_LARGE'); }
  return body;
}

/** The harness server (not yet listening): its own token-list mode, chain and Aave market. */
export function createBaseMainnetHarness(): Server {
  let mode: 'ok' | 'unavailable' | 'slow' = 'ok', reads = 0;
  let chain: ReturnType<typeof newChain> | null = null;
  const counter = { accepted: 0 }, aave = createBaseAaveMarket(), positions: { uniswap: UniswapLiquidityChain | null } = { uniswap: null };
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:8562');
    const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.method === 'POST' && url.pathname === '/__harness/token-list') {
      const next = (JSON.parse(await read(request) || '{}') as { mode?: unknown }).mode;
      if (next !== 'ok' && next !== 'unavailable' && next !== 'slow') { response.writeHead(400).end(); return; }
      mode = next; reads = 0;
      json(200, { mode });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/__harness/token-list') { json(200, { mode, reads }); return; }
    if (request.method === 'GET' && url.pathname === '/token-list') {
      reads += 1;
      if (mode === 'unavailable') { response.writeHead(503, { 'content-type': 'text/plain' }).end('MOCKED token list unavailable'); return; }
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1_500));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(LIST) }).end(LIST);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__harness/chain') {
      try {
        const control = JSON.parse(await read(request) || '{}') as { action?: unknown; owner?: unknown; wei?: unknown; blocks?: unknown };
        if (control.action === 'reset') {
          chain = newChain(); counter.accepted = 0; aave.reset(); positions.uniswap = null;
          if (control.owner !== undefined) {
            if (typeof control.owner !== 'string' || !ADDRESS.test(control.owner) || typeof control.wei !== 'string' || !/^[1-9][0-9]{0,30}$/.test(control.wei)) throw new Error('MOCK_CONTROL_DENIED');
            chain.fundNative(control.owner, BigInt(control.wei));
          }
          json(200, { result: true });
        } else if (control.action === 'mine' && chain && Number.isSafeInteger(control.blocks) && (control.blocks as number) > 0 && (control.blocks as number) <= 64) {
          chain.mine(control.blocks as number);
          json(200, { result: chain.state.head });
        } else if (control.action === 'sent') json(200, { result: counter.accepted });
        else throw new Error('MOCK_CONTROL_DENIED');
      } catch { json(400, { error: 'MOCK_CONTROL_DENIED' }); }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__harness/aave') {
      if (!chain) { json(409, { error: 'MOCK_CHAIN_NOT_STARTED' }); return; }
      try { json(200, { result: aave.control(JSON.parse(await read(request) || '{}')) }); }
      catch (cause) { json(400, { error: 'MOCK_CONTROL_DENIED', reason: cause instanceof Error ? cause.message : 'MOCK_CONTROL_DENIED' }); }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/__harness/aave') { json(200, { result: aave.summary() }); return; }
    if (request.method === 'POST' && url.pathname === '/__harness/uniswap') {
      try {
        const control = JSON.parse(await read(request) || '{}') as Record<string, unknown>;
        if (control.action === 'reset') { chain = null; counter.accepted = 0; aave.reset(); }
        json(200, { result: uniswapControl(positions, control) });
      } catch (cause) { json(400, { error: 'MOCK_CONTROL_DENIED', reason: cause instanceof Error ? cause.message : 'MOCK_CONTROL_DENIED' }); }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/rpc' && positions.uniswap) {
      // The Uniswap position chain answers reads only; its one transaction path is the `send` control (the scripted owner wallet).
      const uniswap = positions.uniswap;
      let id: unknown = null;
      try {
        const call = JSON.parse(await read(request)) as { id?: unknown; method?: unknown; params?: unknown };
        id = call.id ?? null;
        json(200, { jsonrpc: '2.0', id, result: await uniswap.rpc(String(call.method), Array.isArray(call.params) ? call.params : []) });
      } catch (cause) { json(200, { jsonrpc: '2.0', id, error: { code: -32000, message: cause instanceof Error ? cause.message : 'MOCK_RPC_DENIED' } }); }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/rpc') {
      if (!chain) { response.writeHead(503, { 'content-type': 'text/plain' }).end('MOCKED Base chain not started'); return; }
      const live = chain;
      let id: unknown = null;
      try {
        const call = JSON.parse(await read(request)) as { id?: unknown; method?: unknown; params?: unknown };
        id = call.id ?? null;
        const params = Array.isArray(call.params) ? call.params : [];
        const result = call.method === 'eth_sendRawTransaction' ? await sendRawTransaction(live, params[0], counter)
          : await aave.rpc(String(call.method), params, (method, args) => live.rpc(method, args));
        json(200, { jsonrpc: '2.0', id, result });
      } catch (cause) {
        const error = cause as { message?: unknown; rpc?: unknown };
        json(200, { jsonrpc: '2.0', id, error: { code: typeof error.rpc === 'number' ? error.rpc : -32000, message: String(error.message ?? 'MOCK_RPC_DENIED') } });
      }
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end('MOCKED Base mainnet harness');
  });
}
if (import.meta.main) createBaseMainnetHarness().listen(8562, '127.0.0.1');
