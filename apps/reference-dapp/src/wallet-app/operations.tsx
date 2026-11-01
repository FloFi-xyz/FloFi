// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: exporting managed wallets in FloFi Wallet (wallet origin only). Since BUILD-FLOFI-PRIVY-UX-001 FloFi Wallet is
 * the legacy, export-only home of wallets created there before Privy: creating and importing happen with Privy, in FloFi itself.
 *
 * - Export: needs an unlock in the last 5 minutes (the server and the relay enforce it too), an explicit warning the person
 *   acknowledges, and a second of attention before Show; the phrase or key is decrypted and shown only inside the provider's frame.
 */
import { useEffect, useRef, useState } from 'react';
import { exportActions, type AccountWallet } from '../accounts/account-model';
import { AccountIcon } from '../components/account/account-icons';
import { useLocale } from '../i18n/locale';
import type { WalletEcosystem } from '../wallet/wallet-registry';
import { openExportFrame } from './provider-client';
import { RequestHeading, SignControls, type RequestEnv } from './request-parts';
import { UnlockPanel } from './unlock-panel';
import { walletApi } from './wallet-api';
import { codeOf, walletMessage } from './wallet-messages';
import styles from './wallet.module.css';

const NAME: Readonly<Record<WalletEcosystem, string>> = Object.freeze({ evm: 'EVM', solana: 'Solana' });

export function WalletList({ wallets }: { wallets: readonly AccountWallet[] }) {
  const { t } = useLocale();
  if (!wallets.length) return <p className={styles.lead}>{t('This FloFi account has no wallets from the earlier FloFi Wallet.')}</p>;
  return <ul className={styles.list} aria-label={t('Your FloFi Wallets')}>
    {wallets.map(wallet => <li key={wallet.id}>
      <span className={styles.wallet}><span className={`${styles.dot} ${wallet.ecosystem === 'evm' ? styles.dotEvm : styles.dotSolana}`} aria-hidden="true"/>
        <span><strong>{wallet.label}</strong> <span className={styles.badge}>{NAME[wallet.ecosystem]}</span></span></span>
      <span className={styles.mono}>{wallet.address}</span>
    </li>)}
  </ul>;
}

export function ExportRequest({ env, walletId, kind }: { env: RequestEnv; walletId: string; kind: 'recovery-phrase' | 'private-key' }) {
  const { t } = useLocale();
  const wallet = env.context.wallets.find(entry => entry.id === walletId) ?? null;
  const container = useRef<HTMLDivElement>(null), frame = useRef<{ close(): void } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false), [stage, setStage] = useState<'confirm' | 'revealing' | 'shown'>('confirm');
  const [error, setError] = useState<string | null>(null), [stale, setStale] = useState(false);
  const what = t(kind === 'recovery-phrase' ? 'recovery phrase' : 'private key'), frameTitle = t('Turnkey secure export');
  useEffect(() => () => { frame.current?.close(); frame.current = null; }, []);
  useEffect(() => {
    if (!wallet) env.refuse('ACCOUNT_WALLET_NOT_FOUND');
    else if (!exportActions(wallet).includes(kind)) env.refuse('EXPORT_NOT_SUPPORTED');
  }, []); // Checked once, when the request arrives.
  if (!wallet || !exportActions(wallet).includes(kind)) return null;
  const needsUnlock = !env.unlocked || stale || env.freshUnlock === false;
  async function reveal() {
    setStage('revealing'); setError(null);
    try {
      const grant = await walletApi.exportGrant(wallet!, kind);
      frame.current = await openExportFrame(env.config.frames, grant, container.current!);
      container.current?.querySelector('iframe')?.setAttribute('title', frameTitle);
      setStage('shown');
    } catch (cause) {
      const code = codeOf(cause, 'MANAGED_EXPORT_UNAVAILABLE');
      // The server or the relay found the unlock too old: unlock again here, then show.
      if (code === 'WALLET_UNLOCK_REQUIRED') setStale(true);
      setError(code); setStage('confirm');
    }
  }
  const unlocked = (value: Parameters<RequestEnv['onUnlocked']>[0]) => { setStale(false); setError(null); env.onUnlocked(value); };
  return <section className={`${styles.card} ${styles.cardGlow}`} aria-labelledby="request-title">
    <RequestHeading eyebrow={t('Export')} title={t('Show the {0} of {1}', what, wallet.label)} from={env.appHost}/>
    <dl className={styles.fields}><dt>{t('Wallet')}</dt><dd className={styles.mono}>{wallet.address}</dd></dl>
    {needsUnlock ? <UnlockPanel config={env.config} context={env.context} onUnlocked={unlocked} title="Unlock again to export"
      reason="Export needs an unlock in the last 5 minutes. Unlock again with your email code, Google or Apple."/> : null}
    {!needsUnlock && stage !== 'shown' && <>
      <p className={styles.warning}><AccountIcon name="warning" size={18}/><span>{t('Anyone who sees this {0} can take everything in this wallet, on every network. FloFi and Turnkey can’t undo that. Make sure no one can see your screen.', what)}</span></p>
      <label className={styles.check}><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/>
        <span>{t('I understand, and I’m in a private place.')}</span></label>
    </>}
    <div ref={container} className={styles.providerFrame} hidden={stage === 'confirm'} role="group" aria-label={frameTitle} aria-busy={stage === 'revealing'}/>
    {stage === 'shown' && <p className={styles.hint}>{t('Write it down and keep it offline. Choose Done to hide it.')}</p>}
    {error && <p className={styles.error} role="alert">{t(walletMessage(error))}</p>}
    {stage === 'shown'
      ? <button type="button" className={styles.primary} onClick={() => { frame.current?.close(); frame.current = null; env.succeed({ done: true }, t('Export closed.')); }}>{t('Done')}</button>
      : <SignControls id={`${env.id}-export`} ready={!needsUnlock && acknowledged} busy={stage === 'revealing'} label={`Show ${kind === 'recovery-phrase' ? 'recovery phrase' : 'private key'}`}
        busyLabel="Opening…" onSign={() => void reveal()} onCancel={() => env.refuse('FLOFI_WALLET_REJECTED')}/>}
  </section>;
}
