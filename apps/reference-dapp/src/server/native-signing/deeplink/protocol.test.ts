// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the Phantom/Solflare deeplink wire format, built and opened exactly, and every malformed answer refused. */
import { describe, expect, it } from 'vitest';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { base58DecodeBytes as base58Decode, base58EncodeBytes as base58Encode } from './base58.ts';
import { boxKeyPair, boxNonce, boxSeal, boxSharedKey } from './nacl-box.ts';
import { connectUrl, connectedAccount, openAnswer, signedMessage, signedTransaction, signMessageUrl, signTransactionUrl, type DeeplinkChannel } from './protocol.ts';
import { deeplinkTestWallet } from './test-wallet.test-harness.ts';

const REDIRECT = 'https://flofi.test/api/native-signing/apr_aaaaaaaaaaaaaaaaaaaaaaaaaa/nsg_aaaaaaaaaaaaaaaaaaaaaaaaaa/' + 'A'.repeat(22);
const channel = (): DeeplinkChannel => { const pair = boxKeyPair(); return { dappPublicKey: pair.publicKey, dappSecretKey: pair.secretKey }; };
const paramsOf = (url: string) => new URL(url).searchParams;

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: deeplink protocol', () => {
  it('base58 matches the Solana codec on keys and round-trips transaction-sized payloads', async () => {
    const solana = await import('@defi-workflow-engine/reference-compiler');
    for (const bytes of [new Uint8Array(32).fill(255), Uint8Array.from([0, 0, 1, 2, 3]), boxKeyPair().publicKey]) {
      expect(base58Encode(bytes)).toBe(solana.base58Encode(bytes));
      expect(base58Decode(solana.base58Encode(bytes))).toEqual(bytes);
    }
    const large = new Uint8Array(1_232).map((_, i) => (i * 31 + 7) % 256);
    expect(base58Decode(base58Encode(large))).toEqual(large);
    expect(() => base58Decode('0OIl')).toThrow('BASE58_INVALID');
    expect(() => base58Decode('2'.repeat(4_097))).toThrow('BASE58_INVALID');
  });

  for (const wallet of ['phantom', 'solflare'] as const) it(`${wallet}: connect → signMessage → signTransaction round trip through the wallet's own key`, () => {
    const c = channel(), key = createMockedSolanaWallet(), app = deeplinkTestWallet(wallet, key);
    const connect = connectUrl({ wallet, appUrl: 'https://flofi.test', dappPublicKey: c.dappPublicKey, redirectLink: REDIRECT, cluster: 'mainnet-beta' });
    expect(connect).toMatch(wallet === 'phantom' ? /^https:\/\/phantom\.com\/ul\/v1\/connect\?/ : /^https:\/\/solflare\.com\/ul\/v1\/connect\?/);
    expect(Object.fromEntries(paramsOf(connect))).toEqual({ app_url: 'https://flofi.test', dapp_encryption_public_key: base58Encode(c.dappPublicKey),
      redirect_link: REDIRECT, cluster: 'mainnet-beta' });
    const connected = openAnswer({ wallet, method: 'connect', params: paramsOf(app.approve(connect)), channel: c });
    expect(connected.kind).toBe('ANSWERED');
    const account = connectedAccount(connected as Extract<typeof connected, { kind: 'ANSWERED' }>);
    expect(account.address).toBe(key.owner);
    const session = { walletPublicKey: (connected as { walletPublicKey: Uint8Array }).walletPublicKey, session: account.session };
    const signMessage = signMessageUrl({ wallet, channel: c, walletSession: session, redirectLink: REDIRECT, message: 'flofi.test wants you to sign in' });
    expect(app.read(signMessage)).toMatchObject({ method: 'signMessage', payload: { display: 'utf8', session: account.session } });
    const signed = openAnswer({ wallet, method: 'signMessage', params: paramsOf(app.approve(signMessage)), channel: c, walletPublicKey: session.walletPublicKey });
    expect(signedMessage(signed as Extract<typeof signed, { kind: 'ANSWERED' }>)).toHaveLength(64);
    const unsigned = new Uint8Array(Buffer.from(createUnsigned(key.owner), 'base64'));
    const signTx = signTransactionUrl({ wallet, channel: c, walletSession: session, redirectLink: REDIRECT, transaction: unsigned });
    expect(base58Decode(String(app.read(signTx).payload!.transaction))).toEqual(unsigned);
    const tx = openAnswer({ wallet, method: 'signTransaction', params: paramsOf(app.approve(signTx)), channel: c, walletPublicKey: session.walletPublicKey });
    expect(signedTransaction(tx as Extract<typeof tx, { kind: 'ANSWERED' }>).length).toBe(unsigned.length);
  });

  it('maps documented wallet refusals, never carrying markup or control characters', () => {
    expect(openAnswer({ wallet: 'phantom', method: 'signTransaction', params: new URLSearchParams({ errorCode: '4001', errorMessage: 'User\u0000 rejected' }), channel: channel() }))
      .toEqual({ kind: 'REFUSED', code: 'WALLET_REQUEST_REJECTED', walletCode: 4001, message: 'User  rejected' });
    expect(openAnswer({ wallet: 'solflare', method: 'connect', params: new URLSearchParams({ errorCode: '-32603' }), channel: channel() }))
      .toMatchObject({ code: 'WALLET_INTERNAL_ERROR', walletCode: -32603 });
    expect(openAnswer({ wallet: 'phantom', method: 'connect', params: new URLSearchParams({ errorCode: 'abc' }), channel: channel() })).toMatchObject({ code: 'WALLET_REQUEST_FAILED', walletCode: null });
    expect(() => openAnswer({ wallet: 'phantom', method: 'connect', params: new URLSearchParams({ errorCode: '4001', data: 'x' }), channel: channel() })).toThrow('DEEPLINK_ANSWER_INVALID');
  });

  it('refuses answers sealed for another key, with a changed wallet key, oversized or not JSON', () => {
    const c = channel(), key = createMockedSolanaWallet(), app = deeplinkTestWallet('phantom', key);
    const connect = connectUrl({ wallet: 'phantom', appUrl: 'https://flofi.test', dappPublicKey: c.dappPublicKey, redirectLink: REDIRECT, cluster: 'devnet' });
    // Answered for another dapp key: does not open under this channel.
    expect(() => openAnswer({ wallet: 'phantom', method: 'connect', params: paramsOf(app.approve(connect)), channel: channel() })).toThrow('DEEPLINK_ANSWER_NOT_SEALED_FOR_SESSION');
    const answered = openAnswer({ wallet: 'phantom', method: 'connect', params: paramsOf(app.approve(connect)), channel: c }) as { walletPublicKey: Uint8Array };
    const other = boxKeyPair(), nonce = boxNonce();
    const sealed = (data: string, key = boxSharedKey(c.dappPublicKey, other.secretKey)) => new URLSearchParams({ nonce: base58Encode(nonce), data: base58Encode(boxSeal(new TextEncoder().encode(data), nonce, key)) });
    expect(() => openAnswer({ wallet: 'phantom', method: 'signMessage', params: sealed('{"signature":"1"}'), channel: c, walletPublicKey: answered.walletPublicKey }))
      .toThrow('DEEPLINK_ANSWER_NOT_SEALED_FOR_SESSION');
    const withOtherKey = sealed('{}'); withOtherKey.set('phantom_encryption_public_key', base58Encode(other.publicKey));
    expect(() => openAnswer({ wallet: 'phantom', method: 'signMessage', params: withOtherKey, channel: c, walletPublicKey: answered.walletPublicKey })).toThrow('DEEPLINK_WALLET_KEY_CHANGED');
    const notJson = sealed('not json', boxSharedKey(answered.walletPublicKey, c.dappSecretKey));
    expect(() => openAnswer({ wallet: 'phantom', method: 'signMessage', params: notJson, channel: c, walletPublicKey: answered.walletPublicKey })).toThrow();
    expect(() => openAnswer({ wallet: 'phantom', method: 'signMessage', params: new URLSearchParams({ nonce: '1'.repeat(9_000), data: 'x' }), channel: c,
      walletPublicKey: answered.walletPublicKey })).toThrow('DEEPLINK_ANSWER_INVALID');
    expect(() => openAnswer({ wallet: 'phantom', method: 'signMessage', params: sealed('{}'), channel: c })).toThrow('DEEPLINK_SESSION_REQUIRED');
    expect(() => connectUrl({ wallet: 'phantom', appUrl: 'http://flofi.test', dappPublicKey: c.dappPublicKey, redirectLink: REDIRECT, cluster: 'devnet' })).toThrow('DEEPLINK_APP_URL_INVALID');
    expect(() => connectUrl({ wallet: 'phantom', appUrl: 'https://flofi.test', dappPublicKey: c.dappPublicKey, redirectLink: 'javascript:alert(1)', cluster: 'devnet' }))
      .toThrow('DEEPLINK_REDIRECT_INVALID');
  });
});

/** A minimal legacy-format unsigned transaction (one signature slot) for the round trip; never broadcast. */
function createUnsigned(owner: string): string {
  const ownerKey = base58Decode(owner), programId = new Uint8Array(32), blockhash = new Uint8Array(32).fill(7);
  const message = Buffer.concat([Buffer.from([1, 0, 1, 2]), Buffer.from(ownerKey), Buffer.from(programId), Buffer.from(blockhash), Buffer.from([1, 1, 0, 0])]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}
