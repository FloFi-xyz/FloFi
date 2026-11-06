// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the prefix of the Editor's approval links, without imports so the `/approve` page can use it in the
 * browser. The server's link scheme (`editor/approval.ts`) is built from this same constant. The page only uses it to word its messages for a
 * workflow the owner started from their own Editor; the prefix authorizes nothing, and the server alone resolves a link.
 */
export const EDITOR_LINK_PREFIX = 'flofi_edhs_';
