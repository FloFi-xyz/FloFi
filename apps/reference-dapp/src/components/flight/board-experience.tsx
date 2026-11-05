// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-FLIGHT-001: the live parts of /board. The page shows one of the approved states, chosen by the server's real data:
 * 1 Final call (until the list closes; the night before boarding uses the approved "Gate closed" post), 2 Now boarding, 3 group still
 * closed, 4 not on the list, 5 Founding full — and the person's own pass once issued. "Board now" signs the person in when needed,
 * checks list, group and invite, and opens /app with their request as an editable draft. Nothing here signs, simulates or moves funds.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { FLIGHT_BOARDING_KEY, FLIGHT_DRAFT_KEY, FLIGHT_RETURN_KEY } from '../../flight/app-boarding';
import type { FlightState } from '../../flight/http';
import type { FlightAccess } from '../../flight/campaign';
import type { FlightPass, OwnInvite } from '../../flight/store';
import { Flaps, FoundingPass, PassengerPass } from './boarding-pass';
import { FLIGHT_COPY, type FlightCopy } from './flight-copy';
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
const number = (n: number, language: Language) => n.toLocaleString(language === 'PT' ? 'pt-BR' : 'en-US');
const brt = (ms: number, options: Intl.DateTimeFormatOptions, language: Language) =>
  new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en-US', { timeZone: 'America/Sao_Paulo', ...options }).format(new Date(ms));
