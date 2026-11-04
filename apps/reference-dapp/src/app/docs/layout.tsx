// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import type { Metadata } from 'next';

// BUILD-FLOFI-SITE-001: each documentation page renders the approved site's Docs layout itself (in the visitor's language).
export const metadata: Metadata = { title: { default: 'FloFi Docs', template: '%s · FloFi Docs' } };
export default function DocsLayout({ children }: { children: ReactNode }) {
  return children;
}
