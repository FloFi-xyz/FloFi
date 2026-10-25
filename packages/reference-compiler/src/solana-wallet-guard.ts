// SPDX-License-Identifier: AGPL-3.0-only
import { sha256 } from '@noble/hashes/sha2.js';
import { decompileMessageV0, parseMessageV0, type LookupTables, type MessageV0, type SolanaInstruction } from './solana.js';
import { LIGHTHOUSE_PROGRAM } from './solana-wallet-change.js';

/**
 * HOTFIX-PHANTOM-LIGHTHOUSE-001: the one wallet modification FloFi accepts after Review.
 *
 * Phantom protects its users by appending Lighthouse assertion instructions to a transaction before signing it: post-state
 * checks such as "the owner keeps at least N lamports" or "this token account holds at least the minimum output and has no
 * delegate". They read accounts and compare; if the outcome is worse than the wallet's own simulation, the whole transaction
 * fails atomically. They cannot move, approve or create anything.
 *
 * The Lighthouse program (L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95) is immutable on mainnet-beta (ProgramData
 * CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c, upgrade authority None since slot 294,179,293) and its binary has a verified
 * build of github.com/jac0xb/lighthouse (OtterSec, executable hash b70084e0…529a). The assertion instructions accepted here
 * only read their single target account and compare (processor/assert_target_account.rs, assert_token_account.rs).
 *
 * Accepted only when ALL of these hold; anything else is refused (the exact-byte rule still decides every other change):
 *  - same v0 message version, fee payer, signers (same keys, same order, same read-only signer count) and recent blockhash,
 *    so the reviewed validity window and every signature slot are unchanged;
 *  - every reviewed instruction is present, byte for byte with identical account flags, in order, as an exact prefix;
 *  - every added instruction is a Lighthouse assertion of an allowlisted kind whose data decodes completely (no trailing
 *    bytes), with exactly one target that is already an account of the reviewed transaction, with unchanged flags;
 *  - the resolved account set is the reviewed set plus only the Lighthouse program (read-only, unsigned), with every reviewed
 *    account's signer and writable flags unchanged, and lookups only through the reviewed lookup tables.
 * Nothing else may be added: no compute-budget change (the fee stays the reviewed fee), no memory writes, no new account.
 */
const MAX_ADDED = 8, MAX_ASSERTIONS = 16;
const KINDS = { 5: 'AssertAccountInfo', 6: 'AssertAccountInfoMulti', 9: 'AssertTokenAccount', 10: 'AssertTokenAccountMulti' } as const;
export type LighthouseAssertionKind = typeof KINDS[keyof typeof KINDS];
export type SolanaWalletGuardInstruction = { index: number; kind: LighthouseAssertionKind; target: string; assertions: string[]; data: string };
export type SolanaWalletGuard = { format: 'flofi.solana-wallet-guard.v1'; program: typeof LIGHTHOUSE_PROGRAM; reviewedMessageHash: string; signedMessageHash: string;
  instructions: SolanaWalletGuardInstruction[] };

