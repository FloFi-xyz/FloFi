// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident A): what a pre-send wallet nonce refusal records on its CANCELLED attempt — both sides of the
 * disagreement, as decimal counts, so support can tell a lagging wallet view from a real pending transaction without guessing:
 *
 *   wallet / walletRelation   the wallet provider's `pending` count as the browser read it (validated: only a count for the attempt's own nonce)
 *   chainLatest / chainPending FloFi's own RPC, read when the refusal was recorded
 *   chainRelation             CONSUMED: `latest` passed the reviewed nonce — another transaction really used the slot; PENDING_ELSEWHERE: FloFi's
 *                             RPC now also sees a pending transaction at the slot; UNCHANGED: FloFi's chain view still says the reviewed nonce is
 *                             next (the wallet disagreed on its own); UNKNOWN: FloFi's reads failed
 *
 * Plain data; no address, URL, provider text or credential. It never changes what the refusal means: nothing was sent.
 */
import type { WalletNonceRelation } from '../../domain/wallet-nonce.ts';

export type NonceChainRelation = 'CONSUMED' | 'PENDING_ELSEWHERE' | 'UNCHANGED' | 'UNKNOWN';
export type WalletNonceCheck = {
  readonly reviewed: string; readonly wallet: string | null; readonly walletRelation: WalletNonceRelation; readonly reads: number;
  readonly chainLatest: string | null; readonly chainPending: string | null; readonly chainRelation: NonceChainRelation; readonly observedAt: string;
};

export function chainRelationOf(reviewed: string, latest: string | null, pending: string | null): NonceChainRelation {
  if (latest === null || pending === null) return 'UNKNOWN';
  const n = BigInt(reviewed), l = BigInt(latest), p = BigInt(pending);
  if (l > n) return 'CONSUMED';
  if (p > n) return 'PENDING_ELSEWHERE';
  return 'UNCHANGED';
}
