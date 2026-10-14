// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the one administrative authorization boundary, shared by every console page and admin API.
 *
 *   authentication  the sealed `/admin` cookie (admin key, this host) → the server-side session row (not ended, not expired) → its
 *                   ACTIVE principal. The role is read from the database on every request; nothing about authority lives in the cookie.
 *   authorization   VIEWER reads; OPERATOR also changes runtime settings. Grants are managed only by the operator CLI.
 *   mutations       POST + application/json + an Origin equal to this origin + no cross-site fetch metadata + the session's CSRF token.
 */
import { ADMIN_CSRF_HEADER, ADMIN_SESSION_COOKIE, adminCsrfToken, adminCsrfValid, readAdminSession } from './session.ts';
import { permits, type AdminPermission, type AdminPrincipal, type AdminStore } from './store.ts';

export type AdminContext = { readonly principal: AdminPrincipal; readonly sessionId: string; readonly expiresAt: Date; readonly csrf: string };
export type RequestOrigin = { readonly domain: string; readonly uri: string; readonly secure: boolean };

export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The administrator behind a sealed session reference, or null. Any storage failure is a refusal, never a pass. */
export async function authenticateAdmin(input: { readonly key: Buffer; readonly store: Pick<AdminStore, 'readSession'>; readonly token: string | undefined;
  readonly domain: string; readonly now: Date }): Promise<AdminContext | null> {
  const reference = readAdminSession(input.key, input.token, input.now, input.domain);
  if (!reference) return null;
  let row;
  try { row = await input.store.readSession(reference.sessionId, reference.principalId, input.now); } catch { return null; }
  if (!row || row.principal.principalId !== reference.principalId) return null;
  return { principal: row.principal, sessionId: row.sessionId, expiresAt: row.expiresAt, csrf: adminCsrfToken(input.key, row.sessionId) };
}

export function adminPermits(context: AdminContext, permission: AdminPermission): boolean { return permits(context.principal.role, permission); }

/** Origin and request-shape checks for every state-changing admin request; null when acceptable. */
export function mutationRefusal(request: Request, origin: RequestOrigin): string | null {
  if (request.method !== 'POST') return 'METHOD_NOT_ALLOWED';
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return 'ADMIN_CONTENT_TYPE_INVALID';
  if (request.headers.get('origin') !== origin.uri) return 'ADMIN_ORIGIN_INVALID';
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'ADMIN_ORIGIN_INVALID';
  return null;
}
export function csrfRefusal(request: Request, key: Buffer, context: AdminContext): string | null {
  return adminCsrfValid(key, context.sessionId, request.headers.get(ADMIN_CSRF_HEADER)) ? null : 'ADMIN_CSRF_INVALID';
}
export const adminSessionToken = (request: Request) => cookieValue(request.headers.get('cookie'), ADMIN_SESSION_COOKIE);
