// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-FLIGHT-001: the live parts of /board. The page shows one of the approved states, chosen by the server's real data:
 * 1 Final call (until the list closes; the night before boarding uses the approved "Gate closed" post), 2 Now boarding, 3 group still
 * closed, 4 not on the list, 5 Founding full — and the person's own pass once issued. "Board now" signs the person in when needed,
 * checks list, group and invite, and opens /app with their request as an editable draft. Nothing here signs, simulates or moves funds.
 *
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: no count of people anywhere (CLOSED BETA · OPENING IN GROUPS, PASSENGER SEATS OPEN); FINAL CALL marquee
 * until boarding; "I have an invite code" in every state; a person on the list with another email gets a link and a code by email and can
 * type the code here (another device); the card flow: handle (optional), card, share, public page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { FLIGHT_BOARDING_KEY, FLIGHT_DRAFT_KEY, FLIGHT_RETURN_KEY } from '../../flight/app-boarding';
import type { FlightState } from '../../flight/http';
import { INVITE_CODE, type FlightAccess } from '../../flight/campaign';
import type { FlightPass, OwnInvite } from '../../flight/store';
import { faceOf, Flaps, FoundingPass, PassengerPass } from './boarding-pass';
import { boardingDay, brtClock as clockOf, FLIGHT_COPY, type FlightCopy } from './flight-copy';
import styles from './flight.module.css';

type Language = 'EN' | 'PT';
type Answer = { ok: boolean; code?: string; [key: string]: unknown };
const BOARD_RETURN = '/board?board=1';
const storage = () => { try { return sessionStorage; } catch { return null; } };
async function post(path: string, body: unknown): Promise<Answer> {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await response.json() as Answer;
  } catch { return { ok: false, code: 'FLIGHT_UNAVAILABLE' }; }
}
const report = (event: string, detail = '') => { void post('/api/board/event', { event, detail }); };
const brt = (ms: number, options: Intl.DateTimeFormatOptions, language: Language) =>
  new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en-US', { timeZone: 'America/Sao_Paulo', ...options }).format(new Date(ms));
function errorText(copy: FlightCopy, code: string | undefined) {
  return (copy.errors as Record<string, string>)[code ?? ''] ?? copy.errors.generic;
}
function shareOnX(text: string, url = 'https://flofi.xyz/board') {
  window.open(`https://x.com/intent/post?${new URLSearchParams({ text, url })}`, '_blank', 'noopener,noreferrer');
}
/** The approved post text (card handoff): the card's real seat and route. */
function cardPost(pass: FlightPass): string {
  const steps = `${pass.route.stepCount} ${pass.route.stepCount === 1 ? 'step' : 'steps'}`;
  return pass.foundingSeat ? `I just boarded Flight FloFi ✈️ Founding Member ${pass.seat}. ${pass.route.from} → ${pass.route.to} in ${steps}, and I approve every step. @FloFi_xyz`
    : `I just boarded Flight FloFi ✈️ ${pass.route.from} → ${pass.route.to} in ${steps}, and I approve every step. @FloFi_xyz`;
}
const cardUrl = (pass: FlightPass) => pass.publicId ? `https://flofi.xyz/card/${pass.publicId}` : null;

/** Remaining list time in whole seconds, derived from the server reference and the actual elapsed clock. */
function useCountdown(target: number, serverNow: number) {
  const [offset] = useState(() => serverNow - Date.now());
  const [now, setNow] = useState(serverNow);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() + offset), 1000); return () => clearInterval(timer); }, [offset]);
  const seconds = Math.max(0, Math.floor((target - now) / 1000));
  return [Math.floor(seconds / 86400), Math.floor((seconds % 86400) / 3600), Math.floor((seconds % 3600) / 60), seconds % 60] as const;
}

function Countdown({ state, copy }: { state: FlightState; copy: FlightCopy }) {
  const values = useCountdown(state.closesAt, state.now), t = copy.finalCall;
  const two = (n: number) => String(Math.min(n, 99)).padStart(2, '0');
  const word = (n: number, index: number) => `${n} ${t.unitWords[index]![n === 1 ? 0 : 1]}`;
  return <div className={styles.countdown} role="timer" aria-label={`${t.closesIn} ${values.map(word).join(', ')}`}>
    {values.map((value, index) => <span key={index} className={styles.countGroup} aria-hidden="true">
      <Flaps text={two(value)} big/><span className={styles.countUnit}>{t.units[index]}</span></span>)}
  </div>;
}

/** The list form's notice: what the address is used for, that joining is agreeing to it, and the privacy policy's campaign section. */
function ListNotice({ copy, language }: { copy: FlightCopy; language: Language }) {
  return <span id="flight-list-notice">{copy.finalCall.notice} {copy.finalCall.consent} <Link href={language === 'PT' ? '/privacy#campanha-flight-flofi' : '/privacy#flight-flofi'}>{copy.finalCall.privacy}</Link>.</span>;
}

