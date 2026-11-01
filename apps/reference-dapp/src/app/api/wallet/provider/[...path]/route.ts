// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet's relay for its stamped provider requests (see `accounts/wallet-relay.ts`). Wallet origin only.
 * Legacy and export-only since BUILD-FLOFI-PRIVY-UX-001: it relays the export of wallets created in FloFi Wallet before Privy, nothing else.
 */
import { currentWalletSession, sameWalletOrigin, walletHost, walletJson } from '../../../../../accounts/wallet-host';
import { walletRelayDecision } from '../../../../../accounts/wallet-relay';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const host = await walletHost().catch(() => null);
  if (!host) return walletJson(503, { code: 'MANAGED_WALLETS_NOT_CONFIGURED' });
  if (!sameWalletOrigin(request, host.origin)) return walletJson(403, { code: 'WALLET_CROSS_ORIGIN' });
  const session = await currentWalletSession(host);
  const body = await request.text().catch(() => ''), stamp = request.headers.get('x-stamp');
  const context_ = session ? await host.service.context(session).catch(() => null) : null;
  const organization = context_?.organization ? { organizationId: context_.organization.organizationId, userId: context_.organization.userId } : null;
  const decision = await walletRelayDecision({ path: (await context.params).path.join('/'), body, stamp, session, organization,
    apiBaseUrl: host.turnkey.apiBaseUrl, wallets: async () => context_?.wallets ?? [],
    managedResource: wallet => host.account.store.managedResource(session!.account.accountId, wallet.ecosystem, wallet.address), now: new Date() })
    .catch(() => ({ ok: false as const, status: 503, code: 'ACCOUNTS_UNAVAILABLE' }));
  if (!decision.ok) return walletJson(decision.status, { code: decision.code });
  // Byte-for-byte: the provider verifies the wallet page's stamp over exactly this body. Nothing here is logged or kept.
  const upstream = await fetch(decision.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Stamp': stamp! }, body }).catch(() => null);
  if (!upstream) return walletJson(502, { code: 'MANAGED_PROVIDER_UNAVAILABLE' });
  return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
