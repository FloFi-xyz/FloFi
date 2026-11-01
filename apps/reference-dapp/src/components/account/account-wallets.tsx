// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * FloFi account pieces of Credentials → Wallets (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001; one section since
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001, see src/domain/wallet-inventory.ts and secondary-product-workspace.tsx).
 *
 * Export:
 * - a Privy wallet opens Privy's own export screen (the key is shown inside Privy's isolated frame, never to FloFi);
 * - a legacy FloFi Wallet (Turnkey) wallet, created before Privy, keeps its export in FloFi Wallet on its own origin (fresh unlock,
 *   explicit confirmation, the secret shown only inside Turnkey's frame). That is its migration path: export it, then import the key
 *   with Privy (Add wallets → Import key). FloFi never moves funds or replaces an address by itself.
 * MetaMask, Phantom and other external wallets never offer key export: FloFi never held their keys.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { deleteFloFiAccount, type AccountState } from '../../app/account-action';
import { openFloFiWallet, requestFloFiWallet } from '../../wallet/flofi-wallet-channel';
import { syncFloFiWallets } from '../../wallet/flofi-wallet-sync';
import { exportActions, isLegacyWallet, shortAddress, type AccountWallet } from '../../accounts/account-model';
import { useFloFiPrivy } from '../../accounts/privy-client';
import { useFloFiWallet } from '../flofi-wallet-continue';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import styles from './account.module.css';


/**
 * The export entry point. It never shows a secret itself: a Privy wallet's key appears only in Privy's own export screen; a legacy
 * FloFi Wallet (Turnkey) wallet exports in FloFi Wallet (another origin), which asks for a fresh unlock and confirmation there.
 */
export function ExportWalletDialog({ wallet, state, onClose }: { wallet: AccountWallet; state: AccountState; onClose(): void }) {
  const { t } = useLocale();
  const privy = useFloFiPrivy();
  const legacyChannel = useFloFiWallet();
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const legacy = isLegacyWallet(wallet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const actions = exportActions(wallet);
  const ready = legacy ? state.availability.legacyWallets && legacyChannel.configured : Boolean(privy?.ready && privy.authenticated);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (legacy && state.availability.legacyWallets) void syncFloFiWallets({ force: true }); }, [legacy, state.availability.legacyWallets]);
  function open(kind: 'private-key' | 'recovery-phrase') {
    if (busy) return;
    setBusy(true); setError(null); setDone(false);
    if (!legacy) {
      void privy!.exportWallet(wallet.ecosystem, wallet.address).then(() => setDone(true),
        cause => setError(cause instanceof Error ? cause.message : 'PRIVY_WALLET_EXPORT_FAILED')).finally(() => setBusy(false));
      return;
    }
    // Legacy FloFi Wallet: opened in this click (popups need the gesture), then asked to export there.
    try { openFloFiWallet(); } catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : 'FLOFI_WALLET_NOT_OPEN'); return; }
    void requestFloFiWallet({ op: 'export', walletId: wallet.id, kind }).then(() => setDone(true),
      cause => setError(cause instanceof Error ? cause.message : 'MANAGED_EXPORT_UNAVAILABLE')).finally(() => setBusy(false));
  }
  return <dialog ref={dialog} className={styles.frameDialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.frameBody}>
      <button type="button" className={styles.close} aria-label={t('Close')} onClick={onClose}><AccountIcon name="close" size={16}/></button>
      <h2 id={titleId}>{t('Export wallet')}</h2>
      <p>{t(actions.includes('recovery-phrase') ? 'Copy either your private key or recovery phrase to use this wallet in another app.' : 'Copy your private key to use this wallet in another app.')}</p>
      <div className={styles.warning} role="note"><AccountIcon name="warning" size={18}/><span>{t('Never share your private key or recovery phrase with anyone. Whoever has it controls this wallet and its funds. FloFi will never ask for it.')}</span></div>
      <div className={styles.walletBox}><span>{t('Your wallet')}</span>
        <div className={styles.walletLine}><span><strong>{wallet.label}</strong><br/><code title={wallet.address}>{shortAddress(wallet.address)}</code></span></div></div>
      <p className={styles.small}>{t(legacy
        ? 'This wallet was created in the earlier FloFi Wallet. Export happens there, in a separate secure window: you unlock it again, confirm, and the secret is shown only inside Turnkey’s secure frame. To keep using it in FloFi, import the key afterwards in Add wallets.'
        : 'Export happens in Privy’s own secure screen. The key is shown only there; FloFi never sees it.')}</p>
      {!ready && <p className={styles.small} role="status">{t(accountMessage(legacy ? 'MANAGED_WALLETS_NOT_CONFIGURED' : 'PRIVY_SESSION_REQUIRED'))}</p>}
      <div className={styles.exportActions}>
        {actions.includes('private-key') && <button type="button" className={styles.primary} disabled={busy || !ready} onClick={() => open('private-key')}>
          <AccountIcon name="key" size={18}/>{t(legacy ? 'Export private key in FloFi Wallet' : 'Export private key')}</button>}
        {actions.includes('recovery-phrase') && <button type="button" className={styles.primary} disabled={busy || !ready} onClick={() => open('recovery-phrase')}>
          <AccountIcon name="phrase" size={18}/>{t('Export recovery phrase in FloFi Wallet')}</button>}
      </div>
      {busy && <p className={styles.status} role="status">{t(legacy ? 'Continue in FloFi Wallet…' : 'Continue in the export screen…')}</p>}
      {done && <p className={styles.status} role="status">{t(legacy ? 'Export finished in FloFi Wallet.' : 'Export screen closed.')}</p>}
      {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
      <p className={styles.protected}><AccountIcon name="lock" size={14}/>{t('Protected by')} <strong>{legacy ? 'Turnkey' : 'Privy'}</strong></p>
    </div>
  </dialog>;
}

