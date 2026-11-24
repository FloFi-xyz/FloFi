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
  type AccountWallet, type IdentityKind, type SessionMethod } from './account-model.ts';
import { createHash, randomBytes } from 'node:crypto';
import { freshlyAuthenticated, SESSION_PUBLIC_KEY, type AccountSessionToken } from './account-session.ts';
import type { AccountStore, IdentityClaim, RetirementBlocker } from './account-store.ts';
import type { PrivyEmbeddedWallet, PrivyServer, PrivyUser } from './privy-server.ts';
import type { WalletEcosystem } from '../wallet/wallet-registry';

/** The outcome of a verified sign-in. */
export type SignInOutcome = { readonly session: AccountSessionToken; readonly created: boolean; readonly onboarding: AccountView['onboarding'];
  /** BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: whether "Add your wallets" is still needed (`needsWalletOnboarding`). Absent: decided by `onboarding`. */
  readonly walletOnboarding?: boolean };
/** The result of saving the person's Privy wallets: what is saved now, and how many Privy wallets another FloFi account already holds. */
export type PrivyWalletSync = { readonly wallets: readonly AccountWallet[]; readonly heldElsewhere: number;
  /** BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS01): how this FloFi session signed in (the browser's provisioning policy reads it; never authority). */
  readonly method: SessionMethod };

const fail = (code: string): never => { throw new Error(code); };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0): a sign-in that would create a NEW account while another account of this deployment already
 * verified the same email address. Nothing was created and the sign-in proof was released: the person may sign in with that account's method
 * (the kinds below, never an address) or create a separate account anyway. The person just proved they control the address.
 */
export class ExistingAccountFound extends Error {
  readonly kinds: readonly IdentityKind[];
  constructor(kinds: readonly IdentityKind[]) { super('ACCOUNT_EXISTS_FOR_EMAIL'); this.kinds = kinds; }
}
/** A verified address a hint may use: an email-code identity, or a Google sign-in on Google's own mail domain (verified by Google). */
const verifiedEmails = (user: PrivyUser) => user.identities.flatMap(identity => identity.kind === 'email' ? [identity.subject]
  : identity.kind === 'google' && identity.label && /@(?:gmail|googlemail)\.com$/i.test(identity.label) ? [identity.label.toLowerCase()] : []);
/** How long a link FloFi confirmed may be completed at Privy and adopted (`linkReadiness` → `syncLinkedIdentities`). */
export const LINK_GRANT_MS = 15 * 60_000;
/** How long the person has to prove the account that keeps everything after starting to retire a duplicate (the move intent). */
export const ACCOUNT_MOVE_MS = 15 * 60_000;
export const linkGrantDigest = (accountId: string, privySession: string) => digest(`flofi-link-grant:${accountId}:${privySession}`);
export const retiringDigest = (privyUser: string) => digest(`flofi-privy-retiring:${privyUser}`);
const sessionDigest = (privySession: string) => digest(`flofi-privy-session:${privySession}`);
/** The move intent a duplicate account's fresh session created (sealed in an HttpOnly cookie, single use). */
export type AccountMoveIntent = { readonly retiring: string; readonly privyUser: string; readonly nonce: string; readonly expiresAt: number;
  /** The duplicate's sign-in methods, masked, for the confirmation screen. */ readonly methods: readonly MaskedMethod[] };
