// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UX-001: the Send card's "To" field and the Copilot validate a destination through this one network-aware check. It decides only
 * whether typed text is an address of the transfer network's family; the canonical value stays the transfer node's own `recipient`
 * (`CONNECTED_OWNER` or a lower-case address), committed through the existing proposal and bound by Review / Manifest as before.
 * A future address family (e.g. Solana base58) adds one `RECIPIENT_FORMATS` entry keyed by its CAIP-2 namespace; no card changes.
 */
import { isChecksumAddress, transferAllowsRecipients } from '@defi-workflow-engine/action-registry';
import { solanaAddress, solanaKeyOnCurve } from '@defi-workflow-engine/reference-compiler';
import { isSolanaTransferNetwork, transferProfileFor } from './robinhood-transfer-authoring';

export type RecipientFormat = { readonly label: string; readonly placeholder: string; normalize(value: string): string | null };
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const RECIPIENT_FORMATS: Readonly<Record<string, RecipientFormat>> = Object.freeze({
  // EIP-55: a single-case body carries no checksum; a mixed-case address must be its exact checksum encoding (a mistyped letter fails).
  eip155: Object.freeze({ label: 'EVM', placeholder: '0x…', normalize(value: string) {
    if (!EVM_ADDRESS.test(value)) return null;
    const body = value.slice(2);
    return body === body.toLowerCase() || body === body.toUpperCase() || isChecksumAddress(value) ? value.toLowerCase() : null;
  } }),
  // BUILD-SOLANA-TRANSFER-UX-001: a base58 Ed25519 wallet key of exactly 32 bytes (case-sensitive, kept as typed). A program-derived address has
  // no private key and is not offered as a transfer destination.
  solana: Object.freeze({ label: 'Solana', placeholder: 'Solana address', normalize(value: string) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
    try { solanaAddress(value); return solanaKeyOnCurve(value) ? value : null; } catch { return null; }
  } }),
});

/** `OWNER_ONLY`: the network's transfer profile sends only to the connected owner (test-ETH self-transfers). */
export type RecipientPolicy = { readonly kind: 'OWNER_ONLY' } | { readonly kind: 'ADDRESS'; readonly format: RecipientFormat } | { readonly kind: 'UNSUPPORTED' };
export function recipientPolicy(network: string): RecipientPolicy {
  if (isSolanaTransferNetwork(network)) return { kind: 'ADDRESS', format: RECIPIENT_FORMATS.solana! };
  let profile;
  try { profile = transferProfileFor(network); } catch { return { kind: 'UNSUPPORTED' }; }
  if (!transferAllowsRecipients(profile)) return { kind: 'OWNER_ONLY' };
  const format = RECIPIENT_FORMATS[profile.chain.split(':')[0]!];
  return format ? { kind: 'ADDRESS', format } : { kind: 'UNSUPPORTED' };
}

export type RecipientCheck = { readonly ok: true; readonly recipient: 'CONNECTED_OWNER' | string }
  | { readonly ok: false; readonly code: 'TRANSFER_RECIPIENT_REQUIRED' | 'TRANSFER_RECIPIENT_INVALID' | 'TRANSFER_PROFILE_UNSUPPORTED' };
/** The canonical recipient a typed destination authors on `network`, or why it cannot. Surrounding whitespace from a paste is ignored. */
export function checkRecipient(network: string, value: string | null | undefined): RecipientCheck {
  const policy = recipientPolicy(network);
  if (policy.kind === 'UNSUPPORTED') return { ok: false, code: 'TRANSFER_PROFILE_UNSUPPORTED' };
  if (policy.kind === 'OWNER_ONLY') return { ok: true, recipient: 'CONNECTED_OWNER' };
  const text = (value ?? '').trim();
  if (!text) return { ok: false, code: 'TRANSFER_RECIPIENT_REQUIRED' };
  const recipient = policy.format.normalize(text);
  return recipient ? { ok: true, recipient } : { ok: false, code: 'TRANSFER_RECIPIENT_INVALID' };
}
