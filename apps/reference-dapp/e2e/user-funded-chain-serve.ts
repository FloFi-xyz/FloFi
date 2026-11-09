// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution browser suite: the MOCKED loopback Base mainnet chain the user-funded runtime reads and simulates on
 * (https://127.0.0.1:8567), so the Editor's whole-workflow Review and Authorize run in a real browser. MOCKED and loopback only.
 *
 *   POST /rpc/8453   the in-process EVM double of the unit/PostgreSQL tests (src/delegation/harness/evm-double.ts) with Base's registered
 *                    catalog swap deployment and a modelled Aave V3 Base market: allowances, QuoterV2, eth_simulateV1 (the whole batch, then
 *                    discarded), getUserAccountData, receipts. It has NO send method: nothing reaches it except reads and the test's
 *                    own control below, which plays what an EIP-5792 wallet does with `wallet_sendCalls`.
 *   POST /control    test-only JSON-RPC: MOCK_reset(owner, usdcUnits, nativeWei), MOCK_walletBatch(owner, calls) → transaction hash (one
 *                    atomic transaction from the owner's own account, as a 7702 wallet sends it), MOCK_batches, MOCK_simulations,
 *                    MOCK_accountData(owner), MOCK_tokenBalance(token, owner).
 *
 * The certificate is the per-run loopback certificate playwright.config.ts generates for the read harnesses (FLOFI_SWAP_READ_TLS); the app
 * server trusts it through NODE_EXTRA_CA_CERTS. Evidence produced here is MOCKED, never a public execution.
 */
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEvmDouble } from '../src/delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../src/delegation/profiles.ts';
import { BASE_MAINNET_SWAP } from '../src/domain/public-testnet-swap.ts';

export const USER_FUNDED_CHAIN_PORT = 8567;
const directory = process.env.FLOFI_SWAP_READ_TLS;
if (process.env.FLOFI_USER_FUNDED_E2E !== 'MOCKED_LOOPBACK_ONLY' || !directory?.startsWith('/')) throw new Error('USER_FUNDED_HARNESS_DENIED');

const BASE = 'eip155:8453', POOL = delegationAavePool(BASE, [BASE]);
if (!POOL) throw new Error('USER_FUNDED_HARNESS_AAVE_POOL_MISSING');
const reserve = (asset: string) => delegationAaveReserve(BASE, POOL, asset) ?? (() => { throw new Error('USER_FUNDED_HARNESS_RESERVE_MISSING'); })();
// Oracle prices in the base currency (8 decimals): ETH 2,500 USD, USDC 1 USD; the double quotes 1 USDC = 0.0004 WETH.
const RESERVES = [{ ...reserve(BASE_MAINNET_SWAP.weth), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(BASE_MAINNET_SWAP.usdc), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
const create = () => createEvmDouble(8453, () => Math.floor(Date.now() / 1000), { profile: BASE_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
let chain = create(), batches = 0;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const replacer = (_: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;

createServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, async (request, response) => {
  const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value, replacer));
  if (request.method === 'GET') { json(200, { environment: 'MOCKED', chain: BASE, batches }); return; }
  let body = '';
  for await (const chunk of request) { body += String(chunk); if (body.length > 1_048_576) { json(413, {}); return; } }
  let input: { id?: unknown; method?: unknown; params?: unknown };
  try { input = JSON.parse(body) as typeof input; } catch { json(400, {}); return; }
  const id = input.id ?? 1, method = typeof input.method === 'string' ? input.method : '', params = Array.isArray(input.params) ? input.params : [];
  try {
    if (request.url === '/rpc/8453') { json(200, { jsonrpc: '2.0', id, result: await chain.rpc(method, params) }); return; }
    if (request.url !== '/control') { json(404, {}); return; }
    let result: unknown = null;
    if (method === 'MOCK_reset') {
      const [owner, usdc, native] = params as [string, string, string];
      if (!ADDRESS.test(String(owner).toLowerCase())) throw new Error('MOCK_OWNER_INVALID');
      chain = create(); batches = 0;
      chain.control.fundToken(owner, BASE_MAINNET_SWAP.usdc, BigInt(usdc)); chain.control.fundNative(owner, BigInt(native));
    } else if (method === 'MOCK_walletBatch') {
      const [owner, calls] = params as [string, { to: string; data: string; value?: string }[]];
      if (!ADDRESS.test(String(owner).toLowerCase()) || !Array.isArray(calls) || !calls.length) throw new Error('MOCK_BATCH_INVALID');
      batches += 1;
      result = chain.control.walletBatch(owner, calls.map(c => ({ target: c.to, data: c.data, value: BigInt(c.value ?? '0x0') })));
    } else if (method === 'MOCK_batches') result = batches;
    else if (method === 'MOCK_simulations') result = chain.control.simulations();
    else if (method === 'MOCK_accountData') result = chain.control.accountData(String(params[0]));
    else if (method === 'MOCK_tokenBalance') result = chain.control.tokenBalance(String(params[0]), String(params[1]));
    else if (method === 'MOCK_receipt') result = chain.control.receipt(String(params[0]));
    else throw new Error('MOCK_CONTROL_DENIED');
    json(200, { jsonrpc: '2.0', id, result });
  } catch (cause) {
    json(200, { jsonrpc: '2.0', id, error: { code: -32000, message: cause instanceof Error ? cause.message : 'MOCK_FAILED' } });
  }
}).listen(USER_FUNDED_CHAIN_PORT, '127.0.0.1');
