// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: account orchestration (server only).
 *
 * Every entry point receives identity that the server itself verified — an OIDC ID token checked against the provider's keys, a
 * one-time code verified by the provider through FloFi's authenticated call, or a wallet session sealed after FloFi verified the
 * wallet's signature — never a claim from the browser. Signing in creates no wallet, grants no permission, starts no transaction and
 * delegates no signer. Saving a managed wallet requires the provider to confirm that the address belongs to this person's own
 * organization; linking an external wallet requires a fresh wallet proof in this browser. Export is authorized only for a managed
 * wallet of this account, after a recent sign-in, and the secret itself is decrypted only inside the provider's export iframe.
 */
import { accountWalletId, canonicalAddress, exportActions, isManagedLogin, MANAGED_PROVIDER, MANAGED_PROVIDER_NAME, normalizeEmail, parseAccountWalletId, validProvider,
  walletLabel, type AccountView, type AccountWallet, type IdentityKind, type ManagedLogin } from './account-model.ts';
import { freshlyAuthenticated, SESSION_PUBLIC_KEY, type AccountSessionToken, type EmailFlow, type OidcFlow } from './account-session.ts';
import type { AccountStore, IdentityClaim } from './account-store.ts';
import { createHash } from 'node:crypto';
import { exchangeGoogleCode, verifyIdToken, type OidcConfig } from './oidc.ts';
import type { TurnkeyServer } from './turnkey-server.ts';
import type { WalletEcosystem } from '../wallet/wallet-registry';

export type ManagedSession = { readonly organizationId: string; readonly userId: string; readonly sessionKey: string; readonly expiresAt: string };
/** The outcome of a verified sign-in. `managed` is null when the provider session could not be opened (sign-in still succeeds). */
export type SignInOutcome = { readonly session: AccountSessionToken; readonly created: boolean; readonly onboarding: AccountView['onboarding'];
  readonly managed: ManagedSession | null; readonly managedError: string | null };
export type ExportGrant = { readonly organizationId: string; readonly kind: 'private-key' | 'recovery-phrase'; readonly resource: string;
  readonly address: string; readonly keyFormat: 'HEXADECIMAL' | 'SOLANA'; readonly source: 'wallet' | 'wallet-account' | 'private-key' };

