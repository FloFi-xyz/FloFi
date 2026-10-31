// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: the same-origin relay for the browser's provider requests.
 *
 * FloFi's pages allow `connect-src 'self'` only, so the browser sends its provider requests here instead of to the provider's API. Each
 * request is already stamped in the browser with the person's own session key over the exact body; the relay forwards the body and
 * stamp byte-for-byte and cannot create or change either (a changed byte invalidates the stamp). Before forwarding, the server requires
 * a verified account session, an allowlisted activity, the signed-in account's own provider organization and — for any export — a
 * recent sign-in and a managed wallet saved to this account. Bodies and responses are never logged or stored; export responses carry
 * only ciphertext encrypted to the provider's export frame.
 */
import { accountWalletId, canonicalAddress, MANAGED_PROVIDER } from './account-model.ts';
import { freshlyAuthenticated, type AccountSessionToken } from './account-session.ts';
import type { AccountStore } from './account-store.ts';
import type { TurnkeyBrowserConfig } from './turnkey-server.ts';

const ALLOWED = new Map<string, string | null>([
  ['submit/create_wallet', 'ACTIVITY_TYPE_CREATE_WALLET'], ['submit/init_import_private_key', 'ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY'],
  ['submit/import_private_key', 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY'], ['submit/export_wallet', 'ACTIVITY_TYPE_EXPORT_WALLET'],
  ['submit/export_wallet_account', 'ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT'], ['submit/export_private_key', 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY'],
  ['query/get_activity', null],
]);
const STAMP = /^[A-Za-z0-9_-]{40,2048}$/, MAX_BODY = 65_536;
export type RelayDecision = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly status: number; readonly code: string };
type Organization = { readonly organizationId: string; readonly userId: string } | null;

/** Decides whether one browser provider request may be forwarded. Pure apart from reading this account's saved wallets. */
export async function relayDecision(input: { readonly path: string; readonly body: string; readonly stamp: string | null; readonly session: AccountSessionToken | null;
  readonly organization: Organization; readonly provider: TurnkeyBrowserConfig | null; readonly store: Pick<AccountStore, 'wallets' | 'managedResource'>; readonly now: Date }): Promise<RelayDecision> {
  const deny = (status: number, code: string): RelayDecision => ({ ok: false, status, code });
  if (!input.provider) return deny(503, 'MANAGED_WALLETS_NOT_CONFIGURED');
  if (!input.session) return deny(401, 'ACCOUNT_SESSION_REQUIRED');
  if (!input.organization) return deny(403, 'MANAGED_SESSION_REQUIRED');
  if (!ALLOWED.has(input.path)) return deny(404, 'PROVIDER_ROUTE_NOT_ALLOWED');
  if (!input.stamp || !STAMP.test(input.stamp)) return deny(400, 'PROVIDER_STAMP_REQUIRED');
  if (input.body.length > MAX_BODY) return deny(413, 'PROVIDER_REQUEST_TOO_LARGE');
  let body: Record<string, unknown>;
  try { body = JSON.parse(input.body) as Record<string, unknown>; } catch { return deny(400, 'PROVIDER_REQUEST_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return deny(400, 'PROVIDER_REQUEST_INVALID');
  // The browser may act only in the signed-in account's own provider organization, with the expected activity type.
  if (body.organizationId !== input.organization.organizationId) return deny(403, 'PROVIDER_ORGANIZATION_MISMATCH');
  const type = ALLOWED.get(input.path);
  if (type && body.type !== type) return deny(400, 'PROVIDER_ACTIVITY_MISMATCH');
  const parameters = body.parameters && typeof body.parameters === 'object' ? body.parameters as Record<string, unknown> : {};
  if (input.path.startsWith('submit/init_import') || input.path === 'submit/import_private_key') {
    if (parameters.userId !== input.organization.userId) return deny(403, 'PROVIDER_USER_MISMATCH');
  }
  if (input.path.startsWith('submit/export_')) {
    // Export: a recent sign-in, and only a managed wallet saved to this account. External wallets never reach this point.
    if (!freshlyAuthenticated(input.session, input.now)) return deny(403, 'ACCOUNT_REAUTHENTICATION_REQUIRED');
    const wallets = (await input.store.wallets(input.session.accountId)).filter(wallet => wallet.provider === MANAGED_PROVIDER && wallet.origin !== 'external');
    let owned = false;
    for (const wallet of wallets) {
      const resource = await input.store.managedResource(input.session.accountId, wallet.ecosystem, wallet.address);
      if (!resource) continue;
      if (input.path === 'submit/export_wallet' && resource.origin === 'generated' && parameters.walletId === resource.resource) owned = true;
      if (input.path === 'submit/export_private_key' && resource.origin === 'imported' && parameters.privateKeyId === resource.resource) owned = true;
      if (input.path === 'submit/export_wallet_account' && resource.origin === 'generated'
        && accountWalletId(wallet.ecosystem, canonicalAddress(wallet.ecosystem, parameters.address) ?? '') === wallet.id) owned = true;
    }
    if (!owned) return deny(403, 'EXPORT_NOT_SUPPORTED');
  }
  return { ok: true, url: `${input.provider.apiBaseUrl}/public/v1/${input.path}` };
}
