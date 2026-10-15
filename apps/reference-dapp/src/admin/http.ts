// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the admin API as plain `Request → Response` handlers (the `app/admin/api/**` route files only delegate here), so the
 * authorization, CSRF and audit rules are tested exactly as served. Every response is JSON, `no-store`, with closed codes only.
 */
import { adminConfig } from './config.ts';
import { adminSessionToken, authenticateAdmin, adminPermits, csrfRefusal, mutationRefusal, cookieValue, type AdminContext, type RequestOrigin } from './guard.ts';
import { adminHost, type AdminHost } from './host.ts';
import { ADMIN_CHALLENGE_COOKIE, ADMIN_CHALLENGE_TTL_SECONDS, ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_SECONDS, adminChallengeMessage,
  issueAdminChallenge, sealAdminSession, verifyAdminSignature } from './session.ts';
import { createAdminStore, type AdminPermission, type AdminStore } from './store.ts';
import { isUniqueViolation } from '@defi-workflow-engine/cloud-runtime';
import { originFromHeaders } from '../server/session-principal.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type AdminHttpOptions = { readonly env?: Env; readonly host?: AdminHost | { readonly code: string }; readonly now?: () => Date };
export type AdminRequestContext = { readonly key: Buffer; readonly host: AdminHost; readonly store: AdminStore; readonly origin: RequestOrigin; readonly now: Date };

