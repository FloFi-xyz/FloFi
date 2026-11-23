// SPDX-License-Identifier: AGPL-3.0-only
import { assertErc4626DepositBinding, ERC4626_PROXY_SLOTS, fromHex, rpcHash, rpcRecord, rpcUint, supplyCall, supplyHex, supplyTopic, supplyWord, toHex,
  type Erc4626DepositProfile, type Erc4626DepositReview, type SupplyRpc } from '@defi-workflow-engine/reference-compiler';
import { hashSupplyValue } from '@defi-workflow-engine/workflow-contracts';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { TRANSFER_TOPIC } from './reconcile.js';
import { addressTopic, logMatches } from './supply.js';

export type Erc4626DepositObservation =
  | { readonly verdict: 'RECONCILED'; readonly reason: 'EXACT'; readonly transactionHash: string; readonly blockHash: string;
      readonly block: string; readonly shares: string; readonly assets: string; readonly gasCost: string; readonly receiptDigest: string }
  | { readonly verdict: 'INCONCLUSIVE' | 'DIVERGENT'; readonly reason: string };

const depositTopic = supplyTopic('Deposit(address,address,uint256,uint256)');
const zeroTopic = '0x' + '0'.repeat(64);
const lower = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : null;
const inconclusive = (reason: string): Erc4626DepositObservation => ({ verdict: 'INCONCLUSIVE', reason });
const divergent = (reason: string): Erc4626DepositObservation => ({ verdict: 'DIVERGENT', reason });
const codeDigest = (value: unknown) => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2}){1,24576}$/.test(value)
  ? toHex(keccak_256(fromHex(value.toLowerCase()))) : null;

