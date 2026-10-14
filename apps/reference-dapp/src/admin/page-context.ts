// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the guard every console page calls first (server components only). The console is off → 404; storage missing →
 * an explicit unavailable state; no live admin session → the sign-in page. Layouts are not trusted to guard: each page calls this.
 */
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminConfig } from './config.ts';
import { authenticateAdmin, type AdminContext } from './guard.ts';
import { adminHost, type AdminHost } from './host.ts';
import { ADMIN_SESSION_COOKIE } from './session.ts';
import { createAdminStore, type AdminStore } from './store.ts';
import { requestOrigin } from '../server/session-principal.ts';

export type AdminPage = { readonly ok: true; readonly context: AdminContext; readonly host: AdminHost; readonly store: AdminStore; readonly now: Date }
  | { readonly ok: false; readonly code: string };

export async function adminPage(): Promise<AdminPage> {
  const config = adminConfig(process.env);
  if (!config.enabled) notFound();
  const host = await adminHost(process.env);
  if ('code' in host) return { ok: false, code: host.code };
  const store = createAdminStore(host.db, host.tenantId), now = new Date(), origin = await requestOrigin();
  const context = await authenticateAdmin({ key: config.key, store, token: (await cookies()).get(ADMIN_SESSION_COOKIE)?.value, domain: origin.domain, now });
  if (!context) redirect('/admin/login');
  return { ok: true, context, host, store, now };
}

/** The sign-in page's view: whether the console can accept a sign-in, and whether this browser already holds a live session. */
export async function adminSignInState(): Promise<{ readonly available: true; readonly signedIn: boolean } | { readonly available: false; readonly code: string }> {
  const config = adminConfig(process.env);
  if (!config.enabled) notFound();
  const host = await adminHost(process.env);
  if ('code' in host) return { available: false, code: host.code };
  const origin = await requestOrigin();
  const context = await authenticateAdmin({ key: config.key, store: createAdminStore(host.db, host.tenantId), token: (await cookies()).get(ADMIN_SESSION_COOKIE)?.value,
    domain: origin.domain, now: new Date() });
  return { available: true, signedIn: context !== null };
}
