// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): a user-funded wallet batch on Robinhood Chain whose owner cannot cover the native fee.
 *
 * 0x Gasless executes one owner-signed swap through 0x's relayer; it cannot run inside an EIP-5792 wallet batch (the wallet sends a batch and
 * pays its fee in ETH). The run's plan fixes each group's strategy when the owner authorizes the whole workflow, and the planner has no native
 * balance fact to choose `EVM_OWNER_STEP` with (adding one would change what an authorized plan means, which this build does not migrate).
 * So, when the batch preparation finds native gas short and EVERY step of the group is a swap 0x Gasless could carry (ERC-20 → ERC-20 on
 * Robinhood Chain, with 0x Gasless enabled on this deployment), the preparation is refused with a precise code telling the owner to run the
 * workflow in confirm-each-step mode, where each swap goes through `robinhood-swap` and decides there how its fee is paid (native first; 0x
 * Gasless when ETH is short). Any other group keeps native gas and the existing shortfall: transfers, liquidity, bridges, lending and native-ETH
 * swaps on Robinhood Chain always need ETH. The design is never cancelled: nothing is signed or sent by either refusal.
 */
import type { WorkflowRequirement } from '../delegation/steps.ts';
import { readZeroExGaslessConfig } from '../gas-abstraction/config.ts';

type Env = Readonly<Record<string, string | undefined>>;
const ROBINHOOD = 'eip155:4663';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const GASLESS_STEP_MODE_CODE = 'USER_FUNDED_GASLESS_REQUIRES_STEP_MODE';
/**
 * The precise refusal for a short-native batch group that 0x Gasless could carry step by step, or null (the existing native shortfall stands).
 * Pure: the requirement, the group's step range and chain, and the deployment's 0x Gasless switch.
 */
export function gaslessStepModeRefusal(requirement: WorkflowRequirement, group: { readonly chain: string; readonly stepFrom: number; readonly stepTo: number },
  env: Env = process.env): { readonly code: string; readonly stepIndex: number } | null {
  if (group.chain !== ROBINHOOD || !readZeroExGaslessConfig(env).enabled) return null;
  const steps = requirement.steps.slice(group.stepFrom, group.stepTo + 1);
  const erc20 = (asset: { readonly chain: string; readonly address: string }) => asset.chain === ROBINHOOD && /^0x[0-9a-fA-F]{40}$/.test(asset.address) && asset.address.toLowerCase() !== NATIVE;
  const gaslessSwap = steps.length > 0 && steps.every(step => step.chain === ROBINHOOD && step.action === 'swap' && step.inputs.length === 1 && step.outputs.length === 1 &&
    erc20(step.inputs[0]!) && erc20(step.outputs[0]!) && step.inputs[0]!.address.toLowerCase() !== step.outputs[0]!.address.toLowerCase());
  return gaslessSwap ? { code: GASLESS_STEP_MODE_CODE, stepIndex: steps[0]!.index } : null;
}
