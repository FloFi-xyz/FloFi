// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the first-access Privacy & Memory notice on /app. The person's answer (agreed, or "not now") is kept in
 * this first-party cookie so the server renders the same screen the browser keeps (no flash) and the notice does not reappear; a new notice
 * version asks again. Presentation only: the cookie is never authority, and agreeing changes no workflow, approval, signature or funds.
 */
export const PRIVACY_NOTICE_COOKIE = 'flofi_privacy_notice';
export const PRIVACY_NOTICE_VERSION = 1;
export type PrivacyNoticeChoice = 'AGREED' | 'NOT_NOW';
/** An agreement is kept for a year; "not now" for 30 days, then the notice asks once more. */
const MAX_AGE_SECONDS: Readonly<Record<PrivacyNoticeChoice, number>> = Object.freeze({ AGREED: 365 * 24 * 60 * 60, NOT_NOW: 30 * 24 * 60 * 60 });

/** The answer recorded for the current notice version, or null (never answered, an older version, or anything malformed). */
export function parsePrivacyNotice(value: string | null | undefined): PrivacyNoticeChoice | null {
  const match = /^(\d{1,4})\.(AGREED|NOT_NOW)$/.exec(value ?? '');
  return match && Number(match[1]) === PRIVACY_NOTICE_VERSION ? match[2] as PrivacyNoticeChoice : null;
}
/** The `document.cookie` assignment recording an answer: host-only, whole site, Lax; Secure over HTTPS. */
export function privacyNoticeCookie(choice: PrivacyNoticeChoice, secure: boolean): string {
  return `${PRIVACY_NOTICE_COOKIE}=${PRIVACY_NOTICE_VERSION}.${choice}; Path=/; Max-Age=${MAX_AGE_SECONDS[choice]}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
/** The answer in a `document.cookie` string, or null. */
export function privacyNoticeFromCookies(cookies: string): PrivacyNoticeChoice | null {
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === PRIVACY_NOTICE_COOKIE) return parsePrivacyNotice(value.join('='));
  }
  return null;
}
/** The notice is shown on the product workspace under /app only (never on approval, signing or connection pages). */
export const privacyNoticeRoute = (pathname: string | null) => pathname === '/app' || Boolean(pathname?.startsWith('/app/'));
