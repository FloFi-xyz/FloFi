// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The product's request boundary. Authentication alone never grants closed-beta access.
 *
 * New private product use (`withFlightAccess`) requires an active Flight grant while the gate is in `beta`.
 * Observation, reporting and safe cancellation of already-owned work (`withFlightOwner`) require only a live
 * account session, including after grant revocation or while the gate is `closed`, so submitted operations
 * cannot become orphaned. Ownership of a specific run remains enforced by the existing wallet/session checks.
 */
import { betaAccessMode, createBetaAccessStore } from '../flight/beta-access.ts';
import type { WalletPrincipal } from './session-principal.ts';
import type { BetaRequestIdentity } from '../flight/beta-context.ts';
import { withBetaIdentity } from '../flight/beta-context.ts';

/** Flow and approval methods that observe, report or safely stop existing work without starting a new submission. */
const FLIGHT_RECOVERY_METHODS: ReadonlySet<string> = new Set([
  'status', 'observe', 'report', 'walletFailure', 'recoverUnknown', 'recoverReview', 'recover', 'invalidate',
  'cancelPrepared', 'cancel', 'end',
]);
export const isFlightRecoveryMethod = (method: string): boolean => FLIGHT_RECOVERY_METHODS.has(method);

/** Re-read the grant and the unrevoked account session for every operation, including direct Server Action calls. */
export async function requireFlightAccess(principal?: WalletPrincipal, env: Readonly<Record<string, string | undefined>> = process.env): Promise<BetaRequestIdentity | null> {
  const mode = betaAccessMode(env);
  if (mode === 'open') return null; // Rollout is deliberately inert until an operator enables it.
  if (mode !== 'beta') throw new Error('BETA_ACCESS_CLOSED');
  try {
    // Open-mode callers can run without Next's request context. Only an active gate loads request and database dependencies.
    const [{ accountHost, currentAccountSession }, { flightCalendar, flightNow }, { platformStateHost }, { currentWalletPrincipals }] = await Promise.all([
      import('../accounts/account-host.ts'), import('../flight/host.ts'), import('./platform-state-host.ts'), import('./session-principal.ts'),
    ]);
    const host = await accountHost(env), session = await currentAccountSession(host, env);
    if (!session) throw new Error('BETA_SIGN_IN_REQUIRED');
    const calendar = flightCalendar(env);
    if (!calendar) throw new Error('BETA_UNAVAILABLE');
    const gate = createBetaAccessStore(await platformStateHost(env), calendar, env), now = await flightNow(env);
    // The loopback campaign clock may simulate launch dates. Authentication always uses the actual session clock.
    const identity = { accountId: session.accountId, sessionId: session.sessionId, now, sessionNow: Date.now() };
    const loginNamespace = session.method === 'eip155' || session.method === 'solana' ? session.method : null;
    if (loginNamespace && !session.loginWallet) throw new Error('BETA_WALLET_REQUIRED');
    const login = loginNamespace && session.loginWallet ? { namespace: loginNamespace, address: session.loginWallet } : undefined;
    const result = await gate.require({ ...identity, ...(login ? { principal: login } : principal ? { principal } : {}) });
    if (!result.ok) throw new Error(result.code);
    // Local execution and private authoring share this boundary. A stale wallet cookie from another account must not
    // borrow the signed-in account's access, even when the operation does not explicitly select a wallet yet.
    const wallets = principal ? login ? [principal] : [] : await currentWalletPrincipals();
    for (const wallet of wallets) {
      if (wallet.namespace === login?.namespace && wallet.address === login.address) continue;
      const bound = await gate.require({ ...identity, principal: wallet });
      if (!bound.ok) throw new Error(bound.code);
    }
    return { accountId: session.accountId, sessionId: session.sessionId };
  } catch (error) {
    if (error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('BETA_UNAVAILABLE', { cause: error });
  }
}

/** A wallet address the caller names, as a Flight principal (EVM lower-cased), or null when it is not a wallet address. Grants nothing. */
export function walletPrincipalOf(address: unknown): WalletPrincipal | null {
  if (typeof address !== 'string') return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return { namespace: 'eip155', address: address.toLowerCase() };
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? { namespace: 'solana', address } : null;
}
/**
 * P0 (owner test 2026-11-12): the Flight decision for the SAME owner wallet the API checks on every flow call (`backend/app.ts`
 * `betaFlowOwnerRefusal`), returned as a value. Server Action errors are redacted in production builds, so a thrown `BETA_*` reached the
 * Editor as an anonymous failure ("Simulation failed"); this answer reaches it intact, before any quote, simulation or wallet request.
 * Read-only: it creates no grant, wallet binding or session and proves nothing about an address (only the caller's own account is consulted).
 */
export async function flightWalletRefusal(owner: unknown, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | null> {
  if (betaAccessMode(env) === 'open') return null;
  const principal = walletPrincipalOf(owner);
  try { await requireFlightAccess(principal ?? undefined, env); return null; }
  catch (error) { return error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message) ? error.message : 'BETA_UNAVAILABLE'; }
}

/**
 * Authenticated owner session for recovery of existing work. Does not require an active Flight grant.
 * Public/open rollout stays inert. Closed and beta modes both require a live signed-in account session.
 */
export async function requireFlightOwner(env: Readonly<Record<string, string | undefined>> = process.env): Promise<BetaRequestIdentity | null> {
  const mode = betaAccessMode(env);
  if (mode === 'open') return null;
  try {
    const [{ accountHost, currentAccountSession }] = await Promise.all([import('../accounts/account-host.ts')]);
    const host = await accountHost(env), session = await currentAccountSession(host, env);
    if (!session) throw new Error('BETA_SIGN_IN_REQUIRED');
    return { accountId: session.accountId, sessionId: session.sessionId };
  } catch (error) {
    if (error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('BETA_UNAVAILABLE', { cause: error });
  }
}

/** Scope propagation covers previews and nested service calls without sharing one request's identity with another. */
export async function withFlightAccess<T>(work: () => Promise<T>): Promise<T> {
  return withBetaIdentity(await requireFlightAccess(), work);
}

/** Owner-authenticated recovery path: status, receipts, late wallet reports and safe cancellation stay reachable after revocation. */
export async function withFlightOwner<T>(work: () => Promise<T>): Promise<T> {
  return withBetaIdentity(await requireFlightOwner(), work);
}

/**
 * The boundary of a user-funded group answer. A wallet batch's answer (its EIP-5792 id) reports a batch the owner's wallet ALREADY SENT: recording
 * it is reporting existing work, so it stays reachable after the grant ends, is revoked or the gate closes (else an executed batch could never
 * be reconciled). A user-operation signature or signed Solana transactions are relayed by FloFi itself — new submissions — and keep the product
 * grant. The kind chosen here cannot widen access: the service refuses an answer whose kind is not its group's (USER_FUNDED_AUTHORIZATION_KIND_MISMATCH).
 */
export async function withFlightGroupAnswerAccess<T>(answer: unknown, work: () => Promise<T>): Promise<T> {
  const sentBatch = typeof answer === 'object' && answer !== null && (answer as { readonly kind?: unknown }).kind === 'EVM_WALLET_BATCH';
  return sentBatch ? withFlightOwner(work) : withFlightAccess(work);
}

/** Route a flow method to the product grant boundary or the owner recovery boundary. */
export async function withFlightMethodAccess<T>(method: string, work: () => Promise<T>): Promise<T> {
  return isFlightRecoveryMethod(method) ? withFlightOwner(work) : withFlightAccess(work);
}

export async function requireFlightMethodAccess(method: string, principal?: WalletPrincipal,
  env: Readonly<Record<string, string | undefined>> = process.env): Promise<BetaRequestIdentity | null> {
  return isFlightRecoveryMethod(method) ? requireFlightOwner(env) : requireFlightAccess(principal, env);
}
