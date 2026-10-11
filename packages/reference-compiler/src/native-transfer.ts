// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RH-DEMO-001: read-only simulation and Review of one transfer on a network with a transfer profile (Robinhood Testnet;
 * BUILD-ETHEREUM-001 adds Ethereum Sepolia). The authored chain selects the profile. Every value is read at one block; nothing
 * is signed or sent. The Review commitment binds the exact transaction, nonce, fee bounds, balances and freshness.
 *
 * BUILD-RH-002 generalizes the same engine for Robinhood Chain mainnet: native ETH or a catalog ERC-20 (`transfer(recipient,
 * amount)`), to the connected owner or an explicit recipient. A Stock Token's onchain `uid()` and ERC-8056 multiplier state are
 * bound into the Review. A native self-transfer Review is byte-identical to before (no new field appears in it).
 */
import { nativeTransferProfile, transferAllowsRecipients, transferAllowsTokens, transferEnvironment, type NativeTransferProfile } from '@defi-workflow-engine/action-registry';
export { ROBINHOOD_TESTNET_TRANSFER, ETHEREUM_SEPOLIA_TRANSFER, ROBINHOOD_MAINNET_TRANSFER, NATIVE_TRANSFER_PROFILES, nativeTransferProfile,
  type NativeTransferProfile } from '@defi-workflow-engine/action-registry';
import { readTransferNode, supplyAddress, hashSupplyValue, TRANSFER_ACTION, type SemanticWorkflow, type ArtifactSet, type TransferFields,
  type SimulationBundle, type AuthorizationPolicy, type StrategyManifest, type ExecutionPlan } from '@defi-workflow-engine/workflow-contracts';
import { rpcRecord, rpcHex, rpcUint, rpcHash, supplyHex, supplyHash, supplyArtifactHash } from './supply.js';

export type TransferRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
/** The exact request a wallet receives. The wallet assigns the nonce; it must equal the reviewed nonce. */
export type NativeTransferTransaction = { from: string; to: string; value: string; data: string; chainId: string;
  gas: string; maxFeePerGas: string; maxPriorityFeePerGas: '0x0' };
/** BUILD-RH-002: the token side of an ERC-20 transfer Review (absent on native transfers). */
export type TransferTokenReview = { kind: 'ERC20'; token: string; decimals: number; officialId: string | null; balanceBefore: string;
  expectedBalanceAfter: string; recipientBalanceBefore: string; multiplierWad: string | null; scheduledMultiplierWad: string | null;
  scheduledEffectiveAt: number | null };
export type TransferState = { block: number; blockHash: string; blockTimestamp: number; account: string; balance: string;
  nonce: string; pendingNonce: string; gasPrice: string; baseFee: string; observedAt: string;
  /** Token transfers only: the owner's token balance and (Stock Token) multiplier state at the same block. */
  tokenBalance?: string; multiplierWad?: string; scheduledMultiplierWad?: string; scheduledEffectiveAt?: number };
export type NativeTransferReview = { format: 'gryloo.native-transfer-review.v1'; workflow: SemanticWorkflow; chain: string; chainId: number;
  account: string; recipient: string; value: string; nonce: string; transaction: NativeTransferTransaction;
  gasEstimate: string; gasLimit: string; gasPrice: string; maxFeePerGas: string; expectedFee: string; feeBudget: string;
  balanceBefore: string; expectedBalanceAfter: string; minimumBalanceAfter: string; simulationResult: string;
  state: TransferState; expiresAt: string; artifactSet: ArtifactSet; simulation: SimulationBundle; policy: AuthorizationPolicy;
  manifest: StrategyManifest; plan: ExecutionPlan; commitment: string; asset?: TransferTokenReview };
