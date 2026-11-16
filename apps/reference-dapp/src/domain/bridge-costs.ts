// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident E): what a bridge quote costs, from the provider's own reviewed fee lines — never invented, never
 * double-counted.
 *
 * Relay lists its fees with `included: true` when they are already taken out of the quoted output (its service fee, the destination network fee —
 * on Solana this also covers creating a missing token account), and the source network fee is paid separately in the source chain's native coin.
 * The included total is summed only when EVERY included fee is denominated in the input's own unit (the input token, or the same asset named
 * with the same symbol and decimals on the other chain): then it is an amount of what was sent, and its share of the input is meaningful. Otherwise (fees in another asset, no price to convert with) no total or
 * percentage is claimed and each fee is shown on its own. The FloFi 0.1% workflow fee is a separate obligation recorded at reconciliation; it is
 * not part of these provider fees.
 */
export type BridgeFeeLine = { readonly amount: string; readonly decimals: number; readonly symbol: string; readonly included: boolean; readonly chainId: string; readonly token: string };
export type BridgeIncludedCost = { readonly units: bigint; readonly decimals: number; readonly symbol: string; readonly basisPoints: number };

/** A bridge whose included provider fees take at least this share of the input gets a plain notice before authorization (never a block). */
export const HIGH_BRIDGE_COST_BASIS_POINTS = 500;
const NATIVE = /^(native|0x0{40}|11111111111111111111111111111111)$/i;

export function bridgeIncludedCost(route: {
  readonly inputAmount: string;
  readonly inputToken: { readonly chainId: string; readonly address: string | null; readonly decimals: number; readonly symbol: string };
  readonly fees: readonly BridgeFeeLine[];
}): BridgeIncludedCost | null {
  if (!/^[0-9]{1,78}$/.test(route.inputAmount)) return null;
  const input = BigInt(route.inputAmount);
  const included = route.fees.filter(fee => fee.included && /^[0-9]{1,78}$/.test(fee.amount) && BigInt(fee.amount) > 0n);
  if (input <= 0n || !included.length) return null;
  // The input's own token on the source chain, or the same asset as the provider names it on the other side (same symbol, same decimals — e.g.
  // Relay's destination fee for a USDC → USDC bridge, in USDC on the destination chain). Any other asset makes the total unknown.
  const sameToken = (fee: BridgeFeeLine) => fee.chainId === route.inputToken.chainId && (route.inputToken.address
    ? fee.token.toLowerCase() === route.inputToken.address.toLowerCase() : NATIVE.test(fee.token));
  const inInputToken = (fee: BridgeFeeLine) => fee.decimals === route.inputToken.decimals && (sameToken(fee) || fee.symbol === route.inputToken.symbol);
  if (!included.every(inInputToken)) return null;
  const units = included.reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
  if (units > input) return null;
  return { units, decimals: route.inputToken.decimals, symbol: route.inputToken.symbol, basisPoints: Number(units * 10_000n / input) };
}

/** "14.8%", "0.4%", "<0.1%" — rounded down, so the share is never overstated beyond what was computed. */
export function basisPointsLabel(basisPoints: number): string {
  if (basisPoints < 10) return '<0.1%';
  return `${Math.floor(basisPoints / 10) / 10}%`;
}
