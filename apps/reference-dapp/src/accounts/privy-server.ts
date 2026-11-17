// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: FloFi's server side of Privy, its authentication and embedded-wallet provider.
 *
 * FloFi's server never trusts the browser's word about who someone is or which wallet they hold:
 * - it verifies each Privy access token itself with the official SDK (`@privy-io/node`: ES256, issuer `privy.io`, audience = this app id,
 *   unexpired), against the app's published key (`PRIVY_VERIFICATION_KEY` when configured, else the app's JWKS from Privy);
 * - it then reads that user from Privy's API with the app secret (server only), and takes the user's verified identities (Google, Apple,
 *   email, external wallets proven by a signature) and embedded wallets from that answer, never from the browser.
 * The app secret authenticates FloFi to Privy's API only. FloFi's server holds no wallet key, no authorization key and no session signer:
 * it cannot sign with anyone's wallet, and nothing here adds a signer or delegates a permission.
 */
import { PrivyClient } from '@privy-io/node';
import { canonicalAddress, normalizeEmail, PRIVY_USER_ID, type SessionMethod } from './account-model.ts';
import type { IdentityClaim } from './account-store.ts';
import { isHostedDeployment } from '../server/deployment.ts';
import type { WalletEcosystem } from '../wallet/wallet-registry';

type Env = Readonly<Record<string, string | undefined>>;
type Json = Record<string, unknown>;
export type PrivyServerConfig = { readonly appId: string; readonly appSecret: string; readonly apiUrl: string; readonly verificationKey: string | null;
  /** Whether Apple sign-in is offered (it needs the owner's Apple configuration in Privy first). */
  readonly apple: boolean;
  /** MOCKED loopback browser suite only (never on a hosted deployment): the app talks to the local Privy emulator. */
  readonly e2e: boolean };
/** What the browser needs to start Privy. Contains no secret. */
export type PrivyBrowserConfig = { readonly appId: string; readonly apple: boolean; readonly e2e: boolean };
export type PrivyToken = { readonly userId: string; readonly sessionId: string; readonly issuedAt: number; readonly expiresAt: number };
/** One wallet held in the person's Privy embedded wallet (public metadata only). */
export type PrivyEmbeddedWallet = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly imported: boolean; readonly walletId: string | null;
  /** Whether the person granted Privy session signers (delegated actions) on it. FloFi never asks for this. */
  readonly delegated: boolean };
export type PrivyUser = { readonly id: string;
  /** Verified identities FloFi can sign someone in with: Google/Apple subjects, a verified email, external wallets proven by signature. */
  readonly identities: readonly IdentityClaim[];
  /** The most recently verified sign-in method, or null when the user has none FloFi accepts (for example SMS only). */
  readonly method: SessionMethod | null;
  /** The exact external wallet verified by this sign-in, when Privy identifies it unambiguously. */
  readonly loginWallet?: string;
  /**
   * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: the identity of that most recently verified method (kind and subject), or null. A returning account
   * signs in only with a method it already confirmed in FloFi (account-store.ts `signInPrivy`).
   */
  readonly login?: IdentityClaim | null;
  /**
   * When Privy last verified one of those identities (Unix seconds), or null. A FloFi session is "recently authenticated" from this time,
   * not from the access token's: Privy refreshes access tokens silently, so a fresh token alone proves no new sign-in by the person.
   */
  readonly verifiedAt: number | null;
  readonly wallets: readonly PrivyEmbeddedWallet[] };
/** The two calls FloFi makes to Privy (the official SDK by default; a test double in unit tests). */
export type PrivyApi = {
  readonly verifyAccessToken: (token: string) => Promise<{ app_id: string; user_id: string; session_id: string; issued_at: number; expiration: number }>;
  readonly getUser: (userId: string) => Promise<unknown>;
  /**
   * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001, retiring an EMPTY duplicate account only (account-service.ts `completeAccountMove`): block new logins and
   * revoke the user's Privy sessions, undo that, and delete the user. Optional so a test double without them fails closed.
   */
  readonly freezeUser?: (userId: string) => Promise<unknown>;
  readonly unfreezeUser?: (userId: string) => Promise<unknown>;
  readonly deleteUser?: (userId: string) => Promise<unknown>;
};
/** Whether a Privy user may be retired with its duplicate FloFi account: only sign-in methods, nothing that holds or controls value. */
export type PrivyRetirement = { readonly status: 'RETIRABLE'; readonly methods: readonly IdentityClaim[] } | { readonly status: 'GONE' }
  | { readonly status: 'REFUSED'; readonly code: string };

