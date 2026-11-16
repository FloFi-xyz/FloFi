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
 *
 * BUILD-FLOFI-7702-TRANSFER-001: an owner reviewed as a MetaMask Smart Account (`review.state.ownerDelegation`) is reconciled in either of the
 * two ways its wallet can submit the reviewed call. Direct: the owner account itself sent and paid for the reviewed transaction (every direct
 * check above). Relayed (token transfers only): a third party sent one single-use `redeemDelegations` of exactly the reviewed call through the
 * MetaMask Delegation Manager, proven by the coordinator's `relayed` verifier (the Delegation Framework rules owner-bound swaps already use); the
 * relayer paid the network fee, so the owner's fee is 0 and its nonce is untouched. Either way the owner's code must be the reviewed delegation
 * before and after the inclusion block, and the receipt alone must show exactly the reviewed transfer. A Smart Account's balances can also move
 * through relays that do not use its nonce, so when the block's balance changes are not exactly this transfer's the proof is the transaction and
 * receipt (`reconciliationScope: 'TRANSACTION'`). A standard account (EOA) is reconciled exactly as before.
 */
import { erc7710, rpcRecord, rpcHash, supplyHex, supplyHash, supplyArtifactHash, nativeTransferProfile,
  type NativeTransferReview, type TransferRpc } from '@defi-workflow-engine/reference-compiler';
