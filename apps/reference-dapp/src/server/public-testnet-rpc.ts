// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read-only Base Sepolia JSON-RPC clients for the public Uniswap v3 swap and liquidity flows, shared by the in-process
 * server actions and the cloud backend. Only allowlisted read methods; no send, sign or wallet method exists.
 */
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA_SWAP } from '../domain/public-testnet-swap.ts';
import type { Rpc } from './public-testnet-service.ts';

const SEND_METHODS = new Set(['eth_sendTransaction', 'eth_sendRawTransaction', 'sendTransaction', 'eth_sign', 'eth_signTransaction', 'personal_sign']);
export function createBaseSepoliaReadRpc(url: string, methods: readonly string[], timeoutMs = 10_000): Rpc {
  if (methods.some(method => SEND_METHODS.has(method))) throw new Error('PUBLIC_RPC_METHOD_DENIED');
  const allowed = new Set(methods);
  return async (method, params) => {
    if (!allowed.has(method)) throw new Error('PUBLIC_RPC_METHOD_DENIED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!response.ok) throw new Error('PUBLIC_RPC_UNAVAILABLE');
      const text = await response.text();
      if (text.length > 1_048_576) throw new Error('PUBLIC_RPC_RESPONSE_TOO_LARGE');
      const result: unknown = JSON.parse(text);
      if (result && typeof result === 'object' && 'error' in result && result.error && typeof result.error === 'object' &&
          'message' in result.error && typeof result.error.message === 'string' &&
          /missing trie node|historical state (?:is )?(?:unavailable|not available)|state .* is not available/i.test(result.error.message))
        throw new Error('PUBLIC_RPC_HISTORY_UNAVAILABLE');
      // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the node's own JSON-RPC code rides along (`rpcErrorCode`) so a caller can tell "the node answered with an
      // error" from "no answer at all"; the message every caller matches on is unchanged.
      if (result && typeof result === 'object' && 'error' in result && result.error && typeof result.error === 'object' &&
          'code' in result.error && [-32005, -32011, -32016, -32603].includes(Number(result.error.code)))
        throw Object.assign(new Error('PUBLIC_RPC_UNAVAILABLE'), { rpcErrorCode: Number(result.error.code) });
      if (!result || typeof result !== 'object' || !('result' in result) || 'error' in result) throw new Error('PUBLIC_RPC_RESPONSE_INVALID');
      return result.result;
    } catch (cause) {
      if (cause instanceof Error && /^[A-Z_]+$/.test(cause.message)) throw cause;
      throw new Error('PUBLIC_RPC_UNAVAILABLE', { cause });
    } finally { clearTimeout(timeout); }
  };
}
const PUBLIC_SWAP_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_call', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
/**
 * BUILD-CLOUD-PARITY-001: the Base Sepolia read client of the public swap, at the public endpoint or the deployment's HTTPS override
 * `GRYLOO_BASE_SEPOLIA_RPC_URL` (the one Base Sepolia endpoint setting every Base Sepolia flow shares), bound to chain 84532 and paced
 * like the Router's: from a serverless platform's shared egress the public endpoint drops read bursts (measured on the Preview).
 */
export function baseSepoliaSwapRpc(override: string | undefined): Rpc {
  return chainBoundRpc(pacedReadRpc(createBaseSepoliaReadRpc(httpsRpcUrl(override, BASE_SEPOLIA.rpcUrl, 'PUBLIC_RPC_CONFIGURATION_INVALID'), PUBLIC_SWAP_RPC_METHODS)), BASE_SEPOLIA.chainId);
}
/** The live Base Sepolia read client of the Uniswap liquidity flow: the same endpoint setting, paced (see `pacedReadRpc`). */
export function baseSepoliaLiquidityRpc(override: string | undefined): Rpc {
  return pacedReadRpc(createBaseSepoliaReadRpc(baseSepoliaRpcUrl(override), UNISWAP_LIQUIDITY_RPC_METHODS));
}
/** The liquidity flow additionally simulates call sequences and discovers owner transactions by nonce. */
export const UNISWAP_LIQUIDITY_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_maxPriorityFeePerGas', 'eth_simulateV1', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
/** A read client bound to one chain: any `eth_chainId` for another chain is refused, never followed. */
export function chainBoundRpc(rpc: Rpc, chainId: number): Rpc {
  return async (method, params) => {
    const result = await rpc(method, params);
    if (method === 'eth_chainId' && (typeof result !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(result) || BigInt(result) !== BigInt(chainId))) throw new Error('WRONG_PROVIDER_CHAIN');
    return result;
  };
}
/**
 * BUILD-ETHEREUM-001: the Ethereum Sepolia read client of the public swap, at the public endpoint or the server-side HTTPS override
 * `GRYLOO_ETHEREUM_SEPOLIA_RPC_URL`. Never a fallback for Base Sepolia, and never one for Ethereum Mainnet.
 */
