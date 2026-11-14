// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: a short-ETH user-funded batch on Robinhood Chain is refused with a precise code that sends the owner to
 * confirm-each-step mode only when every step of the group is a swap 0x Gasless could carry; anything else keeps native gas and its shortfall.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROBINHOOD_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { workflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine.ts';
import { prepareGroup, type UserFundedDeps } from './groups.ts';
import { PERMANENT_DUE_REFUSALS } from '../workflow-runs/service.ts';
import type { StepRequirement, WorkflowRequirement } from '../delegation/steps.ts';
import { GASLESS_STEP_MODE_CODE, gaslessStepModeRefusal } from './gasless-groups.ts';

const RH = 'eip155:4663', USDG = '0x5fc5360d0b2f7ede3b27e8a1d5e3fa6a1be1d168', WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', TSLA = '0x' + '7'.repeat(40);
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ON = { FLOFI_ZEROX_GASLESS: 'enabled', FLOFI_ZEROX_API_KEY: 'fixture-key-123' };
const asset = (address: string, chain = RH) => ({ chain, address, decimals: 18, symbol: 'X' });
const step = (index: number, action: string, input: string, output: string | null, chain = RH): StepRequirement => ({ index, chain, action, namespace: 'eip155',
  inputs: [{ ...asset(input, chain), amount: 1n }], outputs: output ? [asset(output, chain)] : [] } as unknown as StepRequirement);
const requirement = (...steps: StepRequirement[]) => ({ steps } as unknown as WorkflowRequirement);
const group = (stepTo: number, chain = RH) => ({ chain, stepFrom: 0, stepTo });

describe('a short-ETH Robinhood Chain batch and 0x Gasless', () => {
  it('sends a batch of ERC-20 swaps (WETH/USDG, USDG → Stock Token) to confirm-each-step mode', () => {
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', WETH, USDG), step(1, 'swap', USDG, TSLA)), group(1), ON)).toEqual({ code: GASLESS_STEP_MODE_CODE, stepIndex: 0 });
  });
  it('keeps native gas (the existing shortfall) for anything 0x Gasless cannot carry', () => {
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', USDG, TSLA), step(1, 'transfer', TSLA, null)), group(1), ON)).toBeNull();
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', NATIVE, USDG)), group(0), ON)).toBeNull();
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', USDG, NATIVE)), group(0), ON)).toBeNull();
    expect(gaslessStepModeRefusal(requirement(step(0, 'supply', USDG, null)), group(0), ON)).toBeNull();
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', USDG, WETH, 'eip155:8453')), group(0, 'eip155:8453'), ON)).toBeNull();
  });
  it('is off unless the deployment enabled 0x Gasless', () => {
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', USDG, TSLA)), group(0), {})).toBeNull();
    expect(gaslessStepModeRefusal(requirement(step(0, 'swap', USDG, TSLA)), group(0), { FLOFI_ZEROX_GASLESS: 'enabled' })).toBeNull();
  });
});

describe('review Z1: the refusal a due Robinhood Chain batch actually gets (MOCKED chain double, nothing signed)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const OWNER = '0x1111111111111111111111111111111111111111', NOW = '2026-11-13T03:00:00Z', usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const strategy = { version: 2, steps: [{ action: 'swap', network: 'robinhood', inputAsset: 'WETH', outputAsset: 'USDG', amount: '0.001', slippageBps: 100 }] };
  async function prepare(native: bigint) {
    const chain = createEvmDouble(4663, () => Math.floor(Date.parse(NOW) / 1000), { profile: { ...ROBINHOOD_MAINNET_SWAP, usdc: usdg } });
    chain.control.fundToken(OWNER, ROBINHOOD_MAINNET_SWAP.weth, 10n ** 16n); chain.control.fundNative(OWNER, native);
    const transport = guarded(RH, 'read', 'MOCKED', chain.rpc), requirement = workflowRequirement(strategy), composition = composeWorkflowBound(strategy as never, undefined);
    if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
    const deps: UserFundedDeps = { chains: [RH], evm: c => c === RH ? transport : null, bundler: () => null, solana: null, jupiter: null, now: () => new Date(NOW) };
    return prepareGroup(deps, composition, requirement.value, { runId: 'wfr_z1', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: RH, feePayer: OWNER, stepFrom: 0, stepTo: 0 });
  }
  it('no ETH and 0x Gasless enabled: the permanent step-mode refusal (the run halts; Resume runs the swap through robinhood-swap)', async () => {
    vi.stubEnv('FLOFI_ZEROX_GASLESS', 'enabled'); vi.stubEnv('FLOFI_ZEROX_API_KEY', 'fixture-key-123');
    const r = await prepare(0n);
    expect(r).toMatchObject({ ok: false, code: GASLESS_STEP_MODE_CODE, stepIndex: 0 });
    expect(PERMANENT_DUE_REFUSALS.has((r as { code: string }).code.split(':')[0]!)).toBe(true);
    // 0x Gasless off: the existing native shortfall (not permanent: adding ETH lets the batch run on a retry).
    vi.unstubAllEnvs();
    const off = await prepare(0n);
    expect(off).toMatchObject({ ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE' });
    expect(PERMANENT_DUE_REFUSALS.has('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE')).toBe(false);
  });
});
