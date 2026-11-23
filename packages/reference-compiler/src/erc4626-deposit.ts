// SPDX-License-Identifier: AGPL-3.0-only
import { ERC4626_DEPOSIT_ADAPTER, readErc4626DepositNode, supplyAddress, hashSupplyValue,
  type ArtifactSet, type AuthorizationPolicy, type Erc4626DepositFields, type ExecutionPlan,
  type SemanticWorkflow, type SimulationBundle, type StrategyManifest } from '@defi-workflow-engine/workflow-contracts';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { fromHex, toHex } from './payload.js';
import { rpcHash, rpcRecord, rpcUint, supplyArtifactHash, supplyCall, supplyHex, type SupplyRpc } from './supply.js';

/** Independently reviewed profile for an immutable vault and underlying token. Ingestion cannot confer this trust. */
export type Erc4626DepositProfile = Readonly<Pick<Erc4626DepositFields,
  'chain' | 'vault' | 'underlying' | 'assetDecimals' | 'shareDecimals' | 'certificationDigest'> & {
  vaultCodeHash: string;
  underlyingCodeHash: string;
  genesisHash: string;
  maximumAssets: string;
  maximumGasCost: string;
  maximumSlippageBps: number;
  nativeSymbol: string;
  gasModel: 'EIP1559_EXECUTION_ONLY';
  minimumConfirmations: number;
}>;

export type Erc4626DepositTransaction = Readonly<{
  from: string; to: string; value: '0x0'; data: string; chainId: string; gas: string;
  maxFeePerGas: string; maxPriorityFeePerGas: string; nonce: string;
}>;

export const ERC4626_BOUNDED_DEPOSIT = 'deposit(uint256,address,uint256)';
export const ERC4626_DEPOSIT_STEP = 'erc4626-deposit';
export const ERC4626_DEPOSIT_SEGMENT = 'erc4626-deposit-segment';
const TTL_SECONDS = 120;
const MAX_UINT = (1n << 256n) - 1n;
const oneWord = /^0x[0-9a-fA-F]{64}$/;
const hash = /^0x[0-9a-f]{64}$/;

function uint256(value: string): bigint {
  if (!/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) > MAX_UINT) throw new Error('VAULT_DEPOSIT_PROFILE_INVALID');
  return BigInt(value);
}
function rpcWord(value: unknown): bigint {
  if (typeof value !== 'string' || !oneWord.test(value)) throw new Error('VAULT_RPC_WORD_INVALID');
  return BigInt(value);
}
function blockHeight(value: unknown): number {
  const number = Number(rpcUint(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('VAULT_BLOCK_INVALID');
  return number;
}
function codeHash(code: unknown): string {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,24576}$/.test(code)) throw new Error('VAULT_CODE_INVALID');
  return toHex(keccak_256(fromHex(code.toLowerCase())));
}
function reviewedProfile(workflow: SemanticWorkflow, profile: Erc4626DepositProfile) {
  if (workflow.nodes.length !== 1 || workflow.resourceEdges.length !== 0) throw new Error('VAULT_DEPOSIT_ISOLATED_ONLY');
  const node = workflow.nodes[0]!;
  const fields = readErc4626DepositNode(node);
  const equal = fields.chain === profile.chain && fields.vault === profile.vault && fields.underlying === profile.underlying &&
    fields.assetDecimals === profile.assetDecimals && fields.shareDecimals === profile.shareDecimals && fields.certificationDigest === profile.certificationDigest;
  if (!equal || profile.gasModel !== 'EIP1559_EXECUTION_ONLY' ||
    ![profile.vaultCodeHash, profile.underlyingCodeHash, profile.genesisHash].every(value => hash.test(value)) ||
    !/^[A-Z][A-Z0-9]{1,11}$/.test(profile.nativeSymbol) || !Number.isSafeInteger(profile.minimumConfirmations) ||
    !Number.isSafeInteger(profile.maximumSlippageBps) || profile.maximumSlippageBps < 0 || profile.maximumSlippageBps >= 10_000 ||
    profile.minimumConfirmations < 1 || profile.minimumConfirmations > 256 || BigInt(fields.amount) > uint256(profile.maximumAssets)) {
    throw new Error('VAULT_DEPOSIT_PROFILE_MISMATCH');
  }
  uint256(profile.maximumGasCost);
  return { node, fields, chain: BigInt(fields.chain.slice('eip155:'.length)) };
}

