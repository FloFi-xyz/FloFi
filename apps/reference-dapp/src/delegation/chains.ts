// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: chain transports of delegated authority, each with a closed method allowlist enforced before any byte leaves the
 * process, and an explicit provenance (MOCKED loopback harness vs a public network) that caps every evidence claim made from it.
 *
 *   read      verification of enrollments, grants and revocations (EVM `eth_call`/`eth_getCode`/…, Solana account reads)
 *   owner     read + broadcasting a transaction the OWNER signed (a Solana delegation or revocation) — never a session signature
 *   executor  read only. BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 (invariant S1, user-funded gas): a transaction a SESSION SIGNER signs is paid by
 *             that FloFi-controlled address, so the executor can no longer broadcast anything (no `eth_sendRawTransaction`, no Solana
 *             `sendTransaction`). User-funded execution relays only what the owner signed, through `src/user-funded` (fee payer = owner).
 */
import { assertExecutionEnabled } from '../server/execution-guard.ts';
type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type TransportPurpose = 'read' | 'owner' | 'executor';
export type ChainTransport = { readonly chain: string; readonly provenance: 'MOCKED' | 'PUBLIC'; readonly rpc: Rpc };
// eth_getStorageAt: the Aave reads pin the Pool implementation (ERC-1967 slot), exactly as the owner-signed lending flows do (read-only).
// eth_simulateV1 (P0 workflow execution): a user-funded wallet batch is simulated whole, read-only, before the owner is asked to sign it.
// eth_getLogs (P0 hotfix E1, read-only): a batched bridge's Across fill is found on the destination chain by its (origin chain, deposit id) topics,
// as the Certified Router's own settlement observation does; a forgotten user operation's own event is searched the same way.
const EVM_READ = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_estimateGas', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_simulateV1', 'eth_getLogs']);
const SOL_READ = new Set(['getLatestBlockhash', 'getAccountInfo', 'getBalance', 'getSignatureStatuses', 'getGenesisHash']);
export function allowedMethods(chain: string, purpose: TransportPurpose): ReadonlySet<string> {
  const evm = chain.startsWith('eip155:');
  const read = evm ? EVM_READ : SOL_READ;
  if (purpose === 'read') return read;
  if (purpose === 'owner') return evm ? read : new Set([...read, 'sendTransaction']);
  // `executor`: S1 — no send method at all (a session-signed transaction would be FloFi-funded).
  return read;
}
/** Wraps `inner` so only `purpose`'s methods reach it (DELEGATION_RPC_METHOD_FORBIDDEN otherwise). */
export function guarded(chain: string, purpose: TransportPurpose, provenance: ChainTransport['provenance'], inner: Rpc): ChainTransport {
  const allowed = allowedMethods(chain, purpose);
  return { chain, provenance, rpc: async (method, params) => {
    if (!allowed.has(method)) throw new Error('DELEGATION_RPC_METHOD_FORBIDDEN');
    if (method === 'sendTransaction') assertExecutionEnabled();
    return inner(method, params);
  } };
}
/** A JSON-RPC 2.0 client over HTTP(S) with a timeout; an error response throws its message (bounded, never a body echo beyond 200 chars). */
export function httpRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    if (['sendTransaction', 'eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sendUserOperation'].includes(method)) assertExecutionEnabled();
    // A transport failure (timeout, refused connection) is DELEGATION_RPC_UNAVAILABLE: retryable, never a decision about the step.
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      .catch(() => { throw new Error('DELEGATION_RPC_UNAVAILABLE'); });
    const body = await response.json().catch(() => null) as { result?: unknown; error?: { message?: unknown } } | null;
    if (!body) throw new Error('DELEGATION_RPC_UNAVAILABLE');
    if (body.error) throw new Error(typeof body.error.message === 'string' ? body.error.message.slice(0, 200) : 'DELEGATION_RPC_ERROR');
    return body.result;
  };
}
