// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: Solana durable nonces — pure System-program instruction encoding, nonce-account decoding and the
 * nonce lifetime of a pre-signed transaction. Nothing here holds a key or sends anything.
 *
 * Why: a Solana transaction signed with a recent blockhash dies after ~150 blocks (about a minute). A step that must wait (the Solana leg
 * after an EVM → Solana bridge delivers) cannot be pre-signed that way. With a durable nonce the transaction's `recent_blockhash` field
 * carries the current value of a nonce account the OWNER controls, and its first instruction is `AdvanceNonceAccount` signed by the owner:
 * the transaction stays valid until that nonce advances — exactly once, when this transaction lands (the advance is part of it), or when
 * the owner advances it themselves (revocation: one cheap self-transaction). The owner is the fee payer, the nonce authority and the only
 * signer; FloFi only holds the owner-signed bytes and broadcasts them when the dependency has settled. One nonce account serves one
 * pre-signed transaction at a time, so a group of N delayed transactions needs N nonce accounts (created once, rent-exempt, refundable).
 *
 * Sources: the installed `@solana-program/system` 0.16.0 generated codecs (`CREATE_ACCOUNT_DISCRIMINATOR` 0, `INITIALIZE_NONCE_ACCOUNT_DISCRIMINATOR`
 * 6, `ADVANCE_NONCE_ACCOUNT_DISCRIMINATOR` 4, `WITHDRAW_NONCE_ACCOUNT_DISCRIMINATOR` 5, the `Nonce` account: version u32, state u32,
 * authority, blockhash, lamportsPerSignature u64 = 80 bytes) and `@solana/transaction-messages` (`setTransactionMessageLifetimeUsingDurableNonce`:
 * the advance instruction MUST be first and the lifetime is the nonce value).
 */
import { base58Encode, compileMessageV0, decompileMessageV0, parseMessageV0, publicKeyBytes, readU64, solanaAddress, u64Bytes, type LookupTables, type MessageV0,
  type SolanaInstruction } from './solana.js';

function fail(code: string): never { throw new Error(code); }
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const RECENT_BLOCKHASHES_SYSVAR = 'SysvarRecentB1ockHashes11111111111111111111';
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
/** The nonce account's data size (`getNonceSize()`): what `createAccount` allocates and the rent-exempt minimum is computed for. */
export const NONCE_ACCOUNT_SIZE = 80;
const u32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const bytesOfKey = (address: string) => Array.from(publicKeyBytes(solanaAddress(address)));
const ix = (programId: string, accounts: SolanaInstruction['accounts'], data: number[]): SolanaInstruction => ({ programId, accounts, data: Uint8Array.from(data) });

