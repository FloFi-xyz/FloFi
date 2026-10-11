// SPDX-License-Identifier: AGPL-3.0-only
import { ARBITRUM_ONE_TRANSFER } from '@defi-workflow-engine/action-registry';
import type { Rpc } from './public-testnet-service.ts';

/** Phase 2's Nitro policy: estimates include posting gas; receipts cost gasUsed × effectiveGasPrice. */
export const nitroGasLimit = (estimatedGas: bigint) =>
  (estimatedGas * BigInt(ARBITRUM_ONE_TRANSFER.gasLimitMarginPercent) + 99n) / 100n;
export const nitroMaxFeePerGas = (gasPrice: bigint) => gasPrice * BigInt(ARBITRUM_ONE_TRANSFER.maxFeeMultiplier);

/** The existing Router's NodeInterface estimate, shared with sequential liquidity simulation.
 * Approvals may not exist yet, so eth_estimateGas cannot estimate the later mint. Simulation supplies execution gas;
 * gasEstimateL1Component supplies posting gas without executing the target. Neither is an OP Stack l1Fee.
 */
export async function nitroPostingGas(rpc: Rpc, owner: string, call: { to: string; data: string }, at: string, unavailableCode: string): Promise<bigint> {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  const bytes = call.data.slice(2);
  const data = '0x77d488a2' + call.to.slice(2).padStart(64, '0') + word(0n) + word(96n) + word(BigInt(bytes.length / 2)) +
    bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  const raw = await rpc('eth_call', [{ from: owner, to: '0x00000000000000000000000000000000000000c8', value: '0x0', data }, at]);
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{192}$/.test(raw)) throw new Error(unavailableCode);
  const gas = BigInt('0x' + raw.slice(2, 66)), baseFee = BigInt('0x' + raw.slice(66, 130));
  if (gas >= 1n << 64n || baseFee <= 0n) throw new Error(unavailableCode);
  return gas;
}
