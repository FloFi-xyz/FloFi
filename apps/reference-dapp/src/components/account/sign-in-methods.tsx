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
  const [understood, setUnderstood] = useState(false), [moved, setMoved] = useState<readonly string[] | null>(null);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false);
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
      setNotice(result.value.heldElsewhere ? t('That sign-in method already opens another FloFi account, so it was not added. Nothing was merged or moved.')
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
  }
  async function cancelMove() { await cancelAccountMove(); await reload(); }

  const canLink = state.signedIn && state.privy && state.fresh && Boolean(privy?.linkWithOAuth);
  const move = state.move;
  const kinds = (list: readonly string[]) => list.map(kind => t(METHOD_KIND_LABEL[kind] ?? kind)).join(', ');
  return <AccountShell showcase="account" start>
    <h1 className={styles.title}>{t('Sign-in methods')}</h1>
    <p className={styles.lead}>{t('One FloFi account, several ways in. Every method you add opens this same account; adding one approves nothing and moves no funds.')}</p>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    {notice && <p className={styles.status} role="status">{notice}</p>}

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
    {moved && <section className={styles.banner} role="status" aria-labelledby="move-done" data-move-done="true">
      <strong id="move-done">{t('The duplicate account is closed.')}</strong>
      <p>{t('Now link {0} to this account so it opens it.', kinds(moved))}</p>
    </section>}

    {state.signedIn && <section aria-labelledby="methods-title" className={styles.form}>
      <h2 id="methods-title" className={styles.subtitle}>{t('This account signs in with')}</h2>
      <MethodList methods={state.methods} label={t('Sign-in methods')}/>
      <h2 className={styles.subtitle}>{t('Add a sign-in method')}</h2>
      {!state.fresh ? <div role="note"><p className={styles.small}>{t('For your security, confirm it’s you before adding a sign-in method.')}</p>
        <a className={styles.primary} href={REAUTH}>{t('Confirm it’s you')}</a></div>
        : !canLink ? <p className={styles.small}>{t('Adding sign-in methods is not available here yet.')}</p> : <>
          <button type="button" className={styles.method} disabled={busy !== null} onClick={() => void linkGoogle()}>{t(busy === 'google' ? 'Opening…' : 'Link Google')}</button>
          {state.emailLink && privy?.sendLinkEmailCode && (!codeSent ? <form className={styles.form} onSubmit={event => void sendEmailCode(event)} aria-label={t('Link an email')}>
            <label htmlFor={emailId}>{t('Email address')}</label>
            <input id={emailId} className={styles.input} type="email" inputMode="email" autoComplete="email" required maxLength={254} value={email}
              onChange={event => setEmail(event.currentTarget.value)}/>
            <button type="submit" className={styles.primary} disabled={busy !== null || !email.includes('@')}>{t(busy === 'email' ? 'Sending code…' : 'Email me a code')}</button>
          </form> : <form className={styles.form} onSubmit={event => void verifyEmailCode(event)} aria-label={t('Enter your code')}>
            <label htmlFor={codeId}>{t('Enter the 6-digit code we sent to {0}', email.trim())}</label>
            <input id={codeId} className={`${styles.input} ${styles.code}`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required
              value={code} onChange={event => setCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))}/>
            <button type="submit" className={styles.primary} disabled={busy !== null || code.length !== 6}>{t(busy === 'email' ? 'Verifying…' : 'Link this email')}</button>
          </form>)}
          {!state.emailLink && <p className={styles.small}>{t('Linking an email is not available on this deployment yet.')}</p>}
        </>}
      <p className={styles.small}>{t('A sign-in method that already opens another FloFi account cannot be added here. If that account is an empty duplicate, sign in with that method and choose to bring it to your main account.')}</p>
      {!move && <>
        <h2 className={styles.subtitle}>{t('Is this a duplicate account?')}</h2>
        {state.retirement.length === 0 ? <>
          <p className={styles.small}>{t('If you already have another FloFi account (for example the one with your boarding pass), you can close this empty one and bring its sign-in method there. You will sign in to the other account to confirm.')}</p>
          {!state.fresh ? <a className={styles.quiet} href={REAUTH}>{t('Confirm it’s you')}</a>
            : <button type="button" className={styles.quiet} disabled={busy !== null} onClick={() => void startMove()} data-start-move="true">{t('Bring this sign-in to my other account')}</button>}
        </> : <p className={styles.small}>{t('This account holds something of its own (a wallet, a boarding pass, saved recipients or history), so it is not a duplicate FloFi can close.')}</p>}
      </>}
    </section>}
    <div className={styles.footerLinks}><a href="/app/credentials">{t('Credentials')}</a><a href="/board">{t('Flight FloFi')}</a><a href="/privacy">{t('Privacy')}</a></div>
  </AccountShell>;
}
