// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account orchestration (server only). BUILD-FLOFI-AUTH-WALLETS-001 introduced accounts; BUILD-FLOFI-PRIVY-UX-001 moved sign-in and
 * embedded wallets to Privy.
 *
 * Every entry point receives identity that the server itself verified, never a claim from the browser: a Privy access token checked with
 * the official SDK and the Privy user read back from Privy's API (privy-server.ts), or a wallet session sealed after FloFi verified the
 * wallet's signature. Signing in grants no permission, starts no transaction and delegates no signer. A Privy-managed wallet is saved to
 * the account only after Privy's API confirms that this account's own Privy user holds it; creating or importing a wallet authorizes
 * nothing. Wallets created in FloFi Wallet (Turnkey) before Privy keep their records unchanged (legacy, export only).
 */
import { accountWalletId, canonicalAddress, isPrivyWallet, LEGACY_MANAGED_PROVIDER, needsWalletOnboarding, MANAGED_PROVIDER, MANAGED_PROVIDER_NAME, validProvider, walletLabel, writableWalletLabel, type AccountView,
  type AccountWallet, type IdentityKind } from './account-model.ts';
import { createHash } from 'node:crypto';
import { freshlyAuthenticated, SESSION_PUBLIC_KEY, type AccountSessionToken } from './account-session.ts';
import type { AccountStore } from './account-store.ts';
import type { PrivyEmbeddedWallet, PrivyServer, PrivyUser } from './privy-server.ts';
import type { WalletEcosystem } from '../wallet/wallet-registry';

/** The outcome of a verified sign-in. */
export type SignInOutcome = { readonly session: AccountSessionToken; readonly created: boolean; readonly onboarding: AccountView['onboarding'];
  /** BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: whether "Add your wallets" is still needed (`needsWalletOnboarding`). Absent: decided by `onboarding`. */
  readonly walletOnboarding?: boolean };
/** The result of saving the person's Privy wallets: what is saved now, and how many Privy wallets another FloFi account already holds. */
export type PrivyWalletSync = { readonly wallets: readonly AccountWallet[]; readonly heldElsewhere: number };

