// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001 — MOCKED, LOOPBACK ONLY: a stand-in for the Privy services FloFi uses, for the browser suite
 * (playwright.auth-wallets.config.ts). Never a public provider, never a real identity or key, never real funds.
 *
 * Server side, exactly what FloFi's server calls through the official `@privy-io/node` SDK (PRIVY_API_URL points here):
 * - `GET /v1/apps/<app id>/jwks.json`: the ES256 key that signs this run's access tokens (generated at start-up);
 * - `GET /v1/users/<did>`: the user with snake_case linked accounts, only with the app's Basic credentials and `privy-app-id`.
 * Browser side (`/client/*`, reached by the test's route for `/__privy-e2e/*`; e2e/privy-emulator-client.js): Google / email-code / wallet
 * sign-in, embedded wallet creation and private-key import (one generated wallet per ecosystem and one imported EVM key, like Privy), and
 * signing with DISPOSABLE in-memory keys (secp256k1, Ed25519) that exist only in this process for this run, so FloFi verifies real signatures.
 * Export shows nothing (no secret is ever produced). `/__e2e/*`: test controls and counters.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { base58Decode, base58Encode, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { secp256k1 } from '../../../packages/reference-reconciler/node_modules/@noble/curves/secp256k1.js';
import { keccak_256 } from '../../../packages/reference-reconciler/node_modules/@noble/hashes/sha3.js';

export const PRIVY_E2E_PORT = 8581, PRIVY_E2E_EMAIL_CODE = '135790';
const appId = process.env.FLOFI_PRIVY_E2E_APP_ID ?? '', appSecret = process.env.FLOFI_PRIVY_E2E_APP_SECRET ?? '';
if (!/^[A-Za-z0-9]{10,64}$/.test(appId) || appSecret.length < 16) throw new Error('PRIVY_EMULATOR_CONFIG_INVALID');

type Json = Record<string, unknown>;
type Wallet = { readonly ecosystem: 'evm' | 'solana'; readonly address: string; readonly imported: boolean; readonly id: string; readonly evm?: Uint8Array; readonly solana?: KeyObject };
type User = { readonly id: string; readonly linked: Json[]; readonly wallets: Wallet[] };
const users = new Map<string, User>(), tokens = new Map<string, string>(), codes = new Set<string>();
const stats = { signatures: 0, imports: 0, creations: 0, exports: 0, logins: 0 };
const signer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const id = (prefix: string) => `${prefix}${randomBytes(12).toString('hex').slice(0, 23)}`;

function accessToken(user: string): string {
  const sid = id('cs'), body = `${b64url({ alg: 'ES256', typ: 'JWT', kid: 'e2e' })}.${b64url({ iss: 'privy.io', aud: appId, sub: user, sid, iat: now(), exp: now() + 3600 })}`;
  const token = `${body}.${sign('sha256', Buffer.from(body), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  tokens.set(token, user);
  return token;
}
function newUser(linked: Json[]): User {
  const user: User = { id: `did:privy:${id('cm')}`, linked, wallets: [] };
  users.set(user.id, user);
  return user;
}
const linkedWallet = (wallet: Wallet): Json => ({ type: 'wallet', id: wallet.id, address: wallet.address, chain_type: wallet.ecosystem === 'evm' ? 'ethereum' : 'solana',
  chain_id: wallet.ecosystem === 'evm' ? 'eip155:1' : 'solana:mainnet', wallet_client: 'privy', wallet_client_type: 'privy', connector_type: 'embedded', imported: wallet.imported,
  delegated: false, wallet_index: 0, recovery_method: 'privy', user_can_sign: true, verified_at: now(), first_verified_at: now(), latest_verified_at: now(),
  ...wallet.ecosystem === 'solana' ? { public_key: wallet.address } : {} });
const apiUser = (user: User) => ({ id: user.id, created_at: 1, has_accepted_terms: false, is_guest: false, mfa_methods: [], linked_accounts: [...user.linked, ...user.wallets.map(linkedWallet)] });
const clientUser = (user: User) => ({ id: user.id, embedded: user.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, imported: wallet.imported })) });
/** The user that already holds this verified identity, else a new one (as Privy finds or creates a user at login). */
function loginUser(match: (account: Json) => boolean, account: Json): User {
  const existing = [...users.values()].find(user => user.linked.some(match));
  if (existing) { const entry = existing.linked.find(match)!; entry.latest_verified_at = now(); return existing; }
  return newUser([{ ...account, verified_at: now(), first_verified_at: now(), latest_verified_at: now() }]);
}
function evmAddress(privateKey: Uint8Array): string {
  return `0x${hex(keccak_256(secp256k1.getPublicKey(privateKey, false).subarray(1)).subarray(12))}`;
}
function solanaKey(seed: Uint8Array): { key: KeyObject; address: string } {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { key, address: base58Encode(spki.subarray(spki.length - 32)) };
}
function newWallet(ecosystem: 'evm' | 'solana', secret?: string): Wallet {
  if (ecosystem === 'evm') {
    const key = secret ? Uint8Array.from(Buffer.from(secret.replace(/^0x/, ''), 'hex')) : secp256k1.utils.randomSecretKey();
    if (key.length !== 32) throw new Error('Invalid private key');
    return { ecosystem, evm: key, address: evmAddress(key), imported: Boolean(secret), id: id('ew') };
  }
  const bytes = secret ? base58Decode(secret) : randomBytes(32);
  if (bytes.length !== 32 && bytes.length !== 64) throw new Error('Invalid private key');
  const { key, address } = solanaKey(bytes.subarray(0, 32));
  if (bytes.length === 64 && base58Encode(bytes.subarray(32)) !== address) throw new Error('Invalid private key');
  return { ecosystem, solana: key, address, imported: Boolean(secret), id: id('sw') };
}
function signEvmTransaction(wallet: Wallet, tx: Json): string {
  const int = (key: string) => BigInt(String(tx[key]));
  const fields = { chainId: BigInt(Number(tx.chainId)), nonce: int('nonce'), maxPriorityFeePerGas: int('maxPriorityFeePerGas'), maxFeePerGas: int('maxFeePerGas'),
    gasLimit: int('gas'), to: String(tx.to), value: int('value'), data: String(tx.data) };
  const signature = secp256k1.Signature.fromBytes(secp256k1.sign(Buffer.from(erc7710.eip1559SigningHash(fields).slice(2), 'hex'), wallet.evm!, { prehash: false, format: 'recovered' }), 'recovered');
  return erc7710.signedEip1559(fields, (signature.recovery ?? 0) as 0 | 1, signature.r, signature.s).raw;
}
function personalSign(wallet: Wallet, message: string): string {
  const bytes = Buffer.from(message, 'utf8'), digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes]));
  const signature = secp256k1.Signature.fromBytes(secp256k1.sign(digest, wallet.evm!, { prehash: false, format: 'recovered' }), 'recovered');
  return `0x${signature.r.toString(16).padStart(64, '0')}${signature.s.toString(16).padStart(64, '0')}${(27 + (signature.recovery ?? 0)).toString(16)}`;
}
/** Signs the message of a Solana wire transaction into the slot of this wallet's key (the fee payer: slot 0). */
function signSolanaTransaction(wallet: Wallet, transaction: string): string {
  const wire = Buffer.from(transaction, 'base64'), count = wire[0]!, message = wire.subarray(1 + 64 * count);
  if (!(count >= 1 && count < 0x80) || base58Encode(message.subarray(message[0]! >= 0x80 ? 5 : 4, message[0]! >= 0x80 ? 37 : 36)) !== wallet.address) throw new Error('Signer is not the fee payer');
  sign(null, message, wallet.solana!).copy(wire, 1);
  return wire.toString('base64');
}

async function body(request: IncomingMessage): Promise<Json> {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 200_000) throw new Error('too large'); }
  try { const value = JSON.parse(text || '{}') as Json; return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
function holder(input: Json): User {
  const user = users.get(tokens.get(String(input.token)) ?? '');
  return user ?? fail('User must be authenticated');
}
const walletOf = (user: User, address: unknown) => user.wallets.find(wallet => wallet.address === address || wallet.address === String(address).toLowerCase())
  ?? fail('Wallet not found for this user');

const client: Readonly<Record<string, (input: Json) => unknown>> = {
  login(input) {
    stats.logins++;
    let user: User;
    if (input.method === 'google') {
      const subject = String(input.subject ?? '');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(subject)) fail('OAuth sign-in failed');
      user = loginUser(account => account.type === 'google_oauth' && account.subject === subject, { type: 'google_oauth', subject, email: `${subject}@gmail.test`, name: subject });
    } else if (input.method === 'email') {
      const email = String(input.email ?? '').toLowerCase();
      if (!codes.has(email) || input.code !== PRIVY_E2E_EMAIL_CODE) fail('Invalid code');
      codes.delete(email);
      user = loginUser(account => account.type === 'email' && account.address === email, { type: 'email', address: email });
    } else if (input.method === 'wallet') {
      const ethereum = input.chain !== 'solana', address = ethereum ? String(input.address ?? '').toLowerCase() : String(input.address ?? '');
      if (ethereum ? !/^0x[0-9a-f]{40}$/.test(address) : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) fail('Wallet sign-in failed');
      user = loginUser(account => account.type === 'wallet' && account.connector_type === 'injected' && String(account.address).toLowerCase() === address.toLowerCase(),
        { type: 'wallet', address: ethereum ? address : address, chain_type: ethereum ? 'ethereum' : 'solana', wallet_client: 'unknown', wallet_client_type: ethereum ? 'metamask' : 'phantom',
          connector_type: 'injected' });
    } else return fail('Unsupported login method');
    return { token: accessToken(user.id), user: clientUser(user) };
  },
  'send-code'(input) {
    const email = String(input.email ?? '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Invalid email');
    codes.add(email);
    return { sent: true };
  },
  user(input) { return clientUser(holder(input)); },
  logout(input) { tokens.delete(String(input.token)); return { done: true }; },
  'wallets/create'(input) {
    const user = holder(input), ecosystem = input.ecosystem === 'solana' ? 'solana' : 'evm';
    if (user.wallets.some(wallet => wallet.ecosystem === ecosystem && !wallet.imported)) fail('User already has an embedded wallet');
    const wallet = newWallet(ecosystem);
    user.wallets.push(wallet); stats.creations++;
    return { address: wallet.address };
  },
  'wallets/import'(input) {
    const user = holder(input), ecosystem = input.ecosystem === 'solana' ? 'solana' : 'evm';
    if (ecosystem === 'evm' && user.wallets.some(wallet => wallet.ecosystem === 'evm' && wallet.imported)) fail('User already has an imported wallet');
    let wallet: Wallet;
    try { wallet = newWallet(ecosystem, String(input.privateKey ?? '')); } catch { return fail('Invalid private key'); }
    if (user.wallets.some(entry => entry.address === wallet.address)) fail('Wallet already imported');
    user.wallets.push(wallet); stats.imports++;
    return { address: wallet.address };
  },
  'wallets/export'(input) { walletOf(holder(input), input.address); stats.exports++; return { done: true }; },
  'sign/evm'(input) { stats.signatures++; return { signature: signEvmTransaction(walletOf(holder(input), input.address), input.tx as Json) }; },
  'sign/evm-message'(input) { stats.signatures++; return { signature: personalSign(walletOf(holder(input), input.address), String(input.message)) }; },
  'sign/solana'(input) { stats.signatures++; return { signedTransaction: signSolanaTransaction(walletOf(holder(input), input.address), String(input.transaction)) }; },
  'sign/solana-message'(input) {
    stats.signatures++;
    return { signature: sign(null, Buffer.from(String(input.message), 'base64'), walletOf(holder(input), input.address).solana!).toString('base64') };
  },
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PRIVY_E2E_PORT}`);
    if (url.pathname === '/health') return reply(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === `/v1/apps/${appId}/jwks.json`) {
      return reply(response, 200, { keys: [{ ...signer.publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'ES256', use: 'sig' }] });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/users/')) {
      const expected = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;
      if (request.headers.authorization !== expected || request.headers['privy-app-id'] !== appId) return reply(response, 401, { error: 'Invalid app credentials' });
      const user = users.get(decodeURIComponent(url.pathname.slice('/v1/users/'.length)));
      return user ? reply(response, 200, apiUser(user)) : reply(response, 404, { error: 'User not found' });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/client/')) {
      const handler = client[url.pathname.slice('/client/'.length)];
      if (!handler) return reply(response, 404, { error: 'Not found' });
      return reply(response, 200, handler(await body(request)));
    }
    if (url.pathname === '/__e2e/stats') return reply(response, 200, stats);
    if (request.method === 'POST' && url.pathname === '/__e2e/users') {
      const input = await body(request);
      return reply(response, 200, { id: newUser(Array.isArray(input.linked) ? input.linked as Json[] : []).id });
    }
    if (request.method === 'POST' && url.pathname === '/__e2e/wallet') {
      // An interrupted creation: the wallet exists at "Privy" but FloFi never saved it (refresh/timeout recovery).
      const input = await body(request), user = users.get(String(input.user)) ?? fail('No such user');
      const wallet = newWallet(input.ecosystem === 'solana' ? 'solana' : 'evm');
      user!.wallets.push(wallet);
      return reply(response, 200, { address: wallet.address });
    }
    if (url.pathname === '/__e2e/user') {
      const user = [...users.values()].find(entry => entry.linked.some(account => account.subject === url.searchParams.get('google') || account.address === url.searchParams.get('email')));
      return reply(response, 200, user ? { id: user.id, wallets: user.wallets.map(wallet => wallet.address), tokens: [...tokens.values()].filter(owner => owner === user.id).length } : null);
    }
    return reply(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    reply(response, status, { error: error instanceof Error ? error.message : 'Error' });
  }
}).listen(PRIVY_E2E_PORT, '127.0.0.1');
