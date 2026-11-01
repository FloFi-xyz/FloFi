// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-03): Credentials → one "Wallets" section.
 *
 * Three different things describe a person's wallets, and they stay different concepts:
 *  - account wallets: saved to the signed-in FloFi account on the server (Privy-managed, legacy FloFi Wallet, linked external wallets);
 *  - device references: public addresses saved in this browser (one per provider: Phantom on Ethereum and MetaMask stay distinct);
 *  - connections: the wallet each ecosystem is connected to in this page right now.
 * They are shown as one list. A device reference and the connection of the same provider and address are one entry (as before); an account
 * wallet joins the entry of the same canonical account identity (ecosystem + address), preferring the connected one, so the same wallet is
 * never listed twice. Matching is by identity only, never by label. Display only: nothing here connects, signs or authorizes.
 */
import { isLegacyWallet, isPrivyWallet, type AccountWallet } from '../accounts/account-model';
import type { SavedWallet } from './credentials';
import type { WalletEcosystem } from '../wallet/wallet-registry';

export type ActiveWallet = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly providerKey: string; readonly providerName: string; readonly network: string | null };
export type WalletDesignation = 'privy' | 'legacy' | 'external';
export type WalletInventoryEntry = {
  readonly key: string; readonly ecosystem: WalletEcosystem; readonly address: string;
  readonly label: string; readonly providerName: string; readonly providerKey: string; readonly network: string | null;
  readonly saved: SavedWallet | null; readonly active: ActiveWallet | null; readonly account: AccountWallet | null;
  readonly designation: WalletDesignation;
};
export type WalletStatus = 'Active' | 'Connected · not saved' | 'Saved' | 'Not connected';

/** EVM addresses compare case-insensitively; Solana keys exactly. */
export const canonicalWalletAddress = (ecosystem: WalletEcosystem, address: string) => ecosystem === 'evm' ? address.toLowerCase() : address;
const identity = (ecosystem: WalletEcosystem, address: string) => `${ecosystem}:${canonicalWalletAddress(ecosystem, address)}`;
const sameProvider = (saved: SavedWallet, active: ActiveWallet) => saved.ecosystem === active.ecosystem && saved.providerKey === active.providerKey &&
  canonicalWalletAddress(saved.ecosystem, saved.address) === canonicalWalletAddress(active.ecosystem, active.address);

export function walletInventory(input: { readonly account: readonly AccountWallet[]; readonly saved: readonly SavedWallet[]; readonly active: readonly ActiveWallet[];
  /** Whether a connection's provider is the account's own FloFi wallet (a Privy wallet connected without an account record yet). */
  readonly isFloFiProvider?: (active: ActiveWallet) => boolean }): WalletInventoryEntry[] {
  type Draft = Omit<WalletInventoryEntry, 'account' | 'designation' | 'label'> & { account: AccountWallet | null; label: string };
  // Device references and connections: unchanged pairing (provider + address), connections without a reference listed after them.
  const drafts: Draft[] = [
    ...input.saved.map(saved => {
      const active = input.active.find(entry => sameProvider(saved, entry)) ?? null;
      return { key: `saved:${saved.id}`, ecosystem: saved.ecosystem, address: saved.address, label: saved.label, providerName: saved.providerName,
        providerKey: saved.providerKey, network: active?.network ?? saved.lastNetwork, saved, active, account: null };
    }),
    ...input.active.filter(active => !input.saved.some(saved => sameProvider(saved, active))).map(active => ({
      key: `active:${active.ecosystem}:${active.address}`, ecosystem: active.ecosystem, address: active.address,
      // ACCEPTANCE-FIXES-001: an unsaved connection is the ecosystem's default identity; the provider stays visible beneath it.
      label: active.ecosystem === 'evm' ? 'EVM Default' : 'Solana Default', providerName: active.providerName, providerKey: active.providerKey,
      network: active.network, saved: null, active, account: null })),
  ];
  // Account wallets join the entry of the same account identity (the connected one first). Every account wallet keeps one stable key and
  // place (account order, first), so connecting or disconnecting it never remounts or moves its card.
  const accountEntries: Draft[] = [];
  for (const wallet of input.account) {
    const matches = drafts.filter(draft => draft.account === null && identity(draft.ecosystem, draft.address) === identity(wallet.ecosystem, wallet.address));
    const target = matches.find(draft => draft.active) ?? matches[0];
    if (target) { drafts.splice(drafts.indexOf(target), 1); accountEntries.push({ ...target, key: `account:${wallet.id}`, account: wallet, label: wallet.label }); continue; }
    accountEntries.push({ key: `account:${wallet.id}`, ecosystem: wallet.ecosystem, address: wallet.address, label: wallet.label, providerName: wallet.providerName,
      providerKey: wallet.provider, network: null, saved: null, active: null, account: wallet });
  }
  return [...accountEntries, ...drafts].map(draft => ({ ...draft,
    designation: draft.account ? isPrivyWallet(draft.account) ? 'privy' : isLegacyWallet(draft.account) ? 'legacy' : 'external'
      : draft.active && input.isFloFiProvider?.(draft.active) ? 'privy' : 'external' }));
}

/** One honest status per entry: whether it is connected in this page, and whether FloFi keeps it (account or this device). */
export function walletStatus(entry: Pick<WalletInventoryEntry, 'active' | 'saved' | 'account'>): WalletStatus {
  if (entry.active) return entry.saved || entry.account ? 'Active' : 'Connected · not saved';
  return entry.saved && !entry.account ? 'Saved' : 'Not connected';
}
