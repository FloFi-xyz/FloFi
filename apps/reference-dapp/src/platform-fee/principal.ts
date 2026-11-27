// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE): the feeable principal of one workflow execution.
 *
 * Principal is the capital the owner independently introduces from their wallet. Capital that moves between dependent steps is counted
 * once, where it entered:
 *   - a step input bound to an earlier step's output (`bindings`, `{ step, amountFrom }`) is derived, never principal;
 *   - an unbound step input of an asset an earlier step of the same workflow delivered to the owner (same chain, address and decimals) is
 *     derived up to what that earlier step delivered. When the delivered amount is not known yet (Review, before reconciliation) the
 *     coverage is unbounded, so an estimate never charges more than the final settlement could;
 *   - anything above the covered amount is new principal (it comes from the wallet's own funds).
 * Principal is accounted per exact asset identity (no conversion between tokens, no fiat valuation). The fee of each asset is
 * floor(principal × 80 / 10 000) in that asset's native units.
 *
 * Fail closed: a step this accounting cannot read (unknown action, unreadable input, an asset whose class cannot be established on a
 * network that lists Stock Tokens) makes the whole execution UNSUPPORTED. An UNSUPPORTED execution is never charged (F20).
 */
import type { AssetClass } from '@defi-workflow-engine/action-registry';
import type { Composition, WorkflowComposition } from '../engine/strategy-engine';
import { STRATEGY_ACTIONS } from '../engine/strategy-spec';
import { sameAsset, stepInputs, stepOutput, type AssetIdentity, type WorkflowBinding } from '../engine/workflow-bindings';
import { resolveNetworkAsset } from '../domain/asset-catalogs';
import { ACTION_FEE_POLICY, PLATFORM_FEE_BPS, PLATFORM_FEE_POLICY_ID, platformFeeAmount } from './policy';

export type FeeLine = AssetIdentity & { readonly principal: string; readonly fee: string };
export type StepTreatment = 'PRINCIPAL' | 'DERIVED' | 'PARTLY_DERIVED' | 'NOT_APPLICABLE' | 'NO_WALLET_INPUT';
export type FeeBasis = {
  readonly policyId: typeof PLATFORM_FEE_POLICY_ID;
  readonly rateBps: typeof PLATFORM_FEE_BPS;
  /** FEEABLE: at least one asset has a positive fee. NOT_APPLICABLE: nothing feeable (e.g. only a borrow). UNSUPPORTED: never charged. */
  readonly status: 'FEEABLE' | 'NOT_APPLICABLE' | 'UNSUPPORTED';
  readonly lines: readonly FeeLine[];
  readonly steps: readonly { readonly step: number; readonly action: string; readonly treatment: StepTreatment }[];
  readonly reason: string | null;
};
/** The asset class of an exact identity, or null when it cannot be established. Injected by tests; defaults to the asset catalogs. */
export type AssetClassOf = (asset: AssetIdentity) => AssetClass | null;
export type FeeBasisOptions = {
  /** Native units each producer step actually delivered to the owner (reconciled), by executable step index. Absent: not known yet. */
  readonly delivered?: ReadonlyMap<number, bigint>;
  readonly assetClassOf?: AssetClassOf;
};

/** Networks whose catalogs list Stock Tokens (Robinhood Chain mainnet and testnet). */
const STOCK_NETWORKS = new Set(['eip155:4663', 'eip155:46630']);
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const defaultAssetClassOf: AssetClassOf = asset => {
  if (!asset.chainId.startsWith('eip155:')) return 'TOKEN';
  if (asset.address === NATIVE) return 'NATIVE';
  const found = resolveNetworkAsset(asset.chainId, { address: asset.address });
  if (found && found.decimals === asset.decimals) return found.assetClass;
  return STOCK_NETWORKS.has(asset.chainId) ? null : 'TOKEN';
};

const key = (a: AssetIdentity) => `${a.chainId}|${a.address}|${a.decimals}`;
const UNBOUNDED = -1n;

function unsupported(steps: FeeBasis['steps'], reason: string): FeeBasis {
  return { policyId: PLATFORM_FEE_POLICY_ID, rateBps: PLATFORM_FEE_BPS, status: 'UNSUPPORTED', lines: [], steps, reason };
}

/** The feeable principal and fee of one execution of `workflow` (its executable steps, Batch Payment legs included, and its bindings). */
export function workflowFeeBasis(workflow: Pick<WorkflowComposition, 'steps' | 'bindings'>, options: FeeBasisOptions = {}): FeeBasis {
  const classOf = options.assetClassOf ?? defaultAssetClassOf;
  const available = new Map<string, bigint>(); // derived capital still available per asset (UNBOUNDED when not known)
  const principal = new Map<string, { asset: AssetIdentity; amount: bigint }>();
  const treated: { step: number; action: string; treatment: StepTreatment }[] = [];
  const stock = (asset: AssetIdentity | null) => asset !== null && classOf(asset) === 'STOCK_TOKEN';
  const unknownClass = (asset: AssetIdentity | null) => asset !== null && classOf(asset) === null;

  for (const [index, step] of workflow.steps.entries()) {
    const action = step.strategy.action;
    if (!(STRATEGY_ACTIONS as readonly string[]).includes(action)) return unsupported(treated, 'PLATFORM_FEE_ACTION_UNKNOWN');
    const inputs = stepInputs(step), output = stepOutput(step);
    if (inputs.some(unknownClass) || unknownClass(output)) return unsupported(treated, 'PLATFORM_FEE_ASSET_CLASS_UNKNOWN');
    const consumer = ['swap', 'bridge', 'supply', 'repay', 'transfer', 'add_liquidity'].includes(action);
    if (consumer && !inputs.length) return unsupported(treated, 'PLATFORM_FEE_INPUT_UNREADABLE');
    const feeable = ACTION_FEE_POLICY[action] === 'FEEABLE' && !inputs.some(stock) && !stock(output);
    let derivedParts = 0, principalParts = 0;
    for (const input of inputs) {
      const amount = BigInt(input.amount), k = key(input);
      const bound = workflow.bindings.some(b => b.step === index && sameAsset(b.asset, input));
      const cover = available.get(k);
      const covered = cover === undefined ? 0n : cover === UNBOUNDED ? amount : cover < amount ? cover : amount;
      if (cover !== undefined && cover !== UNBOUNDED) available.set(k, cover - covered);
      if (bound) { derivedParts++; continue; }
      const own = amount - covered;
      if (covered > 0n) derivedParts++;
      if (own > 0n && feeable) {
        principalParts++;
        const prior = principal.get(k);
        principal.set(k, { asset: { chainId: input.chainId, address: input.address, decimals: input.decimals }, amount: (prior?.amount ?? 0n) + own });
      }
    }
    if (output) {
      const k = key(output), delivered = options.delivered?.get(index), prior = available.get(k);
      available.set(k, delivered === undefined || prior === UNBOUNDED ? UNBOUNDED : (prior ?? 0n) + delivered);
    }
    treated.push({ step: index, action, treatment: !consumer ? 'NO_WALLET_INPUT' : !feeable && !derivedParts ? 'NOT_APPLICABLE'
      : principalParts && derivedParts ? 'PARTLY_DERIVED' : principalParts ? 'PRINCIPAL' : derivedParts ? 'DERIVED' : 'NOT_APPLICABLE' });
  }
  const lines: FeeLine[] = [...principal.values()].map(({ asset, amount }) => ({ ...asset, principal: amount.toString(), fee: platformFeeAmount(amount).toString() }))
    .filter(line => BigInt(line.fee) > 0n).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { policyId: PLATFORM_FEE_POLICY_ID, rateBps: PLATFORM_FEE_BPS, status: lines.length ? 'FEEABLE' : 'NOT_APPLICABLE', lines, steps: treated,
    reason: lines.length ? null : principal.size ? 'PLATFORM_FEE_BELOW_ONE_UNIT' : 'PLATFORM_FEE_NO_FEEABLE_PRINCIPAL' };
}

/** A single composed step as a one-step workflow (a single-card execution). */
export const singleStepFeeBasis = (step: Composition, options?: FeeBasisOptions): FeeBasis =>
  workflowFeeBasis({ steps: [step], bindings: [] as readonly WorkflowBinding[] }, options);

/**
 * What may be charged at settlement: per asset, never more than the authorized (reviewed) fee and never more than the final basis.
 * An asset the owner did not authorize is never charged; a final basis that is not FEEABLE charges nothing.
 */
export function settledFee(authorized: Pick<FeeBasis, 'status' | 'lines'>, final: Pick<FeeBasis, 'status' | 'lines'>): readonly FeeLine[] {
  if (authorized.status !== 'FEEABLE' || final.status !== 'FEEABLE') return [];
  return final.lines.flatMap(line => {
    const cap = authorized.lines.find(a => sameAsset(a, line));
    if (!cap) return [];
    const fee = BigInt(line.fee) < BigInt(cap.fee) ? line.fee : cap.fee;
    return BigInt(fee) > 0n ? [{ ...line, fee }] : [];
  });
}
