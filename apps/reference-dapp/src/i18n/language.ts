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
/** The MCP signing surface is embedded in a chat host's frame, where FloFi's preference cookie and storage never reach it: it keeps its earlier
 * default, English, rather than switching every chat user to Portuguese (the decision covered the site, sign-in and /app). */
const EMBEDDED_SURFACES: readonly string[] = ['/mcp/approve']; // = EMBEDDED_APPROVAL_PATH (server/embedded-approval.ts; pinned by locale.test.tsx)
/** The language for a visitor with no saved preference on `pathname` (the proxy's `x-flofi-pathname`). */
export const defaultLanguageFor = (pathname: string | null | undefined): Language => pathname && EMBEDDED_SURFACES.includes(pathname) ? 'EN' : DEFAULT_LANGUAGE;
/** The document language for a preference (the provider keeps the same value after hydration). */
export const documentLanguage = (language: Language) => language === 'PT' ? 'pt' : 'en';
