// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the pages that host the Privy signer, which the proxy serves with the signer pages' script policy
 * (src/accounts/account-csp.ts). Shared by the proxy and the browser (FloFiPrivyProvider refuses to mount Privy in a document that was not
 * loaded as one of these pages, for example one reached by a client-side navigation from a page without that policy).
 */
/** Account pages served by the account policy; the proxy matcher names the same paths. */
export const ACCOUNT_PAGE_PATHS = ['/login', '/onboarding', '/onboarding/:path*'] as const;
export const isAccountPage = (pathname: string) => pathname === '/login' || pathname === '/onboarding' || pathname.startsWith('/onboarding/');
/** Product pages hosting the Privy signer (the `(product)` layout); the proxy serves them `productPagePolicy`. */
export const isProductPage = (pathname: string) => pathname === '/app' || pathname.startsWith('/app/') || pathname === '/approve' || pathname === '/connections'
  || pathname === '/mcp/approve' || pathname === '/__engineering' || pathname === '/%5F_engineering';
/** Whether a document loaded at `pathname` was served with the signer pages' script policy. */
export const isSignerPage = (pathname: string) => isAccountPage(pathname) || isProductPage(pathname);
