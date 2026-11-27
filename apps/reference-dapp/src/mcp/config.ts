// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the MCP gateway's own security boundary — enablement, client credentials and the principal.
 *
 *   FLOFI_MCP=enabled                       explicit opt-in; anything else and the endpoint answers 404 MCP_NOT_ENABLED
 *   FLOFI_MCP_CLIENTS=[{"principal":"dev-alice","tokenSha256":"<64 hex>","wallets":["0x…"]}]
 *                                           SHA-256 digests of high-entropy bearer tokens (the tokens themselves are never
 *                                           stored server-side); `wallets` are the EVM accounts whose runs this credential
 *                                           may read through get_execution_status / get_evidence (owner-granted, optional)
 *   FLOFI_MCP_ALLOWED_ORIGINS=https://…     optional browser origins; any other Origin header is refused (DNS rebinding)
 *
 * This credential is NOT `API_AUTH_TOKEN` (the internal BFF→API bearer): a configured digest equal to its digest is a
 * configuration error, and the gateway never forwards an MCP credential anywhere. It authenticates a developer/partner
 * integration, never a wallet: it grants no financial authority and no wallet session. Any configuration error disables the
 * endpoint (fail closed).
 *
 * BUILD-MCP-002: consumer clients authenticate with OAuth (`FLOFI_MCP_OAUTH=enabled`, `oauth/`), which yields an `mcp-oauth`
 * principal: a pseudonymous FloFi account with scopes. With OAuth enabled `FLOFI_MCP_CLIENTS` becomes optional, and a production
 * deployment refuses static credentials altogether (they remain a development and Preview path).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { deploymentEnvironment, deploymentTenant } from '../server/deployment.ts';
import type { McpScope } from './oauth/config.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** A static developer/partner credential: operator-granted read wallets, no account, so no approval handoffs. */
export type McpCredentialPrincipal = { readonly kind: 'mcp-credential'; readonly id: string; readonly tenantId: string; readonly wallets: readonly string[] };
/** A wallet a principal may read as, with its namespace (automations are owned per wallet: `{namespace, address}`). */
export type McpWalletOwner = { readonly namespace: 'eip155' | 'solana'; readonly address: string };
/**
 * BUILD-MCP-002: an OAuth-connected client acting for a pseudonymous FloFi account. `id` is the grant; `wallets` are the wallets
 * the account linked on FloFi (filled only for `flofi.runs` reads), and `owners` the same links with their namespace. Neither the
 * account nor a link is wallet ownership.
 */
export type McpOAuthPrincipal = { readonly kind: 'mcp-oauth'; readonly id: string; readonly tenantId: string; readonly accountId: string; readonly clientId: string;
  readonly clientName: string; readonly scopes: readonly McpScope[]; readonly wallets: readonly string[]; readonly owners?: readonly McpWalletOwner[];
  /**
   * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: the linked wallets whose owner agreed to balance and position reads — links made on `/connections` at or after
   * FLOFI_MCP_PORTFOLIO_LINKS_FROM, when that page discloses those reads (`portfolioLinksFrom`). Absent or empty: no portfolio read for anyone.
   */
  readonly portfolioOwners?: readonly McpWalletOwner[];
  /**
   * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P0): whether this deployment reads balances and positions at all (`portfolioConsent`), so an
   * unreadable wallet says why: a deployment that reads none is never answered with "link the wallet again" (relinking cannot change it).
   */
  readonly portfolioReads?: PortfolioConsent };
export type McpPrincipal = McpCredentialPrincipal | McpOAuthPrincipal;
/**
 * The wallets a principal may read owner-scoped records as, namespace included: an OAuth account's linked wallets (EVM or Solana, filled by the
 * gateway for `flofi.runs`), or a static credential's operator-granted wallets (EVM only, `WALLET`). Never an address from a request.
 */
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: links made before `/connections` disclosed balance and position reads were consented for run status and
 * evidence only, so portfolio reads use links created at or after FLOFI_MCP_PORTFOLIO_LINKS_FROM (an ISO-8601 instant the operator sets once the
 * deployment showing the new consent text is live). Unset or invalid: fail closed — no link qualifies and get_portfolio is unavailable.
 */
export function portfolioLinksFrom(env: Env): Date | null {
  const raw = env.FLOFI_MCP_PORTFOLIO_LINKS_FROM?.trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(raw)) return null;
  const at = new Date(raw);
  // A calendar date that does not exist (2026-11-31) is invalid, never rolled forward into another day.
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== raw.slice(0, 10) ? null : at;
}
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P0, flofi-data-privacy review): no link made before FloFi's Connections page disclosed balance and
 * position reads can carry that consent. The disclosure was introduced by e470945 (PR #248) and went live in production with deployment
 * dpl_F4z2qXAHRrAt2VABL9K6hmwWtWzy (READY 2026-11-24T04:39:34Z); this floor rounds that up. A configured FLOFI_MCP_PORTFOLIO_LINKS_FROM earlier than it
 * would backdate consent, so it reads nothing (NOT_ENABLED) instead of widening access. Later is always allowed.
 */
export const PORTFOLIO_DISCLOSURE_LIVE_FROM = '2026-11-24T04:40:00Z';
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P0): the deployment's portfolio consent state at `now`.
 *   ENABLED            links made at or after `since` may be read (a link made before it is re-linked on `/connections` to renew consent)
 *   NOT_ENABLED        FLOFI_MCP_PORTFOLIO_LINKS_FROM is unset or invalid: no link qualifies, and re-linking cannot change that (an operator setting)
 *   NOT_YET_EFFECTIVE  the instant is still in the future: no link made before it ever qualifies, so a link qualifies only once made after it
 * Fail closed in every case but ENABLED; consent is never backdated, inferred or represented as a zero balance.
 */
