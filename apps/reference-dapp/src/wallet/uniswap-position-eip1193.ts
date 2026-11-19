// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the exact wallet envelope of a Uniswap v3 position-management request (collect, partial withdrawal,
 * exit, explicit close). A position run has ONE wallet request: the NonfungiblePositionManager call the owner reviewed. A server response
 * can never widen it: the transaction handed to `eth_sendTransaction` must name the reviewed network, the reviewed owner as sender, no value,
 * the reviewed Position Manager, the reviewed call data byte for byte, and exactly the reviewed gas limit and fee caps.
 */
import type { UniswapPositionReview } from '../server/uniswap-position-service';
import type { UniswapTx } from '../server/uniswap-liquidity-service';
import { uniswapLiquidityChainHex } from './uniswap-liquidity-eip1193';

type WalletReview = Pick<UniswapPositionReview, 'chainId' | 'owner' | 'operation'> & {
  readonly contracts: Pick<UniswapPositionReview['contracts'], 'positionManager'>;
  readonly calls: readonly Pick<UniswapPositionReview['calls'][number], 'step' | 'to' | 'data' | 'gasLimit'>[];
  readonly fees: Pick<UniswapPositionReview['fees'], 'maxFeePerGas' | 'maxPriorityFeePerGas'>;
};
const HEX = /^0x[0-9a-f]*$/;
/** True only when `tx` is exactly the reviewed position request (lowercase hex, as the service prepares it). */
export function uniswapPositionWalletTransactionMatches(review: WalletReview, tx: UniswapTx): boolean {
  try {
    const call = review.calls.length === 1 ? review.calls[0] : undefined;
    const chainHex = uniswapLiquidityChainHex(review.chainId);
    return !!call && !!chainHex && call.step === review.operation && call.to === review.contracts.positionManager &&
      tx.chainId === chainHex && tx.from === review.owner && tx.value === '0x0' && tx.to === call.to && HEX.test(tx.data) && tx.data === call.data &&
      BigInt(tx.gas) === BigInt(call.gasLimit) && BigInt(tx.maxFeePerGas) === BigInt(review.fees.maxFeePerGas) &&
      BigInt(tx.maxPriorityFeePerGas) === BigInt(review.fees.maxPriorityFeePerGas) &&
      Object.keys(tx).every(key => ['nonce', 'chainId', 'from', 'to', 'data', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas'].includes(key));
  } catch { return false; }
}
