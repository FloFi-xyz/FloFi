// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: create or import wallets (EVM and Solana) with the embedded-wallet provider.
 *
 * "Save wallets" stays disabled until at least one wallet was really created or imported at the provider in this visit. Saving
 * sends only wallet ids (`<ecosystem>:<address>`); the server asks the provider to confirm each one belongs to this person before it
 * stores public metadata. Import happens in the provider's own frame: FloFi renders no private-key field. When this deployment or
 * this browser cannot do it, the screen says why and nothing is simulated.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { saveManagedWallets, setAccountOnboarding, startSocialSignIn, type AccountState } from '../../app/account-action';
import { accountWalletId, canonicalAddress, shortAddress } from '../../accounts/account-model';
import type { WalletEcosystem } from '../../wallet/wallet-registry';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import { AccountShell, accountStyles as styles } from './account-shell';

type Readiness = 'checking' | 'ready' | 'not-configured' | 'needs-social' | 'locked';
type Pending = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly origin: 'generated' | 'imported' };

/** Whether this browser's provider key holds a live session for this account's wallet organization. */
export function useManagedReadiness(state: AccountState | null): Readiness {
  const [readiness, setReadiness] = useState<Readiness>('checking');
  useEffect(() => {
    let current = true;
    if (!state?.account) { setReadiness('checking'); return; }
    if (!state.availability.managedWallets || !state.provider) { setReadiness('not-configured'); return; }
    if (state.account.method === 'eip155' || state.account.method === 'solana') { setReadiness('needs-social'); return; }
    if (!state.managed || Date.parse(state.managed.expiresAt) <= Date.now()) { setReadiness('locked'); return; }
    void import('../../accounts/turnkey-browser').then(module => module.sessionPublicKey())
      .then(key => { if (current) setReadiness(key === state.managed!.sessionKey ? 'ready' : 'locked'); }, () => { if (current) setReadiness('locked'); });
    return () => { current = false; };
  }, [state]);
  return readiness;
}
/** Signs in again with the method that unlocks this account's wallets, returning to `returnTo`. */
export async function unlockManagedWallets(state: AccountState, returnTo: string): Promise<string | null> {
  const login = state.account?.managedLogin ?? state.account?.method;
  if (login === 'email') { window.location.assign(`/login?method=email&returnTo=${encodeURIComponent(returnTo)}`); return null; }
  if (login !== 'google' && login !== 'apple') return 'MANAGED_WALLETS_NEED_SOCIAL_SIGN_IN';
  const key = await (await import('../../accounts/turnkey-browser')).sessionPublicKey().catch(() => null);
  const started = await startSocialSignIn(login, key, 'sign-in', returnTo).catch(() => ({ ok: false as const, code: 'ACCOUNT_REQUEST_FAILED' }));
  if (started.ok) { window.location.assign(started.value.url); return null; }
  return started.code;
}

