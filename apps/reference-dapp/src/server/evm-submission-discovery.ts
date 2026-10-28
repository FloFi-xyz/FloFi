// SPDX-License-Identifier: AGPL-3.0-only
/** Read-only nonce discovery shared by EVM execution engines. Absence from one node is never proof of non-submission. */
import type { Rpc } from './public-testnet-service.ts';

type Attempt = { nonce: string; preparedAtBlock: number; tx: { from: string } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw Error('EVM_OBSERVATION_RPC_INVALID');
  return BigInt(v);
};
const tag = (n: number) => '0x' + n.toString(16);
export const legacyUnprovenApproval = (a: { state: string; step: string; note: string | null; transactionHash: string | null }) =>
  a.state === 'NOT_FOUND' && a.step.includes('APPROV') && /^(UNIVERSAL|ROUTER|UNISWAP)_SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(a.note ?? '');

export async function discoverEvmNonce(rpc: Rpc, attempt: Attempt): Promise<
  { consumed: true; tx: Record<string, unknown> } | { consumed: false; pendingTx: Record<string, unknown> | null; visibility: 'AVAILABLE' | 'UNAVAILABLE' }
> {
  const nonce = BigInt(attempt.nonce), owner = attempt.tx.from.toLowerCase();
  const count = async (block: number) => quantity(await rpc('eth_getTransactionCount', [owner, tag(block)]));
  const head = Number(quantity(await rpc('eth_blockNumber', [])));
  if (!Number.isSafeInteger(head) || head < attempt.preparedAtBlock) throw Error('EVM_OBSERVATION_RPC_INVALID');
  const matches = (tx: unknown): tx is Record<string, unknown> => object(tx) && typeof tx.from === 'string' && tx.from.toLowerCase() === owner && quantity(tx.nonce) === nonce;
  if (await count(head) <= nonce) {
    // Public RPCs commonly expose only a local or empty pending block. This is positive discovery only.
    try {
      const block = await rpc('eth_getBlockByNumber', ['pending', true]);
      if (!object(block) || !Array.isArray(block.transactions)) return { consumed: false, pendingTx: null, visibility: 'UNAVAILABLE' };
      return { consumed: false, pendingTx: block.transactions.find(matches) ?? null, visibility: 'AVAILABLE' };
    } catch { return { consumed: false, pendingTx: null, visibility: 'UNAVAILABLE' }; }
  }
  if (await count(attempt.preparedAtBlock) > nonce) throw Error('EVM_OBSERVATION_NONCE_PREDATES_PREPARATION');
  let low = attempt.preparedAtBlock, high = head;
  while (high - low > 1) { const middle = low + Math.floor((high - low) / 2); if (await count(middle) > nonce) high = middle; else low = middle; }
  const block = await rpc('eth_getBlockByNumber', [tag(high), true]);
  if (!object(block) || !Array.isArray(block.transactions)) throw Error('EVM_OBSERVATION_RPC_INVALID');
  const tx = block.transactions.find(matches);
  if (!tx) throw Error('EVM_OBSERVATION_DISCOVERY_INCONSISTENT');
  return { consumed: true, tx };
}

export function sameEvmIntent(tx: Record<string, unknown>, expected: { chainId: string; from: string; to: string; data: string; value: string }, nonce: string): boolean {
  try { return typeof tx.from === 'string' && tx.from.toLowerCase() === expected.from.toLowerCase() && quantity(tx.nonce) === BigInt(nonce) &&
    typeof tx.to === 'string' && tx.to.toLowerCase() === expected.to.toLowerCase() && typeof tx.input === 'string' && tx.input.toLowerCase() === expected.data.toLowerCase() &&
    quantity(tx.value) === BigInt(expected.value) && quantity(tx.chainId) === BigInt(expected.chainId); } catch { return false; }
}
