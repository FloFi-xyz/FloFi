// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SecondaryWorkspace } from '../domain/secondary-workspaces';
import { useBuild009Wallet } from '../state/build009-wallet-store';
import { YourWorkflows, type WorkflowNavigation } from './saved-workflows';
import { AutomationsWorkspace, type AutomationNavigation } from './automations-workspace';
import { ExecutionCredentials, PasskeysPanel, type DelegationAccess } from './delegation-credentials';
import { PrivacyControls } from './privacy-controls';
import { useJupiter } from '../state/jupiter-store';
import { brandLabel, LABEL_MAX, networkLabel, type SavedCard } from '../domain/credentials';
import { removeSavedCredential, renameSavedCredential, saveCardReference, saveWalletReference, useCredentials } from '../state/credentials-store';
import { evmNetworkRef, useWalletConnection, type ConnectedWallet } from '../state/wallet-connection';
import { evmWalletEntries } from '../wallet/evm-discovery';
import { solanaWalletChoices } from '../wallet/solana-wallet';
import { EVM_WALLET_NETWORKS } from '../wallet/evm-networks';
import { ECOSYSTEM_LABEL } from '../wallet/wallet-registry';
import { addProviderCard, cardProviderStatus, removeProviderCard, type CardEntryStatus } from '../app/card-action';
import { parseCardFrameMessage, type CardParentMessage } from './card-frame-protocol';
import { DeleteAccount, ExportWalletDialog } from './account/account-wallets';
import { AccountIcon } from './account/account-icons';
import { accountMessage } from './account/account-messages';
import { accountState, removeAccountWallet, renameAccountWallet, type AccountState } from '../app/account-action';
import { exportActions, isLegacyWallet, WALLET_LABEL_MAX } from '../accounts/account-model';
import { walletInventory, walletStatus, type WalletInventoryEntry } from '../domain/wallet-inventory';
import { floFiWalletProviderKey, isFloFiWalletChoice } from '../wallet/flofi-wallet-sync';

type IconName = 'wallet' | 'agent' | 'key' | 'plus' | 'copy' | 'card' | 'secret';
function WorkspaceIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'wallet' ? <><path d="M20 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3M3 6h15a2 2 0 0 1 2 2"/><path d="M16 9h5v7h-5a3.5 3.5 0 0 1 0-7Z"/><path d="M16 12.5h.01"/></>
      : name === 'agent' ? <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M2 12h2m16 0h2M9 16h6M9 11v1m6-1v1"/></>
        : name === 'key' ? <><circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-3-3 3-3m-6 0 3-3"/></>
          : name === 'plus' ? <path d="M12 5v14M5 12h14"/>
            : name === 'copy' ? <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></>
              : name === 'card' ? <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/></>
                : <><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2"/></>}
  </svg>;
}

function FutureAction({ children, className = '' }: { children: ReactNode; className?: string }) {
  const { t: tr } = useLocale();
  return <button type="button" className={`workspace-action ${className}`} disabled title={tr("Coming soon")}>{children}</button>;
}

function AddAction({ children }: { children: ReactNode }) {
  return <FutureAction><WorkspaceIcon name="plus" size={16}/>{children}</FutureAction>;
}

const ecosystemIcons = { evm: '/brand/crypto/ethereum.svg', solana: '/brand/crypto/solana.svg' } as const;
const networkIcons: Record<string, string> = {
  'eip155:8453': '/brand/crypto/base.svg', 'eip155:84532': '/brand/crypto/base.svg', 'eip155:42161': '/brand/crypto/arbitrum.png',
  'eip155:1': '/brand/crypto/ethereum.svg', 'eip155:11155111': '/brand/crypto/ethereum.svg',
};
function credentialNetworkLabel(network: string | null): string {
  if (network?.startsWith('eip155:')) return EVM_WALLET_NETWORKS.find(candidate => candidate.chain === network)?.label ?? `Chain ${network.slice(7)}`;
  return networkLabel(network);
}

