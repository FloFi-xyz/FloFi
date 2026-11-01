// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * "Add your wallets" (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001).
 *
 * One click creates a real Privy embedded wallet for the chosen ecosystem, in the session the person just signed in with: no second
 * Google sign-in, no unlock screen, no extra pop-up. The new address is saved to the account only after FloFi's server confirms with
 * Privy that this account's own Privy user holds it, and it appears at once in its card. "Import key" opens the dedicated import screen.
 * Each button is disabled while its operation runs; a refresh, a timeout or a closed tab is recovered on the next visit (the server saves
 * any Privy wallet the account does not list yet). Creating or importing a wallet authorizes no transaction and delegates no permission.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { savePrivyWallet, setAccountOnboarding, syncPrivyWallets, type AccountState } from '../../app/account-action';
import { isLegacyWallet, isPrivyWallet, shortAddress, type AccountWallet } from '../../accounts/account-model';
import { useFloFiPrivy, type FloFiPrivy } from '../../accounts/privy-client';
import { disconnectToLogin } from '../../accounts/disconnect';
import type { WalletEcosystem } from '../../wallet/wallet-registry';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import { AccountShell, accountStyles as styles } from './account-shell';

/** How long one create (Privy) + save (FloFi) may take before the page offers to check again. */
export const WALLET_OPERATION_TIMEOUT_MS = 60_000;
const ECOSYSTEMS: readonly WalletEcosystem[] = ['evm', 'solana'];
const NAME: Readonly<Record<WalletEcosystem, string>> = { evm: 'EVM', solana: 'Solana' };
type Readiness = 'ready' | 'connecting' | 'unavailable' | 'not-configured' | 'sign-in-again';