/** An exact, pre-existing allowance is a prerequisite. FloFi never generates an approval for this adapter. */
async function observeDeposit(workflow: SemanticWorkflow, profile: Erc4626DepositProfile, ownerInput: string, rpc: SupplyRpc) {
  const { fields, chain } = reviewedProfile(workflow, profile);
  const owner = supplyAddress(ownerInput);
  if (owner === '0x' + '0'.repeat(40) || owner === fields.vault || owner === fields.underlying) throw new Error('VAULT_OWNER_INVALID');
  if (rpcUint(await rpc('eth_chainId', [])) !== chain) throw new Error('VAULT_WRONG_CHAIN');
  const [genesis, latest] = await Promise.all([
    rpc('eth_getBlockByNumber', ['0x0', false]).then(rpcRecord), rpc('eth_getBlockByNumber', ['latest', false]).then(rpcRecord),
  ]);
  if (rpcHash(genesis.hash) !== profile.genesisHash) throw new Error('VAULT_WRONG_CHAIN');
  const block = blockHeight(latest.number), blockHash = rpcHash(latest.hash), tag = supplyHex(block);
  const amount = BigInt(fields.amount), minimum = BigInt(fields.minimumShares);
  const read = async (to: string, data: string) => rpcWord(await rpc('eth_call', [{ from: owner, to, data }, tag]));
  const address = (to: string, selector: string) => read(to, supplyCall(selector));
  const [vaultCode, tokenCode, ownerCode, underlying, assetDecimals, shareDecimals, allowance, balance, shareBalance,
    maxDeposit, preview, nativeBalance, nonce, pendingNonce, gasPrice, priority] = await Promise.all([
    rpc('eth_getCode', [fields.vault, tag]), rpc('eth_getCode', [fields.underlying, tag]), rpc('eth_getCode', [owner, tag]),
    address(fields.vault, 'asset()'), address(fields.underlying, 'decimals()'), address(fields.vault, 'decimals()'),
    read(fields.underlying, supplyCall('allowance(address,address)', owner, fields.vault)),
    read(fields.underlying, supplyCall('balanceOf(address)', owner)), read(fields.vault, supplyCall('balanceOf(address)', owner)),
    read(fields.vault, supplyCall('maxDeposit(address)', owner)), read(fields.vault, supplyCall('previewDeposit(uint256)', amount)),
    rpc('eth_getBalance', [owner, tag]).then(rpcUint), rpc('eth_getTransactionCount', [owner, tag]).then(rpcUint),
    rpc('eth_getTransactionCount', [owner, 'pending']).then(rpcUint), rpc('eth_gasPrice', []).then(rpcUint),
    rpc('eth_maxPriorityFeePerGas', []).then(rpcUint),
  ]);
  if (codeHash(vaultCode) !== profile.vaultCodeHash || codeHash(tokenCode) !== profile.underlyingCodeHash || ownerCode !== '0x' ||
    underlying !== BigInt(fields.underlying) || assetDecimals !== BigInt(fields.assetDecimals) || shareDecimals !== BigInt(fields.shareDecimals)) {
    throw new Error('VAULT_DEPLOYMENT_MISMATCH');
  }
  if (allowance !== amount) throw new Error('VAULT_EXACT_ALLOWANCE_REQUIRED');
  if (balance < amount || maxDeposit < amount) throw new Error('VAULT_DEPOSIT_LIMIT');
  if (nonce !== pendingNonce) throw new Error('VAULT_PENDING_NONCE');
  if (preview < minimum) throw new Error('VAULT_MINIMUM_SHARES_UNAVAILABLE');
  const data = supplyCall(ERC4626_BOUNDED_DEPOSIT, amount, owner, minimum);
  const call = { from: owner, to: fields.vault, value: '0x0' as const, data };
  const [result, estimate] = await Promise.all([rpc('eth_call', [call, tag]).then(rpcWord), rpc('eth_estimateGas', [call, tag]).then(rpcUint)]);
  if (result !== preview) throw new Error('VAULT_SIMULATION_OUTPUT_MISMATCH');
  const baseFee = rpcUint(latest.baseFeePerGas);
  if (estimate < 21_000n || estimate > 500_000n || baseFee <= 0n || priority <= 0n || gasPrice < baseFee) {
    throw new Error('VAULT_GAS_INVALID');
  }
  const gasLimit = (estimate * 120n + 99n) / 100n;
  const maxFee = 2n * (gasPrice > baseFee + priority ? gasPrice : baseFee + priority);
  const feeBudget = maxFee * gasLimit;
  if (feeBudget > uint256(profile.maximumGasCost) || nativeBalance < feeBudget) throw new Error('VAULT_GAS_BUDGET_EXCEEDED');
  if (rpcHash(rpcRecord(await rpc('eth_getBlockByNumber', [tag, false])).hash) !== blockHash) throw new Error('VAULT_REORG');
  const observedNonce = nonce.toString();
  const transaction: Erc4626DepositTransaction = { ...call, chainId: supplyHex(chain), gas: supplyHex(gasLimit),
    maxFeePerGas: supplyHex(maxFee), maxPriorityFeePerGas: supplyHex(priority), nonce: supplyHex(nonce) };
  return { block, blockHash, owner, nonce: observedNonce, transaction, amount: fields.amount, minimumShares: fields.minimumShares,
    expectedShares: result.toString(), sharesBefore: shareBalance.toString(), assetsBefore: balance.toString(),
    gasEstimate: estimate.toString(), feeBudget: feeBudget.toString(), baseFee: baseFee.toString(), priorityFee: priority.toString(),
    nativeBalance: nativeBalance.toString() };
}

