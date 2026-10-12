// SPDX-License-Identifier: AGPL-3.0-only
import { uniswapCatalogDeployment, uniswapLiquidityProfile } from '@defi-workflow-engine/action-registry';
import type { UniswapLiquidityReview, UniswapLiquidityStep, UniswapReviewCall, UniswapTx } from '../server/uniswap-liquidity-service';

/** The authored/reviewed chain's own deployment; unknown chains never fall back to a testnet. */
export const uniswapLiquidityChainHex = (chain: string | number | undefined) =>
  (uniswapCatalogDeployment(chain) ?? uniswapLiquidityProfile(chain))?.chainHex;

/** A server response cannot widen the envelope the owner reviewed before a wallet request. */
type WalletReview = Pick<UniswapLiquidityReview, 'chainId' | 'owner'> & {
  calls: readonly Pick<UniswapReviewCall, 'step' | 'to' | 'data' | 'gasLimit'>[];
  fees: Pick<UniswapLiquidityReview['fees'], 'maxFeePerGas' | 'maxPriorityFeePerGas'>;
};
export function uniswapLiquidityWalletTransactionMatches(review: WalletReview, step: UniswapLiquidityStep, tx: UniswapTx): boolean {
  const call = review.calls.find(c => c.step === step);
  try {
    return !!call && tx.chainId === uniswapLiquidityChainHex(review.chainId) && tx.from === review.owner && tx.value === '0x0' &&
      tx.to === call.to && tx.data === call.data && BigInt(tx.gas) === BigInt(call.gasLimit) &&
      BigInt(tx.maxFeePerGas) === BigInt(review.fees.maxFeePerGas) && BigInt(tx.maxPriorityFeePerGas) === BigInt(review.fees.maxPriorityFeePerGas);
  } catch { return false; }
}
