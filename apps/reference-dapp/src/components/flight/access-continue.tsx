// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: the "Continue" page of an access link and the unsubscribe page. Nothing happens on load: the link's token is
 * read from the URL fragment and sent only when the person presses Continue (single use, server-checked); the fragment is then removed
 * from the address bar. Neither page signs anyone in, creates an account or touches a wallet.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FLIGHT_RETURN_KEY } from '../../flight/app-boarding';
import { FLIGHT_COPY } from './flight-copy';
import styles from './flight.module.css';

type Language = 'EN' | 'PT';
async function post(path: string, body: unknown): Promise<{ ok: boolean; code?: string; next?: string; address?: string }> {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    return await response.json() as { ok: boolean; code?: string; next?: string; address?: string };
  } catch { return { ok: false, code: 'FLIGHT_UNAVAILABLE' }; }
}

function Shell({ lang, children }: { lang: string; children: React.ReactNode }) {
  return <div className={styles.page} lang={lang} data-flight-page="">
    <header className={styles.header}><Link href="/board" aria-label="FloFi"><img src="/brand/flight/flofi-logo-on-blue.svg" alt="FloFi"/></Link></header>
    <main className={styles.accessPage}>{children}</main>
  </div>;
}

export function AccessContinue({ language, lang }: { language: Language; lang: string }) {
  const copy = FLIGHT_COPY[language], t = copy.access;
  const [token, setToken] = useState<string | null | undefined>(undefined), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null), [address, setAddress] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const match = /(?:^|[#&])t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    const value = match ? match[1]! : null;
    setToken(value);
    // Show which address the link proves before the person confirms (nothing is consumed by asking).
    if (value) void post('/api/board/access/peek', { token: value }).then(answer => {
      const address = (answer as { address?: unknown }).address;
      if (answer.ok && typeof address === 'string') setAddress(address);
      else setMessage({ ok: false, text: (copy.errors as Record<string, string>)[answer.code ?? ''] ?? copy.errors.generic });
    });
  }, []);
  async function go() {
    if (!token) return;
    setBusy(true); setMessage({ ok: true, text: t.working });
    const answer = await post('/api/board/access/consume', { token });
    setBusy(false);
    if (answer.ok) {
      // The token is spent: take it out of the address bar and history, then continue to the gate.
      window.history.replaceState(null, '', '/board/access');
      setMessage({ ok: true, text: t.done });
      // As "Board now" before sign-in: /board consumes this mark on arrival, or /app's pass flow does when the server sends the person
      // straight there (P0 hotfix, Flight transition: src/flight/board-arrival.ts).
      if (answer.next === '/board?board=1') { try { sessionStorage.setItem(FLIGHT_RETURN_KEY, '/board?board=1'); } catch { /* Optional. */ } }
      window.location.assign(answer.next === '/board?board=1' ? '/board?board=1' : '/board');
    } else setMessage({ ok: false, text: (copy.errors as Record<string, string>)[answer.code ?? ''] ?? copy.errors.generic });
  }
  useEffect(() => { if (message) status.current?.focus(); }, [message]);
  return <Shell lang={lang}>
    <span className={`${styles.lbl} ${styles.eyebrow}`}>{t.eyebrow}</span>
    <h1>{t.title[0]}<span className={styles.accentLight}>{t.title[1]}</span></h1>
    {token === null ? <p className={styles.heroBody}>{t.missing}</p> : <>
      <p className={styles.heroBody}>{t.body}</p>
      {address && <p className={styles.heroBody}><b>{t.proves(address)}</b></p>}
      <div className={styles.ctaRow}>
        {/* Continue only once the page has shown which address the link proves (nobody links an address they never saw). */}
        <button type="button" className={`${styles.btn} ${styles.btnNavy}`} onClick={go} disabled={!token || !address || busy || message?.ok === true && message.text === t.done}>
          {t.continue} <span aria-hidden="true">→</span></button>
      </div>
    </>}
    <p ref={status} tabIndex={-1} className={message ? message.ok ? styles.status : styles.error : styles.srOnly} role={message?.ok === false ? 'alert' : 'status'}>{message?.text ?? ''}</p>
    {(token === null || message?.ok === false) && <Reissue language={language}/>}
    <p className={styles.small}><Link href="/board">{t.back}</Link></p>
  </Shell>;
}

/**
 * An expired, used or broken link: ask for a new one. The server sends it only to a beta-list address whose group is boarding and answers
 * the same way for any address (it never says whether one is listed).
 */
function Reissue({ language }: { language: Language }) {
  const copy = FLIGHT_COPY[language], t = copy.access, [email, setEmail] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const answer = await post('/api/board/access/request', { email, language });
    setBusy(false);
    setMessage(answer.ok ? { ok: true, text: t.sent } : { ok: false, text: (copy.errors as Record<string, string>)[answer.code ?? ''] ?? copy.errors.generic });
  }
  return <form className={styles.inviteForm} onSubmit={submit} noValidate>
    <label className={styles.srOnly} htmlFor="flight-reissue-email">{t.emailLabel}</label>
    <input id="flight-reissue-email" type="email" autoComplete="email" inputMode="email" placeholder={copy.finalCall.email} value={email} onChange={e => setEmail(e.target.value)}/>
    <button className={`${styles.btn} ${styles.btnGhost}`} type="submit" disabled={busy || email.trim().length < 6}>{t.send}</button>
    <p className={message?.ok ? styles.status : styles.srOnly} role="status">{message?.ok ? message.text : ''}</p>
    {message && !message.ok && <p className={styles.error} role="alert">{message.text}</p>}
  </form>;
}

export function Unsubscribe({ language, lang }: { language: Language; lang: string }) {
  const t = FLIGHT_COPY[language].unsubscribe;
  const [token, setToken] = useState<string | null | undefined>(undefined), [state, setState] = useState<'idle' | 'busy' | 'done' | 'invalid'>('idle');
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('t');
    setToken(value && /^fem_[0-9a-f]{32}\.[0-9a-f]{64}\.[A-Za-z0-9_-]{22}$/.test(value) ? value : null);
  }, []);
  async function go() {
    if (!token) return;
    setState('busy');
    try {
      const response = await fetch(`/api/board/unsubscribe?t=${encodeURIComponent(token)}`, { method: 'POST' });
      setState(response.ok ? 'done' : 'invalid');
    } catch { setState('invalid'); }
  }
  return <Shell lang={lang}>
    <h1>{t.title[0]}<span className={styles.accentLight}>{t.title[1]}</span></h1>
    {token === null || state === 'invalid' ? <p className={styles.error} role="alert">{t.invalid}</p> : state === 'done' ? <p className={styles.status} role="status">{t.done}</p> : <>
      <p className={styles.heroBody}>{t.body}</p>
      <div className={styles.ctaRow}><button type="button" className={`${styles.btn} ${styles.btnNavy}`} onClick={go} disabled={!token || state === 'busy'}>{t.action}</button></div>
    </>}
  </Shell>;
}