const fail = (code: string): never => { throw new Error(code); };
const ECOSYSTEM_LABEL: Readonly<Record<WalletEcosystem, string>> = Object.freeze({ evm: 'EVM wallet', solana: 'Solana wallet' });
/** How old a Privy access token may be when it signs in (Privy issues a new one at each login; later API calls may use older ones). */
export const PRIVY_SIGN_IN_MAX_AGE_MS = 10 * 60_000;
export function createAccountService(input: { readonly store: AccountStore; readonly privy: PrivyServer | null; readonly now?: () => Date }) {
  const { store, privy } = input, now = input.now ?? (() => new Date());
  const provider = () => privy ?? fail('PRIVY_NOT_CONFIGURED');

  /** The Privy user behind `token`, required to be the one linked to this signed-in account. */
  async function ownPrivyUser(session: AccountSessionToken, token: unknown): Promise<PrivyUser> {
    const verified = await provider().verify(token);
    const linked = await store.privyUser(session.accountId);
    if (!linked) fail('PRIVY_ACCOUNT_NOT_LINKED');
    if (linked !== verified.userId) fail('PRIVY_ACCOUNT_MISMATCH');
    return provider().user(verified.userId);
  }
  /**
   * Saves one embedded wallet of the account's own Privy user. Idempotent; an address another FloFi account holds is refused and never
   * moved; an address this account already holds keeps its record unchanged (never silently replaced).
   */
  async function saveEmbedded(session: AccountSessionToken, wallet: PrivyEmbeddedWallet, label: string | null, adoptLegacy = false): Promise<AccountWallet> {
    const holder = await store.walletHolder(wallet.ecosystem, wallet.address);
    if (holder && holder !== session.accountId) fail('ACCOUNT_WALLET_LINKED_ELSEWHERE');
    if (holder) {
      const existing = (await store.wallets(session.accountId)).find(entry => entry.ecosystem === wallet.ecosystem && entry.address === wallet.address);
      // The person just imported, into Privy, the key of this account's own legacy FloFi Wallet (its documented migration): the record
      // becomes that Privy wallet, same address and name. Only on that explicit import, never on a background sync.
      if (existing && adoptLegacy && wallet.imported && existing.provider === LEGACY_MANAGED_PROVIDER)
        return await store.adoptLegacyWallet(session.accountId, wallet.ecosystem, wallet.address, wallet.walletId, now()) ?? existing;
      if (existing) return existing;
    }
    const fallback = wallet.imported ? `Imported ${ECOSYSTEM_LABEL[wallet.ecosystem]}` : ECOSYSTEM_LABEL[wallet.ecosystem];
    return store.saveWallet(session.accountId, { ecosystem: wallet.ecosystem, address: wallet.address, origin: wallet.imported ? 'imported' : 'generated',
      provider: MANAGED_PROVIDER, providerName: MANAGED_PROVIDER_NAME, providerResource: wallet.walletId, label: walletLabel(label) ?? fallback }, now());
  }
  /** Saves every embedded wallet of the Privy user that is not saved yet (recovers a creation or import whose save never finished). */
  async function syncEmbedded(session: AccountSessionToken, user: PrivyUser): Promise<PrivyWalletSync> {
    let heldElsewhere = 0;
    for (const wallet of user.wallets) {
      try { await saveEmbedded(session, wallet, null); }
      catch (error) { if (error instanceof Error && error.message === 'ACCOUNT_WALLET_LINKED_ELSEWHERE') heldElsewhere++; else throw error; }
    }
    return { wallets: await store.wallets(session.accountId), heldElsewhere };
  }

  const service = {
    privyConfigured: () => privy !== null,
    /**
     * Privy sign-in (Google, email code or an external Web3 wallet, all completed in Privy). FloFi verifies the access token, reads the
     * user's verified identities from Privy's API, and signs in to the one account they belong to (account-store.ts `signInPrivy`), then
     * saves any embedded wallet of that user the account does not list yet. Signing in creates no wallet and authorizes nothing.
     */
    async completePrivy(token: unknown): Promise<SignInOutcome> {
      const verified = await provider().verify(token);
      // A sign-in uses a token Privy just issued for this login, once: a copied or replayed token never opens another FloFi session.
      const at = now().getTime();
      if (verified.issuedAt * 1000 < at - PRIVY_SIGN_IN_MAX_AGE_MS || verified.issuedAt * 1000 > at + 60_000) fail('PRIVY_SIGN_IN_STALE');
      // Key the proof on the verified signing input, not its signature: base64url aliases and ECDSA (r, n-s) both verify as the same
      // token. The header and payload bytes are signed, so changing either cannot consume a proof without a valid Privy signature.
      const signedInput = (token as string).slice(0, (token as string).lastIndexOf('.'));
      if (!await store.consumeProof(createHash('sha256').update(`flofi-privy-sign-in:${signedInput}`).digest('hex'), new Date(verified.expiresAt * 1000), now()))
        fail('PRIVY_SIGN_IN_STALE');
      const user = await provider().user(verified.userId);
      if (!user.method) fail('PRIVY_LOGIN_METHOD_UNSUPPORTED');
      // …and only for a login the person just completed at Privy (its last verification of a sign-in method), never for an old Privy
      // session whose token was silently refreshed: a missing or unusable time is treated as old (sign-in.tsx asks the same in the browser).
      if (user.verifiedAt === null || user.verifiedAt * 1000 < at - PRIVY_SIGN_IN_MAX_AGE_MS || user.verifiedAt * 1000 > at + 60_000)
        fail('PRIVY_SIGN_IN_STALE');
      const signed = await store.signInPrivy({ privyUser: user.id, identities: user.identities, method: user.method!, verifiedAt: user.verifiedAt }, now());
      const session: AccountSessionToken = { accountId: signed.accountId, sessionId: signed.sessionId, method: signed.method,
        authenticatedAt: signed.authenticatedAt, expiresAt: signed.expiresAt };
      // A wallet whose save never finished (a closed tab, a timeout) is saved now; a failure here never blocks signing in.
      await syncEmbedded(session, user).catch(() => undefined);
      // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-05): a person who signed in with MetaMask (or already holds a usable wallet) enters the app.
      const account = await store.account(session.accountId);
      return { session, created: signed.created, onboarding: account?.onboarding ?? 'pending',
        walletOnboarding: account ? needsWalletOnboarding(account) : true };
    },
    /**
     * Saves one wallet just created or imported in the person's Privy embedded wallet. The address must be one of the embedded wallets
     * Privy's API lists for this account's own Privy user (never an external wallet, never another user's). `label` is the name the person
     * typed when importing; it is display text only.
     */
    async savePrivyWallet(session: AccountSessionToken, token: unknown, request: { readonly ecosystem: unknown; readonly address: unknown; readonly label?: unknown }): Promise<AccountWallet> {
      if (request.ecosystem !== 'evm' && request.ecosystem !== 'solana') fail('ACCOUNT_WALLET_INVALID');
      const ecosystem = request.ecosystem as WalletEcosystem, address = canonicalAddress(ecosystem, request.address) ?? fail('ACCOUNT_WALLET_INVALID');
      const label = request.label === undefined || request.label === null || request.label === '' ? null
        : writableWalletLabel(request.label) ?? fail(walletLabel(request.label) ? 'ACCOUNT_WALLET_LABEL_KEY_SHAPED' : 'ACCOUNT_WALLET_LABEL_INVALID');
      const user = await ownPrivyUser(session, token);
      const wallet = user.wallets.find(entry => entry.ecosystem === ecosystem && entry.address === address) ?? fail('ACCOUNT_WALLET_NOT_OWNED');
      return saveEmbedded(session, wallet!, label, true);
    },
    /** Saves every embedded wallet of the account's own Privy user that the account does not list yet (refresh and timeout recovery). */
    async syncPrivyWallets(session: AccountSessionToken, token: unknown): Promise<PrivyWalletSync> {
      return syncEmbedded(session, await ownPrivyUser(session, token));
    },
    /**
     * Links an external wallet proven in this browser (a fresh EIP-4361 / Sign-In With Solana wallet session) to the signed-in account, as
     * an identity and as an external wallet (public metadata; never exportable). A wallet held by another account is refused.
     */
    async linkExternalWallet(session: AccountSessionToken, proof: { readonly namespace: 'eip155' | 'solana'; readonly address: string } | null,
      provider: { readonly key: unknown; readonly name: unknown }): Promise<AccountWallet> {
      if (!proof) fail('WALLET_SESSION_REQUIRED');
      const ecosystem: WalletEcosystem = proof!.namespace === 'eip155' ? 'evm' : 'solana', address = canonicalAddress(ecosystem, proof!.address) ?? fail('WALLET_ADDRESS_INVALID');
      if (!freshlyAuthenticated(session, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      // Checked first, so a wallet held by another account never leaves a half-linked identity behind.
      const holder = await store.walletHolder(ecosystem, address!);
      if (holder && holder !== session.accountId) fail('ACCOUNT_WALLET_LINKED_ELSEWHERE');
      // A wallet FloFi's provider keeps for this account (Privy, legacy FloFi Wallet) is never also an external wallet or a sign-in identity.
      if (holder && (await store.wallets(session.accountId)).some(wallet => wallet.ecosystem === ecosystem && wallet.address === address && wallet.origin !== 'external'))
        fail('ACCOUNT_WALLET_IS_FLOFI_WALLET');
      await store.linkIdentity(session.accountId, { kind: proof!.namespace, subject: address!, label: null }, now());
      // An external wallet's provider key can never pose as a managed provider.
      const key = validProvider(provider.key) && provider.key !== MANAGED_PROVIDER && provider.key !== 'turnkey' ? provider.key : 'injected';
      // Checked before anything is written, so a key-shaped name never half-links the wallet (it falls back to the ecosystem's name).
      const name = writableWalletLabel(provider.name) ?? ECOSYSTEM_LABEL[ecosystem];
      if (!holder) await store.saveWallet(session.accountId, { ecosystem, address: address!, origin: 'external', provider: key, providerName: name, providerResource: null, label: name }, now());
      return (await store.wallets(session.accountId)).find(wallet => wallet.id === accountWalletId(ecosystem, address!)) ?? fail('ACCOUNT_WALLET_NOT_FOUND');
    },
    async view(session: AccountSessionToken): Promise<AccountView | null> {
      const account = await store.account(session.accountId);
      if (!account) return null;
      return { accountId: account.accountId, method: session.method, identities: account.identities.filter(identity => identity.kind !== 'privy'),
        onboarding: account.onboarding, wallets: account.wallets, managedLogin: account.organization?.login ?? null,
        privy: account.identities.some(identity => identity.kind === 'privy'),
        authenticatedAt: new Date(session.authenticatedAt * 1000).toISOString(), expiresAt: new Date(session.expiresAt * 1000).toISOString() };
    },
    /** The account's Privy-managed wallets (the only managed wallets FloFi signs with). */
    async privyWallets(session: AccountSessionToken): Promise<AccountWallet[]> {
      return (await store.wallets(session.accountId)).filter(isPrivyWallet);
    },
    /** Deletes the signed-in account (recent sign-in required). Provider wallets and on-chain assets are untouched. */
    async deleteAccount(session: AccountSessionToken): Promise<void> {
      if (!freshlyAuthenticated(session, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      await store.deleteAccount(session.accountId);
    },
    validSessionKey: (value: unknown): value is string => typeof value === 'string' && SESSION_PUBLIC_KEY.test(value),
    identityKinds: (account: AccountView): readonly IdentityKind[] => account.identities.map(identity => identity.kind),
  };
  return service;
}
export type AccountService = ReturnType<typeof createAccountService>;
