// SPDX-License-Identifier: AGPL-3.0-only
/** The product's request boundary. Authentication alone never grants closed-beta access. */
import { accountHost, currentAccountSession } from '../accounts/account-host.ts';
import { betaAccessMode, createBetaAccessStore } from '../flight/beta-access.ts';
import { flightCalendar } from '../flight/host.ts';
import { platformStateHost } from './platform-state-host.ts';
import type { WalletPrincipal } from './session-principal.ts';
import type { BetaRequestIdentity } from '../flight/beta-context.ts';
import { withBetaIdentity } from '../flight/beta-context.ts';

/** Re-read the grant and the unrevoked account session for every operation, including direct Server Action calls. */
export async function requireFlightAccess(principal?: WalletPrincipal, env: Readonly<Record<string, string | undefined>> = process.env): Promise<BetaRequestIdentity | null> {
  const mode = betaAccessMode(env);
  if (mode === 'open') return null; // Rollout is deliberately inert until an operator enables it.
  if (mode !== 'beta') throw new Error('BETA_ACCESS_CLOSED');
  try {
    const host = await accountHost(env), session = await currentAccountSession(host, env);
    if (!session) throw new Error('BETA_SIGN_IN_REQUIRED');
    const calendar = flightCalendar(env);
    if (!calendar) throw new Error('BETA_UNAVAILABLE');
    const result = await createBetaAccessStore(await platformStateHost(env), calendar).require({ accountId: session.accountId,
      sessionId: session.sessionId, ...principal ? { principal } : {}, now: Date.now() });
    if (!result.ok) throw new Error(result.code);
    return { accountId: session.accountId, sessionId: session.sessionId };
  } catch (error) {
    if (error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('BETA_UNAVAILABLE');
  }
}

/** Scope propagation covers previews and nested service calls without sharing one request's identity with another. */
export async function withFlightAccess<T>(work: () => Promise<T>): Promise<T> {
  return withBetaIdentity(await requireFlightAccess(), work);
}

