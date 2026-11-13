// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: a short-ETH user-funded batch on Robinhood Chain is refused with a precise code that sends the owner to
 * confirm-each-step mode only when every step of the group is a swap 0x Gasless could carry; anything else keeps native gas and its shortfall.
 */
import { describe, expect, it } from 'vitest';
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