// Runs in the browser (the liquidity step checks the wallet's bytes there) and on the server: no Node Buffer.
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const solanaMessageHash = (bytes: Uint8Array): string => '0x' + hex(sha256(bytes));
const fail = (reason: string): never => { throw new Error(`SOLANA_WALLET_GUARD_${reason}`); };
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const INTEGER = ['==', '!=', '>', '<', '>=', '<=', 'contains', 'does-not-contain'], EQUATABLE = ['==', '!='];
const KNOWN_PROGRAMS = ['System', 'Token', 'Token2022', 'Rent', 'Stake', 'Vote', 'BpfLoader', 'UpgradeableLoader', 'SysvarConfig'];
/** Borsh as Lighthouse encodes it (lighthouse-common: LEB128 vector lengths and CompactU64), read strictly. */
class Reader {
  offset = 0;
  constructor(private readonly data: Uint8Array) {}
  take(n: number) { if (this.offset + n > this.data.length) fail('DATA_INVALID'); const v = this.data.slice(this.offset, this.offset + n); this.offset += n; return v; }
  u8() { return this.take(1)[0]!; }
  u64() { const b = this.take(8); let v = 0n; for (let i = 7; i >= 0; i--) v = v * 256n + BigInt(b[i]!); return v.toString(); }
  leb() { let v = 0n, shift = 0n; for (let i = 0; i < 10; i++) { const b = this.u8(); v |= BigInt(b & 0x7f) << shift; if (!(b & 0x80)) return v; shift += 7n; } return fail('DATA_INVALID'); }
  pick(table: readonly string[]) { return table[this.u8()] ?? fail('DATA_INVALID'); }
  bool() { const v = this.u8(); return v === 0 ? 'false' : v === 1 ? 'true' : fail('DATA_INVALID'); }
  option(n: number) { const tag = this.u8(); return tag === 0 ? 'none' : tag === 1 ? '0x' + hex(this.take(n)) : fail('DATA_INVALID'); }
  done() { if (this.offset !== this.data.length) fail('DATA_INVALID'); }
}
// AccountInfoAssertion and TokenAccountAssertion variants (types/assert/account_info.rs, token_account.rs), in declaration order.
function accountInfoAssertion(r: Reader): string {
  switch (r.u8()) {
    case 0: { const value = r.u64(); return `lamports ${r.pick(INTEGER)} ${value}`; }
    case 1: { const value = r.u64(); return `dataLength ${r.pick(INTEGER)} ${value}`; }
    case 2: { const value = hex(r.take(32)); return `owner ${r.pick(EQUATABLE)} 0x${value}`; }
    case 3: { const value = r.pick(KNOWN_PROGRAMS); return `owner ${r.pick(EQUATABLE)} ${value}`; }
    case 4: { const value = r.u64(); return `rentEpoch ${r.pick(INTEGER)} ${value}`; }
    case 5: { const value = r.bool(); return `isSigner ${r.pick(EQUATABLE)} ${value}`; }
    case 6: { const value = r.bool(); return `isWritable ${r.pick(EQUATABLE)} ${value}`; }
    case 7: { const value = r.bool(); return `executable ${r.pick(EQUATABLE)} ${value}`; }
    case 8: { const value = hex(r.take(32)), start = r.leb(), length = r.leb(); return `dataHash(${start},${length}) == 0x${value}`; }
    default: return fail('ASSERTION_UNRECOGNIZED');
  }
}
function tokenAccountAssertion(r: Reader): string {
  switch (r.u8()) {
    case 0: { const value = hex(r.take(32)); return `mint ${r.pick(EQUATABLE)} 0x${value}`; }
    case 1: { const value = hex(r.take(32)); return `owner ${r.pick(EQUATABLE)} 0x${value}`; }
    case 2: { const value = r.u64(); return `amount ${r.pick(INTEGER)} ${value}`; }
    case 3: { const value = r.option(32); return `delegate ${r.pick(EQUATABLE)} ${value}`; }
    case 4: { const value = r.u8(); return `state ${r.pick(INTEGER)} ${value}`; }
    case 5: { const tag = r.u8(), value = tag === 0 ? 'none' : tag === 1 ? r.u64() : fail('DATA_INVALID'); return `isNative ${r.pick(EQUATABLE)} ${value}`; }
    case 6: { const value = r.u64(); return `delegatedAmount ${r.pick(INTEGER)} ${value}`; }
    case 7: { const value = r.option(32); return `closeAuthority ${r.pick(EQUATABLE)} ${value}`; }
    case 8: return 'ownerIsDerivedAssociatedTokenAccount';
    default: return fail('ASSERTION_UNRECOGNIZED');
  }
}
/**
 * One Lighthouse instruction's data, decoded completely: an allowlisted read-only assertion kind, a valid log level, every
 * assertion field and nothing trailing (the program itself would ignore trailing bytes; FloFi refuses what it cannot read).
 */
export function decodeLighthouseAssertion(data: Uint8Array): { kind: LighthouseAssertionKind; assertions: string[] } {
  const r = new Reader(data), kind = KINDS[r.u8() as keyof typeof KINDS] ?? fail('INSTRUCTION_UNRECOGNIZED');
  if (r.u8() > 6) fail('DATA_INVALID'); // LogLevel: Silent … FailedEncodedNoop (Borsh variant index)
  const read = kind.startsWith('AssertAccountInfo') ? accountInfoAssertion : tokenAccountAssertion;
  let assertions: string[];
  if (kind.endsWith('Multi')) {
    const count = r.leb();
    if (count < 1n || count > BigInt(MAX_ASSERTIONS)) fail('DATA_INVALID');
    assertions = Array.from({ length: Number(count) }, () => read(r));
  } else assertions = [read(r)];
  r.done();
  return { kind, assertions };
}
type Resolved = Map<string, { signer: boolean; writable: boolean }>;
/** Every account the message loads, with the runtime's message-level flags. */
function resolvedAccounts(message: MessageV0, tables: LookupTables): Resolved {
  const [signers, readonlySigned, readonlyUnsigned] = message.header, n = message.staticKeys.length, out: Resolved = new Map();
  const add = (key: string, signer: boolean, writable: boolean) => { if (out.has(key)) fail('ACCOUNT_DUPLICATED'); out.set(key, { signer, writable }); };
  message.staticKeys.forEach((key, i) => add(key, i < signers, i < signers ? i < signers - readonlySigned : i < n - readonlyUnsigned));
  for (const pick of ['writable', 'readonly'] as const) for (const lookup of message.lookups) for (const index of lookup[pick]) {
    const key = tables[lookup.table]?.[index] ?? fail('LOOKUP_UNKNOWN');
    add(key, false, pick === 'writable');
  }
  return out;
}
const instructionKey = (ix: SolanaInstruction) => `${ix.programId}|${ix.accounts.map(a => `${a.pubkey}:${+a.isSigner}${+a.isWritable}`).join(',')}|${hex(ix.data)}`;

