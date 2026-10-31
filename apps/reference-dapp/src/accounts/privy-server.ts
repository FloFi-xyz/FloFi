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
  readonly wallets: readonly PrivyEmbeddedWallet[] };
/** The two calls FloFi makes to Privy (the official SDK by default; a test double in unit tests). */
export type PrivyApi = {
  readonly verifyAccessToken: (token: string) => Promise<{ app_id: string; user_id: string; session_id: string; issued_at: number; expiration: number }>;
  readonly getUser: (userId: string) => Promise<unknown>;
};

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
export function officialPrivyApi(config: PrivyServerConfig): PrivyApi {
  const cacheKey = `${config.appId}|${config.apiUrl}|${config.verificationKey ?? ''}|${config.appSecret}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;
  const client = new PrivyClient({ appId: config.appId, appSecret: config.appSecret, apiUrl: config.apiUrl, timeout: 15_000, maxRetries: 1,
    ...config.verificationKey ? { jwtVerificationKey: config.verificationKey } : {} });
  const api: PrivyApi = { verifyAccessToken: token => client.utils().auth().verifyAccessToken(token), getUser: userId => client.users()._get(userId) };
  clients.set(cacheKey, api);
  return api;
}

const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const METHOD_ORDER: readonly SessionMethod[] = ['google', 'email', 'apple', 'eip155', 'solana'];

/** The verified identities and embedded wallets of a Privy user object (strict: anything unexpected is ignored, never repaired). */
export function readPrivyUser(value: unknown, userId: string): PrivyUser {
  const user = record(value);
  if (user.id !== userId || !PRIVY_USER_ID.test(userId) || !Array.isArray(user.linked_accounts)) return fail('PRIVY_RESPONSE_INVALID');
  const identities: IdentityClaim[] = [], wallets: PrivyEmbeddedWallet[] = [];
  let method: SessionMethod | null = null, latest = -1;
  const seen = (kind: SessionMethod, at: unknown) => {
    const time = seconds(at);
    if (time > latest || (time === latest && method !== null && METHOD_ORDER.indexOf(kind) < METHOD_ORDER.indexOf(method))) { latest = time; method = kind; }
  };
  for (const entry of (user.linked_accounts as unknown[]).slice(0, 64)) {
    const account = record(entry), at = account.latest_verified_at ?? account.verified_at;
    if (account.type === 'email') {
      const email = normalizeEmail(account.address);
      if (email) { identities.push({ kind: 'email', subject: email, label: email }); seen('email', at); }
    } else if (account.type === 'google_oauth' || account.type === 'apple_oauth') {
      const kind = account.type === 'google_oauth' ? 'google' : 'apple';
      if (typeof account.subject === 'string' && SUBJECT.test(account.subject)) {
        identities.push({ kind, subject: account.subject, label: normalizeEmail(account.email) });
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
        identities.push({ kind, subject: address, label: null });
        seen(kind, at);
      }
    }
  }
  return { id: userId, identities, method, wallets };
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
      return readPrivyUser(value, userId);
    },
  };
}
export type PrivyServer = ReturnType<typeof createPrivyServer>;
