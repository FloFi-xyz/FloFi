// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: whose memory a request may touch. A learning principal is always established by the server:
 *
 *   WALLET   a wallet proven in this browser (the sealed SIWE / SIWS session cookie, `server/session-principal.ts`). EVM and Solana are separate
 *            principals; holding both sessions in one browser is not an account link, so their memories never merge.
 *   CHANNEL  a channel sender as its provider authenticated it (webhook secret / signature), already reduced by Channel Core to a keyed digest of
 *            (channel, business, sender). A Telegram sender is never a wallet, and never a WhatsApp number.
 *
 * Neither the browser nor a message can name a principal: an address in a request is never trusted. The stored subject is an HMAC of the
 * principal under the learning key, so the database alone cannot tell which wallet or sender a memory belongs to.
 */
import { createHmac } from 'node:crypto';
import type { LearningKeys } from './config.ts';

export type LearningPrincipal = { readonly kind: 'WALLET'; readonly namespace: 'eip155' | 'solana'; readonly account: string }
  | { readonly kind: 'CHANNEL'; readonly channel: string; readonly business: string; readonly sender: Buffer };
const EVM = /^0x[0-9a-f]{40}$/, SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, CHANNEL = /^[A-Z][A-Z0-9_]{1,31}$/, BUSINESS = /^[A-Za-z0-9_.:-]{1,64}$/;

export function validPrincipal(principal: LearningPrincipal): boolean {
  if (principal.kind === 'WALLET') return principal.namespace === 'eip155' ? EVM.test(principal.account) : principal.namespace === 'solana' && SOLANA.test(principal.account);
  return CHANNEL.test(principal.channel) && BUSINESS.test(principal.business) && principal.sender.length === 32;
}
/** The keyed, non-reversible subject digest of a verified principal. */
export function subjectDigest(keys: LearningKeys, principal: LearningPrincipal): Buffer {
  if (!validPrincipal(principal)) throw new Error('LEARNING_PRINCIPAL_INVALID');
  const label = principal.kind === 'WALLET' ? `wallet:${principal.namespace}:${principal.account}`
    : `channel:${principal.channel}:${principal.business}:${principal.sender.toString('hex')}`;
  return createHmac('sha256', keys.subject).update(label, 'utf8').digest();
}
/** The contributor digest of a subject (separate key): links contributions to nothing without the learning secret. */
export const contributorDigest = (keys: LearningKeys, subjectId: string): Buffer => createHmac('sha256', keys.contributor).update(`contributor:${subjectId}`, 'utf8').digest();
/** How FloFi names whose memory an offer is about, without showing a full address. */
export function ownerLabel(principal: LearningPrincipal, language: 'EN' | 'PT'): string {
  if (principal.kind === 'CHANNEL') {
    const channel = principal.channel === 'TELEGRAM' ? 'Telegram' : principal.channel === 'WHATSAPP' ? 'WhatsApp' : principal.channel;
    return language === 'PT' ? `esta conta do ${channel}` : `this ${channel} account`;
  }
  const short = `${principal.account.slice(0, 6)}…${principal.account.slice(-4)}`;
  return language === 'PT' ? `sua carteira ${short}` : `your wallet ${short}`;
}
