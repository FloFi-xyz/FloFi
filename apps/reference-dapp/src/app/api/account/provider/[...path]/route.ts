// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-AUTH-WALLETS-001: same-origin relay for the browser's stamped provider requests (see `accounts/provider-relay.ts`). */
import { accountHost, currentAccountSession } from '../../../../../accounts/account-host';
import { relayDecision } from '../../../../../accounts/provider-relay';

export const dynamic = 'force-dynamic';
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  // Same-origin fetches only (defence in depth: the Lax account cookie and the browser's stamp already rule out cross-site use).
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return json(403, { code: 'PROVIDER_RELAY_CROSS_SITE' });
  let host;
  try { host = await accountHost(); } catch { return json(503, { code: 'ACCOUNTS_UNAVAILABLE' }); }
  if (!host) return json(503, { code: 'ACCOUNTS_NOT_CONFIGURED' });
  const session = await currentAccountSession(host);
  const organization = session ? await host.service.managedContext(session).catch(() => null) : null;
  const body = await request.text().catch(() => ''), stamp = request.headers.get('x-stamp');
  const decision = await relayDecision({ path: (await context.params).path.join('/'), body, stamp, session, organization, provider: host.turnkey,
    store: host.store, now: new Date() }).catch(() => ({ ok: false as const, status: 503, code: 'ACCOUNTS_UNAVAILABLE' }));
  if (!decision.ok) return json(decision.status, { code: decision.code });
  // Byte-for-byte: the provider verifies the browser's stamp over exactly this body. Nothing here is logged or kept.
  const upstream = await fetch(decision.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Stamp': stamp! }, body }).catch(() => null);
  if (!upstream) return json(502, { code: 'MANAGED_PROVIDER_UNAVAILABLE' });
  return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