/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-03): one wallet of Credentials → Wallets — a device reference, the connection in this page, an
 * account wallet, or any of them together (src/domain/wallet-inventory.ts). Never a key or balance. Actions follow what the entry is:
 * rename (account or device name), export (FloFi-managed wallets only, in the provider's own screen), save, connect/disconnect, and remove
 * (a device reference, or an external wallet's account association; FloFi-managed wallets stay in the account).
 */
const DESIGNATION = { privy: 'Managed by Privy', legacy: 'Legacy FloFi Wallet', external: 'External' } as const;
function WalletCredentialCard({ entry, busy, accountView, onConnect, onDisconnect, onSave, onStatus, onAccountChanged }: {
  entry: WalletInventoryEntry; busy: boolean; accountView: AccountState | null; onConnect(entry: WalletInventoryEntry): void; onDisconnect(): void;
  onSave(active: ConnectedWallet): void; onStatus(message: string): void; onAccountChanged(): void;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view');
  const [draft, setDraft] = useState(entry.label);
  const [renameError, setRenameError] = useState('');
  const [exporting, setExporting] = useState(false);
  const renameId = useId();
  const { t: tr } = useLocale();
  const account = entry.account, removable = Boolean(entry.saved || account?.origin === 'external');
  async function copyAddress() {
    try { await navigator.clipboard.writeText(entry.address); onStatus('Address copied.'); } catch { onStatus('Address could not be copied.'); }
  }
  async function rename() {
    if (account) {
      const result = await renameAccountWallet(account.id, draft).catch(() => ({ ok: false as const, code: 'ACCOUNTS_UNAVAILABLE' }));
      if (!result.ok) { setRenameError(accountMessage(result.code)); return; }
      if (entry.saved) { try { renameSavedCredential(entry.saved.id, draft); } catch { /* the account name is the one shown */ } }
      setMode('view'); setRenameError(''); onStatus('Wallet renamed.'); onAccountChanged(); return;
    }
    if (!entry.saved) return;
    try { renameSavedCredential(entry.saved.id, draft); setMode('view'); setRenameError(''); onStatus('Wallet renamed.'); }
    catch { setRenameError(`Use 1–${LABEL_MAX} characters.`); }
  }
  async function remove() {
    if (account?.origin === 'external') {
      const result = await removeAccountWallet(account.id).catch(() => ({ ok: false as const, code: 'ACCOUNTS_UNAVAILABLE' }));
      if (!result.ok) { setRenameError(accountMessage(result.code)); return; }
      onAccountChanged();
    }
    if (entry.active) onDisconnect();
    if (entry.saved) removeSavedCredential(entry.saved.id);
    onStatus(`${entry.label} removed from FloFi. Your wallet and its funds are unchanged.`);
  }
  const status = walletStatus(entry);
  const icon = (entry.network && networkIcons[entry.network]) ?? ecosystemIcons[entry.ecosystem];
  return <article className="workspace-wallet-card" aria-label={`${entry.label}, ${ECOSYSTEM_LABEL[entry.ecosystem]}`} data-active={entry.active ? 'true' : 'false'}
    {...account ? { 'data-origin': account.origin } : {}} data-designation={entry.designation}>
    <div className="workspace-wallet-heading">
      <span className="workspace-network-icon"><img src={icon} width="28" height="28" alt=""/></span>
      <div><h3>{entry.label}</h3><p>{entry.providerName} · {ECOSYSTEM_LABEL[entry.ecosystem]}{account || entry.designation !== 'external' ? <> · {tr(DESIGNATION[entry.designation])}</> : null}</p></div>
      <span className={`workspace-wallet-status${entry.active ? ' workspace-wallet-status-active' : ''}`}>{tr(status)}</span>
    </div>
    {entry.designation === 'privy' && <p className="workspace-wallet-signing" data-managed-signing="privy">{tr('Signs with your FloFi wallet (Privy), after you review the transaction in FloFi.')}</p>}
    {entry.designation === 'legacy' && <p className="workspace-wallet-signing" data-managed-signing="legacy">{tr(accountMessage('LEGACY_WALLET_EXPORT_ONLY'))}</p>}
    {(entry.active || entry.saved) && <p className="workspace-wallet-network">{tr(credentialNetworkLabel(entry.network))}</p>}
    <div className="workspace-wallet-address"><code title={entry.address}>{entry.address.slice(0, 6)}…{entry.address.slice(-4)}</code>
      <button type="button" className="workspace-copy" aria-label={tr('Copy {0} address', entry.label)} title={tr("Copy address")} onClick={() => void copyAddress()}><WorkspaceIcon name="copy" size={17}/></button>
    </div>
    {mode === 'rename' && (entry.saved || account) ? <form className="workspace-inline-form" onSubmit={event => { event.preventDefault(); void rename(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setMode('view'); setDraft(entry.label); setRenameError(''); } }}>
      <label htmlFor={renameId}>{tr("Wallet name")}</label>
      <input id={renameId} value={draft} maxLength={account ? WALLET_LABEL_MAX : LABEL_MAX} autoComplete="off" autoFocus aria-invalid={renameError ? 'true' : undefined}
        aria-describedby={renameError ? `${renameId}-error` : undefined} onChange={event => setDraft(event.currentTarget.value)}/>
      {renameError && <p id={`${renameId}-error`} className="workspace-inline-error" role="alert">{tr(renameError)}</p>}
      <div className="workspace-wallet-actions"><button type="submit" className="workspace-action">{tr("Save name")}</button>
        <button type="button" className="workspace-action" onClick={() => { setMode('view'); setDraft(entry.label); setRenameError(''); }}>{tr("Cancel")}</button></div>
    </form> : mode === 'remove' && removable ? <div className="workspace-inline-form" role="group" aria-label={tr('Remove {0}', entry.label)}>
      <p>{tr('Remove {0} from FloFi?', entry.label)}{tr(entry.active ? ' This also disconnects it.' : '')}{tr(" Only FloFi's reference is removed; the wallet and its assets are not affected.")}</p>
      {renameError && <p className="workspace-inline-error" role="alert">{tr(renameError)}</p>}
      <div className="workspace-wallet-actions"><button type="button" className="workspace-action workspace-action-danger" onClick={() => void remove()}>{tr("Remove")}</button>
        <button type="button" className="workspace-action" onClick={() => setMode('view')}>{tr("Cancel")}</button></div>
    </div> : <div className="workspace-wallet-actions">
      {(entry.saved || account) && <button type="button" className="workspace-action" aria-label={tr('Rename {0}', entry.label)} onClick={() => { setDraft(entry.label); setMode('rename'); }}>{tr("Rename")}</button>}
      {account && accountView && exportActions(account).length > 0 && <button type="button" className="workspace-action" aria-label={tr('Export {0}', entry.label)} onClick={() => setExporting(true)}>{tr('Export')}</button>}
      {!entry.saved && !account && entry.active && <button type="button" className="workspace-action" aria-label={tr('Save {0}', entry.label)} onClick={() => onSave(entry.active!)}>{tr("Save")}</button>}
      {entry.active ? <button type="button" className="workspace-action" aria-label={tr('Disconnect {0}', entry.label)} disabled={busy} onClick={onDisconnect}>{tr("Disconnect")}</button>
        : (entry.saved || account && !isLegacyWallet(account)) && <button type="button" className="workspace-action" aria-label={tr('Connect {0}', entry.label)} disabled={busy} onClick={() => onConnect(entry)}>{tr("Connect")}</button>}
      {/* BUILD-FLOFI-PRIVY-UX-001: wallets FloFi's provider keeps (Privy, legacy FloFi Wallet) stay in the account (account-store.ts removeWallet). */}
      {removable && <button type="button" className="workspace-action" aria-label={tr('Remove {0}', entry.label)} onClick={() => setMode('remove')}>{tr("Remove")}</button>}
    </div>}
    {exporting && account && accountView && <ExportWalletDialog wallet={account} state={accountView} onClose={() => setExporting(false)}/>}
  </article>;
}

/** Removal codes after which the saved reference can no longer be used at the provider: FloFi's copy is removed anyway. */
const CARD_REFERENCE_UNUSABLE = new Set(['CARD_TOKENIZATION_PROVIDER_REQUIRED', 'CARD_BINDING_INVALID', 'CARD_PROVIDER_NOT_FOUND']);
function CardCredential({ card, onStatus }: { card: SavedCard; onStatus(message: string): void }) {
  const { t: tr } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  async function remove() {
    setRemoving(true);
    // The saved-card reference at the provider goes first; the card itself is never affected.
    const removed = await removeProviderCard(card.binding).catch(() => ({ ok: false as const, code: 'CARD_PROVIDER_UNREACHABLE' }));
    setRemoving(false);
    if (!removed.ok && !CARD_REFERENCE_UNUSABLE.has(removed.code)) { onStatus('This card could not be removed right now. Try again.'); return; }
    removeSavedCredential(card.id); onStatus('Card removed from FloFi.');
  }
  return <article className="workspace-wallet-card workspace-card-credential" aria-label={card.label}>
    <div className="workspace-wallet-heading">
      <span className="workspace-network-icon"><WorkspaceIcon name="card" size={24}/></span>
      <div><h3>{card.label}</h3><p>{brandLabel(card.brand)} · {card.providerName}</p></div>
    </div>
    <p className="workspace-wallet-network"><span className="numeric">•••• {card.last4}</span>{tr(' · Expires {0}', `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`)}</p>
    {confirming ? <div className="workspace-inline-form" role="group" aria-label={tr('Remove {0}', card.label)}>
      <p>{tr("Remove this card from FloFi? The card itself is not affected.")}</p>
      <div className="workspace-wallet-actions"><button type="button" className="workspace-action workspace-action-danger" disabled={removing}
        onClick={() => void remove()}>{tr("Remove")}</button>
        <button type="button" className="workspace-action" onClick={() => setConfirming(false)}>{tr("Cancel")}</button></div>
    </div> : <div className="workspace-wallet-actions"><button type="button" className="workspace-action" aria-label={tr('Remove {0}', card.label)} onClick={() => setConfirming(true)}>{tr("Remove")}</button></div>}
  </article>;
}

const CARD_ERRORS: Readonly<Record<string, string>> = {
  CARD_EMAIL_INVALID: 'Enter a valid email address.',
  CARD_LIMIT_REACHED: 'This email already has the maximum number of saved cards.',
  CARD_REJECTED_BY_PROVIDER: 'The card could not be saved. Check the details and try again.',
  CARD_TOKEN_INVALID: 'The card could not be saved. Check the details and try again.',
};
/** How long Add card waits for the card page to report ready or unavailable. */
const CARD_FRAME_TIMEOUT_MS = 20_000;
/**
 * The provider's secure entry, framed from the card origin (src/server/card-origin.ts): Mercado Pago's SDK never runs on this origin,
 * which hosts the FloFi wallet signer. The card number, expiry and security code are typed into the provider's own iframes there; this
 * page receives only the provider's one-time token and the email (only from that origin and that frame) and saves the card with its own
 * server action. Adding a card never charges it.
 */
function SecureCardFrame({ entry, providerName, onClose, onAdded }: { entry: string; providerName: string; onClose(): void; onAdded(label: string): void }) {
  const { t: tr, language } = useLocale();
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const origin = new URL(entry).origin;
  const theme = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const src = `${entry}?lang=${language}&theme=${theme}`;
  const close = useRef(onClose), added = useRef(onAdded), closeButton = useRef<HTMLButtonElement>(null);
  close.current = onClose; added.current = onAdded;
  useEffect(() => {
    let saving = false;
    const reply = (message: CardParentMessage) => frame.current?.contentWindow?.postMessage(message, origin);
    async function save(token: string, email: string) {
      if (saving) return;
      saving = true;
      const result = await addProviderCard({ token, email }).catch(() => ({ ok: false as const, code: 'CARD_PROVIDER_UNREACHABLE' }));
      saving = false;
      if (!result.ok) { reply({ type: 'flofi-card-result', ok: false, error: CARD_ERRORS[result.code] ?? 'The card could not be added. Nothing was saved.' }); return; }
      try {
        const saved = saveCardReference(result.value).cards.find(card => card.providerCardId === result.value.providerCardId && card.provider === result.value.provider);
        reply({ type: 'flofi-card-result', ok: true }); added.current(saved?.label ?? 'Card');
      } catch { reply({ type: 'flofi-card-result', ok: false, error: 'The card could not be added. Nothing was saved.' }); }
    }
    function onMessage(event: MessageEvent) {
      if (event.origin !== origin || !frame.current || event.source !== frame.current.contentWindow) return;
      const message = parseCardFrameMessage(event.data);
      if (!message) return;
      if (message.type === 'flofi-card-ready') setPhase('ready');
      else if (message.type === 'flofi-card-unavailable') setPhase('unavailable');
      else if (message.type === 'flofi-card-cancel') close.current();
      else void save(message.token, message.email);
    }
    window.addEventListener('message', onMessage);
    // A frame that never answers (card origin not reachable, framing refused) ends as unavailable instead of a blank, busy dialog.
    const timeout = setTimeout(() => setPhase(current => current === 'loading' ? 'unavailable' : current), CARD_FRAME_TIMEOUT_MS);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timeout); };
  }, [origin]);
  // The frame (and any focus inside it) is gone once entry is unavailable: focus moves to Close.
  useEffect(() => { if (phase === 'unavailable') closeButton.current?.focus(); }, [phase]);
  if (phase === 'unavailable') return <><div role="status" className="card-entry-body"><p>{tr("Secure card entry could not be loaded. Nothing was collected. Try again later.")}</p></div>
    <div className="wallet-selector-footer"><button ref={closeButton} type="button" className="workspace-action" onClick={onClose}>{tr("Close")}</button></div></>;
  // Sandboxed (it keeps its own origin for the provider) so the card page can never navigate this page; no Payment Request permission.
  return <>{phase === 'loading' && <p role="status" className="card-entry-loading">{tr('Loading secure card entry…')}</p>}
    <iframe ref={frame} className="card-entry-frame" src={src} title={tr('{0} secure card entry', providerName)} referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups" aria-busy={phase !== 'ready'}/></>;
}

/**
 * Add card opens the configured provider's secure entry. FloFi renders no card-number or security-code field of its own;
 * without a configured provider it states the prerequisite instead of collecting anything.
 */
function CardEntryDialog({ onClose, onAdded }: { onClose(): void; onAdded(label: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t: tr } = useLocale();
  const titleId = useId(), bodyId = useId();
  const [status, setStatus] = useState<CardEntryStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    let current = true;
    void cardProviderStatus().then(value => { if (current) setStatus(value); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; if (element?.open) element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const secure = status?.available ? status : null;
  return <dialog ref={dialog} className="wallet-selector card-entry" aria-labelledby={titleId} aria-describedby={secure ? undefined : bodyId}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="wallet-selector-panel">
      <div className="wallet-selector-head"><h2 id={titleId}>{tr("Add a card")}</h2>
        <button type="button" className="wallet-selector-close" aria-label={tr("Close")} autoFocus onClick={onClose}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button></div>
      {secure ? <SecureCardFrame entry={secure.entry} providerName={secure.provider.name} onClose={onClose} onAdded={onAdded}/> : <>
        <div id={bodyId} role="status" className="card-entry-body">
          {failed ? <p>{tr("Card entry status could not be checked. Nothing was collected. Try again later.")}</p>
            : !status ? <p>{tr("Checking secure card entry…")}</p>
              : <><p><strong>{tr("Secure card entry isn't available yet.")}</strong></p>
                <p>{tr(!status.available && status.code === 'CARD_ORIGIN_REQUIRED'
                  ? "FloFi never asks for your card number or security code in its own forms. Cards are added only through the card provider's secure entry, on FloFi's separate card page, which isn't set up on this deployment yet."
                  : "FloFi never asks for your card number or security code in its own forms. Cards are added only through a certified card provider's secure entry, and no card provider is connected to FloFi yet.")}</p></>}
        </div>
        <div className="wallet-selector-footer"><button type="button" className="workspace-action" onClick={onClose}>{tr("Close")}</button></div></>}
    </div>
  </dialog>;
}

function CredentialsWorkspace({ access }: { access?: DelegationAccess | undefined }) {
  const { t: tr } = useLocale();
  const evm = useBuild009Wallet();
  const solana = useJupiter();
  const credentials = useCredentials();
  const connection = useWalletConnection();
  const [status, setStatus] = useState('');
  const [cardEntry, setCardEntry] = useState(false);
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-03): the signed-in account's wallets join this one section (read after load, public data only).
  const [account, setAccount] = useState<AccountState | null>(null);
  const loadAccount = useCallback(() => { void accountState().then(setAccount, () => setAccount(null)); }, []);
  useEffect(() => { loadAccount(); }, [loadAccount]);
  // A Google/Apple/email link that failed returns here with a classified code.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('account_error');
    if (code && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)) setStatus(accountMessage(code));
  }, []);
  const active: ConnectedWallet[] = [];
  if (evm.account) active.push({ ecosystem: 'evm', address: evm.account, providerKey: evm.provider?.key ?? 'injected', providerName: evm.provider?.name ?? 'Browser wallet', network: evmNetworkRef(evm.chainId) });
  if (solana.session) active.push({ ecosystem: 'solana', address: solana.session.account.address, providerKey: solana.session.wallet.name, providerName: solana.session.wallet.name, network: solana.session.chain });
  const signedIn = Boolean(account?.availability.accounts && account.account);
  const entries = walletInventory({ account: signedIn ? account!.account!.wallets : [], saved: credentials.wallets, active,
    isFloFiProvider: wallet => isFloFiWalletChoice({ ecosystem: wallet.ecosystem, key: wallet.providerKey }) });
  const busy = evm.busy || solana.busy;
  function save(wallet: ConnectedWallet) {
    try { saveWalletReference(wallet); setStatus(`${wallet.providerName} saved to Credentials.`); } catch { setStatus('This wallet could not be saved.'); }
  }
  async function addWallet() {
    setStatus('');
    const connected = await connection.connect({ title: 'Add a wallet' });
    if (connected) save(connected);
  }
  function disconnect(wallet: WalletInventoryEntry) {
    if (wallet.ecosystem === 'evm') evm.reset(); else void solana.disconnect();
    setStatus(`${wallet.label} disconnected.`);
  }
  /** Connects exactly this entry's wallet: its saved provider, or the provider of the account wallet (FloFi wallets through FloFi's own provider). */
  async function activate(entry: WalletInventoryEntry) {
    setStatus('');
    const providerKey = entry.saved?.providerKey ?? (entry.designation === 'privy' ? floFiWalletProviderKey(entry.ecosystem, entry.address) : entry.providerKey);
    const providerName = entry.saved?.providerName ?? entry.providerName;
    const mismatch = (address: string) => setStatus(`${providerName} connected ${address.slice(0, 6)}…${address.slice(-4)}, not this saved wallet. Choose ${entry.address.slice(0, 6)}…${entry.address.slice(-4)} in ${providerName} to use it.`);
    if (!providerKey) { setStatus(`${providerName} isn't detected in this browser.`); return; }
    if (entry.ecosystem === 'evm') {
      const found = evmWalletEntries().find(candidate => candidate.choice.key === providerKey);
      if (!found) { setStatus(`${providerName} isn't detected in this browser.`); return; }
      const session = await evm.connectWith(found.choice.id);
      if (session && session.account !== entry.address.toLowerCase()) mismatch(session.account);
      return;
    }
    if (!solanaWalletChoices().some(choice => choice.key === providerKey)) { setStatus(`${providerName} isn't detected in this browser.`); return; }
    const session = await solana.connectWith(providerKey, connection.solanaChain);
    if (!session) setStatus(`${providerName} did not connect.`);
    else if (session.account.address !== entry.address) mismatch(session.account.address);
  }
  return <>
    <header className="secondary-workspace-heading"><h1>{tr("Credentials")}</h1><p>{tr("Keep the wallets and cards you use with FloFi in one place. Saved credentials are references only: they never approve a transaction or a payment.")}</p></header>
    <p className="workspace-notice" role="status">{tr(status || connection.error || '')}</p>
    <section className="workspace-section" aria-labelledby="credentials-wallets">
      <div className="workspace-section-heading"><div><WorkspaceIcon name="wallet"/><h2 id="credentials-wallets">{tr("Wallets")}</h2><span className="workspace-count">{entries.length}</span></div>
        <div className="workspace-wallet-actions">
          {signedIn && account!.availability.managedWallets && <a className="workspace-action" style={{ textDecoration: 'none' }} href="/onboarding/wallets"><AccountIcon name="plus" size={16}/>{tr('Create or import')}</a>}
          <button type="button" className="workspace-action" disabled={busy} onClick={() => void addWallet()}><WorkspaceIcon name="plus" size={16}/>{tr("Add wallet")}</button>
        </div></div>
      {account?.availability.accounts && !account.account && <p className="workspace-notice">{tr('Sign in to save wallet addresses to your account and find them on any device. Wallets saved only on this device are listed below.')}{' '}
        <a href="/login?returnTo=%2Fapp%2Fcredentials">{tr('Sign in')}</a></p>}
      {entries.length ? <div className="workspace-wallet-grid">{entries.map(entry => <WalletCredentialCard key={entry.key}
        entry={entry} busy={busy} accountView={signedIn ? account : null} onConnect={target => void activate(target)} onDisconnect={() => disconnect(entry)} onSave={save}
        onStatus={setStatus} onAccountChanged={loadAccount}/>)}</div>
        : <div className="workspace-empty"><span className="workspace-empty-icon"><WorkspaceIcon name="wallet" size={28}/></span><h3>{tr("No wallets yet")}</h3><p>{tr("Add a wallet to save its public address here. FloFi never holds your keys.")}</p></div>}
      {signedIn && <DeleteAccount state={account!}/>}
    </section>
    <section className="workspace-section" aria-labelledby="credentials-cards">
      <div className="workspace-section-heading"><div><WorkspaceIcon name="card"/><h2 id="credentials-cards">{tr("Cards")}</h2><span className="workspace-count">{credentials.cards.length}</span></div>
        <button type="button" className="workspace-action" onClick={() => setCardEntry(true)}><WorkspaceIcon name="plus" size={16}/>{tr("Add card")}</button></div>
      {credentials.cards.length ? <div className="workspace-wallet-grid">{credentials.cards.map(card => <CardCredential key={card.id} card={card} onStatus={setStatus}/>)}</div>
        : <div className="workspace-empty"><span className="workspace-empty-icon"><WorkspaceIcon name="card" size={28}/></span><h3>{tr("No cards yet")}</h3><p>{tr("Cards are added through a certified card provider's secure entry. FloFi never sees or stores your card number or security code.")}</p></div>}
    </section>
    <section className="workspace-section" aria-labelledby="credentials-payments">
      <div className="workspace-section-heading"><div><WorkspaceIcon name="key"/><h2 id="credentials-payments">{tr("Payment connections")}</h2><span className="workspace-count">0</span></div></div>
      <div className="workspace-empty"><span className="workspace-empty-icon"><WorkspaceIcon name="key" size={28}/></span><h3>{tr("No payment provider connected")}</h3><p>{tr("Pix and boleto payments need a connected payment provider. None is connected yet.")}</p></div>
    </section>
    {/* BUILD-AUTOMATION-002: execution Credentials (only where delegated execution is enabled; otherwise nothing renders). */}
    <ExecutionCredentials access={access}/>
    <div className="workspace-secondary-actions"><FutureAction><WorkspaceIcon name="plus" size={16}/><WorkspaceIcon name="secret" size={18}/>{tr("Add secret")}</FutureAction></div>
    {cardEntry && <CardEntryDialog onClose={() => setCardEntry(false)} onAdded={label => { setCardEntry(false); setStatus(`${label} added to Credentials.`); }}/>}
  </>;
}

