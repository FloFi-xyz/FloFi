// SPDX-License-Identifier: AGPL-3.0-only
import { withFlightAccess } from '../../../../server/flight-access';
import { automationAvailability, automationOperation } from '../../../../server/automation-operation';
import type { OverviewView } from '../../../../automations/views';

/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (Automations loading): the Automations workspace's two reads — whether this deployment serves
 * automations and the owner's overview — as ONE GET Route Handler that runs them in parallel. They were two Server Actions called one after the
 * other, and Next.js dispatches a page's Server Actions one at a time, so "Loading automations…" lasted for every action already queued on the
 * page plus both reads in turn (the pattern the Dashboard history reads already left, `/api/dashboard/history`).
 *
 * The same boundary and reads as the actions it replaces for reading: the Flight boundary (`withFlightAccess`), `automationAvailability()` and
 * the owner-scoped `automationOperation('overview')`, which re-verifies the owner server-side (proven in this browser or held by the signed-in
 * account) — the header is only a selection hint. A same-origin browser fetch only; never cached. Every mutation stays a Server Action.
 * `scope=overview` (background refreshes) skips the availability read.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const EVM = /^0x[0-9a-fA-F]{40}$/, SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const refuse = (code: string, status: number) => Response.json({ ok: false, code }, { status, headers: NO_STORE });
export type AutomationSnapshot = {
  readonly availability: { readonly enabled: boolean; readonly code: string | null } | null;
  readonly overview: { readonly ok: true; readonly value: OverviewView } | { readonly ok: false; readonly code: string } | null;
};
export async function GET(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return refuse('AUTOMATION_CROSS_ORIGIN_REFUSED', 403);
  const query = new URL(request.url).searchParams, scope = query.get('scope') ?? 'all', account = request.headers.get('x-flofi-account');
  if ([...query.keys()].some(key => key !== 'scope') || !['all', 'overview'].includes(scope) || account !== null && !EVM.test(account) && !SOLANA.test(account)
    || scope === 'overview' && account === null) return refuse('AUTOMATION_REQUEST_INVALID', 400);
  const owner = account === null ? null : EVM.test(account) ? { namespace: 'eip155' as const, address: account.toLowerCase() } : { namespace: 'solana' as const, address: account };
  try {
    const value = await withFlightAccess<AutomationSnapshot>(async () => {
      const [availability, overview] = await Promise.all([scope === 'all' ? automationAvailability() : Promise.resolve(null),
        owner ? automationOperation<OverviewView>('overview', [], owner) : Promise.resolve(null)]);
      return { availability, overview };
    });
    return Response.json({ ok: true, value }, { headers: NO_STORE });
  } catch (error) {
    return error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message) ? refuse(error.message, 403) : refuse('AUTOMATION_UNAVAILABLE', 500);
  }
}
