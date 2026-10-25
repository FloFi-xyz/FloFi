// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the pure compilation of one reviewed universal route into the existing artifact chain
 * (Quote/State → Artifact Set → Simulation Bundle → AuthorizationPolicy → StrategyManifest → ExecutionPlan), as BUILD-ROUTER-001
 * does for its pairs. The route commitment and the provider order id are normalized values of the quote artifact, so the Manifest
 * hash binds the exact reviewed route and order. Source payloads are the exact EVM calls or the exact Solana v0 message.
 */
import { hashArtifactBytes, hashRawBytes, universalNetworkOfChain, type SemanticWorkflow, type QuoteStateArtifact, type ArtifactSet, type SimulationBundle,
  type AuthorizationPolicy, type StrategyManifest, type ExecutionPlan, type UniversalRoute, type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';

const enc = new TextEncoder();
const H = (kind: Parameters<typeof hashArtifactBytes>[0], value: unknown) => hashArtifactBytes(kind, enc.encode(JSON.stringify(value)));
const fail = (code: string): never => { throw new Error(code); };
export const UNIVERSAL_ARTIFACT_ADAPTER = Object.freeze({ id: 'flofi.router.universal', version: '1.0.0' } as const);
export type UniversalSourcePayload =
  | { readonly ecosystem: 'EVM'; readonly calls: readonly { readonly purpose: 'APPROVAL' | 'BRIDGE_DEPOSIT'; readonly to: string; readonly data: string; readonly value: string }[] }
  | { readonly ecosystem: 'SOLANA'; readonly messageHash: string; readonly programId: string };
export type UniversalArtifactInput = {
  readonly workflow: SemanticWorkflow; readonly nodeId: string; readonly route: UniversalRoute; readonly routeCommitment: string; readonly owner: string;
  readonly payload: UniversalSourcePayload;
  /** Source chain position of the simulation (EVM block or Solana slot), its time, and the native network-fee upper bound. */
  readonly simulation: { readonly position: { readonly kind: 'BLOCK' | 'SLOT'; readonly height: number }; readonly observedAt: string; readonly networkFeeUpperBound: string };
  readonly expiresAt: string;
};
export type UniversalArtifacts = { readonly quote: QuoteStateArtifact; readonly artifactSet: ArtifactSet; readonly simulation: SimulationBundle;
  readonly policy: AuthorizationPolicy; readonly manifest: StrategyManifest; readonly plan: ExecutionPlan;
  readonly hashes: { readonly workflow: string; readonly quote: string; readonly artifactSet: string; readonly simulation: string; readonly policy: string;
    readonly manifest: string; readonly plan: string; readonly payloads: readonly string[] } };
/** Provider identity bound by the policy and the Manifest (`FIXED`): routing provider and protocol. */
export const universalProviderId = (route: Pick<UniversalRoute, 'provider' | 'protocol'>) => `${route.provider}:${route.protocol}`;
const assetOf = (token: UniversalToken) => {
  const network = universalNetworkOfChain(token.chainId) ?? fail('UNIVERSAL_ARTIFACT_NETWORK_INVALID');
  return token.kind === 'NATIVE' ? { chainId: token.chainId, nativeId: network.native.nativeId, decimals: token.decimals }
    : { chainId: token.chainId, address: token.address!, decimals: token.decimals };
};

export function compileUniversalArtifacts(input: UniversalArtifactInput): UniversalArtifacts {
  const { workflow, route, owner } = input;
  const src = route.sourceChain, dst = route.destinationChain, sourceNetwork = universalNetworkOfChain(src) ?? fail('UNIVERSAL_ARTIFACT_NETWORK_INVALID');
  const inputAsset = assetOf(route.inputToken), outputAsset = assetOf(route.outputToken);
  const native = { chainId: src, nativeId: sourceNetwork.native.nativeId, decimals: sourceNetwork.native.decimals };
  const sourceOwner = { chainId: src, address: owner }, recipient = { chainId: dst, address: route.recipient };
  const workflowHash = H('semantic-workflow', workflow), suffix = input.routeCommitment.slice(2, 26);
  const payloads = input.payload.ecosystem === 'EVM'
    ? input.payload.calls.map(c => hashRawBytes('payload', enc.encode(JSON.stringify({ chainId: src, to: c.to, data: c.data, value: c.value }))))
    : [hashRawBytes('payload', enc.encode(JSON.stringify({ chainId: src, messageHash: input.payload.messageHash })))];
  const ageSeconds = Math.max(1, Math.ceil((Date.parse(input.expiresAt) - Date.parse(input.simulation.observedAt)) / 1000));
  const freshness = { observedAt: input.simulation.observedAt, expiresAt: input.expiresAt, maximumAgeSeconds: ageSeconds };
  const uncertainty = [{ code: 'CROSS_CHAIN_SETTLEMENT_NOT_SIMULATED',
    description: `The source deposit is simulated on ${sourceNetwork.name}; the destination delivery by the ${route.provider} solver remains the order's guarantee until observed on chain.` }];
  const depositTarget = route.source.ecosystem === 'EVM' ? route.source.deposit.to : route.source.instruction.programId;
  const contracts = [...route.inputToken.kind === 'TOKEN' ? [{ chainId: src, address: route.inputToken.address!, version: 'verified' }] : [],
    { chainId: src, address: depositTarget, version: 'pinned' }];
  const included = route.fees.filter(f => f.included && f.chainId === src && f.token === (route.inputToken.address ?? 'native'))
    .reduce((sum, f) => sum + BigInt(f.amount), 0n).toString();
  const quote = validateArtifact('quote-state-artifact', { schemaVersion: '1.0.0', artifactId: 'universal.quote.' + suffix, semanticWorkflowHash: workflowHash,
    nodeId: input.nodeId, sourceId: `${route.provider}.live-api`, adapter: UNIVERSAL_ARTIFACT_ADAPTER, chainId: src,
    chainPosition: input.simulation.position, retrievedAt: route.quote.quotedAt,
    freshness: { observedAt: route.quote.quotedAt, expiresAt: route.quote.expiresAt,
      maximumAgeSeconds: Math.max(1, Math.ceil((Date.parse(route.quote.expiresAt) - Date.parse(route.quote.quotedAt)) / 1000)) },
    rawResponseHash: route.quote.rawHash,
    normalizedValues: [{ name: 'route-commitment', kind: 'IDENTIFIER', value: input.routeCommitment },
      { name: 'routing-provider', kind: 'IDENTIFIER', value: route.provider }, { name: 'protocol', kind: 'IDENTIFIER', value: route.protocol },
      { name: 'provider-order-id', kind: 'IDENTIFIER', value: route.order.orderId },
      { name: 'route-steps', kind: 'IDENTIFIER', value: route.steps.map(s => `${s.kind}:${s.protocol}`).join('.') },
      { name: 'destination-chain', kind: 'IDENTIFIER', value: dst }, { name: 'recipient', kind: 'ACCOUNT', value: recipient },
      { name: 'order-deadline', kind: 'INTEGER', value: route.order.deadline },
      { name: 'deposit-payload-hash', kind: 'IDENTIFIER', value: payloads.at(-1)! }],
    providerReference: { kind: 'ROUTE', id: 'route-' + suffix }, proposedContracts: contracts,
    proposedSpenders: [sourceOwner, ...route.source.ecosystem === 'EVM' && route.source.approval ? [{ chainId: src, address: route.source.approval.spender }] : []],
    proposedRecipients: [recipient],
    fees: [{ asset: inputAsset, amount: included }], gas: [{ asset: native, amount: input.simulation.networkFeeUpperBound }],
    outputBounds: [{ outputId: 'amount-out', expected: { asset: outputAsset, amount: route.expectedOutput }, minimum: { asset: outputAsset, amount: route.minimumOutput },
      adverse: { asset: outputAsset, amount: route.minimumOutput } }],
    uncertainty, registryValidation: { registryVersion: '1.1.0', actionType: 'asset.bridge', result: 'CONTRACT_VALIDATED', enforcement: 'NOT_ENFORCED' } });
  const quoteHash = H('quote-state-artifact', quote);
  const artifactSet = validateArtifact('artifact-set', { schemaVersion: '1.0.0', artifactSetId: 'universal.set.' + suffix, semanticWorkflowHash: workflowHash,
    artifacts: [{ artifactId: quote.artifactId, nodeId: input.nodeId, artifactHash: quoteHash }] });
  const artifactSetHash = H('artifact-set', artifactSet);
  const simulation = validateArtifact('simulation-bundle', { schemaVersion: '1.0.0', simulationId: 'universal.simulation.' + suffix,
    semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: workflowHash, artifactSetHash, adapters: [UNIVERSAL_ARTIFACT_ADAPTER], contracts,
    outputs: [{ nodeId: input.nodeId, outputId: 'amount-out', expected: { asset: outputAsset, amount: route.expectedOutput },
      minimum: { asset: outputAsset, amount: route.minimumOutput }, adverse: { asset: outputAsset, amount: route.minimumOutput } }],
    propagatedOutputs: [], failurePaths: [{ failedNodeId: input.nodeId, blockedNodeIds: [], residualAssets: [{ asset: inputAsset, amount: route.inputAmount }] }],
    uncertainty, unsupportedAssumptions: ['The destination delivery is not simulated: a solver delivers it and only on-chain observation proves it.',
      'An unfilled order is refunded to the owner (or delivered to the recipient as the order allows); refund timing depends on the provider.'], freshness });
  const simulationHash = H('simulation-bundle', simulation);
  const recovery = { failurePolicy: 'PAUSE_FOR_APPROVAL' as const, residualAssetRecipient: sourceOwner, maximumAttemptsPerStep: 1, requiresHumanReview: true as const };
  const spendLimits = [{ asset: inputAsset, maximumAmount: route.inputAmount, maximumPerStepAmount: route.inputAmount, maximumCumulativeAmount: route.inputAmount }];
  const gasBudgets = [{ asset: native, maximumAmount: input.simulation.networkFeeUpperBound }];
  const feeBudgets = [{ asset: inputAsset, maximumAmount: included }];
  const providers = { kind: 'FIXED' as const, providerId: universalProviderId(route) };
  const functions = input.payload.ecosystem === 'EVM' ? input.payload.calls.map(c => ({ chainId: src, contract: c.to, functionId: c.data.slice(0, 10) }))
    : [{ chainId: src, contract: input.payload.programId, functionId: route.source.ecosystem === 'SOLANA' ? route.source.instruction.data.slice(0, 18) : 'deposit' }];
  const policy = validateArtifact('authorization-policy', { schemaVersion: '1.0.0', policyId: 'universal.policy.' + suffix, semanticWorkflowHash: workflowHash,
    artifactSetHash, simulationHash, requiredAuthorizationClass: 'MODE_A',
    allowlists: { owners: [sourceOwner], accounts: [sourceOwner], recipients: [recipient], chains: [src, dst], adapters: [UNIVERSAL_ARTIFACT_ADAPTER],
      protocols: [...new Set<string>([route.provider, route.protocol])], contracts, functions },
    budgetReservation: { rule: 'RESERVE_BEFORE_SUBMISSION', concurrentConsumption: 'CUMULATIVE_ACROSS_BRANCHES', implementation: 'NOT_IMPLEMENTED' },
    spendLimits, maximumSlippageBps: route.slippageBps, gasBudgets, feeBudgets, oracleRules: [], accountRiskRules: [], checkpointRules: [], providers, nonce: '0',
    deadline: input.expiresAt, revocationEpoch: 0, recovery, enforcement: 'NOT_ENFORCED' });
  const policyHash = H('authorization-policy', policy);
  const manifest = validateArtifact('strategy-manifest', { schemaVersion: '1.0.0', manifestId: 'universal.manifest.' + suffix, semanticWorkflowRevision: workflow.revision,
    semanticWorkflowHash: workflowHash, artifactSetHash, simulationHash, policyHash, authorizationMode: 'MODE_A', owner: sourceOwner, executor: null,
    expiresAt: input.expiresAt, nonce: '0', revocationEpoch: 0, spendLimits, maximumSlippageBps: route.slippageBps, gasBudgets, feeBudgets, providers, recovery,
    enforcement: 'NOT_ENFORCED' });
  const manifestHash = H('strategy-manifest', manifest);
  const steps = input.payload.ecosystem === 'EVM'
    ? input.payload.calls.map((c, i) => ({ stepId: c.purpose === 'APPROVAL' ? 'universal.step.approval' : 'universal.step.deposit', nodeId: input.nodeId, chainId: src,
      adapter: UNIVERSAL_ARTIFACT_ADAPTER, dependencies: i === 0 ? [] : ['universal.step.approval'], requiredAuthorizationClass: 'MODE_A' as const,
      executionKind: 'DIRECT_TRANSACTION' as const, payloadHash: payloads[i]! }))
    : [{ stepId: 'universal.step.deposit', nodeId: input.nodeId, chainId: src, adapter: UNIVERSAL_ARTIFACT_ADAPTER, dependencies: [], requiredAuthorizationClass: 'MODE_A' as const,
      executionKind: 'DIRECT_TRANSACTION' as const, payloadHash: payloads[0]! }];
  const plan = validateArtifact('execution-plan', { schemaVersion: '1.0.0', executionPlanId: 'universal.plan.' + suffix, semanticWorkflowHash: workflowHash, manifestHash,
    segments: [{ segmentId: 'universal.segment.source', chainId: src, dependencies: [], steps }],
    checkpointIds: ['universal.source-confirmation', 'universal.destination-delivery', 'universal.destination-reconciliation'], enforcement: 'NOT_ENFORCED' });
  return { quote, artifactSet, simulation, policy, manifest, plan, hashes: { workflow: workflowHash, quote: quoteHash, artifactSet: artifactSetHash,
    simulation: simulationHash, policy: policyHash, manifest: manifestHash, plan: H('execution-plan', plan), payloads } };
}
