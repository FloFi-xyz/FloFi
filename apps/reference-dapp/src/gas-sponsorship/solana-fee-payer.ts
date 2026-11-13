// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: a sponsored Solana fee payer. On Solana there is no paymaster: the transaction's fee payer is its first signer.
 * FloFi's sponsor key (an operational key, never a user's) is that fee payer; the owner is still the signer that authorizes every instruction.
 *
 *   build   the reviewed instructions compiled with `payer = sponsor`: the sponsor is static key 0 and signs only to pay the fee;
 *   policy  before the sponsor ever signs, the exact message must: name the sponsor as fee payer; require exactly the sponsor and the owner as
 *           signers; never reference the sponsor in any instruction (so no instruction can debit, close or reassign it — the sponsor pays the fee and
 *           nothing else; account rent, e.g. a token account the deposit creates, stays the owner's and is disclosed at Review); call only the
 *           programs the caller allows (Compute Budget always); carry a compute limit and price whose worst-case fee (5 000 lamports per signature
 *           plus price × limit) is within the per-transaction cap; and use the reviewed recent blockhash;
 *   verify  the owner's signature over exactly that message (the sponsor's slot still empty: the owner's signature is never replaced);
 *   cosign  the sponsor's signature added in slot 0; the transaction is then complete and broadcast by the caller exactly once.
 * The budget and the sponsor's balance floor are the caller's (ledger) checks. Nothing here broadcasts.
 */
import { createPrivateKey, createPublicKey, sign as signBytes } from 'node:crypto';
import { base58Decode, base58Encode, compileMessageV0, parseMessageV0, parseTransaction, serializeMessageV0, serializeSignedTransaction, solanaMessageHash, verifyEd25519,
  type LookupTables, type SolanaInstruction } from '@defi-workflow-engine/reference-compiler';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const LAMPORTS_PER_SIGNATURE = 5_000n;
const fail = (code: string): never => { throw new Error(code); };

/** The sponsor's public key and signer from its 64-byte secret (seed ‖ public key, the Solana keypair format). */
export function solanaSponsorSigner(secretKey: Uint8Array): { readonly publicKey: string; sign(message: Uint8Array): Uint8Array } {
  if (secretKey.length !== 64) fail('GAS_SPONSOR_SOLANA_KEY_INVALID');
  const seed = secretKey.slice(0, 32), key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const derived = Uint8Array.from(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12));
  if (base58Encode(derived) !== base58Encode(secretKey.slice(32))) fail('GAS_SPONSOR_SOLANA_KEY_INVALID');
  return { publicKey: base58Encode(derived), sign: message => Uint8Array.from(signBytes(null, message, key)) };
}
/** The reviewed instructions as a message whose fee payer is the sponsor (base64 of the serialized v0 message, and its hash). */
export function sponsoredMessage(sponsor: string, instructions: readonly SolanaInstruction[], blockhash: string, tables: LookupTables = {}) {
  const message = serializeMessageV0(compileMessageV0(sponsor, instructions, blockhash, tables));
  return { message, messageHash: solanaMessageHash(message), unsignedTransaction: serializeSignedTransaction([null, null], message) };
}
export type SponsorPolicy = { readonly sponsor: string; readonly owner: string; readonly blockhash: string; readonly allowedPrograms: readonly string[];
  readonly maxLamportsPerTx: bigint };
