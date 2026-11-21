// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState, useSyncExternalStore } from 'react';
import { adminPost } from './admin-client';
import type { Language } from '../../i18n/language';
import { finopsCopy } from './finops-copy';

const subscribe = () => () => undefined;
/** BUILD-ADMIN-001: ends the server-side admin session (CSRF-protected) and returns to the sign-in page. */
export function AdminSignOut({ csrf, language = 'EN' }: { csrf: string; language?: Language }) {
  const { copy } = finopsCopy(language);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // The button is visible in streamed HTML before its click handler is ready. Keep it disabled until hydration so a click cannot
  // silently do nothing when a person (or the browser suite) reaches a console page before its client bundle finishes loading.
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  async function signOut() {
    setBusy(true); setError(null);
    const result = await adminPost('/admin/api/session/end', {}, csrf);
    if (result.ok || result.code === 'ADMIN_SESSION_REQUIRED') { window.location.assign('/admin/login'); return; }
    setError(result.code); setBusy(false);
  }
  return <>
    <button type="button" className="admin-button" disabled={!hydrated || busy} onClick={() => void signOut()}>{copy('Sign out')}</button>
    {error ? <span role="alert">{copy('Sign-out failed ({0})', error)}</span> : null}
  </>;
}
