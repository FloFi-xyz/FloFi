// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-UX-001: language preference identities shared by the server layout (cookie → first paint) and the client LocaleProvider.
 * Kept free of `'use client'` so a Server Component may parse the cookie without crossing the client boundary.
 */
export type Language = 'EN' | 'PT';
export const LANGUAGE_KEY = 'flofi.language';
export const LANGUAGE_COOKIE = 'flofi_language';
export const parseLanguage = (value: string | null | undefined): Language | null => value === 'PT' || value === 'EN' ? value : null;
/** Owner decision (BUILD-FLOFI-SITE-001): a visitor with no saved preference gets Portuguese on the site, sign-in and /app. A saved preference
 * (the cookie above, or the storage key the provider restores) always wins, so existing English and Portuguese choices are unchanged. */
export const DEFAULT_LANGUAGE: Language = 'PT';
/**
 * Surfaces outside that decision keep their earlier English default:
 * - the MCP signing surface, embedded in a chat host's frame where FloFi's preference cookie and storage never reach it (switching it would put
 *   every chat user in Portuguese with no way to keep English): EMBEDDED_APPROVAL_PATH in server/embedded-approval.ts, pinned by locale.test.tsx;
 * - FloFi Wallet, on its own host, which never sees the product's preference and has its own language switch;
 * - the admin console, written in English only.
 */
const ENGLISH_DEFAULT = (pathname: string) => pathname === '/mcp/approve' || pathname === '/wallet' || pathname.startsWith('/wallet/')
  || pathname === '/admin' || pathname.startsWith('/admin/');
/** The language for a visitor with no saved preference on `pathname` (the proxy's `x-flofi-pathname`). */
export const defaultLanguageFor = (pathname: string | null | undefined): Language => pathname && ENGLISH_DEFAULT(pathname) ? 'EN' : DEFAULT_LANGUAGE;
/** The document language for a preference: Brazilian Portuguese or English (the provider keeps the same value after hydration). */
export const documentLanguage = (language: Language) => language === 'PT' ? 'pt-BR' : 'en';