function AgentsWorkspace() {
  const { t: tr } = useLocale();
  return <>
    <header className="secondary-workspace-heading"><h1>{tr("Agents")}</h1><p>{tr("Connect AI agents and integrations to FloFi with explicit permissions and your authorization.")}</p></header>
    <section className="workspace-connect-panel" aria-labelledby="connect-agent"><h2 id="connect-agent">{tr("CONNECT AN AGENT")}</h2>
      <div className="workspace-provider-list">{[
        { name: 'Claude', light: '/brand/providers/claude-spark.svg', dark: null },
        { name: 'ChatGPT', light: '/brand/providers/openai-blossom-black.svg', dark: '/brand/providers/openai-blossom-white.svg' },
      ].map(provider => <FutureAction key={provider.name} className="workspace-provider"><span className="workspace-provider-mark" aria-hidden="true">
        <img src={provider.light} className={provider.dark ? 'provider-mark-light' : undefined} width={provider.dark ? 56 : 28} height={provider.dark ? 56 : 28} alt={tr("")}/>
        {provider.dark && <img src={provider.dark} className="provider-mark-dark" width="56" height="56" alt={tr("")}/>}
      </span><span>{tr("Connect with ")}{provider.name}</span><span className="workspace-provider-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h16m-5-5 5 5-5 5"/></svg></span></FutureAction>)}</div>
    </section>
    <section className="workspace-section" aria-labelledby="agent-clients"><div className="workspace-section-heading"><div><WorkspaceIcon name="agent"/><h2 id="agent-clients">{tr("Agents")}</h2><span className="workspace-count">{tr("0 active")}</span></div><AddAction>{tr("Create client")}</AddAction></div>
      <div className="workspace-empty"><span className="workspace-empty-icon"><WorkspaceIcon name="agent" size={28}/></span><h3>{tr("No agent clients yet.")}</h3><AddAction>{tr("Create client")}</AddAction></div>
    </section>
  </>;
}

