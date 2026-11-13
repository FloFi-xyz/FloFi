// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): Solana transactions whose network fee Pimlico's hosted Kora fee payer fronts and the
 * OWNER repays in USDC/USDT inside the same transaction. Pure message policy and verification; nothing here holds a key, signs or sends.
 *
 *   static key 0     the pinned Kora signer: the fee payer, its signature slot left empty for Kora; it may appear in no instruction except as
 *                    `payer` (account 0) of an Associated Token Account Create/CreateIdempotent (Kora charges that rent in the token fee)
 *   static key 1     the owner, the only other signer
 *   last instruction exactly one SPL Token `TransferChecked` (classic Token program, opcode 12) of the reviewed fee amount from the owner's
 *                    fee-token account to the pinned payment address's associated token account, signed by the owner
 *
 * K1 (FloFi never lets a transaction reach Kora without the verified payment): `assertKoraMessage` is checked when the message is built, again on
 * the exact owner-signed bytes (`verifyKoraOwnerSigned`), and the service re-checks it right before every Kora call. Kora's answer must carry the
 * same message, the owner's signature unchanged and a valid signature by the pinned signer in slot 0 (`verifyKoraAnswer`).
 */
import { associatedTokenAddress, base58Encode, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, readU64, serializeSignedTransaction, toBase64,
  u64Bytes, verifyEd25519, type LookupTables, type MessageV0, type SolanaInstruction } from './solana.js';
import { LIGHTHOUSE_PROGRAM } from './solana-wallet-change.js';
import { verifySolanaWalletGuard, type SolanaWalletGuard } from './solana-wallet-guard.js';

export const KORA_MECHANISM = 'PIMLICO_KORA_SPL_FEE' as const;
/** Pimlico's documented ceiling on what its fee payer spends per transaction (fee, priority fee and rent): 0.1 SOL. */
export const KORA_MAX_FEE_LAMPORTS = 100_000_000n;
/**
 * The compute-unit price FloFi sets at most in Kora mode (micro-lamports per unit). A transaction that passed simulation and then fails on chain
 * costs its SOL fee to the operator's Pimlico balance (the owner's token payment reverts with it): this bounds that exposure.
 */
export const KORA_MAX_COMPUTE_UNIT_PRICE = 1_000_000n;
/** Two signatures (Kora, owner): the base fee of a Kora transaction. */
export const KORA_SIGNATURES = 2;
export const KORA_BASE_FEE_LAMPORTS = '10000';
/** Jupiter `/build` account budget in Kora mode, so two signatures, the fee payer and the payment fit Solana's 1,232-byte limit. */
export const KORA_JUPITER_MAX_ACCOUNTS = '40';
/** Classic SPL Token, Associated Token Account and System programs (the fee tokens USDC/USDT are classic SPL Token mints). */
export const KORA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const KORA_ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export type KoraFeeToken = { readonly symbol: string; readonly mint: string; readonly decimals: number };
/** Kora's `estimateTransactionFee` answer, already parsed strictly by the caller's client (decimal strings). */
export type KoraQuote = { readonly feeInLamports: string; readonly feeInToken: string; readonly signerPubkey: string; readonly paymentAddress: string };
/**
 * What a builder needs from the deployment: the pinned signer and payment address, the fee tokens both FloFi and Kora accept, and the quote.
 * `tokens()` verifies the provider's own answer against the pins first (a different signer or payment address is refused, never trusted).
 */
export type KoraPort = { readonly feePayer: string; readonly paymentAddress: string;
  tokens(): Promise<readonly KoraFeeToken[]>;
  estimate(unsignedTransactionBase64: string, feeMint: string): Promise<KoraQuote> };
/**
 * The token-paid fee the owner reviews and signs (bound into the Review commitment): who fronts the SOL fee, what the owner pays back, from which
 * account, to whom. `amount` is the exact token amount of the payment instruction; `quotedFeeLamports` is Kora's quote of its own SOL outflow.
 */
export type KoraGasTerms = { readonly mechanism: typeof KORA_MECHANISM; readonly feePayer: string; readonly paymentAddress: string; readonly paymentAccount: string;
  readonly feeAccount: string; readonly token: KoraFeeToken; readonly amount: string; readonly quotedFeeLamports: string; readonly quotedAt: string;
  /** The worst-case native cost the owner's SOL did not cover at Review: once the owner holds it, the policy picks native again (a new Review). */
  readonly nativeWorstCaseLamports: string };

