// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: durable-nonce instruction layouts (hand-derived from the System program) and lifetimes; the app cross-checks the installed codecs. */
import { describe, expect, it } from 'vitest';
import * as n from '../src/solana-nonce.js';
import { base58Encode, publicKeyBytes, serializeMessageV0, u64Bytes } from '../src/solana.js';

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', NONCE = '4Nd1mBQtrMJVYVfKf2PJy9NZaZdQiw6SzgfKHqeXHzsf', OTHER = 'So11111111111111111111111111111111111111112';

describe('System program nonce instructions', () => {
  it('encode the System program layouts: discriminator u32 LE, then the arguments', () => {
    const create = n.createNonceAccountInstruction(OWNER, NONCE, 1_447_680n);
    expect(Array.from(create.data)).toEqual([0, 0, 0, 0, ...u64Bytes(1_447_680n), ...u64Bytes(80n), ...Array.from(publicKeyBytes(n.SYSTEM_PROGRAM))]);
    expect(create.accounts).toEqual([{ pubkey: OWNER, isSigner: true, isWritable: true }, { pubkey: NONCE, isSigner: true, isWritable: true }]);
    const init = n.initializeNonceAccountInstruction(NONCE, OWNER);
    expect(Array.from(init.data)).toEqual([6, 0, 0, 0, ...Array.from(publicKeyBytes(OWNER))]);
    expect(init.accounts.map(a => a.pubkey)).toEqual([NONCE, n.RECENT_BLOCKHASHES_SYSVAR, n.RENT_SYSVAR]);
    const advance = n.advanceNonceAccountInstruction(NONCE, OWNER);
    expect(Array.from(advance.data)).toEqual([4, 0, 0, 0]);
    expect(advance.accounts).toEqual([{ pubkey: NONCE, isSigner: false, isWritable: true }, { pubkey: n.RECENT_BLOCKHASHES_SYSVAR, isSigner: false, isWritable: false }, { pubkey: OWNER, isSigner: true, isWritable: false }]);
    expect(Array.from(n.withdrawNonceAccountInstruction(NONCE, OWNER, OWNER, 5n).data)).toEqual([5, 0, 0, 0, ...u64Bytes(5n)]);
    expect(() => n.createNonceAccountInstruction(OWNER, NONCE, 0n)).toThrow('SOLANA_NONCE_LAMPORTS_INVALID');
  });
  it('decodes an initialized nonce account and refuses anything else', () => {
    const value = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const data = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, ...Array.from(publicKeyBytes(OWNER)), ...Array.from(value), ...u64Bytes(5000n)]);
    expect(n.decodeNonceAccount(data)).toEqual({ authority: OWNER, nonce: base58Encode(value), lamportsPerSignature: 5000n });
    expect(() => n.decodeNonceAccount(data, OTHER)).toThrow('SOLANA_NONCE_ACCOUNT_INVALID');
    expect(() => n.decodeNonceAccount(data.subarray(0, 79))).toThrow('SOLANA_NONCE_ACCOUNT_INVALID');
    const uninitialized = new Uint8Array(80); uninitialized[0] = 1;
    expect(() => n.decodeNonceAccount(uninitialized)).toThrow('SOLANA_NONCE_ACCOUNT_UNINITIALIZED');
  });
});

describe('durable-nonce messages', () => {
  const value = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
  const nonce = { account: NONCE, authority: OWNER, nonce: value, lamportsPerSignature: 5000n };
  const transfer = { programId: n.SYSTEM_PROGRAM, accounts: [{ pubkey: OWNER, isSigner: true, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }],
    data: Uint8Array.from([2, 0, 0, 0, ...u64Bytes(1_000n)]) };
  it('puts the advance first, the nonce value as the blockhash and the owner as fee payer and authority', () => {
    const message = n.compileDurableNonceMessageV0(OWNER, nonce, [transfer], {});
    expect(message.blockhash).toBe(value); expect(message.staticKeys[0]).toBe(OWNER);
    const lifetime = n.durableNonceLifetime(message, {});
    expect(lifetime).toEqual({ nonceAccount: NONCE, authority: OWNER, nonce: value });
    expect(n.durableNonceLifetimeOf(serializeMessageV0(message), {})).toEqual(lifetime);
    expect(n.nonceStillValid(lifetime!, nonce)).toBe(true);
    expect(n.nonceStillValid(lifetime!, { ...nonce, nonce: base58Encode(new Uint8Array(32)) })).toBe(false);
    expect(n.nonceStillValid(lifetime!, { ...nonce, authority: OTHER })).toBe(false);
    expect(publicKeyBytes(lifetime!.nonce)).toHaveLength(32);
  });
  it('refuses a nonce the owner does not control, an empty step, and reports an ordinary message as not durable', () => {
    expect(() => n.compileDurableNonceMessageV0(OWNER, { ...nonce, authority: OTHER }, [transfer], {})).toThrow('SOLANA_NONCE_AUTHORITY_MISMATCH');
    expect(() => n.compileDurableNonceMessageV0(OWNER, nonce, [], {})).toThrow('SOLANA_NONCE_INSTRUCTIONS_EMPTY');
    const plain = n.compileDurableNonceMessageV0(OWNER, nonce, [transfer], {});
    const ordinary = { ...plain, blockhash: value };
    // The same message without its advance instruction is an ordinary recent-blockhash message.
    const withoutAdvance = { ...ordinary, instructions: ordinary.instructions.slice(1) };
    expect(n.durableNonceLifetime(withoutAdvance as typeof plain, {})).toBeNull();
  });
});