const APP_ID = /^[A-Za-z0-9]{10,64}$/, SECRET = /^[\x21-\x7e]{16,512}$/, JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SUBJECT = /^[A-Za-z0-9._-]{1,255}$/, RESOURCE = /^[A-Za-z0-9-]{8,64}$/;
const PEM = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]{80,1000}\n-----END PUBLIC KEY-----\n?$/;
export const PRIVY_API_URL = 'https://api.privy.io';
const fail = (code: string): never => { throw new Error(code); };

/** The Privy configuration, or null when this deployment has none (sign-in then says so; nothing is simulated). */
export function privyConfig(env: Env): PrivyServerConfig | null {
  const appId = env.NEXT_PUBLIC_PRIVY_APP_ID ?? '', appSecret = env.PRIVY_APP_SECRET ?? '';
  if (!appId || !appSecret || !APP_ID.test(appId) || !SECRET.test(appSecret)) return null;
  // The loopback emulator is a test harness: an unknown mode, or the harness on a hosted deployment, disables Privy (fail closed).
  const e2e = env.FLOFI_PRIVY_E2E === 'MOCKED_LOOPBACK_ONLY';
  if ((env.FLOFI_PRIVY_E2E && !e2e) || (e2e && isHostedDeployment(env))) return null;
  let apiUrl = PRIVY_API_URL;
  if (env.PRIVY_API_URL) {
    let url: URL;
    try { url = new URL(env.PRIVY_API_URL); } catch { return null; }
    if (!e2e || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') return null;
    apiUrl = url.origin;
  }
  const key = (env.PRIVY_VERIFICATION_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (key && !PEM.test(`${key}\n`)) return null;
  return { appId, appSecret, apiUrl, verificationKey: key ? `${key}\n` : null, apple: env.FLOFI_PRIVY_APPLE_LOGIN === 'enabled', e2e };
}

/** What the browser may know about this deployment's Privy app (public values only), or null without Privy. */
export function privyBrowserConfig(env: Env): PrivyBrowserConfig | null {
  const config = privyConfig(env);
  return config ? { appId: config.appId, apple: config.apple, e2e: config.e2e } : null;
}

const clients = new Map<string, PrivyApi>();
/** The official SDK client for this configuration (one per app: it caches the app's JWKS). */
export function officialPrivyApi(config: PrivyServerConfig, transport?: typeof fetch): PrivyApi {
  const cacheKey = `${config.appId}|${config.apiUrl}|${config.verificationKey ?? ''}|${config.appSecret}`;
  const cached = transport ? undefined : clients.get(cacheKey);
  if (cached) return cached;
  const client = new PrivyClient({ appId: config.appId, appSecret: config.appSecret, apiUrl: config.apiUrl, timeout: 15_000, maxRetries: 1,
    ...config.verificationKey ? { jwtVerificationKey: config.verificationKey } : {}, ...transport ? { fetch: transport } : {} });
  const api: PrivyApi = { verifyAccessToken: token => client.utils().auth().verifyAccessToken(token), getUser: userId => client.users()._get(userId),
    freezeUser: userId => client.users().freeze(userId), unfreezeUser: userId => client.users().unfreeze(userId), deleteUser: userId => client.users().delete(userId) };
  if (!transport) clients.set(cacheKey, api);
  return api;
}

const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const METHOD_ORDER: readonly SessionMethod[] = ['google', 'email', 'apple', 'eip155', 'solana'];
/** When Privy first verified a linked account (Unix seconds), or null. */
const since = (account: Json): number | null => seconds(account.first_verified_at ?? account.verified_at) || null;

/** The verified identities and embedded wallets of a Privy user object (strict: anything unexpected is ignored, never repaired). */
export function readPrivyUser(value: unknown, userId: string, options: { readonly apple?: boolean } = {}): PrivyUser {
  const user = record(value);
  if (user.id !== userId || !PRIVY_USER_ID.test(userId) || !Array.isArray(user.linked_accounts)) return fail('PRIVY_RESPONSE_INVALID');
  const identities: IdentityClaim[] = [], wallets: PrivyEmbeddedWallet[] = [];
  let method: SessionMethod | null = null, latest = -1;
  let loginWallet: string | undefined, login: IdentityClaim | null = null;
  const seen = (kind: SessionMethod, at: unknown, address?: string) => {
    const time = seconds(at), claim = identities.at(-1) ?? null;
    if (time > latest || (time === latest && method !== null && METHOD_ORDER.indexOf(kind) < METHOD_ORDER.indexOf(method))) {
      latest = time;
      method = kind;
      loginWallet = address;
      login = claim;
    } else if (time === latest && method === kind && (address !== loginWallet || claim?.subject !== login?.subject)) {
      // Two methods of the same kind verified at the same second: which one signed in is unknown (never guessed).
      loginWallet = undefined;
      login = null;
    }
  };
  for (const entry of (user.linked_accounts as unknown[]).slice(0, 64)) {
    const account = record(entry), at = account.latest_verified_at ?? account.verified_at;
    if (account.type === 'email') {
      const email = normalizeEmail(account.address);
      if (email) { identities.push({ kind: 'email', subject: email, label: email, since: since(account) }); seen('email', at); }
    } else if (account.type === 'google_oauth' || (account.type === 'apple_oauth' && options.apple === true)) {
      // Apple counts only once this deployment enabled it (FloFi's own Apple Services ID in Privy): otherwise an Apple login enabled in the
      // Privy dashboard alone would create a second account for a person whose earlier Apple sign-in has another subject.
      const kind = account.type === 'google_oauth' ? 'google' : 'apple';
      if (typeof account.subject === 'string' && SUBJECT.test(account.subject)) {
        identities.push({ kind, subject: account.subject, label: normalizeEmail(account.email), since: since(account) });
        seen(kind, at);
      }
    } else if (account.type === 'wallet' && (account.chain_type === 'ethereum' || account.chain_type === 'solana')) {
      const ecosystem: WalletEcosystem = account.chain_type === 'ethereum' ? 'evm' : 'solana', address = canonicalAddress(ecosystem, account.address);
      if (!address) continue;
      if (account.wallet_client_type === 'privy' && account.connector_type === 'embedded') {
        wallets.push({ ecosystem, address, imported: account.imported === true, delegated: account.delegated === true,
          walletId: typeof account.id === 'string' && RESOURCE.test(account.id) ? account.id : null });
      } else if (account.wallet_client_type !== 'privy' && account.connector_type !== 'embedded') {
        // An external wallet Privy linked after verifying its signature (SIWE / SIWS).
        const kind = ecosystem === 'evm' ? 'eip155' : 'solana';
        identities.push({ kind, subject: address, label: null, since: since(account) });
        seen(kind, at, address);
      }
    }
  }
  return { id: userId, identities, method, wallets, verifiedAt: method === null || latest <= 0 ? null : latest,
    ...(loginWallet && latest > 0 ? { loginWallet } : {}), login: method === null || latest <= 0 ? null : login };
}

export function createPrivyServer(config: PrivyServerConfig, api: PrivyApi = officialPrivyApi(config), now = () => Date.now()) {
  return {
    browser: (): PrivyBrowserConfig => ({ appId: config.appId, apple: config.apple, e2e: config.e2e }),
    /** Verifies a Privy access token for this app. Every failure is `PRIVY_TOKEN_INVALID` (or `PRIVY_UNAVAILABLE` for a provider outage). */
    async verify(token: unknown): Promise<PrivyToken> {
      if (typeof token !== 'string' || token.length > 4_096 || !JWT.test(token)) return fail('PRIVY_TOKEN_INVALID');
      let claims: Awaited<ReturnType<PrivyApi['verifyAccessToken']>>;
      try { claims = await api.verifyAccessToken(token); }
      catch (error) {
        const name = error instanceof Error ? `${error.name} ${error.message}` : '';
        // A JWKS download that failed is an outage, not a bad token: the person may simply try again.
        throw new Error(/fetch|network|timeout|ECONN|JWKS|aborted/i.test(name) && !/invalid|expired/i.test(name) ? 'PRIVY_UNAVAILABLE' : 'PRIVY_TOKEN_INVALID', { cause: error });
      }
      if (claims.app_id !== config.appId || typeof claims.user_id !== 'string' || !PRIVY_USER_ID.test(claims.user_id)
        || !(seconds(claims.expiration) * 1000 > now())) return fail('PRIVY_TOKEN_INVALID');
      return { userId: claims.user_id, sessionId: typeof claims.session_id === 'string' ? claims.session_id : '', issuedAt: seconds(claims.issued_at),
        expiresAt: seconds(claims.expiration) };
    },
    /** The Privy user behind a verified token, as Privy's API reports it now. */
    async user(userId: string): Promise<PrivyUser> {
      if (!PRIVY_USER_ID.test(userId)) return fail('PRIVY_TOKEN_INVALID');
      let value: unknown;
      try { value = await api.getUser(userId); }
      catch (error) {
        const status = record(error).status;
        throw new Error(status === 404 ? 'PRIVY_USER_NOT_FOUND' : status === 401 || status === 403 ? 'PRIVY_NOT_AUTHORIZED' : 'PRIVY_UNAVAILABLE', { cause: error });
      }
      return readPrivyUser(value, userId, { apple: config.apple });
    },
    /**
     * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: whether this Privy user may be retired with an empty duplicate FloFi account. Read from Privy's own
     * record of the user (never the browser, never `readPrivyUser`, which ignores what FloFi does not use): every linked account must be a
     * sign-in method FloFi can release (Google, Apple, email) and nothing may hold or control value or a second factor — any wallet (embedded,
     * external, smart or cross-app), MFA, or any other account type refuses it.
     */
    async retirement(userId: string): Promise<PrivyRetirement> {
      if (!PRIVY_USER_ID.test(userId)) return fail('PRIVY_TOKEN_INVALID');
      let value: unknown;
      try { value = await api.getUser(userId); }
      catch (error) {
        const status = record(error).status;
        if (status === 404) return { status: 'GONE' };
        throw new Error(status === 401 || status === 403 ? 'PRIVY_NOT_AUTHORIZED' : 'PRIVY_UNAVAILABLE', { cause: error });
      }
      const user = record(value);
      if (user.id !== userId || !Array.isArray(user.linked_accounts) || user.linked_accounts.length > 64) return { status: 'REFUSED', code: 'ACCOUNT_MOVE_PRIVY_UNREADABLE' };
      if (Array.isArray(user.mfa_methods) && user.mfa_methods.length) return { status: 'REFUSED', code: 'ACCOUNT_MOVE_PRIVY_HAS_MFA' };
      for (const entry of user.linked_accounts as unknown[]) {
        const account = record(entry);
        if (account.type === 'google_oauth' || account.type === 'apple_oauth' || account.type === 'email') continue;
        // Any wallet refuses it: an embedded one would become unreachable, and a sign-in wallet is a wallet the account holds.
        return { status: 'REFUSED', code: account.type === 'wallet' && account.wallet_client_type !== 'privy' && account.connector_type !== 'embedded'
          ? 'ACCOUNT_MOVE_WALLET_SIGN_IN' : account.type === 'wallet' || account.type === 'smart_wallet' || account.type === 'cross_app' ? 'ACCOUNT_MOVE_HAS_WALLET'
            : 'ACCOUNT_MOVE_PRIVY_METHOD_UNSUPPORTED' };
      }
      return { status: 'RETIRABLE', methods: readPrivyUser(value, userId, { apple: true }).identities };
    },
    /** Blocks new logins of this Privy user and revokes its sessions (Privy `freeze`). A user already gone counts as done. */
    async freeze(userId: string): Promise<void> { await gone(() => (api.freezeUser ?? fail('PRIVY_UNAVAILABLE'))(userId)); },
    async unfreeze(userId: string): Promise<void> { await gone(() => (api.unfreezeUser ?? fail('PRIVY_UNAVAILABLE'))(userId)); },
    /** Deletes the Privy user (irreversible). A user already gone (an earlier attempt succeeded) counts as done. */
    async remove(userId: string): Promise<void> { await gone(() => (api.deleteUser ?? fail('PRIVY_UNAVAILABLE'))(userId)); },
  };
  async function gone(run: () => Promise<unknown>): Promise<void> {
    try { await run(); }
    catch (error) {
      const status = record(error).status;
      if (status === 404) return;
      throw new Error(status === 401 || status === 403 ? 'PRIVY_NOT_AUTHORIZED' : 'PRIVY_UNAVAILABLE', { cause: error });
    }
  }
}
export type PrivyServer = ReturnType<typeof createPrivyServer>;
