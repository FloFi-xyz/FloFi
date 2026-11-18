// SPDX-License-Identifier: AGPL-3.0-only
import { withFlightAccess } from '../../../../server/flight-access';
import { historyPrincipals } from '../../../../server/history-principals';
import { activityAccount, readWalletActivity } from '../../../../server/wallet-activity';

/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (History): one page of a wallet's received and sent token movements, read-only, as a GET Route
 * Handler — fetched beside the execution history (`/api/dashboard/history`) and never queued behind the page's Server Actions, so a slow or
 * failing activity provider never delays FloFi's own History.
 *
 * The same boundary as the history reads: the Flight boundary (`withFlightAccess`), a same-origin browser fetch, the wallet in the
 * `x-flofi-account` header and its continuation in `x-flofi-cursor` (never in the URL or access logs), and only a wallet this browser proved or the signed-in account holds
 * (`historyPrincipals`) — chain data is public, but FloFi reads it only for its owner. Nothing here signs, submits or persists. Never cached
 * by the browser; the server keeps a short per-wallet cache and joins concurrent reads (`server/wallet-activity.ts`).
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const refuse = (code: string, status: number) => Response.json({ ok: false, code }, { status, headers: NO_STORE });
export async function GET(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return refuse('ACTIVITY_CROSS_ORIGIN_REFUSED', 403);
  // The wallet and the (wallet-bound, server-authenticated) continuation travel in headers: nothing about the wallet is in the URL or access logs.
  const query = new URL(request.url).searchParams, cursor = request.headers.get('x-flofi-cursor');
  let account: ReturnType<typeof activityAccount>;
  try { account = activityAccount(request.headers.get('x-flofi-account') ?? ''); } catch { return refuse('ACTIVITY_REQUEST_INVALID', 400); }
  if ([...query.keys()].length > 0 || (cursor !== null && !/^[A-Za-z0-9_.-]{1,4096}$/.test(cursor))) return refuse('ACTIVITY_REQUEST_INVALID', 400);
  try {
    const value = await withFlightAccess(async () => {
      const namespace = account.ecosystem === 'evm' ? 'eip155' : 'solana';
      const allowed = (await historyPrincipals().catch(() => [])).some(p => p.namespace === namespace && p.address === account.address);
      if (!allowed) throw new Error('ACTIVITY_SIGN_IN_REQUIRED');
      return readWalletActivity({ account: account.address, cursor });
    });
    return Response.json({ ok: true, value }, { headers: NO_STORE });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'ACTIVITY_SIGN_IN_REQUIRED') return refuse(code, 403);
    if (code === 'ACTIVITY_CURSOR_INVALID') return refuse(code, 400);
    if (code === 'ACTIVITY_RATE_LIMITED') return refuse(code, 429);
    return /^BETA_[A-Z_]+$/.test(code) ? refuse(code, 403) : refuse('ACTIVITY_READ_UNAVAILABLE', 500);
  }
}
