// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the transit pages between a conversation and the wallet app: no Review on them, strict CSP, escaped links. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { START_SCRIPT, startPage, statusPage, walletPage } from './pages.ts';

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: transit pages', () => {
  it('opens the wallet by redirect and by one tap, with no script and an escaped URL', () => {
    const page = walletPage('https://phantom.com/ul/v1/connect?a=1&b="<x>', 'Phantom', 'EN');
    expect(page.html).toContain('<meta http-equiv="refresh" content="0;url=https://phantom.com/ul/v1/connect?a=1&amp;b=&quot;&lt;x&gt;">');
    expect(page.html).toContain('Open Phantom'); expect(page.html).not.toMatch(/<script|<form|<iframe/);
    expect(page.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(page.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  });
  it('allows only the start page\'s own fixed script (by hash), which posts the fragment token once', () => {
    const page = startPage('PT'), hash = createHash('sha256').update(START_SCRIPT).digest('base64');
    expect(page.headers['content-security-policy']).toContain(`script-src 'sha256-${hash}'; connect-src 'self'`);
    expect(page.html).toContain(`<script>${START_SCRIPT}</script>`);
    expect(START_SCRIPT).toContain("location.hash.slice(1)"); expect(START_SCRIPT).toContain("history.replaceState");
    expect(START_SCRIPT).toContain("credentials:'omit'");
  });
  it('says where to go next and never shows an amount or a decision', () => {
    const ended = statusPage('ENDED', null, 'EN', { ended: 'You rejected the request in Phantom. Nothing was signed or sent.' });
    expect(ended.html).toContain('You rejected the request in Phantom. Nothing was signed or sent.');
    expect(statusPage('IGNORED', null, 'PT').status).toBe(409);
    expect(statusPage('METADATA', null, 'EN').html).toContain('<title>FloFi</title>');
    const back = statusPage('RETURN', { returnTo: 'CHATGPT', state: 'REVIEW_READY' } as never, 'EN');
    expect(back.html).toContain('href="https://chatgpt.com/"'); expect(back.html).toContain('Your Review is in your conversation');
    expect(statusPage('RETURN', { returnTo: 'TELEGRAM', state: 'SUBMITTED' } as never, 'PT', { telegramBot: 'FloFiBot' }).html).toContain('href="tg://resolve?domain=FloFiBot"');
    for (const kind of ['RETURN', 'IGNORED', 'ENDED', 'REFRESHED'] as const) expect(statusPage(kind, null, 'EN').html).not.toMatch(/SOL|USDC|lamport|<script/);
  });
});
