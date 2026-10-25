// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvalFrameAncestors, embeddedWalletCookie, walletCookieOptions } from './embedded-approval';

describe('MCP signing frame isolation', () => {
  it('allows only the documented host origins and this exact MCP endpoint’s Claude sandbox', () => {
    const hash = createHash('sha256').update('https://flofi.xyz/api/mcp').digest('hex').slice(0, 32);
    expect(approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', VERCEL_ENV: 'production', VERCEL: '1' }).split(' ')).toEqual([
      'https://chatgpt.com', 'https://web-sandbox.oaiusercontent.com', `https://${hash}.claudemcpcontent.com`, 'https://claude.ai',
    ]);
  });
  it('fails closed for missing origins, production lookalikes and malformed origins', () => {
    for (const origin of ['', 'https://flo.finance', 'https://fl0fi.xyz', 'https://flofi.xyz.evil.test', 'http://flofi.xyz', 'https://user@flofi.xyz', 'https://flofi.xyz/'])
      expect(approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: origin, VERCEL: '1', VERCEL_ENV: 'production' })).toBe("'none'");
  });
  it('isolates intentional previews and permits a server-configured loopback fixture only locally', () => {
    const preview = approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: 'https://preview.vercel.app', VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'fix/example' });
    expect(preview).not.toContain('127.0.0.1'); expect(preview).not.toContain('*');
    expect(approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3148' }).split(' ')).toContain('http://127.0.0.1:3148');
    expect(approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3148', VERCEL: '1' })).toBe("'none'");
  });
  it('keeps first-party cookies Strict and partitions embedded HttpOnly Secure cookies on the signing path', () => {
    expect(walletCookieOptions(true, 300)).toEqual({ httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 300 });
    expect(walletCookieOptions(true, 300, true)).toEqual({ httpOnly: true, sameSite: 'none', secure: true, partitioned: true, path: '/mcp/approve', maxAge: 300 });
    expect(walletCookieOptions(true, 0, true)).toMatchObject({ maxAge: 0, partitioned: true, path: '/mcp/approve' });
    expect(() => walletCookieOptions(false, 300, true)).toThrow('EMBEDDED_WALLET_REQUIRES_HTTPS');
    expect(embeddedWalletCookie('flofi_wallet_session')).toBe('embedded_flofi_wallet_session');
  });
});
