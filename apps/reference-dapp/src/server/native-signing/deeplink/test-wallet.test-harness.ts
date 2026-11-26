// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001 test double: a Phantom/Solflare app that answers FloFi's deeplinks exactly as the documented protocol
 * does (its own X25519 key, NaCl box answers, base58 everywhere, errorCode refusals) and signs with a MOCKED in-memory Solana key. It never
 * contacts a network; it only turns a deeplink URL into the redirect URL the wallet would open.
 */
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { base58DecodeBytes as base58Decode, base58EncodeBytes as base58Encode } from './base58.ts';
import { boxKeyPair, boxNonce, boxOpen, boxSeal, boxSharedKey } from './nacl-box.ts';
import { DEEPLINK_WALLETS, type DeeplinkWallet } from './protocol.ts';

type SolanaKey = ReturnType<typeof createMockedSolanaWallet>;
export type WalletRequest = { readonly method: string; readonly params: URLSearchParams; readonly payload: Record<string, unknown> | null; readonly redirect: string };

export function deeplinkTestWallet(wallet: DeeplinkWallet, key: SolanaKey = createMockedSolanaWallet()) {
  const pair = boxKeyPair(), session = base58Encode(new TextEncoder().encode(`session:${key.owner}:${Date.now()}`));
  const shared = (dapp: string) => boxSharedKey(base58Decode(dapp), pair.secretKey);
  const answer = (redirect: string, dapp: string, data: Record<string, unknown>, withKey: boolean) => {
    const nonce = boxNonce(), sealed = boxSeal(new TextEncoder().encode(JSON.stringify(data)), nonce, shared(dapp));
    const query = new URLSearchParams({ ...withKey ? { [DEEPLINK_WALLETS[wallet].keyParam]: base58Encode(pair.publicKey) } : {},
      nonce: base58Encode(nonce), data: base58Encode(sealed) });
    return `${redirect}${redirect.includes('?') ? '&' : '?'}${query.toString()}`;
  };
  /** What a deeplink asks this wallet (its encrypted payload opened with the wallet's own key). */
  function read(url: string): WalletRequest {
    const base = DEEPLINK_WALLETS[wallet].base;
    if (!url.startsWith(`${base}/`)) throw new Error('NOT_THIS_WALLET');
    const parsed = new URL(url), method = parsed.pathname.split('/').pop()!, params = parsed.searchParams;
    const payload = params.get('payload') ? JSON.parse(new TextDecoder().decode(boxOpen(base58Decode(params.get('payload')!), base58Decode(params.get('nonce')!),
      shared(params.get('dapp_encryption_public_key')!)))) as Record<string, unknown> : null;
    if (payload && payload.session !== session) throw new Error('SESSION_MISMATCH');
    return { method, params, payload, redirect: params.get('redirect_link')! };
  }
  return {
    owner: key.owner, key,
    read,
    /** The owner approves: the redirect URL carrying the wallet's sealed answer. `sign` may alter the bytes before signing (adversarial tests). */
    approve(url: string, options: { readonly alter?: (unsignedBase64: string) => string; readonly signer?: SolanaKey } = {}): string {
      const request = read(url), dapp = request.params.get('dapp_encryption_public_key')!;
      if (request.method === 'connect') return answer(request.redirect, dapp, { public_key: key.owner, session }, true);
      if (request.method === 'signMessage') {
        const message = base58Decode(String(request.payload!.message));
        return answer(request.redirect, dapp, { signature: base58Encode((options.signer ?? key).signMessage(message)) }, false);
      }
      if (request.method === 'signTransaction') {
        const unsigned = Buffer.from(base58Decode(String(request.payload!.transaction))).toString('base64');
        const signed = (options.signer ?? key).sign(options.alter ? options.alter(unsigned) : unsigned);
        return answer(request.redirect, dapp, { transaction: base58Encode(new Uint8Array(Buffer.from(signed, 'base64'))) }, false);
      }
      throw new Error(`UNSUPPORTED_${request.method}`);
    },
    /** The owner rejects in the wallet (EIP-1193 4001), as the wallets document it. */
    reject(url: string): string {
      const request = read(url);
      return `${request.redirect}?${new URLSearchParams({ errorCode: '4001', errorMessage: 'User rejected the request.' }).toString()}`;
    },
  };
}
/** The parts of a FloFi native callback URL (`/api/native-signing/<approval>/<session>/<tag>?…`). */
export function callbackParts(url: string): { readonly handoffId: string; readonly sessionId: string; readonly tag: string; readonly params: URLSearchParams } {
  const parsed = new URL(url), [, , , handoffId, sessionId, tag] = parsed.pathname.split('/');
  return { handoffId: handoffId!, sessionId: sessionId!, tag: tag!, params: parsed.searchParams };
}
