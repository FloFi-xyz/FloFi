// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FLOFI_PRODUCTION_ORIGIN as origin, publicApprovalUrl, trustedFlofiUrl } from './navigation.ts';
import { walletDeepLinks } from './wallet-links.ts';
import { approvalUrl } from './approvals.ts';
import { publicOrigin } from '../server/deployment.ts';

const id = 'apr_' + 'a'.repeat(26), secret = 'flofi_hs_' + 'x'.repeat(43), valid = `${origin}/approve#${secret}`;
describe('BUILD-MCP-LINK-INTEGRITY-P0 trusted navigation', () => {
  it.each(['https://www.flo.finance', 'https://flo.finance', 'https://flofi.xyz.evil.test', 'https://fl0fi.xyz',
    'https://flofı.xyz', 'https://flofi-xyz.com', 'https://flofi.xyz.', 'http://flofi.xyz', 'https://flofi.xyz:444'])(
    'refuses alternate production origins: %s', candidate => {
    expect(publicOrigin({ VERCEL: '1', VERCEL_ENV: 'production', FLOFI_PUBLIC_ORIGIN: candidate })).toBeNull();
    expect(trustedFlofiUrl(`${candidate}/approve#${secret}`, origin)).toBeNull();
  });
  it.each(['javascript:alert(1)', 'data:text/html,hello', '//flofi.xyz/approve', 'not a URL', 'https://[bad',
    `https://user:password@flofi.xyz/approve#${secret}`, `https://evil.test@flofi.xyz/approve#${secret}`,
    ` https://flofi.xyz/approve#${secret}`, `https://flofi.xyz:443/approve#${secret}`, `https://%66lofi.xyz/approve#${secret}`,
    `https://flofi.xyz/x/../approve#${secret}`, `https://flofi.xyz\\approve#${secret}`, `https://flofi.xyz/appro\nve#${secret}`])(
    'refuses malformed or normalized navigation: %s', candidate => {
    expect(trustedFlofiUrl(candidate, origin)).toBeNull();
    expect(() => walletDeepLinks(candidate, origin)).toThrow('APPROVAL_LINK_INVALID');
  });
  it.each([`/approve?redirect=https://flo.finance#${secret}`, `/approve?#${secret}`, `/oauth/authorize#${secret}`,
    `/approve/#${secret}`, `/approve#invented`, '/approve', `/approve#${id}`, `/approve#${secret}&redirect=https://flo.finance`])(
    'refuses unexpected approval paths, redirects and fabricated capabilities: %s', path => {
    expect(() => walletDeepLinks(origin + path, origin)).toThrow('APPROVAL_LINK_INVALID');
  });
  it('generates canonical references and private capabilities with the existing wallet contracts', () => {
    expect(publicOrigin({ VERCEL: '1', VERCEL_ENV: 'production', FLOFI_PUBLIC_ORIGIN: origin })).toBe(origin);
    expect(publicApprovalUrl(origin, id)).toBe(`${origin}/approve#${id}`);
    expect(approvalUrl(origin, secret)).toBe(valid);
    const links = walletDeepLinks(valid, origin);
    expect(links.metamask).toBe(`https://metamask.app.link/dapp/flofi.xyz/approve#${secret}`);
    expect(links.phantom).toBe('https://phantom.com/ul/browse/https%3A%2F%2Fflofi.xyz%2Fapprove?ref=https%3A%2F%2Fflofi.xyz');
    expect(links.phantom).not.toContain(secret);
    for (const bad of ['invented', `${id}?next=https://flo.finance`, undefined]) expect(() => publicApprovalUrl(origin, bad)).toThrow('APPROVAL_LINK_INVALID');
    expect(() => approvalUrl(origin, 'invented')).toThrow('APPROVAL_LINK_INVALID');
  });
  it('preserves the exact configured preview origin and local loopback, without inferring trust from request hosts', () => {
    const preview = 'https://flofi-git-security-owner.vercel.app';
    expect(publicOrigin({ VERCEL: '1', VERCEL_ENV: 'preview', FLOFI_PUBLIC_ORIGIN: preview })).toBe(preview);
    expect(publicApprovalUrl(preview, id)).toBe(`${preview}/approve#${id}`);
    expect(trustedFlofiUrl(`${origin}/approve#${id}`, preview)).toBeNull();
    expect(publicApprovalUrl('http://[::1]:3100', id)).toBe(`http://[::1]:3100/approve#${id}`);
    expect(publicOrigin({ VERCEL: '1', VERCEL_ENV: 'preview', FLOFI_PUBLIC_ORIGIN: 'http://localhost:3100' })).toBeNull();
    expect(() => publicApprovalUrl('https://flofi.xyz/path', id)).toThrow('APPROVAL_LINK_INVALID');
  });
});