export type PortfolioConsent =
  | { readonly status: 'ENABLED'; readonly since: string }
  | { readonly status: 'NOT_ENABLED'; readonly cause: 'UNSET_OR_INVALID' | 'BEFORE_DISCLOSURE' }
  | { readonly status: 'NOT_YET_EFFECTIVE'; readonly since: string };
export function portfolioConsent(env: Env, now: Date): PortfolioConsent {
  const from = portfolioLinksFrom(env);
  if (!from) return { status: 'NOT_ENABLED', cause: 'UNSET_OR_INVALID' };
  if (from.getTime() < Date.parse(PORTFOLIO_DISCLOSURE_LIVE_FROM)) return { status: 'NOT_ENABLED', cause: 'BEFORE_DISCLOSURE' };
  return from.getTime() > now.getTime() ? { status: 'NOT_YET_EFFECTIVE', since: from.toISOString() } : { status: 'ENABLED', since: from.toISOString() };
}
export const principalOwners = (principal: McpPrincipal): readonly McpWalletOwner[] => principal.kind === 'mcp-oauth' ? principal.owners ?? []
  : principal.wallets.map(address => ({ namespace: 'eip155' as const, address }));
/** What a static credential may call: everything read-only of BUILD-MCP-001, never an approval request (it has no account). */
export const CREDENTIAL_SCOPES: readonly McpScope[] = Object.freeze(['flofi.strategy', 'flofi.runs']);
export const principalScopes = (principal: McpPrincipal): readonly McpScope[] => principal.kind === 'mcp-oauth' ? principal.scopes : CREDENTIAL_SCOPES;
type Client = { readonly id: string; readonly digest: Buffer; readonly wallets: readonly string[] };
export type McpConfig =
  | { readonly enabled: true; readonly tenantId: string; readonly clients: readonly Client[]; readonly allowedOrigins: readonly string[] }
  | { readonly enabled: false; readonly code: 'MCP_NOT_ENABLED' | 'MCP_CONFIGURATION_INVALID' };

const PRINCIPAL = /^[a-z0-9][a-z0-9_-]{2,63}$/, DIGEST = /^[0-9a-f]{64}$/, WALLET = /^0x[0-9a-f]{40}$/;
/** A presented token: 32–512 URL/base64 characters. Shorter tokens never authenticate, whatever is configured. */
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,512}$/;
const MAX_CLIENTS = 32, MAX_WALLETS = 16;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const invalid = { enabled: false, code: 'MCP_CONFIGURATION_INVALID' } as const;

export function readMcpConfig(env: Env): McpConfig {
  if (env.FLOFI_MCP !== 'enabled') return { enabled: false, code: 'MCP_NOT_ENABLED' };
  let tenantId: string;
  try { tenantId = deploymentTenant(env); } catch { return invalid; }
  const oauth = env.FLOFI_MCP_OAUTH === 'enabled', configured = (env.FLOFI_MCP_CLIENTS ?? '').trim() !== '';
  // Consumer production traffic authenticates with OAuth only; static credentials are a development and Preview path.
  if (configured && deploymentEnvironment(env) === 'production') return invalid;
  let parsed: unknown;
  if (!configured && oauth) parsed = [];
  else try { parsed = JSON.parse(env.FLOFI_MCP_CLIENTS ?? ''); } catch { return invalid; }
  if (!Array.isArray(parsed) || parsed.length < (oauth ? 0 : 1) || parsed.length > MAX_CLIENTS) return invalid;
  const internal = env.API_AUTH_TOKEN ? sha256(env.API_AUTH_TOKEN) : null, clients: Client[] = [];
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid;
    const entry = item as Record<string, unknown>, keys = Object.keys(entry);
    if (keys.some(k => !['principal', 'tokenSha256', 'wallets'].includes(k)) || typeof entry.principal !== 'string' || !PRINCIPAL.test(entry.principal) ||
        typeof entry.tokenSha256 !== 'string' || !DIGEST.test(entry.tokenSha256)) return invalid;
    const wallets = entry.wallets ?? [];
    if (!Array.isArray(wallets) || wallets.length > MAX_WALLETS || !wallets.every(w => typeof w === 'string' && WALLET.test(w)) || new Set(wallets).size !== wallets.length) return invalid;
    const digest = Buffer.from(entry.tokenSha256, 'hex');
    // The internal API credential must never double as a client credential.
    if (internal && timingSafeEqual(digest, internal)) return invalid;
    if (clients.some(c => c.id === entry.principal || c.digest.equals(digest))) return invalid;
    clients.push({ id: entry.principal, digest, wallets: Object.freeze([...wallets as string[]]) });
  }
  const origins: string[] = [];
  for (const raw of (env.FLOFI_MCP_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    let url: URL; try { url = new URL(raw); } catch { return invalid; }
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== raw || url.username || url.password) return invalid;
    origins.push(url.origin);
  }
  return { enabled: true, tenantId, clients: Object.freeze(clients), allowedOrigins: Object.freeze(origins) };
}

/**
 * The principal for an `Authorization: Bearer <token>` header, or null. Every configured digest is compared in constant
 * time; the token is hashed immediately and never stored, logged or returned.
 */
export function authenticate(config: Extract<McpConfig, { enabled: true }>, header: string | null): McpCredentialPrincipal | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  if (!match || !TOKEN.test(match[1]!)) return null;
  const supplied = sha256(match[1]!);
  let found: Client | null = null;
  for (const client of config.clients) if (timingSafeEqual(client.digest, supplied) && !found) found = client;
  return found ? Object.freeze({ kind: 'mcp-credential', id: found.id, tenantId: config.tenantId, wallets: found.wallets }) : null;
}
