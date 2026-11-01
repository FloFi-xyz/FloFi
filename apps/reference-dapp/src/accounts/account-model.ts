// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: the FloFi account model shared by the server and the browser.
 *
 * An account is identity, never financial authority. It groups sign-in identities (Google, Apple, a verified email, a proven
 * EVM or Solana wallet) and public wallet metadata. It never owns a workflow run: run access stays bound to the wallet session
 * that proved the run's owner (`server/run-ownership.ts`), so signing in with Google can never reach another wallet's history.
 *
 * Wallet records are references: an address, its ecosystem, where it came from (generated or imported at the embedded-wallet
 * provider, or an external wallet such as MetaMask or Phantom) and what the provider can export to the owner. Readers are strict:
 * a record with any extra field (for example a key, phrase or token) is dropped, never repaired.
 */
import { withoutControlCharacters, type WalletEcosystem } from '../wallet/wallet-registry';

export type IdentityKind = 'google' | 'apple' | 'email' | 'eip155' | 'solana' | 'privy';
export const IDENTITY_KINDS: readonly IdentityKind[] = Object.freeze(['google', 'apple', 'email', 'eip155', 'solana', 'privy']);
/** How a browser session signed in (BUILD-FLOFI-PRIVY-UX-001: through Privy, with one of these methods). Never `privy` itself. */
export type SessionMethod = Exclude<IdentityKind, 'privy'>;
export const isSessionMethod = (kind: unknown): kind is SessionMethod => kind === 'google' || kind === 'apple' || kind === 'email' || kind === 'eip155' || kind === 'solana';
/** Sign-in methods whose identity can also unlock the person's embedded-wallet provider organization. */
export type ManagedLogin = 'google' | 'apple' | 'email';
export const isManagedLogin = (kind: IdentityKind): kind is ManagedLogin => kind === 'google' || kind === 'apple' || kind === 'email';

export type WalletOrigin = 'generated' | 'imported' | 'external';
/** What the provider can show the authenticated owner: never set for a wallet FloFi does not manage. */
export type WalletExport = 'none' | 'recovery-phrase' | 'private-key';
export type Onboarding = 'pending' | 'completed' | 'dismissed';

export type AccountWallet = {
  /** `<ecosystem>:<address>`. */
  readonly id: string;
  readonly ecosystem: WalletEcosystem;
  readonly address: string;
  readonly origin: WalletOrigin;
  /**
   * `privy` for wallets managed in the person's Privy embedded wallet, `turnkey` for legacy FloFi Wallet (Turnkey) wallets created before
   * BUILD-FLOFI-PRIVY-UX-001; the wallet's provider key (EIP-6963 rdns or Wallet Standard name) for external ones.
   */
  readonly provider: string;
  readonly providerName: string;
  readonly export: WalletExport;
  readonly label: string;
  readonly addedAt: string;
};
export type AccountIdentity = { readonly kind: IdentityKind; readonly label: string };
export type AccountView = {
  readonly accountId: string;
  /** How this browser session signed in. */
  readonly method: SessionMethod;
  readonly identities: readonly AccountIdentity[];
  readonly onboarding: Onboarding;
  readonly wallets: readonly AccountWallet[];
  /** The sign-in method that unlocks this account's legacy FloFi Wallet (Turnkey) organization, when it has one (export only). */
  readonly managedLogin: ManagedLogin | null;
  /** Whether the account is linked to a Privy user (every account that signed in since BUILD-FLOFI-PRIVY-UX-001). */
  readonly privy: boolean;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
};

const EVM = /^0x[0-9a-f]{40}$/, SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9 ._:#-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const ACCOUNT_ID = /^acct_[0-9a-f]{32}$/;
export const WALLET_LABEL_MAX = 40;
/** The embedded-wallet provider of every wallet FloFi creates or imports now (BUILD-FLOFI-PRIVY-UX-001). */
export const MANAGED_PROVIDER = 'privy';
/** Wallets created or imported in FloFi Wallet (Turnkey) before Privy. Kept, shown and exportable; never created or signed with again. */
export const LEGACY_MANAGED_PROVIDER = 'turnkey';
export type ManagedProvider = typeof MANAGED_PROVIDER | typeof LEGACY_MANAGED_PROVIDER;
export const isManagedProvider = (value: unknown): value is ManagedProvider => value === MANAGED_PROVIDER || value === LEGACY_MANAGED_PROVIDER;
export const MANAGED_PROVIDER_NAME = 'FloFi wallet';
/** A Privy user id (DID). */
export const PRIVY_USER_ID = /^did:privy:[A-Za-z0-9]{8,64}$/;

export function validAddress(ecosystem: WalletEcosystem, address: unknown): address is string {
  return typeof address === 'string' && (ecosystem === 'evm' ? EVM.test(address) : SOLANA.test(address));
}
/** EVM addresses are stored lower-case; Solana keys are case-sensitive base58. */
export function canonicalAddress(ecosystem: WalletEcosystem, address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const value = ecosystem === 'evm' ? address.toLowerCase() : address;
  return validAddress(ecosystem, value) ? value : null;
}
export const accountWalletId = (ecosystem: WalletEcosystem, address: string) => `${ecosystem}:${address}`;
export function parseAccountWalletId(id: unknown): { ecosystem: WalletEcosystem; address: string } | null {
  if (typeof id !== 'string') return null;
  const [ecosystem, address, ...rest] = id.split(':');
  if (rest.length || (ecosystem !== 'evm' && ecosystem !== 'solana') || !validAddress(ecosystem, address)) return null;
  return { ecosystem, address: address! };
}
/** A display name: printable, single line, bounded. Returns null when nothing usable remains. */
export function walletLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = withoutControlCharacters(value).replace(/\s+/g, ' ').trim();
  return label && label.length <= WALLET_LABEL_MAX ? label : null;
}
/**
 * Whether text looks like part of a private key or seed (a long unbroken run of hex or base58), for example a key pasted into the
 * Wallet name field by mistake. Such a name is refused whenever a name is written, so no fragment of a key reaches FloFi's database
 * (BUILD-FLOFI-PRIVY-UX-001); names already stored are still shown.
 */
