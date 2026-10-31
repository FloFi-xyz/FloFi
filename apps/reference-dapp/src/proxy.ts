// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse, type NextRequest } from 'next/server';
import { approvalFrameAncestors } from './server/embedded-approval';
import { accountPagePolicy, cspNonce, isAccountPage } from './accounts/account-csp';

/** Evaluate the trusted deployment origin at runtime, including deliberately isolated previews. */
export function proxy(request: NextRequest) {
  // BUILD-FLOFI-AUTH-WALLETS-001: sign-in and wallet onboarding get a per-request nonce policy. Next.js reads the request's policy to put
  // the nonce on its own scripts; the account layout reads `x-nonce` for its theme bootstrap.
  if (isAccountPage(request.nextUrl.pathname)) {
    const nonce = cspNonce(), policy = accountPagePolicy(nonce);
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('Content-Security-Policy', policy);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set('Content-Security-Policy', policy);
    return response;
  }
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', `connect-src 'self'; frame-ancestors ${approvalFrameAncestors(process.env)}`);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
export const config = { matcher: ['/mcp/approve', '/login', '/onboarding', '/onboarding/:path*'] };
