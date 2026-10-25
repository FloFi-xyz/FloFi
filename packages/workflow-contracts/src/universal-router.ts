// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router contract — any of the five FloFi mainnets (Solana, Base,
 * Arbitrum One, Ethereum, Robinhood Chain) as source or destination, any provider-supported asset on either side.
 *
 * Intent lives in the canonical `asset.bridge` node with adapter `flofi.router.universal`: chains, input and output assets,
 * amount, recipient, slippage, the allowed routing providers in preference order and the route selection policy. The node is
 * a closed declaration (it must equal the canonical construction of its own fields). A route is never intent: it is a
 * provider answer normalized into `flofi.universal-route.v1`, verified by the provider's adapter (order hash, transaction
 * bytes, accounts) and bound by its commitment into the Review and the owner's authorization.
 *
 * The BUILD-ROUTER-001 adapter (`flofi.router`, `router.ts`) is unchanged: its pairs, saved workflows and run logs keep
 * their meaning; this contract is additive.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { BRIDGE_ACTION } from './bridge.js';
import type { SemanticWorkflow } from './semantic-workflow.js';
import type { RouteChange } from './router.js';
import { canonicalUniversalAddress, canonicalUniversalToken, UNIVERSAL_ROUTE_SELECTIONS, UNIVERSAL_ROUTER_ADAPTER, UNIVERSAL_ROUTER_CAPABILITY,
  UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS, UNIVERSAL_ROUTING_PROVIDERS, universalNetworkOfChain, type UniversalNetwork, type UniversalRouteSelection,
  type UniversalRoutingProvider } from './universal-router-networks.js';

export * from './universal-router-networks.js';

const UNITS = /^(0|[1-9][0-9]{0,77})$/, HASH = /^0x[0-9a-f]{64}$/, HEX = /^0x(?:[0-9a-f]{2})*$/;
const U64_MAX = (1n << 64n) - 1n, U256_MAX = (1n << 256n) - 1n;
const fail = (code: string): never => { throw new Error(code); };
type Node = SemanticWorkflow['nodes'][number];

// ---------------------------------------------------------------------------------------------------------------
// Canonical IR node
// ---------------------------------------------------------------------------------------------------------------

/** A native coin (ETH, SOL) or a token contract / SPL mint on the node's network. Decimals are verified on chain at simulation. */
export type UniversalAssetRef = { readonly kind: 'NATIVE'; readonly decimals: number } | { readonly kind: 'TOKEN'; readonly address: string; readonly decimals: number };
/**
 * `CONNECTED_OWNER`: the signing wallet, when source and destination share an ecosystem. `CONNECTED_DESTINATION_WALLET`: across
 * ecosystems (Solana ⇄ EVM), the owner's wallet of the destination ecosystem, connected in the FloFi app and bound as an explicit
 * address at Review. Otherwise an explicit destination-chain address.
 */
export type UniversalRecipient = 'CONNECTED_OWNER' | 'CONNECTED_DESTINATION_WALLET' | string;
export type UniversalBridgeFields = {
  readonly sourceChain: string; readonly destinationChain: string; readonly inputAsset: UniversalAssetRef; readonly outputAsset: UniversalAssetRef;
  readonly amount: string; readonly recipient: UniversalRecipient; readonly slippageBps: number;
  readonly providers: readonly UniversalRoutingProvider[]; readonly selection: UniversalRouteSelection;
};

export function validateUniversalProviders(providers: readonly string[]): readonly UniversalRoutingProvider[] {
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > UNIVERSAL_ROUTING_PROVIDERS.length ||
      new Set(providers).size !== providers.length || providers.some(p => !(UNIVERSAL_ROUTING_PROVIDERS as readonly string[]).includes(p)))
    fail('UNIVERSAL_PROVIDER_POLICY_INVALID');
  return providers as readonly UniversalRoutingProvider[];
}
const networkOf = (chain: string, code: string): UniversalNetwork => universalNetworkOfChain(chain) ?? fail(code);
function assetRef(network: UniversalNetwork, value: UniversalAssetRef, code: string): UniversalAssetRef {
  if (!value || !Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > 36) fail(code);
  if (value.kind === 'NATIVE') { if (value.decimals !== network.native.decimals) fail(code); return { kind: 'NATIVE', decimals: value.decimals }; }
  if (value.kind !== 'TOKEN') fail(code);
  return { kind: 'TOKEN', address: canonicalUniversalToken(network, value.address, code), decimals: value.decimals };
}
const irAsset = (network: UniversalNetwork, asset: UniversalAssetRef) => asset.kind === 'NATIVE'
  ? { chainId: network.chain, nativeId: network.native.nativeId, decimals: asset.decimals } : { chainId: network.chain, address: asset.address, decimals: asset.decimals };
