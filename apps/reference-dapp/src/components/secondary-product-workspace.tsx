// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { accountMessage } from './account/account-messages';
import { accountState, removeAccountWallet, renameAccountWallet, type AccountState } from '../app/account-action';
import { exportActions, isLegacyWallet, WALLET_LABEL_MAX } from '../accounts/account-model';
import { walletInventory, walletStatus, type WalletInventoryEntry } from '../domain/wallet-inventory';
import { floFiWalletProviderKey, isFloFiWalletChoice } from '../wallet/flofi-wallet-sync';
import { StatusTag } from './dashboard/dashboard-status';
import { invalidateAccountWallets } from '../state/destination-wallets';

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

type MenuItem = { readonly key: string; readonly label: string; readonly ariaLabel?: string; readonly onSelect?: () => void; readonly href?: string;
  readonly tone?: 'danger'; readonly disabled?: boolean };
/**
 * P0 approved UX (boards 11–13): a "···" (or labelled) menu of real actions. Keyboard operable: Enter/Space/arrows open it and focus the first
 * action, arrows/Home/End move, Escape closes it and returns the focus to its button; Tab or a click outside just closes it. Its actions stay in
 * the page (hidden) while it is closed, as the existing record menus do.
 */
function MoreMenu({ label, items, trigger }: { label: string; items: readonly MenuItem[]; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId(), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const actions = () => [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []];
  useEffect(() => {
    if (!open) return;
    actions()[0]?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    const list = actions(), at = list.indexOf(document.activeElement as HTMLElement), last = list.length - 1;
    const next = event.key === 'ArrowDown' ? (at + 1) % list.length : event.key === 'ArrowUp' ? (at - 1 + list.length) % list.length : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next !== null && list[next]) { event.preventDefault(); list[next].focus(); }
  }
  return <div className="ux-menu" ref={root} onBlur={event => { if (open && event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={button} type="button" className={trigger ? 'ux-button' : 'ux-icon-button'} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      {...trigger ? {} : { 'aria-label': label }} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); } }}>
      {trigger ?? <span aria-hidden="true">···</span>}</button>
    <div id={id} ref={menu} role="menu" aria-label={label} className="ux-menu-list" hidden={!open} onKeyDown={onMenuKey}>
      {items.map(item => item.href ? <a key={item.key} role="menuitem" href={item.href} tabIndex={-1} {...item.ariaLabel ? { 'aria-label': item.ariaLabel } : {}}>{item.label}</a>
        : <button key={item.key} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} data-tone={item.tone} {...item.ariaLabel ? { 'aria-label': item.ariaLabel } : {}}
          onClick={() => { close(); item.onSelect?.(); }}>{item.label}</button>)}
    </div>
  </div>;
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
  // A wallet the account keeps (Privy, legacy FloFi Wallet) is never removed from the account; when this device also saved it, only this
  // device's reference can be removed ("Remove from this device").
  const account = entry.account, removable = account ? account.origin === 'external' : Boolean(entry.saved);
  const deviceOnly = Boolean(account && account.origin !== 'external' && entry.saved);
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
  // Board 13: "MetaMask wallet · EVM · in use on Base". The name stays the wallet's own identity (HOTFIX-WALLET-SELECTOR), never its provider.
  const facts = [/wallet$/i.test(entry.providerName) ? entry.providerName : tr('{0} wallet', entry.providerName), entry.ecosystem === 'evm' ? 'EVM' : ECOSYSTEM_LABEL[entry.ecosystem],
    ...account || entry.designation !== 'external' ? [tr(DESIGNATION[entry.designation])] : [],
    ...entry.active || entry.saved ? [tr(entry.active ? 'in use on {0}' : 'last used on {0}', tr(credentialNetworkLabel(entry.network)))] : []];
  const menu: MenuItem[] = [
    { key: 'copy', label: tr('Copy address'), ariaLabel: tr('Copy {0} address', entry.label), onSelect: () => void copyAddress() },
    ...entry.saved || account ? [{ key: 'rename', label: tr('Rename'), ariaLabel: tr('Rename {0}', entry.label), onSelect: () => { setDraft(entry.label); setRenameError(''); setMode('rename'); } }] : [],
    ...account && accountView && exportActions(account).length > 0 ? [{ key: 'export', label: tr('Export'), ariaLabel: tr('Export {0}', entry.label), onSelect: () => setExporting(true) }] : [],
    ...entry.active ? [{ key: 'disconnect', label: tr('Disconnect'), ariaLabel: tr('Disconnect {0}', entry.label), disabled: busy, onSelect: onDisconnect }] : [],
    // BUILD-FLOFI-PRIVY-UX-001: wallets FloFi's provider keeps (Privy, legacy FloFi Wallet) stay in the account (account-store.ts removeWallet).
    ...removable ? [{ key: 'remove', label: tr('Remove'), ariaLabel: tr('Remove {0}', entry.label), tone: 'danger' as const, onSelect: () => { setRenameError(''); setMode('remove'); } }] : [],
    ...deviceOnly ? [{ key: 'device', label: tr('Remove from this device'), ariaLabel: tr('Remove {0} from this device', entry.label),
      onSelect: () => { removeSavedCredential(entry.saved!.id); onStatus('Removed from this device. The wallet stays in your FloFi account.'); } }] : [],
  ];
  return <article className="ux-wallet-row" aria-label={`${entry.label}, ${ECOSYSTEM_LABEL[entry.ecosystem]}`} data-active={entry.active ? 'true' : 'false'}
    {...account ? { 'data-origin': account.origin } : {}} data-designation={entry.designation}>
    <div className="ux-row">
      <span className="ux-row-icon workspace-network-icon"><img src={icon} width="28" height="28" alt=""/></span>
      <div className="ux-row-main">
        <h3 className="ux-row-name">{entry.label} <code className="ux-address" title={entry.address}>{entry.address.slice(0, 6)}…{entry.address.slice(-4)}</code></h3>
        <p className="ux-row-meta">{facts.join(' · ')}</p>
        {entry.designation === 'privy' && <p className="ux-row-meta workspace-wallet-signing" data-managed-signing="privy">{tr('Signs with your FloFi wallet (Privy), after you review the transaction in FloFi.')}</p>}
        {entry.designation === 'legacy' && <p className="ux-row-meta workspace-wallet-signing" data-managed-signing="legacy">{tr(accountMessage('LEGACY_WALLET_EXPORT_ONLY'))}</p>}
      </div>
      <div className="ux-row-actions">
        <span data-tone={entry.active ? 'soon' : 'neutral'} className={`ux-tag workspace-wallet-status${entry.active ? ' workspace-wallet-status-active' : ''}`}>{tr(status)}</span>
        {!entry.saved && !account && entry.active && <button type="button" className="ux-button" aria-label={tr('Save {0}', entry.label)} onClick={() => onSave(entry.active!)}>{tr("Save")}</button>}
        {!entry.active && (entry.saved || account && !isLegacyWallet(account)) && <button type="button" className="ux-button" aria-label={tr('Connect {0}', entry.label)} disabled={busy} onClick={() => onConnect(entry)}>{tr("Connect")}</button>}
        <MoreMenu label={tr('More actions for {0}', entry.label)} items={menu}/>
      </div>
    </div>
    {mode === 'rename' && (entry.saved || account) ? <form className="ux-inline-form" onSubmit={event => { event.preventDefault(); void rename(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setMode('view'); setDraft(entry.label); setRenameError(''); } }}>
      <label htmlFor={renameId}>{tr("Wallet name")}</label>
      <input id={renameId} value={draft} maxLength={account ? WALLET_LABEL_MAX : LABEL_MAX} autoComplete="off" autoFocus aria-invalid={renameError ? 'true' : undefined}
        aria-describedby={renameError ? `${renameId}-error` : undefined} onChange={event => setDraft(event.currentTarget.value)}/>
      {renameError && <p id={`${renameId}-error`} className="workspace-inline-error" role="alert">{tr(renameError)}</p>}
      <div className="ux-inline-actions"><button type="submit" className="ux-button ux-button-small">{tr("Save name")}</button>
        <button type="button" className="ux-button ux-button-small" onClick={() => { setMode('view'); setDraft(entry.label); setRenameError(''); }}>{tr("Cancel")}</button></div>
    </form> : mode === 'remove' && removable ? <div className="ux-inline-form" role="group" aria-label={tr('Remove {0}', entry.label)}>
      <p>{tr('Remove {0} from FloFi?', entry.label)}{tr(entry.active ? ' This also disconnects it.' : '')}{tr(" Only FloFi's reference is removed; the wallet and its assets are not affected.")}</p>
      {renameError && <p className="workspace-inline-error" role="alert">{tr(renameError)}</p>}
      <div className="ux-inline-actions"><button type="button" className="ux-button ux-button-small ux-button-danger" onClick={() => void remove()}>{tr("Remove")}</button>
        <button type="button" className="ux-button ux-button-small" onClick={() => setMode('view')}>{tr("Cancel")}</button></div>
    </div> : null}
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
  return <article className="ux-wallet-row workspace-card-credential" aria-label={card.label}>
    <div className="ux-row">
      <span className="ux-row-icon workspace-network-icon"><WorkspaceIcon name="card" size={22}/></span>
      <div className="ux-row-main"><h3 className="ux-row-name">{card.label}</h3>
        <p className="ux-row-meta">{brandLabel(card.brand)} · {card.providerName} · <span className="numeric">•••• {card.last4}</span>{tr(' · Expires {0}', `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`)}</p></div>
      {!confirming && <div className="ux-row-actions"><button type="button" className="ux-button" aria-label={tr('Remove {0}', card.label)} onClick={() => setConfirming(true)}>{tr("Remove")}</button></div>}
    </div>
    {confirming && <div className="ux-inline-form" role="group" aria-label={tr('Remove {0}', card.label)}>
      <p>{tr("Remove this card from FloFi? The card itself is not affected.")}</p>
      <div className="ux-inline-actions"><button type="button" className="ux-button ux-button-small ux-button-danger" disabled={removing}
        onClick={() => void remove()}>{tr("Remove")}</button>
        <button type="button" className="ux-button ux-button-small" onClick={() => setConfirming(false)}>{tr("Cancel")}</button></div>
    </div>}
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
  // BUILD-FLOFI-MAINNET-EXEC-002 (review round 2): a wallet linked, removed or renamed here also refreshes the bridge destination resolution.
  const loadAccount = useCallback(() => { invalidateAccountWallets(); void accountState().then(setAccount, () => setAccount(null)); }, []);
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
    if (!providerKey) { setStatus(entry.designation === 'privy' ? 'Your FloFi wallet is still loading in this page. Try again in a moment.' : `${providerName} isn't detected in this browser.`); return; }
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
  const createImport = signedIn && account!.availability.managedWallets;
  return <div className="ux-page credentials">
    <header className="ux-page-head"><div><h1>{tr("Credentials")}</h1><p>{tr("Wallets and payment methods you use with FloFi. Saving here never approves anything.")}</p></div></header>
    <p className="workspace-notice" role="status">{status ? tr(status) : connection.notice ? tr(...connection.notice) : ''}</p>
    <section className="ux-panel" aria-labelledby="credentials-wallets">
      <div className="ux-panel-head"><div><h2 id="credentials-wallets">{tr("Wallets")}</h2><span className="ux-count">{entries.length}</span></div>
        {/* Board 13: one "Add wallet" that opens both existing paths (connect a wallet you have; create or import a FloFi wallet). */}
        {createImport ? <MoreMenu label={tr("Add wallet")} trigger={<><WorkspaceIcon name="plus" size={18}/>{tr("Add wallet")}</>} items={[
          { key: 'connect', label: tr('Connect a wallet you already have'), disabled: busy, onSelect: () => void addWallet() },
          { key: 'flofi', label: tr('Create or import a FloFi wallet'), href: '/onboarding/wallets' }]}/>
          : <button type="button" className="ux-button" disabled={busy} onClick={() => void addWallet()}><WorkspaceIcon name="plus" size={18}/>{tr("Add wallet")}</button>}</div>
      {account?.availability.accounts && !account.account && <p className="ux-panel-text">{tr('Sign in to create or import FloFi wallets that stay with your account. Wallets added here are saved on this device only.')}{' '}
        <a href="/login?returnTo=%2Fapp%2Fcredentials">{tr('Sign in')}</a></p>}
      {entries.length ? <ul className="ux-list">{entries.map(entry => <li key={entry.key}><WalletCredentialCard
        entry={entry} busy={busy} accountView={signedIn ? account : null} onConnect={target => void activate(target)} onDisconnect={() => disconnect(entry)} onSave={save}
        onStatus={setStatus} onAccountChanged={loadAccount}/></li>)}</ul>
        : <p className="ux-panel-text">{tr("Add a wallet to save its public address here. FloFi never holds your keys.")}</p>}
    </section>
    <section className="ux-panel" aria-labelledby="credentials-cards">
      <div className="ux-panel-head"><div><h2 id="credentials-cards">{tr("Cards")}</h2><span className="ux-count">{credentials.cards.length}</span></div>
        <button type="button" className="ux-button" onClick={() => setCardEntry(true)}><WorkspaceIcon name="plus" size={18}/>{tr("Add card")}</button></div>
      {credentials.cards.length ? <ul className="ux-list">{credentials.cards.map(card => <li key={card.id}><CardCredential card={card} onStatus={setStatus}/></li>)}</ul>
        : <p className="ux-panel-text">{tr("Cards are added through a certified card provider's secure entry. FloFi never sees or stores your card number or security code.")}</p>}
    </section>
    {/* Board 13: Pix and boleto do not exist yet — one row with its status, no controls. */}
    <section className="ux-panel ux-panel-row" aria-labelledby="credentials-payments">
      <div className="ux-row"><span className="ux-row-icon"><WorkspaceIcon name="key" size={22}/></span>
        <div className="ux-row-main"><h2 id="credentials-payments" className="ux-row-name">{tr("Pix and boleto")}</h2><p className="ux-row-meta">{tr("Payments through a connected provider")}</p></div>
        <StatusTag tone="soon">{tr("Coming soon")}</StatusTag></div>
    </section>
    {/* BUILD-AUTOMATION-002: execution Credentials (only where delegated execution is enabled; otherwise nothing renders). */}
    <ExecutionCredentials access={access}/>
    {/* Board 13: deleting the account sits last, collapsed; its own confirmation and protections are unchanged. */}
    {signedIn && <DangerZone state={account!}/>}
    {cardEntry && <CardEntryDialog onClose={() => setCardEntry(false)} onAdded={label => { setCardEntry(false); setStatus(`${label} added to Credentials.`); }}/>}
  </div>;
}

