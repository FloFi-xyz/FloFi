// SPDX-License-Identifier: AGPL-3.0-only
/** Browser-only navigation helpers. Never encode a capability in a provider's URL path or query. */
import { APPROVAL_SECRET_FORMAT } from './approval-link-format.ts';
import { trustedFlofiUrl } from './navigation.ts';

export function walletDeepLinks(url: string, origin: string) {
  const target = trustedFlofiUrl(url, origin);
  if (!target || target.href !== `${origin}/approve${target.hash}` || !APPROVAL_SECRET_FORMAT.test(target.hash.slice(1))) throw new Error('APPROVAL_LINK_INVALID');
  // Phantom's documented browse contract puts the encoded URL in the HTTP path. Open only the public landing page; the owner
  // pastes the full approval link inside the wallet browser. Never send a capability to a third-party redirect server.
  const plain = `${target.origin}${target.pathname}`;
  return { phantom: `https://phantom.com/ul/browse/${encodeURIComponent(plain)}?ref=${encodeURIComponent(origin)}`,
    metamask: `https://metamask.app.link/dapp/${plain.replace(/^https?:\/\//, '')}${target.hash}` };
}