/** The largest amount a network's transfers can carry (SPL and lamport amounts are u64; EVM uint256). */
export const universalAmountCeiling = (network: UniversalNetwork): bigint => network.ecosystem === 'SOLANA' ? U64_MAX : U256_MAX;

export function createUniversalBridgeNode(nodeId: string, fields: UniversalBridgeFields): Node {
  const source = networkOf(fields.sourceChain, 'UNIVERSAL_SOURCE_NETWORK_UNSUPPORTED'), destination = networkOf(fields.destinationChain, 'UNIVERSAL_DESTINATION_NETWORK_UNSUPPORTED');
  if (source.chain === destination.chain) fail('UNIVERSAL_SAME_NETWORK');
  const input = assetRef(source, fields.inputAsset, 'UNIVERSAL_INPUT_ASSET_INVALID'), output = assetRef(destination, fields.outputAsset, 'UNIVERSAL_OUTPUT_ASSET_INVALID');
  if (typeof fields.amount !== 'string' || !UNITS.test(fields.amount) || BigInt(fields.amount) < 1n || BigInt(fields.amount) > universalAmountCeiling(source))
    fail('UNIVERSAL_AMOUNT_OUT_OF_RANGE');
  if (!Number.isSafeInteger(fields.slippageBps) || fields.slippageBps < 1 || fields.slippageBps > UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS) fail('UNIVERSAL_SLIPPAGE_OUT_OF_RANGE');
  const crossEcosystem = source.ecosystem !== destination.ecosystem;
  let recipient: Node['inputs'][number];
  if (fields.recipient === 'CONNECTED_OWNER') {
    if (crossEcosystem) fail('UNIVERSAL_RECIPIENT_REQUIRED_ACROSS_ECOSYSTEMS');
    recipient = { name: 'recipient', kind: 'IDENTIFIER', value: 'CONNECTED_OWNER' };
  } else if (fields.recipient === 'CONNECTED_DESTINATION_WALLET') {
    if (!crossEcosystem) fail('UNIVERSAL_RECIPIENT_INVALID');
    recipient = { name: 'recipient', kind: 'IDENTIFIER', value: 'CONNECTED_DESTINATION_WALLET' };
  } else recipient = { name: 'recipient', kind: 'ACCOUNT', value: { chainId: destination.chain,
    address: canonicalUniversalAddress(destination, fields.recipient, 'UNIVERSAL_RECIPIENT_INVALID') } };
  const providers = validateUniversalProviders(fields.providers);
  if (!(UNIVERSAL_ROUTE_SELECTIONS as readonly string[]).includes(fields.selection)) fail('UNIVERSAL_ROUTE_SELECTION_INVALID');
  const inAsset = irAsset(source, input), outAsset = irAsset(destination, output), quantity = { asset: inAsset, amount: fields.amount };
  return { nodeId, actionType: BRIDGE_ACTION, actionSchemaVersion: '1.0.0', chainId: source.chain, requiredCapabilities: [UNIVERSAL_ROUTER_CAPABILITY],
    adapterConstraints: { adapters: [{ ...UNIVERSAL_ROUTER_ADAPTER }], protocols: [...providers] },
    inputs: [{ name: 'amount-in', kind: 'QUANTITY', value: quantity }, { name: 'asset-out', kind: 'ASSET', value: outAsset }, recipient,
      { name: 'route-selection', kind: 'IDENTIFIER', value: fields.selection }],
    expectedOutputs: [{ outputId: 'amount-out', asset: outAsset, minimumAmount: '0' }], dependencies: [],
    userConstraints: [{ kind: 'MAXIMUM_INPUT', quantity }, { kind: 'MAXIMUM_SLIPPAGE_BPS', maximumBps: fields.slippageBps }],
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [],
    editableBounds: [{ parameterName: 'amount-in', asset: inAsset, minimumAmount: '1', maximumAmount: universalAmountCeiling(source).toString() }] };
}
export const isUniversalBridgeNode = (node: { readonly actionType: string; readonly adapterConstraints: { readonly adapters: readonly { readonly id: string }[] } }) =>
  node.actionType === BRIDGE_ACTION && node.adapterConstraints.adapters.length === 1 && node.adapterConstraints.adapters[0]!.id === UNIVERSAL_ROUTER_ADAPTER.id;