/** Deleting the FloFi account: explicit confirmation, a recent sign-in, and an honest statement of what is and is not deleted. */
export function DeleteAccount({ state }: { state: AccountState }) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managed = state.account?.wallets.some(wallet => wallet.origin !== 'external') ?? false;
  async function remove() {
    const result = await deleteFloFiAccount().catch(() => ({ ok: false as const, code: 'ACCOUNTS_UNAVAILABLE' }));
    if (!result.ok) { setError(result.code); return; }
    window.location.assign('/login');
  }
  return <div className="workspace-inline-form" role="group" aria-label={t('Delete FloFi account')}>
    {confirming ? <>
      <p>{t('Delete your FloFi account? Your sign-in identities, sessions and saved wallet addresses are deleted from FloFi.')}{' '}
        {t(managed ? 'Wallets created or imported in FloFi are not deleted: they stay with their provider and their funds are unchanged. Export them first if you want to keep using them elsewhere.'
          : 'Your wallets and their funds are not affected.')}{' '}
        {state.account?.privy ? t('Your sign-in and wallets at our wallet provider, Privy, are not deleted by this. To have Privy delete them too, export your wallets first, then ask FloFi (see Privacy).') : null}</p>
      <div className="workspace-wallet-actions"><button type="button" className="workspace-action workspace-action-danger" onClick={() => void remove()}>{t('Delete account')}</button>
        <button type="button" className="workspace-action" onClick={() => { setConfirming(false); setError(null); }}>{t('Cancel')}</button></div>
      {error === 'ACCOUNT_REAUTHENTICATION_REQUIRED' ? <p className="workspace-inline-error" role="alert">{t(accountMessage(error))}{' '}
        <a className="workspace-action" style={{ textDecoration: 'none' }} href="/login?returnTo=%2Fapp%2Fcredentials">{t('Sign in again')}</a></p>
        : error && <p className="workspace-inline-error" role="alert">{t(accountMessage(error))}</p>}
    </> : <div className="workspace-wallet-actions"><button type="button" className="workspace-action workspace-action-danger" onClick={() => setConfirming(true)}>{t('Delete FloFi account')}</button></div>}
  </div>;
}