function ListForm({ copy, language, flight, onJoined }: { copy: FlightCopy; language: Language; flight: 'FIRST' | 'NEXT'; onJoined: () => void }) {
  const t = copy.finalCall, [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false), confirmation = useRef<HTMLParagraphElement>(null);
  // The confirmation is announced (its live region is already on the page) and takes the focus the removed form had.
  useEffect(() => { if (done) confirmation.current?.focus(); }, [done]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    const trap = (event.currentTarget as HTMLFormElement).elements.namedItem('flight-hp') as HTMLInputElement | null;
    const answer = await post('/api/board/list', { email, language, consent: true, company: trap?.value ?? '' });
    setBusy(false);
    if (answer.ok) { setDone(true); onJoined(); } else setError(errorText(copy, answer.code));
  }
  return <>
    {!done && <form onSubmit={submit} className={styles.personal} noValidate>
      <div className={styles.pill}>
        <label className={styles.srOnly} htmlFor="flight-email">{t.emailLabel}</label>
        <input id="flight-email" type="email" autoComplete="email" inputMode="email" required placeholder={t.email} value={email} onChange={e => setEmail(e.target.value)}
          aria-describedby="flight-list-notice"/>
        {/* Left empty by people; filled only by bots (a name no browser autofills). */}
        <input className={styles.srOnly} type="text" name="flight-hp" tabIndex={-1} autoComplete="off" aria-hidden="true"/>
        <button className={`${styles.btn} ${styles.btnNavy}`} type="submit" disabled={busy} aria-describedby="flight-list-notice">
          {flight === 'FIRST' ? t.join : copy.gateClosed.join} <span aria-hidden="true">→</span></button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>}
    <p ref={confirmation} tabIndex={-1} className={done ? styles.status : styles.srOnly} role="status">{done ? flight === 'FIRST' ? t.joined : copy.gateClosed.joined : ''}</p>
  </>;
}

/** Presentation only: keep invalid characters visible so the backend alphabet still decides validity. */
function formatInvite(value: string): string {
  const upper = value.toUpperCase().replace(/\s/g, '');
  let payload = (upper.startsWith('FLF-') ? upper.slice(4) : upper).replace(/-/g, '');
  // A compact full code has 11 characters. An 8-character payload may itself start with FLF.
  if (payload.length === 11 && payload.startsWith('FLF')) payload = payload.slice(3);
  if (upper === 'FLF-FLF-') payload = ''; // Typing the optional prefix, including its separator.
  if (!payload && !upper) return '';
  return `FLF-${payload.slice(0, 4)}${payload.length > 4 ? `-${payload.slice(4)}` : ''}`;
}

function InviteForm({ copy, now, opensAt, onRedeemed }: { copy: FlightCopy; now: number; opensAt: number; onRedeemed: (flight: unknown) => void }) {
  const t = copy.inviteForm, [code, setCode] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null), caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null) { input.current?.setSelectionRange(caret.current, caret.current); caret.current = null; }
  }, [code]);
  function edit(value: string, position: number) {
    const formatted = formatInvite(value), before = value.slice(0, position).toUpperCase().replace(/[\s-]/g, '');
    const compact = value.toUpperCase().replace(/[\s-]/g, '');
    const hasPrefix = value.toUpperCase().replace(/\s/g, '').startsWith('FLF-') || (compact.length === 11 && compact.startsWith('FLF'));
    const length = hasPrefix ? Math.max(0, before.length - 3) : before.length;
    caret.current = Math.min(formatted.length, 4 + length + (length > 4 ? 1 : 0));
    setCode(formatted);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!INVITE_CODE.test(code)) return;
    // Server calendar also controls the UI; the API independently enforces this before consuming a code.
    if (now < opensAt) { setMessage({ ok: false, text: copy.errors.INVITE_NOT_YET }); return; }
    setBusy(true);
    const answer = await post('/api/board/invite', { code });
    setBusy(false);
    if (answer.ok) { setMessage({ ok: true, text: t.redeemed }); onRedeemed(answer.flight); }
    else if (answer.code === 'FLIGHT_SIGN_IN_REQUIRED') {
      storage()?.setItem(FLIGHT_RETURN_KEY, '/board?invite=1');
      window.location.assign(`/login?returnTo=${encodeURIComponent('/board?invite=1')}`);
    }
    else setMessage({ ok: false, text: errorText(copy, answer.code) });
  }
  return <form className={styles.inviteForm} onSubmit={submit}>
    <label className={styles.srOnly} htmlFor="flight-invite">{t.label}</label>
    <input ref={input} id="flight-invite" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder={t.placeholder} value={code}
      onChange={e => edit(e.target.value, e.target.selectionStart ?? e.target.value.length)}
      onKeyDown={e => {
        const { selectionStart: start, selectionEnd: end } = e.currentTarget;
        if (start === null || end === null) return;
        if (end <= 4 && code.startsWith('FLF-')) {
          if (e.key === 'Delete' || (start !== end && e.key === 'Backspace')) {
            e.preventDefault();
            if (start === end) edit(code.slice(0, 4) + code.slice(5), 4);
            else e.currentTarget.setSelectionRange(4, 4);
            return;
          }
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.currentTarget.setSelectionRange(4, 4);
        }
        if (start !== end) return;
        // Deleting an inserted separator also deletes its adjacent payload character, so the caret never gets trapped.
        if (e.key === 'Backspace' && start <= 4 && code.startsWith('FLF-')) {
          e.preventDefault();
          if (code === 'FLF-') { caret.current = 0; setCode(''); }
          else e.currentTarget.setSelectionRange(4, 4);
        } else if (e.key === 'Backspace' && start === 9) {
          e.preventDefault();
          edit(code.slice(0, start - 2) + code.slice(start), start - 2);
        } else if (e.key === 'Delete' && start === 8 && code[8] === '-') {
          e.preventDefault(); edit(code.slice(0, start) + code.slice(start + 2), start);
        }
      }}/>
    <button className={`${styles.btn} ${styles.btnGhost}`} type="submit" disabled={busy || !INVITE_CODE.test(code)}>{t.use}</button>
    <p className={message?.ok ? styles.status : styles.srOnly} role="status">{message?.ok ? message.text : ''}</p>
    {message && !message.ok && <p className={styles.error} role="alert">{message.text}</p>}
  </form>;
}

