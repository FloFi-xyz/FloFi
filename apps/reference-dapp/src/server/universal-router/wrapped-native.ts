// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the owner's own unwrap of the network's pinned wrapped-native token (WETH → ETH, exactly 1:1) before a Relay
 * order paid in native ETH. The contract and the way it logs a burn are the ones already pinned for each mainnet's swaps
 * (`domain/public-testnet-swap.ts`): canonical WETH9 on Base and Ethereum logs `Withdrawal(src, wad)`; Arbitrum's and Robinhood Chain's
 * aeWETH logs a `Transfer(holder → 0x0)` burn. Read-only and deterministic: nothing here reads a chain, signs or sends.
 */
import { encodeWethWithdraw, toHex } from '@defi-workflow-engine/reference-compiler';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP, ROBINHOOD_MAINNET_SWAP } from '../../domain/public-testnet-swap.ts';

export type WrappedNative = { readonly chain: string; readonly address: string; readonly events: 'WETH9' | 'MINT_BURN' };
const PINS: readonly WrappedNative[] = [BASE_MAINNET_SWAP, ARBITRUM_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP, ROBINHOOD_MAINNET_SWAP]
  .map(profile => ({ chain: profile.chainRef, address: profile.weth.toLowerCase(), events: profile.wethEvents }));
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const fail = (code: string): never => { throw new Error(code); };
const topicAddress = (topic: unknown) => typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic) ? '0x' + topic.slice(26).toLowerCase() : null;

/** The pinned wrapped-native contract of `chain` when `token` is it (a MOCKED run may name its own synthetic pin), else null. */
export function wrappedNativeOf(chain: string, token: string, mocked: readonly WrappedNative[] = []): WrappedNative | null {
  return [...mocked, ...PINS].find(pin => pin.chain === chain && pin.address === token.toLowerCase()) ?? null;
}
/** The owner's exact unwrap call: `withdraw(amount)` on the pinned contract, no value. */
export const unwrapCall = (pin: WrappedNative, amount: string) => ({ purpose: 'UNWRAP' as const, to: pin.address, data: toHex(encodeWethWithdraw(BigInt(amount))), value: '0' });
/**
 * Exactly one burn of exactly `amount` from the owner by the pinned contract, in the dialect it logs, and nothing else from that contract (a
 * successful withdraw pays the same native amount to the caller: WETH9 and aeWETH send exactly `wad` to `msg.sender`).
 */
export function assertUnwrapEffects(pin: WrappedNative, logs: readonly { readonly address?: unknown; readonly topics?: readonly unknown[]; readonly data?: unknown }[], owner: string, amount: string): void {
  const own = logs.filter(log => String(log.address).toLowerCase() === pin.address);
  const burn = (log: (typeof own)[number]) => pin.events === 'WETH9'
    ? log.topics?.[0] === WITHDRAWAL_TOPIC && topicAddress(log.topics?.[1]) === owner
    : log.topics?.[0] === TRANSFER_TOPIC && topicAddress(log.topics?.[1]) === owner && topicAddress(log.topics?.[2]) === '0x' + '0'.repeat(40);
  if (own.length !== 1 || !burn(own[0]!) || typeof own[0]!.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(own[0]!.data) || BigInt(own[0]!.data) !== BigInt(amount))
    fail('UNIVERSAL_UNWRAP_EVENT_MISMATCH');
}
