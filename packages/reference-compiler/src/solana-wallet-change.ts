// SPDX-License-Identifier: AGPL-3.0-only
import { sha256 } from '@noble/hashes/sha2.js';
import { decompileMessageV0, parseMessageV0, parseTransaction, type LookupTables, type MessageV0, type SolanaInstruction } from './solana.js';

/**
 * Diagnostic only: what a wallet changed between the reviewed message and the transaction it returned. It never accepts,
 * repairs or forwards anything (the exact-byte check still decides), and it records no signature or transaction bytes,
 * only public keys, counts and hashes, so it can be journaled and shown to the owner.
 */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const LIMIT = 16;
// Runs in the browser (the liquidity step checks the wallet's bytes there) and on the server: no Node Buffer.
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const hash = (bytes: Uint8Array) => '0x' + hex(sha256(bytes));
function decode(text: unknown): Uint8Array {
  if (typeof text !== 'string' || text.length > 4_096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('SOLANA_BASE64_INVALID');
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}
export type SolanaComputeBudget = { unitLimit: number | null; unitPrice: string | null };
export type SolanaWalletChange = {
  format: 'flofi.solana-wallet-change.v1';
  /** False when the returned bytes are not one readable v0 transaction. */
  parseable: boolean;
  signatures: number | null;
  reviewedMessageHash: string;
  returnedMessageHash: string | null;
  sameMessage: boolean;
  feePayerChanged: boolean | null;
  blockhashChanged: boolean | null;
  signersChanged: boolean | null;
  /** Lookup tables the review does not know, so returned instructions that use them cannot be resolved. */
  unknownLookupTables: boolean | null;
  reviewedInstructions: number;
  returnedInstructions: number | null;
  /** Every reviewed instruction is still present, byte for byte and in order. */
  reviewedInstructionsPreserved: boolean | null;
  /** Returned instructions that are not reviewed ones (bounded). */
  added: { index: number; programId: string; accounts: number; dataBytes: number }[];
  /** Reviewed instructions that are missing or changed (bounded). */
  missing: { index: number; programId: string }[];
  addedAccounts: { address: string; writable: boolean; signer: boolean }[];
  computeBudget: { reviewed: SolanaComputeBudget; returned: SolanaComputeBudget | null };
  /** Programs of the added instructions, e.g. the Lighthouse guard program some wallets append. */
  addedPrograms: string[];
};
const readLe = (data: Uint8Array, offset: number, bytes: number) => {
  let value = 0n;
  for (let i = bytes - 1; i >= 0; i--) value = value * 256n + BigInt(data[offset + i]!);
  return value;
};
function computeBudget(instructions: readonly SolanaInstruction[]): SolanaComputeBudget {
  const out: SolanaComputeBudget = { unitLimit: null, unitPrice: null };
  for (const ix of instructions) if (ix.programId === COMPUTE_BUDGET) {
    if (ix.data[0] === 2 && ix.data.length === 5) out.unitLimit = Number(readLe(ix.data, 1, 4));
    if (ix.data[0] === 3 && ix.data.length === 9) out.unitPrice = readLe(ix.data, 1, 8).toString();
  }
  return out;
}
const key = (ix: SolanaInstruction) => `${ix.programId}|${ix.accounts.map(a => `${a.pubkey}:${+a.isSigner}${+a.isWritable}`).join(',')}|${hex(ix.data)}`;
const signers = (message: MessageV0) => message.staticKeys.slice(0, message.header[0]).join(',');

export function describeSolanaWalletChange(reviewedMessage: string, returned: unknown, tables: LookupTables = {}): SolanaWalletChange {
  const reviewedBytes = decode(reviewedMessage), reviewed = parseMessageV0(reviewedBytes), reviewedIxs = decompileMessageV0(reviewed, tables);
  const change: SolanaWalletChange = { format: 'flofi.solana-wallet-change.v1', parseable: false, signatures: null, reviewedMessageHash: hash(reviewedBytes), returnedMessageHash: null,
    sameMessage: false, feePayerChanged: null, blockhashChanged: null, signersChanged: null, unknownLookupTables: null, reviewedInstructions: reviewedIxs.length,
    returnedInstructions: null, reviewedInstructionsPreserved: null, added: [], missing: [], addedAccounts: [], computeBudget: { reviewed: computeBudget(reviewedIxs), returned: null },
    addedPrograms: [] };
  let message: MessageV0, bytes: Uint8Array;
  try {
    const parsed = parseTransaction(decode(returned));
    change.signatures = parsed.signatures.length;
    bytes = parsed.message; message = parseMessageV0(bytes);
  } catch { return change; }
  change.parseable = true;
  change.returnedMessageHash = hash(bytes);
  change.sameMessage = change.returnedMessageHash === change.reviewedMessageHash;
  change.feePayerChanged = message.staticKeys[0] !== reviewed.staticKeys[0];
  change.blockhashChanged = message.blockhash !== reviewed.blockhash;
  change.signersChanged = signers(message) !== signers(reviewed);
  change.returnedInstructions = message.instructions.length;
  change.unknownLookupTables = message.lookups.some(l => !tables[l.table]);
  const known = new Set([...reviewed.staticKeys, ...reviewedIxs.flatMap(ix => [ix.programId, ...ix.accounts.map(a => a.pubkey)])]);
  let returnedIxs: SolanaInstruction[];
  try { returnedIxs = decompileMessageV0(message, tables); } catch {
    // Unresolvable lookups: report the statically known programs only.
    change.addedPrograms = [...new Set(message.instructions.map(ix => message.staticKeys[ix.programIdIndex]).filter((p): p is string => Boolean(p) && !known.has(p!)))].slice(0, LIMIT);
    return change;
  }
  change.computeBudget.returned = computeBudget(returnedIxs);
  // The reviewed instructions as an ordered subsequence of the returned ones; everything else was added by the wallet.
  let next = 0;
  returnedIxs.forEach((ix, index) => {
    if (next < reviewedIxs.length && key(ix) === key(reviewedIxs[next]!)) { next++; return; }
    if (change.added.length < LIMIT) change.added.push({ index, programId: ix.programId, accounts: ix.accounts.length, dataBytes: ix.data.length });
  });
  change.reviewedInstructionsPreserved = next === reviewedIxs.length;
  for (let index = next; index < reviewedIxs.length && change.missing.length < LIMIT; index++) change.missing.push({ index, programId: reviewedIxs[index]!.programId });
  const seen = new Set<string>();
  for (const ix of returnedIxs) for (const account of [{ pubkey: ix.programId, isWritable: false, isSigner: false }, ...ix.accounts]) {
    if (known.has(account.pubkey) || seen.has(account.pubkey) || change.addedAccounts.length >= LIMIT) continue;
    seen.add(account.pubkey);
    change.addedAccounts.push({ address: account.pubkey, writable: account.isWritable, signer: account.isSigner });
  }
  change.addedPrograms = [...new Set(change.added.map(ix => ix.programId))];
  return change;
}
/** Whether a refused transaction was the reviewed one plus instructions the wallet appended (for the owner-facing reason). */
export function walletAppendedInstructions(change: SolanaWalletChange | null | undefined): boolean {
  return Boolean(change?.parseable && change.reviewedInstructionsPreserved && change.added.length > 0 && !change.feePayerChanged && !change.blockhashChanged);
}
