// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvalFrameAncestorList, approvalFrameAncestors, claudeAppDomain, configuredFrameAncestors, embeddedWalletCookie, walletCookieOptions } from './embedded-approval';

describe('MCP signing frame isolation', () => {
  it('allows only the documented host origins and this exact MCP endpoint’s Claude sandbox', () => {
    const hash = createHash('sha256').update('https://flofi.xyz/api/mcp').digest('hex').slice(0, 32);
    const slash = createHash('sha256').update('https://flofi.xyz/api/mcp/').digest('hex').slice(0, 32);
    // BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: Claude hashes the exact configured connector URL, so the trailing-slash form is its own host.
    expect(approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', VERCEL_ENV: 'production', VERCEL: '1' }).split(' ')).toEqual([
      'https://chatgpt.com', 'https://web-sandbox.oaiusercontent.com', `https://${hash}.claudemcpcontent.com`, `https://${slash}.claudemcpcontent.com`, 'https://claude.ai',
    ]);
    // Claude's documented example and the value its research computed for FloFi's connector URL.
    expect(claudeAppDomain('https://example.com/mcp')).toMatch(/^c3d80a4e[0-9a-f]{24}\.claudemcpcontent\.com$/);
    expect(claudeAppDomain('https://flofi.xyz/api/mcp')).toBe('57290993f7dd5cabb0ea146de14615bd.claudemcpcontent.com');
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
  it('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: adds only exact operator-observed sandbox origins of the two hosts, never a pattern', () => {
    const env = { FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', VERCEL_ENV: 'production', VERCEL: '1', FLOFI_MCP_FRAME_ANCESTORS: [
      'https://flofi-xyz.oaiusercontent.com', ' https://abc123.web-sandbox.oaiusercontent.com ', 'https://0123456789abcdef.claudemcpcontent.com',
      'https://*.oaiusercontent.com', 'https://evil.test', 'http://flofi-xyz.oaiusercontent.com', 'https://a.oaiusercontent.com/path', 'https://a.oaiusercontent.com:444',
      'https://user@a.oaiusercontent.com', 'https://oaiusercontent.com', 'https://a.oaiusercontent.com.evil.test', "'unsafe-inline'", '*',
      'https://files.oaiusercontent.com', 'https://A.oaiusercontent.com', 'https://a.oaiusercontent.com;script-src', 'https://evil-oaiusercontent.com'].join(',') };
    expect(configuredFrameAncestors(env)).toEqual(['https://flofi-xyz.oaiusercontent.com', 'https://abc123.web-sandbox.oaiusercontent.com',
      'https://0123456789abcdef.claudemcpcontent.com']);
    const list = approvalFrameAncestorList(env);
    expect(list.slice(0, 5)).toEqual(approvalFrameAncestors({ FLOFI_PUBLIC_ORIGIN: 'https://flofi.xyz', VERCEL_ENV: 'production', VERCEL: '1' }).split(' '));
    expect(approvalFrameAncestors(env).split(' ')).toEqual(list);
    expect(approvalFrameAncestors(env)).not.toContain('*');
    // Without a valid public origin nothing may frame the page, whatever is configured.
    expect(approvalFrameAncestors({ ...env, FLOFI_PUBLIC_ORIGIN: 'https://fl0fi.xyz' })).toBe("'none'");
    expect(approvalFrameAncestorList({ ...env, FLOFI_PUBLIC_ORIGIN: '' })).toEqual([]);
  });
  it('keeps first-party cookies Strict and partitions host-prefixed embedded HttpOnly Secure cookies', () => {
    expect(walletCookieOptions(true, 300)).toEqual({ httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 300 });
    expect(walletCookieOptions(true, 300, true)).toEqual({ httpOnly: true, sameSite: 'none', secure: true, partitioned: true, path: '/', maxAge: 300 });
    expect(walletCookieOptions(true, 0, true)).toMatchObject({ maxAge: 0, partitioned: true, path: '/' });
    expect(() => walletCookieOptions(false, 300, true)).toThrow('EMBEDDED_WALLET_REQUIRES_HTTPS');
    expect(embeddedWalletCookie('flofi_wallet_session')).toBe('__Host-embedded_flofi_wallet_session');
  });
});
