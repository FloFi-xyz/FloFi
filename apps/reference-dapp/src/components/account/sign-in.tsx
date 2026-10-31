// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: the sign-in screen between the landing page and the app. Four methods only — Apple, Google, Email
 * and Web3 Wallet. Each one is verified by FloFi's server; the browser never decides who is signed in. A method this deployment
 * cannot run is shown disabled with the reason, never simulated. Signing in approves nothing and moves no funds.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { completeEmailSignIn, startEmailSignIn, startSocialSignIn, walletAccountSignIn, type AccountState } from '../../app/account-action';
import { useWalletProof, walletProofMessage, type Namespace } from '../wallet-proof';
import { WalletSelectorProvider } from '../wallet-selector';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import { AccountShell, accountStyles as styles } from './account-shell';

type Method = 'google' | 'apple' | 'email' | 'wallet';
/** The provider session key, only when this deployment has managed wallets (it is created in this browser's IndexedDB). */
async function managedKey(state: AccountState): Promise<string | null> {
  if (!state.availability.managedWallets) return null;
  try { return await (await import('../../accounts/turnkey-browser')).sessionPublicKey(); } catch { return null; }
}

function SignInContent({ state, initialError, returnTo, intent, initialMethod }: { state: AccountState; initialError: string | null; returnTo: string;
  intent: 'sign-in' | 'link'; initialMethod: Method | null }) {
  const { t } = useLocale();
  const [open, setOpen] = useState<Method | null>(initialMethod === 'email' || initialMethod === 'wallet' ? initialMethod : null);
  const [busy, setBusy] = useState<Method | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [namespace, setNamespace] = useState<Namespace | null>(null);
  const evm = useWalletProof('eip155'), solana = useWalletProof('solana');
  const pending = useRef<Namespace | null>(null);
  const emailId = useId(), codeId = useId(), statusId = useId();
  const available = state.availability;
  const go = (path: string) => { window.location.assign(path); };

  async function social(provider: 'google' | 'apple') {
    setError(null); setBusy(provider);
    const started = await startSocialSignIn(provider, await managedKey(state), intent, returnTo).catch(() => ({ ok: false as const, code: 'ACCOUNT_REQUEST_FAILED' }));
    if (started.ok) { go(started.value.url); return; }
    setBusy(null); setError(started.code);
  }
  async function sendCode(event?: { preventDefault(): void }) {
    event?.preventDefault();
    setError(null); setNotice(''); setBusy('email');
    const key = await managedKey(state);
    if (!key) { setBusy(null); setError('MANAGED_SESSION_KEY_UNAVAILABLE'); return; }
    const started = await startEmailSignIn(email, key, intent, returnTo).catch(() => ({ ok: false as const, code: 'EMAIL_SIGN_IN_FAILED' }));
    setBusy(null);
    if (started.ok) { if (sent) setNotice(t('A new code was sent to {0}.', started.value.email)); setSent(started.value.email); setCode(''); } else setError(started.code);
  }
  async function verify(event: { preventDefault(): void }) {
    event.preventDefault();
    setError(null); setBusy('email');
    const done = await completeEmailSignIn(code.replace(/\s+/g, '')).catch(() => ({ ok: false as const, code: 'EMAIL_SIGN_IN_FAILED' }));
    if (done.ok) { go(done.value.next); return; }
    setBusy(null); setError(done.code);
  }
  function proveWith(value: Namespace) {
    setError(null); setNamespace(value); setBusy('wallet'); pending.current = value;
    void (value === 'eip155' ? evm.proveEvm(true) : solana.proveSolana(true));
  }
  // When the wallet proof (a new EIP-4361 / Sign-In With Solana signature verified by the server) settles, sign in with it.
  const proof = namespace === 'solana' ? solana : evm;
  useEffect(() => {
    const value = pending.current;
    if (!value || proof.busy) return;
    pending.current = null;
    if (proof.error) { setBusy(null); setError(walletProofMessage(proof.error, value)); return; }
    void walletAccountSignIn(value, proof.wallet?.key ?? 'injected', proof.wallet?.name ?? (value === 'eip155' ? 'EVM wallet' : 'Solana wallet'), returnTo)
      .then(result => { if (result.ok) go(result.value.next); else { setBusy(null); setError(result.code); } })
      .catch(() => { setBusy(null); setError('WALLET_SIGN_IN_FAILED'); });
  }, [proof.busy, proof.error, proof.wallet, returnTo]);

  const unavailable = (method: Exclude<Method, 'wallet'>) => !available[method];
  const methodButton = (method: Method, label: string, icon: 'apple' | 'google' | 'email' | 'wallet', onClick: () => void, disabled: boolean) =>
    <button type="button" className={styles.method} onClick={onClick} disabled={disabled || busy !== null && busy !== method}
      aria-expanded={method === 'email' || method === 'wallet' ? open === method : undefined} aria-describedby={disabled ? statusId : undefined}
      title={disabled ? t('Not available on this deployment yet') : undefined}>
      <AccountIcon name={icon}/><span>{t(label)}{busy === method ? <small>{t('Opening…')}</small> : null}</span></button>;

  return <AccountShell showcase="account">
    <h1 className={styles.title}>{t(intent === 'link' ? 'Add a sign-in' : 'Sign in')}<span>{t(intent === 'link' ? 'to your account' : 'your way')}</span></h1>
    <p className={styles.lead}>{t(intent === 'link' ? 'Add another way to sign in to this FloFi account. It must be yours and not used by another account.'
      : 'Sign in to your FloFi account or create one with any method you like.')}</p>
    {!available.accounts && <div className={styles.banner} role="status"><strong>{t("Accounts aren't available on this deployment yet.")}</strong>
      <p>{t('You can still build workflows and use your own wallet in FloFi without an account.')}</p></div>}
    <div className={styles.methods} role="group" aria-label={t('Sign-in methods')}>
      {methodButton('apple', 'Apple', 'apple', () => void social('apple'), unavailable('apple'))}
      {methodButton('google', 'Google', 'google', () => void social('google'), unavailable('google'))}
      {methodButton('email', 'Email', 'email', () => { setError(null); setOpen(open === 'email' ? null : 'email'); }, unavailable('email'))}
      {methodButton('wallet', 'Web3 Wallet', 'wallet', () => { setError(null); setOpen(open === 'wallet' ? null : 'wallet'); }, !available.wallet || intent === 'link')}
    </div>
    {open === 'email' && available.email && (sent === null ? <form className={styles.form} onSubmit={event => void sendCode(event)} aria-label={t('Email sign-in')}>
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
    {open === 'wallet' && <div className={styles.form} role="group" aria-label={t('Web3 Wallet sign-in')}>
      <p style={{ margin: 0, color: 'var(--acc-muted)', fontSize: 14 }}>{t('Your wallet signs a sign-in message that FloFi verifies. It approves no transaction and moves no funds.')}</p>
      <div className={styles.methods}>
        <button type="button" className={styles.method} disabled={busy !== null} onClick={() => proveWith('eip155')}><img src="/brand/crypto/ethereum.svg" width="20" height="20" alt=""/>{t('EVM wallet')}</button>
        <button type="button" className={styles.method} disabled={busy !== null} onClick={() => proveWith('solana')}><img src="/brand/crypto/solana.svg" width="20" height="20" alt=""/>{t('Solana wallet')}</button>
      </div>
    </div>}
    <p id={statusId} className={styles.status} role="status">{notice || (!available.google || !available.apple || !available.email
      ? t('Methods shown as unavailable are not configured on this deployment yet.') : '')}</p>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    <div className={styles.notice}><span className={styles.noticeIcon}><AccountIcon name="shield" size={18}/></span><div>
      <strong>{t('Nothing executes without your review')}</strong>
      <p>{t('Your account is how you sign in. Transactions are always simulated, reviewed and signed by your own wallet.')}</p></div></div>
    <div className={styles.footerLinks}><a href="/app">{t('Explore the builder without an account')}</a><a href="/privacy">{t('Privacy')}</a></div>
  </AccountShell>;
}

/** `/login` renders outside the product shell, so it mounts its own instance of the canonical wallet selector. */
export function SignInScreen(props: Parameters<typeof SignInContent>[0]) {
  return <WalletSelectorProvider><SignInContent {...props}/></WalletSelectorProvider>;
}
