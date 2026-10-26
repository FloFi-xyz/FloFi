// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-UX-001: language preference identities shared by the server layout (cookie → first paint) and the client LocaleProvider.
 * Kept free of `'use client'` so a Server Component may parse the cookie without crossing the client boundary.
 */
export type Language = 'EN' | 'PT';
export const LANGUAGE_KEY = 'flofi.language';
export const LANGUAGE_COOKIE = 'flofi_language';
export const parseLanguage = (value: string | null | undefined): Language | null => value === 'PT' || value === 'EN' ? value : null;