/** Board 14: the assistant integrations are not available yet; each row says so with its status and is not a control. */
/** Board 13: deleting the FloFi account, last and collapsed. DeleteAccount keeps its own two-step confirmation and server checks unchanged. */
export function DangerZone({ state }: { state: AccountState }) {
  const { t: tr } = useLocale();
  return <details className="ux-details ux-danger-zone"><summary>{tr("Danger zone · delete FloFi account")}</summary><DeleteAccount state={state}/></details>;
}

function AgentsWorkspace() {
  const { t: tr } = useLocale();
  return <div className="ux-page agents">
    <header className="ux-page-head"><div><h1>{tr("Agents")}</h1><p>{tr("Connect AI assistants to FloFi. They suggest, and you approve each step here.")}</p></div></header>
    <section className="ux-panel" aria-labelledby="connect-agent">
      <div className="ux-panel-head"><div><h2 id="connect-agent">{tr("Connect an assistant")}</h2></div></div>
      <ul className="ux-list">{[
        { name: 'Claude', light: '/brand/providers/claude-spark.svg', dark: null },
        { name: 'ChatGPT', light: '/brand/providers/openai-blossom-black.svg', dark: '/brand/providers/openai-blossom-white.svg' },
      ].map(provider => <li key={provider.name} className="ux-row workspace-provider-row">
        <span className="ux-row-icon workspace-provider-mark" aria-hidden="true">
          <img src={provider.light} className={provider.dark ? 'provider-mark-light' : undefined} width={provider.dark ? 56 : 28} height={provider.dark ? 56 : 28} alt=""/>
          {provider.dark && <img src={provider.dark} className="provider-mark-dark" width="56" height="56" alt=""/>}
        </span>
        <div className="ux-row-main"><h3 className="ux-row-name">{tr('Connect with {0}', provider.name)}</h3><p className="ux-row-meta">{tr('Use FloFi from inside {0}.', provider.name)}</p></div>
        <StatusTag tone="testing">{tr("In testing")}</StatusTag>
      </li>)}</ul>
    </section>
    <section className="ux-panel ux-panel-row" aria-labelledby="agent-clients">
      <div className="ux-row"><span className="ux-row-icon"><WorkspaceIcon name="agent" size={22}/></span>
        <div className="ux-row-main"><h2 id="agent-clients" className="ux-row-name">{tr("API clients")}</h2><p className="ux-row-meta">{tr("For people who integrate FloFi through code")}</p></div>
        <StatusTag tone="soon">{tr("Coming soon")}</StatusTag></div>
    </section>
  </div>;
}

