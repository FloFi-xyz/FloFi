// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet's relay for its stamped provider requests (wallet origin only). Since BUILD-FLOFI-PRIVY-UX-001
 * FloFi Wallet (Turnkey) is the legacy, export-only home of wallets created there before Privy: it relays only the export activities.
 *
 * The wallet page stamps each request with the wallet-origin key that the person unlocked; the relay forwards body and stamp byte for
 * byte and can neither create nor alter either. Before forwarding it requires: a valid wallet session for a valid account session, a
 * stamp by exactly the unlocked key, canonical JSON, the account's own provider organization, an allowlisted activity, an unlock in the
 * last 5 minutes and a legacy wallet saved to this account that the exported resource belongs to.
 * Creating, importing and signing are no longer relayed (FloFi's wallets are Privy wallets now), and broadcasting activities, policies,
 * users and API keys never were. These checks are defence in depth; the person's confirmation in the wallet page comes first.
 */
import { accountWalletId, canonicalAddress, isLegacyWallet, type AccountWallet } from './account-model.ts';
import { SOLANA_SIGN_IN_STATEMENT, WALLET_SIGN_IN_STATEMENT } from '../server/wallet-session.ts';
import { unlockedFor, WALLET_EXPORT_UNLOCK_SECONDS, type WalletSession } from './wallet-session.ts';
import { FLOFI_WALLET_EVM_CHAIN_IDS } from '../wallet/flofi-signing.ts';

/** Export only (legacy, BUILD-FLOFI-PRIVY-UX-001). Every other provider route, including create, import and sign, is refused. */
const ALLOWED = new Map<string, string | null>([
  ['submit/export_wallet', 'ACTIVITY_TYPE_EXPORT_WALLET'], ['submit/export_wallet_account', 'ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT'],
  ['submit/export_private_key', 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY'], ['query/get_activity', null],
]);
const STAMP = /^[A-Za-z0-9_-]{40,2048}$/, MAX_BODY = 65_536;
/** A sign-in message only: SIWE/EIP-4361 or Sign-In With Solana text, bounded, printable. */
const SIGN_IN_MESSAGE = /^[^\n]{1,256} wants you to sign in with your (?:Ethereum|Solana) account:\n[^\0]{1,4000}$/;
export type WalletRelayDecision = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly status: number; readonly code: string };
type Organization = { readonly organizationId: string; readonly userId: string } | null;

/** The public key inside an `X-Stamp` header (base64url JSON), or null. */
export function stampPublicKey(stamp: string): string | null {
  try {
    const value = JSON.parse(Buffer.from(stamp, 'base64url').toString('utf8')) as { publicKey?: unknown; scheme?: unknown };
    return value.scheme === 'SIGNATURE_SCHEME_TK_API_P256' && typeof value.publicKey === 'string' && /^0[23][0-9a-f]{64}$/.test(value.publicKey) ? value.publicKey : null;
  } catch { return null; }
}

/**
 * Whether `message` is exactly a FloFi sign-in message for the product host, as FloFi's server writes it (server/wallet-session.ts
 * `walletSignInMessage` / `solanaSignInMessage`): `<appHost> wants you to sign in with your <chain> account:`, the signing address, FloFi's
 * own statement, `URI: <appOrigin>`, version 1, the chain (EVM: one of FloFi's mainnets), a server nonce, the issue and expiry times, and
 * nothing else; unexpired at `now`. Another dapp's domain or statement, extra lines or an expired message are never signed.
 */
const SIGN_IN_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, SIGN_IN_NONCE = /^[0-9a-f]{32}$/;
export function floFiSignInMessage(message: string, ecosystem: 'evm' | 'solana', address: string, app: { readonly host: string; readonly origin: string },
  now = Date.now()): boolean {
  if (!SIGN_IN_MESSAGE.test(message) || message.length > 2_048 || /[\0\r]/.test(message)) return false;
  const lines = message.split('\n'), evm = ecosystem === 'evm', chain = evm ? 'Ethereum' : 'Solana';
  if (lines.length !== (evm ? 11 : 10)) return false;
  const statement = evm ? WALLET_SIGN_IN_STATEMENT : SOLANA_SIGN_IN_STATEMENT;
  // EVM: the message's chain must be one of FloFi's mainnets (Solana sign-in messages name no cluster).
  const evmChain = evm ? /^Chain ID: ([1-9][0-9]{0,15})$/.exec(lines[7] ?? '') : null;
  if (evm && (!evmChain || !FLOFI_WALLET_EVM_CHAIN_IDS.has(Number(evmChain[1])))) return false;
  const [nonceLine = '', issuedLine = '', expiresLine = ''] = lines.slice(evm ? 8 : 7);
  const nonce = nonceLine.startsWith('Nonce: ') ? nonceLine.slice(7) : '', issuedAt = issuedLine.startsWith('Issued At: ') ? issuedLine.slice(11) : '';
  const expiresAt = expiresLine.startsWith('Expiration Time: ') ? expiresLine.slice(17) : '';
  if (!SIGN_IN_NONCE.test(nonce) || !SIGN_IN_ISO.test(issuedAt) || !SIGN_IN_ISO.test(expiresAt)) return false;
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires <= now) return false;
  return lines[0] === `${app.host} wants you to sign in with your ${chain} account:` && canonicalAddress(ecosystem, lines[1] ?? '') === address
    && lines[2] === '' && lines[3] === statement && lines[4] === '' && lines[5] === `URI: ${app.origin}` && lines[6] === 'Version: 1';
}