function ImportDialog({ state, ecosystem, onClose, onImported }: { state: AccountState; ecosystem: WalletEcosystem; onClose(): void; onImported(wallet: Pending): void }) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null), container = useRef<HTMLDivElement>(null);
  const controller = useRef<{ submit(): Promise<{ address: string }>; close(): void } | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'importing' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    let current = true;
    void import('../../accounts/turnkey-browser').then(module => module.openImportFrame(state.provider!, state.managed!, ecosystem, container.current!))
      .then(opened => {
        if (!current) { opened.close(); return; }
        container.current?.querySelector('iframe')?.setAttribute('title', t('Turnkey secure key field'));
        controller.current = opened; setPhase('ready');
      },
        cause => { if (current) { setPhase('failed'); setError(cause instanceof Error ? cause.message : 'MANAGED_IMPORT_UNAVAILABLE'); } });
    return () => { current = false; controller.current?.close(); controller.current = null; if (element?.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [state, ecosystem, t]);
  async function submit() {
    if (!controller.current) return;
    setPhase('importing'); setError(null);
    try {
      const imported = await controller.current.submit(), address = canonicalAddress(ecosystem, imported.address);
      if (!address) throw new Error('MANAGED_RESPONSE_INVALID');
      onImported({ ecosystem, address, origin: 'imported' });
    } catch (cause) { setPhase('ready'); setError(cause instanceof Error ? cause.message : 'MANAGED_ACTIVITY_NOT_COMPLETED'); }
  }
  const name = ecosystem === 'evm' ? 'EVM' : 'Solana';
  return <dialog ref={dialog} className={styles.frameDialog} aria-labelledby="import-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.frameBody}>
      <button type="button" className={styles.close} aria-label={t('Close')} onClick={onClose}><AccountIcon name="close" size={16}/></button>
      <h2 id="import-title">{t('Import {0} key', name)}</h2>
      <p>{t(ecosystem === 'evm' ? 'Paste the private key (64 hexadecimal characters) of the wallet you want to bring.' : 'Paste the private key (base58) of the Solana wallet you want to bring.')}</p>
      <div className={styles.warning}><AccountIcon name="warning" size={18}/><span>{t('Type or paste it only into the secure field below. It belongs to Turnkey, on its own domain: FloFi cannot read it, and it is encrypted before it leaves this field.')}</span></div>
      <div ref={container} className={styles.frame} role="group" aria-label={t('Turnkey secure key field')} aria-busy={phase === 'loading'}/>
      {phase === 'loading' && <p className={styles.status} role="status">{t('Opening the secure field…')}</p>}
      {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
      <button type="button" className={styles.primary} disabled={phase !== 'ready'} onClick={() => void submit()}>{t(phase === 'importing' ? 'Importing…' : 'Import wallet')}</button>
      <p className={styles.protected}><AccountIcon name="lock" size={14}/>{t('Protected by')} <strong>Turnkey</strong></p>
    </div>
  </dialog>;
}

export function AddWallets({ state }: { state: AccountState }) {
  const { t } = useLocale();
  const readiness = useManagedReadiness(state);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState<WalletEcosystem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const ready = readiness === 'ready';
  const add = (wallet: Pending) => setPending(current => current.some(entry => entry.ecosystem === wallet.ecosystem && entry.address === wallet.address) ? current : [...current, wallet]);
  async function create(ecosystem: WalletEcosystem) {
    setBusy(`create:${ecosystem}`); setError(null); setStatus('');
    try {
      const module = await import('../../accounts/turnkey-browser');
      const created = await module.createManagedWallet(state.provider!, state.managed!, ecosystem), address = canonicalAddress(ecosystem, created.address);
      if (!address) throw new Error('MANAGED_RESPONSE_INVALID');
      add({ ecosystem, address, origin: 'generated' });
      setStatus(t('{0} wallet created: {1}', ecosystem === 'evm' ? 'EVM' : 'Solana', shortAddress(address)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'MANAGED_ACTIVITY_NOT_COMPLETED'); }
    finally { setBusy(null); }
  }
  async function save() {
    setBusy('save'); setError(null);
    const saved = await saveManagedWallets(pending.map(wallet => accountWalletId(wallet.ecosystem, wallet.address))).catch(() => ({ ok: false as const, code: 'ACCOUNT_WALLET_SAVE_FAILED' }));
    if (!saved.ok) { setBusy(null); setError(saved.code); return; }
    await setAccountOnboarding('completed').catch(() => undefined);
    window.location.assign('/app');
  }
  async function unlock() {
    setBusy('unlock'); setError(null);
    const failed = await unlockManagedWallets(state, '/onboarding/wallets');
    if (failed) { setBusy(null); setError(failed); }
  }
  const tile = (ecosystem: WalletEcosystem, kind: 'create' | 'import') => {
    const done = pending.filter(wallet => wallet.ecosystem === ecosystem && wallet.origin === (kind === 'create' ? 'generated' : 'imported'));
    return <button type="button" className={`${styles.tile}${done.length ? ` ${styles.tileDone}` : ''}`} disabled={!ready || busy !== null}
      aria-label={`${t(kind === 'create' ? 'Create {0} wallet' : 'Import {0} key', ecosystem === 'evm' ? 'EVM' : 'Solana')}${done.length
        ? ` — ${t(kind === 'create' ? 'created: {0}' : 'imported: {0}', done.map(wallet => shortAddress(wallet.address)).join(', '))}` : ''}`}
      onClick={() => kind === 'create' ? void create(ecosystem) : setImporting(ecosystem)}>
      <strong><AccountIcon name={done.length ? 'check' : kind === 'create' ? 'plus' : 'import'} size={16}/>{t(kind === 'create' ? 'Create wallet' : 'Import key')}</strong>
      {done.length ? <code>{done.map(wallet => shortAddress(wallet.address)).join(', ')}</code>
        : <small>{t(busy === `create:${ecosystem}` && kind === 'create' ? 'Creating…' : kind === 'create' ? 'Generate a fresh wallet in seconds, ready to use right away'
          : 'Bring an existing wallet with its private key, entered in Turnkey’s secure field')}</small>}
    </button>;
  };
  return <AccountShell showcase="wallets" start>
    <p className={styles.crumbs}><a href="/onboarding">{t('Account')}</a> / <span aria-current="page">{t('Add wallets')}</span></p>
    <h1 className={styles.heading} style={{ marginTop: 28 }}>{t('Add your wallets')}</h1>
    <p className={`${styles.lead} ${styles.center}`} style={{ textAlign: 'center' }}>{t('Create a new wallet or import one you already have. Keys are created and kept by our wallet provider, Turnkey — FloFi never sees or stores them.')}</p>
    {/* The provider signing adapter is not part of this release: say so before anyone creates or imports a wallet for FloFi. */}
    <div className={styles.notice} role="note" data-managed-signing="unavailable"><span className={styles.noticeIcon}><AccountIcon name="shield" size={18}/></span><div>
      <strong>{t('FloFi can’t sign workflows with these wallets yet')}</strong>
      <p>{t('Wallets you create or import here are held by Turnkey and kept with your account, and you can export them. To review and sign transactions in FloFi today, connect MetaMask, Phantom or Solflare in Credentials.')}</p></div></div>
    {readiness === 'not-configured' && <div className={styles.banner} role="status"><strong>{t("Creating and importing wallets isn't available on this deployment yet.")}</strong>
      <p>{t('You can still connect MetaMask, Phantom or Solflare in Credentials and use them with FloFi.')}</p></div>}
    {readiness === 'needs-social' && <div className={styles.banner} role="status"><strong>{t('You signed in with a wallet.')}</strong>
      <p>{t('Creating or importing wallets needs a Google, Apple or email sign-in, which also protects their recovery. Your connected wallet keeps working as it is.')}</p></div>}
    {readiness === 'locked' && <div className={styles.banner} role="status"><strong>{t('Confirm it’s you to add wallets')}</strong>
      <p>{t('Your secure wallet session in this browser has ended. Sign in again to create or import wallets.')}</p>
      <button type="button" className={styles.quiet} disabled={busy !== null} onClick={() => void unlock()}><AccountIcon name="lock" size={16}/>{t('Sign in again')}</button></div>}
    <section className={`${styles.ecosystem} ${styles.ecosystemEvm}`} aria-label="EVM">
      <div className={styles.ecosystemTab}><img src="/brand/crypto/ethereum.svg" alt=""/><span>EVM</span></div>
      <div className={styles.tiles}>{tile('evm', 'create')}{tile('evm', 'import')}</div>
    </section>
    <section className={`${styles.ecosystem} ${styles.ecosystemSolana}`} aria-label="Solana">
      <div className={styles.ecosystemTab}><img src="/brand/crypto/solana.svg" alt=""/><span>Solana</span></div>
      <div className={styles.tiles}>{tile('solana', 'create')}{tile('solana', 'import')}</div>
    </section>
    {pending.length > 0 && <ul className={styles.pending} aria-label={t('Wallets ready to save')}>{pending.map(wallet => <li key={`${wallet.ecosystem}:${wallet.address}`}>
      <span>{wallet.ecosystem === 'evm' ? 'EVM' : 'Solana'} · <code title={wallet.address}>{shortAddress(wallet.address)}</code></span>
      <span className={`${styles.badge} ${styles.badgeGreen}`}>{t(wallet.origin === 'generated' ? 'Newly created' : 'Newly imported')}</span></li>)}</ul>}
    <p className={styles.status} role="status">{status}</p>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    <div className={styles.saveRow}>
      <button type="button" className={styles.outline} disabled={pending.length === 0 || busy !== null} onClick={() => void save()}>{t(busy === 'save' ? 'Saving…' : 'Save wallets')}</button>
      <div className={styles.row} style={{ justifyContent: 'center', gap: 22 }}>
        <a className={styles.textLink} href="/app/credentials">{t('Connect an existing wallet instead')}</a>
        <button type="button" className={styles.textLink} disabled={busy !== null} onClick={() => void setAccountOnboarding('dismissed').finally(() => window.location.assign('/app'))}>
          {t(pending.length ? 'Skip without saving these wallets' : 'Skip for now')}</button>
      </div>
      <p className={styles.small}>{t('Adding a wallet authorizes nothing. Every transaction is still simulated, reviewed and signed by you.')}</p>
    </div>
    {importing && ready && <ImportDialog state={state} ecosystem={importing} onClose={() => setImporting(null)}
      onImported={wallet => { add(wallet); setImporting(null); setStatus(t('{0} key imported: {1}', wallet.ecosystem === 'evm' ? 'EVM' : 'Solana', shortAddress(wallet.address))); }}/>}
  </AccountShell>;
}