function PasskeysWorkspace({ access }: { access?: DelegationAccess | undefined }) {
  const { t: tr } = useLocale();
  // BUILD-AUTOMATION-002: the passkey manager where delegated execution is enabled; board 15's one "Coming soon" state everywhere else.
  return <PasskeysPanel access={access} placeholder={<div className="ux-page passkeys">
    <header className="ux-page-head"><div><h1>{tr("Passkeys")}</h1></div></header>
    <section className="ux-panel ux-empty workspace-passkey-empty" aria-labelledby="passkey-soon"><span className="ux-empty-icon"><WorkspaceIcon name="key" size={30}/></span>
      <StatusTag tone="soon">{tr("Coming soon")}</StatusTag>
      <h2 id="passkey-soon">{tr("Sign in with your fingerprint or face")}</h2>
      <p>{tr("A passkey lets you sign in to FloFi without a password, using your device unlock. It does not sign transactions.")}</p></section>
  </div>}/>;
}

export function SecondaryProductWorkspace({ workspace, workflows, automations }: { workspace: SecondaryWorkspace['id']; workflows?: WorkflowNavigation | undefined;
  automations?: AutomationNavigation | undefined }) {
  const access: DelegationAccess | undefined = automations?.proof ? { owner: automations.owner ?? null, proof: automations.proof } : undefined;
  // Board 11: Your workflows' "Create workflow" opens the Chat entry (the shell's own open-chat callback, also used by Automations).
  return workspace === 'workflows' ? <YourWorkflows {...workflows} create={workflows?.create ?? automations?.openChat}/> : workspace === 'automations' ? <AutomationsWorkspace {...automations}/>
    : workspace === 'credentials' ? <CredentialsWorkspace access={access}/> : workspace === 'agents' ? <AgentsWorkspace/>
      // BUILD-CHAT-LEARNING-002: the Copilot's privacy controls, reached from Settings.
      : workspace === 'privacy' ? <PrivacyControls proof={automations?.proof}/> : <PasskeysWorkspace access={access}/>;
}