/**
 * `groupShortfall`: the native shortfall was proven for the whole execution group (the owner's SOL cannot pay every transaction of a sign-all
 * group, ADR-0010 §2: the mechanism is chosen per execution group), so this member is built with Kora even if its own native cost alone fits; the
 * caller proves the group shortfall with the members' `nativeWorstCaseLamports`.
 */
export type KoraBuildOptions = { readonly groupShortfall?: boolean };
const fail = (code: string): never => { throw new Error(code); };
export const koraAta = (wallet: string, mint: string) => associatedTokenAddress(wallet, mint, KORA_TOKEN_PROGRAM, KORA_ASSOCIATED_TOKEN_PROGRAM);

/** The owner's repayment: SPL Token `TransferChecked` (opcode 12) of `amount` from the owner's fee-token account to the payment account. */
export function koraPaymentInstruction(owner: string, terms: Pick<KoraGasTerms, 'feeAccount' | 'paymentAccount' | 'token'>, amount: bigint): SolanaInstruction {
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) fail('KORA_FEE_QUOTE_INVALID');
  return { programId: KORA_TOKEN_PROGRAM, data: Uint8Array.from([12, ...u64Bytes(amount), terms.token.decimals]), accounts: [
    { pubkey: terms.feeAccount, isSigner: false, isWritable: true }, { pubkey: terms.token.mint, isSigner: false, isWritable: false },
    { pubkey: terms.paymentAccount, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }] };
}
/** An ATA creation (Create or CreateIdempotent) whose rent payer FloFi hands to the Kora signer; any other instruction is returned unchanged. */
export function koraPaidAccountCreation(ix: SolanaInstruction, owner: string, feePayer: string): SolanaInstruction {
  const create = ix.programId === KORA_ASSOCIATED_TOKEN_PROGRAM && (ix.data.length === 0 || ix.data.length === 1 && ix.data[0]! <= 1);
  if (!create || ix.accounts[0]?.pubkey !== owner) return ix;
  return { ...ix, accounts: [{ pubkey: feePayer, isSigner: true, isWritable: true }, ...ix.accounts.slice(1)] };
}
/** The ATA accounts a Kora transaction creates with Kora as rent payer (their rent is part of Kora's quote and is never the owner's SOL). */
export function koraCreatedAccounts(instructions: readonly SolanaInstruction[], feePayer: string): string[] {
  return instructions.filter(ix => ix.programId === KORA_ASSOCIATED_TOKEN_PROGRAM && ix.accounts[0]?.pubkey === feePayer).map(ix => ix.accounts[1]?.pubkey ?? fail('KORA_MESSAGE_INVALID'));
}
const isPayment = (ix: SolanaInstruction, terms: KoraGasTerms) => ix.accounts.some(a => a.pubkey === terms.paymentAccount || a.pubkey === terms.paymentAddress);

/**
 * K1 on a compiled message (the reviewed one, or what the owner signed): the pinned fee payer at static key 0 with exactly one other signer, the
 * owner at key 1; the fee payer in no instruction except as ATA rent payer; exactly one payment, byte for byte the reviewed TransferChecked, as
 * the last instruction (only verified wallet-guard assertions may follow it); no other instruction touching the payment account or address.
 */
