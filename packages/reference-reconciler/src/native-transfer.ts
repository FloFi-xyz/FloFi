// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RH-DEMO-001 runtime reconciliation of one native self-transfer from public chain reads only. It never
 * trusts the wallet's reported result: inclusion, sender, recipient, value, calldata, nonce, fee bounds and
 * the exact owner balance and nonce deltas are re-derived from the chain.
 *
 * BUILD-RH-002: the same reconciler for a native transfer to an explicit recipient and for a catalog ERC-20 transfer: the token
 * call must be the reviewed `transfer(recipient, amount)`, its only logs the token's `Transfer` (and a Stock Token's
 * `TransferWithScaledUI`), the token balances must move by exactly the amount and the owner's ETH by exactly the fee.
 *
 * BUILD-BASE-001: on an OP Stack profile (Base) the fee is gasUsed × effectiveGasPrice plus the receipt's `l1Fee`; a receipt without
 * `l1Fee` there is not reconcilable. Profiles without an L1 data fee are unchanged.
 */
import { rpcRecord, rpcHash, supplyHex, supplyHash, supplyArtifactHash, nativeTransferProfile,
  type NativeTransferReview, type TransferRpc } from '@defi-workflow-engine/reference-compiler';
import { transferL1FeeOracle } from '@defi-workflow-engine/action-registry';
import { hashJournalBytes, type EvidenceBundle, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';

export type TransferChainAttempt = { nonce: string; transactionHash: string | null; preparedAtBlock: number };
export type TransferObservation = { verdict: 'RECONCILED' | 'DIVERGENT' | 'INCONCLUSIVE'; reason: string;
  transaction: Record<string, unknown> | null; receipt: Record<string, unknown> | null;
  facts: { blockNumber: number; blockHash: string; gasUsed: string; effectiveGasPrice: string; fee: string; balanceBefore: string; balanceAfter: string;
    nonceBefore: string; nonceAfter: string; transactionType: string;
    /** Token transfers only. */ tokenBalanceBefore?: string; tokenBalanceAfter?: string; recipientTokenBalanceBefore?: string; recipientTokenBalanceAfter?: string } | null };
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** ERC-8056 `TransferWithScaledUI(address,address,uint256,uint256)`, emitted by Robinhood Stock Tokens next to `Transfer`. */
const SCALED_TRANSFER_TOPIC = '0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802';
const topicAddress = (value: unknown) => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/.test(value.toLowerCase()) ? '0x' + value.toLowerCase().slice(26) : null;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const strict = (value: unknown): bigint => { if (typeof value !== 'string' || !QUANTITY.test(value.toLowerCase())) throw new Error('TRANSFER_RPC_INVALID'); return BigInt(value); };
/** A 32-byte ABI word (eth_call result). */
const strictWord = (value: unknown): bigint => { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('TRANSFER_RPC_INVALID'); return BigInt(value); };

export async function reconcileNativeTransfer(review: NativeTransferReview, attempt: TransferChainAttempt, rpc: TransferRpc): Promise<TransferObservation> {
  const base: TransferObservation = { verdict: 'INCONCLUSIVE', reason: 'TRANSACTION_NOT_OBSERVED', transaction: null, receipt: null, facts: null };
  if (!attempt.transactionHash) return base;
  try {
    // The reviewed chain selects the profile; the RPC must report that same chain.
    const profile = nativeTransferProfile(review.chain);
    if (review.chainId !== profile.chainId || strict(await rpc('eth_chainId', [])) !== BigInt(profile.chainId)) throw new Error('TRANSFER_WRONG_CHAIN');
    const [txValue, receiptValue] = await Promise.all([rpc('eth_getTransactionByHash', [attempt.transactionHash]), rpc('eth_getTransactionReceipt', [attempt.transactionHash])]);
    if (!txValue || !receiptValue) return base;
    const tx = rpcRecord(txValue), receipt = rpcRecord(receiptValue);
    base.transaction = tx; base.receipt = receipt;
    const owner = review.account, type = typeof tx.type === 'string' ? tx.type.toLowerCase() : '', token = review.asset ?? null;
    // The exact reviewed transaction (native: to the recipient with the value; token: to the token with the reviewed calldata).
    const target = review.transaction.to;
    if (rpcHash(tx.hash) !== attempt.transactionHash || rpcHash(receipt.transactionHash) !== attempt.transactionHash ||
        typeof tx.from !== 'string' || tx.from.toLowerCase() !== owner || typeof tx.to !== 'string' || tx.to.toLowerCase() !== target ||
        strict(tx.value) !== BigInt(review.transaction.value) || tx.input !== review.transaction.data || strict(tx.nonce) !== BigInt(attempt.nonce) || attempt.nonce !== review.nonce ||
        strict(tx.chainId) !== BigInt(profile.chainId) || !['0x0', '0x2'].includes(type) ||
        typeof receipt.from !== 'string' || receipt.from.toLowerCase() !== owner || typeof receipt.to !== 'string' || receipt.to.toLowerCase() !== target ||
        rpcHash(tx.blockHash) !== rpcHash(receipt.blockHash) || strict(tx.blockNumber) !== strict(receipt.blockNumber)) throw new Error('TRANSFER_TRANSACTION_MISMATCH');
    // The reviewed fee bounds: the wallet may lower but never raise them.
    const gasLimit = strict(tx.gas), offeredPrice = type === '0x2' ? strict(tx.maxFeePerGas) : strict(tx.gasPrice);
    if (gasLimit > BigInt(review.gasLimit) || offeredPrice > BigInt(review.maxFeePerGas)) throw new Error('TRANSFER_FEE_BOUND_MISMATCH');
    const blockNumber = Number(strict(receipt.blockNumber));
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= attempt.preparedAtBlock || blockNumber <= review.state.block) throw new Error('TRANSFER_BLOCK_MISMATCH');
    const canonical = rpcRecord(await rpc('eth_getBlockByNumber', [supplyHex(blockNumber), false]));
    if (rpcHash(canonical.hash) !== rpcHash(receipt.blockHash) || !Array.isArray(canonical.transactions) ||
        !canonical.transactions.some(h => typeof h === 'string' && h.toLowerCase() === attempt.transactionHash)) throw new Error('TRANSFER_REORG');
    const latest = Number(strict(await rpc('eth_blockNumber', [])));
    if (latest < blockNumber + profile.minimumConfirmations) return { ...base, reason: 'AWAITING_CONFIRMATIONS' };
    if (strict(receipt.status) !== 1n) return { ...base, verdict: 'DIVERGENT', reason: 'TRANSFER_REVERTED' };
    // A native transfer between externally owned accounts emits no logs. A token transfer emits only the token's own transfer
    // log(s) for exactly (owner → recipient, amount); anything else is unexplained.
    if (!Array.isArray(receipt.logs)) throw new Error('TRANSFER_LOGS_MISMATCH');
    if (!token) {
      const recipientCode = review.state.recipientCodeHash === undefined ? '0x' : await rpc('eth_getCode', [review.recipient, supplyHex(blockNumber - 1)]);
      if (review.state.recipientCodeHash !== undefined && supplyHash(recipientCode) !== review.state.recipientCodeHash)
        throw new Error('TRANSFER_RECIPIENT_CODE_MISMATCH');
      // A reviewed value-only call can run the recipient's receive/fallback code. The owner debit is still exact below.
      if ((review.state.recipientCodeHash === undefined || recipientCode === '0x') && receipt.logs.length) throw new Error('TRANSFER_LOGS_MISMATCH');
    }
    if (token) {
      const logs = receipt.logs.map(rpcRecord);
      const transfers = logs.filter(log => Array.isArray(log.topics) && log.topics[0] === TRANSFER_TOPIC);
      const scaled = logs.filter(log => Array.isArray(log.topics) && log.topics[0] === SCALED_TRANSFER_TOPIC);
      const ok = (log: Record<string, unknown>) => typeof log.address === 'string' && log.address.toLowerCase() === token.token && Array.isArray(log.topics) &&
        topicAddress(log.topics[1]) === owner && topicAddress(log.topics[2]) === review.recipient && typeof log.data === 'string';
      if (logs.length !== transfers.length + scaled.length || transfers.length !== 1 || scaled.length > (token.officialId ? 1 : 0) ||
          !transfers.every(ok) || !scaled.every(ok) || strictWord('0x' + (transfers[0]!.data as string).slice(2, 66)) !== BigInt(review.value) ||
          scaled.some(log => strictWord('0x' + (log.data as string).slice(2, 66)) !== BigInt(review.value))) throw new Error('TRANSFER_LOGS_MISMATCH');
    }
    const gasUsed = strict(receipt.gasUsed), effectiveGasPrice = strict(receipt.effectiveGasPrice);
    if (gasUsed > gasLimit || effectiveGasPrice > offeredPrice) throw new Error('TRANSFER_FEE_BOUND_MISMATCH');
    // Ethereum L1 charges gasUsed × effectiveGasPrice; Arbitrum Nitro also folds L1 data into gasUsed. No separate L1 fee.
    // BUILD-BASE-001: an OP Stack receipt adds its own `l1Fee`, which the owner also pays.
    const opStack = transferL1FeeOracle(profile) !== null;
    if (opStack && receipt.l1Fee === undefined) throw new Error('TRANSFER_RECEIPT_L1_FEE_MISMATCH');
    const l1Fee = opStack ? strict(receipt.l1Fee) : 0n;
    const fee = gasUsed * effectiveGasPrice + l1Fee;
    if (fee > BigInt(review.feeBudget)) throw new Error('TRANSFER_FEE_BOUND_MISMATCH');
    const before = supplyHex(blockNumber - 1), after = supplyHex(blockNumber);
    const [balanceBefore, balanceAfter, nonceBefore, nonceAfter, code] = await Promise.all([
      rpc('eth_getBalance', [owner, before]).then(strict), rpc('eth_getBalance', [owner, after]).then(strict),
      rpc('eth_getTransactionCount', [owner, before]).then(strict), rpc('eth_getTransactionCount', [owner, after]).then(strict),
      rpc('eth_getCode', [owner, after])]);
    // Exactly one owner transaction in the inclusion block, and it consumed the reviewed nonce.
    if (nonceBefore !== BigInt(review.nonce) || nonceAfter !== nonceBefore + 1n) throw new Error('TRANSFER_NONCE_MISMATCH');
    if (code !== '0x') throw new Error('TRANSFER_OWNER_NOT_EOA');
    // ETH leaves the owner by exactly the fee, plus the value when it goes to someone else (a self-transfer's value leg nets to zero).
    const valueOut = !token && review.recipient !== owner ? BigInt(review.value) : 0n;
    if (balanceBefore - balanceAfter !== fee + valueOut || balanceBefore < (token ? 0n : BigInt(review.value)) + fee) throw new Error('TRANSFER_BALANCE_MISMATCH');
    let tokenFacts = {};
    if (token) {
      const balanceOf = (account: string, block: string) => rpc('eth_call', [{ to: token.token, data: '0x70a08231' + account.slice(2).padStart(64, '0') }, block]).then(strictWord);
      const [ownerBefore, ownerAfter, recipientBefore, recipientAfter] = await Promise.all([balanceOf(owner, before), balanceOf(owner, after),
        balanceOf(review.recipient, before), balanceOf(review.recipient, after)]);
      const self = review.recipient === owner, amount = BigInt(review.value);
      if (self ? ownerBefore !== ownerAfter : ownerBefore - ownerAfter !== amount || recipientAfter - recipientBefore !== amount) throw new Error('TRANSFER_TOKEN_BALANCE_MISMATCH');
      tokenFacts = { tokenBalanceBefore: ownerBefore.toString(), tokenBalanceAfter: ownerAfter.toString(), recipientTokenBalanceBefore: recipientBefore.toString(),
        recipientTokenBalanceAfter: recipientAfter.toString() };
    }
    const final = rpcRecord(await rpc('eth_getBlockByNumber', [after, false]));
    if (rpcHash(final.hash) !== rpcHash(receipt.blockHash)) throw new Error('TRANSFER_REORG');
    return { ...base, verdict: 'RECONCILED', reason: token ? 'TOKEN_TRANSFER_VERIFIED' : 'NATIVE_TRANSFER_VERIFIED', facts: { blockNumber, blockHash: rpcHash(receipt.blockHash),
      gasUsed: gasUsed.toString(), effectiveGasPrice: effectiveGasPrice.toString(), fee: fee.toString(), balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(), nonceBefore: nonceBefore.toString(), nonceAfter: nonceAfter.toString(), transactionType: type, ...tokenFacts } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'TRANSFER_OBSERVATION_FAILED';
    // Provider failures stay ambiguous; any mismatch never reconciles.
    return { ...base, verdict: /MISMATCH|WRONG_CHAIN|REORG|NOT_EOA/.test(message) ? 'DIVERGENT' : 'INCONCLUSIVE', reason: message };
  }
}
export type NativeTransferEvidence = { bundle: EvidenceBundle; bundleHash: string; publicExecution: Record<string, unknown>;
  artifacts: { workflow: unknown; artifactSet: unknown; simulation: unknown; policy: unknown; manifest: unknown; plan: unknown; journal: ExecutionJournal; review: NativeTransferReview } };
export function buildNativeTransferEvidence(input: { id: string; review: NativeTransferReview; journal: ExecutionJournal; provenance: 'PUBLIC_TESTNET' | 'PUBLIC_MAINNET' | 'MOCKED';
  ownerInitiated: boolean; observation: TransferObservation; observedAt?: string }): NativeTransferEvidence {
  const { review, observation: o } = input;
  if (o.verdict !== 'RECONCILED' || !o.facts || !o.receipt || !o.transaction || !input.ownerInitiated) throw new Error('TRANSFER_EVIDENCE_NOT_RECONCILED');
  const head = hashJournalBytes(new TextEncoder().encode(JSON.stringify(input.journal))).at(-1);
  if (!head) throw new Error('TRANSFER_JOURNAL_EMPTY');
  const profile = nativeTransferProfile(review.chain);
  const nativeAsset = { chainId: profile.chain, nativeId: 'ETH', decimals: 18 };
  const publicExecution = { network: profile.network, chainId: profile.chainId, explorer: profile.explorer, officialSource: profile.officialSource,
    account: review.account, recipient: review.recipient, value: review.value, nonce: review.nonce, transactionHash: o.receipt.transactionHash,
    explorerUrl: `${profile.explorer}/tx/${String(o.receipt.transactionHash)}`, ...o.facts, provenance: input.provenance, ownerInitiated: input.ownerInitiated,
    submissions: 1, verdict: o.verdict };
  const bundle: EvidenceBundle = { schemaVersion: '1.0.0', evidenceBundleId: input.id, version: 1, supersedes: null,
    semanticWorkflowHash: review.manifest.semanticWorkflowHash, artifactSetHash: review.manifest.artifactSetHash, simulationHash: review.manifest.simulationHash,
    policyHash: review.manifest.policyHash, manifestHash: supplyArtifactHash('strategy-manifest', review.manifest),
    executionPlanHash: supplyArtifactHash('execution-plan', review.plan), journalHeadHash: head, observedAt: input.observedAt ?? new Date().toISOString(),
    // Never inflated: a MOCKED harness run is MOCKED; only an owner-signed public run carries the public execution level.
    environment: input.provenance === 'PUBLIC_TESTNET' ? 'TESTNET_EXECUTED' : input.provenance === 'PUBLIC_MAINNET' ? 'MAINNET_EXECUTED' : 'MOCKED', outcome: 'RECONCILED',
    receipts: [{ receiptId: 'native-transfer-receipt', contentHash: supplyHash(o.receipt) }], differences: [],
    reconciliation: { balances: [{ asset: nativeAsset, amount: o.facts.balanceAfter },
      ...review.asset && o.facts.tokenBalanceAfter !== undefined ? [{ asset: { chainId: profile.chain, address: review.asset.token, decimals: review.asset.decimals }, amount: o.facts.tokenBalanceAfter }] : []],
      allowances: [], debt: [], positions: [],
      fees: [{ asset: nativeAsset, amount: o.facts.fee }], residualAssets: [], ownership: [{ chainId: profile.chain, address: review.account }],
      limitations: transferL1FeeOracle(profile) ? [
        `Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`,
        review.asset ? 'Token transfer: exact transfer(recipient, amount) call, its transfer log(s) and both token balances; ETH moved by exactly the fee.'
          : review.recipient !== review.account ? 'Native transfer to an explicit recipient: the owner balance moved by exactly the value plus the fee.'
          : 'Self-transfer: the value leg nets to zero; the owner balance moved by exactly the fee.',
        'The fee is gasUsed × effectiveGasPrice plus the OP Stack L1 data fee (l1Fee) of the receipt.']
        : review.asset || review.recipient !== review.account ? [
        `Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`,
        review.asset ? 'Token transfer: exact transfer(recipient, amount) call, its transfer log(s) and both token balances; ETH moved by exactly the fee.'
          : 'Native transfer to an explicit recipient: the exact value-only call and owner debit (value plus fee) are verified; contract recipients may execute their receive/fallback code.',
        'The fee is gasUsed × effectiveGasPrice, which includes Arbitrum Nitro L1 data gas.'] : profile.settlement === 'L2' ? [`Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`,
        'Self-transfer: the value leg nets to zero; the fee is gasUsed × effectiveGasPrice, which includes Arbitrum Nitro L1 data gas.',
        'This is a chain execution proof, not a DeFi capability.'] :
        [`Inclusion is verified at ${profile.network} block level after ${profile.minimumConfirmations} confirmations; finalized-checkpoint status is not claimed.`,
          'Self-transfer: the value leg nets to zero; the fee is gasUsed × effectiveGasPrice.',
          'This is a chain execution proof, not a DeFi capability.'] },
    evidence: [{ evidenceId: 'native-transfer-public-observations', kind: 'EXTERNAL_REFERENCE', contentHash: supplyHash(publicExecution) }] };
  return { bundle, bundleHash: supplyArtifactHash('evidence-bundle', bundle), publicExecution,
    artifacts: { workflow: review.workflow, artifactSet: review.artifactSet, simulation: review.simulation, policy: review.policy,
      manifest: review.manifest, plan: review.plan, journal: input.journal, review } };
}