/** `SystemProgram.createAccount(payer → newAccount, lamports, NONCE_ACCOUNT_SIZE, owner = System)`: both signers (the new account's key signs once, at creation). */
export function createNonceAccountInstruction(payer: string, nonceAccount: string, lamports: bigint): SolanaInstruction {
  if (typeof lamports !== 'bigint' || lamports <= 0n) fail('SOLANA_NONCE_LAMPORTS_INVALID');
  return ix(SYSTEM_PROGRAM, [{ pubkey: solanaAddress(payer), isSigner: true, isWritable: true }, { pubkey: solanaAddress(nonceAccount), isSigner: true, isWritable: true }],
    [...u32(0), ...u64Bytes(lamports), ...u64Bytes(BigInt(NONCE_ACCOUNT_SIZE)), ...bytesOfKey(SYSTEM_PROGRAM)]);
}
/** `SystemProgram.nonceInitialize(nonceAccount, authority)`: the owner becomes the only key that can advance or withdraw it. */
export function initializeNonceAccountInstruction(nonceAccount: string, authority: string): SolanaInstruction {
  return ix(SYSTEM_PROGRAM, [{ pubkey: solanaAddress(nonceAccount), isSigner: false, isWritable: true }, { pubkey: RECENT_BLOCKHASHES_SYSVAR, isSigner: false, isWritable: false },
    { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false }], [...u32(6), ...bytesOfKey(authority)]);
}
/** `SystemProgram.nonceAdvance(nonceAccount, authority)`: the first instruction of every durable-nonce transaction (and the owner's revocation). */
export function advanceNonceAccountInstruction(nonceAccount: string, authority: string): SolanaInstruction {
  return ix(SYSTEM_PROGRAM, [{ pubkey: solanaAddress(nonceAccount), isSigner: false, isWritable: true }, { pubkey: RECENT_BLOCKHASHES_SYSVAR, isSigner: false, isWritable: false },
    { pubkey: solanaAddress(authority), isSigner: true, isWritable: false }], u32(4));
}
/** `SystemProgram.nonceWithdraw(nonceAccount → to, lamports)` by the authority: the owner takes the rent back when a nonce account is retired. */
export function withdrawNonceAccountInstruction(nonceAccount: string, authority: string, to: string, lamports: bigint): SolanaInstruction {
  if (typeof lamports !== 'bigint' || lamports <= 0n) fail('SOLANA_NONCE_LAMPORTS_INVALID');
  return ix(SYSTEM_PROGRAM, [{ pubkey: solanaAddress(nonceAccount), isSigner: false, isWritable: true }, { pubkey: solanaAddress(to), isSigner: false, isWritable: true },
    { pubkey: RECENT_BLOCKHASHES_SYSVAR, isSigner: false, isWritable: false }, { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    { pubkey: solanaAddress(authority), isSigner: true, isWritable: false }], [...u32(5), ...u64Bytes(lamports)]);
}

export type NonceAccountState = { readonly authority: string; readonly nonce: string; readonly lamportsPerSignature: bigint };
/** The nonce account's current value and authority (`Nonce` v1, state Initialized), or a closed refusal for anything else. */
export function decodeNonceAccount(data: Uint8Array, owner: string = SYSTEM_PROGRAM): NonceAccountState {
  if (!(data instanceof Uint8Array) || data.length !== NONCE_ACCOUNT_SIZE || owner !== SYSTEM_PROGRAM) fail('SOLANA_NONCE_ACCOUNT_INVALID');
  const version = data[0]! | data[1]! << 8 | data[2]! << 16 | data[3]! << 24, state = data[4]! | data[5]! << 8 | data[6]! << 16 | data[7]! << 24;
  if (version !== 1 || state !== 1) fail('SOLANA_NONCE_ACCOUNT_UNINITIALIZED');
  return { authority: base58Encode(data.subarray(8, 40)), nonce: base58Encode(data.subarray(40, 72)), lamportsPerSignature: readU64(data, 72) };
}

/**
 * A v0 message whose lifetime is a durable nonce: `AdvanceNonceAccount(nonceAccount, owner)` first, the step's instructions after it, and the
 * nonce value in the `recent_blockhash` field. The owner is the fee payer and the nonce authority.
 */
export function compileDurableNonceMessageV0(owner: string, nonce: NonceAccountState & { readonly account: string }, instructions: readonly SolanaInstruction[],
  tables: LookupTables): MessageV0 {
  if (solanaAddress(nonce.authority) !== solanaAddress(owner)) fail('SOLANA_NONCE_AUTHORITY_MISMATCH');
  if (!instructions.length) fail('SOLANA_NONCE_INSTRUCTIONS_EMPTY');
  return compileMessageV0(owner, [advanceNonceAccountInstruction(nonce.account, owner), ...instructions], nonce.nonce, tables);
}
export type DurableNonceLifetime = { readonly nonceAccount: string; readonly authority: string; readonly nonce: string };
/**
 * What a message's lifetime is: the durable nonce it advances (first instruction `AdvanceNonceAccount` by the fee payer, `recent_blockhash` =
 * the nonce value), or null for an ordinary recent-blockhash message. Anything that only looks like a nonce transaction is refused.
 */
export function durableNonceLifetime(message: MessageV0, tables: LookupTables): DurableNonceLifetime | null {
  const [first] = decompileMessageV0(message, tables);
  if (!first || first.programId !== SYSTEM_PROGRAM || first.data.length !== 4 || (first.data[0]! | first.data[1]! << 8 | first.data[2]! << 16 | first.data[3]! << 24) !== 4) return null;
  const [nonceAccount, sysvar, authority] = first.accounts;
  if (!nonceAccount?.isWritable || sysvar?.pubkey !== RECENT_BLOCKHASHES_SYSVAR || !authority?.isSigner) fail('SOLANA_NONCE_ADVANCE_INVALID');
  if (authority.pubkey !== message.staticKeys[0]) fail('SOLANA_NONCE_AUTHORITY_MISMATCH');
  return { nonceAccount: nonceAccount.pubkey, authority: authority.pubkey, nonce: message.blockhash };
}
/** The lifetime of serialized message bytes (see `durableNonceLifetime`). */
export function durableNonceLifetimeOf(messageBytes: Uint8Array, tables: LookupTables): DurableNonceLifetime | null {
  return durableNonceLifetime(parseMessageV0(messageBytes), tables);
}
/** Whether a pre-signed nonce transaction can still land: its nonce account still holds exactly the value it was signed with, under the same authority. */
export function nonceStillValid(lifetime: DurableNonceLifetime, current: NonceAccountState): boolean {
  return current.nonce === lifetime.nonce && current.authority === lifetime.authority;
}
