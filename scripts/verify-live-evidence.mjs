#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * BUILD-FLOFI-UNIVERSAL-E2E-001: re-verify, read-only, every public execution in the execution ledger against public RPC endpoints.
 * It holds no key, signs nothing and sends no transaction: it only reads transactions, receipts and blocks.
 *
 *   node scripts/verify-live-evidence.mjs docs/builds/BUILD-FLOFI-UNIVERSAL-E2E-001-EXECUTION-LEDGER.json [out.json]
 *
 * EVM: the transaction exists on the ledger's chain id, its receipt has status 1, it is in the canonical block (the block hash at its
 * number equals the receipt's), at the recorded block when one is recorded, and the owner is the sender or appears in a log topic
 * (relayed EIP-7702 / delegated redemptions are sent by a relayer). Solana: the signature is finalized without error, at the recorded slot,
 * and the owner signed it. History a public endpoint no longer serves is reported as UNAVAILABLE, never as verified.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ENDPOINTS = {
  'eip155:84532': 'https://sepolia.base.org',
  'eip155:46630': 'https://rpc.testnet.chain.robinhood.com',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'https://api.devnet.solana.com',
};
const [ledgerPath, outPath] = process.argv.slice(2);
if (!ledgerPath) { console.error('usage: verify-live-evidence.mjs <ledger.json> [out.json]'); process.exit(2); }
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));

async function rpc(url, method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000) }).catch(cause => ({ ok: false, status: 0, cause }));
    if (response.ok) {
      const body = await response.json();
      if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
      return body.result;
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error(`${method}: endpoint unavailable`);
}
const topicOf = address => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

async function verifyEvm(entry, tx, url) {
  const expectedChainId = BigInt(entry.chain.split(':')[1]);
  const [transaction, receipt, head] = await Promise.all([rpc(url, 'eth_getTransactionByHash', [tx.hash]), rpc(url, 'eth_getTransactionReceipt', [tx.hash]),
    rpc(url, 'eth_blockNumber', [])]);
  if (!transaction || !receipt) return { status: 'UNAVAILABLE', reason: 'transaction or receipt not served' };
  const block = Number(BigInt(receipt.blockNumber)), canonical = await rpc(url, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
  const owner = entry.owner?.toLowerCase() ?? null;
  const checks = {
    chainId: transaction.chainId !== undefined && BigInt(transaction.chainId) === expectedChainId,
    receiptStatus: receipt.status === '0x1',
    canonicalBlock: canonical?.hash === receipt.blockHash,
    recordedBlock: tx.block === undefined || tx.block === block,
    ownerInvolved: owner === null || transaction.from.toLowerCase() === owner || receipt.logs.some(log => log.topics.some(topic => topic.toLowerCase() === topicOf(owner))),
  };
  return { status: Object.values(checks).every(Boolean) ? 'VERIFIED' : 'MISMATCH', checks, block, blockHash: receipt.blockHash, confirmations: Number(BigInt(head)) - block,
    sender: transaction.from, to: transaction.to, gasUsed: BigInt(receipt.gasUsed).toString() };
}
async function verifySolana(entry, tx, url) {
  const result = await rpc(url, 'getTransaction', [tx.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (!result) return { status: 'UNAVAILABLE', reason: 'signature not served by this endpoint (history may be pruned)' };
  const message = result.transaction.message, signers = message.accountKeys.slice(0, message.header.numRequiredSignatures);
  const checks = {
    finalizedWithoutError: result.meta?.err === null,
    signature: result.transaction.signatures[0] === tx.signature,
    recordedSlot: tx.slot === undefined || tx.slot === result.slot,
    ownerSigned: entry.owner === null || signers.includes(entry.owner),
  };
  return { status: Object.values(checks).every(Boolean) ? 'VERIFIED' : 'MISMATCH', checks, slot: result.slot, blockTime: result.blockTime, fee: result.meta?.fee ?? null };
}

const results = [];
for (const entry of ledger.entries) {
  const url = ENDPOINTS[entry.chain];
  const transactions = [];
  for (const tx of entry.transactions) {
    let outcome;
    try { outcome = !url ? { status: 'UNAVAILABLE', reason: 'no public endpoint configured' } : entry.chain.startsWith('solana:') ? await verifySolana(entry, tx, url) : await verifyEvm(entry, tx, url); }
    catch (cause) { outcome = { status: 'UNAVAILABLE', reason: String(cause?.message ?? cause).slice(0, 200) }; }
    transactions.push({ role: tx.role, id: tx.hash ?? tx.signature, ...outcome });
  }
  const status = transactions.every(t => t.status === 'VERIFIED') ? 'VERIFIED' : transactions.some(t => t.status === 'MISMATCH') ? 'MISMATCH' : 'UNAVAILABLE';
  results.push({ id: entry.id, action: entry.action, network: entry.network, chain: entry.chain, endpoint: url ?? null, status, transactions });
  console.log(`${status.padEnd(11)} ${entry.id}`);
}
const report = { format: 'flofi.live-evidence-verification.v1', ledger: ledgerPath, readOnly: true, signed: false, broadcast: false, checkedAt: new Date().toISOString(), results };
if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.exitCode = results.every(result => result.status === 'VERIFIED') ? 0 : 1;