/** Whether this page can create and import wallets now, and if not, why. */
export function walletReadiness(state: AccountState, privy: Pick<FloFiPrivy, 'ready' | 'authenticated'> | null, slow = false): Readiness {
  if (!state.account || !state.availability.managedWallets || !privy) return 'not-configured';
  // An account that has not signed in through Privy yet (a session from before Privy) signs in again once; nothing else changes.
  if (!state.account.privy) return 'sign-in-again';
  // Never an endless spinner: a provider that has not loaded after 20 seconds is reported, with a way to retry.
  if (!privy.ready) return slow ? 'unavailable' : 'connecting';
  return privy.authenticated ? 'ready' : 'sign-in-again';
}
const withTimeout = <T,>(run: Promise<T>, ms = WALLET_OPERATION_TIMEOUT_MS) => Promise.race([run,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WALLET_OPERATION_TIMEOUT')), ms))]);
const merge = (current: readonly AccountWallet[], next: readonly AccountWallet[]) =>
  [...current.filter(wallet => !next.some(entry => entry.id === wallet.id)), ...next];

export function AddWallets({ state }: { state: AccountState }) {
  const { t } = useLocale();
  const privy = useFloFiPrivy();
  const [wallets, setWallets] = useState<readonly AccountWallet[]>(state.account?.wallets ?? []);
  const [busy, setBusy] = useState<WalletEcosystem | 'save' | 'check' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [slow, setSlow] = useState(false);
  const recovered = useRef(false);
  const readiness = walletReadiness(state, privy, slow);
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 20_000); return () => clearTimeout(timer); }, []);

  /** Saves any Privy wallet this account does not list yet (a creation or import whose save did not finish). */
  const recover = useCallback(async (quiet: boolean) => {
    const token = await privy?.getAccessToken();
    if (!token) { if (!quiet) setError('PRIVY_SESSION_REQUIRED'); return; }
    const result = await syncPrivyWallets(token).catch(() => ({ ok: false as const, code: 'ACCOUNT_WALLET_SAVE_FAILED' }));
    if (result.ok) { setWallets(current => merge(current, result.value.wallets)); if (result.value.heldElsewhere && !quiet) setError('ACCOUNT_WALLET_LINKED_ELSEWHERE'); }
    else if (!quiet) setError(result.code);
  }, [privy]);
  useEffect(() => {
    if (readiness !== 'ready' || recovered.current) return;
    recovered.current = true;
    void recover(true);
  }, [readiness, recover]);

  async function create(ecosystem: WalletEcosystem) {
    if (!privy || busy !== null) return;
    setBusy(ecosystem); setError(null); setStatus(t('Creating your {0} wallet…', NAME[ecosystem]));
    try {
      await withTimeout((async () => {
        // A wallet Privy already holds for this person (an earlier attempt that was interrupted) is saved, never duplicated.
        let address = privy.embedded.find(wallet => wallet.ecosystem === ecosystem && !wallet.imported)?.address ?? null;
        if (!address) {
          try { address = (await privy.createWallet(ecosystem)).address; }
          catch (cause) { if (cause instanceof Error && cause.message === 'PRIVY_WALLET_LIMIT') { await recover(false); return; } throw cause; }
        }
        const token = await privy.getAccessToken();
        if (!token) throw new Error('PRIVY_SESSION_REQUIRED');
        const saved = await savePrivyWallet(token, ecosystem, address);
        if (!saved.ok) throw new Error(saved.code);
        setWallets(current => merge(current, [saved.value]));
        // The address is shown once, in its card (BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 P1-01); the announcement does not repeat it.
        setStatus(t('{0} wallet created.', NAME[ecosystem]));
      })());
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error ? cause.message : 'PRIVY_WALLET_CREATE_FAILED');
    } finally { setBusy(null); }
  }
  async function check() {
    setBusy('check'); setError(null);
    try { await withTimeout(recover(false)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'ACCOUNT_WALLET_SAVE_FAILED'); } finally { setBusy(null); }
  }
  async function finish(value: 'completed' | 'dismissed') {
    setBusy('save'); setError(null);
    await setAccountOnboarding(value).catch(() => undefined);
    window.location.assign('/app');
  }

  const valid = wallets.filter(wallet => isPrivyWallet(wallet) || isLegacyWallet(wallet) || wallet.origin === 'external');
  /** Copies the full address (never the shortened text shown). */
  function copy(wallet: AccountWallet) {
    void navigator.clipboard.writeText(wallet.address).then(() => setStatus(t('Address copied.')), () => setStatus(t('Address could not be copied.')));
  }
  /** One wallet, shown once inside its card: status, shortened address and a copy button (BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 P1-01). */
  const walletTile = (wallet: AccountWallet, title: string, wide = false) => <div key={wallet.id} className={`${styles.tile} ${styles.tileDone}${wide ? ` ${styles.tileWide}` : ''}`}
    data-wallet-address={wallet.address} role="group" aria-label={`${t(title)}: ${wallet.label}`}>
    <strong><AccountIcon name="check" size={16}/>{t(title)}</strong>
    <small>{wallet.label}</small>
    <span className={styles.tileAddress}><code title={wallet.address}>{shortAddress(wallet.address)}</code>
      <button type="button" className={styles.copyAddress} aria-label={t('Copy {0} address', wallet.label)} title={t('Copy address')} onClick={() => copy(wallet)}>
        <AccountIcon name="copy" size={15}/></button></span>
  </div>;
  const card = (ecosystem: WalletEcosystem) => {
    const own = valid.filter(wallet => wallet.ecosystem === ecosystem);
    const created = own.find(wallet => isPrivyWallet(wallet) && wallet.origin === 'generated');
    const imported = own.find(wallet => isPrivyWallet(wallet) && wallet.origin === 'imported');
    // A wallet linked in another way (MetaMask, Phantom, a legacy FloFi Wallet) keeps one full-width tile in the same card.
    const others = own.filter(wallet => wallet !== created && wallet !== imported);
    const pending = busy === ecosystem;
    return <section key={ecosystem} className={`${styles.ecosystem} ${ecosystem === 'evm' ? styles.ecosystemEvm : styles.ecosystemSolana}`} aria-label={NAME[ecosystem]}
      data-ecosystem={ecosystem}>
      <div className={styles.ecosystemTab}><img src={`/brand/crypto/${ecosystem === 'evm' ? 'ethereum' : 'solana'}.svg`} alt=""/><span>{NAME[ecosystem]}</span></div>
      <div className={styles.ecosystemBody}>
      <div className={styles.tiles}>
        {created ? walletTile(created, 'Wallet created')
          : <button type="button" className={styles.tile} disabled={readiness !== 'ready' || busy !== null} aria-busy={pending} onClick={() => void create(ecosystem)}>
            <strong><AccountIcon name="plus" size={16}/>{t(pending ? 'Creating…' : 'Create wallet')}</strong>
            <small>{t('A new {0} wallet, ready right away', NAME[ecosystem])}</small>
          </button>}
        {imported ? walletTile(imported, 'Imported wallet') : readiness === 'ready' && busy === null
          ? <a className={styles.tile} href={`/onboarding/wallets/import/${ecosystem}`}>
            <strong><AccountIcon name="import" size={16}/>{t('Import key')}</strong><small>{t('Bring an existing {0} wallet with its private key', NAME[ecosystem])}</small></a>
          : <button type="button" className={styles.tile} disabled><strong><AccountIcon name="import" size={16}/>{t('Import key')}</strong>
            <small>{t('Bring an existing {0} wallet with its private key', NAME[ecosystem])}</small></button>}
        {others.map(wallet => walletTile(wallet, isLegacyWallet(wallet) ? 'Legacy FloFi Wallet' : 'Connected', true))}
      </div>
      </div>
    </section>;
  };

  return <AccountShell showcase="wallets" start>
    <p className={styles.crumbs}><a href="/app/credentials">{t('Account')}</a> / <span aria-current="page">{t('Add wallets')}</span></p>
    <h1 className={styles.heading} style={{ marginTop: 28 }}>{t('Add your wallets')}</h1>
    <p className={`${styles.lead} ${styles.center}`} style={{ textAlign: 'center' }}>{t('Create a new wallet or import one you already have. Keys are created and kept by our wallet provider, Privy — FloFi’s servers never receive or store them.')}</p>
    {readiness === 'not-configured' && <div className={styles.banner} role="status"><strong>{t("Creating and importing wallets isn't available on this deployment yet.")}</strong>
      <p>{t('You can still connect MetaMask, Phantom or Solflare in Credentials and use them with FloFi.')}</p></div>}
    {readiness === 'connecting' && <p className={styles.status} role="status">{t('Connecting to your wallet provider…')}</p>}
    {readiness === 'unavailable' && <div className={styles.banner} role="status"><strong>{t("Your wallet provider isn't responding.")}</strong>
      <p>{t('Check your connection, then try again. Nothing was created.')}</p>
      <button type="button" className={styles.primary} onClick={() => window.location.reload()}>{t('Try again')}</button></div>}
    {readiness === 'sign-in-again' && <div className={styles.banner} role="status"><strong>{t('Sign in again to add wallets.')}</strong>
      <p>{t('Your wallet provider session has ended in this browser. Your account and wallets are unchanged.')}</p>
      <button type="button" className={styles.primary} onClick={() => void disconnectToLogin(privy)}>{t('Sign in again')}</button></div>}
    {ECOSYSTEMS.map(card)}
    <p className={styles.status} role="status">{status}</p>
    {error && <div role="alert"><p className={styles.error}>{t(accountMessage(error))}</p>
      {(error === 'WALLET_OPERATION_TIMEOUT' || error === 'ACCOUNT_WALLET_SAVE_FAILED') && readiness === 'ready'
        && <button type="button" className={styles.textLink} disabled={busy !== null} onClick={() => void check()}>{t('Check again')}</button>}</div>}
    <div className={styles.saveRow}>
      <button type="button" className={styles.outline} disabled={valid.length === 0 || busy !== null} onClick={() => void finish('completed')}>
        {t(busy === 'save' ? 'Opening FloFi…' : 'Continue')}</button>
      <div className={styles.row} style={{ justifyContent: 'center', gap: 22 }}>
        <a className={styles.textLink} href="/app/credentials">{t('Connect an existing wallet instead')}</a>
        <button type="button" className={styles.textLink} disabled={busy !== null} onClick={() => void finish('dismissed')}>{t('Skip for now')}</button>
      </div>
      <p className={styles.small}>{t('Adding a wallet authorizes nothing. Every transaction is still simulated, reviewed and signed by you.')}</p>
    </div>
  </AccountShell>;
}