/**
 * "On the list with another email?": a link and a 6-digit code go to that address if it is on the beta list and its group is boarding (the
 * answer never says whether it is); the code typed here proves the address on this device (another device than the email's, too).
 */
function AccessForms({ copy, language, onClaimed, intro = true }: { copy: FlightCopy; language: Language; onClaimed: (notice: string) => void; intro?: boolean }) {
  const t = copy.access, [email, setEmail] = useState(''), [code, setCode] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function request(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    const answer = await post('/api/board/access/request', { email, language });
    setBusy(false);
    if (answer.ok) setMessage({ ok: true, text: t.sent }); else setMessage({ ok: false, text: errorText(copy, answer.code) });
  }
  async function useCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    const answer = await post('/api/board/access/code', { email, code });
    setBusy(false);
    // The confirmation moves to the hero (this form leaves the page when the person's state changes).
    if (answer.ok) onClaimed(answer.status === 'SESSION' ? t.pendingSignIn : t.claimed);
    else setMessage({ ok: false, text: errorText(copy, answer.code) });
  }
  return <div className={styles.accessForms}>
    {intro && <p className={styles.small}>{t.otherEmail}</p>}
    <form onSubmit={request} className={styles.inviteForm} noValidate>
      <label className={styles.srOnly} htmlFor="flight-access-email">{t.emailLabel}</label>
      <input id="flight-access-email" type="email" autoComplete="email" inputMode="email" placeholder={copy.finalCall.email} value={email} onChange={e => setEmail(e.target.value)}/>
      <button className={`${styles.btn} ${styles.btnGhost}`} type="submit" disabled={busy || email.trim().length < 6}>{t.send}</button>
    </form>
    <form onSubmit={useCode} className={styles.inviteForm} noValidate>
      <label className={styles.srOnly} htmlFor="flight-access-code">{t.codeLabel}</label>
      {/* No maxLength: a code pasted from the email's digit cells arrives with tabs or line breaks between digits; only digits are kept. */}
      <input id="flight-access-code" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} aria-describedby="flight-access-code-hint"
        onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}/>
      <button className={`${styles.btn} ${styles.btnGhost}`} type="submit" disabled={busy || code.length !== 6 || email.trim().length < 6}>{t.codeUse}</button>
    </form>
    <p id="flight-access-code-hint" className={styles.small}>{t.codeHint}</p>
    <p className={message?.ok ? styles.status : styles.srOnly} role="status">{message?.ok ? message.text : ''}</p>
    {message && !message.ok && <p className={styles.error} role="alert">{message.text}</p>}
  </div>;
}

function calendarFile(opensAt: number, language: Language): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const summary = language === 'PT' ? 'Flight FloFi: embarque do seu grupo' : 'Flight FloFi: your group boards';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FloFi//Flight FloFi//EN', 'BEGIN:VEVENT', `UID:flight-${opensAt}@flofi.xyz`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(opensAt)}`, `DTEND:${stamp(opensAt + 3_600_000)}`, `SUMMARY:${summary}`, 'URL:https://flofi.xyz/board', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/**
 * The person's own card, in the approved flow: 1 "Who's flying?" (an optional X handle, once, right after the card is issued), 2 the card
 * with Share on X, Download card and Copy link, 3 the post on X (text and the card's own link: the link's preview shows the card), 4 the
 * card's public page. Then their invites (Founding from the beta list only) and the departures-board choice.
 */