const fail = (code: string): never => { throw new Error(code); };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const classified = (error: unknown, fallback: string) => error instanceof Error && CODE.test(error.message) ? error.message : fallback;
const PROVIDER_LABEL: Readonly<Record<'google' | 'apple', 'Google' | 'Apple'>> = Object.freeze({ google: 'Google', apple: 'Apple' });
/** Display-only expiry of a provider session JWT; one hour when it cannot be read. Never used as an authorization input. */
function sessionExpiry(jwt: string, now: Date): string {
  try {
    const exp = (JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    if (Number.isSafeInteger(exp) && (exp as number) * 1000 > now.getTime()) return new Date((exp as number) * 1000).toISOString();
  } catch { /* fall through */ }
  return new Date(now.getTime() + 3_600_000).toISOString();
}

export function createAccountService(input: { readonly store: AccountStore; readonly turnkey: TurnkeyServer | null; readonly now?: () => Date;
  readonly transport?: typeof fetch }) {
  const { store, turnkey } = input, now = input.now ?? (() => new Date()), transport = input.transport ?? fetch;

  async function establish(claim: IdentityClaim, intent: 'sign-in' | 'link', current: AccountSessionToken | null): Promise<{ session: AccountSessionToken; created: boolean }> {
    if (intent === 'link') {
      // Linking adds a verified identity to the signed-in account; it never moves one from another account.
      if (!current || !freshlyAuthenticated(current, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      await store.linkIdentity(current!.accountId, claim, now());
      return { session: current!, created: false };
    }
    const signed = await store.signIn(claim, now());
    return { session: signed, created: signed.created };
  }
  /**
   * Binds (or creates) the person's provider organization for a managed-capable sign-in and opens a provider session for the
   * browser's key. Failure here never fails the FloFi sign-in: managed wallets simply stay unavailable, with the reason.
   */
  async function managedSession(accountId: string, login: ManagedLogin, sessionKey: string | null,
    open: (organization: string) => Promise<string>, locate: () => Promise<{ organization: string; user: string } | null>,
    create: () => Promise<{ organization: string; user: string }>): Promise<{ managed: ManagedSession | null; managedError: string | null }> {
    if (!turnkey) return { managed: null, managedError: 'MANAGED_WALLETS_NOT_CONFIGURED' };
    if (!sessionKey) return { managed: null, managedError: 'MANAGED_SESSION_KEY_MISSING' };
    try {
      const account = await store.account(accountId) ?? fail('ACCOUNT_NOT_FOUND');
      let organization = account.organization;
      if (organization && organization.login !== login) return { managed: null, managedError: `MANAGED_WALLETS_NEED_${organization.login.toUpperCase()}_SIGN_IN` };
      if (!organization) {
        const located = await locate() ?? await create();
        organization = await store.setWalletOrganization(accountId, { provider: 'turnkey', organization: located.organization, user: located.user, login }, now());
      }
      const jwt = await open(organization.organization);
      return { managed: { organizationId: organization.organization, userId: organization.user, sessionKey, expiresAt: sessionExpiry(jwt, now()) }, managedError: null };
    } catch (error) { return { managed: null, managedError: classified(error, 'MANAGED_SESSION_UNAVAILABLE') }; }
  }
  async function onboardingOf(accountId: string) { return (await store.account(accountId))?.onboarding ?? 'pending'; }

  const service = {
    /** Google (code + PKCE) or Apple (form_post ID token): verify, sign in or link, and open the provider session when possible. */
    async completeOidc(config: OidcConfig, flow: OidcFlow, response: { readonly code?: unknown; readonly idToken?: unknown }, current: AccountSessionToken | null): Promise<SignInOutcome> {
      const idToken = config.provider === 'google' ? await exchangeGoogleCode(config, response.code, flow.verifier, transport) : response.idToken;
      const identity = await verifyIdToken(config, idToken, flow, { now: now(), transport });
      // Each ID token signs in once: a replayed token (even with the same browser key) is refused.
      if (!await store.consumeProof(createHash('sha256').update(idToken as string).digest('hex'), identity.expiresAt, now())) fail('OIDC_TOKEN_REPLAYED');
      const email = identity.emailVerified ? identity.email : null;
      const { session, created } = await establish({ kind: config.provider, subject: identity.subject, label: email }, flow.intent, current);
      const provider = PROVIDER_LABEL[config.provider], token = idToken as string;
      const managed = await managedSession(session.accountId, config.provider, flow.sessionKey, organization => turnkey!.oidcLogin(organization, token, flow.sessionKey!),
        () => turnkey!.findOrganization({ oidcToken: token }), () => turnkey!.createOrganization(`flofi-${session.accountId}`, { provider, oidcToken: token, email }));
      return { session, created, onboarding: await onboardingOf(session.accountId), ...managed };
    },
    /** Sends an email one-time code through the provider, at most 5 per address per hour (and a deployment-wide ceiling). */
    async startEmail(email: unknown, sessionKey: string): Promise<{ challengeId: string; email: string }> {
      if (!turnkey) fail('EMAIL_SIGN_IN_NOT_CONFIGURED');
      const address = normalizeEmail(email) ?? fail('EMAIL_INVALID');
      if (!await store.emailChallengeAllowed(address, now())) fail('EMAIL_RATE_LIMITED');
      const providerChallenge = await turnkey!.initEmailOtp(address);
      return { challengeId: await store.startEmailChallenge({ email: address, providerChallenge, browserBinding: sessionKey }, now()), email: address };
    },
    /** Verifies the code with the provider (bound to this browser's key), then signs in or links the verified email. */
    async completeEmail(flow: EmailFlow, code: unknown, current: AccountSessionToken | null): Promise<SignInOutcome> {
      if (!turnkey) fail('EMAIL_SIGN_IN_NOT_CONFIGURED');
      if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code.trim())) fail('EMAIL_CODE_INVALID');
      // Server-side attempt budget: at most 5 tries per challenge, whatever the provider allows; then a new code is required.
      const challenge = await store.attemptEmailChallenge(flow.challengeId, now()) ?? fail('EMAIL_CHALLENGE_EXPIRED');
      const { email, providerChallenge, browserBinding: sessionKey } = challenge!;
      let verificationToken: string;
      try { verificationToken = await turnkey!.verifyEmailOtp(providerChallenge, (code as string).trim(), sessionKey); }
      catch (error) {
        // A wrong or expired code is a completed-but-failed provider activity; transport and configuration failures keep their own code.
        const code = classified(error, 'EMAIL_CODE_REJECTED');
        throw new Error(code === 'TURNKEY_ACTIVITY_NOT_COMPLETED' || code === 'TURNKEY_REQUEST_FAILED' ? 'EMAIL_CODE_REJECTED' : code, { cause: error });
      }
      await store.consumeEmailChallenge(flow.challengeId, now());
      const { session, created } = await establish({ kind: 'email', subject: email, label: email }, flow.intent, current);
      const managed = await managedSession(session.accountId, 'email', sessionKey, organization => turnkey!.emailLogin(organization, verificationToken, sessionKey),
        () => turnkey!.findOrganization({ email }), () => turnkey!.createOrganization(`flofi-${session.accountId}`, { email, verificationToken }));
      return { session, created, onboarding: await onboardingOf(session.accountId), ...managed };
    },
    /**
     * Web3 Wallet sign-in: the wallet session FloFi sealed after verifying the wallet's EIP-4361 / Sign-In With Solana signature.
     * The wallet is recorded as an external wallet of the account (public metadata; never exportable).
     */
    async completeWallet(proof: { readonly namespace: 'eip155' | 'solana'; readonly address: string }, provider: { readonly key: unknown; readonly name: unknown },
      intent: 'sign-in' | 'link', current: AccountSessionToken | null): Promise<SignInOutcome> {
      const ecosystem: WalletEcosystem = proof.namespace === 'eip155' ? 'evm' : 'solana', address = canonicalAddress(ecosystem, proof.address) ?? fail('WALLET_ADDRESS_INVALID');
      // Linking checks the wallet record first, so a wallet held by another account never leaves a half-linked identity behind.
      const holder = await store.walletHolder(ecosystem, address);
      if (intent === 'link' && holder && holder !== current?.accountId) fail('ACCOUNT_WALLET_LINKED_ELSEWHERE');
      const { session, created } = await establish({ kind: proof.namespace, subject: address, label: null }, intent, current);
      const key = validProvider(provider.key) ? provider.key : 'injected', name = walletLabel(provider.name) ?? (ecosystem === 'evm' ? 'EVM wallet' : 'Solana wallet');
      // A wallet whose record belongs to another account (for example an exported managed wallet) still signs in to its own identity's
      // account; its record is never moved.
      if (!holder) await store.saveWallet(session.accountId, { ecosystem, address, origin: 'external', provider: key, providerName: name, providerResource: null, label: name }, now());
      return { session, created, onboarding: await onboardingOf(session.accountId), managed: null, managedError: 'MANAGED_WALLETS_NEED_SOCIAL_SIGN_IN' };
    },
    async view(session: AccountSessionToken): Promise<AccountView | null> {
      const account = await store.account(session.accountId);
      if (!account) return null;
      return { accountId: account.accountId, method: session.method, identities: account.identities, onboarding: account.onboarding, wallets: account.wallets,
        managedLogin: account.organization?.login ?? null, authenticatedAt: new Date(session.authenticatedAt * 1000).toISOString(),
        expiresAt: new Date(session.expiresAt * 1000).toISOString() };
    },
    /** The provider organization of a managed-capable session (non-secret ids for the browser's own stamped requests). */
    async managedContext(session: AccountSessionToken): Promise<{ organizationId: string; userId: string; login: ManagedLogin } | null> {
      if (!turnkey || !isManagedLogin(session.method)) return null;
      const organization = (await store.account(session.accountId))?.organization;
      return organization && organization.login === session.method ? { organizationId: organization.organization, userId: organization.user, login: organization.login } : null;
    },
    /** Saves managed wallets after the provider confirms each address belongs to this person's organization. */
    async saveManagedWallets(session: AccountSessionToken, ids: unknown): Promise<AccountWallet[]> {
      if (!turnkey) fail('MANAGED_WALLETS_NOT_CONFIGURED');
      const requested = (Array.isArray(ids) ? ids : []).slice(0, 8).map(parseAccountWalletId);
      if (!requested.length || requested.some(entry => entry === null)) fail('ACCOUNT_WALLET_INVALID');
      const organization = (await store.account(session.accountId))?.organization ?? fail('MANAGED_ORGANIZATION_MISSING');
      const [accounts, wallets, keys] = await Promise.all([turnkey!.walletAccounts(organization!.organization), turnkey!.wallets(organization!.organization),
        turnkey!.privateKeys(organization!.organization)]);
      const saved: AccountWallet[] = [];
      for (const entry of requested as { ecosystem: WalletEcosystem; address: string }[]) {
        const format = entry.ecosystem === 'evm' ? 'ADDRESS_FORMAT_ETHEREUM' : 'ADDRESS_FORMAT_SOLANA';
        const same = (candidate: string) => canonicalAddress(entry.ecosystem, candidate) === entry.address;
        const account = accounts.find(candidate => candidate.format === format && same(candidate.address));
        const generated = account && wallets.find(wallet => wallet.walletId === account.walletId && !wallet.imported);
        const imported = !generated ? keys.find(key => key.imported && key.addresses.some(address => address.format === format && same(address.address))) : undefined;
        if (!generated && !imported) fail('ACCOUNT_WALLET_NOT_OWNED');
        const label = entry.ecosystem === 'evm' ? 'EVM wallet' : 'Solana wallet';
        saved.push(await store.saveWallet(session.accountId, { ecosystem: entry.ecosystem, address: entry.address, origin: generated ? 'generated' : 'imported',
          provider: MANAGED_PROVIDER, providerName: MANAGED_PROVIDER_NAME, providerResource: generated ? generated.walletId : imported!.privateKeyId,
          label: generated ? label : `Imported ${label}` }, now()));
      }
      return saved;
    },
    /** Links an external wallet proven in this browser (fresh wallet session) to the signed-in account. */
    async linkExternalWallet(session: AccountSessionToken, proof: { readonly namespace: 'eip155' | 'solana'; readonly address: string } | null,
      provider: { readonly key: unknown; readonly name: unknown }): Promise<AccountWallet> {
      if (!proof) fail('WALLET_SESSION_REQUIRED');
      await service.completeWallet(proof!, provider, 'link', session);
      const ecosystem: WalletEcosystem = proof!.namespace === 'eip155' ? 'evm' : 'solana';
      return (await store.wallets(session.accountId)).find(wallet => wallet.id === accountWalletId(ecosystem, canonicalAddress(ecosystem, proof!.address)!))
        ?? fail('ACCOUNT_WALLET_NOT_FOUND');
    },
    /** Authorizes one export of a managed wallet of this account after a recent sign-in. External wallets are never exportable. */
    async authorizeExport(session: AccountSessionToken, id: unknown, kind: unknown): Promise<ExportGrant> {
      if (!turnkey) fail('MANAGED_WALLETS_NOT_CONFIGURED');
      if (!freshlyAuthenticated(session, now())) fail('ACCOUNT_REAUTHENTICATION_REQUIRED');
      const parsed = parseAccountWalletId(id) ?? fail('ACCOUNT_WALLET_INVALID');
      const wallet = (await store.wallets(session.accountId)).find(candidate => candidate.id === accountWalletId(parsed!.ecosystem, parsed!.address)) ?? fail('ACCOUNT_WALLET_NOT_FOUND');
      if (kind !== 'private-key' && kind !== 'recovery-phrase') fail('EXPORT_KIND_INVALID');
      if (!exportActions(wallet!).includes(kind as 'private-key')) fail('EXPORT_NOT_SUPPORTED');
      const context = await service.managedContext(session) ?? fail('MANAGED_SESSION_REQUIRED');
      const resource = await store.managedResource(session.accountId, wallet!.ecosystem, wallet!.address) ?? fail('EXPORT_NOT_SUPPORTED');
      const keyFormat = wallet!.ecosystem === 'evm' ? 'HEXADECIMAL' : 'SOLANA';
      const source = kind === 'recovery-phrase' ? 'wallet' : resource!.origin === 'imported' ? 'private-key' : 'wallet-account';
      return { organizationId: context!.organizationId, kind: kind as ExportGrant['kind'], resource: source === 'wallet-account' ? wallet!.address : resource!.resource,
        address: wallet!.address, keyFormat, source };
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
