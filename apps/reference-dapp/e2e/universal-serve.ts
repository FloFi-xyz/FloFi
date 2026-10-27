// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 loopback server (127.0.0.1:8566) for the browser suite, wrapping the same MOCKED in-process chains (Base,
 * Arbitrum One, Ethereum, Robinhood Chain, Solana) and MOCKED Relay API (orders hashed for real) as the unit and PostgreSQL tests. Never a
 * public network; nothing is broadcast anywhere but these in-memory chains.
 *   /evm/<chainId>, /solana   JSON-RPC (the app's universal router reads, simulates and — Solana only — submits the owner-signed bytes here)
 *   /relay/*                  quote/v2 and intents/status/v3 like Relay; /lifi/*, /mayan/*, /across/* answer "no route" (recorded shapes)
 *   /control                  the test's own wallet and chain clock: reset, evm_send (the EVM wallet's broadcast), fill, mine, counters
 * A Solana transaction FloFi submits lands immediately (finalized in the mock); EVM sends mine one block, `mine` adds confirmations.
 */
import { createServer } from 'node:http';
import { UNIVERSAL_NETWORKS } from '@defi-workflow-engine/workflow-contracts';
import { createEvmMockChain, createRelayMock, createSolanaMock, mockedUniversalDeployment, type EvmMock } from '../src/server/universal-router/universal.test-harness.ts';
import { UNIVERSAL_HARNESS_PORT } from '../src/server/universal-router/mock-deployment.ts';

const USDC = { base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } as const;
const WETH = { chain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 };
const NATIVE = { EVM: '0x0000000000000000000000000000000000000000', SOLANA: '11111111111111111111111111111111' } as const;
function harness(owners: { evm?: string; solana?: string } = {}) {
  const now = () => Date.now(), D = mockedUniversalDeployment();
  let orderLifetimeSeconds = 7 * 86_400;
  const evm: Record<string, EvmMock> = Object.fromEntries(Object.keys(D.evm).map(chain => [chain, createEvmMockChain(D.evm[chain]!, { now,
    tokens: { ...chain === UNIVERSAL_NETWORKS.base.chain ? { [USDC.base]: 6 } : {}, ...chain === WETH.chain ? { [WETH.address]: WETH.decimals } : {} } })]));
  const solana = createSolanaMock(D.solana, { mints: { [USDC.solana]: 6 } });
  // 1 SOL = 150 USDC; 1 ETH = 4,000 USDC.
  const price = (c: string) => c === NATIVE.SOLANA ? 150n : c === NATIVE.EVM || c === WETH.address ? 4000n : 1n;
  const relay = createRelayMock({ now, orderLifetimeSeconds: () => orderLifetimeSeconds, decimals: (_, c) => c === NATIVE.EVM || c === WETH.address ? 18 : c === NATIVE.SOLANA ? 9 : 6, rate: (i, o) => 10n ** 18n * price(i) / price(o),
    symbol: (_, c) => c === NATIVE.SOLANA ? 'SOL' : c === NATIVE.EVM ? 'ETH' : c === WETH.address ? 'WETH' : 'USDC' });
  const base = evm[UNIVERSAL_NETWORKS.base.chain]!;
  if (owners.evm) { base.setNative(owners.evm, 10n ** 18n); base.setToken(USDC.base, owners.evm, 1_000_000_000n); }
  if (owners.solana) { solana.setLamports(owners.solana, 2_000_000_000n); solana.setToken(owners.solana, USDC.solana, 500_000_000n); }
  const counters = { solanaSends: 0, evmSends: 0 };
  // Every Solana transaction FloFi broadcasts lands at once in the mock (a public cluster would take a few seconds).
  const solanaRpc = async (method: string, params: readonly unknown[]) => {
    const result = await solana.rpc(method, params);
    if (method === 'sendTransaction') { counters.solanaSends += 1; solana.land(String(result)); }
    return result;
  };
  return { evm, solana, solanaRpc, relay, counters, base, quoteValidity(seconds: number) { orderLifetimeSeconds = 600 + seconds; } };
}
let h = harness();

type RelayQuote = { requestId: string; protocol: { v2: { orderId: string; orderData: { output: { chainId: string; payments: { recipient: string; currency: string;
  expectedAmount: string }[] } } } } };
/**
 * The solver fills the reviewed order on its destination chain and Relay reports success.
 * Prefer `orderId` (Execute re-quotes for revalidation, so `quotes.at(-1)` is often a different order than Review).
 */
function fill(p: { sourceHash?: string | null; orderId?: string } = {}) {
  const quotes = h.relay.quotes as RelayQuote[];
  const raw = (p.orderId
    ? [...quotes].reverse().find(q => q.protocol?.v2?.orderId?.toLowerCase() === p.orderId!.toLowerCase())
    : quotes.at(-1));
  if (!raw) throw new Error('MOCK_NO_ORDER');
  const order = raw.protocol.v2, payment = order.orderData.output.payments[0]!;
  const destination = Object.values(UNIVERSAL_NETWORKS).find(n => n.providers.relay.slug === order.orderData.output.chainId)!;
  const native = payment.currency === NATIVE.EVM || payment.currency === NATIVE.SOLANA;
  const hash = destination.ecosystem === 'SOLANA'
    ? h.solana.deliver({ recipient: payment.recipient, mint: native ? null : payment.currency, amount: BigInt(payment.expectedAmount), orderId: order.orderId })
    : h.evm[destination.chain]!.deliver({ recipient: payment.recipient, token: native ? null : payment.currency, amount: BigInt(payment.expectedAmount), orderId: order.orderId });
  h.relay.setStatus(raw.requestId, { status: 'success', inTxHashes: p.sourceHash ? [p.sourceHash] : [], txHashes: [hash] });
  return hash;
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${UNIVERSAL_HARNESS_PORT}`);
  const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  try {
    if (url.pathname.startsWith('/relay/')) {
      const answer = request.method === 'POST' ? await h.relay.http.post(url.href, body) : await h.relay.http.get(url.href);
      const refused = answer as { __httpStatus?: number; __body?: unknown };
      json(refused.__httpStatus ?? 200, refused.__httpStatus ? refused.__body : answer); return;
    }
    if (url.pathname.startsWith('/lifi/')) { json(200, { routes: [] }); return; }
    if (url.pathname.startsWith('/mayan/')) { json(200, { quotes: [] }); return; }
    if (url.pathname.startsWith('/across/')) { json(400, { message: 'Route not enabled' }); return; }
    if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'text/plain' }).end('MOCKED Flofi universal router harness'); return; }
    const { method, params = [] } = body as { method: string; params?: unknown[] };
    const reply = (value: object) => json(200, { jsonrpc: '2.0', id: 1, ...value });
    try {
      const evmPath = /^\/evm\/(\d+)$/.exec(url.pathname);
      if (evmPath) { reply({ result: await h.evm[`eip155:${evmPath[1]}`]!.rpc(method, params) }); return; }
      if (url.pathname === '/solana') { reply({ result: await h.solanaRpc(method, params) }); return; }
      if (url.pathname !== '/control') { json(404, {}); return; }
      const p = (params[0] ?? {}) as Record<string, unknown>;
      if (method === 'MOCK_reset') { h = harness(p as { evm?: string; solana?: string }); reply({ result: true }); return; }
      if (method === 'MOCK_quoteValidity') { const seconds = Number(p.seconds); if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) throw Error('MOCK_INVALID_VALIDITY');
        h.quoteValidity(seconds); reply({ result: true }); return; }
      if (method === 'MOCK_evm_send') {
        const tx = p as { from: string; to: string; data: string; value: string; chainId: string };
        const chain = Object.values(UNIVERSAL_NETWORKS).find(n => n.evmChainId === Number(BigInt(tx.chainId)))!.chain;
        h.counters.evmSends += 1;
        reply({ result: h.evm[chain]!.wallet.send({ from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }).hash }); return;
      }
      if (method === 'MOCK_failSimulation') { h.evm[UNIVERSAL_NETWORKS.base.chain]!.state.simulateFails = p.enabled === true; reply({ result: true }); return; }
      if (method === 'MOCK_nonce') { const chain = `eip155:${Number(BigInt(String(params[2] ?? '0x2105')))}`;
        reply({ result: await h.evm[chain]!.rpc('eth_getTransactionCount', params.slice(0, 2)) }); return; }
      if (method === 'MOCK_fill') {
        reply({ result: fill({ sourceHash: typeof p.sourceHash === 'string' ? p.sourceHash : null,
          ...typeof p.orderId === 'string' ? { orderId: p.orderId } : {} }) }); return;
      }
      if (method === 'MOCK_mine') { for (const m of Object.values(h.evm)) for (let i = 0; i < Number(p.blocks ?? 3); i++) m.mine(); reply({ result: true }); return; }
      if (method === 'MOCK_counters') { reply({ result: h.counters }); return; }
      reply({ error: { code: -32601, message: 'MOCK_METHOD_UNSUPPORTED' } });
    } catch (error) { reply({ error: { code: -32000, message: error instanceof Error ? error.message : 'MOCK_ERROR' } }); }
  } catch { json(400, {}); }
}).listen(UNIVERSAL_HARNESS_PORT, '127.0.0.1');