const nativeAdapter = { id: 'evm.native-transfer', version: '1.0.0' }, tokenAdapter = { id: 'evm.token-transfer', version: '1.0.0' };
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const transferData = (recipient: string, amount: string) => '0xa9059cbb' + supplyAddress(recipient).slice(2).padStart(64, '0') + word(BigInt(amount));
const TRUE_WORD = '0x' + word(1n);
type TokenRef = { address: string; officialId: string | null };

export async function readTransferState(rpc: TransferRpc, profile: NativeTransferProfile, accountInput: string, now = Date.now(), token?: TokenRef): Promise<TransferState> {
  const account = supplyAddress(accountInput);
  if (rpcUint(await rpc('eth_chainId', [])) !== BigInt(profile.chainId)) throw new Error('TRANSFER_WRONG_CHAIN');
  const block = rpcRecord(await rpc('eth_getBlockByNumber', ['latest', false]));
  const tag = rpcHex(block.number), blockHash = rpcHash(block.hash), number = Number(rpcUint(tag)), timestamp = Number(rpcUint(block.timestamp));
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) throw new Error('TRANSFER_RPC_INVALID');
  const age = now - timestamp * 1000;
  if (age > 120_000 || age < -30_000) throw new Error('TRANSFER_STALE_CHAIN_HEAD');
  const [balance, nonce, pendingNonce, gasPrice, code] = await Promise.all([
    rpc('eth_getBalance', [account, tag]), rpc('eth_getTransactionCount', [account, tag]),
    rpc('eth_getTransactionCount', [account, 'pending']), rpc('eth_gasPrice', []), rpc('eth_getCode', [account, tag])]);
  // A code-bearing owner (contract or EIP-7702 delegation) would execute code on a self-transfer.
  if (rpcHexOrEmpty(code) !== '0x') throw new Error('TRANSFER_OWNER_NOT_EOA');
  const tokenFacts: Pick<TransferState, 'tokenBalance' | 'multiplierWad' | 'scheduledMultiplierWad' | 'scheduledEffectiveAt'> = {};
  if (token) {
    const call = async (data: string) => rpcHex(await rpc('eth_call', [{ to: token.address, data }, tag]));
    tokenFacts.tokenBalance = BigInt(await call('0x70a08231' + account.slice(2).padStart(64, '0'))).toString();
    if (token.officialId) {
      tokenFacts.multiplierWad = BigInt(await call('0xa60bf13d')).toString();
      tokenFacts.scheduledMultiplierWad = BigInt(await call('0xdc767007')).toString();
      tokenFacts.scheduledEffectiveAt = Number(BigInt(await call('0x97a4064f')));
    }
  }
  if (rpcHash(rpcRecord(await rpc('eth_getBlockByNumber', [tag, false])).hash) !== blockHash) throw new Error('TRANSFER_REORG');
  const baseFee = block.baseFeePerGas === undefined ? 0n : rpcUint(block.baseFeePerGas);
  return { block: number, blockHash, blockTimestamp: timestamp, account, balance: rpcUint(balance).toString(), nonce: rpcUint(nonce).toString(),
    pendingNonce: rpcUint(pendingNonce).toString(), gasPrice: rpcUint(gasPrice).toString(), baseFee: baseFee.toString(), observedAt: new Date(now).toISOString(),
    ...tokenFacts };
}
function rpcHexOrEmpty(value: unknown): string { return value === '0x' ? '0x' : rpcHex(value); }