/**
 * Verifies the message a wallet returned against the reviewed one. Returns null for the byte-identical reviewed message, the
 * guard's description when it is the reviewed transaction plus only verified Lighthouse assertions, and throws
 * SOLANA_WALLET_GUARD_* for anything else. It never repairs or rebuilds a transaction; signatures are checked by the caller
 * over the returned message, which is exactly what would be broadcast.
 */
export function verifySolanaWalletGuard(reviewedMessage: Uint8Array, returnedMessage: Uint8Array, tables: LookupTables): SolanaWalletGuard | null {
  if (sameBytes(reviewedMessage, returnedMessage)) return null;
  let reviewed: MessageV0, returned: MessageV0;
  try { reviewed = parseMessageV0(reviewedMessage); returned = parseMessageV0(returnedMessage); } catch { return fail('MESSAGE_INVALID'); }
  if (returned.blockhash !== reviewed.blockhash) fail('BLOCKHASH_CHANGED');
  if (returned.header[0] !== reviewed.header[0] || returned.header[1] !== reviewed.header[1] ||
      returned.staticKeys.slice(0, returned.header[0]).join(',') !== reviewed.staticKeys.slice(0, reviewed.header[0]).join(',')) fail('SIGNERS_CHANGED');
  if (returned.lookups.some(l => !tables[l.table])) fail('LOOKUP_UNKNOWN');
  let reviewedIxs: SolanaInstruction[], returnedIxs: SolanaInstruction[];
  try { reviewedIxs = decompileMessageV0(reviewed, tables); returnedIxs = decompileMessageV0(returned, tables); } catch { return fail('LOOKUP_UNKNOWN'); }
  const added = returnedIxs.length - reviewedIxs.length;
  if (added < 1 || added > MAX_ADDED) fail('INSTRUCTIONS_CHANGED');
  reviewedIxs.forEach((ix, i) => { if (instructionKey(ix) !== instructionKey(returnedIxs[i]!)) fail('INSTRUCTIONS_CHANGED'); });
  const before = resolvedAccounts(reviewed, tables), after = resolvedAccounts(returned, tables);
  if (before.has(LIGHTHOUSE_PROGRAM)) fail('ACCOUNTS_CHANGED');
  for (const [key, flags] of before) { const now = after.get(key); if (!now || now.signer !== flags.signer || now.writable !== flags.writable) fail('ACCOUNTS_CHANGED'); }
  for (const [key, flags] of after) if (!before.has(key) && (key !== LIGHTHOUSE_PROGRAM || flags.signer || flags.writable)) fail('ACCOUNTS_CHANGED');
  const instructions = returnedIxs.slice(reviewedIxs.length).map((ix, i): SolanaWalletGuardInstruction => {
    if (ix.programId !== LIGHTHOUSE_PROGRAM) fail('INSTRUCTION_UNRECOGNIZED');
    if (ix.accounts.length !== 1) fail('ACCOUNTS_CHANGED');
    const target = ix.accounts[0]!.pubkey;
    if (!before.has(target)) fail('TARGET_NOT_REVIEWED');
    return { index: reviewedIxs.length + i, ...decodeLighthouseAssertion(ix.data), target, data: hex(ix.data) };
  });
  return { format: 'flofi.solana-wallet-guard.v1', program: LIGHTHOUSE_PROGRAM, reviewedMessageHash: solanaMessageHash(reviewedMessage),
    signedMessageHash: solanaMessageHash(returnedMessage), instructions };
}
/**
 * Store validation: a journaled signed message is either the reviewed message (no guard recorded) or a guard that still
 * verifies and is exactly the recorded one. A tampered journal can never turn into broadcastable, unverified bytes.
 */
export function assertRecordedSolanaWalletGuard(reviewedMessage: Uint8Array, signedMessage: Uint8Array, recorded: SolanaWalletGuard | undefined, tables: LookupTables): void {
  let verified: SolanaWalletGuard | null;
  try { verified = verifySolanaWalletGuard(reviewedMessage, signedMessage, tables); } catch { return fail('RECORD_INVALID'); }
  if (JSON.stringify(verified ?? undefined) !== JSON.stringify(recorded)) fail('RECORD_INVALID');
}
