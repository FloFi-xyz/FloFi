// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the official encrypted deeplink protocols of Phantom and Solflare (Solana), as FloFi's server speaks
 * them on the owner's behalf from a conversation (ChatGPT, Claude, Telegram) — no SDK, no relay service, no third-party account.
 *
 *   connect           FloFi → wallet: app_url, dapp_encryption_public_key, cluster, redirect_link
 *                     wallet → redirect_link: <wallet>_encryption_public_key, nonce, data = box({ public_key, session })
 *   signMessage       FloFi → wallet: dapp_encryption_public_key, nonce, redirect_link, payload = box({ message, session, display })
 *                     wallet → redirect_link: nonce, data = box({ signature })
 *   signTransaction   FloFi → wallet: dapp_encryption_public_key, nonce, redirect_link, payload = box({ transaction, session })
 *                     wallet → redirect_link: nonce, data = box({ transaction })
 *   any refusal       wallet → redirect_link: errorCode, errorMessage
 *
 * Every binary value is base58; `box` is NaCl crypto_box under the X25519 key shared by FloFi's one-time key and the wallet's. This module only
 * builds the exact URLs and opens the exact answers, refusing anything malformed, oversized or not sealed for this session. What a decrypted
 * answer CLAIMS (an address, a signature, signed bytes) is never trusted here: the caller verifies it cryptographically (a Sign-In With Solana
 * signature, the reviewed transaction's owner signature) before anything depends on it. A connect answer in particular is not authenticated —
 * whoever holds the redirect link can produce one — so it never proves wallet ownership.
 */
import { base58DecodeBytes as base58Decode, base58EncodeBytes as base58Encode } from './base58.ts';
import { boxNonce, boxOpen, boxSeal, boxSharedKey, BOX_KEY_BYTES, BOX_NONCE_BYTES } from './nacl-box.ts';

export type DeeplinkWallet = 'phantom' | 'solflare';
export type DeeplinkCluster = 'mainnet-beta' | 'devnet';
export type DeeplinkMethod = 'connect' | 'signMessage' | 'signTransaction';
/** The wallets FloFi speaks to: each one's universal-link base and the name of its encryption-key answer parameter. */
export const DEEPLINK_WALLETS: Readonly<Record<DeeplinkWallet, { readonly name: string; readonly base: string; readonly keyParam: string }>> = Object.freeze({
  phantom: Object.freeze({ name: 'Phantom', base: 'https://phantom.com/ul/v1', keyParam: 'phantom_encryption_public_key' }),
  solflare: Object.freeze({ name: 'Solflare', base: 'https://solflare.com/ul/v1', keyParam: 'solflare_encryption_public_key' }),
});
export const isDeeplinkWallet = (value: unknown): value is DeeplinkWallet => value === 'phantom' || value === 'solflare';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** Bounds on what FloFi accepts back: a Solana transaction is at most 1,232 bytes; a box adds 16; base58 grows by at most 1.37×. */
const MAX_DATA_CHARS = 4_096, MAX_PARAM_CHARS = 8_192, MAX_ERROR_MESSAGE = 200;
const fail = (code: string): never => { throw new Error(code); };
const bytes58 = (value: unknown, length: number | null, code: string, max = MAX_DATA_CHARS): Uint8Array => {
  if (typeof value !== 'string' || !value || value.length > max || !BASE58.test(value)) return fail(code);
  let out: Uint8Array;
  try { out = base58Decode(value, max); } catch { return fail(code); }
  return length === null || out.length === length ? out : fail(code);
};
const httpsUrl = (value: string, code: string) => {
  let url: URL;
  try { url = new URL(value); } catch { return fail(code); }
  // The exact string the caller gave (an origin stays an origin, without a trailing slash).
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? value : fail(code);
};

/** One-time encrypted channel state FloFi keeps (server-side) between its request and the wallet's answer. */
export type DeeplinkChannel = { readonly dappPublicKey: Uint8Array; readonly dappSecretKey: Uint8Array };
export type WalletSession = { readonly walletPublicKey: Uint8Array; readonly session: string };

/** `connect`: asks the wallet to reveal one account to FloFi for this cluster (no signature, no authority). */
export function connectUrl(input: { readonly wallet: DeeplinkWallet; readonly appUrl: string; readonly dappPublicKey: Uint8Array; readonly redirectLink: string;
  readonly cluster: DeeplinkCluster }): string {
  if (input.dappPublicKey.length !== BOX_KEY_BYTES) fail('DEEPLINK_KEY_INVALID');
  const query = new URLSearchParams({ app_url: httpsUrl(input.appUrl, 'DEEPLINK_APP_URL_INVALID'), dapp_encryption_public_key: base58Encode(input.dappPublicKey),
    redirect_link: httpsUrl(input.redirectLink, 'DEEPLINK_REDIRECT_INVALID'), cluster: input.cluster });
  return `${DEEPLINK_WALLETS[input.wallet].base}/connect?${query.toString()}`;
}
/** An encrypted request (`signMessage`, `signTransaction`) on an established wallet session. */
function sealedUrl(wallet: DeeplinkWallet, method: Exclude<DeeplinkMethod, 'connect'>, channel: DeeplinkChannel, walletSession: WalletSession, redirectLink: string,
  payload: Record<string, string>): string {
  const nonce = boxNonce(), key = boxSharedKey(walletSession.walletPublicKey, channel.dappSecretKey);
  const sealed = boxSeal(new TextEncoder().encode(JSON.stringify({ ...payload, session: walletSession.session })), nonce, key);
  const query = new URLSearchParams({ dapp_encryption_public_key: base58Encode(channel.dappPublicKey), nonce: base58Encode(nonce),
    redirect_link: httpsUrl(redirectLink, 'DEEPLINK_REDIRECT_INVALID'), payload: base58Encode(sealed) });
  return `${DEEPLINK_WALLETS[wallet].base}/${method}?${query.toString()}`;
}
/** `signMessage` of exact UTF-8 text (FloFi's Sign-In With Solana message), shown to the owner as text. */
export function signMessageUrl(input: { readonly wallet: DeeplinkWallet; readonly channel: DeeplinkChannel; readonly walletSession: WalletSession; readonly redirectLink: string;
  readonly message: string }): string {
  return sealedUrl(input.wallet, 'signMessage', input.channel, input.walletSession, input.redirectLink,
    { message: base58Encode(new TextEncoder().encode(input.message)), display: 'utf8' });
}
/** `signTransaction` of FloFi's exact reviewed, unsigned transaction bytes; FloFi verifies and broadcasts the signed bytes itself. */
export function signTransactionUrl(input: { readonly wallet: DeeplinkWallet; readonly channel: DeeplinkChannel; readonly walletSession: WalletSession; readonly redirectLink: string;
  readonly transaction: Uint8Array }): string {
  if (!input.transaction.length || input.transaction.length > 1_232) fail('DEEPLINK_TRANSACTION_INVALID');
  return sealedUrl(input.wallet, 'signTransaction', input.channel, input.walletSession, input.redirectLink, { transaction: base58Encode(input.transaction) });
}

/** What came back to a redirect link: the wallet's refusal, or its sealed answer opened under this channel. */
export type DeeplinkAnswer =
  | { readonly kind: 'REFUSED'; readonly code: string; readonly walletCode: number | null; readonly message: string | null }
  | { readonly kind: 'ANSWERED'; readonly walletPublicKey: Uint8Array; readonly data: Readonly<Record<string, unknown>> };
/** EIP-1193-style codes the wallets document; anything else is reported by number only. */
const REFUSALS: Readonly<Record<string, string>> = Object.freeze({ '4001': 'WALLET_REQUEST_REJECTED', '4100': 'WALLET_UNAUTHORIZED', '4900': 'WALLET_DISCONNECTED',
  '-32000': 'WALLET_INVALID_INPUT', '-32002': 'WALLET_REQUEST_PENDING', '-32003': 'WALLET_TRANSACTION_REJECTED', '-32601': 'WALLET_METHOD_NOT_FOUND',
  '-32603': 'WALLET_INTERNAL_ERROR' });
/**
 * Opens a wallet's answer. `walletPublicKey` is the wallet's encryption key from the session's `connect` (required for later methods; a later
 * answer that names another key is refused); a `connect` answer carries it in `<wallet>_encryption_public_key`.
 */
export function openAnswer(input: { readonly wallet: DeeplinkWallet; readonly method: DeeplinkMethod; readonly params: URLSearchParams; readonly channel: DeeplinkChannel;
  readonly walletPublicKey?: Uint8Array | null }): DeeplinkAnswer {
  const params = input.params, keyParam = DEEPLINK_WALLETS[input.wallet].keyParam;
  for (const [, value] of params) if (value.length > MAX_PARAM_CHARS) fail('DEEPLINK_ANSWER_INVALID');
  const errorCode = params.get('errorCode');
  if (errorCode !== null) {
    if (params.has('data') || params.has('nonce')) fail('DEEPLINK_ANSWER_INVALID');
    const numeric = /^-?[0-9]{1,6}$/.test(errorCode) ? Number(errorCode) : null;
    const message = params.get('errorMessage');
    return { kind: 'REFUSED', code: numeric !== null ? REFUSALS[String(numeric)] ?? 'WALLET_REQUEST_FAILED' : 'WALLET_REQUEST_FAILED', walletCode: numeric,
      // A wallet's own words, bounded and as plain text; shown to nobody but kept for the owner's diagnostics.
      message: message ? message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_ERROR_MESSAGE) : null };
  }
  const answeredKey = params.get(keyParam);
  let walletPublicKey: Uint8Array;
  if (input.method === 'connect') walletPublicKey = bytes58(answeredKey, BOX_KEY_BYTES, 'DEEPLINK_ANSWER_INVALID', 64);
  else {
    if (!input.walletPublicKey || input.walletPublicKey.length !== BOX_KEY_BYTES) return fail('DEEPLINK_SESSION_REQUIRED');
    // A wallet may repeat its key on later answers; it must be the very key of this session's connect.
    if (answeredKey !== null && base58Encode(bytes58(answeredKey, BOX_KEY_BYTES, 'DEEPLINK_ANSWER_INVALID', 64)) !== base58Encode(input.walletPublicKey)) fail('DEEPLINK_WALLET_KEY_CHANGED');
    walletPublicKey = input.walletPublicKey;
  }
  const nonce = bytes58(params.get('nonce'), BOX_NONCE_BYTES, 'DEEPLINK_ANSWER_INVALID', 64), sealed = bytes58(params.get('data'), null, 'DEEPLINK_ANSWER_INVALID');
  let opened: Uint8Array;
  try { opened = boxOpen(sealed, nonce, boxSharedKey(walletPublicKey, input.channel.dappSecretKey)); }
  catch { return fail('DEEPLINK_ANSWER_NOT_SEALED_FOR_SESSION'); }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened)); } catch { return fail('DEEPLINK_ANSWER_INVALID'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('DEEPLINK_ANSWER_INVALID');
  return { kind: 'ANSWERED', walletPublicKey, data: data as Record<string, unknown> };
}
/** The account and session a `connect` answer names (an unauthenticated claim: see the module note). */
export function connectedAccount(answer: Extract<DeeplinkAnswer, { kind: 'ANSWERED' }>): { readonly address: string; readonly session: string } {
  const address = answer.data.public_key, session = answer.data.session;
  bytes58(address, 32, 'DEEPLINK_ACCOUNT_INVALID', 64);
  if (typeof session !== 'string' || !session || session.length > 2_048 || !/^[\x21-\x7e]+$/.test(session)) fail('DEEPLINK_SESSION_INVALID');
  return { address: address as string, session: session as string };
}
/** The 64-byte Ed25519 signature a `signMessage` answer names (verified by the caller against the exact message and account). */
export function signedMessage(answer: Extract<DeeplinkAnswer, { kind: 'ANSWERED' }>): Uint8Array {
  return bytes58(answer.data.signature, 64, 'DEEPLINK_SIGNATURE_INVALID', 128);
}
/** The signed transaction bytes a `signTransaction` answer names (verified by the flow against the reviewed bytes before any broadcast). */
export function signedTransaction(answer: Extract<DeeplinkAnswer, { kind: 'ANSWERED' }>): Uint8Array {
  const out = bytes58(answer.data.transaction, null, 'DEEPLINK_TRANSACTION_INVALID');
  return out.length > 0 && out.length <= 1_232 ? out : fail('DEEPLINK_TRANSACTION_INVALID');
}
