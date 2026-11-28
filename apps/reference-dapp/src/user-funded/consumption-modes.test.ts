// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (E02/E05): a binding's consumption mode in the owner's own wallet batch. A step bound to a swap of the
 * same batch spends from the swap's GUARANTEED output (its signed minimum), never an estimate and never the owner's unrelated balance: all of it
 * (up to the cap), a share of it, or exactly a fixed amount that the guarantee must cover before anything is offered for signing.
 *
 * MOCKED loopback chain double (Arbitrum One identities); nothing reaches a network and nothing is signed.
 */
import { describe, expect, it } from 'vitest';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { workflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine.ts';
import type { EvmGroupCalls } from './evm-calls.ts';
import { prepareGroup, type UserFundedDeps } from './groups.ts';

const CHAIN = 'eip155:42161', OWNER = '0x1111111111111111111111111111111111111111', RECIPIENT = '0x4444444444444444444444444444444444444444';
const NOW = '2026-11-09T03:00:00Z', USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth;
const SWAP = { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 };
const send = (amount: string) => ({ action: 'transfer', network: 'arbitrum-one', asset: 'WETH', amount, recipient: RECIPIENT });
type Prepared = { group: EvmGroupCalls };

function arbitrum() {
  const chain = createEvmDouble(42161, () => Math.floor(Date.parse(NOW) / 1000), { profile: ARBITRUM_MAINNET_SWAP });
  // The owner already holds unrelated WETH: a bound step must never spend it.
  chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundToken(OWNER, WETH, 10n ** 16n); chain.control.fundNative(OWNER, 10n ** 17n);
  const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
  const deps: UserFundedDeps = { chains: [CHAIN], evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
  const prepare = (s: { version: 2; steps: Record<string, unknown>[]; bindings: Record<string, unknown>[] }) => {
    const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    return prepareGroup(deps, composition, requirement.value, { runId: 'wfr_modes', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN, feePayer: OWNER,
      stepFrom: 0, stepTo: s.steps.length - 1 });
  };
  return { chain, prepare };
}
const calls = async (binding: Record<string, unknown>, cap: string) => {
  const { prepare } = arbitrum();
  const r = await prepare({ version: 2, steps: [SWAP, send(cap)], bindings: [{ step: 1, amountFrom: 0, ...binding }] });
  if (!r.ok) throw new Error(r.code);
  const group = (r.value.prepared as unknown as Prepared).group;
  const swap = group.calls.find(c => c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE') as { amountOutMinimum: string };
  const transfer = group.calls.find(c => c.kind === 'ERC20_TRANSFER') as { amount: string; to: string };
  return { minimum: BigInt(swap.amountOutMinimum), transfer };
};

describe('BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: consumption modes in a wallet batch (GUARANTEED output only)', () => {
  it('ALL spends the swap\'s signed minimum (below the cap), exactly as an unmoded binding does', async () => {
    const all = await calls({ consume: 'ALL' }, '0.0013'), plain = await calls({}, '0.0013');
    expect(all.minimum).toBeLessThan(1_300_000_000_000_000n);
    expect(BigInt(all.transfer.amount)).toBe(all.minimum);
    expect(plain.transfer.amount).toBe(all.transfer.amount);
    // A cap below the guarantee still bounds it.
    const capped = await calls({ consume: 'ALL' }, '0.0001');
    expect(capped.transfer.amount).toBe('100000000000000');
  });

  it('PERCENT spends floor(guaranteed × bps / 10 000), capped by its own amount', async () => {
    const half = await calls({ consume: 'PERCENT', bps: 5000 }, '0.0013');
    expect(BigInt(half.transfer.amount)).toBe(half.minimum * 5000n / 10_000n);
    const quarter = await calls({ consume: 'PERCENT', bps: 2500 }, '0.0013');
    expect(BigInt(quarter.transfer.amount)).toBe(quarter.minimum * 2500n / 10_000n);
    const capped = await calls({ consume: 'PERCENT', bps: 5000 }, '0.0001');
    expect(capped.transfer.amount).toBe('100000000000000');
  });

  it('FIXED spends exactly its amount when the guarantee covers it, and is refused before anything is offered when it does not', async () => {
    const fixed = await calls({ consume: 'FIXED' }, '0.0005');
    expect(fixed.transfer).toMatchObject({ amount: '500000000000000', to: RECIPIENT });
    // 0.0013 WETH is more than the swap guarantees: nothing is simulated, offered or sent, and the owner's unrelated WETH never tops it up.
    const { chain, prepare } = arbitrum();
    expect(await prepare({ version: 2, steps: [SWAP, send('0.0013')], bindings: [{ step: 1, amountFrom: 0, consume: 'FIXED' }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_INSUFFICIENT_FOR_FIXED_AMOUNT', stepIndex: 1 });
    expect(chain.control.simulations()).toBe(0);
    expect(chain.control.sends()).toBe(0);
    expect(chain.control.tokenBalance(WETH, OWNER)).toBe(10n ** 16n);
  });
});
