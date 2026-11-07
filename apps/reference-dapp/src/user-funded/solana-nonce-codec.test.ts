// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the compiler's durable-nonce encodings agree byte for byte with the installed @solana-program/system codecs (the app's own dependency). */
import { describe, expect, it } from 'vitest';
import { getAdvanceNonceAccountInstruction, getCreateAccountInstruction, getInitializeNonceAccountInstruction, getNonceEncoder, getNonceSize, getWithdrawNonceAccountInstruction, NonceState,
  NonceVersion } from '@solana-program/system';
import { address, createNoopSigner } from '@solana/kit';
import { solanaNonce as n } from '@defi-workflow-engine/reference-compiler';
import { base58Encode, publicKeyBytes, serializeMessageV0, u64Bytes } from '@defi-workflow-engine/reference-compiler';

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', NONCE = '4Nd1mBQtrMJVYVfKf2PJy9NZaZdQiw6SzgfKHqeXHzsf', OTHER = 'So11111111111111111111111111111111111111112';
const signer = (a: string) => createNoopSigner(address(a));
const bytes = (i: { data: ReadonlyArray<number> | Uint8Array }) => Array.from(i.data as Uint8Array);
const metas = (i: { accounts?: readonly { address: string; role: number }[] }) => (i.accounts ?? []).map(a => ({ pubkey: String(a.address), isSigner: a.role >= 2, isWritable: a.role % 2 === 1 }));

describe('System program nonce instructions', () => {
  it('encode exactly as the generated codecs', () => {
    expect(n.NONCE_ACCOUNT_SIZE).toBe(getNonceSize());
    const create = getCreateAccountInstruction({ payer: signer(OWNER), newAccount: signer(NONCE), lamports: 1_447_680n, space: getNonceSize(), programAddress: address(n.SYSTEM_PROGRAM) });
    const mine = n.createNonceAccountInstruction(OWNER, NONCE, 1_447_680n);
    expect(Array.from(mine.data)).toEqual(bytes(create)); expect(mine.accounts).toEqual(metas(create)); expect(mine.programId).toBe(String(create.programAddress));
    const init = getInitializeNonceAccountInstruction({ nonceAccount: address(NONCE), nonceAuthority: address(OWNER) });
    const mineInit = n.initializeNonceAccountInstruction(NONCE, OWNER);
    expect(Array.from(mineInit.data)).toEqual(bytes(init)); expect(mineInit.accounts).toEqual(metas(init));
    const advance = getAdvanceNonceAccountInstruction({ nonceAccount: address(NONCE), nonceAuthority: signer(OWNER) });
    const mineAdvance = n.advanceNonceAccountInstruction(NONCE, OWNER);
    expect(Array.from(mineAdvance.data)).toEqual(bytes(advance)); expect(mineAdvance.accounts).toEqual(metas(advance));
    const withdraw = getWithdrawNonceAccountInstruction({ nonceAccount: address(NONCE), recipientAccount: address(OWNER), nonceAuthority: signer(OWNER), withdrawAmount: 5n });
    const mineWithdraw = n.withdrawNonceAccountInstruction(NONCE, OWNER, OWNER, 5n);
    expect(Array.from(mineWithdraw.data)).toEqual(bytes(withdraw)); expect(mineWithdraw.accounts).toEqual(metas(withdraw));
  });
  it('decodes an initialized nonce account and refuses anything else', () => {
    const value = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const data = new Uint8Array(getNonceEncoder().encode({ version: NonceVersion.Current, state: NonceState.Initialized, authority: address(OWNER), blockhash: address(value), lamportsPerSignature: 5000n }));
    expect(n.decodeNonceAccount(data)).toEqual({ authority: OWNER, nonce: value, lamportsPerSignature: 5000n });
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
