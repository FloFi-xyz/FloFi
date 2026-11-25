// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0): Sign-in methods — one FloFi account, several verified ways in.
 *
 * - Lists the account's sign-in methods (masked; never a provider subject).
 * - Links another method (Google, email code) to the account's own Privy user, after a recent sign-in (`linkReadiness`), and only then lets
 *   FloFi adopt it (`syncSignInMethods`): the server, reading Privy's API, decides what was linked. A method another account holds is never
 *   moved or merged.
 * - Moves a sign-in out of an EMPTY duplicate account, explicitly and with proof of control of both accounts: started signed in to the
 *   duplicate (a recent sign-in), confirmed signed in to the account that keeps everything. FloFi then closes the duplicate (it holds nothing:
 *   no wallet, pass, beta access, recipients or history) and its sign-in method can be linked here. Nothing else moves.
 * Nothing here signs, approves or executes anything.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { cancelAccountMove, completeAccountMove, linkReadiness, signInMethodsState, startAccountMove, syncSignInMethods, type SignInMethodsState } from '../../app/account-action';
import { useFloFiPrivy } from '../../accounts/privy-client';
import { AccountShell, accountStyles as styles } from './account-shell';
import { accountMessage } from './account-messages';
import { METHOD_KIND_LABEL } from './sign-in';

const REAUTH = '/login?reauth=1&returnTo=%2Faccount%2Fsign-in-methods';
type Method = { readonly kind: string; readonly hint: string | null };

function MethodList({ methods, label }: { methods: readonly Method[]; label: string }) {
  const { t } = useLocale();
  return <ul className={styles.methodList} aria-label={label}>
    {methods.length ? methods.map(method => <li key={`${method.kind}:${method.hint ?? ''}`}><strong>{t(METHOD_KIND_LABEL[method.kind] ?? method.kind)}</strong>
      {method.hint && <span>{method.hint}</span>}</li>) : <li>{t('No sign-in method is recorded yet.')}</li>}
  </ul>;
}

