// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { publicOrigin } from './deployment';
import { sessionCookieName } from './session-cookie';

/** Ordinary /approve stays unframeable. Only the separate signing route accepts MCP Apps ancestors. */
export const EMBEDDED_APPROVAL_PATH = '/mcp/approve';
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: exact MCP Apps sandbox origins the operator observed for FloFi's own panel
 * (`FLOFI_MCP_FRAME_ANCESTORS`, comma-separated). The MCP Apps specification lets a host serve a view from a per-conversation or a
 * host-derived dedicated origin (`ui.domain`), which a fixed list cannot always name. Only exact `https` origins on the two hosts' sandbox
 * domains are accepted: never a wildcard, path, port, user info or another domain (anything else is ignored), at most 8.
 */
const SANDBOX_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}(?:oaiusercontent\.com|claudemcpcontent\.com)$/;
export function configuredFrameAncestors(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return [...new Set((env.FLOFI_MCP_FRAME_ANCESTORS ?? '').split(',').map(value => value.trim()).filter(value => SANDBOX_ORIGIN.test(value)))].slice(0, 8);
}
/** The exact origins allowed to frame `/mcp/approve` (empty: none). The panel reads the same list for its own fast diagnostic. */
export function approvalFrameAncestorList(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const origin = publicOrigin(env);
  if (!origin) return [];
  const claude = createHash('sha256').update(`${origin}/api/mcp`).digest('hex').slice(0, 32);
  const hosts = ['https://chatgpt.com', 'https://web-sandbox.oaiusercontent.com',
    `https://${claude}.claudemcpcontent.com`, 'https://claude.ai', ...configuredFrameAncestors(env)];
  if (new URL(origin).protocol === 'http:') hosts.push(origin);
  return [...new Set(hosts)];
}
export function approvalFrameAncestors(env: Readonly<Record<string, string | undefined>>): string {
  const hosts = approvalFrameAncestorList(env);
  return hosts.length ? hosts.join(' ') : "'none'";
}

/** Separate host-prefixed cookies preserve Strict first-party sessions. Reads are scoped to the trusted MCP pathname by session-principal. */
export const embeddedWalletCookie = (name: string) => sessionCookieName(`embedded_${name}`, true);
export function walletCookieOptions(secure: boolean, maxAge: number, embedded = false) {
  if (typeof embedded !== 'boolean') throw new Error('WALLET_SESSION_CONTEXT_INVALID');
  if (embedded && !secure) throw new Error('EMBEDDED_WALLET_REQUIRES_HTTPS');
  return { httpOnly: true, sameSite: embedded ? 'none' as const : 'strict' as const, secure,
    path: '/', maxAge, ...embedded ? { partitioned: true } : {} };
}