export type Erc4626DepositReview = Readonly<Awaited<ReturnType<typeof observeDeposit>> & {
  workflow: SemanticWorkflow; profileHash: string; expiresAt: string; commitment: string;
  artifactSet: ArtifactSet; simulation: SimulationBundle; policy: AuthorizationPolicy; manifest: StrategyManifest; plan: ExecutionPlan;
}>;

/** Read-only simulation. Requires a certified profile supplied by a trusted host and leaves authorization to the owner flow. */
export async function simulateErc4626Deposit(workflowInput: SemanticWorkflow, profileInput: Erc4626DepositProfile, ownerInput: string, rpc: SupplyRpc,
  now = Date.now()): Promise<Erc4626DepositReview> {
  const workflow = structuredClone(workflowInput), profile = Object.freeze({ ...profileInput });
  const semanticHash = supplyArtifactHash('semantic-workflow', workflow);
  const { node, fields } = reviewedProfile(workflow, profile);
  const state = await observeDeposit(workflow, profile, ownerInput, rpc);
  const { chain, vault } = fields;
  const observedAt = new Date(now).toISOString(), expiresAt = new Date(now + TTL_SECONDS * 1000).toISOString();
  const profileHash = hashSupplyValue(profile);
  const artifactSet: ArtifactSet = { schemaVersion: '1.0.0', artifactSetId: 'erc4626-deposit-artifacts', semanticWorkflowHash: semanticHash,
    artifacts: [{ artifactId: 'erc4626-deposit-state', nodeId: node.nodeId, artifactHash: hashSupplyValue({ state, profileHash }) }] };
  const artifactHash = supplyArtifactHash('artifact-set', artifactSet);
  const contracts = [{ chainId: chain, address: vault, version: 'erc4626-bounded' },
    { chainId: chain, address: fields.underlying, version: 'erc20' }];
  const adapter = { ...ERC4626_DEPOSIT_ADAPTER }, shares = { chainId: chain, address: vault, decimals: fields.shareDecimals };
  const simulation: SimulationBundle = { schemaVersion: '1.0.0', simulationId: 'erc4626-deposit-simulation',
    semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, contracts,
    adapters: [adapter], outputs: [{ nodeId: node.nodeId, outputId: 'shares', expected: { asset: shares, amount: state.expectedShares },
      minimum: { asset: shares, amount: fields.minimumShares }, adverse: { asset: shares, amount: fields.minimumShares } }],
    propagatedOutputs: [], failurePaths: [], uncertainty: [], unsupportedAssumptions: [],
    freshness: { observedAt, expiresAt, maximumAgeSeconds: TTL_SECONDS } };
  const simulationHash = supplyArtifactHash('simulation-bundle', simulation);
  const owner = { chainId: chain, address: state.owner }, underlying = { chainId: chain, address: fields.underlying, decimals: fields.assetDecimals };
  const spendLimits = [{ asset: underlying, maximumAmount: state.amount, maximumPerStepAmount: state.amount, maximumCumulativeAmount: state.amount }];
  const gasBudgets = [{ asset: { chainId: chain, nativeId: profile.nativeSymbol, decimals: 18 }, maximumAmount: state.feeBudget }];
  const providers = { kind: 'FIXED' as const, providerId: adapter.id };
  const recovery = { failurePolicy: 'ABORT' as const, residualAssetRecipient: owner, maximumAttemptsPerStep: 1, requiresHumanReview: true as const };
  const minimum = BigInt(fields.minimumShares), expected = BigInt(state.expectedShares);
  const maximumSlippageBps = Number(((expected - minimum) * 10_000n + expected - 1n) / expected);
  if (maximumSlippageBps > profile.maximumSlippageBps) throw new Error('VAULT_SLIPPAGE_POLICY_EXCEEDED');
  const policy: AuthorizationPolicy = { schemaVersion: '1.0.0', policyId: 'erc4626-deposit-policy', semanticWorkflowHash: semanticHash,
    artifactSetHash: artifactHash, simulationHash, requiredAuthorizationClass: 'MODE_A',
    allowlists: { owners: [owner], accounts: [owner], recipients: [owner], chains: [chain], adapters: [adapter],
      protocols: ['erc4626'], contracts, functions: [{ chainId: chain, contract: vault, functionId: 'deposit-assets-receiver-minshares' }] },
    budgetReservation: { rule: 'RESERVE_BEFORE_SUBMISSION', concurrentConsumption: 'CUMULATIVE_ACROSS_BRANCHES', implementation: 'NOT_IMPLEMENTED' },
    spendLimits, maximumSlippageBps, gasBudgets, feeBudgets: [], oracleRules: [], accountRiskRules: [], checkpointRules: [], providers,
    nonce: state.nonce, deadline: expiresAt, revocationEpoch: workflow.revision, recovery, enforcement: 'NOT_ENFORCED' };
  const manifest: StrategyManifest = { schemaVersion: '1.0.0', manifestId: 'erc4626-deposit-manifest', semanticWorkflowRevision: workflow.revision,
    semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, simulationHash, policyHash: supplyArtifactHash('authorization-policy', policy),
    authorizationMode: 'MODE_A', owner, executor: null, expiresAt, nonce: state.nonce, revocationEpoch: workflow.revision,
    spendLimits, maximumSlippageBps, gasBudgets, feeBudgets: [], providers, recovery, enforcement: 'NOT_ENFORCED' };
  const plan: ExecutionPlan = { schemaVersion: '1.0.0', executionPlanId: 'erc4626-deposit-plan', semanticWorkflowHash: semanticHash,
    manifestHash: supplyArtifactHash('strategy-manifest', manifest), segments: [{ segmentId: ERC4626_DEPOSIT_SEGMENT, chainId: chain, dependencies: [],
      steps: [{ stepId: ERC4626_DEPOSIT_STEP, nodeId: node.nodeId, chainId: chain, adapter, dependencies: [],
        requiredAuthorizationClass: 'MODE_A', executionKind: 'DIRECT_TRANSACTION', payloadHash: hashSupplyValue(state.transaction, 'payload') }] }],
    checkpointIds: [], enforcement: 'NOT_ENFORCED' };
  supplyArtifactHash('execution-plan', plan);
  const review = { ...state, workflow, profileHash, expiresAt, artifactSet, simulation, policy, manifest, plan };
  return { ...review, commitment: hashSupplyValue(review) };
}

