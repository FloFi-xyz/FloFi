// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the typed Capability API — one read-only view, per network, of what FloFi can author and how far each action
 * can go, generated from the registries every surface already shares:
 *
 *   identity            the network registry (name, environment, family, official catalog)
 *   actions             the canonical examples (`AUTHORING_CAPABILITIES`), scoped by the deployment's network scope and the agent rollout gate
 *   assets              the validated official catalog of a catalog network (and whether it is loaded now), else MCP discovery's listed assets
 *   routes              Cross-chain Router routes (certified pairs) and the universal router's networks
 *   required parameters the canonical strategy schema (`strategyRequiredFields`)
 *   eligibility         the execution capability registry resolved on each example's composed IR (`codeCapabilities`): what code supports
 *
 * A new network or protocol becomes discoverable here by being registered and certified in those registries — never by teaching the Copilot a
 * list. Nothing here is authority: capability discovery is not execution certification, deployment enablement is decided by the runtime at
 * Review, and every proposal still needs a fresh simulation, the owner's Review and the owner's wallet signature. Pure; no network, no wallet.
 */
import { AAVE_V3_AMOUNT_POLICY } from '@defi-workflow-engine/action-registry';
import { UNIVERSAL_NETWORKS } from '@defi-workflow-engine/workflow-contracts';
import { AUTHORING_CAPABILITIES, type AuthoringCapability } from '../authoring-capabilities';
import { declaredNetworkSymbols, officialCatalogLoaded } from '../asset-catalogs';
import { agentRolloutAllows, pendingAgentCapability } from '../agent-rollout';
import { NETWORKS, networkIdentity, type NetworkIdentity } from '../network-registry';
import { networkAllowed, type NetworkScope } from '../network-scope';
import { codeCapabilities, supportedAssets, type CodeCapability } from '../../engine/capability-catalog';
import { strategyRequiredFields, type NetworkId, type StrategyAction } from '../../engine/strategy-spec';

export const CAPABILITY_API_VERSION = 1;
export type CapabilityEligibility = {
  /** FloFi can author it (a canonical example composes on this network). */ readonly author: true;
  /** The execution capability registry's verdict for the network's public environment, on the composed example — code facts, not demonstrations. */
  readonly simulate: boolean; readonly review: boolean; readonly execute: boolean;
  /** Highest evidence the registry records as demonstrated for this exact path, or NONE_DEMONSTRATED. */ readonly demonstratedEvidence: string;
  /** Deployment enablement is a runtime fact: the hosted runtime decides it at Review (MCP `get_capabilities` reports it per deployment). */
  readonly deployment: 'DECIDED_BY_RUNTIME_AT_REVIEW';
};
export type ActionAssets =
  | { readonly kind: 'OFFICIAL_CATALOG'; readonly loaded: boolean; readonly examples: readonly string[] }
  | { readonly kind: 'LISTED'; readonly symbols: readonly string[] };
export type ActionCapability = {
  readonly action: StrategyAction; readonly assets: ActionAssets;
  /** Bridges: the destinations of certified Cross-chain Router routes from this network, with the route's source token. */
  readonly routes: readonly { readonly destination: string; readonly asset: string }[];
  readonly requiredParameters: readonly string[]; readonly eligibility: CapabilityEligibility; readonly limitations: readonly string[];
};
export type NetworkCapabilityProfile = {
  readonly version: typeof CAPABILITY_API_VERSION; readonly key: string; readonly name: string; readonly environment: 'MAINNET' | 'TESTNET';
  readonly family: 'EVM' | 'SOLANA'; readonly realFunds: boolean;
  /** PUBLIC: offered by the public product. ENGINEERING_ONLY: a test network kept for isolated certification (never in public suggestions). */
  readonly availability: 'PUBLIC' | 'ENGINEERING_ONLY';
  /** The universal Cross-chain Router connects this network to every other universal network (any known asset; the route is chosen live). */
  readonly universalBridge: boolean; readonly actions: readonly ActionCapability[];
};

const codeRows = new Map<NetworkScope, readonly CodeCapability[]>();
/** The registry verdicts are deterministic for a build; they are computed once per scope. */
function rows(scope: NetworkScope): readonly CodeCapability[] {
  if (!codeRows.has(scope)) codeRows.set(scope, codeCapabilities(scope));
  return codeRows.get(scope)!;
}
const familyOf = (network: NetworkIdentity): 'EVM' | 'SOLANA' => network.chain.startsWith('solana:') ? 'SOLANA' : 'EVM';
const universalKeys = (): readonly string[] => Object.keys(UNIVERSAL_NETWORKS);
const inScope = (scope: NetworkScope) => (network: NetworkIdentity | null) => !network || networkAllowed(network.key, scope);
const scopedCapabilities = (scope: NetworkScope): readonly AuthoringCapability[] => AUTHORING_CAPABILITIES.filter(capability =>
  inScope(scope)(capability.network) && inScope(scope)(capability.destination) && agentRolloutAllows(capability.action, capability.network.key));