function PassPanel({ pass, invites, copy, onPass }: { pass: FlightPass; invites: readonly OwnInvite[]; copy: FlightCopy; onPass: (pass: FlightPass) => void }) {
  const t = copy.pass, printedKey = `flofi.flight.printed.${pass.passId}`;
  const [handle, setHandle] = useState(pass.handle ?? ''), [visible, setVisible] = useState(pass.public), [message, setMessage] = useState<string | null>(null);
  // Screen 1 only once per card, and only while the card has no handle yet.
  const [printing, setPrinting] = useState<boolean | null>(null);
  // Remembered in this browser (not only this tab): the handle screen is shown once.
  const remembered = () => { try { return localStorage; } catch { return null; } };
  useEffect(() => { setPrinting(pass.handle === null && remembered()?.getItem(printedKey) !== '1'); }, [pass.handle, printedKey]);
  const printed = () => { remembered()?.setItem(printedKey, '1'); setPrinting(false); window.setTimeout(() => document.getElementById('pass')?.focus(), 0); };
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const unused = invites.filter(invite => !invite.redeemed).length;
  async function save(event: FormEvent, after?: () => void) {
    event.preventDefault();
    const answer = await post('/api/board/handle', { handle, public: visible });
    if (answer.ok) { onPass(answer.pass as FlightPass); setMessage(t.saved); after?.(); } else setMessage(errorText(copy, answer.code));
  }
  const url = cardUrl(pass), kind = pass.foundingSeat ? 'founding' : 'passenger';
  // Until the browser knows whether the handle screen comes first, show neither (no card flashing before "Who's flying?").
  if (printing === null) return <section id="pass" tabIndex={-1} aria-label={t.yours} aria-busy="true"/>;
  if (printing) return <section className={styles.passControls} aria-labelledby="who-title">
    <div>
      <span className={`${styles.lbl} ${styles.eyebrow}`}>{t.whoEyebrow}</span>
      <h2 id="who-title" className={styles.h2}>{t.whoTitle}</h2>
      <p>{t.whoBody}</p>
      <form className={styles.personal} onSubmit={event => save(event, printed)}>
        <label className={styles.field}>{t.handleLabel}<input type="text" value={handle} maxLength={16} autoComplete="off" spellCheck={false} placeholder="@your_handle"
          onChange={e => setHandle(e.target.value)} aria-describedby="who-note"/></label>
        <p id="who-note" className={styles.small}>{t.handleNote}</p>
        <div className={styles.ctaRow}>
          <button className={`${styles.btn} ${styles.btnNavy}`} type="submit" disabled={!handle.trim()}>{t.print} <span aria-hidden="true">→</span></button>
          <button className={`${styles.btn} ${styles.btnGhost}`} type="button" onClick={printed}>{t.skip}</button>
        </div>
        <p role="status" className={message ? styles.error : styles.srOnly}>{message ?? ''}</p>
      </form>
    </div>
  </section>;
  return <>
    <section id="pass" tabIndex={-1} aria-label={t.yours}>{pass.foundingSeat ? <FoundingPass pass={faceOf(pass)} copy={copy}/> : <PassengerPass pass={pass} copy={copy}/>}</section>
    <div className={styles.passControls}>
      <section aria-labelledby="pass-share-title">
        <h2 id="pass-share-title">{t.ready}</h2>
        <div className={styles.ctaRow}>
          {url && <button className={`${styles.btn} ${styles.btnNavy}`} type="button" onClick={() => { report('share_click', kind); shareOnX(cardPost(pass), url); }}>{t.share}</button>}
          {url && <a className={`${styles.btn} ${styles.btnBlue}`} href={`/card/${pass.publicId}/image?download=1`} download>{t.download}</a>}
          {url && <button className={`${styles.btn} ${styles.btnGhost}`} type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(url); setShareMessage(t.copied); } catch { setShareMessage(url); } }}>{t.copy}</button>}
          {unused > 0 && <a className={`${styles.btn} ${styles.btnGhost}`} href="#invites">{t.invitesReady(unused)} <span aria-hidden="true">→</span></a>}
        </div>
        {url && <p className={styles.small}><a href={url}>{url.replace('https://', '')}</a> · {t.emailed}</p>}
        <p role="status" className={shareMessage ? styles.muted : styles.srOnly}>{shareMessage ?? ''}</p>
      </section>
      <section aria-labelledby="pass-handle-title">
        <h2 id="pass-handle-title">{t.handleLabel}</h2>
        <form onSubmit={event => save(event)} className={styles.personal}>
          <label className={styles.field}>{t.handleLabel}<input type="text" value={handle} maxLength={16} autoComplete="off" spellCheck={false} placeholder="@handle"
            onChange={e => setHandle(e.target.value)} aria-describedby="pass-handle-note"/></label>
          <p id="pass-handle-note" className={styles.small}>{t.handleNote}</p>
          <label className={styles.check}><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)}/>{t.handlePublic}</label>
          <div className={styles.ctaRow}>
            <button className={`${styles.btn} ${styles.btnBlue}`} type="submit">{t.save}</button>
            <Link className={`${styles.btn} ${styles.btnBlue}`} href="/app">{t.open}</Link>
          </div>
          <p role="status" className={message ? styles.muted : styles.srOnly}>{message ?? ''}</p>
        </form>
      </section>
      {invites.length > 0 && <section id="invites" tabIndex={-1} aria-labelledby="pass-invites-title">
        <h2 id="pass-invites-title">{t.invitesTitle}</h2>
        <p className={styles.muted}>{t.invitesBody}</p>
        <ul className={styles.inviteList}>{invites.map(invite => <li key={invite.code}>{invite.redeemed ? <><s>{invite.code}</s> <span className={styles.muted}>{t.used}</span></> : invite.code}</li>)}</ul>
      </section>}
    </div>
  </>;
}

