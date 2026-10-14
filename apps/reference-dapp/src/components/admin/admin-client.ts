// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/** BUILD-ADMIN-001: the console's only browser → server calls: same-origin JSON POSTs carrying the session's CSRF token. */
export type AdminResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; code: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

export async function adminPost<T = Record<string, unknown>>(path: string, body: unknown, csrf: string | null = null): Promise<AdminResult<T>> {
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json', ...csrf ? { 'x-flofi-admin-csrf': csrf } : {} }, body: JSON.stringify(body) });
    const value = await response.json() as AdminResult<T>;
    if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value;
    return { ok: false, code: 'ADMIN_RESPONSE_INVALID' };
  } catch (cause) {
    return { ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : 'ADMIN_REQUEST_FAILED' };
  }
}
