// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: who may read and manage FloFi's own history records (execution runs, saved workflows) for a wallet.
 *
 * A person who is signed in should see their own history without proving the same wallet again: signed in → history available. The authority
 * is still server-side and per request, never an address the browser sends:
 *   - a wallet proven in this browser (the HttpOnly wallet sessions, `currentWalletPrincipals`), as before; and
 *   - the wallets of the verified FloFi account session (unrevoked, unexpired server record): the embedded wallets the provider listed for the
 *     account, its legacy FloFi Wallet records, external wallets linked with a fresh FloFi wallet proof, and the wallets it signs in with.
 *     Each address belongs to at most one account per tenant, and the list is read from the database on every request (a removed wallet or a
 *     revoked session stops at once).
 * The browser's address remains an expected-wallet guard only. A wallet that is neither proven here nor held by the signed-in account still
 * needs its own proof, so another person's history is never reachable. Account wallets never apply inside the embedded approval route, whose
 * wallet authority stays isolated. Used for history records and the workflow library; the Copilot's per-wallet memory uses `memoryPrincipals`
 * (one unambiguous wallet per ecosystem). Automations, delegation, approvals and signing keep their own proofs.
 */
import { headers } from 'next/headers';
import { accountHost, currentAccountSession, type AccountHost } from '../accounts/account-host.ts';
import { EMBEDDED_APPROVAL_PATH } from './embedded-approval.ts';
import { currentWalletPrincipals, type WalletPrincipal } from './session-principal.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type HistoryPrincipalSeams = { readonly proven?: () => Promise<readonly WalletPrincipal[]>; readonly account?: () => Promise<readonly WalletPrincipal[]> };

/** The wallets held by this request's verified FloFi account session; empty without an account, a database or inside embedded approval. */
export async function accountWalletPrincipals(env: Env = process.env, seams: { host?: AccountHost | null; embedded?: boolean } = {}): Promise<readonly WalletPrincipal[]> {
  const embedded = seams.embedded ?? (await headers()).get('x-flofi-pathname') === EMBEDDED_APPROVAL_PATH;
  if (embedded) return [];
  const host = seams.host !== undefined ? seams.host : await accountHost(env);
  if (!host) return [];
  const session = await currentAccountSession(host, env);
  if (!session) return [];
  return host.store.walletAddresses(session.accountId);
}

/** Wallets whose FloFi history this request may read and manage: proven in this browser, or held by the signed-in account. */
export async function historyPrincipals(seams: HistoryPrincipalSeams = {}): Promise<readonly WalletPrincipal[]> {
  const [proven, account] = await Promise.all([(seams.proven ?? currentWalletPrincipals)().catch(() => []),
    (seams.account ?? (() => accountWalletPrincipals()))().catch(() => [])]);
  const seen = new Set<string>(), all: WalletPrincipal[] = [];
  for (const principal of [...proven, ...account]) {
    const key = `${principal.namespace}:${principal.address}`;
    if (!seen.has(key)) { seen.add(key); all.push(principal); }
  }
  return all;
}

/**
 * The wallets whose Copilot memory this request may use: at most one per ecosystem, never a guess. A wallet proven in this browser wins (one
 * session per ecosystem); otherwise the signed-in account's wallet of that ecosystem, only when the account holds exactly one there. With
 * several account wallets and none proven, that ecosystem has no memory identity until the person proves the wallet they use.
 */
export async function memoryPrincipals(seams: HistoryPrincipalSeams = {}): Promise<readonly WalletPrincipal[]> {
  const [proven, account] = await Promise.all([(seams.proven ?? currentWalletPrincipals)().catch(() => []),
    (seams.account ?? (() => accountWalletPrincipals()))().catch(() => [])]);
  return (['eip155', 'solana'] as const).flatMap(namespace => {
    const here = proven.find(principal => principal.namespace === namespace);
    if (here) return [here];
    const held = account.filter(principal => principal.namespace === namespace);
    return held.length === 1 ? [held[0]!] : [];
  });
}