export function ethereumSepoliaSwapRpc(override: string | undefined, methods: readonly string[] = PUBLIC_SWAP_RPC_METHODS): Rpc {
  return chainBoundRpc(createBaseSepoliaReadRpc(httpsRpcUrl(override, ETHEREUM_SEPOLIA_SWAP.rpcUrl, 'PUBLIC_RPC_CONFIGURATION_INVALID'), methods), ETHEREUM_SEPOLIA_SWAP.chainId);
}
function httpsRpcUrl(override: string | undefined, fallback: string, code: string): string {
  if (override === undefined || override === '') return fallback;
  let url: URL;
  try { url = new URL(override); } catch { throw new Error(code); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(code);
  return url.href;
}
/** Optional HTTPS override (e.g. a keyed provider for rate limits); anything else is a configuration error. */
export function baseSepoliaRpcUrl(override: string | undefined): string {
  if (override === undefined || override === '') return BASE_SEPOLIA.rpcUrl;
  let url: URL;
  try { url = new URL(override); } catch { throw new Error('UNISWAP_LIQUIDITY_RPC_CONFIGURATION_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('UNISWAP_LIQUIDITY_RPC_CONFIGURATION_INVALID');
  return url.href;
}
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: a read that got no usable answer from the node — the transport failed (HTTP error, timeout, refused
 * connection), the node reported a rate or capacity limit, or it lacks the pinned block's state. Distinct from an error the node answered
 * about the call itself (a revert: PUBLIC_RPC_RESPONSE_INVALID, or JSON-RPC -32603, which some providers use for reverts).
 */
export function readNotAnswered(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (cause.message === 'PUBLIC_RPC_HISTORY_UNAVAILABLE') return true;
  if (cause.message !== 'PUBLIC_RPC_UNAVAILABLE') return false;
  const code = (cause as { rpcErrorCode?: unknown }).rpcErrorCode;
  return code === undefined || code === -32005 || code === -32011 || code === -32016;
}
/**
 * Public endpoints rate-limit bursts (public Base answered HTTP 429 "over rate limit" to the router's parallel Review reads
 * during the BUILD-ROUTER-001 preflight). Every router RPC is a read, so calls are paced through one queue per transport and
 * transport failures are retried with backoff. An answer the node gave (including a JSON-RPC error) is never retried.
 */
export function pacedReadRpc(rpc: Rpc, options: { minIntervalMs?: number; retries?: number; sleep?: (ms: number) => Promise<void>; maxInFlight?: number } = {}): Rpc {
  // Measured on public Base (2026-10-04): a burst of ~5 eth_call succeeds, then HTTP 429 for several seconds.
  const minIntervalMs = options.minIntervalMs ?? 250, retries = options.retries ?? 6;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const maxInFlight = options.maxInFlight ?? 1;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 8) throw new Error('RPC_PACING_INVALID');
  if (maxInFlight > 1) return concurrentPacedRpc(rpc, minIntervalMs, retries, sleep, maxInFlight);
  let queue: Promise<unknown> = Promise.resolve(), last = 0;
  return (method, params) => {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try { return await rpc(method, params); }
        catch (cause) {
          if (!(cause instanceof Error && cause.message === 'PUBLIC_RPC_UNAVAILABLE') || attempt >= retries) throw cause;
          await sleep(500 * 2 ** attempt);
        }
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the dedicated-endpoint variant. Starts stay at least `minIntervalMs` apart, at most `maxInFlight` reads
 * run at once, and a transport failure pauses every later start for its backoff (the shared pause the one-at-a-time queue gives today). Same
 * retry rule: only PUBLIC_RPC_UNAVAILABLE is retried; an answer the node gave never is. Reads only; no send method passes through here.
 */
function concurrentPacedRpc(rpc: Rpc, minIntervalMs: number, retries: number, sleep: (ms: number) => Promise<void>, maxInFlight: number): Rpc {
  let last = 0, pausedUntil = 0, active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    for (;;) {
      if (active < maxInFlight) {
        const wait = Math.max(last + minIntervalMs, pausedUntil) - Date.now();
        if (wait <= 0) { active++; last = Date.now(); return; }
        await sleep(wait);
      } else await new Promise<void>(resolve => waiting.push(resolve));
    }
  };
  const release = () => { active--; waiting.shift()?.(); };
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      try { return await rpc(method, params); }
      catch (cause) {
        if (!(cause instanceof Error && cause.message === 'PUBLIC_RPC_UNAVAILABLE') || attempt >= retries) throw cause;
        pausedUntil = Math.max(pausedUntil, Date.now() + 500 * 2 ** attempt);
      } finally { release(); }
    }
  };
}
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: read pacing for an operator-configured RPC endpoint. The public endpoints keep the measured
 * one-at-a-time, 250 ms pacing. `GRYLOO_RPC_READ_PROFILE=dedicated` declares that the operator's endpoints — a configured
 * `GRYLOO_<NETWORK>_RPC_URL`, the router's fallback URLs and its keyed Alchemy URL — are providers with capacity for parallel reads
 * (25 ms between starts, at most 6 in flight); it never applies to a public default URL.
 */
export function readPacingFor(env: Readonly<Record<string, string | undefined>>, operatorEndpoint: boolean): { minIntervalMs?: number; maxInFlight?: number } {
  return operatorEndpoint && env.GRYLOO_RPC_READ_PROFILE === 'dedicated' ? { minIntervalMs: 25, maxInFlight: 6 } : {};
}
