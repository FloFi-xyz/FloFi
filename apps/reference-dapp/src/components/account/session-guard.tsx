// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRIVY-UX-001: after Disconnect, the browser's Back button must not bring back a signed-in page from its back/forward cache.
 * A page restored from that cache (`pageshow` with `persisted`) is reloaded, so the server checks the session again and a revoked one
 * shows the signed-out page. The pages themselves are also sent `Cache-Control: no-store` (next.config.ts).
 */
import { useEffect } from 'react';

export function SessionGuard() {
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  return null;
}
