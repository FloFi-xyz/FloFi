// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the conversation's "Sign with …" buttons: a channel-keyed token in the URL fragment that is never stored with
 * the message, exact link shapes at the output guard, and Telegram's keyboard row under the approval link.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channelKeys, open, sealContext } from './crypto.ts';
import { nativeConfirmLink, outputSafe, safeWalletLinks, sealReply } from './delivery.ts';
import { nativeStartLinks, nativeStartToken, readNativeStartToken } from './native-start.ts';
import { renderSendMessage } from '../telegram/render.ts';

const keys = channelKeys(randomBytes(32).toString('hex')), other = channelKeys(randomBytes(32).toString('hex'));
const ORIGIN = 'https://flofi.test', H = 'apr_' + 'a'.repeat(26), C = 'chc_' + 'b'.repeat(26);
const later = new Date(Date.now() + 600_000);

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native start buttons', () => {
  it('round-trips the conversation, approval and wallet; refuses another key, tampering, an unknown wallet and expiry', () => {
    const token = nativeStartToken(keys, { handoffId: H, conversationId: C, wallet: 'phantom', expiresAt: later });
    expect(readNativeStartToken(keys, token, new Date())).toEqual({ handoffId: H, conversationId: C, wallet: 'phantom', expiresAt: new Date(Math.floor(later.getTime() / 1000) * 1000) });
    expect(readNativeStartToken(other, token, new Date())).toBeNull();
    const [prefix, body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), w: 'metamask' })).toString('base64url');
    expect(readNativeStartToken(keys, `${prefix}.${forged}.${mac}`, new Date())).toBeNull();
    expect(readNativeStartToken(keys, token, new Date(later.getTime() + 1_000))).toBeNull();
    expect(readNativeStartToken(keys, 'ns1.x.y', new Date())).toBeNull();
  });
  it('keeps the token in the fragment, never stores the buttons, and lets only exact native links through the output guard', () => {
    const links = nativeStartLinks(ORIGIN, keys, { handoffId: H, conversationId: C, expiresAt: later }, 'PT');
    expect(links.map(l => l.label)).toEqual(['Assinar com Phantom', 'Assinar com Solflare']);
    for (const link of links) expect(new URL(link.url)).toMatchObject({ origin: ORIGIN, pathname: '/api/native-signing/start', search: '' });
    const reply = { text: 'ok', choices: [], link: null, walletLinks: links };
    expect(outputSafe(reply, ORIGIN)).toBe(true);
    expect(outputSafe({ ...reply, walletLinks: [{ label: 'x', url: 'https://evil.test/api/native-signing/start#ns1.a' }] }, ORIGIN)).toBe(false);
    // Delivery drops a malformed button and keeps the good ones (the approval message itself is never failed by a button).
    expect(safeWalletLinks([links[0]!, { label: 'x', url: 'https://evil.test/api/native-signing/start#ns1.a' }, { label: 'y', url: `${ORIGIN}/approve` }], ORIGIN)).toEqual([links[0]]);
    const sealed = sealReply({ tenantId: 't', keys }, 'cho_1', reply, ORIGIN);
    expect(open(keys.seal, sealed, sealContext('t', 'channel_outbox', 'cho_1', 'body'))).not.toMatch(/ns1\.|native-signing/);
    // A Review's confirmation link has one exact shape (kept sealed with its notification); anything else is not a native link.
    const confirm = `${ORIGIN}/api/native-signing/${H}/nsg_${'c'.repeat(26)}/confirm/${'D'.repeat(22)}`;
    expect(nativeConfirmLink(confirm, ORIGIN)).toBe(true);
    expect(outputSafe({ text: 'ok', choices: [], link: { label: 'Confirm', url: confirm } }, ORIGIN)).toBe(true);
    for (const bad of [`${confirm}x`, confirm.replace('/confirm/', '/open/'), confirm.replace(ORIGIN, 'https://evil.test')]) expect(nativeConfirmLink(bad, ORIGIN)).toBe(false);
    expect(open(keys.seal, sealReply({ tenantId: 't', keys }, 'cho_2', { text: 'ok', choices: [], link: { label: 'Confirm', url: confirm } }, ORIGIN),
      sealContext('t', 'channel_outbox', 'cho_2', 'body'))).toContain(confirm);
  });
  it('puts the wallet buttons in one Telegram row under the approval link, before the one-tap actions', () => {
    const links = nativeStartLinks(ORIGIN, keys, { handoffId: H, conversationId: C, expiresAt: later }, 'EN');
    const message = renderSendMessage({ kind: 'TELEGRAM_CHAT', value: '1' } as never, { text: 'Strategy ready', link: { label: 'Authorize', url: `${ORIGIN}/approve#flofi_chs_x` },
      choices: [{ id: 'act:status', label: 'Status' }, { id: 'act:cancel', label: 'Cancel' }], walletLinks: links });
    expect((message.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard).toEqual([[{ text: 'Authorize', url: `${ORIGIN}/approve#flofi_chs_x` }],
      [{ text: 'Sign with Phantom', url: links[0]!.url }, { text: 'Sign with Solflare', url: links[1]!.url }],
      [{ text: 'Status', callback_data: 'act:status' }, { text: 'Cancel', callback_data: 'act:cancel' }]]);
  });
});
