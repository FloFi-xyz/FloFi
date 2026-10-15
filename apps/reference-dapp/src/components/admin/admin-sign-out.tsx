// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import { adminPost } from './admin-client';

/** BUILD-ADMIN-001: ends the server-side admin session (CSRF-protected) and returns to the sign-in page. */
export function AdminSignOut({ csrf }: { csrf: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function signOut() {
    setBusy(true); setError(null);
    const result = await adminPost('/admin/api/session/end', {}, csrf);
    if (result.ok || result.code === 'ADMIN_SESSION_REQUIRED') { window.location.assign('/admin/login'); return; }
    setError(result.code); setBusy(false);
  }
  return <>
    <button type="button" className="admin-button" disabled={busy} onClick={() => void signOut()}>Sign out</button>
    {error ? <span role="alert">Sign-out failed ({error})</span> : null}
  </>;
}
