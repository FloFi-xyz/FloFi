// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * The sign-in screen between the landing page and the app (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001).
 * Google, Email and Web3 Wallet (Apple once configured), all completed in Privy. FloFi's server then verifies Privy's access token and
 * reads the person's identities from Privy itself (privy-server.ts); the browser never decides who is signed in. A method this
 * deployment cannot run is shown disabled with the reason, never simulated. Signing in approves nothing and moves no funds.
 *
 * No automatic reconnection: a Privy session left in this browser (for example right after Disconnect) never signs anyone in by itself.
 * Only a sign-in the person completes on this page (or Google's redirect back to it) reaches FloFi's server; anything else is logged out.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { privyMoveToExisting, privySignIn, type AccountState } from '../../app/account-action';
import { useFloFiPrivy } from '../../accounts/privy-client';
import { rememberSignIn } from '../../wallet/sign-in-wallet';
import { invalidateSavedRecipients } from '../../state/saved-recipients-store';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import { currentSignInPage, signInCallFailure, SIGN_IN_PAGE_OUTDATED } from './sign-in-failure';
import { AccountShell, accountStyles as styles } from './account-shell';

type Method = 'google' | 'apple' | 'email' | 'wallet';
/** Whether this page load is Privy's OAuth redirect back (its completion then signs the person in). */
const oauthReturn = () => typeof window !== 'undefined' && /[?&]privy_oauth_(?:code|state)=/.test(window.location.search);
/** Removes Privy's OAuth return from the address, so a reload never tries to finish that return again. */
function stripOAuthReturn() {
  const url = new URL(window.location.href);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('privy_oauth_')) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
/**
 * Authentication UX & Login Regression Fix (P0): a return from Google that Privy has not finished within this time is ended (with a reason).
 * Privy's real SDK finishes nothing — no completion, no error — when a session already existed in the browser and has Google; the page then
 * waited on "Signing you in…" forever.
 */
export const OAUTH_RETURN_TIMEOUT_MS = 20_000;
/** How long the page waits for Privy to load before saying the wallet provider could not be reached (the methods stay disabled until it loads). */
export const PRIVY_READY_TIMEOUT_MS = 15_000;
export const SIGN_IN_INTERRUPTED = 'PRIVY_SIGN_IN_INTERRUPTED';

/** BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: the sign-in methods of another account, named by kind only (never an address). */
export const METHOD_KIND_LABEL: Readonly<Record<string, string>> = { google: 'Google', apple: 'Apple', email: 'Email code', eip155: 'Web3 wallet', solana: 'Solana wallet' };
export function SignInScreen({ state, initialError, returnTo, mode = null, moving = [] }: { state: AccountState; initialError: string | null; returnTo: string;
  /** `reauth`: confirm the account already signed in (a step-up). `move`: sign in to the account that keeps everything (a duplicate is closing). */
  mode?: 'reauth' | 'move' | null; moving?: readonly { readonly kind: string; readonly hint: string | null }[] }) {
  const { t } = useLocale();
  const privy = useFloFiPrivy();
  const [open, setOpen] = useState<Method | null>(null);
  const [busy, setBusy] = useState<Method | 'finish' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState<string | null>(null), [notice, setNotice] = useState('');
  const emailId = useId(), codeId = useId(), statusId = useId();
  /** BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: a new account would be created for an email another account already verified (its method kinds). */
  const [existing, setExisting] = useState<readonly string[] | null>(null);
  /** Set when the person started a sign-in on this page; a Privy session without it is never used. */
  const started = useRef(false), finishing = useRef(false), cleared = useRef(false), returning = useRef(false);
  /**
   * Authentication UX & Login Regression Fix (P0): no method starts while Privy is loading or while a Privy session left in this browser (an
   * earlier sign-in, a sign-out that only ended FloFi's session, the account being closed) is still being ended. With Privy's real SDK a login
   * started over a live session is ignored ("already logged in"), a wallet signature fails ("User already authenticated") and a Google return
   * is finished as a LINK to that session's user, or not at all: the person saw "Sign-in did not complete" or waited forever.
   */
  const [prepared, setPrepared] = useState(false);
  useEffect(() => { if (oauthReturn()) { started.current = true; returning.current = true; setBusy('finish'); } }, []);
  const available = state.availability, configured = privy !== null;
  /** Ends a sign-in that cannot finish here (nothing was signed in at FloFi): the return is removed and the Privy session ended. */
  const interrupt = async (code: string) => {
    if (finishing.current) return;
    if (returning.current) { stripOAuthReturn(); returning.current = false; }
    started.current = false; setBusy(null); setError(code);
    await privy?.logout();
  };

  /** Hands the completed Privy sign-in to FloFi's server, which verifies it and opens the FloFi session. */
  async function finish(allowNew = false) {
    if (!privy || finishing.current) return;
    finishing.current = true; setBusy('finish'); setError(null); setExisting(null);
    const token = await privy.getAccessToken();
    const result = token ? await privySignIn(token, returnTo, { allowNew, ...mode ? { mode } : {} })
      .catch((cause: unknown) => ({ ok: false as const, code: signInCallFailure(cause) })) : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
    // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: the verified sign-in re-allows silent restore of the wallet just used (no prompt, no authority).
    if (result.ok) { rememberSignIn(result.value.method); invalidateSavedRecipients(); window.location.assign(result.value.next); return; }
    // Nothing was created: the person chooses between the account that already has this email and a separate account (the Privy session stays
    // for "Create a separate account"; "Use another method" ends it).
    if (result.code === 'ACCOUNT_EXISTS_FOR_EMAIL' && 'kinds' in result && Array.isArray(result.kinds)) {
      finishing.current = false; setBusy(null); setExisting((result.kinds as unknown[]).filter((kind): kind is string => typeof kind === 'string'));
      return;
    }
    // A refused sign-in leaves no Privy session behind either, so the next attempt starts clean.
    await privy.logout();
    // HOTFIX-FLOFI-PRODUCTION-RECOVERY-001: this page belongs to an earlier deployment, whose sign-in call no longer exists. Retrying here
    // would fail forever; the current deployment's page is loaded instead, saying why (nothing was signed in).
    if (result.code === SIGN_IN_PAGE_OUTDATED) { window.location.replace(currentSignInPage(returnTo)); return; }
    finishing.current = false; started.current = false; setBusy(null); setError(result.code);
  }
  useEffect(() => {
    if (!privy) return;
    // Only a login this page just completed signs in. A session that already existed (Privy reports `wasAlreadyAuthenticated`) is never
    // turned into a FloFi sign-in, even when the URL looks like an OAuth return: it is ended instead — and on a return from Google, the person is
    // told so (Privy cannot finish that return as a sign-in while another session was open), never left waiting.
    const offLogin = privy.onLogin(event => {
      if (!event.wasAlreadyAuthenticated) { if (started.current) void finish(); return; }
      if (finishing.current) return;
      if (returning.current) { void interrupt(SIGN_IN_INTERRUPTED); return; }
      started.current = false; setBusy(null); void privy.logout();
    });
    const offError = privy.onLoginError(failure => {
      started.current = false; setBusy(null); setError(failure);
      // A sign-in Privy refused because another session was still open: that session is ended, so the next attempt starts clean.
      if (failure === SIGN_IN_INTERRUPTED) { if (returning.current) { stripOAuthReturn(); returning.current = false; } void privy.logout(); }
    });
    return () => { offLogin(); offError(); };
  }); // re-subscribes with the latest `privy` on every render
  useEffect(() => {
    // A Privy session that this page did not just complete (left over from before, or after Disconnect) is ended, never reused — and the
    // methods are offered only once it has ended.
    if (!privy?.ready || cleared.current) return;
    cleared.current = true;
    if (privy.authenticated && !started.current) void privy.logout().finally(() => setPrepared(true));
    else setPrepared(true);
  }, [privy?.ready]);
  useEffect(() => {
    // Privy did not load: say so (the methods stay disabled; they are offered as soon as it loads).
    if (!privy || privy.ready) return;
    const timer = setTimeout(() => setError(current => current ?? 'PRIVY_UNAVAILABLE'), PRIVY_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [privy, privy?.ready]);
  useEffect(() => { if (prepared) setError(current => current === 'PRIVY_UNAVAILABLE' ? null : current); }, [prepared]);
  useEffect(() => {
    // A return from Google that Privy has not finished in time is ended with a reason, never left on "Signing you in…".
    if (!privy?.ready || !returning.current) return;
    const timer = setTimeout(() => { if (returning.current && !finishing.current) void interrupt(SIGN_IN_INTERRUPTED); }, OAUTH_RETURN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [privy?.ready]);

  /**
   * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: bring this just-verified sign-in to the account that already has the email: FloFi starts the move (the
   * server checks everything), then the person signs in to that account to confirm it and link this method there.
   */
  async function addToExisting() {
    if (!privy || finishing.current) return;
    finishing.current = true; setBusy('finish'); setError(null);
    const token = await privy.getAccessToken();
    const result = token ? await privyMoveToExisting(token).catch((cause: unknown) => ({ ok: false as const, code: signInCallFailure(cause) }))
      : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
    await privy.logout();
    if (result.ok) { window.location.assign(result.value.next); return; }
    finishing.current = false; started.current = false; setBusy(null); setExisting(null); setError(result.code);
  }
  async function begin(method: Method, run: () => Promise<void> | void) {
    setError(null); setNotice(''); started.current = true; setBusy(method);
    // Never over a live Privy session (see `prepared`): one that appeared since the page loaded is ended first.
    if (privy?.authenticated) await privy.logout();
    try { await run(); } catch (cause) { started.current = false; setBusy(null); setError(cause instanceof Error ? cause.message : 'PRIVY_SIGN_IN_FAILED'); return; }
    // OAuth navigates away; the wallet chooser and the email code answer through `onLogin` / `onLoginError`.
    if (method === 'wallet') setBusy(null);
  }
  async function sendCode(event?: { preventDefault(): void }) {
    event?.preventDefault();
    if (!privy) return;
    // The old code is cleared when the new one is requested, never after: a code typed while the request runs is kept.
    setError(null); setNotice(''); setCode(''); setBusy('email');
    try {
      await privy.sendEmailCode(email.trim());
      if (sent) setNotice(t('A new code was sent to {0}.', email.trim()));
      setSent(email.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PRIVY_EMAIL_CODE_FAILED'); }
    setBusy(null);
  }
  async function verify(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!privy) return;
    await begin('email', async () => {
      await privy.loginWithEmailCode(code);
      // Privy also reports the completion through `onLogin`; `finish` runs once either way.
      await finish();
    });
  }

  const unavailable = (method: Method) => !configured || !available[method];
  const methodButton = (method: Method, label: string, icon: 'apple' | 'google' | 'email' | 'wallet', onClick: () => void) => {
    const disabled = unavailable(method);
    return <button type="button" className={styles.method} onClick={onClick} disabled={disabled || !prepared || (busy !== null && busy !== method)}
      aria-expanded={method === 'email' ? open === method : undefined} aria-describedby={disabled ? statusId : undefined}
      title={disabled ? t('Not available on this deployment yet') : undefined}>
      <AccountIcon name={icon}/><span>{t(label)}{busy === method && method !== 'email' ? <small>{t('Opening…')}</small> : null}</span></button>;
  };

  return <AccountShell showcase="account">
    <h1 className={styles.title}>{t('Sign in')}<span>{t('your way')}</span></h1>
    <p className={styles.lead}>{t('Sign in to your FloFi account or create one with Google, your email or your wallet.')}</p>
    {!available.accounts && <div className={styles.banner} role="status"><strong>{t("Accounts aren't available on this deployment yet.")}</strong>
      <p>{t('You can still build workflows and use your own wallet in FloFi without an account.')}</p>
      <a className={styles.primary} href="/app">{t('Continue to FloFi')}</a></div>}
    {available.accounts && !available.google && <div className={styles.banner} role="status"><strong>{t("Sign-in isn't configured on this deployment yet.")}</strong>
      <p>{t('You can still build workflows and use your own wallet in FloFi without an account.')}</p></div>}
    {mode === 'reauth' && <div className={styles.banner} role="status" data-sign-in-mode="reauth"><strong>{t('Confirm it’s you')}</strong>
      <p>{t('Sign in again with the same method.')}</p></div>}
    {mode === 'move' && <div className={styles.banner} role="status" data-sign-in-mode="move"><strong>{t('Sign in to the account that keeps everything')}</strong>
      <p>{t('Use the method you boarded with, not {0}.', [...new Set(moving.map(method => t(METHOD_KIND_LABEL[method.kind] ?? method.kind)))].join(', '))}</p></div>}
    {existing && <div className={styles.banner} role="alert" data-existing-account="true"><strong>{t('This email already belongs to a FloFi account.')}</strong>
      <p>{t('That account signs in with {0}.', existing.map(kind => t(METHOD_KIND_LABEL[kind] ?? kind)).join(', '))}</p>
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={() => void addToExisting()}>{t('Add this sign-in to that account')}</button>
        <button type="button" className={styles.textLink} onClick={() => { setExisting(null); started.current = false; void privy?.logout(); }}>{t('Use another sign-in method')}</button>
        <button type="button" className={styles.textLink} onClick={() => { started.current = true; void finish(true); }}>{t('Create a separate account')}</button>
      </div></div>}
    {busy === 'finish' ? <p className={styles.status} role="status" data-signing-in="true">{t('Signing you in…')}</p> : existing ? null : <>
      <div className={styles.methods} role="group" aria-label={t('Sign-in methods')}>
        {methodButton('google', 'Google', 'google', () => void begin('google', () => privy!.loginWithOAuth('google')))}
        {available.apple && methodButton('apple', 'Apple', 'apple', () => void begin('apple', () => privy!.loginWithOAuth('apple')))}
        {methodButton('email', 'Email', 'email', () => { setError(null); setOpen(open === 'email' ? null : 'email'); })}
        {methodButton('wallet', 'Web3 Wallet', 'wallet', () => void begin('wallet', () => privy!.loginWithWallet()))}
      </div>
      {open === 'email' && !unavailable('email') && (sent === null ? <form className={styles.form} onSubmit={event => void sendCode(event)} aria-label={t('Email sign-in')}>
        <label htmlFor={emailId}>{t('Email address')}</label>
        <input id={emailId} className={styles.input} type="email" inputMode="email" autoComplete="email" required maxLength={254} value={email} autoFocus
          onChange={event => setEmail(event.currentTarget.value)} placeholder="you@example.com"/>
        <button type="submit" className={styles.primary} disabled={busy !== null || !email.includes('@')}>{t(busy === 'email' ? 'Sending code…' : 'Email me a code')}</button>
      </form> : <form className={styles.form} onSubmit={event => void verify(event)} aria-label={t('Enter your code')}>
        <label htmlFor={codeId}>{t('Enter the 6-digit code we sent to {0}', sent ?? '')}</label>
        <input id={codeId} className={`${styles.input} ${styles.code}`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus
          value={code} onChange={event => setCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))}/>
        <button type="submit" className={styles.primary} disabled={busy !== null || code.length !== 6}>{t(busy === 'email' ? 'Verifying…' : 'Verify and continue')}</button>
        <div className={styles.row}><button type="button" className={styles.textLink} onClick={() => void sendCode()} disabled={busy !== null}>{t('Send a new code')}</button>
          <button type="button" className={styles.textLink} onClick={() => { setSent(null); setCode(''); }}>{t('Use another email')}</button></div>
      </form>)}
    </>}
    <p id={statusId} className={styles.status} role="status">{notice || (configured && !prepared && busy === null ? t('Getting sign-in ready…') : '')}</p>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    <div className={styles.notice}><span className={styles.noticeIcon}><AccountIcon name="shield" size={18}/></span><div>
      <strong>{t('Nothing executes without your review')}</strong>
      <p>{t('Your account is how you sign in. Transactions are always simulated, reviewed and signed by your own wallet.')}</p></div></div>
    <div className={styles.footerLinks}><a href="/app">{t('Explore the builder without an account')}</a><a href="/privacy">{t('Privacy')}</a></div>
  </AccountShell>;
}
