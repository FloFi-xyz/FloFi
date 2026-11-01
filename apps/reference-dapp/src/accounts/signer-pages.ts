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
/**
 * The script policy a document loaded at `pathname` carries: `/login` (the only page that may also allow Privy's bot check), the other
 * account pages, or the product pages; null for a page that does not host the signer. A client-side navigation keeps the document and
 * its policy, so FloFiPrivyProvider reloads whenever the current page needs another class than the one the document was loaded with.
 */
export type SignerPolicy = 'login' | 'account' | 'product';
export function signerPolicy(pathname: string): SignerPolicy | null {
  if (pathname === '/login') return 'login';
  if (isAccountPage(pathname)) return 'account';
  return isProductPage(pathname) ? 'product' : null;
}
