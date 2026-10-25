// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect } from 'react';

/** Size only. Capabilities, wallet payloads and signatures never cross this message channel. */
export function EmbeddedApproval() {
  useEffect(() => {
    if (window.parent === window) return;
    const notify = () => window.parent.postMessage({ type: 'flofi/approval-frame', height: document.documentElement.scrollHeight }, '*');
    notify();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(notify);
    observer?.observe(document.body);
    return () => observer?.disconnect();
  }, []);
  return null;
}