export const keyShapedText = (value: string): boolean => /[0-9a-fA-F]{20,}/.test(value) || /[1-9A-HJ-NP-Za-km-z]{24,}/.test(value);
/** A wallet name as it may be written: a valid label that does not look like key material. */
export function writableWalletLabel(value: unknown): string | null {
  const label = walletLabel(value);
  return label && !keyShapedText(label) ? label : null;
}
export const validProvider = (value: unknown): value is string => typeof value === 'string' && PROVIDER.test(value);
/** A verified email address, normalised to lower case. Only the shape is checked here; verification belongs to the provider. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  // No ':' anywhere: FloFi keeps other kinds of email challenges under prefixed keys (`wallet-unlock:<email>`), and a sign-in address must
  // never be able to name one of those keys (or another provider's contact syntax).
  return email.length <= 254 && /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email) && withoutControlCharacters(email) === email ? email : null;
}

const exactKeys = (value: object, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && own.every(key => keys.includes(key));
};
const WALLET_KEYS = ['id', 'ecosystem', 'address', 'origin', 'provider', 'providerName', 'export', 'label', 'addedAt'] as const;
/**
 * The only export capability each wallet may carry (mirrors the database CHECK constraints): Turnkey generated an HD wallet with a
 * recovery phrase; Privy shows its owner the private key of a generated or imported wallet; an external wallet's key was never held.
 */
export function exportOf(origin: WalletOrigin, provider: string): WalletExport {
  if (origin === 'external') return 'none';
  return origin === 'generated' && provider === LEGACY_MANAGED_PROVIDER ? 'recovery-phrase' : 'private-key';
}
/** Whether a wallet record is one of the person's Privy-managed wallets (the only managed wallets FloFi signs with). */
export const isPrivyWallet = (wallet: Pick<AccountWallet, 'origin' | 'provider'>) => wallet.origin !== 'external' && wallet.provider === MANAGED_PROVIDER;
/** Whether a wallet record is a legacy FloFi Wallet (Turnkey) wallet: listed and exportable, never signed with. */
export const isLegacyWallet = (wallet: Pick<AccountWallet, 'origin' | 'provider'>) => wallet.origin !== 'external' && wallet.provider === LEGACY_MANAGED_PROVIDER;
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-05): whether a signed-in account still needs "Add your wallets". An account that signed in with
 * (or linked) a wallet proven by signature — MetaMask, Phantom, … — or that already holds a FloFi (Privy) or external wallet goes straight to
 * the app: it is never asked to create an embedded wallet it does not need. A legacy export-only wallet alone does not count (it cannot sign).
 * Presentation routing only: it grants nothing and changes no stored onboarding choice.
 */
export function needsWalletOnboarding(account: { readonly onboarding: Onboarding; readonly identities: readonly Pick<AccountIdentity, 'kind'>[];
  readonly wallets: readonly Pick<AccountWallet, 'origin' | 'provider'>[] }): boolean {
  if (account.onboarding !== 'pending') return false;
  const signedWallet = account.identities.some(identity => identity.kind === 'eip155' || identity.kind === 'solana');
  return !signedWallet && !account.wallets.some(wallet => wallet.origin === 'external' || isPrivyWallet(wallet));
}

export function readAccountWallet(value: unknown): AccountWallet | null {
  if (!value || typeof value !== 'object' || !exactKeys(value, WALLET_KEYS)) return null;
  const v = value as Record<string, unknown>;
  if ((v.ecosystem !== 'evm' && v.ecosystem !== 'solana') || !validAddress(v.ecosystem, v.address)) return null;
  if (v.origin !== 'generated' && v.origin !== 'imported' && v.origin !== 'external') return null;
  if (!validProvider(v.provider) || (v.origin !== 'external') !== isManagedProvider(v.provider) || v.export !== exportOf(v.origin, v.provider)) return null;
  if (walletLabel(v.providerName) !== v.providerName || walletLabel(v.label) !== v.label) return null;
  if (typeof v.addedAt !== 'string' || !TIMESTAMP.test(v.addedAt) || v.id !== accountWalletId(v.ecosystem, v.address)) return null;
  return { id: v.id, ecosystem: v.ecosystem, address: v.address, origin: v.origin, provider: v.provider, providerName: v.providerName as string,
    export: v.export as WalletExport, label: v.label as string, addedAt: v.addedAt };
}
/** The export actions an owner may be offered for a wallet: none for an external wallet whose key FloFi's provider never held. */
export function exportActions(wallet: Pick<AccountWallet, 'origin' | 'export'>): readonly ('private-key' | 'recovery-phrase')[] {
  if (wallet.origin === 'external' || wallet.export === 'none') return [];
  // A generated HD wallet exports its phrase and its account key; an imported key has no phrase, and none is ever derived.
  return wallet.export === 'recovery-phrase' ? ['private-key', 'recovery-phrase'] : ['private-key'];
}
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const IDENTITY_LABEL: Readonly<Record<IdentityKind, string>> = Object.freeze({
  google: 'Google', apple: 'Apple', email: 'Email', eip155: 'EVM wallet', solana: 'Solana wallet', privy: 'Privy',
});
