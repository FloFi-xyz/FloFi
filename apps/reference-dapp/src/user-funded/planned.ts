// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: what a prepared user-funded EVM batch will do for each of its steps, in the words the owner reads before the wallet
 * prompt and in the run's progress — what each step spends, a swap's quoted output and signed minimum, a borrow's exact delivery. Pure: read from
 * the prepared artifact the run stores (never from a label), with the step's own asset identities (decimals, symbol) for display.
 */
import { formatAssetAmount } from '@defi-workflow-engine/action-registry';
import { assetKey, type AssetRef, type StepRequirement } from '../delegation/steps.ts';
import type { EvmGroupCalls } from './evm-calls.ts';

/** An amount the owner reads: its asset identity (the run's asset key), raw units, decimals, symbol and the formatted value. */
export type ReviewAmount = { readonly asset: string; readonly units: string; readonly decimals: number; readonly symbol: string; readonly text: string };
export type PlannedStep = { readonly spend: ReviewAmount | null; readonly expected: ReviewAmount | null; readonly minimum: ReviewAmount | null;
  /** A transfer's recipient exactly as the prepared call pays it (lower-case EVM address); null for every other step. */
  readonly recipient: string | null };

export const amountOf = (units: string | bigint, ref: AssetRef): ReviewAmount =>
  ({ asset: assetKey(ref), units: units.toString(), decimals: ref.decimals, symbol: ref.symbol, text: `${formatAssetAmount(units.toString(), ref.decimals)} ${ref.symbol}` });
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const sameAsset = (key: string, ref: AssetRef) => key.toLowerCase().endsWith(`:${ref.address.toLowerCase()}`) || key.endsWith('/native:ETH') && ref.address.toLowerCase() === NATIVE;
const refOf = (step: StepRequirement, key: string) => [...step.inputs, ...step.outputs].find(ref => sameAsset(key, ref)) ?? null;

/** The wallet-visible planned values of a prepared EVM batch, per step index. */
export function plannedSteps(requirement: { readonly steps: readonly StepRequirement[] }, group: EvmGroupCalls): ReadonlyMap<number, PlannedStep> {
  const out = new Map<number, PlannedStep>();
  for (const s of group.steps) {
    const step = requirement.steps[s.stepIndex];
    if (!step) continue;
    const spendRef = refOf(step, s.spend.asset), quotedRef = s.quoted ? refOf(step, s.quoted.asset) : null, guaranteedRef = s.guaranteed ? refOf(step, s.guaranteed.asset) : null;
    // A borrow or a withdrawal spends nothing from the wallet: it delivers exactly its amount to the owner.
    const borrow = step.action === 'borrow' || step.action === 'withdraw';
    out.set(s.stepIndex, {
      spend: !borrow && spendRef ? amountOf(s.spend.amount, spendRef) : null,
      expected: s.quoted && quotedRef ? amountOf(s.quoted.amount, quotedRef) : borrow && s.guaranteed && guaranteedRef ? amountOf(s.guaranteed.amount, guaranteedRef) : null,
      minimum: step.action === 'swap' && s.guaranteed && guaranteedRef ? amountOf(s.guaranteed.amount, guaranteedRef) : null, recipient: s.recipient });
  }
  return out;
}