export function assertKoraMessage(message: MessageV0, tables: LookupTables, owner: string, terms: KoraGasTerms): void {
  if (terms.mechanism !== KORA_MECHANISM || BigInt(terms.amount) <= 0n) fail('KORA_FEE_QUOTE_INVALID');
  if (message.staticKeys[0] !== terms.feePayer) fail('KORA_FEE_PAYER_MISMATCH');
  if (message.header[0] !== KORA_SIGNATURES || message.staticKeys[1] !== owner || owner === terms.feePayer) fail('KORA_SIGNERS_INVALID');
  if (terms.paymentAccount !== koraAta(terms.paymentAddress, terms.token.mint) || terms.feeAccount !== koraAta(owner, terms.token.mint)) fail('KORA_PAYMENT_ACCOUNT_MISMATCH');
  let instructions: SolanaInstruction[];
  try { instructions = decompileMessageV0(message, tables); } catch { return fail('KORA_MESSAGE_INVALID'); }
  // Static key 0 is a signer, so it can never come from a lookup table: index 0 is the only way an instruction names it.
  message.instructions.forEach((ix, i) => {
    if (ix.programIdIndex === 0) fail('KORA_FEE_PAYER_REFERENCED');
    ix.accounts.forEach((account, position) => {
      if (account !== 0) return;
      const decoded = instructions[i]!;
      const create = decoded.programId === KORA_ASSOCIATED_TOKEN_PROGRAM && (decoded.data.length === 0 || decoded.data.length === 1 && decoded.data[0]! <= 1) &&
        position === 0 && decoded.accounts.length === 6 && decoded.accounts[4]?.pubkey === SYSTEM_PROGRAM && decoded.accounts[2]?.pubkey !== terms.feePayer;
      if (!create) fail('KORA_FEE_PAYER_REFERENCED');
    });
  });
  const payments = instructions.map((ix, i) => ({ ix, i })).filter(({ ix }) => isPayment(ix, terms));
  if (payments.length !== 1) fail('KORA_PAYMENT_MISSING');
  const { ix, i } = payments[0]!;
  const expected = koraPaymentInstruction(owner, terms, BigInt(terms.amount));
  // Writability is message-wide after compilation (the owner may be writable for another instruction); the token accounts must be writable.
  const same = ix.programId === expected.programId && ix.data.length === expected.data.length && ix.data.every((b, k) => b === expected.data[k]) &&
    ix.accounts.length === 4 && ix.accounts.every((a, k) => a.pubkey === expected.accounts[k]!.pubkey && a.isSigner === expected.accounts[k]!.isSigner &&
      (k === 1 || k === 3 || a.isWritable));
  if (!same) fail('KORA_PAYMENT_CHANGED');
  if (instructions.slice(i + 1).some(after => after.programId !== LIGHTHOUSE_PROGRAM)) fail('KORA_PAYMENT_NOT_LAST');
  // Defence in depth: the runtime refuses a key loaded twice, but no resolved account may name the fee payer except through index 0 above.
  if (instructions.some((decoded, n) => decoded.accounts.some((a, p) => a.pubkey === terms.feePayer && message.instructions[n]!.accounts[p] !== 0)))
    fail('KORA_FEE_PAYER_REFERENCED');
}

/** Unsigned wire form with one empty slot per required signer (one slot: the original single-signer form, byte for byte). */
export function unsignedTransactionBytes(message: Uint8Array): Uint8Array {
  const signers = parseMessageV0(message).header[0];
  return serializeSignedTransaction(Array.from({ length: signers }, () => null), message);
}

/** What the owner returned for a Kora transaction: the owner's signature (the claim identity) and the exact owner-signed bytes, slot 0 empty. */
export type KoraOwnerSigned = { signature: string; transaction: string; walletGuard?: SolanaWalletGuard };
/**
 * The owner signed the reviewed Kora message (or it plus verified Lighthouse assertions): two signature slots, Kora's slot 0 still empty, a valid
 * owner signature in slot 1, and K1 on the exact signed message. Anything else fails closed and nothing reaches Kora.
 */
export function verifyKoraOwnerSigned(review: { message: string; owner: string; gas: KoraGasTerms; lookupTables?: LookupTables }, signedBase64: unknown, prefix: string): KoraOwnerSigned {
  const bytes = fromBase64(signedBase64, 2048);
  const { signatures, message } = parseTransaction(bytes);
  if (signatures.length !== KORA_SIGNATURES) fail(`${prefix}_TRANSACTION_CHANGED`);
  let walletGuard: SolanaWalletGuard | null;
  try { walletGuard = verifySolanaWalletGuard(fromBase64(review.message), message, review.lookupTables ?? {}); } catch { return fail(`${prefix}_TRANSACTION_CHANGED`); }
  if (signatures[0]!.some(byte => byte !== 0)) fail('KORA_FEE_PAYER_SLOT_FILLED');
  if (!verifyEd25519(signatures[1]!, message, review.owner)) fail(`${prefix}_SIGNATURE_INVALID`);
  assertKoraMessage(parseMessageV0(message), review.lookupTables ?? {}, review.owner, review.gas);
  return { signature: base58Encode(signatures[1]!), transaction: toBase64(bytes), ...walletGuard ? { walletGuard } : {} };
}
/** Kora's `signAndSendTransaction` answer, parsed by the client. */
export type KoraSignedAnswer = { readonly signature: string; readonly signedTransaction: string; readonly signerPubkey: string };
/**
 * Kora's answer must be the transaction the owner signed, completed: the same message, the owner's slot unchanged and slot 0 a valid signature
 * by the pinned signer, whose base58 is the transaction id Kora names. Returns the transaction id and the fully signed bytes.
 */
