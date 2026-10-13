// SPDX-License-Identifier: AGPL-3.0-only
import type { JupiterRecord } from '../server/jupiter-service';
import type { SolanaCompositionView } from '../server/solana-composition-service';
import type { CopilotVerified } from './copilot-conversation';
import { ORCA_WHIRLPOOLS_DEVNET } from '@defi-workflow-engine/action-registry';
import { formatTokenAmount } from './jupiter-authoring';

type SwapRecord = JupiterRecord | null;
type CompositionView = SolanaCompositionView | null;
/**
 * PR B: swap output that a reconciled execution left in the wallet — a reconciled Solana Devnet swap's output, or the part of a composition's
 * reconciled swap output its position did not deposit (all of it when the run ended after the swap). Nothing else counts as "remaining tokens".
 */
export function reconciledRemaining(owner: string | null, swap: SwapRecord, composition: CompositionView): CopilotVerified['remaining'] {
  if (!owner) return [];
  // Recovery records may belong to a wallet that is no longer connected.
  if (composition && composition.record.review.owner !== owner) composition = null;
  if (swap && swap.review.owner !== owner) swap = null;
  const symbol = (token: 0 | 1) => token === 0 ? 'SOL' as const : 'devUSDC' as const, decimals = (token: 0 | 1) => token === 0 ? 9 : 6;
  const binding = composition?.record.binding;
  if (composition && binding && (composition.phase === 'COMPLETED' || composition.phase === 'PARTIAL')) {
    const effects = composition.phase === 'COMPLETED' ? composition.liquidity?.observations.at(-1)?.effects : null;
    if (composition.swap.observations.at(-1)?.verdict !== 'RECONCILED' ||
      (composition.phase === 'COMPLETED' && composition.liquidity?.observations.at(-1)?.verdict !== 'RECONCILED') ||
      (composition.phase === 'COMPLETED' && !effects)) return [];
    const left = BigInt(binding.received) - (effects ? BigInt(binding.token === 0 ? effects.depositedA : effects.depositedB) : 0n);
    return left > 0n ? [{ token: symbol(binding.token), amount: formatTokenAmount(left.toString(), decimals(binding.token)) }] : [];
  }
  // A swap attached to an unfinished composition is reserved for that composition.
  if (composition && swap?.id === composition.swap.id) return [];
  const observed = swap?.evidence ? swap.observations.at(-1) : null;
  const output = swap?.review.output.symbol.toUpperCase();
  if (!swap || swap.review.chain !== ORCA_WHIRLPOOLS_DEVNET.chain || observed?.verdict !== 'RECONCILED' || !observed.outputReceived || (output !== 'SOL' && output !== 'DEVUSDC')) return [];
  return BigInt(observed.outputReceived) > 0n ? [{ token: output === 'SOL' ? 'SOL' : 'devUSDC', amount: formatTokenAmount(observed.outputReceived, swap.review.output.decimals) }] : [];
}