import { transferL1FeeOracle } from '@defi-workflow-engine/action-registry';
import { hashJournalBytes, type EvidenceBundle, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';

export type TransferChainAttempt = { nonce: string; transactionHash: string | null; preparedAtBlock: number };
export type TransferObservation = { verdict: 'RECONCILED' | 'DIVERGENT' | 'INCONCLUSIVE'; reason: string;
  transaction: Record<string, unknown> | null; receipt: Record<string, unknown> | null;
  facts: { blockNumber: number; blockHash: string; gasUsed: string; effectiveGasPrice: string; fee: string; balanceBefore: string; balanceAfter: string;
    nonceBefore: string; nonceAfter: string; transactionType: string;
    /** HOTFIX-WORKFLOW-CONCURRENCY-001: TRANSACTION when other transactions of the owner shared the block (absent: block-level proof). */
    reconciliationScope?: 'TRANSACTION';
    /** Token transfers only. */ tokenBalanceBefore?: string; tokenBalanceAfter?: string; recipientTokenBalanceBefore?: string; recipientTokenBalanceAfter?: string;
    /** BUILD-FLOFI-7702-TRANSFER-001, Smart Account owners only: the reviewed EIP-7702 delegate, verified before and after the inclusion block. */
    ownerDelegation?: string;
    /**
     * BUILD-FLOFI-7702-TRANSFER-001, relayed submissions only: a third party (`gasPayer`) sent the transaction and paid `networkFee`; `fee` (what the
     * owner paid) is then 0. Absent: the owner sent the transaction and paid `fee` itself.
     */
    submission?: 'RELAYED'; gasPayer?: string; networkFee?: string } | null };
/**
 * BUILD-FLOFI-7702-TRANSFER-001: what the coordinator's relay verifier proved for a transaction the owner did not send itself: the relayer, the
 * receipt status, whether the redeemed delegation was single use (proven on chain), and the reviewed framework contracts that may log besides the
 * reviewed call (none of them moves funds). It throws `TRANSFER_TRANSACTION_MISMATCH` or `TRANSFER_SUBMISSION_UNSUPPORTED` for any other shape and
 * `TRANSFER_RECEIPT_NOT_CANONICAL` while the receipt is not final.
 */
export type TransferRelayProof = { relayer: string; status: 0 | 1; singleUse: boolean; frameworkLoggers: readonly string[] };
export type TransferRelayVerifier = (input: { review: NativeTransferReview; transactionHash: string; preparedAtBlock: number;
  transaction: Record<string, unknown>; receipt: Record<string, unknown> }) => Promise<TransferRelayProof>;
/** Verdicts that are divergence, never a provider failure: any mismatch, and every refused relayed shape. */
const DIVERGENT_REASON = /MISMATCH|WRONG_CHAIN|REORG|NOT_EOA|^TRANSFER_RELAYED_|^TRANSFER_SUBMISSION_UNSUPPORTED$/;
const DELEGATION_MANAGER = erc7710.DELEGATION_FRAMEWORK_V1_3.delegationManager;
/**
 * BUILD-FLOFI-7702-TRANSFER-001: whether another transaction in `block` redeemed a delegation rooted at the owner (a relay that moves the owner's
 * funds without its nonce): positive evidence that the block's balance changes are not this transfer's alone.
 */
async function ownerRedemptionElsewhere(rpc: TransferRpc, owner: string, block: number, hash: string): Promise<boolean> {
  const logs = await rpc('eth_getLogs', [{ address: DELEGATION_MANAGER, topics: [erc7710.REDEEMED_DELEGATION_TOPIC, '0x' + owner.slice(2).padStart(64, '0')],
    fromBlock: supplyHex(block), toBlock: supplyHex(block) }]);
  if (!Array.isArray(logs)) throw new Error('TRANSFER_RPC_INVALID');
  return logs.map(rpcRecord).some(log => log.removed !== true && typeof log.transactionHash === 'string' && log.transactionHash.toLowerCase() !== hash);
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** ERC-8056 `TransferWithScaledUI(address,address,uint256,uint256)`, emitted by Robinhood Stock Tokens next to `Transfer`. */
const SCALED_TRANSFER_TOPIC = '0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802';
const topicAddress = (value: unknown) => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/.test(value.toLowerCase()) ? '0x' + value.toLowerCase().slice(26) : null;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const strict = (value: unknown): bigint => { if (typeof value !== 'string' || !QUANTITY.test(value.toLowerCase())) throw new Error('TRANSFER_RPC_INVALID'); return BigInt(value); };
/** A 32-byte ABI word (eth_call result). */
const strictWord = (value: unknown): bigint => { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('TRANSFER_RPC_INVALID'); return BigInt(value); };

export async function reconcileNativeTransfer(review: NativeTransferReview, attempt: TransferChainAttempt, rpc: TransferRpc,
  options: { readonly relayed?: TransferRelayVerifier } = {}): Promise<TransferObservation> {
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
    const delegation = review.state.ownerDelegation ?? null;
    // The exact reviewed transaction (native: to the recipient with the value; token: to the token with the reviewed calldata).
    const target = review.transaction.to;
    if (rpcHash(tx.hash) !== attempt.transactionHash || rpcHash(receipt.transactionHash) !== attempt.transactionHash || attempt.nonce !== review.nonce ||
        strict(tx.chainId) !== BigInt(profile.chainId) || rpcHash(tx.blockHash) !== rpcHash(receipt.blockHash) || strict(tx.blockNumber) !== strict(receipt.blockNumber) ||
        typeof tx.from !== 'string' || typeof receipt.from !== 'string' || receipt.from.toLowerCase() !== tx.from.toLowerCase()) throw new Error('TRANSFER_TRANSACTION_MISMATCH');
    // BUILD-FLOFI-7702-TRANSFER-001: a transaction the owner did not send is only ever a relayed redemption for a reviewed Smart Account, of a
    // token transfer (a relayed call carrying native value is not a shape FloFi reconciles), proven by the coordinator's relay verifier.
    let relay: TransferRelayProof | null = null;
    if (tx.from.toLowerCase() !== owner) {
      if (!delegation || !options.relayed) throw new Error('TRANSFER_TRANSACTION_MISMATCH');
      // Only a redemption through the Delegation Manager can be a relay of this owner's call; anything else is simply not this transfer.
      if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== DELEGATION_MANAGER) throw new Error('TRANSFER_TRANSACTION_MISMATCH');
      if (!token) throw new Error('TRANSFER_RELAYED_NATIVE_UNSUPPORTED');
      // Inclusion after preparation first: an older transaction is a mismatch, never a provider failure in the relay proof.
      const included = Number(strict(receipt.blockNumber));
      if (!Number.isSafeInteger(included) || included <= attempt.preparedAtBlock || included <= review.state.block) throw new Error('TRANSFER_BLOCK_MISMATCH');
      relay = await options.relayed({ review, transactionHash: attempt.transactionHash, preparedAtBlock: attempt.preparedAtBlock, transaction: tx, receipt });
      if (relay.relayer !== tx.from.toLowerCase() || relay.relayer === owner) throw new Error('TRANSFER_TRANSACTION_MISMATCH');
    } else if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== target || strict(tx.value) !== BigInt(review.transaction.value) || tx.input !== review.transaction.data ||
        strict(tx.nonce) !== BigInt(attempt.nonce) || !['0x0', '0x2'].includes(type) || typeof receipt.to !== 'string' || receipt.to.toLowerCase() !== target)
      throw new Error('TRANSFER_TRANSACTION_MISMATCH');
    // The reviewed fee bounds: the wallet may lower but never raise them. A relayer's own transaction is bounded by the relayer, never charged to the owner.
    const gasLimit = strict(tx.gas), offeredPrice = type === '0x2' ? strict(tx.maxFeePerGas) : strict(tx.gasPrice);
    if (!relay && (gasLimit > BigInt(review.gasLimit) || offeredPrice > BigInt(review.maxFeePerGas))) throw new Error('TRANSFER_FEE_BOUND_MISMATCH');
    const blockNumber = Number(strict(receipt.blockNumber));
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= attempt.preparedAtBlock || blockNumber <= review.state.block) throw new Error('TRANSFER_BLOCK_MISMATCH');
    const canonical = rpcRecord(await rpc('eth_getBlockByNumber', [supplyHex(blockNumber), false]));
    if (rpcHash(canonical.hash) !== rpcHash(receipt.blockHash) || !Array.isArray(canonical.transactions) ||
        !canonical.transactions.some(h => typeof h === 'string' && h.toLowerCase() === attempt.transactionHash)) throw new Error('TRANSFER_REORG');
    const latest = Number(strict(await rpc('eth_blockNumber', [])));
    if (latest < blockNumber + profile.minimumConfirmations) return { ...base, reason: 'AWAITING_CONFIRMATIONS' };
    // A reverted relay has no logs: nothing ties it to the owner and its authorization may still be redeemable. Divergent, never a result.
    if (strict(receipt.status) !== 1n) return { ...base, verdict: 'DIVERGENT', reason: relay ? 'TRANSFER_RELAYED_SUBMISSION_REVERTED' : 'TRANSFER_REVERTED' };
    // A native transfer between externally owned accounts emits no logs. A token transfer emits only the token's own transfer
    // log(s) for exactly (owner → recipient, amount); anything else is unexplained.
    if (!Array.isArray(receipt.logs)) throw new Error('TRANSFER_LOGS_MISMATCH');
    // A relayed redemption also logs the reviewed framework's bookkeeping (the manager's RedeemedDelegation, LimitedCalls' IncreasedCount),
    // already proven by the relay verifier; the authorization must be single use, so the relay can never execute the reviewed call again.
    let logs: unknown[] = receipt.logs;
    if (relay) {
      if (relay.status !== 1) throw new Error('TRANSFER_TRANSACTION_MISMATCH');
      if (!relay.singleUse) throw new Error('TRANSFER_RELAYED_DELEGATION_NOT_SINGLE_USE');
      const framework = new Set(relay.frameworkLoggers.map(a => a.toLowerCase()));
      logs = logs.filter(log => !(typeof rpcRecord(log).address === 'string' && framework.has(String(rpcRecord(log).address).toLowerCase())));
    }
    if (!token) {
      const recipientCode = review.state.recipientCodeHash === undefined ? '0x' : await rpc('eth_getCode', [review.recipient, supplyHex(blockNumber - 1)]);
      if (review.state.recipientCodeHash !== undefined && supplyHash(recipientCode) !== review.state.recipientCodeHash)
        throw new Error('TRANSFER_RECIPIENT_CODE_MISMATCH');
      // A reviewed value-only call can run the recipient's receive/fallback code. The owner debit is still exact below.
      // A Smart Account's self-transfer runs its reviewed delegate's receive(), which logs nothing.
      if ((review.state.recipientCodeHash === undefined || recipientCode === '0x' || review.recipient === owner) && logs.length) throw new Error('TRANSFER_LOGS_MISMATCH');
    }
    if (token) {
      const records = logs.map(rpcRecord);
      const transfers = records.filter(log => Array.isArray(log.topics) && log.topics[0] === TRANSFER_TOPIC);
      const scaled = records.filter(log => Array.isArray(log.topics) && log.topics[0] === SCALED_TRANSFER_TOPIC);
      const ok = (log: Record<string, unknown>) => typeof log.address === 'string' && log.address.toLowerCase() === token.token && Array.isArray(log.topics) &&
        topicAddress(log.topics[1]) === owner && topicAddress(log.topics[2]) === review.recipient && typeof log.data === 'string';
      if (records.length !== transfers.length + scaled.length || transfers.length !== 1 || scaled.length > (token.officialId ? 1 : 0) ||
          !transfers.every(ok) || !scaled.every(ok) || strictWord('0x' + (transfers[0]!.data as string).slice(2, 66)) !== BigInt(review.value) ||
          scaled.some(log => strictWord('0x' + (log.data as string).slice(2, 66)) !== BigInt(review.value))) throw new Error('TRANSFER_LOGS_MISMATCH');
    }
    const gasUsed = strict(receipt.gasUsed), effectiveGasPrice = strict(receipt.effectiveGasPrice);
    if (gasUsed > gasLimit || effectiveGasPrice > offeredPrice) throw new Error('TRANSFER_FEE_BOUND_MISMATCH');
    // gasLimit/offeredPrice are the sender's own: for a relay they bound the relayer's transaction, as a receipt must.
    // Ethereum L1 charges gasUsed × effectiveGasPrice; Arbitrum Nitro also folds L1 data into gasUsed. No separate L1 fee.
    // BUILD-BASE-001: an OP Stack receipt adds its own `l1Fee`, which the owner also pays.
    const opStack = transferL1FeeOracle(profile) !== null;
    if (opStack && receipt.l1Fee === undefined) throw new Error('TRANSFER_RECEIPT_L1_FEE_MISMATCH');
    const l1Fee = opStack ? strict(receipt.l1Fee) : 0n;
    // The network fee of this transaction. The owner paid it on a direct submission (bounded by the Review); a relayer paid it on a relayed one.
    const networkFee = gasUsed * effectiveGasPrice + l1Fee, fee = relay ? 0n : networkFee;
    if (fee > BigInt(review.feeBudget)) throw new Error('TRANSFER_FEE_BOUND_MISMATCH');
    const before = supplyHex(blockNumber - 1), after = supplyHex(blockNumber);
    const [balanceBefore, balanceAfter, nonceBefore, nonceAfter, code, codeBefore] = await Promise.all([
      rpc('eth_getBalance', [owner, before]).then(strict), rpc('eth_getBalance', [owner, after]).then(strict),
      rpc('eth_getTransactionCount', [owner, before]).then(strict), rpc('eth_getTransactionCount', [owner, after]).then(strict),
      rpc('eth_getCode', [owner, after]), delegation ? rpc('eth_getCode', [owner, before]) : Promise.resolve('0x')]);
    // BUILD-FLOFI-7702-TRANSFER-001: the owner account was the reviewed one around the inclusion block: no code for a standard account, exactly
    // the reviewed delegation designator for a Smart Account (an unreviewed delegate could have acted on what the account received).
    if (delegation) {
      const designator = '0xef0100' + delegation.slice(2);
      if (String(code).toLowerCase() !== designator || String(codeBefore).toLowerCase() !== designator) throw new Error('TRANSFER_OWNER_ACCOUNT_CODE_MISMATCH');
    } else if (code !== '0x') throw new Error('TRANSFER_OWNER_NOT_EOA');
    // Exactly one owner transaction in the inclusion block, and it consumed the reviewed nonce: the balance changes are this transfer's alone.
    // HOTFIX-WORKFLOW-CONCURRENCY-001: independent transactions of the same owner may share the block. The block then holds this transaction's
    // reviewed nonce among others, and its balance changes are not this transfer's alone: it is proven from its own transaction (exact call,
    // nonce, fee bounds) and receipt (status, fee, and for a token exactly its transfer log) instead.
    const reviewed = BigInt(review.nonce), consumed = nonceBefore <= reviewed && nonceAfter > reviewed;
    // ETH leaves the owner by exactly the fee it paid, plus the value when it goes to someone else (a self-transfer's value leg nets to zero).
    const valueOut = !token && review.recipient !== owner ? BigInt(review.value) : 0n;
    const tokenDeltas = async () => {
      const balanceOf = (account: string, block: string) => rpc('eth_call', [{ to: token!.token, data: '0x70a08231' + account.slice(2).padStart(64, '0') }, block]).then(strictWord);
      const [ownerBefore, ownerAfter, recipientBefore, recipientAfter] = await Promise.all([balanceOf(owner, before), balanceOf(owner, after),
        balanceOf(review.recipient, before), balanceOf(review.recipient, after)]);
      const self = review.recipient === owner, amount = BigInt(review.value);
      const exact = self ? ownerBefore === ownerAfter : ownerBefore - ownerAfter === amount && recipientAfter - recipientBefore === amount;
      return { exact, facts: { tokenBalanceBefore: ownerBefore.toString(), tokenBalanceAfter: ownerAfter.toString(), recipientTokenBalanceBefore: recipientBefore.toString(),
        recipientTokenBalanceAfter: recipientAfter.toString() } };
    };
    let tokenFacts = {}, shared: boolean;
    if (!delegation) {
      shared = consumed && nonceAfter - nonceBefore > 1n;
      if (!shared && (nonceBefore !== reviewed || nonceAfter !== nonceBefore + 1n)) throw new Error('TRANSFER_NONCE_MISMATCH');
      if (!shared && (balanceBefore - balanceAfter !== fee + valueOut || balanceBefore < (token ? 0n : BigInt(review.value)) + fee)) throw new Error('TRANSFER_BALANCE_MISMATCH');
      if (token && !shared) {
        const deltas = await tokenDeltas();
        if (!deltas.exact) throw new Error('TRANSFER_TOKEN_BALANCE_MISMATCH');
        tokenFacts = deltas.facts;
      }
    } else {
      // A direct submission consumed the reviewed nonce in this block; a relayed one uses the relayer's nonce, never the owner's.
      if (!relay && !consumed) throw new Error('TRANSFER_NONCE_MISMATCH');
      // The block-level proof holds when the block's changes are exactly this transfer's. Only positive evidence that something else of the
      // owner moved in the block (another of its transactions, or another redemption rooted at it) makes the transaction and receipt the
      // proof instead; an unexplained difference is a mismatch, exactly as for a standard account.
      const nonceExact = relay ? nonceAfter === nonceBefore : nonceBefore === reviewed && nonceAfter === nonceBefore + 1n;
      const deltas = token ? await tokenDeltas() : null;
      shared = !(nonceExact && balanceBefore - balanceAfter === fee + valueOut && (!deltas || deltas.exact));
      if (shared && nonceExact && !await ownerRedemptionElsewhere(rpc, owner, blockNumber, attempt.transactionHash))
        throw new Error(deltas && !deltas.exact ? 'TRANSFER_TOKEN_BALANCE_MISMATCH' : 'TRANSFER_BALANCE_MISMATCH');
      if (deltas && !shared) tokenFacts = deltas.facts;
    }
    const final = rpcRecord(await rpc('eth_getBlockByNumber', [after, false]));
    if (rpcHash(final.hash) !== rpcHash(receipt.blockHash)) throw new Error('TRANSFER_REORG');
    return { ...base, verdict: 'RECONCILED', reason: token ? 'TOKEN_TRANSFER_VERIFIED' : 'NATIVE_TRANSFER_VERIFIED', facts: { blockNumber, blockHash: rpcHash(receipt.blockHash),
      gasUsed: gasUsed.toString(), effectiveGasPrice: effectiveGasPrice.toString(), fee: fee.toString(), balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(), nonceBefore: nonceBefore.toString(), nonceAfter: nonceAfter.toString(), transactionType: type, ...tokenFacts,
      ...shared ? { reconciliationScope: 'TRANSACTION' as const } : {}, ...delegation ? { ownerDelegation: delegation } : {},
      ...relay ? { submission: 'RELAYED' as const, gasPayer: relay.relayer, networkFee: networkFee.toString() } : {} } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'TRANSFER_OBSERVATION_FAILED';
    // Provider failures stay ambiguous; any mismatch never reconciles.
    return { ...base, verdict: DIVERGENT_REASON.test(message) ? 'DIVERGENT' : 'INCONCLUSIVE', reason: message };
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
      limitations: o.facts.ownerDelegation !== undefined ? delegatedLimitations(review, o.facts, profile) : [...o.facts.reconciliationScope === 'TRANSACTION' ? ['Other transactions of this wallet were included in the same block, so the block-level balance changes are not this transfer\'s alone: ' +
        'it is verified from its own transaction (exact call, nonce and fee bounds) and receipt (status, fee' + (review.asset ? ' and its exact token transfer log' : '') + ').'] : [],
        ...transferL1FeeOracle(profile) ? [
        `Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`,
        review.asset ? 'Token transfer: exact transfer(recipient, amount) call, its transfer log(s) and both token balances; ETH moved by exactly the fee.'
          : review.recipient !== review.account ? 'Native transfer to an explicit recipient: the owner balance moved by exactly the value plus the fee.'
          : 'Self-transfer: the value leg nets to zero; the owner balance moved by exactly the fee.',
        'The fee is gasUsed × effectiveGasPrice plus the OP Stack L1 data fee (l1Fee) of the receipt.']
        : review.asset || review.recipient !== review.account ? [
        profile.settlement === 'L1' ? `Inclusion is verified on ${profile.network} (L1) after ${profile.minimumConfirmations} confirmations; finalized-checkpoint status is not claimed.`
          : `Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`,
        review.asset ? 'Token transfer: exact transfer(recipient, amount) call, its transfer log(s) and both token balances; ETH moved by exactly the fee.'
          : 'Native transfer to an explicit recipient: the exact value-only call and owner debit (value plus fee) are verified; contract recipients may execute their receive/fallback code.',
        profile.settlement === 'L1' ? 'The network fee is gasUsed × effectiveGasPrice.' : 'The fee is gasUsed × effectiveGasPrice, which includes Arbitrum Nitro L1 data gas.'] : profile.settlement === 'L2' ? [`Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`,
        'Self-transfer: the value leg nets to zero; the fee is gasUsed × effectiveGasPrice, which includes Arbitrum Nitro L1 data gas.',
        'This is a chain execution proof, not a DeFi capability.'] :
        [`Inclusion is verified at ${profile.network} block level after ${profile.minimumConfirmations} confirmations; finalized-checkpoint status is not claimed.`,
          'Self-transfer: the value leg nets to zero; the fee is gasUsed × effectiveGasPrice.',
          'This is a chain execution proof, not a DeFi capability.']] },
    evidence: [{ evidenceId: 'native-transfer-public-observations', kind: 'EXTERNAL_REFERENCE', contentHash: supplyHash(publicExecution) }] };
  return { bundle, bundleHash: supplyArtifactHash('evidence-bundle', bundle), publicExecution,
    artifacts: { workflow: review.workflow, artifactSet: review.artifactSet, simulation: review.simulation, policy: review.policy,
      manifest: review.manifest, plan: review.plan, journal: input.journal, review } };
}
/**
 * BUILD-FLOFI-7702-TRANSFER-001: what the evidence of a Smart Account owner's transfer does and does not prove, stated from the facts the
 * reconciler established (who sent and paid, and whether the block-level balance proof or the transaction and receipt carry it).
 */
