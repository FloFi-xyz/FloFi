// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parsePrivacyNotice, privacyNoticeCookie, privacyNoticeFromCookies, privacyNoticeRoute, PRIVACY_NOTICE_VERSION } from './privacy-notice';

describe('Privacy & Memory notice answer', () => {
  it('reads only an answer to the current notice version', () => {
    expect(parsePrivacyNotice(`${PRIVACY_NOTICE_VERSION}.AGREED`)).toBe('AGREED');
    expect(parsePrivacyNotice(`${PRIVACY_NOTICE_VERSION}.NOT_NOW`)).toBe('NOT_NOW');
    for (const value of [undefined, null, '', 'AGREED', `${PRIVACY_NOTICE_VERSION + 1}.AGREED`, `${PRIVACY_NOTICE_VERSION}.YES`, `${PRIVACY_NOTICE_VERSION}.AGREED;x`])
      expect(parsePrivacyNotice(value)).toBeNull();
  });
  it('writes a host-only, whole-site Lax cookie (a year for an agreement, 30 days for not now), Secure over HTTPS', () => {
    expect(privacyNoticeCookie('AGREED', true)).toBe(`flofi_privacy_notice=${PRIVACY_NOTICE_VERSION}.AGREED; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    expect(privacyNoticeCookie('NOT_NOW', false)).toBe(`flofi_privacy_notice=${PRIVACY_NOTICE_VERSION}.NOT_NOW; Path=/; Max-Age=2592000; SameSite=Lax`);
    expect(privacyNoticeFromCookies(`a=1; flofi_privacy_notice=${PRIVACY_NOTICE_VERSION}.NOT_NOW; b=2`)).toBe('NOT_NOW');
    expect(privacyNoticeFromCookies('a=1')).toBeNull();
  });
  it('is shown on /app pages only', () => {
    expect(['/app', '/app/dashboard', '/app/workflows'].every(privacyNoticeRoute)).toBe(true);
    expect(['/approve', '/mcp/approve', '/connections', '/application', null].some(privacyNoticeRoute)).toBe(false);
  });
});