function transferFields(workflow: SemanticWorkflow): { node: SemanticWorkflow['nodes'][number]; read: TransferFields; profile: NativeTransferProfile } {
  const nodes = workflow.nodes.filter(n => n.actionType === TRANSFER_ACTION);
  if (nodes.length !== 1 || workflow.nodes.some(n => n.actionType !== TRANSFER_ACTION && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.length || workflow.nodes.some(n => n.dependencies.length)) throw new Error('TRANSFER_ISOLATED_ONLY');
  const read = readTransferNode(nodes[0]!);
  let profile: NativeTransferProfile;
  try { profile = nativeTransferProfile(read.fields.chain); } catch { throw new Error('TRANSFER_PROFILE_UNSUPPORTED'); }
  if (read.fields.recipient !== 'CONNECTED_OWNER' && !transferAllowsRecipients(profile)) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  if (read.kind === 'NATIVE' ? BigInt(read.fields.amount) > BigInt(profile.maximumValueWei) : !transferAllowsTokens(profile)) throw new Error('TRANSFER_PROFILE_UNSUPPORTED');
  return { node: nodes[0]!, read, profile };
}
/** The token a transfer workflow moves (null for native ETH): what readTransferState must also observe. */
export function transferToken(workflow: SemanticWorkflow): TokenRef | null {
  const { read } = transferFields(workflow);
  return read.kind === 'TOKEN' ? { address: read.fields.token.address, officialId: read.fields.token.officialId } : null;
}
/** The exact transaction for the connected owner: a native value transfer, or the token's `transfer(recipient, amount)`. */
export function compileNativeTransfer(workflow: SemanticWorkflow, accountInput: string, gasLimit: string, maxFeePerGas: string): NativeTransferTransaction {
  const { read, profile } = transferFields(workflow), owner = supplyAddress(accountInput);
  const recipient = read.fields.recipient === 'CONNECTED_OWNER' ? owner : supplyAddress(read.fields.recipient);
  if (read.kind === 'TOKEN') return { from: owner, to: read.fields.token.address, value: '0x0', data: transferData(recipient, read.fields.amount),
    chainId: profile.chainHex, gas: supplyHex(gasLimit), maxFeePerGas: supplyHex(maxFeePerGas), maxPriorityFeePerGas: '0x0' };
  return { from: owner, to: recipient, value: supplyHex(read.fields.amount), data: '0x', chainId: profile.chainHex,
    gas: supplyHex(gasLimit), maxFeePerGas: supplyHex(maxFeePerGas), maxPriorityFeePerGas: '0x0' };
}

/** Only reads. eth_call and eth_estimateGas execute the exact transfer against ephemeral state. */
export async function simulateNativeTransfer(workflow: SemanticWorkflow, accountInput: string, rpc: TransferRpc, now = Date.now()): Promise<NativeTransferReview> {
  const semanticHash = supplyArtifactHash('semantic-workflow', workflow);
  const { node, read, profile } = transferFields(workflow), native = { chainId: profile.chain, nativeId: 'ETH', decimals: 18 };
  const token = read.kind === 'TOKEN' ? read.fields.token : null;
  const state = await readTransferState(rpc, profile, accountInput, now, token ? { address: token.address, officialId: token.officialId } : undefined);
  const account = state.account, tag = supplyHex(state.block);
  const recipient = read.fields.recipient === 'CONNECTED_OWNER' ? account : supplyAddress(read.fields.recipient);
  const insufficient = transferEnvironment(profile) === 'MAINNET' ? 'TRANSFER_INSUFFICIENT_ETH' : 'TRANSFER_INSUFFICIENT_TEST_ETH';
  // A queued transaction would make the wallet's nonce assignment ambiguous.
  if (state.pendingNonce !== state.nonce) throw new Error('TRANSFER_PENDING_TRANSACTION');
  let asset: TransferTokenReview | undefined;
  if (token) {
    const call = async (data: string) => rpcHex(await rpc('eth_call', [{ to: token.address, data }, tag]));
    if (BigInt(await call('0x313ce567')) !== BigInt(token.decimals)) throw new Error('TRANSFER_TOKEN_METADATA_MISMATCH');
    if (token.officialId) {
      if ('0x' + word(BigInt(await call('0xf514ce36'))) !== token.officialId) throw new Error('TRANSFER_TOKEN_IDENTITY_MISMATCH');
      const scheduledAt = state.scheduledEffectiveAt ?? 0;
      // A corporate action taking effect before this Review could be used would change what the tokens represent.
      if (state.scheduledMultiplierWad !== state.multiplierWad && scheduledAt > state.blockTimestamp && scheduledAt <= Math.floor(now / 1000) + profile.reviewTtlSeconds)
        throw new Error('TRANSFER_STOCK_MULTIPLIER_CHANGE_PENDING');
    }
    if (BigInt(state.tokenBalance!) < BigInt(read.fields.amount)) throw new Error('TRANSFER_INSUFFICIENT_TOKEN_BALANCE');
    const recipientBalance = BigInt(await call('0x70a08231' + recipient.slice(2).padStart(64, '0')));
    const self = recipient === account;
    asset = { kind: 'ERC20', token: token.address, decimals: token.decimals, officialId: token.officialId, balanceBefore: state.tokenBalance!,
      expectedBalanceAfter: self ? state.tokenBalance! : (BigInt(state.tokenBalance!) - BigInt(read.fields.amount)).toString(),
      recipientBalanceBefore: recipientBalance.toString(), multiplierWad: state.multiplierWad ?? null, scheduledMultiplierWad: state.scheduledMultiplierWad ?? null,
      scheduledEffectiveAt: state.scheduledEffectiveAt ?? null };
  } else if (recipient !== account) {
    // A native value transfer to a contract would run its code (and possibly emit logs); only an EOA recipient is reconcilable.
    if (rpcHexOrEmpty(await rpc('eth_getCode', [recipient, tag])) !== '0x') throw new Error('TRANSFER_RECIPIENT_NOT_EOA');
  }
  const value = token ? 0n : BigInt(read.fields.amount), balance = BigInt(state.balance);
  if (balance <= value && !token) throw new Error(insufficient);
  const transactionPreview = compileNativeTransfer(workflow, account, '1', '1');
  const call = { from: account, to: transactionPreview.to, value: transactionPreview.value, data: transactionPreview.data };
  const result = await rpc('eth_call', [call, tag]);
  if (token ? result !== TRUE_WORD : result !== '0x') throw new Error('TRANSFER_SIMULATION_UNEXPECTED_RETURN');
  const gas = rpcUint(await rpc('eth_estimateGas', [call, tag]));
  if (gas < 21_000n || gas > 500_000n) throw new Error('TRANSFER_GAS_INVALID');
  const gasPrice = BigInt(state.gasPrice), baseFee = BigInt(state.baseFee);
  if (gasPrice <= 0n) throw new Error('TRANSFER_GAS_PRICE_INVALID');
  const gasLimit = (gas * BigInt(profile.gasLimitMarginPercent) + 99n) / 100n;
  const maxFeePerGas = (gasPrice > baseFee ? gasPrice : baseFee) * BigInt(profile.maxFeeMultiplier);
  const expectedFee = gas * gasPrice, feeBudget = gasLimit * maxFeePerGas;
  if (balance < value + feeBudget) throw new Error(insufficient);
  const transaction = compileNativeTransfer(workflow, account, gasLimit.toString(), maxFeePerGas.toString());
  if (rpcHash(rpcRecord(await rpc('eth_getBlockByNumber', [tag, false])).hash) !== state.blockHash) throw new Error('TRANSFER_REORG');
  const expiresAt = new Date(now + profile.reviewTtlSeconds * 1000).toISOString();
  const artifactSet: ArtifactSet = { schemaVersion: '1.0.0', artifactSetId: 'native-transfer-artifacts', semanticWorkflowHash: semanticHash,
    artifacts: [{ artifactId: 'native-transfer-state', nodeId: node.nodeId, artifactHash: supplyHash({ state, transaction, gas: gas.toString(), result, ...asset ? { asset } : {} }) }] };
  const artifactHash = supplyArtifactHash('artifact-set', artifactSet);
  const adapter = token ? tokenAdapter : nativeAdapter;
  const simulation: SimulationBundle = { schemaVersion: '1.0.0', simulationId: 'native-transfer-simulation', semanticWorkflowRevision: workflow.revision,
    semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, adapters: [adapter], contracts: [], outputs: [], propagatedOutputs: [],
    failurePaths: [], uncertainty: profile.settlement === 'L2' ? [{ code: 'L2_SOFT_CONFIRMATION', description: 'Inclusion is first a Robinhood Chain sequencer confirmation; L1 finality follows later.' }] :
      [{ code: 'L1_REORG_WINDOW', description: `Inclusion is an ${profile.network} block; reconciliation waits for ${profile.minimumConfirmations} confirmations.` }],
    unsupportedAssumptions: [], freshness: { observedAt: state.observedAt, expiresAt, maximumAgeSeconds: profile.reviewTtlSeconds } };
  const simulationHash = supplyArtifactHash('simulation-bundle', simulation), owner = { chainId: profile.chain, address: account };
  const moved = token ? { chainId: profile.chain, address: token.address, decimals: token.decimals } : native;
  const spendLimits = [{ asset: moved, maximumAmount: read.fields.amount, maximumPerStepAmount: read.fields.amount, maximumCumulativeAmount: read.fields.amount }];
  const gasBudgets = [{ asset: native, maximumAmount: feeBudget.toString() }];
  const recovery = { failurePolicy: 'ABORT' as const, residualAssetRecipient: owner, maximumAttemptsPerStep: 1, requiresHumanReview: true as const };
  const providers = { kind: 'FIXED' as const, providerId: token ? tokenAdapter.id : profile.adapterId };
  const policy: AuthorizationPolicy = { schemaVersion: '1.0.0', policyId: 'native-transfer-policy', semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash,
    simulationHash, requiredAuthorizationClass: 'MODE_A', allowlists: { owners: [owner], accounts: [owner], recipients: [{ chainId: profile.chain, address: recipient }], chains: [profile.chain],
      adapters: [adapter], protocols: [token ? 'erc20' : 'native'], contracts: token ? [{ chainId: profile.chain, address: token.address, version: 'erc20' }] : [],
      functions: token ? [{ chainId: profile.chain, contract: token.address, functionId: 'transfer-address-uint256' }] : [] },
    budgetReservation: { rule: 'RESERVE_BEFORE_SUBMISSION', concurrentConsumption: 'CUMULATIVE_ACROSS_BRANCHES', implementation: 'NOT_IMPLEMENTED' },
    spendLimits, maximumSlippageBps: 0, gasBudgets, feeBudgets: [], oracleRules: [], accountRiskRules: [], checkpointRules: [], providers,
    nonce: state.nonce, deadline: expiresAt, revocationEpoch: workflow.revision, recovery, enforcement: 'NOT_ENFORCED' };
  const policyHash = supplyArtifactHash('authorization-policy', policy);
  const manifest: StrategyManifest = { schemaVersion: '1.0.0', manifestId: 'native-transfer-manifest', semanticWorkflowRevision: workflow.revision,
    semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, simulationHash, policyHash, authorizationMode: 'MODE_A', owner, executor: null,
    expiresAt, nonce: state.nonce, revocationEpoch: workflow.revision, spendLimits, maximumSlippageBps: 0, gasBudgets, feeBudgets: [], providers, recovery,
    enforcement: 'NOT_ENFORCED' };
  const manifestHash = supplyArtifactHash('strategy-manifest', manifest);
  const plan: ExecutionPlan = { schemaVersion: '1.0.0', executionPlanId: 'native-transfer-plan', semanticWorkflowHash: semanticHash, manifestHash,
    segments: [{ segmentId: 'native-transfer-segment', chainId: profile.chain, dependencies: [], steps: [{ stepId: 'native-transfer', nodeId: node.nodeId,
      chainId: profile.chain, adapter, dependencies: [], requiredAuthorizationClass: 'MODE_A', executionKind: 'DIRECT_TRANSACTION',
      payloadHash: hashSupplyValue({ ...transaction, nonce: state.nonce }, 'payload') }] }], checkpointIds: [], enforcement: 'NOT_ENFORCED' };
  supplyArtifactHash('execution-plan', plan);
  const review = { format: 'gryloo.native-transfer-review.v1' as const, workflow, chain: profile.chain, chainId: profile.chainId, account, recipient,
    value: read.fields.amount, nonce: state.nonce, transaction, gasEstimate: gas.toString(), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(),
    maxFeePerGas: maxFeePerGas.toString(), expectedFee: expectedFee.toString(), feeBudget: feeBudget.toString(), balanceBefore: state.balance,
    expectedBalanceAfter: (balance - value - expectedFee).toString(), minimumBalanceAfter: (balance - value - feeBudget).toString(), simulationResult: String(result),
    state, expiresAt, artifactSet, simulation, policy, manifest, plan, ...asset ? { asset } : {} };
  // A native self-transfer keeps its original Review exactly: the value nets to zero for the owner's balance.
  if (!token && recipient === account) Object.assign(review, { expectedBalanceAfter: (balance - expectedFee).toString(), minimumBalanceAfter: (balance - feeBudget).toString() });
  return { ...review, commitment: supplyHash(review) };
}
/** Fails closed unless the reviewed commitment, intent, owner, nonce, fee bounds, balances, token state and freshness all still hold. */
export function assertNativeTransferReview(review: NativeTransferReview, workflow: SemanticWorkflow, account: string, state: TransferState, now = Date.now()): void {
  const { commitment, ...content } = review;
  if (supplyHash(content) !== commitment || review.format !== 'gryloo.native-transfer-review.v1') throw new Error('TRANSFER_AUTHORIZATION_INVALID');
  if (supplyArtifactHash('semantic-workflow', workflow) !== review.manifest.semanticWorkflowHash ||
      JSON.stringify(workflow) !== JSON.stringify(review.workflow)) throw new Error('TRANSFER_SEMANTIC_REVISION_CHANGED');
  const { read, profile } = transferFields(workflow), owner = supplyAddress(account);
  const recipient = read.fields.recipient === 'CONNECTED_OWNER' ? owner : supplyAddress(read.fields.recipient);
  if (read.fields.amount !== review.value || owner !== review.account || review.recipient !== recipient || review.chain !== profile.chain ||
      review.chainId !== profile.chainId || (read.kind === 'TOKEN') !== Boolean(review.asset)) throw new Error('TRANSFER_AUTHORIZATION_INVALID');
  if (now >= Date.parse(review.expiresAt) || now < Date.parse(review.state.observedAt)) throw new Error('TRANSFER_REVIEW_EXPIRED');
  const value = read.kind === 'TOKEN' ? 0n : BigInt(review.value);
  if (state.account !== review.account || state.nonce !== review.nonce || state.pendingNonce !== review.nonce || state.block < review.state.block ||
      BigInt(state.gasPrice) > BigInt(review.maxFeePerGas) || BigInt(state.balance) < value + BigInt(review.feeBudget)) throw new Error('TRANSFER_AUTHORIZATION_STALE');
  if (review.asset) {
    if (state.tokenBalance === undefined || BigInt(state.tokenBalance) < BigInt(review.value)) throw new Error('TRANSFER_AUTHORIZATION_STALE');
    // A Stock Token multiplier that moved since Review changes what the reviewed amount represents.
    if (review.asset.officialId && (state.multiplierWad !== review.asset.multiplierWad || state.scheduledMultiplierWad !== review.asset.scheduledMultiplierWad ||
        state.scheduledEffectiveAt !== review.asset.scheduledEffectiveAt)) throw new Error('TRANSFER_STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED');
  }
  if (JSON.stringify(compileNativeTransfer(workflow, owner, review.gasLimit, review.maxFeePerGas)) !== JSON.stringify(review.transaction)) throw new Error('TRANSFER_AUTHORIZATION_INVALID');
}