function PasskeysWorkspace({ access }: { access?: DelegationAccess | undefined }) {
  const { t: tr } = useLocale();
  // BUILD-AUTOMATION-002: the passkey manager where delegated execution is enabled; this placeholder everywhere else.
  return <PasskeysPanel access={access} placeholder={<>
    <header className="secondary-workspace-heading"><h1>{tr("Passkeys")}</h1><p>{tr("Manage device passkeys associated with your FloFi account or session.")}</p></header>
    <section className="workspace-passkey-control" aria-labelledby="passkey-unlock"><button type="button" role="switch" className="workspace-passkey-switch" aria-checked="false" aria-labelledby="passkey-unlock" aria-describedby="passkey-help" disabled title={tr("Coming soon")}><span/></button>
      <div><h2 id="passkey-unlock">{tr("Unlock with a passkey")}</h2><p id="passkey-help">{tr("Turn on to add a passkey.")}</p></div>
    </section>
    <section className="workspace-empty workspace-passkey-empty" aria-label={tr("Passkeys")}><span className="workspace-empty-icon"><WorkspaceIcon name="key" size={28}/></span><p>{tr("No passkeys yet. Add one to get started.")}</p></section>
  </>}/>;
}

export function SecondaryProductWorkspace({ workspace, workflows, automations }: { workspace: SecondaryWorkspace['id']; workflows?: WorkflowNavigation | undefined;
  automations?: AutomationNavigation | undefined }) {
  const access: DelegationAccess | undefined = automations?.proof ? { owner: automations.owner ?? null, proof: automations.proof } : undefined;
  return workspace === 'workflows' ? <YourWorkflows {...workflows}/> : workspace === 'automations' ? <AutomationsWorkspace {...automations}/>
    : workspace === 'credentials' ? <CredentialsWorkspace access={access}/> : workspace === 'agents' ? <AgentsWorkspace/>
      // BUILD-CHAT-LEARNING-002: the Copilot's privacy controls, reached from Settings.
      : workspace === 'privacy' ? <PrivacyControls proof={automations?.proof}/> : <PasskeysWorkspace access={access}/>;
}
