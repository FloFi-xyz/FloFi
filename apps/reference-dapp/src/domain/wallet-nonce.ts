// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident A): the pre-send nonce check, as one shared, classified rule.
 *
 * FloFi prepares an EVM request with the account nonce its own RPC reports as `pending` (the durable nonce reservation), and every owner-wallet
 * flow asks the wallet's EIP-1193 provider for its own `pending` count just before `eth_sendTransaction`. Wallets assign the nonce themselves
 * (MetaMask ignores a dapp-supplied nonce unless the owner customises it), so a request the wallet would number differently is never sent: it
 * would either queue behind something FloFi cannot see or land on a slot the Review did not reserve. That check is kept, unchanged in strength:
 * the request goes to the wallet only when the wallet's own count equals the reviewed nonce.
 *
 * What changes is that a disagreement is CLASSIFIED instead of reported as one undifferentiated "another transaction took the slot":
 *
 *   WALLET_BEHIND  the wallet reports a LOWER count than the nonce FloFi's chain reads proved next — its network view lags the chain (a lagging RPC
 *                  node, or state not refreshed after a transaction that already confirmed). The reviewed nonce is still correct. This is the only
 *                  case recovered automatically: the wallet's count is read again a bounded number of times (one block apart), and the request
 *                  proceeds only if it then equals the reviewed nonce. Nothing is signed or sent while it disagrees.
 *   WALLET_AHEAD   the wallet reports a HIGHER count: it holds (or its node sees) a pending transaction FloFi's RPC did not report. It may be a real
 *                  transaction from this wallet (another dapp, another tab) or one the wallet still tracks locally. Never auto-resolved: the owner
 *                  checks pending wallet transactions; afterwards a fresh preparation reads the nonce again.
 *   INVALID        the wallet's answer is not a canonical quantity. Fail closed.
 *
 * Whether the reviewed slot was really CONSUMED by another transaction is decided server-side from the chain itself (`latest` advanced past the
 * reviewed nonce), never from the wallet's answer. Nothing here fabricates a nonce, skips ahead, replaces a transaction or retries a send.
 */

export type WalletNonceRelation = 'ALIGNED' | 'WALLET_BEHIND' | 'WALLET_AHEAD' | 'INVALID';
/** The wallet-side evidence of one check, safe to record (two integers as decimal strings; no address, no RPC URL, no provider text). */
export type WalletNonceEvidence = { readonly reviewed: string; readonly wallet: string | null; readonly relation: WalletNonceRelation; readonly reads: number };

/**
 * A JSON-RPC quantity (`0x` + hex digits, at most 64 bits as nonces are) or, as some providers answer, a non-negative safe integer (the Aave flow
 * already accepted both); anything else is unreadable, never coerced.
 */
export function walletNonceQuantity(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  // Canonical only (no leading zeros), exactly as the flows' own parsers accepted before (wallet-execution review).
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(value)) return null;
  return BigInt(value);
}

export function classifyWalletNonce(reviewed: bigint, walletValue: unknown): { relation: WalletNonceRelation; wallet: bigint | null } {
  const wallet = walletNonceQuantity(walletValue);
  if (wallet === null) return { relation: 'INVALID', wallet: null };
  return { relation: wallet === reviewed ? 'ALIGNED' : wallet < reviewed ? 'WALLET_BEHIND' : 'WALLET_AHEAD', wallet };
}

/** Bounded re-observation of a lagging wallet view: at most this many reads in total, `WALLET_NONCE_REREAD_MS` apart (about one L2 block). */
export const WALLET_NONCE_MAX_READS = 3;
export const WALLET_NONCE_REREAD_MS = 2_000;

/**
 * Reads the wallet's pending count and compares it with the reviewed nonce. Only a lower count (`WALLET_BEHIND`) is read again, up to
 * `WALLET_NONCE_MAX_READS` reads in total; `stillCurrent` is asked before every re-read so a run the owner left, an edited workflow or a changed
 * wallet stops the wait immediately (it throws its own code). The result is the last observation; `ALIGNED` is the only one that allows the send.
 */
export async function observeWalletNonce(input: {
  readonly reviewed: bigint;
  readonly read: () => Promise<unknown>;
  readonly stillCurrent?: () => void | Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxReads?: number;
}): Promise<WalletNonceEvidence> {
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const maxReads = Math.max(1, Math.min(input.maxReads ?? WALLET_NONCE_MAX_READS, WALLET_NONCE_MAX_READS));
  let reads = 0, last: ReturnType<typeof classifyWalletNonce> = { relation: 'INVALID', wallet: null };
  while (reads < maxReads) {
    if (reads > 0) { await sleep(WALLET_NONCE_REREAD_MS); await input.stillCurrent?.(); }
    last = classifyWalletNonce(input.reviewed, await input.read());
    reads++;
    if (last.relation !== 'WALLET_BEHIND') break;
  }
  return { reviewed: input.reviewed.toString(), wallet: last.wallet === null ? null : last.wallet.toString(), relation: last.relation, reads };
}

