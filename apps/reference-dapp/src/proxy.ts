// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse, type NextRequest } from 'next/server';
import { approvalFrameAncestors } from './server/embedded-approval';
import { accountPagePolicy, cspNonce, isAccountPage, isProductPage, productPagePolicy } from './accounts/account-csp';
import { isWalletAsset, isWalletPath, reservedWalletHosts, walletOrigin, walletPagePolicy } from './accounts/wallet-origin';
import { cardOrigin, cardPagePolicy, isCardAsset, isCardPath, reservedCardHosts } from './server/card-origin';

const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
/** A response carrying a fresh nonce policy, and the request headers Next.js reads to put the nonce on its own scripts. */
function withNonce(request: NextRequest, policy: (nonce: string) => string, extra: Record<string, string> = {}) {
  const nonce = cspNonce(), value = policy(nonce);
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  // Authoritative route context for the host-only embedded wallet proof cookie. Never trust a caller-supplied pathname header.
  headers.set('x-flofi-pathname', request.nextUrl.pathname);
  headers.set('Content-Security-Policy', value);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', value);
  for (const [name, content] of Object.entries(extra)) response.headers.set(name, content);
  return response;
}

/** Evaluate the trusted deployment origin at runtime, including deliberately isolated previews. */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet. Its host serves only its own pages, route handlers and static assets (no product page,
  // no server action), and its paths do not exist on the product host. See src/accounts/wallet-origin.ts.
  const wallet = walletOrigin(process.env), host = (request.headers.get('host') ?? '').toLowerCase();
  // Fail closed: the wallet host is wallet-only even when its configuration is invalid (its pages then say FloFi Wallet is unavailable and
  // its routes answer MANAGED_WALLETS_NOT_CONFIGURED); it never falls through to the product.
  if (wallet ? host === wallet.host.toLowerCase() : reservedWalletHosts(process.env).has(host)) {
    if (request.headers.has('next-action')) return notFound();
    if (isWalletAsset(pathname) || pathname.startsWith('/api/wallet')) {
      const response = NextResponse.next();
      response.headers.set('X-Content-Type-Options', 'nosniff');
      // Static brand images and route responses never run script or frame anything on the wallet origin.
      if (!pathname.startsWith('/_next/static/')) response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
      return response;
    }
    if (!isWalletPath(pathname)) return notFound();
    return withNonce(request, nonce => walletPagePolicy(nonce), { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  }
  if (isWalletPath(pathname)) return notFound();
  // BUILD-FLOFI-PRIVY-UX-001: the card origin serves only the card entry page (Mercado Pago's SDK) and its static assets, never the product,
  // and the product never serves that page (src/server/card-origin.ts). Fail closed like the wallet host.
  const card = cardOrigin(process.env);
  if (card ? host === card.host.toLowerCase() : reservedCardHosts(process.env).has(host)) {
    if (request.headers.has('next-action')) return notFound();
    if (isCardAsset(pathname)) { const response = NextResponse.next(); response.headers.set('X-Content-Type-Options', 'nosniff'); return response; }
    if (!card || !isCardPath(pathname)) return notFound();
    return withNonce(request, nonce => cardPagePolicy(nonce, card), { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  }
  if (isCardPath(pathname)) return notFound();
  // BUILD-FLOFI-AUTH-WALLETS-001: sign-in and wallet onboarding get a per-request nonce policy. Next.js reads the request's policy to put
  // the nonce on its own scripts; the account layout reads `x-nonce` for its theme bootstrap.
  if (isAccountPage(pathname)) return withNonce(request, nonce => accountPagePolicy(nonce, process.env, { signIn: pathname === '/login' }));
  // BUILD-FLOFI-PRIVY-UX-001: every product page hosts the Privy signer, so it runs only FloFi's own scripts (account-csp.ts). This policy
  // replaces next.config.ts's for these paths, so it carries their framing rules too.
  if (isProductPage(pathname)) {
    if (pathname === '/mcp/approve') return withNonce(request, nonce => productPagePolicy(nonce, { frameAncestors: approvalFrameAncestors(process.env) }),
      { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
    // The workspace may be framed only by FloFi itself: never by another site, nor by the same-site card origin (which runs Mercado Pago).
    return withNonce(request, nonce => productPagePolicy(nonce, { frameAncestors: NEVER_FRAMED.has(pathname) ? "'none'" : "'self'" }));
  }
  // OAuth loopback landing used only as a same-origin redirect_uri (e2e MCP host). It must not carry a nonce script policy:
  // Playwright's embedded host then replaces the document with setContent, and Chromium inherits the prior navigation's CSP into
  // that document.write — which would block the host fixture's inline script and never render the approval panel.
  if (pathname === '/mcp-e2e-callback') return NextResponse.next();
  // Privy's trust boundary is the entire product origin. Public pages, admin pages and even error documents must carry the same
  // script restrictions: a script injected there could otherwise open a signer page and drive its same-origin wallet frame.
  // Route handlers that return their own stricter policy (e.g. script-free OAuth consent) keep that response policy.
  return withNonce(request, nonce => productPagePolicy(nonce, { frameAncestors: "'none'" }));
}
/** Product pages that hold a handoff secret, account choices or wallet credentials: never framed (as in next.config.ts). */
const NEVER_FRAMED: ReadonlySet<string> = new Set(['/approve', '/connections', '/app/credentials']);
// Every request except Next.js's immutable build output and image optimizer: the wallet host must refuse everything that is not its own.
export const config = { matcher: ['/((?!_next/static|_next/image).*)'] };
