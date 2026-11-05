// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: where Flight FloFi's state lives (the deployment's own database and tenant, as every other feature), who the
 * signed-in person is (their FloFi account and its verified addresses), and the campaign clock.
 */
import { createHmac } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { accountHost, currentAccountSession } from '../accounts/account-host';
import { ACCOUNT_SESSION_COOKIE } from '../accounts/account-session';
import { sessionCookieName } from '../server/session-cookie';
import { isHostedDeployment } from '../server/deployment';
import { platformStateHost } from '../server/platform-state-host';
import { normalizeEmail } from './campaign';
import { rateLimitClient } from './rate-limit-client';
import { createFlightStore, type FlightStore } from './store';

type Env = Readonly<Record<string, string | undefined>>;

/** The campaign store, or null when this deployment has no database (the page then says the campaign is unavailable). */
export async function flightStore(env: Env = process.env): Promise<FlightStore | null> {
  if (!env.DATABASE_URL) return null;
  return createFlightStore(await platformStateHost(env));
}

/**
 * The campaign clock: the real time. A MOCKED loopback test server (never a hosted deployment) may set it per browser with the
 * `flofi_flight_clock` cookie, so the browser suites can walk through Final call, Gate closed and Boarding in one run.
 */
export const FLIGHT_CLOCK_COOKIE = 'flofi_flight_clock';
export function flightClockHarness(env: Env = process.env): boolean {
  return env.FLOFI_FLIGHT_CLOCK_HARNESS === 'MOCKED_LOOPBACK_ONLY' && !isHostedDeployment(env);
}
export async function flightNow(env: Env = process.env): Promise<number> {
  if (!flightClockHarness(env)) return Date.now();
  const value = Number((await cookies()).get(FLIGHT_CLOCK_COOKIE)?.value);
  return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}

/** The signed-in FloFi account and the addresses its identities prove (a Privy-verified email, Google's or Apple's email), or null. */
export type FlightPerson = { readonly accountId: string; readonly emails: readonly string[] };
export async function flightPerson(env: Env = process.env): Promise<FlightPerson | null> {
  // No account cookie, no account: answered before the account host (its database pool) is opened.
  const jar = await cookies();
  if (!jar.has(ACCOUNT_SESSION_COOKIE) && !jar.has(sessionCookieName(ACCOUNT_SESSION_COOKIE, true))) return null;
  const host = await accountHost(env).catch(() => null);
  const session = await currentAccountSession(host, env);
  if (!host || !session) return null;
  const view = await host.service.view(session).catch(() => null);
  if (!view) return null;
  // The list's own address rule (`normalizeEmail`), so an address matched or stored here is one the operator can also erase.
  const emails = [...new Set(view.identities.filter(identity => identity.kind === 'email' || identity.kind === 'google' || identity.kind === 'apple')
    .map(identity => normalizeEmail(identity.label)).filter((email): email is string => email !== null))];
  return { accountId: view.accountId, emails };
}

/**
 * A keyed digest of the request's network client (`rateLimitClient`), used only to rate-limit the public list form (the address is
 * never stored). Null when the deployment has no session secret or the platform sends no address: such requests still count toward
 * the deployment-wide limit (`NO_CLIENT`).
 */
export async function clientDigest(env: Env = process.env): Promise<string | null> {
  const secret = env.FLOFI_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const list = await headers();
  const address = list.get('x-real-ip') ?? list.get('x-forwarded-for')?.split(',')[0] ?? '';
  const client = address.length <= 64 ? rateLimitClient(address) : null;
  if (!client) return null;
  const key = createHmac('sha256', secret).update('flofi-flight-client-v1').digest();
  return createHmac('sha256', key).update(client).digest('hex');
}
