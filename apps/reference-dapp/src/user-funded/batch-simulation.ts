// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: the whole user-funded EVM batch simulated BEFORE the owner is asked to sign it — read-only, from the owner's own
 * account, at the latest block, in order (`eth_simulateV1`). The wallet later executes exactly these calls atomically; this proves now that
 * they would succeed and what they would leave behind:
 *
 *   every call     must succeed in order (an approval returns true or nothing, a swap returns at least its signed minimum)
 *   Aave borrow    the owner's Aave account read AFTER the whole batch (`getUserAccountData`) must keep a health factor of at least 2.0 —
 *                  the same minimum the owner-signed Borrow flow enforces (reference-compiler `BORROW_MINIMUM_HEALTH_FACTOR`). It is read
 *                  from the protocol itself after the batch's supplies, so collateral enablement, prices, caps and liquidity are Aave's own.
 *   gas            each call's simulated gas, for the fee the review shows (the wallet still shows and charges the final fee)
 *
 * Nothing is signed, sent or stored. A transport without `eth_simulateV1` is reported as UNAVAILABLE: the caller decides (a batch that
 * borrows is then refused, never signed blind).
 */
import { BORROW_MINIMUM_HEALTH_FACTOR, type erc7710 } from '@defi-workflow-engine/reference-compiler';
import type { ChainTransport } from '../delegation/chains.ts';
import type { EvmGroupCalls, UserCall } from './evm-calls.ts';

/** `getUserAccountData(address)` of an Aave V3 Pool. */
const GET_USER_ACCOUNT_DATA = '0xbf92857c';
const word = (address: string) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hex = (v: bigint) => '0x' + v.toString(16);
const uint = (v: unknown) => { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('USER_FUNDED_SIMULATION_INVALID'); return v === '0x' ? 0n : BigInt(v); };

export type BatchSimulation = {
  readonly method: 'eth_simulateV1'; readonly block: string;
  /** Gas each call used, in order. */ readonly gasUsed: readonly string[];
  /** A swap's simulated output (raw units), null for other calls. */ readonly outputs: readonly (string | null)[];
  /** The owner's Aave health factor (1e18) after the batch, per Pool the batch touches; absent when it touches none. */
  readonly healthFactorAfter: Readonly<Record<string, string>>;
};
export type BatchSimulationResult = { readonly ok: true; readonly value: BatchSimulation } | { readonly ok: false; readonly code: string; readonly callIndex: number | null }
  | { readonly ok: false; readonly code: 'USER_FUNDED_SIMULATION_UNAVAILABLE'; readonly callIndex: null };

/** The Aave Pools a group calls (supply/borrow), lower-case. */
export const aavePoolsOf = (calls: readonly UserCall[]) => [...new Set(calls.flatMap(c => c.kind === 'AAVE_V3_SUPPLY' || c.kind === 'AAVE_V3_BORROW' ? [c.pool.toLowerCase()] : []))];
/**
 * A JSON-RPC answer that means "this node does not offer the method" (as opposed to a simulation that ran and failed). Method-level refusals
 * only: a node that lags (a header or block it has not seen yet) is a transient RPC failure, never "this RPC cannot simulate".
 */
const lagging = (message: string) => /(?:header|block) (?:not found|unavailable)|unknown block|block not (?:yet )?(?:available|synced)/i.test(message);
const unsupported = (message: string) => !lagging(message)
  && /method not found|unknown method|(?:method|eth_simulateV1)[^.]*(?:not supported|unsupported|does not exist|is not available)|DELEGATION_RPC_METHOD_FORBIDDEN/i.test(message);

/** Exposed for tests: the classification of a failed `eth_simulateV1` answer. */
export const simulationFailureKind = (message: string) => unsupported(message) ? 'UNSUPPORTED' : lagging(message) ? 'LAGGING' : 'OTHER';