function eligibility(scope: NetworkScope, action: StrategyAction, network: string): CapabilityEligibility {
  const row = rows(scope).find(item => item.action === action && item.network === network);
  return { author: true, simulate: Boolean(row?.supportedByCode.SIMULATE), review: Boolean(row?.supportedByCode.REVIEW),
    execute: Boolean(row?.ownerWalletExecutionImplemented), demonstratedEvidence: row?.demonstratedEvidence ?? 'NONE_DEMONSTRATED', deployment: 'DECIDED_BY_RUNTIME_AT_REVIEW' };
}
function assetsOf(scope: NetworkScope, network: NetworkIdentity, action: StrategyAction, capabilities: readonly AuthoringCapability[]): ActionAssets {
  const bound = [...new Set(capabilities.filter(capability => capability.asset !== null).map(capability => capability.asset!))];
  if (bound.length && action !== 'transfer') return { kind: 'LISTED', symbols: bound };
  if (network.catalog && (action === 'swap' || action === 'add_liquidity' || action === 'transfer'))
    return { kind: 'OFFICIAL_CATALOG', loaded: officialCatalogLoaded(network.chain), examples: declaredNetworkSymbols(network.chain).slice(0, 8) };
  const listed = supportedAssets(scope, network.key as NetworkId).filter(asset => asset.actions.includes(action)).map(asset => asset.symbol);
  return { kind: 'LISTED', symbols: [...new Set(listed)] };
}
function limitationsOf(network: NetworkIdentity, action: StrategyAction): string[] {
  const out: string[] = [];
  if (network.environment === 'MAINNET') out.push('REAL_FUNDS');
  const policy = (AAVE_V3_AMOUNT_POLICY as Readonly<Record<string, string>>)[action];
  if (policy === 'PARTIAL_ONLY') out.push('PARTIAL_AMOUNTS_ONLY');
  if (pendingAgentCapability(action, network.key)) out.push('AGENT_ROLLOUT_PENDING_OWNER_APPROVAL');
  if (network.catalog && (action === 'swap' || action === 'add_liquidity' || action === 'transfer')) out.push('ASSET_MUST_BE_IN_OFFICIAL_CATALOG');
  if (action === 'add_liquidity') out.push('NOT_A_SEQUENCE_STEP');
  if (action === 'lending_composition') out.push('FIXED_COMPOSITION_ONLY');
  return out;
}

/** Every network of `scope` with its actions (in network registry order); test networks only in engineering certification. */
export function networkCapabilityProfiles(scope: NetworkScope): readonly NetworkCapabilityProfile[] {
  const capabilities = scopedCapabilities(scope);
  return NETWORKS.filter(network => inScope(scope)(network) && capabilities.some(capability => capability.network === network || capability.destination === network))
    .map(network => {
      const own = capabilities.filter(capability => capability.network === network);
      const actions = [...new Set(own.map(capability => capability.action))].map((action): ActionCapability => {
        const ofAction = own.filter(capability => capability.action === action);
        return { action, assets: assetsOf(scope, network, action, ofAction),
          routes: action === 'bridge' ? ofAction.filter(capability => capability.destination).map(capability => ({ destination: capability.destination!.name, asset: capability.asset ?? '' })) : [],
          requiredParameters: strategyRequiredFields(action), eligibility: eligibility(scope, action, network.key), limitations: limitationsOf(network, action) };
      });
      return { version: CAPABILITY_API_VERSION, key: network.key, name: network.name, environment: network.environment, family: familyOf(network),
        realFunds: network.environment === 'MAINNET', availability: network.environment === 'MAINNET' ? 'PUBLIC' : 'ENGINEERING_ONLY',
        universalBridge: universalKeys().includes(network.key) && network.environment === 'MAINNET', actions };
    });
}
/** One network's profile (by registry key, CAIP-2 chain, name or alias), or null when it is unknown or outside `scope`. */
export function networkCapabilityProfile(scope: NetworkScope, value: string): NetworkCapabilityProfile | null {
  const identity = networkIdentity(value);
  return identity ? networkCapabilityProfiles(scope).find(profile => profile.key === identity.key) ?? null : null;
}
/** Why `action` cannot be authored on a network in `scope`, or null when it can. Codes only; the caller writes the sentence. */
export type CapabilityGap = 'NETWORK_UNKNOWN' | 'TEST_NETWORK_NOT_AVAILABLE' | 'ACTION_NOT_ON_NETWORK' | 'AGENT_ROLLOUT_NOT_APPROVED';
export function capabilityGap(scope: NetworkScope, action: StrategyAction, value: string): CapabilityGap | null {
  const identity = networkIdentity(value);
  if (!identity || !NETWORKS.includes(identity)) return 'NETWORK_UNKNOWN';
  if (!networkAllowed(identity.key, scope)) return 'TEST_NETWORK_NOT_AVAILABLE';
  if (!agentRolloutAllows(action, identity.key) && AUTHORING_CAPABILITIES.some(capability => capability.action === action && capability.network === identity)) return 'AGENT_ROLLOUT_NOT_APPROVED';
  return networkCapabilityProfile(scope, identity.key)?.actions.some(item => item.action === action) ? null : 'ACTION_NOT_ON_NETWORK';
}
/** The networks of `scope` where `action` can be authored, by name. */
export const networksWith = (scope: NetworkScope, action: StrategyAction): readonly string[] =>
  networkCapabilityProfiles(scope).filter(profile => profile.actions.some(item => item.action === action)).map(profile => profile.name);
/** Universal bridge networks of `scope` (mainnets only; engineering keeps the same five). */
export const universalBridgeNetworks = (scope: NetworkScope): readonly string[] =>
  networkCapabilityProfiles(scope).filter(profile => profile.universalBridge).map(profile => profile.key);
