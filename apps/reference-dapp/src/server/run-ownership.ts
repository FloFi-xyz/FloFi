// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-JOURNEY-001: run ownership for permissionless flows.
 *
 * A run belongs to the wallet that created it (the owner recorded in its validated, append-only log, which can never
 * change). A caller is identified only by a wallet session principal — the address that proved control of the wallet by
 * signing the sign-in message (see `wallet-session.ts`). This guard decides whether that principal may call a flow method;
 * the same function runs in the API (`backend/app.ts`) and in local server actions, so both paths enforce one rule.
 *
 * Ownership is not financial authority: it never authorizes a transaction. Each wallet request still needs the owner's
 * Review, Manifest acceptance, Execute click and the wallet's own signature, exactly as before.
 */
export type OwnershipPolicy = {
  /** Capability probes that need no session. */
  readonly open: readonly string[];
  /** Methods whose argument at this index is the claimed owner (it must be the principal). */
  readonly ownerArgument: Readonly<Record<string, number>>;
  /** Methods whose first argument is a run id (the durable run's owner must be the principal). */
  readonly runArgument: readonly string[];
};
/** The Cross-chain Router methods (both networks). A method missing here is refused, never silently allowed. */
export const ROUTER_OWNERSHIP: OwnershipPolicy = Object.freeze({
  open: Object.freeze(['mode', 'info']),
  ownerArgument: Object.freeze({ simulate: 1, begin: 1 }),
  runArgument: Object.freeze(['refresh', 'review', 'invalidate', 'begin', 'handoff', 'report', 'walletFailure', 'observe', 'status']),
});
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router. A run belongs to its source wallet — an EVM account (Sign-In With
 * Ethereum session) or a Solana key (Sign-In With Solana session). Discovery persists nothing and binds no owner.
 */
export const UNIVERSAL_OWNERSHIP: OwnershipPolicy = Object.freeze({
  open: Object.freeze(['mode', 'info', 'discover']),
  ownerArgument: Object.freeze({ simulate: 1, begin: 1 }),
  runArgument: Object.freeze(['refresh', 'review', 'invalidate', 'begin', 'handoff', 'report', 'submit', 'walletFailure', 'observe', 'status']),
});
/** Stablecoin → Pix payments: a run, its Review and its source transfer belong to the wallet that simulated it. */
export const PAYMENT_OWNERSHIP: OwnershipPolicy = Object.freeze({
  open: Object.freeze(['mode', 'info']),
  ownerArgument: Object.freeze({ simulate: 1, begin: 1 }),
  runArgument: Object.freeze(['review', 'invalidate', 'begin', 'handoff', 'report', 'observe', 'status']),
});
/** Server-to-server only: the BFF sets it from a verified session; the browser can never reach the API to set it. */
export const WALLET_PRINCIPAL_HEADER = 'x-flofi-wallet-principal';
const ACCOUNT = /^0x[0-9a-f]{40}$/, SOLANA_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A lower-case EVM account, or (BUILD-CROSSCHAIN-UNIVERSAL-001) a base58 Solana key proven by a Sign-In With Solana session; null for anything
 * else (absent, malformed, mixed-case EVM). A Solana principal never equals an EVM owner, so flows owned by EVM accounts are unaffected.
 */
export function normalizePrincipal(value: unknown): string | null {
  return typeof value === 'string' && (ACCOUNT.test(value) || SOLANA_KEY.test(value)) ? value : null;
}
/** EVM accounts compare case-insensitively; Solana keys are case-sensitive base58 and compare exactly. */
const samePrincipal = (claimed: string, principal: string) => ACCOUNT.test(principal) ? claimed.toLowerCase() === principal : claimed === principal;

/**
 * Resolves when `principal` may call `method(args)`; otherwise throws a classified code:
 * `WALLET_SESSION_REQUIRED` (no session), `RUN_OWNER_MISMATCH` (another wallet's run or a claimed owner that is not the
 * principal), `RUN_OWNERSHIP_UNDECLARED` (a method the policy does not cover). `ownerOf` loads the durable owner and
 * throws the flow's own code (e.g. `ROUTER_RUN_NOT_FOUND`) for an unknown run.
 */
export async function assertRunOwnership(policy: OwnershipPolicy, method: string, args: readonly unknown[], principal: string | null,
  ownerOf: (runId: string) => Promise<string>): Promise<void> {
  if (policy.open.includes(method)) return;
  if (normalizePrincipal(principal) === null) throw new Error('WALLET_SESSION_REQUIRED');
  const claims = Object.hasOwn(policy.ownerArgument, method), existing = policy.runArgument.includes(method);
  if (!claims && !existing) throw new Error('RUN_OWNERSHIP_UNDECLARED');
  if (claims) {
    const claimed = args[policy.ownerArgument[method]!];
    if (typeof claimed !== 'string' || !samePrincipal(claimed, principal!)) throw new Error('RUN_OWNER_MISMATCH');
  }
  if (existing) {
    if (typeof args[0] !== 'string') throw new Error('RUN_ID_INVALID');
    const owner = await ownerOf(args[0]);
    if (typeof owner !== 'string' || !samePrincipal(owner, principal!)) throw new Error('RUN_OWNER_MISMATCH');
  }
}
