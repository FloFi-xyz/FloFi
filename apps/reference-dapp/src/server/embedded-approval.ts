// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { publicOrigin } from './deployment';
import { sessionCookieName } from './session-cookie';

/** Ordinary /approve stays unframeable. Only the separate signing route accepts MCP Apps ancestors. */
export const EMBEDDED_APPROVAL_PATH = '/mcp/approve';
export function approvalFrameAncestors(env: Readonly<Record<string, string | undefined>>): string {
  const origin = publicOrigin(env);
  if (!origin) return "'none'";
  const claude = createHash('sha256').update(`${origin}/api/mcp`).digest('hex').slice(0, 32);
  const hosts = ['https://chatgpt.com', 'https://web-sandbox.oaiusercontent.com',
    `https://${claude}.claudemcpcontent.com`, 'https://claude.ai'];
  if (new URL(origin).protocol === 'http:') hosts.push(origin);
  return hosts.join(' ');
}

/** Separate host-prefixed cookies preserve Strict first-party sessions. Reads are scoped to the trusted MCP pathname by session-principal. */
export const embeddedWalletCookie = (name: string) => sessionCookieName(`embedded_${name}`, true);
export function walletCookieOptions(secure: boolean, maxAge: number, embedded = false) {
  if (typeof embedded !== 'boolean') throw new Error('WALLET_SESSION_CONTEXT_INVALID');
  if (embedded && !secure) throw new Error('EMBEDDED_WALLET_REQUIRES_HTTPS');
  return { httpOnly: true, sameSite: embedded ? 'none' as const : 'strict' as const, secure,
    path: '/', maxAge, ...embedded ? { partitioned: true } : {} };
}
