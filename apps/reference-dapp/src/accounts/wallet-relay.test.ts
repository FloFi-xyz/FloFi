// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet's relay forwards only what its rules allow. Since BUILD-FLOFI-PRIVY-UX-001 FloFi Wallet (Turnkey)
// is the legacy, export-only home of wallets created there before Privy: the relay forwards only the export of a legacy wallet saved to the
// account (after a recent unlock by exactly the unlocked key) and refuses creating, importing and signing, whatever the request carries.
import { describe, expect, it, vi } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { floFiSignInMessage, stampPublicKey, walletRelayDecision } from './wallet-relay';
import { exportOf, isLegacyWallet, type AccountWallet } from './account-model';
import type { WalletSession } from './wallet-session';
import { SOLANA_SIGN_IN_STATEMENT, WALLET_SIGN_IN_STATEMENT } from '../server/wallet-session';

const NOW = new Date('2026-10-31T12:00:00.000Z'), T = Math.floor(NOW.getTime() / 1000);
const KEY = '02' + 'a'.repeat(64), OTHER_KEY = '03' + 'b'.repeat(64);
const EVM = '0x' + '1'.repeat(40), SOLANA = '11111111111111111111111111111111', PRIVY_EVM = '0x' + '3'.repeat(40), EXTERNAL_EVM = '0x' + '9'.repeat(40);
const ORG = { organizationId: 'org-1', userId: 'user-1' }, APP = { host: 'flofi.xyz', origin: 'https://flofi.xyz' };
const API = 'https://api.turnkey.com';
const wallet = (ecosystem: 'evm' | 'solana', address: string, origin: AccountWallet['origin'] = 'generated',
  provider = origin === 'external' ? 'io.metamask' : 'turnkey'): AccountWallet => ({ id: `${ecosystem}:${address}`, ecosystem, address, origin, provider,
  providerName: 'FloFi wallet', export: exportOf(origin, provider), label: 'Main', addedAt: NOW.toISOString() });
/** The account's wallets: a legacy generated EVM wallet, a legacy imported Solana key, a Privy wallet and an external wallet. */
const WALLETS = [wallet('evm', EVM), wallet('solana', SOLANA, 'imported'), wallet('evm', PRIVY_EVM, 'generated', 'privy'), wallet('evm', EXTERNAL_EVM, 'external')];
/** Provider resources by address (the store returns one for every non-external wallet; a Privy wallet may carry its Privy id). */
const RESOURCES: Readonly<Record<string, { origin: string; resource: string }>> = { [EVM]: { origin: 'generated', resource: 'wallet-123456' },
  [SOLANA]: { origin: 'imported', resource: 'key-abcdef12' }, [PRIVY_EVM]: { origin: 'generated', resource: 'wallet-privy01' } };
const session = (patch: Partial<WalletSession> = {}): WalletSession => ({ account: { accountId: 'acct_' + '0'.repeat(32), sessionId: 'f'.repeat(32), method: 'email',
  authenticatedAt: T - 60, expiresAt: T + 3600 }, issuedAt: T - 60, expiresAt: T + 1800, unlockedKey: KEY, unlockedAt: T - 30, unlockedUntil: T + 600, ...patch });
const stamp = (publicKey = KEY) => Buffer.from(JSON.stringify({ publicKey, scheme: 'SIGNATURE_SCHEME_TK_API_P256', signature: '30' + '0'.repeat(140) })).toString('base64url');
const unsigned = () => Buffer.from(erc7710.unsignedEip1559({ chainId: 8453n, nonce: 7n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n,
  gasLimit: 21_000n, to: '0x' + '2'.repeat(40), value: 5n, data: '0x' })).toString('hex');
const TYPES: Readonly<Record<string, string>> = { 'submit/export_wallet': 'ACTIVITY_TYPE_EXPORT_WALLET', 'submit/export_wallet_account': 'ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT',
  'submit/export_private_key': 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY', 'submit/create_wallet': 'ACTIVITY_TYPE_CREATE_WALLET',
  'submit/init_import_private_key': 'ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY', 'submit/import_private_key': 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY',
  'submit/sign_transaction': 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2', 'submit/sign_raw_payload': 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' };
