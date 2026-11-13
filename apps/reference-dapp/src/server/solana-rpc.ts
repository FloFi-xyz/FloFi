// SPDX-License-Identifier: AGPL-3.0-only
import type { SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { assertExecutionEnabled } from './execution-guard.ts';

/**
 * Read methods for simulation/reconciliation. sendTransaction is reachable only from the owner-signed submit path. `getSignaturesForAddress`
 * and `getBlock` (ADR-0010 §4, read-only: one block's height, no transactions) recover a Kora transaction whose answer was lost, by the owner's
 * recorded signature, within the window its blockhash allowed.
 */
const methods = new Set(['getGenesisHash', 'getSlot', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'getLatestBlockhash', 'getBlockHeight', 'getFeeForMessage', 'simulateTransaction', 'getMinimumBalanceForRentExemption',
  'getSignatureStatuses', 'getTransaction', 'getSignaturesForAddress', 'getBlock', 'sendTransaction']);

/** An owner-chosen HTTPS RPC may carry its own credential in its path; it is never logged or returned. */
export function solanaRpcOverride(value: string | undefined, code: string): string | undefined {
  if (value && (() => { try { const url = new URL(value); return url.protocol !== 'https:' || Boolean(url.username || url.password); } catch { return true; } })()) throw new Error(code);
  return value;
}
/** Serialized, allowlisted JSON-RPC transport shared by every Solana swap runtime. Cluster identity is verified by the callers. */
export function createSolanaRpc(endpoint: string, loopback: boolean): SolanaRpc {
  let queue: Promise<unknown> = Promise.resolve();
  const post = async (method: string, params: readonly unknown[]) => {
    if (!methods.has(method)) throw new Error('SOLANA_RPC_METHOD_DENIED');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!loopback) await new Promise<void>(resolve => setTimeout(resolve, attempt === 0 ? 120 : 600 * attempt));
      // The queue and pacing can outlive an operator's pause; check at the actual network boundary.
      if (method === 'sendTransaction') assertExecutionEnabled();
      const response = await fetch(endpoint, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const text = await response.text(); if (text.length > 2_097_152) throw new Error('SOLANA_RPC_RESPONSE_TOO_LARGE');
      if (response.status === 429 && method !== 'sendTransaction') { if (attempt < 2) continue; throw new Error('SOLANA_RPC_RATE_LIMITED'); }
      // Node 24 supplies each primitive's original JSON lexeme. Preserve large integer balances before JSON.parse's Number result
      // can lose precision; downstream uint64 decoders accept these exact decimal strings and still reject unsafe Number values.
      const value: unknown = JSON.parse(text, (_key: string, parsed: unknown, context?: { source?: string }) =>
        typeof parsed === 'number' && !Number.isSafeInteger(parsed) && context?.source && /^-?[0-9]+$/.test(context.source) ? context.source : parsed);
      if (value && typeof value === 'object' && 'error' in value && value.error) {
        const rpcError = value.error as { code?: unknown; message?: unknown };
        throw new Error(method === 'sendTransaction' ? 'SOLANA_SEND_REJECTED' : 'SOLANA_RPC_ERROR', { cause: { code: rpcError.code, message: String(rpcError.message ?? '').slice(0, 300) } });
      }
      if (!response.ok || !value || typeof value !== 'object' || !('result' in value)) throw new Error('SOLANA_RPC_UNAVAILABLE');
      return value.result;
    }
    throw new Error('SOLANA_RPC_RATE_LIMITED');
  };
  // P0 catalog reliability: a read queued for an abandoned preview (its context signal aborted) is dropped when its turn comes, never sent. Only the
  // preview transport passes a context (backend/app.ts untilAborted); submissions and owner flows never do, so they are unaffected.
  return (method: string, params: readonly unknown[], context?: { readonly signal?: AbortSignal }) => {
    const result = queue.then(() => context?.signal?.aborted ? Promise.reject(new Error('RPC_READ_ABANDONED')) : post(method, params));
    queue = result.catch(() => undefined); return result;
  };
}