export function BoardExperience({ initial, language }: { initial: FlightState | null; language: Language }) {
  const copy = FLIGHT_COPY[language];
  const [state, setState] = useState(initial);
  const [personal, setPersonal] = useState<FlightAccess | null>(() => {
    const access = initial?.me.flight?.access;
    return access && (access.kind === 'batch_closed' || access.kind === 'not_listed') ? access : null;
  });
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [nextJoined, setNextJoined] = useState(false);
  const [accessNotice, setAccessNotice] = useState<string | null>(null), [showAccess, setShowAccess] = useState(false);
  const joinedStatus = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (nextJoined) joinedStatus.current?.focus(); }, [nextJoined]);
  // A proven address changes the hero: focus its heading so the confirmation is read out (the form the person used is gone).
  useEffect(() => { if (accessNotice) document.getElementById('flight-access-notice')?.focus(); }, [accessNotice]);
  const [paused, setPaused] = useState(false);
  const [focusPass, setFocusPass] = useState(false);
  // When the hero changes to the person's own state, focus its heading so the change is read out (the form they used is gone).
  const shown = useRef(personal);
  useEffect(() => {
    if (shown.current === personal) return;
    shown.current = personal;
    if (personal) document.getElementById('flight-hero-title')?.focus();
  }, [personal]);
  const pass = state?.me.flight?.pass ?? null;
  // An already-boarded person's pass is focused once it is on the page.
  useEffect(() => { if (focusPass && pass) { document.getElementById('pass')?.focus(); setFocusPass(false); } }, [focusPass, pass]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/board/state', { cache: 'no-store' });
      if (response.ok) setState(await response.json() as FlightState);
    } catch { /* The page keeps its last real numbers. */ }
  }, []);
  const claimed = useCallback((notice: string) => { setAccessNotice(notice); setShowAccess(false); setPersonal(null); void refresh(); }, [refresh]);
  // Departures stay live while the page is visible.
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  // Example routes fill the request and scroll to it ("Rotas de exemplo: o clique preenche o campo do hero e rola a página até ele").
  useEffect(() => {
    const fill = (event: Event) => { setPrompt((event as CustomEvent<string>).detail); document.getElementById('flight-prompt')?.focus(); };
    window.addEventListener('flight:route', fill);
    return () => window.removeEventListener('flight:route', fill);
  }, []);

  const goToApp = useCallback(() => {
    const store = storage();
    store?.setItem(FLIGHT_BOARDING_KEY, '1');
    window.location.assign('/app');
  }, []);
  const checkAccess = useCallback(async () => {
    setBusy(true); setMessage(copy.boarding.checking);
    const answer = await post('/api/board/board', {});
    setBusy(false); setMessage(null);
    if (answer.code === 'FLIGHT_SIGN_IN_REQUIRED') {
      storage()?.setItem(FLIGHT_RETURN_KEY, BOARD_RETURN);
      window.location.assign(`/login?returnTo=${encodeURIComponent(BOARD_RETURN)}`);
      return;
    }
    const flight = answer.flight as { access: FlightAccess } | undefined;
    if (!answer.ok) {
      if (flight?.access.kind === 'batch_closed' || flight?.access.kind === 'not_listed') setPersonal(flight.access);
      else setMessage(errorText(copy, answer.code));
      return;
    }
    if (!flight) return;
    if (answer.access) setMessage(errorText(copy, `ACCESS_${String(answer.access)}`));
    if (flight.access.kind === 'eligible') goToApp();
    else if (flight.access.kind === 'boarded') { await refresh(); setFocusPass(true); }
    else setPersonal(flight.access);
  }, [copy, goToApp, refresh]);

  // Back from sign-in ("Board now" or an invite): continue where the person was, once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('board') && !params.has('invite')) return;
    window.history.replaceState(null, '', '/board');
    storage()?.removeItem(FLIGHT_RETURN_KEY);
    if (params.has('invite')) setShowInvite(true);
    // A link/code proved access before sign-in: continue through the existing Privy login and return here. The pending HttpOnly
    // proof stays server-checked and binds only on checkAccess's explicit Board now request after authentication.
    else if (initial?.phase === 'BOARDING') void checkAccess();
  }, []); // Only on arrival.

  const board = (event: FormEvent) => {
    event.preventDefault();
    report('board_click');
    const text = prompt.trim();
    if (text) { report('prompt_submit'); storage()?.setItem(FLIGHT_DRAFT_KEY, text.slice(0, 500)); }
    else storage()?.removeItem(FLIGHT_DRAFT_KEY); // A route picked and then cleared is not carried to /app.
    void checkAccess();
  };

  const phase = state?.phase ?? null;
  // Founding seats closed: a yes/no from the server, never a count.
  const full = state !== null && !state.foundingOpen;
  // Nobody boards before boarding opens: the marquee says FINAL CALL until then ("Na última chamada a faixa rolante diz FINAL CALL").
  const marquee = useMemo(() => Array.from({ length: 6 }, () => phase === 'BOARDING' ? copy.marquee : copy.marqueeFinal), [copy, phase]);
  const inviteLink = !pass && <p className={styles.small}><button type="button" className={styles.linkButton} onClick={() => setShowInvite(value => !value)}>{copy.boarding.invite}</button></p>;

  let hero: ReactNode;
  if (!state) hero = <div className={styles.heroText}><h1 className={styles.srOnly}>Flight FloFi</h1><p className={styles.status}>{copy.unavailable}</p></div>;
  else if (personal?.kind === 'batch_closed') {
    const t = copy.batch, when = `${brt(personal.opensAt, { month: 'short', day: 'numeric' }, language)} ${language === 'PT' ? 'às' : 'at'} ${clockOf(personal.opensAt)}`;
    hero = <div className={`${styles.heroText} ${styles.onDark}`}>
      <div className={styles.board}>
        <Flaps text={t.onTheList} cells={14}/>
        <span className={styles.boardLabel}>{t.yourGroup}</span><Flaps text={t.group(personal.batch)} cells={10}/>
        <span className={styles.boardLabel}>{t.opens}</span>
        <Flaps text={`${brt(personal.opensAt, { month: 'short', day: '2-digit' }, 'EN').toUpperCase()} ${brt(personal.opensAt, { hour: '2-digit', minute: '2-digit', hour12: false }, 'EN')}`} cells={13} hi/>
      </div>
      <h1 id="flight-hero-title" tabIndex={-1}>{t.title[0]}<span className={styles.accentPeri}>{t.title[1]}</span></h1>
      <p className={styles.heroBody}>{t.body(when)}</p>
      <div className={styles.ctaRow}>
        <a className={`${styles.btn} ${styles.btnBlue}`} download="flight-flofi.ics" href={`data:text/calendar;charset=utf-8,${encodeURIComponent(calendarFile(personal.opensAt, language))}`}>{t.calendar}</a>
      </div>
      <p className={styles.small}>{t.invite} <button type="button" className={styles.linkButton} onClick={() => setShowInvite(true)}>{t.useIt}</button></p>
      {showInvite && <InviteForm key="invite" copy={copy} now={state.now} opensAt={state.boardingOpensAt} onRedeemed={() => { setPersonal(null); void refresh(); }}/>}
    </div>;
  } else if (personal?.kind === 'not_listed') {
    const t = copy.notListed;
    hero = <div className={`${styles.heroText} ${styles.onDark}`}>
      <div className={styles.board}>
        <Flaps text={t.board[0]} cells={12}/>
        <span className={styles.boardLabel}>{t.labels[0]}</span><Flaps text={t.board[1]} cells={12} hi/>
        <span className={styles.boardLabel}>{t.labels[1]}</span><Flaps text={t.board[2]} cells={12}/>
      </div>
      <h1 id="flight-hero-title" tabIndex={-1}>{t.title[0]}<span className={styles.accentPeri}>{t.title[1]}</span></h1>
      <p className={styles.heroBody}>{t.body}</p>
      <p ref={joinedStatus} tabIndex={-1} className={nextJoined ? styles.status : styles.srOnly} role="status">{nextJoined ? t.joined : ''}</p>
      {state.phase === 'BOARDING' && <AccessForms copy={copy} language={language} onClaimed={claimed}/>}
      {nextJoined ? null : state.me.hasEmail ? <div className={styles.ctaRow}>
        <button type="button" className={`${styles.btn} ${styles.btnBlue}`} onClick={async () => {
          const answer = await post('/api/board/list', { language, consent: true });
          if (answer.ok) setNextJoined(true); else setMessage(errorText(copy, answer.code));
        }}>{t.next}</button>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { report('share_click', 'not_listed'); shareOnX(copy.share.notListed(boardingDay(state.boardingOpensAt, language))); }}>{t.share}</button>
      </div> : <>
        <ListForm copy={copy} language={language} flight="NEXT" onJoined={() => setNextJoined(true)}/>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { report('share_click', 'not_listed'); shareOnX(copy.share.notListed(boardingDay(state.boardingOpensAt, language))); }}>{t.share}</button>
      </>}
      <p className={styles.notice}><ListNotice copy={copy} language={language}/></p>
      <p className={styles.small}>{copy.batch.invite} <button type="button" className={styles.linkButton} onClick={() => setShowInvite(true)}>{copy.batch.useIt}</button></p>
      {showInvite && <InviteForm key="invite" copy={copy} now={state.now} opensAt={state.boardingOpensAt} onRedeemed={() => { setPersonal(null); void refresh(); }}/>}
      {message && <p className={styles.error} role="alert">{message}</p>}
    </div>;
  } else if (phase === 'FINAL_CALL' || phase === 'GATE_CLOSED') {
    const gate = phase === 'GATE_CLOSED', t = gate ? copy.gateClosed : copy.finalCall;
    // The boarding day and time come from the deployment's campaign calendar (the server state), never from the copy.
    const eyebrow = gate ? copy.gateClosed.eyebrow : copy.finalCall.eyebrow(boardingDay(state.boardingOpensAt, language));
    const body = gate ? copy.gateClosed.body(clockOf(state.boardingOpensAt)) : copy.finalCall.body;
    hero = <div className={styles.heroText}>
      <span className={`${styles.lbl} ${styles.eyebrow}`}>{eyebrow}</span>
      <h1>{t.title[0]}<span className={styles.accentLight}>{t.title[1]}</span></h1>
      <p className={styles.heroBody}>{body}</p>
      {!gate && <><span className={`${styles.lbl} ${styles.eyebrow}`}>{copy.finalCall.closesIn}</span><Countdown state={state} copy={copy}/></>}
      <ListForm copy={copy} language={language} flight={gate ? 'NEXT' : 'FIRST'} onJoined={() => undefined}/>
      <div className={styles.metaRow}>
        <span className={styles.notice}><ListNotice copy={copy} language={language}/></span>
      </div>
      {inviteLink}
      {showInvite && !pass && <InviteForm key="invite" copy={copy} now={state.now} opensAt={state.boardingOpensAt} onRedeemed={() => void refresh()}/>}
    </div>;
  } else {
    const t = copy.boarding;
    hero = <div className={styles.heroText}>
      {full ? <div className={styles.fullBanner} role="note"><span>{copy.foundingFull.banner}</span><span>{copy.foundingFull.seats}</span></div>
        : <span className={`${styles.lbl} ${styles.eyebrow}`}>{t.eyebrow}</span>}
      <h1 id="flight-hero-title" tabIndex={-1}>{t.title[0]}{t.title[1]}</h1>
      <p className={styles.heroBody}>{full ? <>{copy.foundingFull.body[0]}<b>{copy.foundingFull.body[1]}</b></> : <>{t.body[0]}<b>{t.body[1]}</b></>}</p>
      <form className={styles.pill} onSubmit={board}>
        <label className={styles.pillTo} htmlFor="flight-prompt">{t.to}<span className={styles.srOnly}> · {t.promptLabel}</span></label>
        <input id="flight-prompt" autoComplete="off" maxLength={500} placeholder={full ? copy.foundingFull.placeholder : t.placeholder} value={prompt} onChange={e => setPrompt(e.target.value)}/>
        <button className={`${styles.btn} ${styles.btnNavy}`} type="submit" disabled={busy}>{t.board} <span aria-hidden="true">→</span></button>
      </form>
      <p className={message ? styles.status : styles.srOnly} role="status">{message ?? ''}</p>
      <p id="flight-access-notice" tabIndex={-1} className={accessNotice ? styles.status : styles.srOnly} role="status">{accessNotice ?? ''}</p>
      {!accessNotice && state.me.accessPending && <p className={styles.status}>{copy.access.pendingSignIn}</p>}
      <div className={styles.metaRow}>
        <span className={styles.meta}>{full ? copy.passengerSeats : copy.closedBeta}</span>
        {!pass && <><span className={styles.dot} aria-hidden="true"/><button type="button" className={styles.linkButton} onClick={() => setShowInvite(value => !value)}>{t.invite}</button></>}
      </div>
      {showInvite && !pass && <InviteForm key="invite" copy={copy} now={state.now} opensAt={state.boardingOpensAt} onRedeemed={() => void refresh()}/>}
      {/* On the list with another email, or on another device: a link and a code by email, or the code typed here (signed in or not). */}
      {!pass && !accessNotice && <p className={styles.small}><button type="button" className={styles.linkButton} aria-expanded={showAccess}
        onClick={() => setShowAccess(value => !value)}>{copy.access.otherEmail}</button></p>}
      {showAccess && !pass && <AccessForms copy={copy} language={language} onClaimed={claimed} intro={false}/>}
    </div>;
  }

  const dark = personal !== null;
  const sticker = !state ? null : dark ? null : phase === 'FINAL_CALL' ? copy.finalCall.sticker : phase === 'GATE_CLOSED' ? copy.gateClosed.sticker : copy.boarding.sticker;
  return <>
    <section id="top" className={`${styles.hero}${dark ? ` ${styles.heroDark}` : ''}`} aria-label="Flight FloFi">
      {hero}
      {!dark && <div className={styles.heroArt} aria-hidden="true">
        <img className={styles.mascot} src="/brand/flight/gota-welcome.svg" alt=""/>
        {sticker && <span className={styles.sticker}>{sticker}</span>}
      </div>}
      {dark && personal?.kind === 'not_listed' && <div className={styles.heroArt} aria-hidden="true">
        <img className={styles.mascot} src="/brand/flight/gota-safety.svg" alt=""/>
      </div>}
      <div className={styles.marquee}>
        <div className={`${styles.track}${paused ? ` ${styles.paused}` : ''}`} aria-hidden="true">{marquee.map((text, index) => <span key={index}>{text}</span>)}</div>
        {/* Moving text can be stopped (WCAG 2.2.2); reduced-motion settings stop it already. */}
        <button type="button" className={styles.marqueeToggle} aria-pressed={paused} aria-label={copy.marqueePause} onClick={() => setPaused(value => !value)}>
          <span aria-hidden="true">{paused ? '▶' : '❚❚'}</span></button>
      </div>
    </section>
    {pass && <PassPanel pass={pass} invites={state?.me.flight?.invites ?? []} copy={copy}
      onPass={next => setState(s => s && s.me.flight ? { ...s, me: { ...s.me, flight: { ...s.me.flight, pass: next } } } : s)}/>}
    {state && state.phase === 'BOARDING' && state.departures.length > 0 && <section className={styles.departures} aria-labelledby="departures-title">
      <div className={styles.departuresHead}>
        <div className={styles.sectionHead}>
          <span className={styles.lbl}>{copy.departures.eyebrow}</span>
          <h2 className={styles.h2} id="departures-title">{copy.departures.title[0]}<span className={styles.accentPeri}>{copy.departures.title[1]}</span></h2>
        </div>
        <span className={`${styles.meta} ${styles.muted}`}>{copy.departures.updated(brt(state.now, { hour: '2-digit', minute: '2-digit', hour12: false }, 'EN'))}</span>
      </div>
      <div className={styles.departuresBoard}>
        <table>
          <caption className={styles.srOnly}>{copy.departures.caption}</caption>
          <thead><tr>{copy.departures.head.map(head => <th key={head} scope="col">{head}</th>)}</tr></thead>
          <tbody>{state.departures.map((departure, index) => <tr key={`${departure.seat}-${index}`}>
            <td><Flaps text={`@${departure.handle}`} cells={13}/></td>
            <td><Flaps text={`${departure.from} → ${departure.to}`} cells={11} hi/></td>
            <td><Flaps text={String(departure.steps)} cells={2}/></td>
            <td><Flaps text={departure.seat} cells={4}/></td>
            <td><Flaps text={copy.departures.boarded} hi/></td>
          </tr>)}</tbody>
        </table>
        {/* Phones: the same departures stacked, the handle over its route, steps and seat (the table is hidden there). */}
        <ol className={styles.departuresList} aria-label={copy.departures.caption}>{state.departures.map((departure, index) => <li key={`${departure.seat}-${index}`}>
          <Flaps text={`@${departure.handle}`}/>
          <span className={styles.departuresLine}>
            <Flaps text={`${departure.from} → ${departure.to}`} hi label={`${copy.departures.head[1]}: ${departure.from} → ${departure.to}`}/>
            <Flaps text={String(departure.steps)} label={`${copy.departures.head[2]}: ${departure.steps}`}/>
            <Flaps text={departure.seat} label={`${copy.departures.head[3]}: ${departure.seat}`}/>
          </span>
        </li>)}</ol>
      </div>
    </section>}
  </>;
}

/** "Use this route": fills the hero's request (Now boarding) or keeps it for after boarding opens, and scrolls to the hero. */
export function RouteButton({ prompt, routeId, label }: { prompt: string; routeId: string; label: string }) {
  return <button type="button" className={`${styles.btn} ${styles.btnBlue}`} onClick={() => {
    report('route_example_click', routeId);
    storage()?.setItem(FLIGHT_DRAFT_KEY, prompt);
    window.dispatchEvent(new CustomEvent('flight:route', { detail: prompt }));
    document.getElementById('top')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }}>{label}</button>;
}
