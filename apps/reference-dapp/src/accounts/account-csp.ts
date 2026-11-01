// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Content Security Policies of every page that hosts the Privy signer: sign-in and wallet onboarding (`/login`, `/onboarding*`,
 * including the private-key import screen) and the product (`/app*`, `/approve`, `/connections`, `/mcp/approve`, `/__engineering`).
 * BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001.
 *
 * Why every such page needs it: Privy's session and its wallet frame trust this whole origin, and Privy's confirmation screen is drawn by
 * the page itself. A script running on the origin could therefore ask Privy to sign directly, bypassing FloFi's reviewed-attempt gate. So
 * these pages run only FloFi's own scripts: a fresh per-request nonce on Next.js's scripts and the theme bootstrap, FloFi's own bundles
 * from `'self'`, and nothing from any other host — except Privy's bot-protection loader when the owner enabled it (privy-hosts.ts).
 * There is no `'strict-dynamic'`: a script element inserted at runtime must still come from FloFi itself. No inline script, inline event
 * handler, `javascript:` URL, plugin or `<base>` rewrite runs. Third-party payment code (Mercado Pago) never runs on this origin: card
 * entry lives on the separate card origin (src/server/card-origin.ts). Styles keep `'unsafe-inline'` for React style attributes and Privy's
 * styled components; CSS cannot run script.
 *
 * `'unsafe-eval'` remains: `@defi-workflow-engine/action-registry` and the workflow contracts compile their Ajv validators with
 * `new Function` when they load (only their own static schemas). It lets an already-running FloFi script evaluate strings; it lets
 * nothing new load. Removing it needs those validators precompiled (build report, follow-ups).
 */
import { privyBotConnectSources, privyScriptSources, PRIVY_CONNECT_SOURCES, PRIVY_FRAME_SOURCES, PRIVY_IMAGE_SOURCES } from './privy-hosts';

type Env = Readonly<Record<string, string | undefined>>;
export { ACCOUNT_PAGE_PATHS, isAccountPage, isProductPage } from './signer-pages';

/** A request nonce: 128 random bits, base64. */
export function cspNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

const checkNonce = (nonce: string) => { if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce)) throw new Error('CSP_NONCE_INVALID'); };
/** The script rules shared by every page hosting the Privy signer. */
function signerScripts(nonce: string, env: Env, signIn: boolean): string[] {
  checkNonce(nonce);
  // Privy's bot-check loader is needed only to sign in: it may run on `/login` (when declared), never on the import screen or the product.
  const bot = signIn ? privyScriptSources(env) : [];
  return [`script-src 'self' 'nonce-${nonce}' 'unsafe-eval'${bot.map(source => ` ${source}`).join('')}`, "script-src-attr 'none'", "object-src 'none'", "base-uri 'none'"];
}

export function accountPagePolicy(nonce: string, env: Env = process.env, options: { readonly signIn?: boolean } = {}): string {
  const signIn = options.signIn === true, [scripts, attributes] = signerScripts(nonce, env, signIn);
  return [
    "default-src 'self'",
    scripts!, attributes!,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${PRIVY_IMAGE_SOURCES.join(' ')}`,
    "font-src 'self'",
    `connect-src 'self' ${[...PRIVY_CONNECT_SOURCES, ...signIn ? privyBotConnectSources(env) : []].join(' ')}`,
    `frame-src ${PRIVY_FRAME_SOURCES.join(' ')}`,
    `child-src ${PRIVY_FRAME_SOURCES.join(' ')}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The product pages' policy. Next.js serves one policy per response and this one replaces `next.config.ts`'s, so it is complete: the
 * signer's script rules, the network the product uses (itself, Privy and the bot protection), and who may frame the page (`'none'` for
 * the sensitive pages, the MCP hosts for `/mcp/approve`, unrestricted as before for the workspace). Frames, images and fonts keep the
 * product's existing freedom; none of them runs script in this origin.
 */
export function productPagePolicy(nonce: string, options: { readonly frameAncestors: string | null }, env: Env = process.env): string {
  return [
    ...signerScripts(nonce, env, false),
    `connect-src 'self' ${PRIVY_CONNECT_SOURCES.join(' ')}`,
    ...options.frameAncestors ? [`frame-ancestors ${options.frameAncestors}`] : [],
  ].join('; ');
}
