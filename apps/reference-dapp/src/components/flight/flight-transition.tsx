// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * P0 hotfix (Flight transition): FloFi's branded full-screen state between the Flight pages and the product, so entering FloFi never
 * shows a half-styled page and never jumps abruptly:
 * - `FlightTransition`: "Checking your boarding…" while /board checks access, kept on screen until the next document replaces it;
 * - `FlightHandoff`: a FULL navigation (location.replace) to a fixed FloFi path, for a response that must not navigate inside the current
 *   document (a Server Action re-render or a client-router fetch; see src/server/flight-gate.ts). The destination always loads as its own
 *   document with its own CSS. It runs at once: no timer, no delay;
 * - `FlightGateScreen`: what the product layout renders when the Flight gate does not let the request in. Nothing of the workspace is
 *   rendered with it. "Try again" only reloads the page, whose server checks access again; nothing here grants or changes access.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { pageExitInProgress } from '../../accounts/page-exit';
import { useLocale } from '../../i18n/locale';
import styles from './flight-transition.module.css';

/** The paths a hand-off may load. Fixed: never a value from the URL or the person. */
export type FlightHandoffPath = '/board' | '/app';

function Logo() {
  return <img className={styles.logo} src="/brand/flight/flofi-logo-on-blue.svg" alt="FloFi"/>;
}

/** The busy state: the message is a status (announced); `focus` moves focus to it when it appears after the person's own action. */
export function FlightTransition({ message, focus = false, fade = false }: { message: ReactNode; focus?: boolean; fade?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) root.current?.focus(); }, [focus]);
  return <div ref={root} className={`${styles.screen}${fade ? ` ${styles.fadeIn}` : ''}`} role="status" aria-busy="true" tabIndex={-1} data-flight-transition="">
    <Logo/>
    {message ? <p className={styles.message}>{message}</p> : null}
    <span className={styles.dots} aria-hidden="true"><span/><span/><span/></span>
  </div>;
}

/**
 * A full navigation to `to`, at once, under the busy state. `replace`: Back does not return to the page that handed off. A page already
 * leaving on purpose (Disconnect, on its way to sign-in: src/accounts/page-exit.ts) is left to finish: no second navigation races it.
 */
export function FlightHandoff({ to, message }: { to: FlightHandoffPath; message: ReactNode }) {
  const [leaving] = useState(pageExitInProgress);
  useEffect(() => { if (!leaving) window.location.replace(to); }, [leaving, to]);
  return <FlightTransition message={leaving ? null : message}/>;
}

/** The access check could not run (the access store is unavailable): no product content, no hop to /board, a reload to try again. */
function FlightAccessRetry() {
  const { t } = useLocale(), titleId = useId(), [busy, setBusy] = useState(false);
  return <main className={styles.screen} aria-labelledby={titleId} data-flight-gate="retry">
    <Logo/>
    <h1 className={styles.title} id={titleId}>{t('We could not check your access')}</h1>
    <p className={styles.body}>{t('Your FloFi workspace opens once your Flight FloFi access is confirmed.')}</p>
    <button type="button" className={styles.action} disabled={busy} onClick={() => { setBusy(true); window.location.reload(); }}>{t('Try again')}</button>
  </main>;
}

/** The product layout's answer for a request the gate did not let in (see `flightGateResponse`). */
export function FlightGateScreen({ response }: { response: 'HANDOFF' | 'RETRY' }) {
  const { t } = useLocale();
  return response === 'HANDOFF' ? <FlightHandoff to="/board" message={t('Taking you to Flight FloFi…')}/> : <FlightAccessRetry/>;
}
