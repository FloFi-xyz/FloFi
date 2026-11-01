// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: what the code at an owner account says about who can originate its transactions.
 *
 *  - `EOA`: no code. A standard account (MetaMask, Rabby, a Privy embedded wallet) whose key signs ordinary transactions.
 *  - `EIP7702`: the code is exactly an EIP-7702 delegation designator (`0xef0100 ‖ delegate`). The account is still an externally owned
 *    account: its own key signs and it originates ordinary (type-2) transactions; EIP-7702 only adds code that runs when the account is
 *    called or receives ETH. MetaMask "Smart Accounts" are this kind. `verified` says whether the delegate is an implementation FloFi has
 *    reviewed (`VERIFIED_EIP7702_DELEGATES`). An unknown delegate could run arbitrary code when the account receives a swap's ETH (for
 *    example a "sweeper" that forwards it elsewhere), so callers refuse it rather than guess.
 *  - `CONTRACT`: any other code (a Safe or another smart contract wallet). It has no key of its own and cannot originate the transaction
 *    FloFi asks the connected wallet to sign; ERC-4337/ERC-1271 execution is not part of these flows.
 *
 * Classification only: it never grants authority. Every caller still simulates the exact owner transaction at a pinned block.
 */
import { DELEGATION_FRAMEWORK_V1_3 } from './erc7710.js';

export type OwnerAccountCode = { readonly kind: 'EOA' } | { readonly kind: 'EIP7702'; readonly delegate: string; readonly verified: boolean } | { readonly kind: 'CONTRACT' };

/**
 * Delegate implementations FloFi has reviewed for owner accounts that sign FloFi transactions themselves. MetaMask Smart Accounts delegate
 * to the MetaMask Delegation Framework v1.3.0 `EIP7702StatelessDeleGator` (deterministic CREATE2 address on every supported EVM mainnet),
 * whose `receive()` accepts ETH and whose code runs nothing else on a plain incoming transfer. Extend only after reviewing a delegate's code.
 */
export const VERIFIED_EIP7702_DELEGATES: readonly string[] = Object.freeze([DELEGATION_FRAMEWORK_V1_3.eip7702StatelessDeleGator]);

const DESIGNATOR = /^0xef0100([0-9a-f]{40})$/;

/** Classifies `eth_getCode` of an owner account. Anything that is not empty code or an exact designator is a contract (fails closed). */
export function ownerAccountCode(code: unknown): OwnerAccountCode {
  if (code === '0x') return { kind: 'EOA' };
  const value = typeof code === 'string' ? code.toLowerCase() : '';
  const match = DESIGNATOR.exec(value);
  if (!match) return { kind: 'CONTRACT' };
  const delegate = `0x${match[1]!}`;
  // A designator pointing at the zero address clears delegation (the node then reports empty code); seen here, it is malformed.
  if (/^0x0{40}$/.test(delegate)) return { kind: 'CONTRACT' };
  return { kind: 'EIP7702', delegate, verified: VERIFIED_EIP7702_DELEGATES.includes(delegate) };
}
