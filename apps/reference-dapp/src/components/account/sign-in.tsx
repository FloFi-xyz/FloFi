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
import { privySignIn, type AccountState } from '../../app/account-action';
import { useFloFiPrivy } from '../../accounts/privy-client';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import { AccountShell, accountStyles as styles } from './account-shell';

type Method = 'google' | 'apple' | 'email' | 'wallet';
/** Whether this page load is Privy's OAuth redirect back (its completion then signs the person in). */
const oauthReturn = () => typeof window !== 'undefined' && /[?&]privy_oauth_(?:code|state)=/.test(window.location.search);

export function SignInScreen({ state, initialError, returnTo }: { state: AccountState; initialError: string | null; returnTo: string }) {
  const { t } = useLocale();
  const privy = useFloFiPrivy();
  const [open, setOpen] = useState<Method | null>(null);
  const [busy, setBusy] = useState<Method | 'finish' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState<string | null>(null), [notice, setNotice] = useState('');
  const emailId = useId(), codeId = useId(), statusId = useId();
  /** Set when the person started a sign-in on this page; a Privy session without it is never used. */
  const started = useRef(false), finishing = useRef(false), cleared = useRef(false);
  useEffect(() => { if (oauthReturn()) { started.current = true; setBusy('finish'); } }, []);
  const available = state.availability, configured = privy !== null;

  /** Hands the completed Privy sign-in to FloFi's server, which verifies it and opens the FloFi session. */
  async function finish() {
    if (!privy || finishing.current) return;
    finishing.current = true; setBusy('finish'); setError(null);
    const token = await privy.getAccessToken();
    const result = token ? await privySignIn(token, returnTo).catch(() => ({ ok: false as const, code: 'PRIVY_SIGN_IN_FAILED' }))
      : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
    if (result.ok) { window.location.assign(result.value.next); return; }
    // A refused sign-in leaves no Privy session behind either, so the next attempt starts clean.
    await privy.logout();
    finishing.current = false; started.current = false; setBusy(null); setError(result.code);
  }
  useEffect(() => {
    if (!privy) return;
    const offLogin = privy.onLogin(() => { if (started.current) void finish(); });
    const offError = privy.onLoginError(failure => { started.current = false; setBusy(null); setError(failure); });
    return () => { offLogin(); offError(); };
  }); // re-subscribes with the latest `privy` on every render
  useEffect(() => {
    // A Privy session that this page did not just complete (left over from before, or after Disconnect) is ended, never reused.
    if (!privy?.ready || cleared.current) return;
    cleared.current = true;
    if (privy.authenticated && !started.current) void privy.logout();
  }, [privy?.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  async function begin(method: Method, run: () => Promise<void> | void) {
    setError(null); setNotice(''); started.current = true; setBusy(method);
    try { await run(); } catch (cause) { started.current = false; setBusy(null); setError(cause instanceof Error ? cause.message : 'PRIVY_SIGN_IN_FAILED'); return; }
    // OAuth navigates away; the wallet chooser and the email code answer through `onLogin` / `onLoginError`.
    if (method === 'wallet') setBusy(null);
  }
  async function sendCode(event?: { preventDefault(): void }) {
    event?.preventDefault();
    if (!privy) return;
    setError(null); setNotice(''); setBusy('email');
    try {
      await privy.sendEmailCode(email.trim());
      if (sent) setNotice(t('A new code was sent to {0}.', email.trim()));
      setSent(email.trim()); setCode('');
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
    return <button type="button" className={styles.method} onClick={onClick} disabled={disabled || (busy !== null && busy !== method)}
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
    {busy === 'finish' ? <p className={styles.status} role="status" data-signing-in="true">{t('Signing you in…')}</p> : <>
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
    <p id={statusId} className={styles.status} role="status">{notice || (available.accounts && !configured ? t('Methods shown as unavailable are not configured on this deployment yet.') : '')}</p>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    {available.accounts && <p className={styles.small} style={{ textAlign: 'left' }}>{t('FloFi stores your sign-in identity (email address or provider ID) and the public addresses of wallets you save, never a key. You can delete your account in Credentials.')} <a href="/privacy">{t('Privacy')}</a></p>}
    <div className={styles.notice}><span className={styles.noticeIcon}><AccountIcon name="shield" size={18}/></span><div>
      <strong>{t('Nothing executes without your review')}</strong>
      <p>{t('Your account is how you sign in. Transactions are always simulated, reviewed and signed by your own wallet.')}</p></div></div>
    <div className={styles.footerLinks}><a href="/app">{t('Explore the builder without an account')}</a><a href="/privacy">{t('Privacy')}</a></div>
  </AccountShell>;
}
