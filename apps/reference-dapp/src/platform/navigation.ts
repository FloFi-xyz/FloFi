// SPDX-License-Identifier: AGPL-3.0-only
export const FLOFI_PRODUCTION_ORIGIN = 'https://flofi.xyz';

/**
 * Strict parsing against a server-configured origin, never a tool argument or request header. Callers additionally allowlist
 * the path and fragment for their particular journey. Self-contained so the MCP App can use the same parser in its sandbox.
 */
export function trustedFlofiUrl(value: unknown, origin: string): URL | null {
  try {
    const base = new URL(origin);
    if (base.origin !== origin || base.username || base.password || !(base.protocol === 'https:'
      || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) return null;
    if (typeof value !== 'string' || value.length > 2_048) return null;
    const url = new URL(value);
    // Refuse URL-parser repairs (whitespace, backslashes, dot segments, encoded hosts, default ports), credentials and redirects.
    return url.href === value && url.origin === origin && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** A nonsecret reference, emitted only after the approval service has created a real approval. It is never an access grant. */
export function publicApprovalUrl(origin: string, approvalId: unknown): string {
  if (typeof approvalId !== 'string' || !/^apr_[a-z2-7]{26}$/.test(approvalId)) throw new Error('APPROVAL_LINK_INVALID');
  const url = trustedFlofiUrl(`${origin}/approve#${approvalId}`, origin);
  if (!url) throw new Error('APPROVAL_LINK_INVALID');
  return url.href;
}
