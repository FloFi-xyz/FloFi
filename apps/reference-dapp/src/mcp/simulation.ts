// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: which existing flow previews a strategy, and the allowlisted view of its result.
 *
 * The preview is the flow's unchanged simulation (`backend/preview.ts`). Its record contains executable material — calldata,
 * unsigned transactions, nonces, the ephemeral run id and the Review commitment — none of which may reach an MCP client: a
 * model holding calldata could route around Review and the owner's wallet. The view is therefore built only from explicit
 * per-flow fact allowlists plus the canonical Simulation Bundle, Authorization Policy and Strategy Manifest validated against
 * their schemas (which carry hashes and 4-byte selectors, never payloads). `assertSafeOutput` is the last line: any key or
 * value shaped like a transaction, calldata, signature or key fails the call closed.
 */
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { ETHEREUM_ROUTER_NETWORKS } from '@defi-workflow-engine/action-registry';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import type { FlowName } from '../../backend/flows.ts';
import { catalogNetworkOfChain } from '../server/catalog-networks.ts';
import { networkIdentity } from '../domain/network-registry.ts';
import type { StrategySpec } from '../engine/strategy-spec';
import { isUniversalBridgeSpec } from '../engine/strategy-engine';
import { UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';

export type PreviewPlan = { readonly flow: FlowName; readonly subject: 'EVM' | 'SOLANA' | 'NONE';
  /** BUILD-CROSSCHAIN-UNIVERSAL-001: a Solana ⇄ EVM bridge previews with the destination ecosystem's public quote subject as recipient (read-only). */
  readonly destinationSubject?: 'EVM' | 'SOLANA' };
/** The flow that previews a strategy, or the reason MCP cannot preview it. */
export function previewPlan(spec: StrategySpec): PreviewPlan | { readonly code: string } {
  switch (spec.action) {
    case 'bridge': {
      // BUILD-CROSSCHAIN-UNIVERSAL-001: every non-certified mainnet bridge previews on the universal router's own simulation.
      if (isUniversalBridgeSpec(spec)) {
        const source = UNIVERSAL_NETWORKS[spec.sourceNetwork as UniversalNetworkKey], destination = UNIVERSAL_NETWORKS[spec.destinationNetwork as UniversalNetworkKey];
        return { flow: 'crosschain-universal', subject: source.ecosystem === 'SOLANA' ? 'SOLANA' : 'EVM',
          ...source.ecosystem !== destination.ecosystem && spec.recipient === undefined ? { destinationSubject: destination.ecosystem === 'SOLANA' ? 'SOLANA' : 'EVM' } : {} };
      }
      const ethereumRoute = ETHEREUM_ROUTER_NETWORKS.find(route => {
        const [source, destination] = route.split('-to-');
        const key = (network: string) => network === 'arbitrum-one' ? 'arbitrum' : network;
        return source === key(spec.sourceNetwork) && destination === key(spec.destinationNetwork);
      });
      if (ethereumRoute) return { flow: `crosschain-router-${ethereumRoute}`, subject: 'EVM' };
      // BUILD-RH-002: each Robinhood Chain route is its own router flow; BUILD-BASE-001 so is Arbitrum One → Base.
      const robinhood = { 'base>robinhood': 'crosschain-router-base-to-robinhood', 'robinhood>base': 'crosschain-router-robinhood-to-base',
        'arbitrum-one>robinhood': 'crosschain-router-arbitrum-to-robinhood', 'robinhood>arbitrum-one': 'crosschain-router-robinhood-to-arbitrum',
        'arbitrum-one>base': 'crosschain-router-arbitrum-to-base' } as const;
      const route = robinhood[`${spec.sourceNetwork}>${spec.destinationNetwork}` as keyof typeof robinhood];
      return { flow: route ?? (spec.sourceNetwork === 'base' ? 'crosschain-router' : 'crosschain-router-testnet'), subject: 'EVM' };
    }
    // BUILD-SOLANA-TRANSFER-UX-001: a Solana transfer previews against the sender's public balances (the simulation subject); FloFi re-simulates
    // with the actual signing wallet before any Review. EVM transfers bind the connected owner, so they still need the owner's browser.
    case 'transfer': return spec.network === 'solana' ? { flow: 'solana-transfer', subject: 'SOLANA' } : spec.network === 'solana-devnet'
      ? { flow: 'solana-devnet-transfer', subject: 'SOLANA' } : { code: 'SIMULATION_REQUIRES_OWNER_BROWSER' };
    case 'swap':
      // BUILD-BASE-001: Base mainnet swaps (the USDC ⇄ WETH reference pair included) quote on the Base catalog-network swap flow.
      { const network = catalogNetworkOfChain(networkIdentity(spec.network)?.chain);
        if (network) return { flow: network.flows.swap, subject: 'NONE' }; }
      if (spec.network === 'solana') return { flow: 'jupiter-swap', subject: 'SOLANA' };
      if (spec.network === 'solana-devnet') return { flow: 'solana-devnet-swap', subject: 'SOLANA' };
      return { flow: 'base-sepolia-swap', subject: 'NONE' };
    case 'supply': case 'borrow': case 'repay': case 'withdraw': return { flow: catalogNetworkOfChain(networkIdentity(spec.network)?.chain)?.flows.lending ?? 'aave-supply', subject: 'EVM' };
    // Orca positions need a position-mint key generated in the owner's browser; there is nothing to preview without it.
    case 'add_liquidity': return spec.network === 'solana-devnet' || spec.network === 'solana' ? { code: 'SIMULATION_REQUIRES_OWNER_BROWSER' }
      : { flow: spec.network === 'robinhood' ? 'robinhood-liquidity' : catalogNetworkOfChain(networkIdentity(spec.network)?.chain)?.flows.liquidity ?? 'uniswap-liquidity', subject: 'EVM' };
    case 'lending_composition': return { flow: 'lending-composition', subject: 'EVM' };
  }
}
/** The flow enablement that governs a strategy even when MCP cannot preview it (for capability reporting). */
export function strategyFlow(spec: StrategySpec): FlowName | null {
  const plan = previewPlan(spec);
  if ('flow' in plan) return plan.flow;
  return spec.action === 'add_liquidity' ? spec.network === 'solana' ? 'orca-liquidity-mainnet' : 'orca-liquidity' : spec.action === 'transfer'
    ? spec.network === 'ethereum-sepolia' || spec.network === 'robinhood-testnet' ? 'robinhood-transfer'
      : catalogNetworkOfChain(networkIdentity(spec.network)?.chain)?.flows.transfer ?? null : null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new Error('MCP_SIMULATION_PROJECTION_FAILED'); };
const obj = (value: unknown): Record<string, unknown> => isObject(value) ? value : fail();
/** Copies exactly `keys` whose values are scalars (or null); anything else is dropped, never copied by reference. */
function pick(value: unknown, keys: readonly string[]): Record<string, Json> {
  const source = obj(value), out: Record<string, Json> = {};
  for (const key of keys) {
    const v = source[key];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
const list = (value: unknown, keys: readonly string[]): Record<string, Json>[] => Array.isArray(value) ? value.slice(0, 64).map(item => pick(item, keys)) : [];
const hash = (kind: 'simulation-bundle' | 'authorization-policy' | 'strategy-manifest', value: unknown) =>
  hashArtifactBytes(kind, new TextEncoder().encode(JSON.stringify(value)));

/** The canonical artifacts of a review, each re-validated against its schema; absent or invalid ones are omitted, never repaired. */
function canonicalArtifacts(source: unknown): Record<string, Json> | null {
  if (!isObject(source)) return null;
  const out: Record<string, Json> = {};
  for (const [field, kind, name] of [['simulation', 'simulation-bundle', 'simulationBundle'], ['policy', 'authorization-policy', 'authorizationPolicy'],
    ['manifest', 'strategy-manifest', 'strategyManifest']] as const) {
    try { const artifact = validateArtifact(kind, source[field]); out[name] = { hash: hash(kind, artifact), artifact: JSON.parse(JSON.stringify(artifact)) as Json }; }
    catch { /* not produced by this flow */ }
  }
  return Object.keys(out).length ? out : null;
}

export type SimulationView = { readonly kind: string; readonly provenance: string; readonly observedAt: string | null; readonly expiresAt: string | null;
  readonly facts: Record<string, Json>; readonly canonicalArtifacts: Record<string, Json> | null };
/** The allowlisted view of a flow's preview result. Throws `MCP_SIMULATION_PROJECTION_FAILED` on an unexpected shape. */
export function projectSimulation(flow: FlowName, value: unknown): SimulationView {
  const record = obj(value);
  switch (flow) {
    case 'crosschain-router': case 'crosschain-router-testnet': case 'crosschain-router-base-to-robinhood': case 'crosschain-router-robinhood-to-base':
    case 'crosschain-router-arbitrum-to-robinhood': case 'crosschain-router-robinhood-to-arbitrum': case 'crosschain-router-arbitrum-to-base':
    case 'crosschain-router-ethereum-to-base': case 'crosschain-router-base-to-ethereum':
    case 'crosschain-router-ethereum-to-arbitrum': case 'crosschain-router-arbitrum-to-ethereum':
    case 'crosschain-router-ethereum-to-robinhood': case 'crosschain-router-robinhood-to-ethereum': {
      const r = obj(record.review), quote = obj(r.quote), route = obj(r.route), simulation = obj(r.simulation);
      return { kind: 'CROSS_CHAIN_ROUTE', provenance: String(record.provenance), observedAt: String(r.observedAt), expiresAt: String(r.expiresAt),
        facts: { recipient: String(r.recipient), recipientKind: String(r.recipientKind),
          quote: { ...pick(quote, ['provider', 'expectedOutput', 'minimumOutput', 'feeTotal', 'estimatedDurationSeconds', 'quotedAt', 'expiresAt']),
            inputAmount: String(route.inputAmount), inputToken: pick(route.inputToken, ['chainId', 'address', 'decimals', 'symbol']),
            outputToken: pick(route.outputToken, ['chainId', 'address', 'decimals', 'symbol']) },
          providersConsidered: list(obj(r.selection).considered, ['provider', 'outcome', 'code', 'minimumOutput', 'feeTotal']),
          transactionSimulation: { ...pick(simulation, ['provenance', 'method', 'chainId', 'block', 'ownerDebit']),
            calls: list(simulation.calls, ['purpose', 'gasUsed']), notSimulated: Array.isArray(simulation.notSimulated) ? simulation.notSimulated.map(String) : [] },
          approvals: list(r.approvals, ['token', 'spender', 'amount', 'currentAllowance', 'required']),
          fees: pick(r.fees, ['maxFeePerGas', 'maxPriorityFeePerGas', 'gasLimitTotal', 'executionFeeUpperBoundWei', 'l1FeeUpperBoundWei', 'totalUpperBoundWei']),
          deadlines: pick(r.deadlines, ['reviewExpiresAt', 'quoteExpiresAt', 'depositMustLandBy', 'fillDeadline']) },
        canonicalArtifacts: canonicalArtifacts(r.artifacts) };
    }
    case 'crosschain-universal': {
      const r = obj(record.review), route = obj(r.route), source = obj(r.source), simulation = obj(source.simulation), quote = obj(route.quote);
      return { kind: 'CROSS_CHAIN_ROUTE', provenance: String(record.provenance), observedAt: String(r.observedAt), expiresAt: String(r.expiresAt),
        facts: { recipient: String(r.recipient), recipientKind: String(r.recipientKind),
          quote: { provider: String(route.provider), protocol: String(route.protocol), expectedOutput: String(route.expectedOutput), minimumOutput: String(route.minimumOutput),
            estimatedDurationSeconds: Number(quote.estimatedDurationSeconds), quotedAt: String(quote.quotedAt), expiresAt: String(quote.expiresAt),
            inputAmount: String(route.inputAmount), inputToken: pick(route.inputToken, ['chainId', 'kind', 'address', 'decimals', 'symbol']),
            outputToken: pick(route.outputToken, ['chainId', 'kind', 'address', 'decimals', 'symbol']) },
          providerFees: list(route.fees, ['kind', 'label', 'chainId', 'symbol', 'decimals', 'amount', 'included']),
          providersConsidered: list(obj(r.selection).considered, ['provider', 'outcome', 'code', 'expectedOutput', 'minimumOutput']),
          transactionSimulation: { ...pick(simulation, ['provenance', 'method', 'block', 'slot', 'ownerDebit', 'unitsConsumed']), ecosystem: String(source.ecosystem),
            calls: list(simulation.calls, ['purpose', 'gasUsed']), notSimulated: Array.isArray(simulation.notSimulated) ? simulation.notSimulated.map(String) : [] },
          approvals: list(source.approvals, ['token', 'spender', 'amount', 'currentAllowance', 'required']),
          feePolicy: pick(r.feePolicy, ['flofiFee', 'flofiFeeRateBps', 'flofiFeeBasis', 'flofiFeeCollection', 'networkFeeUpperBound', 'networkFeeSymbol', 'networkFeeDecimals']),
          authorizations: pick(r.authorizations, ['sourceSignatures', 'destinationAuthorization']),
          deadlines: pick(r.deadlines, ['reviewExpiresAt', 'quoteExpiresAt', 'orderDeadline']) },
        canonicalArtifacts: canonicalArtifacts(r.artifacts) };
    }
    case 'aave-supply': case 'base-aave': case 'arbitrum-aave': case 'ethereum-aave': {
      const r = obj(record.review), operation = r.withdraw ? 'WITHDRAW' : r.repay ? 'REPAY' : r.borrow ? 'BORROW' : 'SUPPLY';
      return { kind: 'AAVE_V3', provenance: String(record.provenance), observedAt: String(obj(r.state).observedAt), expiresAt: String(r.expiresAt),
        facts: { operation, ...pick(r, ['chain', 'pool', 'asset', 'aToken', 'amount', 'beneficiary', 'approvalRequired', 'allowance', 'gasPrice']),
          gasLimits: Array.isArray(r.gasLimits) ? r.gasLimits.map(String) : [],
          state: pick(r.state, ['block', 'balance', 'nativeBalance', 'position', 'allowance']),
          projected: pick(r.withdraw ?? r.repay ?? r.borrow ?? {}, ['expectedPostHealthFactor', 'debtAfter', 'debtAfterBase', 'collateralAfter', 'walletAfter']) },
        canonicalArtifacts: canonicalArtifacts(r) };
    }
    case 'base-sepolia-swap': case 'robinhood-swap': case 'base-swap': case 'arbitrum-swap': case 'ethereum-swap': {
      const q = obj(record.quote);
      // BUILD-RH-002: a catalog-network quote (Robinhood Chain, BUILD-BASE-001 Base) carries its own provenance (PUBLIC_MAINNET or MOCKED) and decimals;
      // Robinhood Chain quotes also carry the Stock Token multipliers.
      return { kind: 'SWAP_QUOTE', provenance: flow === 'base-sepolia-swap' ? 'PUBLIC_TESTNET' : String(q.provenance), observedAt: String(q.observedAt), expiresAt: String(q.expiresAt),
        facts: { ...pick(q, ['chainId', 'inputToken', 'outputToken', 'inputSymbol', 'outputSymbol', 'amountIn', 'expectedOut', 'minimumOut', 'slippageBps', 'pool', 'fee',
          'blockNumber', 'estimatedGas', 'inputDecimals', 'outputDecimals',
          // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: which side is the network's native ETH (its token is the EIP-7528 marker, never WETH9), or a WETH9 wrap/unwrap.
          'native', 'conversion']),
          ...flow === 'robinhood-swap' ? { stocks: list(q.stocks, ['side', 'symbol', 'officialId', 'multiplierWad', 'scheduledMultiplierWad', 'scheduledEffectiveAt']) } : {} },
        canonicalArtifacts: null };
    }
    case 'uniswap-liquidity': case 'robinhood-liquidity': case 'base-liquidity': case 'arbitrum-liquidity': case 'ethereum-liquidity': {
      const r = obj(record.review);
      return { kind: 'CONCENTRATED_LIQUIDITY', provenance: String(record.provenance), observedAt: String(r.observedAt), expiresAt: String(r.expiresAt),
        facts: { ...pick(r, ['network', 'chainId', 'recipient', 'deadline']), pool: pick(r.pool, ['fee', 'tickSpacing', 'tick', 'price']),
          range: pick(r.range, ['tickLower', 'tickUpper', 'lowerPrice', 'upperPrice', 'state', 'description']),
          intent: pick(r.intent, ['amount0Max', 'amount1Max', 'slippageBps']), expected: pick(r.expected, ['liquidity', 'amount0', 'amount1']),
          minimums: pick(r.minimums, ['amount0Min', 'amount1Min']), balances: pick(r.balances, ['token0', 'token1', 'native']),
          approvals: list(r.approvals, ['step', 'token', 'symbol', 'spender', 'amount', 'currentAllowance', 'required']),
          fees: pick(r.fees, ['maxFeePerGas', 'maxPriorityFeePerGas', 'gasLimitTotal', 'executionFeeUpperBoundWei', 'l1FeeUpperBoundWei', 'totalUpperBoundWei']) },
        canonicalArtifacts: null };
    }
    case 'jupiter-swap': case 'solana-devnet-swap': {
      const r = obj(record.review), simulation = obj(r.simulationResult);
      return { kind: 'SOLANA_SWAP', provenance: String(record.provenance), observedAt: String(obj(r.quote).fetchedAt), expiresAt: String(r.expiresAt),
        facts: { ...pick(r, ['chain', 'cluster', 'amount', 'slippageBps', 'estimatedFeeLamports']), inputToken: pick(r.input, ['symbol', 'mint', 'decimals']),
          outputToken: pick(r.output, ['symbol', 'mint', 'decimals']), quote: pick(r.quote, ['inAmount', 'outAmount', 'otherAmountThreshold', 'priceImpactPct', 'slippageBps', 'fetchedAt']),
          simulation: pick(simulation, ['slot', 'unitsConsumed', 'inputSpent', 'outputReceived', 'accountCreationLamports', 'feeLamports']) },
        canonicalArtifacts: canonicalArtifacts(r) };
    }
    case 'solana-transfer': case 'solana-devnet-transfer': {
      const r = obj(record.review), simulation = obj(r.simulationResult);
      return { kind: 'SOLANA_TRANSFER', provenance: String(record.provenance), observedAt: String(obj(obj(r.simulation).freshness).observedAt), expiresAt: String(r.expiresAt),
        facts: { ...pick(r, ['chain', 'cluster', 'network', 'owner', 'recipient', 'amount', 'estimatedFeeLamports', 'accountCreationLamports', 'maximumAccountCreationLamports', 'maximumNetworkCostLamports']),
          asset: pick(r.asset, ['symbol', 'mint', 'decimals', 'program', 'verified']),
          token: r.token ? { ...pick(r.token, ['program', 'mint', 'decimals', 'createDestination', 'sourceAmount', 'destinationAmount']),
            extensions: Array.isArray(obj(r.token).extensions) ? (obj(r.token).extensions as unknown[]).map(Number).slice(0, 32) : [] } : null,
          simulation: pick(simulation, ['slot', 'unitsConsumed', 'ownerLamportsBefore', 'ownerLamportsAfter', 'recipientLamportsBefore', 'recipientLamportsAfter',
            'sourceAmountBefore', 'sourceAmountAfter', 'destinationAmountBefore', 'destinationAmountAfter', 'accountCreationLamports', 'feeLamports']) },
        canonicalArtifacts: canonicalArtifacts(r) };
    }
    case 'lending-composition': {
      const r = obj(Array.isArray(record.reviews) ? record.reviews[0] : null), fields = obj(r.fields);
      return { kind: 'LENDING_COMPOSITION', provenance: String(record.provenance), observedAt: null, expiresAt: String(r.expiresAt),
        facts: { ...pick(fields, ['chain', 'supplyAmount', 'borrowAmount', 'slippageBps', 'owner']), ...pick(r, ['gasPrice', 'gasBudget', 'l1FeeUpperBound']),
          steps: Array.isArray(r.calls) ? r.calls.map(c => String(obj(c).id)).slice(0, 16) : [] },
        canonicalArtifacts: canonicalArtifacts(r) };
    }
    default: return fail();
  }
}

/** Keys that only executable material, secrets or wallet internals use. */
const FORBIDDEN_KEY = /^(data|calldata|tx|txs|transaction|transactions|unsignedtransaction|signedtransaction|rawtransaction|serializedtransaction|signature|signatures|privatekey|secret|mnemonic|seed|seedphrase|commitment|apikey|accesstoken|bearer)$/i;
/**
 * Fails closed when an MCP result contains anything executable or secret: forbidden keys, hex payloads longer than a hash
 * (66 chars), or long base64 blobs (serialized transactions). Hashes, addresses, selectors and mints pass.
 */
export function assertSafeOutput(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('MCP_OUTPUT_GUARD');
  if (typeof value === 'string') {
    if (/0x[0-9a-fA-F]{67,}/.test(value) || /^[A-Za-z0-9+/]{200,}={0,2}$/.test(value)) throw new Error('MCP_OUTPUT_GUARD');
    // BUILD-MCP-002: OAuth access/refresh tokens, codes and consent tokens never appear in a tool result.
    // BUILD-DEVELOPER-001: nor a Developer API key or a webhook signing secret (the one response that issues a secret checks it apart).
    if (/flofi_(at|rt|code|csrf|sk)_[A-Za-z0-9_-]/.test(value) || /whsec_[A-Za-z0-9+/]/.test(value)) throw new Error('MCP_OUTPUT_GUARD');
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertSafeOutput(item, depth + 1); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error('MCP_OUTPUT_GUARD');
    assertSafeOutput(item, depth + 1);
  }
}