export async function simulateWalletBatch(t: ChainTransport, group: EvmGroupCalls, calls: readonly erc7710.Call[]): Promise<BatchSimulationResult> {
  if (calls.length !== group.calls.length || !calls.length) return { ok: false, code: 'USER_FUNDED_SIMULATION_INVALID', callIndex: null };
  const pools = aavePoolsOf(group.calls);
  const sequence = [...calls.map(c => ({ from: group.owner, to: c.target, data: c.data, value: hex(c.value) })),
    ...pools.map(pool => ({ from: group.owner, to: pool, data: GET_USER_ACCOUNT_DATA + word(group.owner), value: '0x0' }))];
  let raw: unknown, block: string;
  try {
    // At least this block: the simulation runs on the node's latest state (a node behind a load balancer may not have this exact block yet).
    block = String(await t.rpc('eth_blockNumber', []));
    raw = await t.rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: sequence }], validation: false, traceTransfers: false, returnFullTransactions: false }, 'latest']);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (unsupported(message)) return { ok: false, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', callIndex: null };
    return { ok: false, code: message === 'DELEGATION_RPC_UNAVAILABLE' || lagging(message) ? 'USER_FUNDED_RPC_UNAVAILABLE' : 'USER_FUNDED_SIMULATION_FAILED', callIndex: null };
  }
  const blocks = Array.isArray(raw) ? raw : null, results = blocks?.length === 1 && blocks[0] && typeof blocks[0] === 'object' ? (blocks[0] as { calls?: unknown }).calls : null;
  if (!Array.isArray(results) || results.length !== sequence.length) return { ok: false, code: 'USER_FUNDED_SIMULATION_INVALID', callIndex: null };
  const gasUsed: string[] = [], outputs: (string | null)[] = [];
  for (const [i, call] of group.calls.entries()) {
    const r = results[i] as { status?: unknown; returnData?: unknown; gasUsed?: unknown } | null;
    if (!r || r.status !== '0x1') return { ok: false, code: 'SIMULATION_REVERTED', callIndex: i };
    const returned = typeof r.returnData === 'string' ? r.returnData : '0x';
    if (call.kind === 'ERC20_APPROVE' && returned !== '0x' && uint(returned) !== 1n) return { ok: false, code: 'SIMULATION_REVERTED', callIndex: i };
    let output: string | null = null;
    if (call.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE') {
      const out = uint(returned.slice(0, 66));
      if (out < BigInt(call.amountOutMinimum)) return { ok: false, code: 'SWAP_MINIMUM_NOT_MET', callIndex: i };
      output = out.toString();
    }
    const gas = uint(r.gasUsed);
    if (gas <= 0n || gas > 30_000_000n) return { ok: false, code: 'USER_FUNDED_SIMULATION_INVALID', callIndex: i };
    gasUsed.push(gas.toString()); outputs.push(output);
  }
  const healthFactorAfter: Record<string, string> = {};
  for (const [k, pool] of pools.entries()) {
    const r = results[group.calls.length + k] as { status?: unknown; returnData?: unknown } | null;
    if (!r || r.status !== '0x1' || typeof r.returnData !== 'string' || r.returnData.length < 2 + 6 * 64) return { ok: false, code: 'USER_FUNDED_SIMULATION_INVALID', callIndex: null };
    healthFactorAfter[pool] = BigInt('0x' + r.returnData.slice(2 + 5 * 64, 2 + 6 * 64)).toString();
  }
  // A batch that BORROWS must leave the owner's Aave account at or above the owner-signed Borrow flow's minimum health factor.
  for (const [i, call] of group.calls.entries()) if (call.kind === 'AAVE_V3_BORROW' && BigInt(healthFactorAfter[call.pool.toLowerCase()] ?? '0') < BORROW_MINIMUM_HEALTH_FACTOR)
    return { ok: false, code: 'BORROW_UNSAFE_HEALTH_FACTOR', callIndex: i };
  return { ok: true, value: { method: 'eth_simulateV1', block, gasUsed, outputs, healthFactorAfter } };
}
