// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: EIP-5792 wallet call batches — pure request/response shapes. Nothing here talks to a wallet.
 *
 * `wallet_sendCalls` asks the OWNER's wallet to execute a list of calls from the owner's own account, atomically when the wallet reports the
 * `atomic` capability for that chain (MetaMask: the account's own EIP-7702 smart account `execute(batch)` in ONE transaction the owner
 * confirms and pays for). FloFi never pays, relays or signs anything on this path: the wallet builds, shows, signs and broadcasts the
 * transaction itself; FloFi only hands it the exact calls of the workflow on that chain and reconciles the receipt the wallet reports
 * (`wallet_getCallsStatus`), re-read from the chain. No paymaster capability is ever requested (`FloFi never sponsors`), and a wallet that
 * cannot execute the batch atomically is refused for this path (the workflow falls back to confirming each step).
 *
 * Sources: EIP-5792 (final, `version: "2.0.0"`): `wallet_getCapabilities(address, [chainIds])` → `{ [chainId]: { atomic: { status } } }`;
 * `wallet_sendCalls({ version, chainId, from, atomicRequired, calls })` → `{ id }`; `wallet_getCallsStatus(id)` → `{ status, atomic, receipts }` with
 * status 100 (pending), 200 (confirmed), 400 (offchain failure), 500 (chain rules failure), 600 (partially confirmed).
 */
import { evmAddress, type Call } from './erc7710.js';

function fail(code: string): never { throw new Error(code); }
export const SEND_CALLS_VERSION = '2.0.0';
const DATA = /^0x(?:[0-9a-f]{2})*$/, HASH = /^0x[0-9a-f]{64}$/;
const hex = (value: bigint) => '0x' + value.toString(16);
export type SendCallsRequest = { readonly version: typeof SEND_CALLS_VERSION; readonly chainId: string; readonly from: string; readonly atomicRequired: true;
  readonly calls: readonly { readonly to: string; readonly value: string; readonly data: string }[] };
/** The `wallet_sendCalls` parameter for the workflow's exact calls on `chainId`: atomic required, no capabilities (no sponsorship) requested. */
export function sendCallsRequest(chainId: number, from: string, calls: readonly Call[]): SendCallsRequest {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !calls.length || calls.length > 16) fail('EIP5792_REQUEST_INVALID');
  return { version: SEND_CALLS_VERSION, chainId: hex(BigInt(chainId)), from: evmAddress(from), atomicRequired: true,
    calls: calls.map(c => typeof c.data === 'string' && DATA.test(c.data.toLowerCase()) && c.value >= 0n
      ? { to: evmAddress(c.target), value: hex(c.value), data: c.data.toLowerCase() } : fail('EIP5792_REQUEST_INVALID')) };
}
export type AtomicStatus = 'supported' | 'ready' | 'unsupported';
/** The `atomic` capability of one chain from a `wallet_getCapabilities` answer: `supported` (upgraded), `ready` (the wallet will upgrade the account in the same confirmation), else unsupported. */
export function atomicCapability(capabilities: unknown, chainId: number): AtomicStatus {
  const all = capabilities && typeof capabilities === 'object' ? capabilities as Record<string, unknown> : null;
  const key = Object.keys(all ?? {}).find(k => /^0x[0-9a-fA-F]+$/.test(k) && BigInt(k) === BigInt(chainId));
  const chain = key && all ? all[key] : null;
  const atomic = chain && typeof chain === 'object' ? (chain as { atomic?: { status?: unknown } }).atomic?.status : null;
  return atomic === 'supported' || atomic === 'ready' ? atomic : 'unsupported';
}
/** The batch id a wallet answered `wallet_sendCalls` with (a string in EIP-5792 2.0.0; older wallets answered `{ id }` or a bare string). */
export function sendCallsId(result: unknown): string {
  const id = typeof result === 'string' ? result : result && typeof result === 'object' ? (result as { id?: unknown }).id : null;
  return typeof id === 'string' && /^0x[0-9a-fA-F]{2,}$|^[A-Za-z0-9_-]{1,256}$/.test(id) ? id : fail('EIP5792_RESPONSE_INVALID');
}
export type CallsStatus = { readonly status: 'PENDING' | 'CONFIRMED' | 'OFFCHAIN_FAILURE' | 'CHAIN_FAILURE' | 'PARTIAL' | 'UNKNOWN'; readonly code: number; readonly atomic: boolean;
  readonly receipts: readonly { readonly transactionHash: string; readonly success: boolean; readonly blockNumber: bigint | null; readonly gasUsed: bigint | null; readonly logs: readonly unknown[] }[] };
const STATUS: Readonly<Record<number, CallsStatus['status']>> = Object.freeze({ 100: 'PENDING', 200: 'CONFIRMED', 400: 'OFFCHAIN_FAILURE', 500: 'CHAIN_FAILURE', 600: 'PARTIAL' });
const quantity = (value: unknown): bigint | null => typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) ? BigInt(value) : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
/** A `wallet_getCallsStatus` answer. Only the transaction hashes are trusted from it: FloFi re-reads every receipt from the chain. */
export function callsStatus(result: unknown): CallsStatus {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : fail('EIP5792_RESPONSE_INVALID');
  const code = typeof r.status === 'number' ? r.status : typeof r.status === 'string' && /^(CONFIRMED|PENDING)$/.test(r.status) ? (r.status === 'CONFIRMED' ? 200 : 100) : fail('EIP5792_RESPONSE_INVALID');
  const receipts = (Array.isArray(r.receipts) ? r.receipts : []).map(raw => {
    const x = raw && typeof raw === 'object' ? raw as Record<string, unknown> : fail('EIP5792_RESPONSE_INVALID');
    const transactionHash = typeof x.transactionHash === 'string' && HASH.test(x.transactionHash.toLowerCase()) ? x.transactionHash.toLowerCase() : fail('EIP5792_RESPONSE_INVALID');
    const status = quantity(x.status);
    return { transactionHash, success: status === 1n, blockNumber: quantity(x.blockNumber), gasUsed: quantity(x.gasUsed), logs: Array.isArray(x.logs) ? x.logs : [] };
  });
  return { status: STATUS[code] ?? 'UNKNOWN', code, atomic: r.atomic === true, receipts };
}