const MAX_BODY = 16_384, CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const REFUSED_AUDIT_WINDOW_MS = 600_000, REFUSED_AUDIT_MAX = 200;
export function json(status: number, body: Record<string, unknown>, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
export const codeOf = (error: unknown, fallback: string) => error instanceof Error && CODE.test(error.message) ? error.message : fallback;
function cookie(name: string, value: string, origin: RequestOrigin, maxAge: number): string {
  return `${name}=${value}; Path=${ADMIN_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${origin.secure ? '; Secure' : ''}`;
}
const clear = (name: string, origin: RequestOrigin) => cookie(name, '', origin, 0);

/** Parses a bounded JSON object body; null when absent, oversized or not a plain object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY) return null;
  let text: string;
  try { text = await request.text(); } catch { return null; }
  if (text.length > MAX_BODY) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Configuration, storage and origin for one admin request; a Response when the console is off or unavailable. */
export async function adminRequest(request: Request, options: AdminHttpOptions): Promise<AdminRequestContext | Response> {
  const env = options.env ?? process.env, config = adminConfig(env);
  if (!config.enabled) return json(404, { ok: false, code: 'ROUTE_NOT_FOUND' });
  const host = options.host ?? await adminHost(env);
  if ('code' in host) return json(503, { ok: false, code: host.code });
  return { key: config.key, host, store: createAdminStore(host.db, host.tenantId), origin: originFromHeaders(request.headers), now: (options.now ?? (() => new Date()))() };
}

/** An authenticated, permitted, CSRF-checked mutation; a Response on any refusal. */
export async function adminMutation(request: Request, options: AdminHttpOptions, permission: AdminPermission):
  Promise<{ readonly context: AdminContext; readonly request: AdminRequestContext } | Response> {
  const base = await adminRequest(request, options);
  if (base instanceof Response) return base;
  const shape = mutationRefusal(request, base.origin);
  if (shape) return json(shape === 'METHOD_NOT_ALLOWED' ? 405 : 403, { ok: false, code: shape });
  const context = await authenticateAdmin({ key: base.key, store: base.store, token: adminSessionToken(request), domain: base.origin.domain, now: base.now });
  if (!context) return json(401, { ok: false, code: 'ADMIN_SESSION_REQUIRED' });
  const csrf = csrfRefusal(request, base.key, context);
  if (csrf) return json(403, { ok: false, code: csrf });
  if (!adminPermits(context, permission)) {
    await base.store.audit({ actor: context.principal.principalId, kind: 'ADMIN_PERMISSION_DENIED', outcome: 'REFUSED', code: 'ADMIN_ROLE_INSUFFICIENT',
      target: new URL(request.url).pathname.replace(/[^A-Za-z0-9:._-]/g, ':').slice(0, 120) }).catch(() => undefined);
    return json(403, { ok: false, code: 'ADMIN_ROLE_INSUFFICIENT' });
  }
  return { context, request: base };
}

/** POST /admin/api/session/challenge `{ address, chainId }` → the exact message to sign; the nonce stays in an HttpOnly cookie. */
export async function handleAdminChallenge(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  const base = await adminRequest(request, options);
  if (base instanceof Response) return base;
  const shape = mutationRefusal(request, base.origin);
  if (shape) return json(shape === 'METHOD_NOT_ALLOWED' ? 405 : 403, { ok: false, code: shape });
  const body = await readJsonObject(request);
  const address = typeof body?.address === 'string' ? body.address.toLowerCase() : '', chainId = body?.chainId;
  try {
    const { token } = issueAdminChallenge(base.key, { domain: base.origin.domain, uri: base.origin.uri, now: base.now });
    const message = adminChallengeMessage(base.key, { challengeToken: token, domain: base.origin.domain, uri: base.origin.uri, address, chainId: chainId as number, now: base.now });
    return json(200, { ok: true, message }, [cookie(ADMIN_CHALLENGE_COOKIE, token, base.origin, ADMIN_CHALLENGE_TTL_SECONDS)]);
  } catch (error) { return json(400, { ok: false, code: codeOf(error, 'ADMIN_SIGN_IN_FAILED') }); }
}

/**
 * POST /admin/api/session `{ address, chainId, signature }`: verifies the signature over the sealed challenge (single use: the cookie is
 * cleared whatever the outcome), requires an ACTIVE grant for the recovered wallet, then records a server-side session.
 */
export async function handleAdminSignIn(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  const base = await adminRequest(request, options);
  if (base instanceof Response) return base;
  const shape = mutationRefusal(request, base.origin);
  if (shape) return json(shape === 'METHOD_NOT_ALLOWED' ? 405 : 403, { ok: false, code: shape });
  const clearChallenge = clear(ADMIN_CHALLENGE_COOKIE, base.origin);
  const refuse = async (status: number, code: string) => {
    // Refusals are audited without any address; a flood stops being recorded (it is still refused).
    const recent = await base.store.countAudit('ADMIN_SIGN_IN', new Date(base.now.getTime() - REFUSED_AUDIT_WINDOW_MS)).catch(() => REFUSED_AUDIT_MAX);
    if (recent < REFUSED_AUDIT_MAX) await base.store.audit({ actor: 'anonymous', kind: 'ADMIN_SIGN_IN', outcome: 'REFUSED', code }).catch(() => undefined);
    return json(status, { ok: false, code }, [clearChallenge]);
  };
  const body = await readJsonObject(request);
  let account: string, sessionId: string;
  try {
    ({ account, sessionId } = verifyAdminSignature(base.key, { challengeToken: cookieValue(request.headers.get('cookie'), ADMIN_CHALLENGE_COOKIE), domain: base.origin.domain,
      uri: base.origin.uri, address: typeof body?.address === 'string' ? body.address.toLowerCase() : '', chainId: body?.chainId as number,
      signature: typeof body?.signature === 'string' ? body.signature : '', now: base.now }));
  } catch (error) { return refuse(401, codeOf(error, 'WALLET_SIGNATURE_INVALID')); }
  try {
    const principal = await base.store.activePrincipalByAccount(account);
    if (!principal) return refuse(403, 'ADMIN_NOT_GRANTED');
    const expiresAt = new Date(base.now.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000);
    try { await base.store.createSession({ sessionId, principalId: principal.principalId, createdAt: base.now, expiresAt }); }
    catch (error) { if (isUniqueViolation(error)) return refuse(401, 'ADMIN_SIGN_IN_CHALLENGE_USED'); throw error; }
    await base.store.audit({ actor: principal.principalId, kind: 'ADMIN_SIGN_IN', outcome: 'OK', target: principal.principalId });
    const token = sealAdminSession(base.key, { sessionId, principalId: principal.principalId, domain: base.origin.domain, issuedAt: base.now, expiresAt });
    return json(200, { ok: true, role: principal.role, expiresAt: expiresAt.toISOString() },
      [clearChallenge, cookie(ADMIN_SESSION_COOKIE, token, base.origin, ADMIN_SESSION_TTL_SECONDS)]);
  } catch { return json(503, { ok: false, code: 'ADMIN_STORE_UNAVAILABLE' }, [clearChallenge]); }
}

/** POST /admin/api/session/end: ends the server-side session (any role) and clears the cookie. */
export async function handleAdminSignOut(request: Request, options: AdminHttpOptions = {}): Promise<Response> {
  const allowed = await adminMutation(request, options, 'read');
  if (allowed instanceof Response) return allowed;
  const { context, request: base } = allowed;
  try {
    await base.store.endSession(context.sessionId, 'SIGNED_OUT');
    await base.store.audit({ actor: context.principal.principalId, kind: 'ADMIN_SIGN_OUT', outcome: 'OK', target: context.principal.principalId });
  } catch { return json(503, { ok: false, code: 'ADMIN_STORE_UNAVAILABLE' }); }
  return json(200, { ok: true }, [clear(ADMIN_SESSION_COOKIE, base.origin)]);
}