export async function walletRelayDecision(input: { readonly path: string; readonly body: string; readonly stamp: string | null;
  readonly session: WalletSession | null; readonly organization: Organization; readonly apiBaseUrl: string | null;
  readonly wallets: () => Promise<readonly AccountWallet[]>; readonly managedResource: (wallet: AccountWallet) => Promise<{ origin: string; resource: string } | null>;
  readonly now: Date }): Promise<WalletRelayDecision> {
  const deny = (status: number, code: string): WalletRelayDecision => ({ ok: false, status, code });
  if (!input.apiBaseUrl) return deny(503, 'MANAGED_WALLETS_NOT_CONFIGURED');
  if (!input.session) return deny(401, 'WALLET_SESSION_REQUIRED');
  if (!input.organization) return deny(403, 'MANAGED_ORGANIZATION_MISSING');
  if (!ALLOWED.has(input.path)) return deny(404, 'PROVIDER_ROUTE_NOT_ALLOWED');
  if (!input.stamp || !STAMP.test(input.stamp)) return deny(400, 'PROVIDER_STAMP_REQUIRED');
  // Only the key this wallet session unlocked may be relayed (no other browser key, and nothing once the unlock has ended).
  const key = stampPublicKey(input.stamp);
  if (!key || !input.session.unlockedKey || !unlockedFor(input.session, key, input.now)) return deny(403, 'WALLET_UNLOCK_REQUIRED');
  if (input.body.length > MAX_BODY) return deny(413, 'PROVIDER_REQUEST_TOO_LARGE');
  let body: Record<string, unknown>;
  try { body = JSON.parse(input.body) as Record<string, unknown>; } catch { return deny(400, 'PROVIDER_REQUEST_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return deny(400, 'PROVIDER_REQUEST_INVALID');
  // The exact serialization the page stamped: duplicate keys or a re-encoding could make these checks and the provider read different values.
  if (JSON.stringify(body) !== input.body) return deny(400, 'PROVIDER_REQUEST_NOT_CANONICAL');
  if (body.organizationId !== input.organization.organizationId) return deny(403, 'PROVIDER_ORGANIZATION_MISMATCH');
  const type = ALLOWED.get(input.path);
  if (type && body.type !== type) return deny(400, 'PROVIDER_ACTIVITY_MISMATCH');
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters) ? body.parameters as Record<string, unknown> : {};
  if (input.path.startsWith('submit/export_')) {
    if (!unlockedFor(input.session, key, input.now, WALLET_EXPORT_UNLOCK_SECONDS)) return deny(403, 'WALLET_UNLOCK_REQUIRED');
    let owned = false;
    for (const wallet of (await input.wallets()).filter(isLegacyWallet)) {
      const resource = await input.managedResource(wallet);
      if (!resource) continue;
      if (input.path === 'submit/export_wallet' && resource.origin === 'generated' && parameters.walletId === resource.resource) owned = true;
      if (input.path === 'submit/export_private_key' && resource.origin === 'imported' && parameters.privateKeyId === resource.resource) owned = true;
      if (input.path === 'submit/export_wallet_account' && resource.origin === 'generated'
        && accountWalletId(wallet.ecosystem, canonicalAddress(wallet.ecosystem, parameters.address) ?? '') === wallet.id) owned = true;
    }
    if (!owned) return deny(403, 'EXPORT_NOT_SUPPORTED');
  }
  return { ok: true, url: `${input.apiBaseUrl}/public/v1/${input.path}` };
}
