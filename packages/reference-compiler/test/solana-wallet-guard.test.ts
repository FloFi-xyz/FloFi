// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { base58Encode, compileMessageV0, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, serializeMessageV0, serializeTransaction, toBase64,
  u64Bytes, type LookupTables, type SolanaInstruction } from '../src/solana.js';
import { LIGHTHOUSE_PROGRAM } from '../src/solana-wallet-change.js';
import { assertRecordedSolanaWalletGuard, decodeLighthouseAssertion, verifySolanaWalletGuard } from '../src/solana-wallet-guard.js';
import { mockedPhantomGuardInstructions } from '../src/lighthouse-mock.js';
import { verifySignedSolanaSwap } from '../src/solana-swap.js';
import { createMockedSolanaWallet } from '../src/jupiter-mock.js';

/**
 * HOTFIX-PHANTOM-LIGHTHOUSE-001. The fixture holds REAL Phantom-signed mainnet-beta transactions (finalized, public RPC): the dApp's
 * instructions followed by the Lighthouse assertions Phantom appended before signing. For each one the "reviewed" message is rebuilt
 * from the dApp instructions alone; the real wallet-returned transaction, with Phantom's real Ed25519 signature, must be accepted.
 */
type Fixture = { signature: string; slot: number; err: unknown; transaction: string; lookupTables: Record<string, Record<string, string>> };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/phantom-lighthouse-mainnet.json', import.meta.url), 'utf8')) as { transactions: Fixture[] };
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
// Only the entries each transaction loaded are known; every other index stays a hole, so nothing can resolve through an invented entry.
const tablesOf = (f: Fixture): LookupTables => Object.fromEntries(Object.entries(f.lookupTables).map(([table, entries]) =>
  [table, Array.from({ length: Math.max(...Object.keys(entries).map(Number)) + 1 }, (_, i) => entries[i]!)]));
function real(f: Fixture) {
  const bytes = fromBase64(f.transaction, 2048), { message } = parseTransaction(bytes), parsed = parseMessageV0(message), tables = tablesOf(f);
  const all = decompileMessageV0(parsed, tables);
  let k = all.length; while (k > 0 && all[k - 1]!.programId === LIGHTHOUSE_PROGRAM) k--;
  const dapp = all.slice(0, k), owner = parsed.staticKeys[0]!;
  const rebuild = (instructions: readonly SolanaInstruction[], extra: LookupTables = {}, blockhash = parsed.blockhash) =>
    serializeMessageV0(compileMessageV0(owner, instructions, blockhash, { ...extra, ...tables }));
  return { bytes, message, parsed, tables, all, dapp, owner, reviewed: rebuild(dapp), rebuild };
}
const jupiter = fixture.transactions.find(f => f.signature.startsWith('5DSfVKL9'))!;

