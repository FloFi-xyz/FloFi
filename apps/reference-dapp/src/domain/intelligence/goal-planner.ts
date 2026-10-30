// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001 (mandatory addendum): goal-to-workflow planning. A person states an outcome ("I have USDC on Base and want SOL on
 * Solana", "supply my USDC on Aave") and FloFi derives the ordered steps that reach it from its own registries — never from canned workflows:
 *
 *   paths       same network: a swap; another network: one Cross-chain Router bridge (a certified route for that asset, or the universal router,
 *               which also converts the asset inside the same route); a supply after it lands where Aave V3 lists the asset
 *   eligibility every step is an action the Capability API lists on its network in this scope, and a multi-step plan only uses steps the
 *               sequence runtime executes one after another (swap, bridge, supply, transfer: liquidity is not a sequence step)
 *   funding     a later step spends what the step before it actually delivers, capped by an amount: the user's own amount when it is the same
 *               asset (a bridge delivers at most what it sends), otherwise a cap the user states — FloFi never invents one
 *   choice      fewer steps first (the universal router converts and moves in one route); a certified route when one exists unless the user
 *               asked for the lowest cost, in which case the universal router compares every provider's guaranteed amount at Review
 *
 * Every value comes from the goal (the caller grounds each one in the user's words); unknown or missing fields are asked one at a time, with
 * options from the registries. The plan grants nothing: each step is still authored through the exact grammar, simulated fresh, reviewed by
 * the owner and signed by the owner's wallet. Pure; no quotes, balances or network access (live quotes come from the read-only route tools).
 */
import { UNIVERSAL_NETWORKS } from '@defi-workflow-engine/workflow-contracts';
import { bridgeOffers, lendingOffers } from '../authoring-capabilities';
import { networkIdentity, type NetworkIdentity } from '../network-registry';
import { networkAllowed, type NetworkScope } from '../network-scope';
import { capabilityGap, networkCapabilityProfiles } from './capability-api';
import { fiatReference } from './asset-resolution';
import type { CopilotLiquidityAction } from '../copilot-intent';

export { GOAL_PREFERENCES, GOAL_USES, type GoalPreference, type GoalUse } from './goal-vocabulary';
import type { GoalPreference, GoalUse } from './goal-vocabulary';
/** Networks are registry keys (`base`, `arbitrum-one`, `solana`, …); assets are references exactly as written. */
export type Goal = {
  readonly source: { readonly network: string | null; readonly asset: string | null; readonly amount: string | null };
  readonly target: { readonly network: string | null; readonly asset: string | null; readonly use: GoalUse };
  readonly preference: GoalPreference | null;
  /** The most a funded later step may spend when it is a different asset than the user's own amount (stated by the user). */
  readonly cap: string | null;
  readonly liquidity?: CopilotLiquidityAction | null;
};
export type GoalField = 'sourceAsset' | 'sourceNetwork' | 'amount' | 'targetNetwork' | 'targetAsset' | 'cap' | 'deposits' | 'range';
export type GoalStepAction = 'swap' | 'bridge' | 'supply' | 'add_liquidity';
export type GoalStep = {
  readonly action: GoalStepAction; readonly network: string; readonly destinationNetwork: string | null;
  readonly inputAsset: string; readonly outputAsset: string | null; readonly amount: string;
  /** The earlier step whose actual delivery this step spends (its `amount` is then a cap), or null. */ readonly fundedBy: number | null;
  /** Bridges: BEST asks the universal router for every provider's guaranteed amount; null lets FloFi use a certified route when one exists. */
  readonly routing: 'BEST' | null;
  readonly liquidity?: CopilotLiquidityAction;
};
export type GoalReason = 'SAME_NETWORK_SWAP' | 'CERTIFIED_ROUTE' | 'UNIVERSAL_ROUTE' | 'CONVERTS_IN_ROUTE' | 'LOWEST_COST_AT_REVIEW' | 'FASTEST_NOT_SELECTABLE'
  | 'FUNDED_BY_PREVIOUS_STEP' | 'CAP_IS_YOUR_AMOUNT' | 'EACH_STEP_REVIEWED' | 'REAL_FUNDS';
export type GoalAlternative = { readonly code: 'UNIVERSAL_BEST' | 'CERTIFIED_ROUTE' | 'SWAP_ONLY' | 'SEPARATE_LIQUIDITY'; readonly network: string | null };
export type GoalGap = 'TEST_NETWORK_NOT_AVAILABLE' | 'NETWORK_UNKNOWN' | 'NO_SWAP_ON_NETWORK' | 'NO_ROUTE_BETWEEN_NETWORKS' | 'LENDING_ASSET_NOT_SUPPORTED'
  | 'LENDING_NOT_ON_NETWORK' | 'LIQUIDITY_NOT_ON_NETWORK' | 'LIQUIDITY_ASSET_NOT_IN_PAIR' | 'FIAT_NOT_AN_ASSET' | 'SAME_NETWORK_BRIDGE';
export type GoalPlan =
  | { readonly kind: 'PLAN'; readonly steps: readonly GoalStep[]; readonly reasons: readonly GoalReason[]; readonly alternatives: readonly GoalAlternative[] }
  | { readonly kind: 'NEEDS'; readonly field: GoalField; readonly options: readonly string[]; readonly step?: number; readonly asset?: string }
  | { readonly kind: 'UNSUPPORTED'; readonly code: GoalGap; readonly network: string | null; readonly options: readonly string[]; readonly alternatives: readonly GoalAlternative[] }
  /** A liquidity goal that needs no conversion: the existing liquidity authoring asks for its pair, deposits and range. */
  | { readonly kind: 'LIQUIDITY'; readonly network: string }
  | { readonly kind: 'NOTHING_TO_DO'; readonly network: string; readonly asset: string };

const same = (a: string | null, b: string | null) => a !== null && b !== null && a.trim().toUpperCase() === b.trim().toUpperCase();
const nameOf = (key: string) => networkIdentity(key)?.name ?? key;
const universal = (key: string) => Object.keys(UNIVERSAL_NETWORKS).includes(key);
/** A certified Cross-chain Router route for this asset between the two networks (registry routes only). */
const certifiedRoute = (scope: NetworkScope, from: string, to: string, asset: string) => bridgeOffers().some(route =>
  route.source.key === from && route.destination.key === to && same(route.asset, asset) && networkAllowed(route.source.key, scope) && networkAllowed(route.destination.key, scope));
const lendingOn = (scope: NetworkScope) => lendingOffers().filter(offer => networkAllowed(offer.network.key, scope));
/** Public networks a source asset can start from: every network with a swap, bridge or supply in scope. */
const startNetworks = (scope: NetworkScope) => networkCapabilityProfiles(scope).filter(profile => profile.actions.some(action => ['swap', 'bridge', 'supply'].includes(action.action)) || profile.universalBridge)
  .map(profile => profile.name);
function known(scope: NetworkScope, key: string | null): { ok: true; network: NetworkIdentity } | { ok: false; plan: GoalPlan } | null {
  if (key === null) return null;
  const identity = networkIdentity(key);
  if (!identity) return { ok: false, plan: { kind: 'UNSUPPORTED', code: 'NETWORK_UNKNOWN', network: null, options: startNetworks(scope), alternatives: [] } };
  if (!networkAllowed(identity.key, scope)) return { ok: false, plan: { kind: 'UNSUPPORTED', code: 'TEST_NETWORK_NOT_AVAILABLE', network: identity.name, options: [], alternatives: [] } };
  return { ok: true, network: identity };
}

/** The ordered steps that reach `goal`, or the one field FloFi needs next, or why the registries cannot reach it. */
export function planGoal(goal: Goal, scope: NetworkScope): GoalPlan {
  for (const asset of [goal.source.asset, goal.target.asset])
    if (asset && fiatReference(asset)) return { kind: 'UNSUPPORTED', code: 'FIAT_NOT_AN_ASSET', network: null, options: [], alternatives: [] };
  const from = known(scope, goal.source.network), to = known(scope, goal.target.network);
  if (from && !from.ok) return from.plan;
  if (to && !to.ok) return to.plan;
  if (goal.target.use === 'LIQUIDITY') {
    const network = to?.network ?? from?.network ?? null;
    if (!network) return { kind: 'NEEDS', field: 'targetNetwork', options: networkCapabilityProfiles(scope).filter(p => p.actions.some(a => a.action === 'add_liquidity')).map(p => p.name) };
    if (capabilityGap(scope, 'add_liquidity', network.key)) return { kind: 'UNSUPPORTED', code: 'LIQUIDITY_NOT_ON_NETWORK', network: network.name, options: [], alternatives: [] };
    const position = goal.liquidity;
    if (!position || position.deposits.length !== 2) return { kind: 'NEEDS', field: 'deposits', options: [] };
    if (!position.rangeUnit || (position.rangeUnit !== 'FULL' && (!position.upper || (position.rangeUnit !== 'PERCENT' && !position.lower))))
      return { kind: 'NEEDS', field: 'range', options: [] };
    const asset = goal.target.asset ?? position.deposits.find(deposit => same(deposit.asset, goal.source.asset))?.asset ?? null;
    if (!asset) return { kind: 'NEEDS', field: 'targetAsset', options: position.deposits.map(deposit => deposit.asset) };
    const deposit = position.deposits.find(item => same(item.asset, asset));
    if (!deposit) return { kind: 'UNSUPPORTED', code: 'LIQUIDITY_ASSET_NOT_IN_PAIR', network: network.name, options: position.deposits.map(item => item.asset), alternatives: [] };
    // Reuse the same registry-backed route search for the funding asset; the position remains part of this workflow.
    const conversion = planGoal({ ...goal, target: { network: network.key, asset, use: 'HOLD' } }, scope);
    if (conversion.kind !== 'PLAN' && conversion.kind !== 'NOTHING_TO_DO') return conversion;
    const prefix = conversion.kind === 'PLAN' ? conversion.steps : [];
    const fundedBy = prefix.length ? prefix.length - 1 : null;
    const step: GoalStep = { action: 'add_liquidity', network: network.key, destinationNetwork: null, inputAsset: asset, outputAsset: null,
      amount: deposit.maxAmount, fundedBy, routing: null, liquidity: position };
    return { kind: 'PLAN', steps: [...prefix, step], reasons: [...new Set<GoalReason>([...conversion.kind === 'PLAN' ? conversion.reasons : [],
      ...fundedBy !== null ? ['FUNDED_BY_PREVIOUS_STEP', 'EACH_STEP_REVIEWED'] as const : [], ...network.environment === 'MAINNET' ? ['REAL_FUNDS'] as const : []])],
      alternatives: conversion.kind === 'PLAN' ? conversion.alternatives : [] };
  }
  if (!goal.source.asset) return { kind: 'NEEDS', field: 'sourceAsset', options: goal.target.use === 'SUPPLY' ? [...new Set(lendingOn(scope).map(offer => offer.asset))] : [] };
  const lending = lendingOn(scope);
  // Supplying: where the market is comes first (its options are Aave V3's own networks for that asset); then where the user holds the asset.
  if (goal.target.use === 'SUPPLY' && !to && !from) {
    const offers = lending.filter(offer => same(offer.asset, goal.target.asset ?? goal.source.asset));
    if (offers.length) return { kind: 'NEEDS', field: 'targetNetwork', options: offers.map(offer => offer.network.name) };
  }
  if (!from) return { kind: 'NEEDS', field: 'sourceNetwork', options: to ? [to.network.name, ...startNetworks(scope).filter(name => name !== to.network.name)].slice(0, 5) : startNetworks(scope) };
  const target = to?.network ?? null;
  let targetAsset = goal.target.asset;
  if (goal.target.use === 'SUPPLY') {
    const wanted = targetAsset ?? goal.source.asset;
    const offers = lending.filter(offer => same(offer.asset, wanted));
    if (!offers.length) return { kind: 'UNSUPPORTED', code: 'LENDING_ASSET_NOT_SUPPORTED', network: null, options: [...new Set(lending.map(offer => `${offer.asset} · ${offer.network.name}`))], alternatives: [] };
    if (!target) return { kind: 'NEEDS', field: 'targetNetwork', options: offers.map(offer => offer.network.name) };
    const offer = offers.find(item => item.network === target);
    if (!offer) return { kind: 'UNSUPPORTED', code: 'LENDING_NOT_ON_NETWORK', network: target.name, options: offers.map(item => item.network.name), alternatives: [] };
    targetAsset = offer.asset;
  }
  if (!target) return { kind: 'NEEDS', field: 'targetNetwork', options: [from.network.name, ...startNetworks(scope).filter(name => name !== from.network.name)].slice(0, 5) };
  if (!goal.source.amount) return { kind: 'NEEDS', field: 'amount', options: [] };
  const amount = goal.source.amount, steps: GoalStep[] = [], reasons: GoalReason[] = [], alternatives: GoalAlternative[] = [];
  const supplying = goal.target.use === 'SUPPLY';
  // What arrives on the target network before an optional supply: the supply's asset, or what the user wants to hold (null: the bridge's default).
  const arrive = targetAsset;
  if (from.network === target) {
    if (!arrive || same(arrive, goal.source.asset)) {
      if (!supplying) return { kind: 'NOTHING_TO_DO', network: target.name, asset: goal.source.asset };
    } else {
      if (capabilityGap(scope, 'swap', target.key)) return { kind: 'UNSUPPORTED', code: 'NO_SWAP_ON_NETWORK', network: target.name, options: [], alternatives: [] };
      steps.push({ action: 'swap', network: target.key, destinationNetwork: null, inputAsset: goal.source.asset, outputAsset: arrive, amount, fundedBy: null, routing: null });
      reasons.push('SAME_NETWORK_SWAP');
    }
  } else {
    // A certified route moves its own asset (it may arrive as the destination's stablecoin); a different requested asset needs the universal router.
    const certified = certifiedRoute(scope, from.network.key, target.key, goal.source.asset) && (!arrive || same(arrive, goal.source.asset));
    const both = universal(from.network.key) && universal(target.key);
    if (!certified && !both) return { kind: 'UNSUPPORTED', code: 'NO_ROUTE_BETWEEN_NETWORKS', network: target.name,
      options: networkCapabilityProfiles(scope).filter(profile => profile.universalBridge && profile.key !== from.network.key).map(profile => profile.name), alternatives: [] };
    const best = goal.preference === 'LOWEST_COST' || goal.preference === 'FASTEST' || !certified;
    if (goal.preference === 'CERTIFIED_ROUTE' && !certified) return { kind: 'UNSUPPORTED', code: 'NO_ROUTE_BETWEEN_NETWORKS', network: target.name, options: [],
      alternatives: both ? [{ code: 'UNIVERSAL_BEST', network: target.key }] : [] };
    steps.push({ action: 'bridge', network: from.network.key, destinationNetwork: target.key, inputAsset: goal.source.asset, outputAsset: arrive, amount, fundedBy: null,
      routing: best && both ? 'BEST' : null });
    reasons.push(best && both ? 'UNIVERSAL_ROUTE' : 'CERTIFIED_ROUTE');
    if (arrive && !same(arrive, goal.source.asset)) reasons.push('CONVERTS_IN_ROUTE');
    if (goal.preference === 'LOWEST_COST' || goal.preference === 'FASTEST') reasons.push('LOWEST_COST_AT_REVIEW');
    if (goal.preference === 'FASTEST') reasons.push('FASTEST_NOT_SELECTABLE');
    if (certified && both && best) alternatives.push({ code: 'CERTIFIED_ROUTE', network: target.key });
    if (certified && both && !best) alternatives.push({ code: 'UNIVERSAL_BEST', network: target.key });
  }
  if (supplying) {
    if (capabilityGap(scope, 'supply', target.key)) return { kind: 'UNSUPPORTED', code: 'LENDING_NOT_ON_NETWORK', network: target.name, options: lending.map(offer => offer.network.name), alternatives: [] };
    const funded = steps.length ? steps.length - 1 : null;
    // The same asset arrives (a bridge delivers at most what it sends): the user's own amount is the cap. Another asset needs the user's cap.
    const sameAsset = same(targetAsset, goal.source.asset);
    if (funded !== null && !sameAsset && !goal.cap) return { kind: 'NEEDS', field: 'cap', options: [], step: steps.length, asset: targetAsset! };
    steps.push({ action: 'supply', network: target.key, destinationNetwork: null, inputAsset: targetAsset!, outputAsset: null, amount: funded === null || sameAsset ? amount : goal.cap!,
      fundedBy: funded, routing: null });
    if (funded !== null) reasons.push('FUNDED_BY_PREVIOUS_STEP', ...sameAsset ? ['CAP_IS_YOUR_AMOUNT' as const] : []);
  }
  if (steps.length > 1) reasons.push('EACH_STEP_REVIEWED');
  if ([from.network, target].some(network => network.environment === 'MAINNET')) reasons.push('REAL_FUNDS');
  return { kind: 'PLAN', steps, reasons: [...new Set(reasons)], alternatives };
}
/** Display names of a plan's networks (for copy). */
export const stepNetworkNames = (step: GoalStep): readonly string[] => [nameOf(step.network), ...step.destinationNetwork ? [nameOf(step.destinationNetwork)] : []];