type Input = Parameters<typeof walletRelayDecision>[0];
const body = (path: string, parameters: Record<string, unknown>, organizationId = ORG.organizationId) =>
  JSON.stringify({ type: TYPES[path] ?? 'ACTIVITY_TYPE_GET_ACTIVITY', timestampMs: String(NOW.getTime()), organizationId, parameters });
function decide(path: string, parameters: Record<string, unknown>, patch: Partial<Input> = {}) {
  return walletRelayDecision({ path, body: body(path, parameters), stamp: stamp(), session: session(), organization: ORG, apiBaseUrl: API,
    wallets: async () => WALLETS, managedResource: async item => RESOURCES[item.address] ?? null, now: NOW, ...patch });
}
const forwarded = (path: string) => ({ ok: true, url: `${API}/public/v1/${path}` });
const EXPORT = { walletId: 'wallet-123456', targetPublicKey: '04' + 'c'.repeat(128) };

describe('wallet relay: session, key, request shape and organization', () => {
  it('refuses without a provider, a wallet session, an organization, an allowlisted route, a stamp or the unlocked key', async () => {
    expect(await decide('submit/export_wallet', EXPORT, { apiBaseUrl: null })).toEqual({ ok: false, status: 503, code: 'MANAGED_WALLETS_NOT_CONFIGURED' });
    expect(await decide('submit/export_wallet', EXPORT, { session: null })).toEqual({ ok: false, status: 401, code: 'WALLET_SESSION_REQUIRED' });
    expect(await decide('submit/export_wallet', EXPORT, { organization: null })).toEqual({ ok: false, status: 403, code: 'MANAGED_ORGANIZATION_MISSING' });
    expect(await decide('submit/eth_send_transaction', {})).toEqual({ ok: false, status: 404, code: 'PROVIDER_ROUTE_NOT_ALLOWED' });
    expect(await decide('submit/sol_send_transaction', {})).toEqual({ ok: false, status: 404, code: 'PROVIDER_ROUTE_NOT_ALLOWED' });
    expect(await decide('submit/export_wallet', EXPORT, { stamp: null })).toEqual({ ok: false, status: 400, code: 'PROVIDER_STAMP_REQUIRED' });
    expect(await decide('submit/export_wallet', EXPORT, { stamp: stamp(OTHER_KEY) })).toEqual({ ok: false, status: 403, code: 'WALLET_UNLOCK_REQUIRED' });
    expect(await decide('submit/export_wallet', EXPORT, { session: session({ unlockedUntil: T - 1 }) })).toEqual({ ok: false, status: 403, code: 'WALLET_UNLOCK_REQUIRED' });
    expect(await decide('submit/export_wallet', EXPORT, { session: session({ unlockedKey: null, unlockedAt: null, unlockedUntil: null }) }))
      .toEqual({ ok: false, status: 403, code: 'WALLET_UNLOCK_REQUIRED' });
    expect(stampPublicKey(stamp())).toBe(KEY);
  });
  it('requires the canonical JSON the page stamped, the account’s own organization and the route’s own activity', async () => {
    const base = { path: 'submit/export_wallet', stamp: stamp(), session: session(), organization: ORG, apiBaseUrl: API, wallets: async () => WALLETS,
      managedResource: async (item: AccountWallet) => RESOURCES[item.address] ?? null, now: NOW };
    const spaced = '{"organizationId":"org-1", "type":"ACTIVITY_TYPE_EXPORT_WALLET"}';
    expect(await walletRelayDecision({ ...base, body: spaced })).toEqual({ ok: false, status: 400, code: 'PROVIDER_REQUEST_NOT_CANONICAL' });
    expect(await walletRelayDecision({ ...base, body: body('submit/export_wallet', EXPORT, 'org-2') })).toEqual({ ok: false, status: 403, code: 'PROVIDER_ORGANIZATION_MISMATCH' });
    const mismatched = JSON.stringify({ type: 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY', timestampMs: String(NOW.getTime()), organizationId: ORG.organizationId, parameters: EXPORT });
    expect(await walletRelayDecision({ ...base, body: mismatched })).toEqual({ ok: false, status: 400, code: 'PROVIDER_ACTIVITY_MISMATCH' });
    expect(await walletRelayDecision({ ...base, body: body('submit/export_wallet', EXPORT) })).toEqual(forwarded('submit/export_wallet'));
  });
});

describe('wallet relay: legacy and export-only', () => {
  it('refuses creating, importing and signing before it reads the account’s wallets, even for requests it used to forward', async () => {
    const siwe = `${APP.host} wants you to sign in with your Ethereum account:\n${EVM}\n\n${WALLET_SIGN_IN_STATEMENT}\n\nURI: ${APP.origin}\nVersion: 1\nChain ID: 8453`;
    const message = Buffer.from(siwe, 'utf8'), personal = Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, 'utf8'), message]).toString('hex');
    const requests: [string, Record<string, unknown>][] = [
      ['submit/create_wallet', { walletName: 'w', accounts: [{ curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/60'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_ETHEREUM' }] }],
      ['submit/create_wallet_accounts', { walletId: 'wallet-123456', accounts: [] }],
      ['submit/init_import_private_key', { userId: ORG.userId }],
      ['submit/import_private_key', { userId: ORG.userId, privateKeyName: 'k', encryptedBundle: 'x', curve: 'CURVE_SECP256K1', addressFormats: ['ADDRESS_FORMAT_ETHEREUM'] }],
      ['submit/init_import_wallet', { userId: ORG.userId }], ['submit/import_wallet', { userId: ORG.userId, walletName: 'w', encryptedBundle: 'x', accounts: [] }],
      // Exactly what the relay forwarded before Privy (with a reviewed-attempt binding): a type 2 transaction on Base by a legacy wallet.
      ['submit/sign_transaction', { signWith: EVM, unsignedTransaction: unsigned(), type: 'TRANSACTION_TYPE_ETHEREUM' }],
      // FloFi's own sign-in message for this host, naming the legacy signer, as EIP-191 bytes hashed by the provider.
      ['submit/sign_raw_payload', { signWith: EVM, payload: personal, encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_KECCAK256' }],
      ['submit/sign_raw_payloads', { signWith: SOLANA, payloads: ['00'], encoding: 'PAYLOAD_ENCODING_HEXADECIMAL', hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE' }],
      ['submit/create_policy', {}], ['submit/create_api_keys', {}], ['submit/create_users', {}], ['query/list_wallets', {}], ['query/list_private_keys', {}],
    ];
    for (const [path, parameters] of requests) {
      const wallets = vi.fn(async () => WALLETS), managedResource = vi.fn(async () => RESOURCES[EVM]!);
      expect(await decide(path, parameters, { wallets, managedResource }), path).toEqual({ ok: false, status: 404, code: 'PROVIDER_ROUTE_NOT_ALLOWED' });
      expect(wallets, path).not.toHaveBeenCalled();
      expect(managedResource, path).not.toHaveBeenCalled();
    }
  });
  it('forwards an activity poll for the unlocked key, without any export rule', async () => {
    expect(await decide('query/get_activity', { activityId: 'activity-1' })).toEqual(forwarded('query/get_activity'));
    expect(await decide('query/get_activity', { activityId: 'activity-1' }, { stamp: stamp(OTHER_KEY) })).toEqual({ ok: false, status: 403, code: 'WALLET_UNLOCK_REQUIRED' });
  });
  it('exports only with a recent unlock and a legacy wallet of this account that owns the exported resource', async () => {
    expect(await decide('submit/export_wallet', EXPORT)).toEqual(forwarded('submit/export_wallet'));
    expect(await decide('submit/export_wallet', { ...EXPORT, walletId: 'wallet-other' })).toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet', EXPORT, { session: session({ unlockedAt: T - 301 }) })).toEqual({ ok: false, status: 403, code: 'WALLET_UNLOCK_REQUIRED' });
    // A generated wallet's account by its address (any case), an imported key by its id; never one kind of resource through the other route.
    expect(await decide('submit/export_wallet_account', { address: EVM.toUpperCase().replace('0X', '0x'), targetPublicKey: EXPORT.targetPublicKey }))
      .toEqual(forwarded('submit/export_wallet_account'));
    expect(await decide('submit/export_private_key', { privateKeyId: 'key-abcdef12', targetPublicKey: EXPORT.targetPublicKey })).toEqual(forwarded('submit/export_private_key'));
    expect(await decide('submit/export_private_key', { privateKeyId: 'wallet-123456', targetPublicKey: EXPORT.targetPublicKey }))
      .toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet', { ...EXPORT, walletId: 'key-abcdef12' })).toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet_account', { address: SOLANA, targetPublicKey: EXPORT.targetPublicKey })).toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    // Another account's wallet (not in this account's list) is never exported, whatever resource the provider holds.
    expect(await decide('submit/export_wallet', EXPORT, { wallets: async () => [] })).toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
  });
  it('never exports a Privy or external wallet through FloFi Wallet, nor looks up their resources', async () => {
    const managedResource = vi.fn(async (item: AccountWallet) => RESOURCES[item.address] ?? null);
    expect(await decide('submit/export_wallet', { ...EXPORT, walletId: 'wallet-privy01' }, { managedResource })).toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet_account', { address: PRIVY_EVM, targetPublicKey: EXPORT.targetPublicKey }, { managedResource }))
      .toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet_account', { address: EXTERNAL_EVM, targetPublicKey: EXPORT.targetPublicKey }, { managedResource }))
      .toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(managedResource.mock.calls.length).toBeGreaterThan(0);
    expect(managedResource.mock.calls.every(([item]) => isLegacyWallet(item))).toBe(true);
    // The very resource a legacy wallet would own is refused when the account's wallet with it is a Privy wallet.
    const privyOnly = [wallet('evm', EVM, 'generated', 'privy')];
    expect(await decide('submit/export_wallet', EXPORT, { wallets: async () => privyOnly })).toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
    expect(await decide('submit/export_wallet_account', { address: EVM, targetPublicKey: EXPORT.targetPublicKey }, { wallets: async () => privyOnly }))
      .toEqual({ ok: false, status: 403, code: 'EXPORT_NOT_SUPPORTED' });
  });
});

describe('FloFi sign-in messages', () => {
  it('accepts only FloFi’s own sign-in message for this host and that wallet, on FloFi Wallet’s mainnets', () => {
    const siws = `${APP.host} wants you to sign in with your Solana account:\n${SOLANA}\n\n${SOLANA_SIGN_IN_STATEMENT}\n\nURI: ${APP.origin}\nVersion: 1\nNonce: abc`;
    expect(floFiSignInMessage(siws, 'solana', SOLANA, APP)).toBe(true);
    expect(floFiSignInMessage(siws.replace(APP.host, 'evil.example'), 'solana', SOLANA, APP)).toBe(false);
    expect(floFiSignInMessage(siws, 'solana', '22222222222222222222222222222222', APP)).toBe(false);
    expect(floFiSignInMessage(siws.replace(SOLANA_SIGN_IN_STATEMENT, 'Approve everything.'), 'solana', SOLANA, APP)).toBe(false);
    const siwe = (chain: number) => `${APP.host} wants you to sign in with your Ethereum account:\n${EVM}\n\n${WALLET_SIGN_IN_STATEMENT}\n\nURI: ${APP.origin}\nVersion: 1\nChain ID: ${chain}`;
    // EVM sign-in on FloFi Wallet's four mainnets only; a testnet chain (Base Sepolia, Sepolia, Robinhood Chain Testnet) is refused.
    for (const chain of [1, 8453, 42161, 4663]) expect(floFiSignInMessage(siwe(chain), 'evm', EVM, APP)).toBe(true);
    for (const chain of [84532, 11155111, 46630, 421614]) expect(floFiSignInMessage(siwe(chain), 'evm', EVM, APP)).toBe(false);
    expect(floFiSignInMessage(siwe(8453).replace(`URI: ${APP.origin}`, 'URI: https://evil.example'), 'evm', EVM, APP)).toBe(false);
  });
});
