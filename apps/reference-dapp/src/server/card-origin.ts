// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the card origin, the only place Mercado Pago's Secure Fields SDK runs.
 *
 * Why a separate origin: the product origin hosts the Privy signer. Privy's session and wallet frame trust that whole origin and Privy's
 * confirmation screen is drawn by the page, so any script running there could ask Privy to sign without FloFi's reviewed-attempt gate.
 * Mercado Pago's SDK is third-party code FloFi cannot review or pin (it is served unversioned). It therefore never runs on the product
 * origin: Add card frames `/card-entry` from this origin (`FLOFI_CARD_ORIGIN`, served by the same deployment but only for that page and
 * its static assets), where the SDK mounts its own secure fields. The frame hands the product only Mercado Pago's one-time card token and
 * the email, by `postMessage` to the product origin; the product checks the sender's origin and window and saves the card through its own
 * server action. The card origin can neither read the product's storage nor script its pages, and it holds no FloFi session.
 *
 * Without a valid card origin, Add card is unavailable (nothing is collected); the SDK is never loaded on the product origin instead.
 */
import { deploymentEnvironment, isHostedDeployment, publicOrigin } from './deployment.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type CardOrigin = { readonly origin: string; readonly host: string; readonly appOrigin: string; readonly appHost: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Production has one card origin, as it has one brand origin. Previews may name their own https host. */
export const FLOFI_PRODUCTION_CARD_ORIGIN = 'https://cards.flofi.xyz';

/** The card origin of this deployment, or null when absent or invalid (Add card then stays unavailable). */
export function cardOrigin(env: Env): CardOrigin | null {
  const raw = env.FLOFI_CARD_ORIGIN ?? '', app = publicOrigin(env);
  if (!raw || !app) return null;
  let url: URL, appUrl: URL;
  try { url = new URL(raw); appUrl = new URL(app); } catch { return null; }
  if (url.origin !== raw || url.username || url.password || url.host === appUrl.host) return null;
  if (deploymentEnvironment(env) === 'production' && url.origin !== FLOFI_PRODUCTION_CARD_ORIGIN) return null;
  // Plain http only for the MOCKED loopback card suite on a local server (two loopback hosts = two origins).
  const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && env.GRYLOO_CARD_E2E === 'MOCKED_LOOPBACK_ONLY' && !isHostedDeployment(env))) return null;
  return { origin: url.origin, host: url.host, appOrigin: appUrl.origin, appHost: appUrl.host };
}
/** Hosts that must never serve the product, even when the card configuration is missing or invalid (fail closed). */
export function reservedCardHosts(env: Env): ReadonlySet<string> {
  const hosts = new Set<string>([new URL(FLOFI_PRODUCTION_CARD_ORIGIN).host]);
  try { if (env.FLOFI_CARD_ORIGIN) hosts.add(new URL(env.FLOFI_CARD_ORIGIN).host.toLowerCase()); } catch { /* unparseable: nothing to reserve */ }
  const app = publicOrigin(env);
  try { if (app) hosts.delete(new URL(app).host.toLowerCase()); } catch { /* no product origin */ }
  return hosts;
}
export const CARD_ORIGIN_PREREQUISITE = 'Card entry runs on a separate card origin (FLOFI_CARD_ORIGIN, https://cards.flofi.xyz in production) so the '
  + "card provider's script never runs where the FloFi wallet signs; it must be configured on the deployment before FloFi can add cards.";
/** The one page the card origin serves (and the product origin never does). */
export const CARD_ENTRY_PATH = '/card-entry';
export const isCardPath = (pathname: string) => pathname === CARD_ENTRY_PATH;
/** What else the card origin serves: that page's static assets. Everything else there is 404. */
export const isCardAsset = (pathname: string) => pathname.startsWith('/_next/static/') || pathname.startsWith('/fonts/') || pathname === '/favicon.ico';

/** Mercado Pago's API, static and secure-fields origins: the only network the card page uses besides its own origin. */
export const MERCADO_PAGO_CONNECT_SOURCES = Object.freeze(['https://api.mercadopago.com', 'https://api-static.mercadopago.com', 'https://secure-fields.mercadopago.com']);

/**
 * The card page's policy: its own scripts by nonce and what they load (`'strict-dynamic'`: Mercado Pago's SDK and whatever it loads, the
 * reason this origin exists), no inline handler, plugin or `<base>`; network only to itself and Mercado Pago; framed only by the product.
 */
export function cardPagePolicy(nonce: string, card: CardOrigin): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce)) throw new Error('CSP_NONCE_INVALID');
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `connect-src 'self' ${MERCADO_PAGO_CONNECT_SOURCES.join(' ')}`,
    "form-action 'none'",
    `frame-ancestors ${card.appOrigin}`,
  ].join('; ');
}
