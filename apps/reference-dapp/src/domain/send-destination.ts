// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UX-001: the product Copilot box tries the exact chat grammar first. A Send there that names no destination on a recipient-capable network
 * would become a self-send (the grammar's CONNECTED_OWNER default, kept unchanged for Chat, MCP and channels). The box asks instead and
 * completes the same exact sentence with the answered address, so the proposal is the one typing "… to 0x…" in one message produces.
 */
import type { Command } from './commands';
import { checkRecipient, recipientPolicy } from './recipient-address';

export const SEND_DESTINATION_QUESTION = 'Which wallet should I send it to?';
export const SEND_DESTINATION_INVALID = 'That is not a valid address on this network. Paste the full destination wallet address.';
const TYPED = /\bto\s+(0x[0-9a-fA-F]{40})\s*$/i;

export type SendDestinationIssue = { readonly kind: 'MISSING' | 'INVALID'; readonly network: string };
/** Why an exact-grammar Send cannot be proposed as typed (no destination, or one that is not an address of its network), or null. */
export function sendDestinationIssue(command: Command, text: string): SendDestinationIssue | null {
  if (command.type !== 'ADD_RH_TRANSFER' || recipientPolicy(command.input.network).kind !== 'ADDRESS') return null;
  const typed = TYPED.exec(text.trim())?.[1];
  if (!typed) return command.input.recipient === 'CONNECTED_OWNER' ? { kind: 'MISSING', network: command.input.network } : null;
  return checkRecipient(command.input.network, typed).ok ? null : { kind: 'INVALID', network: command.input.network };
}
/** The pending exact Send completed by a typed answer, or null when the answer is not a destination address on that network. */
export function completeSendDestination(request: string, network: string, answer: string): string | null {
  const check = checkRecipient(network, answer);
  return check.ok && check.recipient !== 'CONNECTED_OWNER' ? `${request.trim()} to ${check.recipient}` : null;
}
