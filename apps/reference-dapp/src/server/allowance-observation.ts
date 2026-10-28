// SPDX-License-Identifier: AGPL-3.0-only
import type { AllowanceObservation } from '../domain/financial-observation.ts';
import type { Rpc } from './public-testnet-service.ts';

/** Repeated polling must not fill an append-only run log with unchanged facts. Keep the timestamp of the last stored observation. */
export function retainAllowanceObservation(before: AllowanceObservation | undefined, after: AllowanceObservation | undefined): AllowanceObservation | undefined {
  return before && after && ['chain', 'owner', 'token', 'spender', 'status', 'amount'].every(k => before[k as keyof AllowanceObservation] === after[k as keyof AllowanceObservation]) ? before : after;
}

/** A block-pinned allowance observation. Failure replaces current availability, never manufactures zero. */
export async function observeEvmAllowance(rpc: Rpc, identity: Pick<AllowanceObservation, 'chain' | 'owner' | 'token' | 'spender'>, observedAt: string): Promise<AllowanceObservation> {
  const base = { ...identity, observedAt };
  try {
    if (BigInt(String(await rpc('eth_chainId', []))) !== BigInt(identity.chain.split(':')[1]!)) throw Error('ALLOWANCE_WRONG_CHAIN');
    const head = await rpc('eth_getBlockByNumber', ['latest', false]) as { number: string; hash: string } | null;
    if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash)) throw Error('ALLOWANCE_BLOCK_UNAVAILABLE');
    const word = (a: string) => a.slice(2).padStart(64, '0');
    const data = await rpc('eth_call', [{ to: identity.token, data: '0xdd62ed3e' + word(identity.owner) + word(identity.spender) }, head.number]);
    if (typeof data !== 'string' || !/^0x[0-9a-f]{64}$/i.test(data)) throw Error('ALLOWANCE_RESPONSE_INVALID');
    const canonical = await rpc('eth_getBlockByNumber', [head.number, false]) as { hash?: string } | null;
    if (canonical?.hash !== head.hash) throw Error('ALLOWANCE_BLOCK_CHANGED');
    const blockNumber = Number(BigInt(head.number));
    if (!Number.isSafeInteger(blockNumber)) throw Error('ALLOWANCE_BLOCK_INVALID');
    return { ...base, status: 'VERIFIED', amount: BigInt(data).toString(), blockNumber, blockHash: head.hash };
  } catch { return { ...base, status: 'UNAVAILABLE', amount: null, blockNumber: null, blockHash: null }; }
}