describe('Phantom Lighthouse guard: real mainnet-beta Phantom transactions', () => {
  it.each(fixture.transactions.map(f => [f.signature.slice(0, 12), f] as const))('accepts %s: reviewed instructions plus verified assertions, real owner signature', (_, f) => {
    const r = real(f);
    expect(f.err).toBeNull();
    const guard = verifySolanaWalletGuard(r.reviewed, r.message, r.tables)!;
    expect(guard).toMatchObject({ format: 'flofi.solana-wallet-guard.v1', program: LIGHTHOUSE_PROGRAM, signedMessageHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(guard.instructions.map(i => i.kind)).toEqual(r.all.length - r.dapp.length === 2 ? ['AssertAccountInfoMulti', 'AssertTokenAccountMulti'] : ['AssertAccountInfoMulti']);
    expect(guard.instructions[0]).toMatchObject({ target: r.owner, assertions: expect.arrayContaining(['owner == System', 'dataLength == 0']) });
    // The signature Phantom produced verifies over exactly the bytes that were broadcast; the signature is the on-chain identity.
    const signed = verifySignedSolanaSwap({ message: toBase64(r.reviewed), owner: r.owner, lookupTables: r.tables }, f.transaction, 'JUPITER');
    expect(signed).toEqual({ signature: f.signature, transaction: f.transaction, walletGuard: guard });
  });
  it('captures the Phantom Jupiter swap exactly: SOL-balance and output-token-account assertions, after every Jupiter instruction', () => {
    const r = real(jupiter), guard = verifySolanaWalletGuard(r.reviewed, r.message, r.tables)!;
    expect(r.dapp.map(i => i.programId)).toContain(JUPITER);
    expect(guard.instructions).toEqual([
      { index: r.dapp.length, kind: 'AssertAccountInfoMulti', target: r.owner, assertions: ['lamports >= 66497618', 'owner == System', 'dataLength == 0'],
        data: '0604030052acf603000000000403000001000000000000000000' },
      { index: r.dapp.length + 1, kind: 'AssertTokenAccountMulti', target: guard.instructions[1]!.target,
        assertions: ['amount >= 74867290', 'delegate == none', 'delegatedAmount <= 0', 'ownerIsDerivedAssociatedTokenAccount'], data: '0a0404025a62760400000000040300000600000000000000000508' }]);
  });
  it('the MOCKED Phantom replica emits the captured instruction bytes', () => {
    const r = real(jupiter), target = r.all.at(-1)!.accounts[0]!.pubkey;
    const mocked = mockedPhantomGuardInstructions(r.owner, { lamportsAtLeast: 66_497_618n, tokenAccount: target, tokenAmountAtLeast: 74_867_290n });
    expect(mocked.map(i => Buffer.from(i.data).toString('hex'))).toEqual(r.all.slice(r.dapp.length).map(i => Buffer.from(i.data).toString('hex')));
  });
  it('returns null for the byte-identical reviewed message', () => {
    const r = real(jupiter);
    expect(verifySolanaWalletGuard(r.reviewed, r.reviewed, r.tables)).toBeNull();
  });
});

describe('Phantom Lighthouse guard: everything else is refused (adversarial, derived from the real Jupiter transaction)', () => {
  const r = real(jupiter), guards = r.all.slice(r.dapp.length);
  const refused = (message: Uint8Array, code: string, tables = r.tables) => expect(() => verifySolanaWalletGuard(r.reviewed, message, tables)).toThrow(`SOLANA_WALLET_GUARD_${code}`);
  const lighthouse = (data: number[], accounts = [{ pubkey: r.owner, isSigner: false, isWritable: false }]): SolanaInstruction => ({ programId: LIGHTHOUSE_PROGRAM, accounts, data: Uint8Array.from(data) });
  const withData = (data: Uint8Array) => r.rebuild([...r.dapp, { ...guards[0]!, data }]);
  it('refuses Lighthouse instructions that write or that FloFi cannot read completely', () => {
    refused(r.rebuild([...r.dapp, lighthouse([0, 0, 0, 0, 0])]), 'INSTRUCTION_UNRECOGNIZED'); // MemoryWrite
    refused(r.rebuild([...r.dapp, lighthouse([1, 0, 0])]), 'INSTRUCTION_UNRECOGNIZED'); // MemoryClose
    refused(r.rebuild([...r.dapp, lighthouse([15, 0, 0, ...u64Bytes(1n), 5], [])]), 'ACCOUNTS_CHANGED'); // AssertSysvarClock: no target account
    refused(withData(Uint8Array.from([...guards[0]!.data, 0])), 'DATA_INVALID'); // trailing byte (the program would ignore it; FloFi does not)
    refused(withData(Uint8Array.from([6, 7, ...guards[0]!.data.slice(2)])), 'DATA_INVALID'); // log level out of range
    refused(withData(Uint8Array.from([6, 4, 0])), 'DATA_INVALID'); // no assertion at all
    refused(withData(Uint8Array.from([6, 4, 1, 9])), 'ASSERTION_UNRECOGNIZED');
    refused(withData(Uint8Array.from([6, 4, 1, 0, ...u64Bytes(5n), 8])), 'DATA_INVALID'); // operator out of range
    refused(withData(guards[0]!.data.slice(0, -1)), 'DATA_INVALID'); // truncated
  });
  it('refuses any change to a reviewed instruction, its order, the fee budget, the blockhash or the signers', () => {
    const jupiterIndex = r.dapp.findIndex(i => i.programId === JUPITER), changedSwap = r.dapp.map((ix, i) => i === jupiterIndex ? { ...ix, data: Uint8Array.from(ix.data.map((b, j) => j === 9 ? b ^ 1 : b)) } : ix);
    refused(r.rebuild([...changedSwap, ...guards]), 'INSTRUCTIONS_CHANGED');
    refused(r.rebuild([...r.dapp.slice(0, -1), ...guards]), 'INSTRUCTIONS_CHANGED'); // a reviewed instruction dropped
    refused(r.rebuild([...r.dapp.slice(0, 2), guards[0]!, ...r.dapp.slice(2), guards[1]!]), 'INSTRUCTIONS_CHANGED'); // inserted before the swap
    refused(r.rebuild([{ programId: COMPUTE_BUDGET, accounts: [], data: Uint8Array.from([3, ...u64Bytes(375_000n)]) }, ...r.dapp]), 'INSTRUCTIONS_CHANGED'); // priority fee inserted
    refused(r.rebuild([...r.dapp, { programId: COMPUTE_BUDGET, accounts: [], data: Uint8Array.from([3, ...u64Bytes(375_000n)]) }]), 'INSTRUCTION_UNRECOGNIZED');
    refused(r.rebuild([...r.dapp, ...guards], {}, base58Encode(new Uint8Array(32).fill(7))), 'BLOCKHASH_CHANGED');
    const stranger = createMockedSolanaWallet().owner;
    refused(r.rebuild([...r.dapp, lighthouse([...guards[0]!.data], [{ pubkey: stranger, isSigner: true, isWritable: false }])]), 'SIGNERS_CHANGED');
  });
  it('refuses new accounts, changed account flags and lookups the Review does not know', () => {
    const stranger = createMockedSolanaWallet().owner;
    refused(r.rebuild([...r.dapp, lighthouse([...guards[0]!.data], [{ pubkey: stranger, isSigner: false, isWritable: false }])]), 'ACCOUNTS_CHANGED'); // target outside the Review
    const readonly = r.dapp.flatMap(i => i.accounts).find(a => !a.isWritable && !a.isSigner && !r.dapp.some(i => i.programId === a.pubkey))!;
    // A reviewed read-only account made writable: flags are message-level, so the reviewed instruction that uses it changes too.
    refused(r.rebuild([...r.dapp, lighthouse([...guards[0]!.data], [{ ...readonly, isWritable: true }])]), 'INSTRUCTIONS_CHANGED');
    refused(r.rebuild([...r.dapp, lighthouse([...guards[0]!.data], [guards[0]!.accounts[0]!, guards[1]!.accounts[0]!])]), 'ACCOUNTS_CHANGED'); // two targets
    refused(r.rebuild([...r.dapp, ...guards], { [stranger]: [readonly.pubkey] }), 'LOOKUP_UNKNOWN');
  });
  it('requires the owner signature over exactly the returned bytes, and one signer for a swap', () => {
    const owner = createMockedSolanaWallet(), other = createMockedSolanaWallet();
    const ix = (signer: string): SolanaInstruction => ({ programId: '11111111111111111111111111111111', accounts: [{ pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: other.owner, isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, ...u64Bytes(1_000n)]) });
    const blockhash = base58Encode(new Uint8Array(32).fill(3)), reviewed = serializeMessageV0(compileMessageV0(owner.owner, [ix(owner.owner)], blockhash, {}));
    const guarded = toBase64(serializeTransaction(null, serializeMessageV0(compileMessageV0(owner.owner, [ix(owner.owner), ...mockedPhantomGuardInstructions(owner.owner, { lamportsAtLeast: 1n })], blockhash, {}))));
    const review = { message: toBase64(reviewed), owner: owner.owner };
    expect(verifySignedSolanaSwap(review, owner.sign(guarded), 'SOLANA_TRANSFER').walletGuard?.instructions).toHaveLength(1);
    expect(() => verifySignedSolanaSwap(review, other.sign(guarded), 'SOLANA_TRANSFER')).toThrow('SOLANA_TRANSFER_SIGNATURE_INVALID');
    expect(() => verifySignedSolanaSwap(review, toBase64(serializeTransaction(null, fromBase64(owner.sign(guarded)).slice(65))), 'SOLANA_TRANSFER')).toThrow('SOLANA_TRANSFER_SIGNATURE_INVALID');
  });
});

describe('recorded wallet guards (store validation)', () => {
  const r = real(jupiter), guard = verifySolanaWalletGuard(r.reviewed, r.message, r.tables)!;
  it('accepts exactly the recorded guard, and no guard for the reviewed bytes', () => {
    expect(() => assertRecordedSolanaWalletGuard(r.reviewed, r.message, guard, r.tables)).not.toThrow();
    expect(() => assertRecordedSolanaWalletGuard(r.reviewed, r.reviewed, undefined, r.tables)).not.toThrow();
  });
  it('refuses a tampered, missing or invented guard record', () => {
    const tampered = { ...guard, instructions: guard.instructions.map(i => ({ ...i, assertions: ['lamports >= 0'] })) };
    expect(() => assertRecordedSolanaWalletGuard(r.reviewed, r.message, tampered, r.tables)).toThrow('SOLANA_WALLET_GUARD_RECORD_INVALID');
    expect(() => assertRecordedSolanaWalletGuard(r.reviewed, r.message, undefined, r.tables)).toThrow('SOLANA_WALLET_GUARD_RECORD_INVALID');
    expect(() => assertRecordedSolanaWalletGuard(r.reviewed, r.reviewed, guard, r.tables)).toThrow('SOLANA_WALLET_GUARD_RECORD_INVALID');
    expect(() => assertRecordedSolanaWalletGuard(r.reviewed, r.rebuild([...r.dapp.slice(1), ...r.all.slice(r.dapp.length)]), guard, r.tables)).toThrow('SOLANA_WALLET_GUARD_RECORD_INVALID');
  });
});

describe('Lighthouse assertion decoding (types/assert/*.rs, Borsh variant order)', () => {
  const key = Array.from({ length: 32 }, (_, i) => i);
  it.each([
    [[5, 0, 0, ...u64Bytes(7n), 4], 'AssertAccountInfo', ['lamports >= 7']],
    [[5, 1, 1, ...u64Bytes(165n), 0], 'AssertAccountInfo', ['dataLength == 165']],
    [[5, 2, 2, ...key, 1], 'AssertAccountInfo', ['owner != 0x' + Buffer.from(key).toString('hex')]],
    [[5, 3, 3, 2, 0], 'AssertAccountInfo', ['owner == Token2022']],
    [[5, 4, 4, ...u64Bytes(9n), 5], 'AssertAccountInfo', ['rentEpoch <= 9']],
    [[6, 5, 3, 5, 1, 0, 6, 0, 0, 7, 0, 1], 'AssertAccountInfoMulti', ['isSigner == true', 'isWritable == false', 'executable != false']],
    [[5, 6, 8, ...key, 0, 0x80, 0x01], 'AssertAccountInfo', ['dataHash(0,128) == 0x' + Buffer.from(key).toString('hex')]],
    [[9, 0, 0, ...key, 0], 'AssertTokenAccount', ['mint == 0x' + Buffer.from(key).toString('hex')]],
    [[9, 0, 1, ...key, 0], 'AssertTokenAccount', ['owner == 0x' + Buffer.from(key).toString('hex')]],
    [[9, 0, 3, 1, ...key, 1], 'AssertTokenAccount', ['delegate != 0x' + Buffer.from(key).toString('hex')]],
    [[10, 4, 4, 4, 1, 0, 5, 1, ...u64Bytes(2_039_280n), 0, 7, 0, 0, 8], 'AssertTokenAccountMulti',
      ['state == 1', 'isNative == 2039280', 'closeAuthority == none', 'ownerIsDerivedAssociatedTokenAccount']],
  ] as const)('decodes %j', (data, kind, assertions) => {
    expect(decodeLighthouseAssertion(Uint8Array.from(data))).toEqual({ kind, assertions });
  });
  it('refuses every instruction that is not an allowlisted assertion', () => {
    for (const disc of [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 255]) expect(() => decodeLighthouseAssertion(Uint8Array.from([disc, 0, 0]))).toThrow('SOLANA_WALLET_GUARD_INSTRUCTION_UNRECOGNIZED');
    expect(() => decodeLighthouseAssertion(Uint8Array.from([6, 4, 17, ...Array.from({ length: 17 }, () => [7, 0, 0]).flat()]))).toThrow('SOLANA_WALLET_GUARD_DATA_INVALID');
    expect(() => decodeLighthouseAssertion(Uint8Array.from([5, 0, 5, 2, 0]))).toThrow('SOLANA_WALLET_GUARD_DATA_INVALID'); // bool must be 0 or 1
    expect(() => decodeLighthouseAssertion(Uint8Array.from([9, 0, 3, 2, 0]))).toThrow('SOLANA_WALLET_GUARD_DATA_INVALID'); // Option tag must be 0 or 1
  });
});