/** "9:00": the approved board's 24-hour Brazilian time, without a leading zero. */
function clockOf(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return `${Number(parts.find(part => part.type === 'hour')?.value ?? 0)}:${parts.find(part => part.type === 'minute')?.value ?? '00'}`;
}
function errorText(copy: FlightCopy, code: string | undefined) {
  return (copy.errors as Record<string, string>)[code ?? ''] ?? copy.errors.generic;
}
function shareOnX(text: string) {
  const url = `https://x.com/intent/post?${new URLSearchParams({ text, url: 'https://flofi.xyz/board' })}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** The remaining time to the list closing, in whole minutes (server time, so the test clock and the real one agree). */
function useCountdown(target: number, serverNow: number) {
  const [offset] = useState(() => serverNow - Date.now());
  const [now, setNow] = useState(serverNow);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() + offset), 15_000); return () => clearInterval(timer); }, [offset]);
  const minutes = Math.max(0, Math.floor((target - now) / 60_000));
  return [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60] as const;
}

function Countdown({ state, copy }: { state: FlightState; copy: FlightCopy }) {
  const [d, h, m] = useCountdown(state.closesAt, state.now), t = copy.finalCall;
  const two = (n: number) => String(Math.min(n, 99)).padStart(2, '0');
  const word = (n: number, index: number) => `${n} ${t.unitWords[index]![n === 1 ? 0 : 1]}`;
  return <div className={styles.countdown} role="timer" aria-label={`${t.closesIn} ${word(d, 0)}, ${word(h, 1)}, ${word(m, 2)}`}>
    {[d, h, m].map((value, index) => <span key={index} className={styles.countGroup} aria-hidden="true">
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

function InviteForm({ copy, onRedeemed }: { copy: FlightCopy; onRedeemed: (flight: unknown) => void }) {
  const t = copy.inviteForm, [code, setCode] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
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
    <input id="flight-invite" autoComplete="off" spellCheck={false} placeholder={t.placeholder} value={code} onChange={e => setCode(e.target.value)} maxLength={16}/>
    <button className={`${styles.btn} ${styles.btnGhost}`} type="submit" disabled={busy || code.trim().length < 11}>{t.use}</button>
    <p className={message?.ok ? styles.status : styles.srOnly} role="status">{message?.ok ? message.text : ''}</p>
    {message && !message.ok && <p className={styles.error} role="alert">{message.text}</p>}
  </form>;
}

function calendarFile(opensAt: number, language: Language): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const summary = language === 'PT' ? 'Flight FloFi: embarque do seu grupo' : 'Flight FloFi: your group boards';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FloFi//Flight FloFi//EN', 'BEGIN:VEVENT', `UID:flight-${opensAt}@flofi.xyz`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(opensAt)}`, `DTEND:${stamp(opensAt + 3_600_000)}`, `SUMMARY:${summary}`, 'URL:https://flofi.xyz/board', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/** The person's own pass, their handle choice, their invites and sharing. */
function PassPanel({ pass, invites, copy, onPass }: { pass: FlightPass; invites: readonly OwnInvite[]; copy: FlightCopy; onPass: (pass: FlightPass) => void }) {
  const t = copy.pass, [handle, setHandle] = useState(pass.handle ?? ''), [visible, setVisible] = useState(pass.public), [message, setMessage] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    const answer = await post('/api/board/handle', { handle, public: visible });
    if (answer.ok) { onPass(answer.pass as FlightPass); setMessage(t.saved); } else setMessage(errorText(copy, answer.code));
  }
  return <>
    <section id="pass" tabIndex={-1} aria-label={t.yours}>{pass.foundingSeat ? <FoundingPass pass={pass} copy={copy}/> : <PassengerPass pass={pass} copy={copy}/>}</section>
    <div className={styles.passControls}>
      <section aria-labelledby="pass-handle-title">
        <h2 id="pass-handle-title">{t.handleLabel}</h2>
        <form onSubmit={save} className={styles.personal}>
          <label className={styles.field}>{t.handleLabel}<input type="text" value={handle} maxLength={16} autoComplete="off" spellCheck={false} placeholder="@handle"
            onChange={e => setHandle(e.target.value)}/></label>
          <label className={styles.check}><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)}/>{t.handlePublic}</label>
          <div className={styles.ctaRow}>
            <button className={`${styles.btn} ${styles.btnBlue}`} type="submit">{t.save}</button>
            <button className={`${styles.btn} ${styles.btnNavy}`} type="button" onClick={() => {
              report('share_click', pass.foundingSeat ? 'founding' : 'passenger');
              shareOnX(copy.share.pass(pass.foundingSeat ? `${t.foundingMember} ${pass.seat}` : pass.seat, `${pass.route.from} → ${pass.route.to}`));
            }}>{t.share}</button>
            <Link className={`${styles.btn} ${styles.btnBlue}`} href="/app">{t.open}</Link>
          </div>
          <p role="status" className={message ? styles.muted : styles.srOnly}>{message ?? ''}</p>
        </form>
      </section>
      {invites.length > 0 && <section aria-labelledby="pass-invites-title">
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
  // Departures and counters stay live while the page is visible.
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
    if (!answer.ok) { setMessage(errorText(copy, answer.code)); return; }
    const flight = answer.flight as { access: FlightAccess };
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
    else if (initial?.me.signedIn && initial.phase === 'BOARDING') void checkAccess();
  }, []); // Only on arrival.

  const board = (event: FormEvent) => {
    event.preventDefault();
    report('board_click');
    const text = prompt.trim();
    if (text) { report('prompt_submit'); storage()?.setItem(FLIGHT_DRAFT_KEY, text.slice(0, 500)); }
    else storage()?.removeItem(FLIGHT_DRAFT_KEY); // A route picked and then cleared is not carried to /app.
    void checkAccess();
  };

  const counters = state?.counters ?? null, phase = state?.phase ?? null;
  const full = counters !== null && counters.foundingLeft === 0;
  const marquee = useMemo(() => Array.from({ length: 6 }, () => copy.marquee), [copy]);

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
      {showInvite && <InviteForm key="invite" copy={copy} onRedeemed={() => { setPersonal(null); void refresh(); }}/>}
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
      <p className={nextJoined ? styles.status : styles.srOnly} role="status">{nextJoined ? t.joined : ''}</p>
      {nextJoined ? null : state.me.hasEmail ? <div className={styles.ctaRow}>
        <button type="button" className={`${styles.btn} ${styles.btnBlue}`} onClick={async () => {
          const answer = await post('/api/board/list', { language, consent: true });
          if (answer.ok) setNextJoined(true); else setMessage(errorText(copy, answer.code));
        }}>{t.next}</button>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { report('share_click', 'not_listed'); shareOnX(copy.share.notListed); }}>{t.share}</button>
      </div> : <>
        <ListForm copy={copy} language={language} flight="NEXT" onJoined={() => setNextJoined(true)}/>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { report('share_click', 'not_listed'); shareOnX(copy.share.notListed); }}>{t.share}</button>
      </>}
      <p className={styles.notice}><ListNotice copy={copy} language={language}/></p>
      <p className={styles.small}>{copy.batch.invite} <button type="button" className={styles.linkButton} onClick={() => setShowInvite(true)}>{copy.batch.useIt}</button></p>
      {showInvite && <InviteForm key="invite" copy={copy} onRedeemed={() => { setPersonal(null); void refresh(); }}/>}
      {message && <p className={styles.error} role="alert">{message}</p>}
    </div>;
  } else if (phase === 'FINAL_CALL' || phase === 'GATE_CLOSED') {
    const gate = phase === 'GATE_CLOSED', t = gate ? copy.gateClosed : copy.finalCall;
    hero = <div className={styles.heroText}>
      <span className={`${styles.lbl} ${styles.eyebrow}`}>{t.eyebrow}</span>
      <h1>{t.title[0]}<span className={styles.accentLight}>{t.title[1]}</span></h1>
      <p className={styles.heroBody}>{t.body}</p>
      {!gate && <><span className={`${styles.lbl} ${styles.eyebrow}`}>{copy.finalCall.closesIn}</span><Countdown state={state} copy={copy}/></>}
      <ListForm copy={copy} language={language} flight={gate ? 'NEXT' : 'FIRST'} onJoined={() => { if (!gate) void refresh(); }}/>
      <div className={styles.metaRow}>
        <span className={styles.meta}>{copy.finalCall.onList(number(state.counters.onList, language))}</span>
        <span className={styles.notice}><ListNotice copy={copy} language={language}/></span>
      </div>
    </div>;
  } else {
    const t = copy.boarding;
    hero = <div className={styles.heroText}>
      {full ? <div className={styles.fullBanner} role="note"><span>{copy.foundingFull.banner}</span><span>100 / 100</span></div>
        : <span className={`${styles.lbl} ${styles.eyebrow}`}>{t.eyebrow}</span>}
      <h1>{t.title[0]}{t.title[1]}</h1>
      <p className={styles.heroBody}>{full ? <>{copy.foundingFull.body[0]}<b>{copy.foundingFull.body[1]}</b></> : <>{t.body[0]}<b>{t.body[1]}</b></>}</p>
      <form className={styles.pill} onSubmit={board}>
        <label className={styles.pillTo} htmlFor="flight-prompt">{t.to}<span className={styles.srOnly}> · {t.promptLabel}</span></label>
        <input id="flight-prompt" autoComplete="off" maxLength={500} placeholder={full ? copy.foundingFull.placeholder : t.placeholder} value={prompt} onChange={e => setPrompt(e.target.value)}/>
        <button className={`${styles.btn} ${styles.btnNavy}`} type="submit" disabled={busy}>{t.board} <span aria-hidden="true">→</span></button>
      </form>
      <p className={message ? styles.status : styles.srOnly} role="status">{message ?? ''}</p>
      <div className={styles.metaRow}>
        <span className={styles.meta}>{t.counters(number(state.counters.boarded, language))}</span>
        {!full && <><span className={styles.dot} aria-hidden="true"/><span className={`${styles.meta} ${styles.metaSoft}`}>{t.left(number(state.counters.foundingLeft, language))}</span></>}
        {!pass && <><span className={styles.dot} aria-hidden="true"/><button type="button" className={styles.linkButton} onClick={() => setShowInvite(value => !value)}>{t.invite}</button></>}
      </div>
      {showInvite && !pass && <InviteForm key="invite" copy={copy} onRedeemed={() => void refresh()}/>}
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
