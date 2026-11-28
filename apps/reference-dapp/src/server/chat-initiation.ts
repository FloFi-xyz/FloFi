// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1): the web Chat's initiation reference — the trusted, server-held signal that separates an
 * execution the Chat started (`web_chat`) from one the Editor started (`web_editor`). Chat and the Editor are the same /app page and call the same
 * server actions, so no request path or client label can tell them apart; this reference can only come from this server.
 *
 *   issued     by the Chat's own server action (`app/chat-initiation-action.ts`) to the FloFi account signed in on that request, for
 *              CHAT_INITIATION_SECONDS: an HMAC-SHA256 (key derived for this purpose only from the deployment's session secret, the same root as the
 *              conversation scope) over a keyed digest of the tenant and account (never the account id, a wallet address or an email in clear),
 *              the issue and expiry instants and a random nonce
 *   presented  by the browser while the Chat's own Review runs (`domain/chat-initiation.ts`, a cookie scoped to /app)
 *   verified   on the server for every creating call, against the FloFi account session of THAT request: a valid MAC, this tenant and account,
 *              not expired, not issued in the future, a lifetime no longer than the policy. Anything else — no reference, a forged, altered,
 *              expired or another account's reference, no account session, a key that cannot be derived — is the Editor (fail closed: an
 *              unverifiable reference never yields `web_chat`, and never fails the financial call).
 *
 * What it proves: this server issued it, recently, to the account that now creates the run, and the browser presented it for the Chat's Review.
 * It cannot prove which button a person pressed (no server-side signal can); it authorizes nothing and is never logged.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { CHAT_INITIATION_FORMAT } from '../domain/chat-initiation.ts';
import { walletSessionKey } from './wallet-session.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** Lifetime of one reference. The Chat refreshes it in the background long before it ends. */
export const CHAT_INITIATION_SECONDS = 900;
/** Clock tolerance for a reference issued by another instance whose clock runs slightly ahead. */
const SKEW_SECONDS = 30;
const PREFIX = 'ci1';

/** The purpose-bound key (HKDF of the deployment's session key; throws where that secret is not configured, like the session itself). */
export const chatInitiationKey = (env: Env): Buffer => Buffer.from(hkdfSync('sha256', walletSessionKey(env), 'flofi', 'flofi/chat-initiation/v1', 32));
/** The keyed digest binding a reference to one tenant and FloFi account (identifies nobody without the server's key). */
const accountBinding = (key: Uint8Array, tenantId: string, accountId: string) =>
  createHmac('sha256', key).update(`flofi.chat-initiation.account.v1\0${tenantId}\0${accountId}`).digest('base64url').slice(0, 32);
const mac = (key: Uint8Array, body: string) => createHmac('sha256', key).update(`${PREFIX}.${body}`).digest('base64url');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export type ChatInitiation = { readonly reference: string; readonly expiresAt: number };
/** A new reference for this tenant and account (`expiresAt`: epoch milliseconds). */
export function issueChatInitiation(key: Uint8Array, tenantId: string, accountId: string, now = new Date(), seconds = CHAT_INITIATION_SECONDS): ChatInitiation {
  if (!tenantId || !accountId || !Number.isInteger(seconds) || seconds < 1 || seconds > CHAT_INITIATION_SECONDS) throw new Error('CHAT_INITIATION_INVALID');
  const issued = Math.floor(now.getTime() / 1000), expires = issued + seconds;
  const body = Buffer.from(JSON.stringify({ a: accountBinding(key, tenantId, accountId), i: issued, e: expires, n: randomBytes(16).toString('base64url') })).toString('base64url');
  return { reference: `${PREFIX}.${body}.${mac(key, body)}`, expiresAt: expires * 1000 };
}

/** Whether `reference` is a genuine, current reference of this tenant and account. Total: never throws, false on any doubt. */
export function verifyChatInitiation(key: Uint8Array, reference: unknown, tenantId: string, accountId: string, now = new Date()): boolean {
  try {
    if (typeof reference !== 'string' || !CHAT_INITIATION_FORMAT.test(reference) || !tenantId || !accountId) return false;
    const [, body, signature] = reference.split('.') as [string, string, string];
    if (!same(signature, mac(key, body))) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { a?: unknown; i?: unknown; e?: unknown; n?: unknown };
    if (!payload || typeof payload !== 'object' || Object.keys(payload).sort().join() !== 'a,e,i,n') return false;
    const { a, i, e } = payload, at = Math.floor(now.getTime() / 1000);
    if (typeof a !== 'string' || !Number.isSafeInteger(i) || !Number.isSafeInteger(e)) return false;
    const issued = i as number, expires = e as number;
    if (expires <= issued || expires - issued > CHAT_INITIATION_SECONDS || issued > at + SKEW_SECONDS || expires <= at) return false;
    return same(a, accountBinding(key, tenantId, accountId));
  } catch { return false; }
}

/**
 * The web surface of the server action being served: `WEB_CHAT` only for a reference this server issued to the FloFi account signed in on this
 * request (its verified, unrevoked session), `WEB_EDITOR` otherwise. Reads the request's cookies; outside a request it is the Editor.
 */
export async function verifiedWebSurface(reference: string | null | undefined, env: Env = process.env): Promise<'WEB_CHAT' | 'WEB_EDITOR'> {
  if (typeof reference !== 'string' || !CHAT_INITIATION_FORMAT.test(reference)) return 'WEB_EDITOR';
  try {
    const [{ accountHost, currentAccountSession }, { platformStateHost }] = await Promise.all([import('../accounts/account-host.ts'), import('./platform-state-host.ts')]);
    const session = await currentAccountSession(await accountHost(env), env);
    if (!session) return 'WEB_EDITOR';
    const { tenantId } = await platformStateHost(env);
    return verifyChatInitiation(chatInitiationKey(env), reference, tenantId, session.accountId) ? 'WEB_CHAT' : 'WEB_EDITOR';
  } catch { return 'WEB_EDITOR'; }
}
/** The same, reading the reference from this request's own cookie. */
export async function requestWebSurface(env: Env = process.env): Promise<'WEB_CHAT' | 'WEB_EDITOR'> {
  try {
    const [{ cookies }, { CHAT_INITIATION_COOKIE }] = await Promise.all([import('next/headers'), import('../domain/chat-initiation.ts')]);
    return await verifiedWebSurface((await cookies()).get(CHAT_INITIATION_COOKIE)?.value, env);
  } catch { return 'WEB_EDITOR'; }
}