export function assertErc4626DepositBinding(review: Erc4626DepositReview, profile: Erc4626DepositProfile): Erc4626DepositFields {
  const { commitment, ...content } = review;
  const { node, fields, chain } = reviewedProfile(review.workflow, profile);
  const [segment] = review.plan.segments, step = segment?.steps[0], tx = review.transaction;
  const semanticHash = supplyArtifactHash('semantic-workflow', review.workflow);
  const artifactHash = supplyArtifactHash('artifact-set', review.artifactSet);
  const simulationHash = supplyArtifactHash('simulation-bundle', review.simulation);
  const policyHash = supplyArtifactHash('authorization-policy', review.policy);
  const manifestHash = supplyArtifactHash('strategy-manifest', review.manifest);
  const gas = rpcUint(tx.gas), fee = rpcUint(tx.maxFeePerGas), priority = rpcUint(tx.maxPriorityFeePerGas);
  const observedAt = Date.parse(review.simulation.freshness.observedAt), expiresAt = Date.parse(review.expiresAt);
  if (hashSupplyValue(content) !== commitment || review.profileHash !== hashSupplyValue(profile) ||
    [review.artifactSet, review.simulation, review.policy, review.manifest, review.plan].some(artifact => artifact.semanticWorkflowHash !== semanticHash) ||
    [review.simulation, review.policy, review.manifest].some(artifact => artifact.artifactSetHash !== artifactHash) ||
    review.policy.simulationHash !== simulationHash || review.manifest.simulationHash !== simulationHash || review.manifest.policyHash !== policyHash ||
    review.plan.manifestHash !== manifestHash || review.manifest.owner.address !== review.owner || review.manifest.owner.chainId !== fields.chain ||
    review.manifest.authorizationMode !== 'MODE_A' || review.manifest.executor !== null ||
    review.manifest.nonce !== review.nonce || review.policy.nonce !== review.nonce ||
    !Number.isFinite(observedAt) || expiresAt !== observedAt + TTL_SECONDS * 1000 || review.manifest.expiresAt !== review.expiresAt ||
    review.policy.deadline !== review.expiresAt || review.simulation.freshness.expiresAt !== review.expiresAt ||
    review.plan.segments.length !== 1 || segment?.steps.length !== 1 || segment.chainId !== fields.chain ||
    step?.executionKind !== 'DIRECT_TRANSACTION' || step.payloadHash !== hashSupplyValue(tx, 'payload') ||
    step.nodeId !== node.nodeId || step.chainId !== fields.chain || step.requiredAuthorizationClass !== 'MODE_A' ||
    step.adapter.id !== ERC4626_DEPOSIT_ADAPTER.id || step.adapter.version !== ERC4626_DEPOSIT_ADAPTER.version ||
    tx.chainId !== supplyHex(chain) || tx.nonce !== supplyHex(review.nonce) || tx.from !== review.owner || tx.to !== fields.vault || tx.value !== '0x0' ||
    gas < 21_000n || gas > 600_000n || priority <= 0n || fee < priority || gas * fee !== BigInt(review.feeBudget) ||
    gas * fee > uint256(profile.maximumGasCost) || review.manifest.maximumSlippageBps > profile.maximumSlippageBps ||
    tx.data !== supplyCall(ERC4626_BOUNDED_DEPOSIT, BigInt(fields.amount), review.owner, BigInt(fields.minimumShares)) ||
    review.amount !== fields.amount || review.minimumShares !== fields.minimumShares) throw new Error('VAULT_REVIEW_INVALID');
  return fields;
}