/** The compute limit and price a message sets (Compute Budget `SetComputeUnitLimit` = 2, `SetComputeUnitPrice` = 3; Solana's default limit otherwise). */
function computeBudget(message: ReturnType<typeof parseMessageV0>): { limit: bigint; price: bigint } {
  let limit = 200_000n * BigInt(Math.max(1, message.instructions.length)), price = 0n;
  for (const ix of message.instructions) {
    if (message.staticKeys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM) continue;
    const d = ix.data, view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (d[0] === 2 && d.length === 5) limit = BigInt(view.getUint32(1, true));
    else if (d[0] === 3 && d.length === 9) price = view.getBigUint64(1, true);
    else fail('GAS_SPONSOR_SOLANA_COMPUTE_BUDGET_UNSUPPORTED');
  }
  return { limit, price };
}
/** The worst-case fee the sponsor pays for a message (base fee per signature + priority fee), in lamports. */
export function sponsoredFeeUpperBound(messageBytes: Uint8Array): bigint {
  const message = parseMessageV0(messageBytes), { limit, price } = computeBudget(message);
  return LAMPORTS_PER_SIGNATURE * BigInt(message.header[0]) + (price * limit + 999_999n) / 1_000_000n;
}
/** The sponsor-safety policy of an exact message (see the module comment); returns its worst-case fee. */
export function assertSponsorableMessage(messageBytes: Uint8Array, policy: SponsorPolicy): bigint {
  const message = parseMessageV0(messageBytes);
  if (message.staticKeys[0] !== policy.sponsor) fail('GAS_SPONSOR_SOLANA_FEE_PAYER_MISMATCH');
  // Exactly two required signers: the sponsor (fee) and the owner (authority); the owner is never the fee payer here.
  if (message.header[0] !== 2 || message.staticKeys[1] !== policy.owner || policy.owner === policy.sponsor) fail('GAS_SPONSOR_SOLANA_SIGNERS_INVALID');
  if (message.blockhash !== policy.blockhash) fail('GAS_SPONSOR_SOLANA_BLOCKHASH_MISMATCH');
  // Address lookup tables could hide the sponsor in an instruction: a sponsored message carries none.
  if (message.lookups.length) fail('GAS_SPONSOR_SOLANA_LOOKUP_TABLES_REFUSED');
  const allowed = new Set([COMPUTE_BUDGET_PROGRAM, ...policy.allowedPrograms]);
  for (const ix of message.instructions) {
    if (!allowed.has(message.staticKeys[ix.programIdIndex] ?? '')) fail('GAS_SPONSOR_SOLANA_PROGRAM_NOT_ALLOWED');
    if (ix.accounts.includes(0) || ix.programIdIndex === 0) fail('GAS_SPONSOR_SOLANA_SPONSOR_REFERENCED');
  }
  const fee = sponsoredFeeUpperBound(messageBytes);
  if (fee > policy.maxLamportsPerTx) fail('GAS_SPONSOR_SOLANA_FEE_ABOVE_CAP');
  return fee;
}
/**
 * The owner-signed transaction (wire bytes): exactly two signature slots, the sponsor's still empty, the owner's valid over exactly the reviewed
 * message (hash), which passes the policy. Returns the complete transaction with the sponsor's signature added, and the worst-case fee.
 */
export function cosignSponsoredTransaction(signed: Uint8Array, input: { readonly messageHash: string; readonly policy: SponsorPolicy;
  readonly signer: ReturnType<typeof solanaSponsorSigner> }): { readonly transaction: Uint8Array; readonly signature: string; readonly maxFee: bigint } {
  const { signatures, message } = parseTransaction(signed);
  if (signatures.length !== 2) fail('GAS_SPONSOR_SOLANA_SIGNATURES_INVALID');
  if (solanaMessageHash(message) !== input.messageHash) fail('GAS_SPONSOR_SOLANA_MESSAGE_CHANGED');
  if (input.signer.publicKey !== input.policy.sponsor) fail('GAS_SPONSOR_SOLANA_FEE_PAYER_MISMATCH');
  const maxFee = assertSponsorableMessage(message, input.policy);
  if (signatures[0]!.some(byte => byte !== 0)) fail('GAS_SPONSOR_SOLANA_SPONSOR_SLOT_FILLED');
  if (!verifyEd25519(signatures[1]!, message, input.policy.owner)) fail('GAS_SPONSOR_SOLANA_OWNER_SIGNATURE_INVALID');
  const sponsorSignature = input.signer.sign(message);
  return { transaction: serializeSignedTransaction([sponsorSignature, signatures[1]!], message), signature: base58Encode(sponsorSignature), maxFee };
}
/** The transaction id is its first signature: the sponsor's (base58). */
export const sponsoredTransactionId = (transaction: Uint8Array) => base58Encode(parseTransaction(transaction).signatures[0]!);
export { base58Decode };