function delegatedLimitations(review: NativeTransferReview, facts: NonNullable<TransferObservation['facts']>, profile: ReturnType<typeof nativeTransferProfile>): string[] {
  const relayed = facts.submission === 'RELAYED', blockLevel = facts.reconciliationScope !== 'TRANSACTION', opStack = transferL1FeeOracle(profile) !== null;
  const self = review.recipient === review.account;
  return [
    `The owner is a MetaMask Smart Account: an EIP-7702 delegation to the reviewed DeleGator ${facts.ownerDelegation}, verified unchanged before and after the inclusion block.`,
    relayed ? `Relayed submission: ${facts.gasPayer} sent one single-use redemption of exactly the reviewed call through the MetaMask Delegation Manager and paid the ` +
      `network fee (${facts.networkFee} wei); the owner paid no network fee and its nonce was not used.`
      : 'Direct submission: the owner account sent the reviewed transaction at the reviewed nonce, within the reviewed fee bounds, and paid its network fee.',
    ...blockLevel ? [] : ['Another transaction or relayed redemption of this account was included in the same block, so the block-level balance changes were not ' +
      'this transfer\'s alone: it is verified from its own transaction and receipt (status' + (relayed ? '' : ', fee') + (review.asset ? ' and its exact token transfer log'
        : self || review.state.recipientCodeHash === undefined || review.state.recipientCodeHash === supplyHash('0x') ? ', no logs' : '') + ').'],
    opStack || profile.settlement === 'L2' ? `Inclusion is verified at ${profile.network} (L2) sequencer level after confirmations; L1 finality is not claimed.`
      : `Inclusion is verified on ${profile.network} (L1) after ${profile.minimumConfirmations} confirmations; finalized-checkpoint status is not claimed.`,
    review.asset ? 'Token transfer: exact transfer(recipient, amount) call and its transfer log(s)' + (blockLevel ? '; both token balances moved by exactly the amount' : '') + '.'
      : self ? 'Self-transfer: the value leg nets to zero; the reviewed delegate\'s receive() ran and logged nothing.'
      : 'Native transfer to an explicit recipient: the exact value-only call' + (blockLevel ? ' and the owner debit (value plus fee)' : '') + ' are verified.',
    (relayed ? 'The relayer\'s network fee is ' : 'The network fee is ') + (opStack ? 'gasUsed × effectiveGasPrice plus the OP Stack L1 data fee (l1Fee) of the receipt.'
      : profile.settlement === 'L1' ? 'gasUsed × effectiveGasPrice.' : 'gasUsed × effectiveGasPrice, which includes Arbitrum Nitro L1 data gas.')];
}
