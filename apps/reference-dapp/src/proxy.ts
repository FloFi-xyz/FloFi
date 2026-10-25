// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { approvalFrameAncestors } from './server/embedded-approval';

/** Evaluate the trusted deployment origin at runtime, including deliberately isolated previews. */
export function proxy() {
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', `connect-src 'self'; frame-ancestors ${approvalFrameAncestors(process.env)}`);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
export const config = { matcher: '/mcp/approve' };