const refOf = (asset: Record<string, unknown>): UniversalAssetRef => 'nativeId' in asset
  ? { kind: 'NATIVE', decimals: asset.decimals as number } : { kind: 'TOKEN', address: asset.address as string, decimals: asset.decimals as number };
/** Closed declaration: the node must be exactly the canonical construction of its own fields. */
export function readUniversalBridgeNode(node: Node): UniversalBridgeFields {
  if (!isUniversalBridgeNode(node)) fail('UNIVERSAL_NODE_INVALID');
  const amount = node.inputs.find(p => p.name === 'amount-in'), out = node.inputs.find(p => p.name === 'asset-out');
  const recipient = node.inputs.find(p => p.name === 'recipient'), selection = node.inputs.find(p => p.name === 'route-selection');
  const slip = node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
  if (amount?.kind !== 'QUANTITY' || out?.kind !== 'ASSET' || selection?.kind !== 'IDENTIFIER' || slip?.kind !== 'MAXIMUM_SLIPPAGE_BPS' || !recipient)
    return fail('UNIVERSAL_NODE_INVALID');
  let recipientValue: UniversalRecipient;
  if (recipient.kind === 'IDENTIFIER' && (recipient.value === 'CONNECTED_OWNER' || recipient.value === 'CONNECTED_DESTINATION_WALLET')) recipientValue = recipient.value;
  else if (recipient.kind === 'ACCOUNT' && recipient.value.chainId === out.value.chainId) recipientValue = recipient.value.address;
  else return fail('UNIVERSAL_RECIPIENT_INVALID');
  const fields: UniversalBridgeFields = { sourceChain: node.chainId, destinationChain: out.value.chainId, inputAsset: refOf(amount.value.asset as Record<string, unknown>),
    outputAsset: refOf(out.value as Record<string, unknown>), amount: amount.value.amount, recipient: recipientValue, slippageBps: slip.maximumBps,
    providers: node.adapterConstraints.protocols as UniversalRoutingProvider[], selection: selection.value as UniversalRouteSelection };
  let rebuilt: Node;
  try { rebuilt = createUniversalBridgeNode(node.nodeId, fields); } catch (cause) { throw cause instanceof Error ? cause : new Error('UNIVERSAL_NODE_INVALID'); }
  if (canonicalJson(node) !== canonicalJson(rebuilt)) fail('UNIVERSAL_DECLARATION_INVALID');
  return fields;
}
/** The one isolated universal bridge node of a workflow, or throws. */
export function validateUniversalBridgeWorkflow(workflow: SemanticWorkflow): UniversalBridgeFields & { readonly nodeId: string } {
  const node = workflow.nodes[0];
  if (workflow.nodes.length !== 1 || workflow.resourceEdges.length !== 0 || !node || node.dependencies.length !== 0) fail('UNIVERSAL_ISOLATED_ONLY');
  return { ...readUniversalBridgeNode(node!), nodeId: node!.nodeId };
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical route model
// ---------------------------------------------------------------------------------------------------------------

export type UniversalToken = { readonly chainId: string; readonly kind: 'NATIVE' | 'TOKEN'; readonly address: string | null; readonly decimals: number; readonly symbol: string };
/**
 * `included`: deducted inside the quote (the expected output is already net of it). Not included: paid separately by the
 * owner (the source network fee, in the source chain's native coin).
 */
export type UniversalRouteFeeKind = 'RELAYER_SERVICE' | 'RELAYER_DESTINATION_GAS' | 'INTEGRATOR_THIRD_PARTY' | 'BRIDGE_OTHER' | 'SOURCE_NETWORK_FEE';
export type UniversalRouteFee = { readonly kind: UniversalRouteFeeKind; readonly label: string; readonly chainId: string; readonly token: string;
  readonly decimals: number; readonly symbol: string; readonly amount: string; readonly included: boolean; readonly recipient: string | null };
export type UniversalRouteStep = { readonly kind: 'BRIDGE' | 'DESTINATION_SWAP'; readonly protocol: string; readonly fromChain: string; readonly toChain: string;
  readonly fromToken: string; readonly toToken: string; readonly amountIn: string; readonly amountOut: string };
export type UniversalSolanaAccount = { readonly pubkey: string; readonly isSigner: boolean; readonly isWritable: boolean };
export type UniversalRouteSource =
  | { readonly ecosystem: 'EVM'; readonly chainId: string;
      /** The exact allowance the deposit needs (token deposits); null for a native deposit. */
      readonly approval: { readonly token: string; readonly spender: string; readonly amount: string } | null;
      readonly deposit: { readonly to: string; readonly data: string; readonly value: string } }
  | { readonly ecosystem: 'SOLANA'; readonly chainId: string;
      readonly instruction: { readonly programId: string; readonly accounts: readonly UniversalSolanaAccount[]; readonly data: string } };
/** The provider order the source deposit commits to (Relay protocol v2: `orderId` = EIP-712 hashStruct of `orderData`). */
export type UniversalRouteOrder = { readonly kind: 'RELAY_V2'; readonly orderId: string; readonly orderData: Readonly<Record<string, unknown>>;
  readonly solver: string; readonly deadline: number; readonly depository: string;
  readonly refunds: readonly { readonly chainId: string; readonly recipient: string; readonly currency: string }[] };
export type UniversalRoute = {
  readonly format: 'flofi.universal-route.v1';
  readonly provider: UniversalRoutingProvider; readonly protocol: string;
  readonly sourceChain: string; readonly destinationChain: string; readonly inputToken: UniversalToken; readonly outputToken: UniversalToken;
  readonly inputAmount: string; readonly expectedOutput: string; readonly minimumOutput: string; readonly slippageBps: number;
  readonly depositor: string; readonly recipient: string; readonly refundAddress: string;
  readonly steps: readonly UniversalRouteStep[]; readonly fees: readonly UniversalRouteFee[];
  readonly source: UniversalRouteSource; readonly order: UniversalRouteOrder;
  /** What else the owner must do on the destination chain. Relay delivers without any destination transaction. */
  readonly destination: { readonly additionalAuthorization: 'NONE' };
  readonly quote: { readonly id: string; readonly rawHash: string; readonly quotedAt: string; readonly expiresAt: string; readonly estimatedDurationSeconds: number };
};

const FEE_KINDS: readonly UniversalRouteFeeKind[] = ['RELAYER_SERVICE', 'RELAYER_DESTINATION_GAS', 'INTEGRATOR_THIRD_PARTY', 'BRIDGE_OTHER', 'SOURCE_NETWORK_FEE'];
const isoTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const units = (value: unknown, code = 'UNIVERSAL_ROUTE_AMOUNT_INVALID'): string => typeof value === 'string' && UNITS.test(value) ? value : fail(code);
const symbolOk = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9.$+_-]{1,24}$/.test(value);
/** A token reference on a network: native (`address` null) or a canonical contract/mint. */
export function universalToken(value: UniversalToken, chainId: string, code = 'UNIVERSAL_ROUTE_TOKEN_INVALID'): UniversalToken {
  const network = networkOf(chainId, code);
  if (!value || value.chainId !== chainId || !Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > 36 || !symbolOk(value.symbol)) fail(code);
  if (value.kind === 'NATIVE') {
    if (value.address !== null || value.decimals !== network.native.decimals) fail(code);
    return { chainId, kind: 'NATIVE', address: null, decimals: value.decimals, symbol: value.symbol };
  }
  if (value.kind !== 'TOKEN') fail(code);
  return { chainId, kind: 'TOKEN', address: canonicalUniversalToken(network, value.address, code), decimals: value.decimals, symbol: value.symbol };
}
/** The asset reference a token denotes (what the IR node carries). */
export const universalAssetOf = (token: UniversalToken): UniversalAssetRef => token.kind === 'NATIVE'
  ? { kind: 'NATIVE', decimals: token.decimals } : { kind: 'TOKEN', address: token.address!, decimals: token.decimals };