/**
 * The closed refusal code of a non-aligned observation, under a flow's prefix (`UNIVERSAL`, `ROUTER`, `UNISWAP`, `SUPPLY`, `TRANSFER`). An
 * unreadable answer keeps the flow's historical code (`<FLOW>_WALLET_NONCE_MISMATCH`, or `_RESPONSE_INVALID` where the flow used it); the two classified relations have their own codes so the owner is
 * told what actually disagreed. Every code still contains `NONCE`, so each flow's existing "nothing was sent" handling applies unchanged.
 */
export function walletNonceRefusal(prefix: string, evidence: Pick<WalletNonceEvidence, 'relation'>, invalid: 'MISMATCH' | 'RESPONSE_INVALID' = 'MISMATCH'): string | null {
  if (evidence.relation === 'ALIGNED') return null;
  return `${prefix}_WALLET_NONCE_${evidence.relation === 'WALLET_BEHIND' ? 'BEHIND' : evidence.relation === 'WALLET_AHEAD' ? 'AHEAD' : invalid}`;
}

/** Any classified pre-send wallet nonce refusal of any flow (the request never reached the wallet's send method). */
export const WALLET_NONCE_REFUSAL = /^[A-Z]+_WALLET_NONCE_(?:MISMATCH|BEHIND|AHEAD|RESPONSE_INVALID)$/;

/**
 * The owner-facing sentence of a classified pre-send wallet nonce refusal (any flow), or null for any other code. Plain words, no nonce values:
 * the counts stay in the run's technical details and the Support view.
 */
export const WALLET_NONCE_COPY = {
  BEHIND: 'Your wallet reported an older transaction number than the network, so nothing was sent by FloFi. Wait a moment, then refresh and review this step again.',
  AHEAD: 'Your wallet shows a pending transaction that FloFi does not see on the network yet, so nothing was sent by FloFi. Check pending transactions in your wallet, then refresh and review this step again.',
  MISMATCH: 'Your wallet and the network reported different transaction numbers. No transaction was sent by FloFi. Check pending wallet transactions, then refresh and review this step again.',
  INVALID: 'Your wallet did not report a readable transaction number, so nothing was sent by FloFi. Reconnect your wallet, then refresh and review this step again.',
} as const;
export function walletNonceMessage(code: string): string | null {
  if (!WALLET_NONCE_REFUSAL.test(code)) return null;
  return code.endsWith('_BEHIND') ? WALLET_NONCE_COPY.BEHIND : code.endsWith('_AHEAD') ? WALLET_NONCE_COPY.AHEAD : code.endsWith('_RESPONSE_INVALID') ? WALLET_NONCE_COPY.INVALID
    : WALLET_NONCE_COPY.MISMATCH;
}

/**
 * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (security review): the note a server records for a proven wallet refusal (EIP-1193 4001 user rejected,
 * 4100 unauthorized, anything else in the accepted refusal set: method unsupported), derived from the refusal code itself — the same names the
 * stores already send — so a client label can never turn a refusal into a pre-wallet reason.
 */
export function refusalNote(prefix: string, rejectionCode: number): string {
  return `${prefix}_${rejectionCode === 4001 ? 'REJECTED' : rejectionCode === 4100 ? 'WALLET_UNAUTHORIZED' : 'WALLET_METHOD_UNSUPPORTED'}`;
}

/**
 * Wallet-execution review: flows that compare the wallet with the nonce recorded at REVIEW time (Aave supply, Robinhood transfer) cannot tell a
 * pending wallet transaction from a Review the chain has since moved past (another transaction, or a MetaMask Smart Account's own nonce use), so
 * a higher wallet count is worded neutrally there (MISMATCH), never as "a pending transaction FloFi does not see". A lower count still re-reads.
 */
export function reviewNonceRefusal(prefix: string, evidence: Pick<WalletNonceEvidence, 'relation'>, invalid: 'MISMATCH' | 'RESPONSE_INVALID' = 'MISMATCH'): string | null {
  return walletNonceRefusal(prefix, evidence.relation === 'WALLET_AHEAD' ? { relation: 'INVALID' } : evidence, evidence.relation === 'WALLET_AHEAD' ? 'MISMATCH' : invalid);
}