/** Independent reads against the exact chain, block, transaction, logs and balances. Never retries a transaction. */
export async function reconcileErc4626Deposit(review: Erc4626DepositReview, profile: Erc4626DepositProfile, transactionHash: string,
  rpc: SupplyRpc): Promise<Erc4626DepositObservation> {
  let fields;
  try { fields = assertErc4626DepositBinding(review, profile); }
  catch { return divergent('VAULT_REVIEW_INVALID'); }
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) return divergent('VAULT_TRANSACTION_HASH_INVALID');
  const expected = review.transaction;
  try {
    if (rpcUint(await rpc('eth_chainId', [])) !== BigInt(expected.chainId)) return inconclusive('VAULT_WRONG_CHAIN');
    if (rpcHash(rpcRecord(await rpc('eth_getBlockByNumber', ['0x0', false])).hash) !== profile.genesisHash) return inconclusive('VAULT_WRONG_CHAIN');
    const [txValue, receiptValue] = await Promise.all([
      rpc('eth_getTransactionByHash', [transactionHash]), rpc('eth_getTransactionReceipt', [transactionHash]),
    ]);
    if (txValue === null || receiptValue === null) return inconclusive('VAULT_TRANSACTION_PENDING');
    const tx = rpcRecord(txValue), receipt = rpcRecord(receiptValue);
    const block = rpcUint(receipt.blockNumber), blockHash = rpcHash(receipt.blockHash), index = rpcUint(receipt.transactionIndex);
    const type = rpcUint(tx.type);
    if (block <= BigInt(review.block) || rpcHash(tx.hash) !== transactionHash || rpcHash(receipt.transactionHash) !== transactionHash ||
      rpcHash(tx.blockHash) !== blockHash || rpcUint(tx.blockNumber) !== block || rpcUint(tx.transactionIndex) !== index ||
      lower(tx.from) !== expected.from || lower(tx.to) !== expected.to || lower(receipt.from) !== expected.from || lower(receipt.to) !== expected.to ||
      lower(tx.input) !== expected.data || rpcUint(tx.value) !== 0n || rpcUint(tx.nonce) !== BigInt(expected.nonce) ||
      rpcUint(tx.chainId) !== BigInt(expected.chainId) || (type !== 0n && type !== 2n)) return divergent('VAULT_TRANSACTION_MISMATCH');
    // The reviewed fee bounds, as on the engine's other EVM paths: the wallet may lower gas and fees but never raise them.
    const gasLimit = rpcUint(tx.gas), offeredPrice = type === 2n ? rpcUint(tx.maxFeePerGas) : rpcUint(tx.gasPrice);
    if (gasLimit > BigInt(expected.gas) || offeredPrice > BigInt(expected.maxFeePerGas) ||
      (type === 2n && rpcUint(tx.maxPriorityFeePerGas) > offeredPrice)) return divergent('VAULT_FEE_BOUND_MISMATCH');
    const tag = supplyHex(block), parentTag = supplyHex(block - 1n);
    const [head, included, parent] = await Promise.all([
      rpc('eth_blockNumber', []).then(rpcUint), rpc('eth_getBlockByNumber', [tag, false]).then(rpcRecord),
      rpc('eth_getBlockByNumber', [parentTag, false]).then(rpcRecord),
    ]);
    if (rpcHash(included.hash) !== blockHash || rpcHash(included.parentHash) !== rpcHash(parent.hash) ||
      !Array.isArray(included.transactions) || index >= BigInt(included.transactions.length) ||
      lower(included.transactions[Number(index)]) !== transactionHash) return inconclusive('VAULT_REORG');
    if (head < block + BigInt(profile.minimumConfirmations)) return inconclusive('VAULT_CONFIRMATIONS_PENDING');
    if (rpcUint(receipt.status) !== 1n) return divergent('VAULT_TRANSACTION_REVERTED');
    const fee = rpcUint(receipt.gasUsed) * rpcUint(receipt.effectiveGasPrice);
    if (fee <= 0n || fee > BigInt(review.feeBudget) || rpcUint(receipt.gasUsed) > gasLimit ||
      rpcUint(receipt.effectiveGasPrice) > offeredPrice || (receipt.l1Fee != null && rpcUint(receipt.l1Fee) !== 0n)) {
      return divergent('VAULT_FEE_MISMATCH');
    }
    if (!Array.isArray(receipt.logs)) return divergent('VAULT_LOGS_INVALID');
    const ownerTopic = addressTopic(review.owner), vaultTopic = addressTopic(fields.vault);
    const deposits = receipt.logs.map(rpcRecord).filter(log => log.removed !== true && lower(log.address) === fields.vault && Array.isArray(log.topics)
      && log.topics[0] === depositTopic);
    const [deposit] = deposits, amount = BigInt(fields.amount), logged = deposit?.data;
    if (deposits.length !== 1 || typeof logged !== 'string' || !/^0x[0-9a-f]{128}$/.test(logged) ||
      !Array.isArray(deposit?.topics) || deposit.topics.length !== 3 || deposit.topics[1] !== ownerTopic ||
      deposit.topics[2] !== ownerTopic || BigInt('0x' + logged.slice(2, 66)) !== amount) return divergent('VAULT_DEPOSIT_LOG_MISMATCH');
    const shares = BigInt('0x' + logged.slice(66));
    if (shares < BigInt(fields.minimumShares) ||
      receipt.logs.filter(log => logMatches(log, fields.underlying, [TRANSFER_TOPIC, ownerTopic, vaultTopic], '0x' + supplyWord(amount))).length !== 1 ||
      receipt.logs.filter(log => logMatches(log, fields.vault, [TRANSFER_TOPIC, zeroTopic, ownerTopic], '0x' + supplyWord(shares))).length !== 1) {
      return divergent('VAULT_TRANSFER_LOG_MISMATCH');
    }
    const read = (to: string, data: string, blockTag: string) => rpc('eth_call', [{ to, data }, blockTag]).then(rpcUint);
    const balance = (to: string, blockTag: string) => read(to, supplyCall('balanceOf(address)', review.owner), blockTag);
    const allowance = (blockTag: string) => read(fields.underlying, supplyCall('allowance(address,address)', review.owner, fields.vault), blockTag);
    const proxySlots = (target: string) => Promise.all(ERC4626_PROXY_SLOTS.map(slot => rpc('eth_getStorageAt', [target, slot, tag]).then(rpcUint)));
    const [assetBefore, assetAfter, sharesBefore, sharesAfter, allowanceBefore, allowanceAfter, vaultCode, tokenCode, ownerCode, vaultSlots, tokenSlots] =
      await Promise.all([
        balance(fields.underlying, parentTag), balance(fields.underlying, tag), balance(fields.vault, parentTag), balance(fields.vault, tag),
        allowance(parentTag), allowance(tag), rpc('eth_getCode', [fields.vault, tag]), rpc('eth_getCode', [fields.underlying, tag]),
        rpc('eth_getCode', [review.owner, tag]), proxySlots(fields.vault), proxySlots(fields.underlying),
      ]);
    if (codeDigest(vaultCode) !== profile.vaultCodeHash || codeDigest(tokenCode) !== profile.underlyingCodeHash ||
      [...vaultSlots, ...tokenSlots].some(value => value !== 0n)) return divergent('VAULT_DEPLOYMENT_MISMATCH');
    if (ownerCode !== '0x') return divergent('VAULT_OWNER_NOT_EOA');
    if (assetBefore - assetAfter !== amount || sharesAfter - sharesBefore !== shares || allowanceBefore !== amount || allowanceAfter !== 0n)
      return divergent('VAULT_BALANCE_MISMATCH');
    const consistent = rpcRecord(await rpc('eth_getBlockByNumber', [tag, false]));
    if (rpcHash(consistent.hash) !== blockHash) return inconclusive('VAULT_REORG');
    return { verdict: 'RECONCILED', reason: 'EXACT', transactionHash, blockHash, block: block.toString(), shares: shares.toString(),
      assets: amount.toString(), gasCost: fee.toString(), receiptDigest: hashSupplyValue(receipt) };
  } catch { return inconclusive('VAULT_CHAIN_EVIDENCE_UNAVAILABLE'); }
}
