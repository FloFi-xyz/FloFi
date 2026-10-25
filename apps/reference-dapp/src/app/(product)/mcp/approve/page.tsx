// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';

/** Reuses ProductWorkspace and the existing wallet/financial runtime; no model-callable signing endpoint. */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const metadata: Metadata = { title: 'FloFi · Authorize with your wallet', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function EmbeddedApprovePage() { return null; }