const tokenKey = (token: UniversalToken) => token.address ?? 'native';
const sortByJson = <T,>(items: T[]) => items.sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);

/**
 * Validates and normalizes a universal route: every field typed and bounded, addresses canonical for their ecosystem, fee lines
 * in one deterministic order, minimum ≤ expected, the source transaction on the source chain. Protocol-specific proof (order hash,
 * calldata, derived accounts) is the provider adapter's job and happens before this.
 */
export function canonicalizeUniversalRoute(route: UniversalRoute): UniversalRoute {
  if (!route || route.format !== 'flofi.universal-route.v1') fail('UNIVERSAL_ROUTE_FORMAT_INVALID');
  const source = networkOf(route.sourceChain, 'UNIVERSAL_ROUTE_NETWORK_INVALID'), destination = networkOf(route.destinationChain, 'UNIVERSAL_ROUTE_NETWORK_INVALID');
  if (source.chain === destination.chain) fail('UNIVERSAL_ROUTE_NETWORK_INVALID');
  if (!(UNIVERSAL_ROUTING_PROVIDERS as readonly string[]).includes(route.provider)) fail('UNIVERSAL_ROUTE_PROVIDER_INVALID');
  if (typeof route.protocol !== 'string' || !/^[a-z0-9.-]{1,40}$/.test(route.protocol)) fail('UNIVERSAL_ROUTE_PROTOCOL_INVALID');
  const inputToken = universalToken(route.inputToken, source.chain), outputToken = universalToken(route.outputToken, destination.chain);
  const inputAmount = units(route.inputAmount), expectedOutput = units(route.expectedOutput), minimumOutput = units(route.minimumOutput);
  if (BigInt(inputAmount) < 1n || BigInt(inputAmount) > universalAmountCeiling(source) || BigInt(minimumOutput) < 1n || BigInt(minimumOutput) > BigInt(expectedOutput) ||
      BigInt(expectedOutput) > universalAmountCeiling(destination)) fail('UNIVERSAL_ROUTE_AMOUNT_INVALID');
  if (!Number.isSafeInteger(route.slippageBps) || route.slippageBps < 1 || route.slippageBps > UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS) fail('UNIVERSAL_ROUTE_SLIPPAGE_INVALID');
  // The slippage bound is the owner's: the guaranteed minimum may never be further below the expected output than it allows.
  if (BigInt(minimumOutput) < BigInt(expectedOutput) * BigInt(10_000 - route.slippageBps) / 10_000n) fail('UNIVERSAL_ROUTE_MINIMUM_BELOW_SLIPPAGE');
  const depositor = canonicalUniversalAddress(source, route.depositor, 'UNIVERSAL_ROUTE_ADDRESS_INVALID');
  const refundAddress = canonicalUniversalAddress(source, route.refundAddress, 'UNIVERSAL_ROUTE_ADDRESS_INVALID');
  const recipient = canonicalUniversalAddress(destination, route.recipient, 'UNIVERSAL_ROUTE_ADDRESS_INVALID');
  if (refundAddress !== depositor) fail('UNIVERSAL_ROUTE_REFUND_ADDRESS_INVALID');
  const chainToken = (chainId: string, token: string) => {
    if (chainId !== source.chain && chainId !== destination.chain) fail('UNIVERSAL_ROUTE_STEPS_INVALID');
    return token === 'native' ? token : canonicalUniversalToken(networkOf(chainId, 'UNIVERSAL_ROUTE_STEPS_INVALID'), token, 'UNIVERSAL_ROUTE_STEPS_INVALID');
  };
  if (!Array.isArray(route.steps) || route.steps.length < 1 || route.steps.length > 6) fail('UNIVERSAL_ROUTE_STEPS_INVALID');
  const steps = route.steps.map(s => {
    if (!s || !['BRIDGE', 'DESTINATION_SWAP'].includes(s.kind) || typeof s.protocol !== 'string' || !/^[a-z0-9.-]{1,40}$/.test(s.protocol)) fail('UNIVERSAL_ROUTE_STEPS_INVALID');
    return { kind: s.kind, protocol: s.protocol, fromChain: s.fromChain, toChain: s.toChain, fromToken: chainToken(s.fromChain, s.fromToken),
      toToken: chainToken(s.toChain, s.toToken), amountIn: units(s.amountIn), amountOut: units(s.amountOut) };
  });
  const bridges = steps.filter(s => s.kind === 'BRIDGE');
  if (bridges.length !== 1 || bridges[0]!.fromChain !== source.chain || bridges[0]!.toChain !== destination.chain || steps[0]!.kind !== 'BRIDGE' ||
      steps[0]!.fromToken !== tokenKey(inputToken) || steps.at(-1)!.toToken !== tokenKey(outputToken) || steps.at(-1)!.toChain !== destination.chain ||
      steps[0]!.amountIn !== inputAmount) fail('UNIVERSAL_ROUTE_STEPS_INVALID');
  if (!Array.isArray(route.fees) || route.fees.length > 16) fail('UNIVERSAL_ROUTE_FEES_INVALID');
  const fees = sortByJson(route.fees.map(f => {
    if (!f || !FEE_KINDS.includes(f.kind) || typeof f.label !== 'string' || f.label.length < 1 || f.label.length > 80 || typeof f.included !== 'boolean' ||
        !Number.isSafeInteger(f.decimals) || f.decimals < 0 || f.decimals > 36 || !symbolOk(f.symbol)) fail('UNIVERSAL_ROUTE_FEES_INVALID');
    const network = networkOf(f.chainId, 'UNIVERSAL_ROUTE_FEES_INVALID');
    if (f.chainId !== source.chain && f.chainId !== destination.chain) fail('UNIVERSAL_ROUTE_FEES_INVALID');
    const token = f.token === 'native' ? 'native' : canonicalUniversalToken(network, f.token, 'UNIVERSAL_ROUTE_FEES_INVALID');
    // The source network fee is paid in the source chain's native coin, outside the quote; every other line is inside it.
    if ((f.kind === 'SOURCE_NETWORK_FEE') !== !f.included || f.kind === 'SOURCE_NETWORK_FEE' && (token !== 'native' || f.chainId !== source.chain)) fail('UNIVERSAL_ROUTE_FEES_INVALID');
    const feeRecipient = f.recipient === null ? null : canonicalUniversalAddress(network, f.recipient, 'UNIVERSAL_ROUTE_FEES_INVALID');
    return { kind: f.kind, label: f.label, chainId: f.chainId, token, decimals: f.decimals, symbol: f.symbol, amount: units(f.amount), included: f.included, recipient: feeRecipient };
  }));
  const s = route.source;
  let sourceTx: UniversalRouteSource;
  if (!s || s.chainId !== source.chain || s.ecosystem !== source.ecosystem) return fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
  if (s.ecosystem === 'EVM') {
    const d = s.deposit;
    if (!d || typeof d.data !== 'string' || !HEX.test(d.data) || d.data.length < 10 || d.data.length > 100_000 || typeof d.value !== 'string' || !UNITS.test(d.value))
      fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
    const to = canonicalUniversalAddress(source, d.to, 'UNIVERSAL_ROUTE_TRANSACTION_INVALID');
    let approval: { token: string; spender: string; amount: string } | null = null;
    if (inputToken.kind === 'NATIVE') { if (s.approval !== null || d.value !== inputAmount) fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID'); }
    else {
      if (d.value !== '0' || !s.approval) fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
      approval = { token: canonicalUniversalAddress(source, s.approval!.token, 'UNIVERSAL_ROUTE_APPROVAL_INVALID'),
        spender: canonicalUniversalAddress(source, s.approval!.spender, 'UNIVERSAL_ROUTE_APPROVAL_INVALID'), amount: units(s.approval!.amount, 'UNIVERSAL_ROUTE_APPROVAL_INVALID') };
      if (approval.token !== inputToken.address || approval.amount !== inputAmount || approval.spender !== to) fail('UNIVERSAL_ROUTE_APPROVAL_INVALID');
    }
    sourceTx = { ecosystem: 'EVM', chainId: source.chain, approval, deposit: { to, data: d.data, value: d.value } };
  } else {
    const ix = s.instruction;
    if (!ix || !Array.isArray(ix.accounts) || ix.accounts.length < 1 || ix.accounts.length > 32 || typeof ix.data !== 'string' || !HEX.test(ix.data) || ix.data.length < 18 ||
        ix.data.length > 2_000) fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
    const programId = canonicalUniversalAddress(source, ix.programId, 'UNIVERSAL_ROUTE_TRANSACTION_INVALID');
    const accounts = ix.accounts.map(a => {
      if (!a || typeof a.isSigner !== 'boolean' || typeof a.isWritable !== 'boolean' || typeof a.pubkey !== 'string') fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
      // System Program and other program ids are legitimate instruction accounts here; only the 32-byte shape is required.
      if (a.pubkey !== '11111111111111111111111111111111') canonicalUniversalAddress(source, a.pubkey, 'UNIVERSAL_ROUTE_TRANSACTION_INVALID');
      return { pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable };
    });
    // The owner is the only signer the deposit may require.
    if (accounts.some(a => a.isSigner && a.pubkey !== depositor) || !accounts.some(a => a.isSigner)) fail('UNIVERSAL_ROUTE_SIGNER_INVALID');
    sourceTx = { ecosystem: 'SOLANA', chainId: source.chain, instruction: { programId, accounts, data: ix.data } };
  }
  const o = route.order;
  if (!o || o.kind !== 'RELAY_V2' || !HASH.test(o.orderId) || !o.orderData || typeof o.orderData !== 'object' || Array.isArray(o.orderData) ||
      typeof o.solver !== 'string' || !/^0x[0-9a-f]{40}$/.test(o.solver) || !Number.isSafeInteger(o.deadline) || o.deadline <= 0 || typeof o.depository !== 'string' ||
      !Array.isArray(o.refunds) || o.refunds.length < 1 || o.refunds.length > 4) fail('UNIVERSAL_ROUTE_ORDER_INVALID');
  const order: UniversalRouteOrder = { kind: 'RELAY_V2', orderId: o.orderId, orderData: JSON.parse(canonicalJson(o.orderData)) as Record<string, unknown>, solver: o.solver,
    deadline: o.deadline, depository: o.depository, refunds: o.refunds.map(r => {
      if (!r || typeof r.chainId !== 'string' || typeof r.recipient !== 'string' || typeof r.currency !== 'string') fail('UNIVERSAL_ROUTE_ORDER_INVALID');
      return { chainId: r.chainId, recipient: r.recipient, currency: r.currency };
    }) };
  if (route.destination?.additionalAuthorization !== 'NONE') fail('UNIVERSAL_ROUTE_DESTINATION_INVALID');
  const q = route.quote;
  if (!q || typeof q.id !== 'string' || q.id.length < 1 || q.id.length > 160 || !HASH.test(q.rawHash) || !isoTime(q.quotedAt) || !isoTime(q.expiresAt) ||
      Date.parse(q.expiresAt) <= Date.parse(q.quotedAt) || !Number.isSafeInteger(q.estimatedDurationSeconds) || q.estimatedDurationSeconds < 0 ||
      q.estimatedDurationSeconds > 86_400) fail('UNIVERSAL_ROUTE_QUOTE_INVALID');
  if (Date.parse(q.expiresAt) > o.deadline * 1000) fail('UNIVERSAL_ROUTE_QUOTE_INVALID');
  return { format: 'flofi.universal-route.v1', provider: route.provider, protocol: route.protocol, sourceChain: source.chain, destinationChain: destination.chain,
    inputToken, outputToken, inputAmount, expectedOutput, minimumOutput, slippageBps: route.slippageBps, depositor, recipient, refundAddress, steps, fees,
    source: sourceTx, order, destination: { additionalAuthorization: 'NONE' },
    quote: { id: q.id, rawHash: q.rawHash, quotedAt: q.quotedAt, expiresAt: q.expiresAt, estimatedDurationSeconds: q.estimatedDurationSeconds } };
}
/** Deterministic route commitment: key order and fee order cannot change it; any material byte does. */
export function universalRouteCommitment(route: UniversalRoute): string {
  return '0x' + createHash('sha256').update('flofi/universal-route-commitment/v1\n' + canonicalJson(canonicalizeUniversalRoute(route))).digest('hex');
}
/** Fees inside the quote, summed per token (chain:token), for comparison. */
const includedFees = (route: UniversalRoute) => route.fees.filter(f => f.included).reduce<Record<string, bigint>>((sum, f) => {
  const key = `${f.chainId}:${f.token}`; sum[key] = (sum[key] ?? 0n) + BigInt(f.amount); return sum; }, {});
/**
 * Material differences between a reviewed route and a candidate.
 * `REQUOTE`: a fresh quote from the same provider is compared to the reviewed route. Identity, protocol, steps, approvals, targets,
 * value, refund targets and fee recipients must be equal, and the provider must still expect to deliver at least the reviewed
 * guaranteed minimum (else the reviewed order would likely be refunded rather than filled). The executed bytes are still the
 * reviewed bytes; the fresh quote is only evidence that the provider still offers the reviewed route.
 * `EXACT`: any byte of the route, including calldata, order, quote identity and deadlines, is material.
 */
export function compareUniversalRoutes(reviewedInput: UniversalRoute, candidateInput: UniversalRoute, mode: 'REQUOTE' | 'EXACT'): readonly RouteChange[] {
  const a = canonicalizeUniversalRoute(reviewedInput), b = canonicalizeUniversalRoute(candidateInput), changes = new Set<RouteChange>();
  const same = (x: unknown, y: unknown) => canonicalJson(x) === canonicalJson(y);
  if (a.sourceChain !== b.sourceChain || a.destinationChain !== b.destinationChain) changes.add('CHAIN_CHANGED');
  if (!same({ ...a.inputToken, symbol: null }, { ...b.inputToken, symbol: null }) || !same({ ...a.outputToken, symbol: null }, { ...b.outputToken, symbol: null }))
    changes.add('TOKEN_CHANGED');
  if (a.inputAmount !== b.inputAmount) changes.add('AMOUNT_CHANGED');
  if (a.recipient !== b.recipient) changes.add('RECIPIENT_CHANGED');
  if (a.depositor !== b.depositor) changes.add('DEPOSITOR_CHANGED');
  if (a.refundAddress !== b.refundAddress || !same(a.order.refunds.map(r => [r.chainId, r.recipient]), b.order.refunds.map(r => [r.chainId, r.recipient])))
    changes.add('REFUND_ADDRESS_CHANGED');
  if (a.provider !== b.provider) changes.add('PROVIDER_CHANGED');
  if (a.protocol !== b.protocol) changes.add('PROTOCOL_CHANGED');
  const shape = (r: UniversalRoute) => r.steps.map(s => [s.kind, s.protocol, s.fromChain, s.toChain, s.fromToken, s.toToken]);
  if (!same(shape(a), shape(b))) changes.add('STEPS_CHANGED');
  const recipients = (r: UniversalRoute) => [...new Set(r.fees.map(f => `${f.kind}:${f.recipient ?? ''}`))].sort();
  if (!same(recipients(a), recipients(b))) changes.add('FEE_RECIPIENT_CHANGED');
  if (BigInt(b.expectedOutput) < BigInt(a.minimumOutput)) changes.add('MINIMUM_OUTPUT_DECREASED');
  if (a.slippageBps !== b.slippageBps) changes.add('SLIPPAGE_CHANGED');
  if (a.source.ecosystem !== b.source.ecosystem) changes.add('TRANSACTION_TARGET_CHANGED');
  else if (a.source.ecosystem === 'EVM' && b.source.ecosystem === 'EVM') {
    if (!same(a.source.approval, b.source.approval)) changes.add('APPROVAL_CHANGED');
    if (a.source.deposit.to !== b.source.deposit.to) changes.add('TRANSACTION_TARGET_CHANGED');
    if (a.source.deposit.data.slice(0, 10) !== b.source.deposit.data.slice(0, 10)) changes.add('TRANSACTION_FUNCTION_CHANGED');
    if (a.source.deposit.value !== b.source.deposit.value) changes.add('VALUE_CHANGED');
  } else if (a.source.ecosystem === 'SOLANA' && b.source.ecosystem === 'SOLANA') {
    if (a.source.instruction.programId !== b.source.instruction.programId) changes.add('TRANSACTION_TARGET_CHANGED');
    if (a.source.instruction.data.slice(0, 18) !== b.source.instruction.data.slice(0, 18)) changes.add('TRANSACTION_FUNCTION_CHANGED');
    if (!same(a.source.instruction.accounts.map(x => [x.isSigner, x.isWritable]), b.source.instruction.accounts.map(x => [x.isSigner, x.isWritable])))
      changes.add('TRANSACTION_TARGET_CHANGED');
  }
  if (a.order.depository !== b.order.depository || a.order.kind !== b.order.kind) changes.add('BRIDGE_CONTRACT_CHANGED');
  if (mode === 'EXACT') {
    const data = (r: UniversalRoute) => r.source.ecosystem === 'EVM' ? r.source.deposit.data : canonicalJson(r.source.instruction);
    if (data(a) !== data(b)) changes.add('CALLDATA_CHANGED');
    if (!same(a.quote, b.quote) || a.expectedOutput !== b.expectedOutput || a.minimumOutput !== b.minimumOutput || !same(a.fees, b.fees) || a.order.orderId !== b.order.orderId)
      changes.add('QUOTE_CHANGED');
    if (a.order.deadline !== b.order.deadline) changes.add('DEADLINE_CHANGED');
  } else {
    // A provider re-quote may move fees with gas prices; only a rise that eats into the reviewed minimum is material (checked above).
    const fa = includedFees(a), fb = includedFees(b);
    if (Object.keys(fb).some(k => !(k in fa))) changes.add('FEES_OUT_OF_BOUNDS');
  }
  return [...changes].sort();
}