/** Revalidates an authoritative stored Review immediately before the owner wallet request. */
export async function assertFreshErc4626Deposit(review: Erc4626DepositReview, profile: Erc4626DepositProfile, expectedCommitment: string,
  owner: string, rpc: SupplyRpc, now = Date.now()): Promise<void> {
  assertErc4626DepositBinding(review, profile);
  if (expectedCommitment !== review.commitment || review.owner !== supplyAddress(owner) ||
    !Number.isFinite(now) || now >= Date.parse(review.expiresAt) || now < Date.parse(review.simulation.freshness.observedAt)) {
    throw new Error('VAULT_REVIEW_REQUIRED');
  }
  const fresh = await observeDeposit(review.workflow, profile, owner, rpc);
  if (rpcHash(rpcRecord(await rpc('eth_getBlockByNumber', [supplyHex(review.block), false])).hash) !== review.blockHash) throw new Error('VAULT_REORG');
  if (fresh.block < review.block || fresh.nonce !== review.nonce || BigInt(fresh.gasEstimate) > BigInt(review.transaction.gas) ||
    BigInt(fresh.baseFee) + BigInt(review.transaction.maxPriorityFeePerGas) > BigInt(review.transaction.maxFeePerGas) ||
    BigInt(fresh.nativeBalance) < BigInt(review.feeBudget)) throw new Error('VAULT_NEW_REVIEW_REQUIRED');
}
