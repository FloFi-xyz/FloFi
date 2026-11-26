// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the "Sign with Phantom / Solflare" buttons under a conversation's approval message. Each opens FloFi's native
 * signing start for THIS conversation's approval with that wallet; the token travels only in the URL fragment (no server log or wallet ever sees it,
 * as for the approval link) and is MACed with the channel's own key. It authorizes nothing: the session it starts still needs the wallet's own
 * Sign-In With Solana proof, the requester's claim rule, a fresh simulation, the Review in this conversation, its confirmation here and the
 * owner's approval in the wallet. Channel code never runs any of those steps.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { NATIVE_SIGNING_WALLETS, type NativeSigningWallet } from '../../platform/native-signing.ts';
import type { ChannelKeys } from './crypto.ts';
import type { ChannelLanguage } from './config.ts';

export type NativeStart = { readonly handoffId: string; readonly conversationId: string; readonly wallet: NativeSigningWallet; readonly expiresAt: Date };
type Body = { readonly h: string; readonly c: string; readonly w: string; readonly e: number };
const keyOf = (keys: ChannelKeys) => Buffer.from(hkdfSync('sha256', keys.approval, 'flofi', 'flofi/channels/native-start/v1', 32));
const mac = (keys: ChannelKeys, body: string) => createHmac('sha256', keyOf(keys)).update(`ns1.${body}`).digest();
const HANDOFF = /^apr_[a-z2-7]{26}$/, CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;

export function nativeStartToken(keys: ChannelKeys, start: NativeStart): string {
  const body = Buffer.from(JSON.stringify({ h: start.handoffId, c: start.conversationId, w: start.wallet, e: Math.floor(start.expiresAt.getTime() / 1000) } satisfies Body)).toString('base64url');
  return `ns1.${body}.${mac(keys, body).toString('base64url')}`;
}
/** The start a token names, or null (another key, tampered, malformed, unknown wallet or expired). */
export function readNativeStartToken(keys: ChannelKeys, token: unknown, now: Date): NativeStart | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [prefix, body, tag, ...rest] = token.split('.');
  if (prefix !== 'ns1' || !body || !tag || rest.length) return null;
  const expected = mac(keys, body), given = Buffer.from(tag, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let value: Body;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Body; } catch { return null; }
  if (!value || !HANDOFF.test(value.h) || !CONVERSATION.test(value.c) || !(NATIVE_SIGNING_WALLETS as readonly string[]).includes(value.w)
    || !Number.isSafeInteger(value.e) || value.e * 1000 <= now.getTime()) return null;
  return { handoffId: value.h, conversationId: value.c, wallet: value.w as NativeSigningWallet, expiresAt: new Date(value.e * 1000) };
}
const LABELS: Readonly<Record<ChannelLanguage, Readonly<Record<NativeSigningWallet, string>>>> = Object.freeze({
  EN: { phantom: 'Sign with Phantom', solflare: 'Sign with Solflare' }, PT: { phantom: 'Assinar com Phantom', solflare: 'Assinar com Solflare' } });
/** One button per supported wallet for this conversation's approval. */
export function nativeStartLinks(origin: string, keys: ChannelKeys, input: Omit<NativeStart, 'wallet'>, language: ChannelLanguage): { readonly label: string; readonly url: string }[] {
  return NATIVE_SIGNING_WALLETS.map(wallet => ({ label: LABELS[language][wallet], url: `${origin}/api/native-signing/start#${nativeStartToken(keys, { ...input, wallet })}` }));
}