export function SignInMethodsScreen({ initial }: { initial: SignInMethodsState }) {
  const { t } = useLocale();
  const privy = useFloFiPrivy();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false), [moved, setMoved] = useState<readonly string[] | null>(null), [linked, setLinked] = useState(false);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false), [showEmail, setShowEmail] = useState(false);
  const emailId = useId(), codeId = useId(), syncing = useRef(false);
  const reload = useCallback(async () => setState(await signInMethodsState()), []);

  /** FloFi's server reads the account's own Privy user and adopts what was linked from here (never what was linked any other way). */
  const sync = useCallback(async () => {
    if (!privy || syncing.current) return;
    syncing.current = true; setBusy('sync'); setError(null);
    try {
      const token = await privy.getAccessToken();
      const result = token ? await syncSignInMethods(token) : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
      if (!result.ok) { setError(result.code); return; }
      if (result.value.added) setLinked(true);
      // The boarded account's own next step when its Google belongs to the other account (the case this build fixes).
      setNotice(result.value.heldElsewhere ? `${t('That sign-in method already opens another FloFi account, so it was not added. Nothing was merged or moved.')} ${
        t('If that account is empty, sign in with it and choose “Bring this sign-in to my other account”.')}`
        : result.value.added ? t('Linked. You can now sign in with it.')
          : result.value.unconfirmed ? t('A sign-in method was linked at Privy before FloFi asked, so it was not added and does not open this account.')
            : t('Nothing new was linked.'));
      await reload();
    } finally { syncing.current = false; setBusy(null); }
  }, [privy, reload, t]);
  // Google's link returns to this page: FloFi syncs on the browser's signal, and the server decides.
  useEffect(() => privy?.onLinkResult?.(result => {
    if (result.status === 'linked') void sync();
    else setError(result.code);
  }), [privy, sync]);

  async function ready(): Promise<boolean> {
    if (!privy) { setError('PRIVY_NOT_CONFIGURED'); return false; }
    const token = await privy.getAccessToken();
    const result = token ? await linkReadiness(token) : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
    if (!result.ok) { setError(result.code); return false; }
    return true;
  }
  async function linkGoogle() {
    setBusy('google'); setError(null); setNotice(null);
    try {
      if (!await ready()) return;
      await privy!.linkWithOAuth!('google');
      // Privy's own flow leaves for Google and comes back here (then `onLinkResult`); a link that completes in place is synced now.
      await sync();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ACCOUNT_LINK_FAILED'); }
    finally { setBusy(current => current === 'google' ? null : current); }
  }
  async function sendEmailCode(event: { preventDefault(): void }) {
    event.preventDefault();
    setBusy('email'); setError(null); setNotice(null);
    try {
      if (!await ready()) return;
      await privy!.sendLinkEmailCode!(email.trim());
      setCodeSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PRIVY_EMAIL_CODE_FAILED'); }
    finally { setBusy(null); }
  }
  async function verifyEmailCode(event: { preventDefault(): void }) {
    event.preventDefault();
    setBusy('email'); setError(null);
    try { await privy!.linkWithEmailCode!(code); setCodeSent(false); setCode(''); setEmail(''); await sync(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'PRIVY_EMAIL_CODE_INVALID'); }
    finally { setBusy(null); }
  }
  async function startMove() {
    setBusy('move'); setError(null);
    const result = await startAccountMove().catch(() => ({ ok: false as const, code: 'ACCOUNT_MOVE_FAILED' }));
    if (!result.ok) { setBusy(null); setError(result.code); return; }
    // The duplicate's session has ended; its Privy session ends too, so the next sign-in proves the other account.
    await privy?.logout();
    window.location.assign(result.value.next);
  }
  async function confirmMove() {
    setBusy('confirm'); setError(null);
    const result = await completeAccountMove().catch(() => ({ ok: false as const, code: 'ACCOUNT_MOVE_FAILED' }));
    setBusy(null);
    if (!result.ok) { setError(result.code); return; }
    setMoved(result.value.kinds);
    await reload();
    // The confirmation the person pressed is gone: focus the result so it is read out.
    document.getElementById('move-done')?.focus();
  }
  async function cancelMove() { await cancelAccountMove(); await reload(); }

  const canLink = state.signedIn && state.privy && state.fresh && Boolean(privy?.linkWithOAuth);
  const move = state.move;
  const kinds = (list: readonly string[]) => list.map(kind => t(METHOD_KIND_LABEL[kind] ?? kind)).join(', ');
  // Authentication UX & Login Regression Fix (item 6): while a duplicate is being closed, and right after, the page shows only that step and
  // then only the link of the method that was closed (no other method, no email field unless that method is an email). The full page returns
  // once the step is finished or abandoned.
  const focused = Boolean(move) || moved !== null;
  // Only the methods this account can still add here (Privy holds one of each kind per user), and only what this deployment can link.
  const has = (kind: string) => state.methods.some(method => method.kind === kind);
  const linkable = state.signedIn && state.privy && Boolean(privy?.linkWithOAuth);
  const addGoogle = linkable && !has('google'), addEmail = linkable && state.emailLink && Boolean(privy?.sendLinkEmailCode) && !has('email');
  const linkGoogleNow = moved?.includes('google') && canLink, linkEmailNow = moved?.includes('email') && canLink && state.emailLink && Boolean(privy?.sendLinkEmailCode);
  const emailForms = !codeSent ? <form key="email" className={styles.form} onSubmit={event => void sendEmailCode(event)} aria-label={t('Link an email')}>
    <label htmlFor={emailId}>{t('Email address')}</label>
    <input id={emailId} className={styles.input} type="email" inputMode="email" autoComplete="email" required maxLength={254} value={email} autoFocus readOnly={busy !== null}
      onChange={event => setEmail(event.currentTarget.value)}/>
    <button type="submit" className={styles.primary} disabled={busy !== null || !email.includes('@')}>{t(busy === 'email' ? 'Sending code…' : 'Email me a code')}</button>
    {showEmail && <button type="button" className={styles.textLink} disabled={busy !== null} onClick={() => { setShowEmail(false); setEmail(''); }}>{t('Cancel')}</button>}
  </form> : <form key="code" className={styles.form} onSubmit={event => void verifyEmailCode(event)} aria-label={t('Enter your code')}>
    <label htmlFor={codeId}>{t('Enter the 6-digit code we sent to {0}', email.trim())}</label>
    <input id={codeId} className={`${styles.input} ${styles.code}`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required
      value={code} autoFocus onChange={event => setCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))}/>
    <button type="submit" className={styles.primary} disabled={busy !== null || code.length !== 6}>{t(busy === 'email' ? 'Verifying…' : 'Link this email')}</button>
    {/* Never a dead end: a new code, another address, or stop. */}
    <div className={styles.row}>
      <button type="button" className={styles.textLink} disabled={busy !== null} onClick={event => void sendEmailCode(event)}>{t('Send a new code')}</button>
      <button type="button" className={styles.textLink} disabled={busy !== null} onClick={() => { setCodeSent(false); setCode(''); }}>{t('Use another email')}</button>
      <button type="button" className={styles.textLink} disabled={busy !== null} onClick={() => { setCodeSent(false); setCode(''); setEmail(''); setShowEmail(false); setError(null); }}>{t('Cancel')}</button>
    </div>
  </form>;
  return <AccountShell showcase="account" start>
    <h1 className={styles.title}>{t('Sign-in methods')}</h1>
    <p className={styles.lead}>{t('Every method here opens this same account.')}</p>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    {/* BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (beta incident: Google could not be linked to a wallet account): Google already opens another FloFi
        account (usually an empty one created by signing in with Google first). Never a dead end: the existing, checked way to bring it here. */}
    {error === 'FLOFI_SIGN_IN_METHOD_HELD_ELSEWHERE' && <p className={styles.small} role="note">
      {t('If that account is empty, sign in with it and choose “Bring this sign-in to my other account”.')}</p>}
    {notice && <p className={styles.status} role="status">{notice}</p>}
    {/* A link that came back from the provider's page (a new document): the next step is the account itself. */}
    {linked && !moved && <div className={styles.row}><a className={styles.primary} href="/app" data-continue-account="true">{t('Continue to my account')}</a></div>}

    {move && !state.signedIn && <section className={styles.banner} aria-labelledby="move-signin">
      <strong id="move-signin">{t('Sign in to the account that keeps everything')}</strong>
      <p>{t('To finish, sign in to your other FloFi account (for example the one with your boarding pass).')}</p>
      <div className={styles.row}><a className={styles.primary} href="/login?move=1">{t('Sign in')}</a>
        <button type="button" className={styles.textLink} onClick={() => void cancelMove()}>{t('Cancel')}</button></div>
    </section>}
    {move && state.signedIn && move.mine && <section className={styles.banner} aria-labelledby="move-same">
      <strong id="move-same">{t('This is the account you are closing')}</strong>
      <p>{t('Sign in to your other FloFi account, the one that keeps everything, to finish.')}</p>
      <div className={styles.row}><a className={styles.primary} href="/login?move=1">{t('Sign in to the other account')}</a>
        <button type="button" className={styles.textLink} onClick={() => void cancelMove()}>{t('Cancel')}</button></div>
    </section>}
    {move && state.signedIn && !move.mine && !moved && <section className={styles.banner} aria-labelledby="move-confirm" data-move-confirm="true">
      <strong id="move-confirm">{t('Close the duplicate account?')}</strong>
      <p>{t('Keep: this account, which signs in with:')}</p>
      <MethodList methods={state.methods} label={t('This account')}/>
      <p>{t('Close: the duplicate account that signs in with:')}</p>
      <MethodList methods={move.methods} label={t('The duplicate account')}/>
      <p className={styles.small}>{t('The duplicate holds nothing (no wallet, boarding pass, beta access, saved recipients or history): FloFi checks it again before closing it. Nothing moves to this account. After that you can link its sign-in method here.')}</p>
      {!state.fresh ? <p><a className={styles.primary} href={REAUTH}>{t('Confirm it’s you')}</a></p> : <>
        <label className={styles.check}><input type="checkbox" checked={understood} onChange={event => setUnderstood(event.currentTarget.checked)}/>
          <span>{t('I understand the duplicate account will be closed for good.')}</span></label>
        <div className={styles.row}><button type="button" className={styles.primary} disabled={!understood || busy !== null} onClick={() => void confirmMove()}>
          {t(busy === 'confirm' ? 'Closing…' : 'Close it and continue')}</button>
          <button type="button" className={styles.textLink} onClick={() => void cancelMove()}>{t('Cancel')}</button></div></>}
    </section>}
    {moved && <section className={styles.banner} aria-labelledby="move-done" data-move-done="true">
      <strong id="move-done" tabIndex={-1}>{t('The duplicate account is closed.')}</strong>
      {linked ? <>
        <MethodList methods={state.methods} label={t('Sign-in methods')}/>
        <div className={styles.row}><a className={styles.primary} href="/app" data-continue-account="true">{t('Continue to my account')}</a></div>
      </> : <>
        {!state.fresh ? <><p>{t('Now link {0} to this account so it opens it.', kinds(moved))}</p>
          <p><a className={styles.primary} href={REAUTH}>{t('Confirm it’s you')}</a></p></>
          : linkGoogleNow || linkEmailNow ? <>
            <p>{t('Now link {0} to this account so it opens it.', kinds(moved))}</p>
            {linkGoogleNow && <button type="button" className={styles.method} disabled={busy !== null} onClick={() => void linkGoogle()}>{t(busy === 'google' ? 'Opening…' : 'Link Google')}</button>}
            {linkEmailNow && emailForms}
          </>
          // Nothing this deployment can link here: say so, and the account is the next step (never an instruction with nothing to press).
          : <p className={styles.small}>{t(moved.includes('email') && canLink ? 'Linking an email is not available on this deployment yet.' : 'Adding sign-in methods is not available here yet.')}</p>}
        <div className={styles.row}>{state.fresh && !linkGoogleNow && !linkEmailNow
          ? <a className={styles.primary} href="/app" data-continue-account="true">{t('Continue to my account')}</a>
          : <a className={styles.textLink} href="/app">{t('Not now')}</a>}</div>
      </>}
    </section>}

    {state.signedIn && !focused && <section aria-labelledby="methods-title" className={styles.form}>
      <h2 id="methods-title" className={styles.subtitle}>{t('This account signs in with')}</h2>
      <MethodList methods={state.methods} label={t('Sign-in methods')}/>
      {(addGoogle || addEmail) && <>
        <h2 className={styles.subtitle}>{t('Add a sign-in method')}</h2>
        {/* Authentication UX & Login Regression Fix: the security step is asked only when adding, and only when the sign-in is not recent. */}
        {!state.fresh ? <div role="note"><p className={styles.small}>{t('For your security, confirm it’s you first.')}</p>
          <a className={styles.primary} href={REAUTH}>{t('Confirm it’s you')}</a></div>
          : <>
            {addGoogle && <button type="button" className={styles.method} disabled={busy !== null} onClick={() => void linkGoogle()}>{t(busy === 'google' ? 'Opening…' : 'Add Google')}</button>}
            {addEmail && (showEmail || codeSent ? emailForms
              : <button type="button" className={styles.method} disabled={busy !== null} onClick={() => setShowEmail(true)}>{t('Add email')}</button>)}
          </>}
      </>}
      {/* An account signed in before FloFi used Privy has no Privy link yet, so nothing can be linked to it: confirming with the same sign-in
          (a Privy sign-in of a method this account already holds) creates that link; adding Google or email is then offered here. */}
      {!linkable && !state.privy && Boolean(privy?.linkWithOAuth) && <div role="note">
        <h2 className={styles.subtitle}>{t('Add a sign-in method')}</h2>
        <p className={styles.small}>{t('To add Google or email, first confirm it’s you with a sign-in method this account already has.')}</p>
        <a className={styles.primary} href={REAUTH}>{t('Confirm it’s you')}</a></div>}
      {!move && <details className={styles.small} data-duplicate-help="true">
        <summary>{t('Is this a second FloFi account?')}</summary>
        {state.retirement.length === 0 ? <>
          <p>{t('If you boarded with another sign-in, close this empty account and bring its sign-in there. You will sign in to the other account to confirm.')}</p>
          {!state.fresh ? <a className={styles.quiet} href={REAUTH}>{t('Confirm it’s you')}</a>
            : <button type="button" className={styles.quiet} disabled={busy !== null} onClick={() => void startMove()} data-start-move="true">{t('Bring this sign-in to my other account')}</button>}
        </> : <p>{t('This account holds something of its own (a wallet, a boarding pass, saved recipients or history), so it is not a duplicate FloFi can close.')}</p>}
      </details>}
    </section>}
    <div className={styles.footerLinks}><a href="/app/credentials">{t('Credentials')}</a><a href="/board">{t('Flight FloFi')}</a><a href="/privacy">{t('Privacy')}</a></div>
  </AccountShell>;
}
