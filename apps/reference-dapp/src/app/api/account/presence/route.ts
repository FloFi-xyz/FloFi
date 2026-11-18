// SPDX-License-Identifier: AGPL-3.0-only
import { accountHost, currentAccountSession } from '../../../../accounts/account-host';

/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (My Account): the Settings menu's account presence — whether this deployment offers accounts and
 * whether this browser holds a valid FloFi session — as a GET Route Handler, exactly what the `accountPresence()` Server Action answers (one
 * verified-session read, no account data). As an action it waited in the page's Server Action queue (Next.js dispatches them one at a time per
 * client), so the menu's My Account row stayed a placeholder behind every action already in flight. A same-origin browser fetch only; never
 * cached; a failed read answers 500 and the menu keeps its placeholder or its fallback, never "signed in".
 */
export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
export async function GET(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return Response.json({ ok: false, code: 'ACCOUNT_CROSS_ORIGIN_REFUSED' }, { status: 403, headers: NO_STORE });
  if (new URL(request.url).search) return Response.json({ ok: false, code: 'ACCOUNT_REQUEST_INVALID' }, { status: 400, headers: NO_STORE });
  try {
    const host = await accountHost();
    const value = host ? { accounts: true, signedIn: await currentAccountSession(host) !== null } : { accounts: false, signedIn: false };
    return Response.json({ ok: true, value }, { headers: NO_STORE });
  } catch { return Response.json({ ok: false, code: 'ACCOUNTS_UNAVAILABLE' }, { status: 500, headers: NO_STORE }); }
}