export type MaskedMethod = { readonly kind: IdentityKind; readonly hint: string | null };
/** A sign-in identity as the person may see it: kind and a masked address, never a provider subject. */
export function maskedMethod(identity: Pick<IdentityClaim, 'kind' | 'subject' | 'label'>): MaskedMethod {
  const mail = (address: string | null) => { const [user = '', domain = ''] = (address ?? '').split('@'); return user && domain ? `${user.slice(0, 1)}***@${domain}` : null; };
  if (identity.kind === 'eip155') return { kind: identity.kind, hint: `${identity.subject.slice(0, 6)}…${identity.subject.slice(-4)}` };
  if (identity.kind === 'solana') return { kind: identity.kind, hint: `${identity.subject.slice(0, 4)}…${identity.subject.slice(-4)}` };
  if (identity.kind === 'email') return { kind: identity.kind, hint: mail(identity.subject) };
  return { kind: identity.kind, hint: mail(identity.label) };
}
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
    return { wallets: await store.wallets(session.accountId), heldElsewhere, method: session.method };
  }

  const service = {
    privyConfigured: () => privy !== null,
    /**
     * Privy sign-in (Google, email code or an external Web3 wallet, all completed in Privy). FloFi verifies the access token, reads the
     * user's verified identities from Privy's API, and signs in to the one account they belong to (account-store.ts `signInPrivy`), then
     * saves any embedded wallet of that user the account does not list yet. Signing in creates no wallet and authorizes nothing.
     */
    async completePrivy(token: unknown, options: { readonly allowNew?: boolean; readonly existingOnly?: boolean } = {}): Promise<SignInOutcome> {
      const verified = await provider().verify(token);
      // A sign-in uses a token Privy just issued for this login, once: a copied or replayed token never opens another FloFi session.
      const at = now().getTime();
      if (verified.issuedAt * 1000 < at - PRIVY_SIGN_IN_MAX_AGE_MS || verified.issuedAt * 1000 > at + 60_000) fail('PRIVY_SIGN_IN_STALE');
      // Key the proof on the verified signing input, not its signature: base64url aliases and ECDSA (r, n-s) both verify as the same
      // token. The header and payload bytes are signed, so changing either cannot consume a proof without a valid Privy signature.
      const signedInput = (token as string).slice(0, (token as string).lastIndexOf('.'));
      const proof = digest(`flofi-privy-sign-in:${signedInput}`), expires = new Date(verified.expiresAt * 1000);
      if (!await store.consumeProof(proof, expires, now())) fail('PRIVY_SIGN_IN_STALE');
      // BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: one FloFi sign-in per Privy session. A Privy session that already signed in (or that only linked a
      // method, which refreshes its tokens and its verification time) never opens another FloFi session: only a new login at Privy does.
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(verified.sessionId)) fail('PRIVY_TOKEN_INVALID');
      const sessionProof = sessionDigest(verified.sessionId);
      if (!await store.consumeProof(sessionProof, new Date(Math.max(verified.expiresAt * 1000, at + 31 * 86_400_000)), now())) fail('PRIVY_SIGN_IN_STALE');
      const user = await provider().user(verified.userId);
      if (!user.method) fail('PRIVY_LOGIN_METHOD_UNSUPPORTED');
      // …and only for a login the person just completed at Privy (its last verification of a sign-in method), never for an old Privy
      // session whose token was silently refreshed: a missing or unusable time is treated as old (sign-in.tsx asks the same in the browser).
      if (user.verifiedAt === null || user.verifiedAt * 1000 < at - PRIVY_SIGN_IN_MAX_AGE_MS || user.verifiedAt * 1000 > at + 60_000)
        fail('PRIVY_SIGN_IN_STALE');
      // A duplicate account being retired (its Privy user is being deleted) is never signed in or recreated meanwhile.
      if (await store.proofActive(retiringDigest(user.id), now())) fail('ACCOUNT_MOVE_IN_PROGRESS');
      // BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: before a NEW account is created for an address another account already verified, ask (nothing merged).
      if (!options.allowNew && !options.existingOnly) {
        const preview = await store.signInPreview(user.id, user.identities, verifiedEmails(user));
        if (!preview.reaches && preview.sameEmail.length) {
          await store.releaseProof(proof); await store.releaseProof(sessionProof);
          throw new ExistingAccountFound([...new Set(preview.sameEmail.flatMap(account => account.kinds))]);
        }
      }
      const signed = await store.signInPrivy({ privyUser: user.id, identities: user.identities, method: user.method!, verifiedAt: user.verifiedAt,
        login: user.login ?? null, ...options.existingOnly ? { existingOnly: true } : {} }, now());
      const session: AccountSessionToken = { accountId: signed.accountId, sessionId: signed.sessionId, method: signed.method,
        authenticatedAt: signed.authenticatedAt, expiresAt: signed.expiresAt, ...(user.loginWallet ? { loginWallet: user.loginWallet } : {}) };
      // A wallet whose save never finished (a closed tab, a timeout) is saved now; a failure here never blocks signing in.
      await syncEmbedded(session, user).catch(() => undefined);
      // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-05): a person who signed in with MetaMask (or already holds a usable wallet) enters the app.
      const account = await store.account(session.accountId);
      return { session, created: signed.created, onboarding: account?.onboarding ?? 'pending',
        walletOnboarding: account ? needsWalletOnboarding(account) : true };
    },
    /**
     * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0): the account's sign-in methods (masked) and whether it may be retired as an empty duplicate.
     * Read only.
     */
    async signInMethods(session: AccountSessionToken): Promise<{ readonly methods: readonly MaskedMethod[]; readonly fresh: boolean; readonly privy: boolean;
      readonly retirement: readonly RetirementBlocker[] }> {
      const [identities, privyUser, retirement] = await Promise.all([store.identities(session.accountId), store.privyUser(session.accountId),
        store.retirementBlockers(session.accountId)]);
      return { methods: identities.map(maskedMethod), fresh: freshlyAuthenticated(session, now()), privy: privyUser !== null, retirement };
    },
    /**
     * Step-up before linking a sign-in method at Privy: a recent FloFi sign-in, and the browser's Privy session must be this account's own Privy
     * user (never another person's left in the browser). Grants a short window, bound to that Privy session, in which a method linked from
     * FloFi's page is adopted (`syncLinkedIdentities`); a method linked at Privy any other way is never adopted and never signs in.
     */
    async linkReadiness(session: AccountSessionToken, token: unknown): Promise<void> {
      if (!freshlyAuthenticated(session, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      const verified = await provider().verify(token);
      const linked = await store.privyUser(session.accountId);
      if (!linked) fail('PRIVY_ACCOUNT_NOT_LINKED');
      if (linked !== verified.userId) fail('PRIVY_ACCOUNT_MISMATCH');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(verified.sessionId)) fail('PRIVY_TOKEN_INVALID');
      // The window starts at the FIRST readiness of this Privy session (an open window is never moved or extended): only a method Privy first
      // verified inside it is adopted, never one linked at Privy before FloFi asked.
      await store.consumeProof(linkGrantDigest(session.accountId, verified.sessionId), new Date(now().getTime() + LINK_GRANT_MS), now());
    },
    /**
     * After a link FloFi confirmed (`linkReadiness`, same Privy session, within its window): reads the account's own Privy user from Privy's API
     * and adds the sign-in identities the account does not hold yet. One another account holds is never moved: it is counted in `heldElsewhere`.
     */
    async syncLinkedIdentities(session: AccountSessionToken, token: unknown): Promise<{ readonly added: number; readonly heldElsewhere: number;
      readonly unconfirmed: number; readonly methods: readonly MaskedMethod[] }> {
      const verified = await provider().verify(token);
      const linked = await store.privyUser(session.accountId);
      if (!linked) fail('PRIVY_ACCOUNT_NOT_LINKED');
      if (linked !== verified.userId) fail('PRIVY_ACCOUNT_MISMATCH');
      const expires = await store.proofExpiresAt(linkGrantDigest(session.accountId, verified.sessionId), now());
      if (!expires) fail('ACCOUNT_LINK_NOT_CONFIRMED');
      // Clock skew between Privy and FloFi: one minute before the window opened.
      const from = Math.floor((expires!.getTime() - LINK_GRANT_MS) / 1000) - 60;
      const user = await provider().user(verified.userId);
      const result = await store.addLinkedIdentities(session.accountId, user.identities, from, now());
      return { ...result, methods: (await store.identities(session.accountId)).map(maskedMethod) };
    },
    /**
     * Step 1 of retiring an EMPTY duplicate account (the one this browser is signed in to): a recent sign-in, nothing in the account but its
     * sign-in identities, and a Privy user that holds nothing but sign-in methods. Returns the intent the caller seals into an HttpOnly cookie
     * (it then ends this session). Nothing is changed yet.
     */
    async startAccountMove(session: AccountSessionToken): Promise<AccountMoveIntent> {
      if (!freshlyAuthenticated(session, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      const privyUser = await store.privyUser(session.accountId) ?? fail('PRIVY_ACCOUNT_NOT_LINKED');
      const blockers = await store.retirementBlockers(session.accountId);
      if (blockers.length) fail(`ACCOUNT_MOVE_BLOCKED_${blockers[0]}`);
      const privy = await provider().retirement(privyUser!);
      if (privy.status !== 'RETIRABLE') fail(privy.status === 'GONE' ? 'PRIVY_USER_NOT_FOUND' : privy.code);
      return { retiring: session.accountId, privyUser: privyUser!, nonce: randomBytes(32).toString('base64url'), expiresAt: Math.floor(now().getTime() / 1000) + ACCOUNT_MOVE_MS / 1000,
        methods: (await store.identities(session.accountId)).map(maskedMethod) };
    },
    /**
     * Step 2, signed in to the account that keeps everything (`session`, a recent sign-in, never the duplicate itself): retires the duplicate
     * named by the intent. Its Privy user is frozen first (no new login, its sessions revoked), checked again (only sign-in methods), the FloFi
     * account deleted under a lock after the same checks (it holds nothing; nothing moves to this account), then the Privy user deleted, which
     * frees its sign-in methods to be linked here through Privy (`linkReadiness`). Every refusal leaves both accounts as they were (the Privy
     * user unfrozen). Idempotent: a retry with the same intent resumes where an earlier attempt stopped. Returns the duplicate's method kinds.
     */
    async completeAccountMove(session: AccountSessionToken, intent: AccountMoveIntent, tenantId: string): Promise<{ readonly kinds: readonly IdentityKind[] }> {
      if (!freshlyAuthenticated(session, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      if (intent.expiresAt * 1000 <= now().getTime()) fail('ACCOUNT_MOVE_EXPIRED');
      if (intent.retiring === session.accountId) fail('ACCOUNT_MOVE_SAME_ACCOUNT');
      if (await store.privyUser(session.accountId) === intent.privyUser) fail('ACCOUNT_MOVE_SAME_ACCOUNT');
      const used = digest(`flofi-account-move:${intent.nonce}`);
      if (await store.proofActive(used, now())) fail('ACCOUNT_MOVE_USED');
      const elsewhere = async () => (await store.privyHolders(intent.privyUser)).some(holder => holder.tenantId !== tenantId || holder.accountId !== intent.retiring);
      // The Privy user must belong to no other account, in any tenant sharing this Privy app.
      if (await elsewhere()) fail('ACCOUNT_MOVE_PRIVY_HELD');
      const privy = provider();
      const kinds = intent.methods.map(method => method.kind);
      try {
        // Inside the recovery path: a freeze that applied but answered with an error is undone below like any other refusal.
        await privy.freeze(intent.privyUser);
        const state = await privy.retirement(intent.privyUser);
        if (state.status === 'REFUSED') fail(state.code);
        const retired = await store.retireAccount(intent.retiring, intent.privyUser, { digest: retiringDigest(intent.privyUser),
          expiresAt: new Date(intent.expiresAt * 1000 + ACCOUNT_MOVE_MS) }, now(), session.accountId);
        if (retired === 'PRIVY_MISMATCH') fail('ACCOUNT_MOVE_INVALID');
        if (retired === 'GONE' && !await store.proofActive(retiringDigest(intent.privyUser), now())) fail('ACCOUNT_MOVE_INVALID');
        if (retired !== 'RETIRED' && retired !== 'GONE') fail(`ACCOUNT_MOVE_BLOCKED_${retired}`);
        if (await elsewhere()) fail('ACCOUNT_MOVE_PRIVY_HELD');
        if (state.status === 'RETIRABLE') {
          try { await privy.remove(intent.privyUser); }
          catch (cause) { await store.auditRetirement(intent.retiring, 'FAILED', 'ACCOUNT_MOVE_PRIVY_PENDING', now()).catch(() => undefined); throw cause; }
        }
        await store.auditRetirement(intent.retiring, 'OK', null, now()).catch(() => undefined);
      } catch (cause) {
        // Nothing is left half-done at Privy: the user can log in again (FloFi's own retirement, if it happened, stays and is retried).
        await privy.unfreeze(intent.privyUser).catch(async () => {
          // Left frozen at Privy (its sign-in blocked) while nothing else may have changed: recorded for an operator, never silent.
          await store.auditRetirement(intent.retiring, 'FAILED', 'ACCOUNT_MOVE_UNFREEZE_FAILED', now()).catch(() => undefined);
        });
        throw cause instanceof Error && /^(?:PRIVY_UNAVAILABLE|PRIVY_NOT_AUTHORIZED)$/.test(cause.message) ? new Error('ACCOUNT_MOVE_PRIVY_PENDING', { cause }) : cause;
      }
      await store.consumeProof(used, new Date(intent.expiresAt * 1000 + ACCOUNT_MOVE_MS), now());
      console.info(JSON.stringify({ event: 'account.duplicate.retired', retired: intent.retiring, kept: session.accountId, methods: kinds }));
      return { kinds };
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
