// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: `POST /api/gas/paymaster/<chainId>` — FloFi's ERC-7677 paymaster proxy, the URL a wallet's EIP-5792
 * `paymasterService` capability calls while it builds the owner's operation (`paymaster-service.ts` decides). Wallets call it from their own
 * origin (an extension, a wallet popup), so it answers CORS for any origin, with no cookie or credential: what authorizes a sponsorship is the
 * single-use grant in the request's context, bound to exactly the reviewed calls of one owner. Disabled (`config.ts`): 404, nothing sponsored.
 */
import { platformStateHost } from '../server/platform-state-host.ts';
import { gasSponsorshipRuntime, sponsorshipStorage, type GasSponsorshipRuntime } from './runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;
const MAX_BODY_BYTES = 64 * 1024;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
const rpcError = (status: number, code: number, message: string, id: unknown = null) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: HEADERS });

let deployment: Promise<GasSponsorshipRuntime | null> | null = null;
/** The deployment's runtime (PostgreSQL state), created once per process; a failure is not cached. */
const deploymentRuntime = (env: Env) => deployment ??= platformStateHost(env).then(host => gasSponsorshipRuntime(env, () => sponsorshipStorage(host)))
  .catch(() => { deployment = null; return null; });

/** The body as text, read no further than `limit` bytes (a body without a length is never buffered whole); null when larger. */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handlePaymasterHttp(request: Request, env: Env = process.env,
  runtimeOf: (env: Env) => Promise<GasSponsorshipRuntime | null> = deploymentRuntime): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== 'POST') return rpcError(405, -32600, 'GAS_SPONSOR_METHOD_NOT_ALLOWED');
  const chainId = /\/api\/gas\/paymaster\/([1-9][0-9]{0,9})\/?$/.exec(new URL(request.url).pathname)?.[1];
  if (!chainId) return rpcError(404, -32602, 'GAS_SPONSOR_CHAIN_UNEXPECTED');
  // Configuration is read before any storage is opened: a deployment without sponsorship never touches the database here.
  const runtime = await runtimeOf(env);
  if (!runtime) return rpcError(404, -32601, 'GAS_SPONSORSHIP_DISABLED');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return rpcError(413, -32600, 'GAS_SPONSOR_REQUEST_TOO_LARGE');
  const text = await boundedText(request, MAX_BODY_BYTES);
  if (text === null) return rpcError(413, -32600, 'GAS_SPONSOR_REQUEST_TOO_LARGE');
  let body: unknown;
  try { body = JSON.parse(text); } catch { return rpcError(400, -32700, 'GAS_SPONSOR_REQUEST_INVALID'); }
  // One request at a time (no JSON-RPC batches): every sponsorship is decided and recorded on its own.
  if (!body || typeof body !== 'object' || Array.isArray(body)) return rpcError(400, -32600, 'GAS_SPONSOR_REQUEST_INVALID');
  const answer = await runtime.paymaster(Number(chainId), body as Parameters<GasSponsorshipRuntime['paymaster']>[1]);
  // JSON-RPC errors travel in a 200 response (wallets read the error object); the provider's key or URL never appears in either.
  return new Response(JSON.stringify(answer), { status: 200, headers: HEADERS });
}