export function verifyKoraAnswer(ownerSignedBase64: string, answer: KoraSignedAnswer, feePayer: string): { signature: string; transaction: string } {
  if (answer.signerPubkey !== feePayer) fail('KORA_SIGNER_MISMATCH');
  const owner = parseTransaction(fromBase64(ownerSignedBase64, 2048));
  let relayed: ReturnType<typeof parseTransaction>;
  try { relayed = parseTransaction(fromBase64(answer.signedTransaction, 2048)); } catch { return fail('KORA_ANSWER_INVALID'); }
  const sameMessage = relayed.message.length === owner.message.length && relayed.message.every((b, i) => b === owner.message[i]);
  if (!sameMessage || relayed.signatures.length !== KORA_SIGNATURES || !relayed.signatures[1]!.every((b, i) => b === owner.signatures[1]![i])) fail('KORA_ANSWER_INVALID');
  if (parseMessageV0(relayed.message).staticKeys[0] !== feePayer || !verifyEd25519(relayed.signatures[0]!, relayed.message, feePayer)) fail('KORA_SIGNER_MISMATCH');
  const signature = base58Encode(relayed.signatures[0]!);
  if (signature !== answer.signature) fail('KORA_ANSWER_INVALID');
  return { signature, transaction: toBase64(serializeSignedTransaction(relayed.signatures, relayed.message)) };
}
/**
 * Recorded attempt bytes stay consistent: the relayed transaction is the owner-signed one plus the pinned signer's slot-0 signature, and its id is
 * that signature. Shared by the executors' validators and the reconcilers.
 */
export function assertKoraRelayedAttempt(ownerSignedBase64: string, ownerSignature: string, relayedBase64: string, signature: string, feePayer: string): void {
  const owner = parseTransaction(fromBase64(ownerSignedBase64, 2048));
  if (owner.signatures.length !== KORA_SIGNATURES || base58Encode(owner.signatures[1]!) !== ownerSignature || owner.signatures[0]!.some(b => b !== 0)) fail('KORA_ATTEMPT_INVALID');
  const relayed = verifyKoraAnswer(ownerSignedBase64, { signature, signedTransaction: relayedBase64, signerPubkey: feePayer }, feePayer);
  if (relayed.transaction !== relayedBase64) fail('KORA_ATTEMPT_INVALID');
}

/** A Kora quote is usable only for the pinned signer and payment address, a positive token amount (zero would be a sponsorship) and ≤ 0.1 SOL. */
export function assertKoraQuote(quote: KoraQuote, port: Pick<KoraPort, 'feePayer' | 'paymentAddress'>): { feeInLamports: bigint; feeInToken: bigint } {
  if (quote.signerPubkey !== port.feePayer || quote.paymentAddress !== port.paymentAddress) fail('KORA_SIGNER_MISMATCH');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(quote.feeInLamports) || !/^(0|[1-9][0-9]{0,19})$/.test(quote.feeInToken)) fail('KORA_FEE_QUOTE_INVALID');
  const feeInLamports = BigInt(quote.feeInLamports), feeInToken = BigInt(quote.feeInToken);
  if (feeInToken <= 0n || feeInToken > 0xffff_ffff_ffff_ffffn) fail('KORA_FEE_QUOTE_INVALID');
  if (feeInLamports > KORA_MAX_FEE_LAMPORTS) fail('KORA_FEE_ABOVE_CAP');
  return { feeInLamports, feeInToken };
}
/** The codes a native Solana build fails with when the owner's SOL cannot pay the network fee (or a new account's rent). */
export function isSolanaNativeFeeShortfall(cause: unknown): boolean {
  const code = cause instanceof Error ? cause.message : '';
  return /^(JUPITER|SOLANA_TRANSFER)_(INSUFFICIENT_SOL|SIMULATION_FAILED|OWNER_NOT_WALLET)$/.test(code);
}
/** Read the payment amount of a decoded payment instruction (for display and reconciliation; the policy above already proved its shape). */
export const koraPaymentAmount = (ix: SolanaInstruction): bigint => readU64(ix.data, 1);
