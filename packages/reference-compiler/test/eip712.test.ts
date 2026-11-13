// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: the generic EIP-712 hasher against 0x's official Gasless API v2 examples (their `hash` is the
 * EIP-712 digest; Permit2 PermitWitnessTransferFrom with nested structs and `bytes[]`, and EIP-2612 Permit). Offline fixtures only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import * as eip712 from '../src/eip712.js';

type Example = { hash: string; eip712: eip712.TypedData; signature?: { v: number; r: string; s: string; signatureType: number } };
const examples = JSON.parse(readFileSync(new URL('./fixtures/zeroex-gasless-official-examples.json', import.meta.url), 'utf8')) as Record<string, Example>;
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');

describe('EIP-712 hashing of provider-built typed data', () => {
  it.each(['quoteTrade', 'quoteApproval', 'submitTrade', 'submitApproval'])('recomputes 0x\'s official %s hash exactly', name => {
    const example = examples[name]!;
    expect(eip712.hashTypedData(example.eip712)).toBe(example.hash);
  });
  it('hashes the same digest whether or not the payload declares EIP712Domain', () => {
    const types = Object.fromEntries(Object.entries(examples.quoteTrade!.eip712.types).filter(([name]) => name !== 'EIP712Domain'));
    expect(eip712.hashTypedData({ ...examples.quoteTrade!.eip712, types })).toBe(examples.quoteTrade!.hash);
  });
  it('encodes the Permit2 witness type with its dependencies sorted after the primary type', () => {
    expect(eip712.encodeType('PermitWitnessTransferFrom', examples.quoteTrade!.eip712.types)).toBe(
      'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,SlippageAndActions slippageAndActions)' +
      'SlippageAndActions(address recipient,address buyToken,uint256 minAmountOut,bytes[] actions)TokenPermissions(address token,uint256 amount)');
    // Settler's SLIPPAGE_AND_ACTIONS_TYPEHASH (0x-settler src/SettlerAbstract.sol).
    expect(hex(keccak_256(new TextEncoder().encode(eip712.encodeType('SlippageAndActions', examples.quoteTrade!.eip712.types)))))
      .toBe('0x615e8d716cef7295e75dd3f1f10d679914ad6d7759e8e9459f0109ef75241701');
  });
  it('recovers the official submit signatures to the example taker', () => {
    for (const name of ['submitTrade', 'submitApproval']) {
      const { signature, hash } = examples[name]!;
      const joined = signature!.r + signature!.s.slice(2) + signature!.v.toString(16);
      expect(eip712.recoverTypedDataSigner(hash, joined)).toBe('0x70a9f34f9b34c64957b9c401a97bfed35b95049e');
      expect(eip712.splitSignature(joined)).toEqual({ v: signature!.v, r: signature!.r, s: signature!.s });
    }
  });
  it('recovers a fresh disposable signer and normalises v from 0/1', () => {
    const secret = secp256k1.utils.randomSecretKey();
    const address = hex(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12));
    const digest = eip712.hashTypedData(examples.quoteApproval!.eip712);
    const raw = secp256k1.sign(Buffer.from(digest.slice(2), 'hex'), secret, { prehash: false, format: 'recovered' });
    const v27 = hex(raw.subarray(1)) + (raw[0]! + 27).toString(16), v0 = hex(raw.subarray(1)) + raw[0]!.toString(16).padStart(2, '0');
    expect(eip712.recoverTypedDataSigner(digest, v27)).toBe(address);
    expect(eip712.recoverTypedDataSigner(digest, v0)).toBe(address);
    expect(eip712.splitSignature(v0).v).toBe(raw[0]! + 27);
  });
  it('fails closed on every malformed payload instead of guessing', () => {
    const base = examples.quoteTrade!.eip712;
    const message = base.message as { permitted: Record<string, unknown>; slippageAndActions: Record<string, unknown> };
    const variants: [string, eip712.TypedData, string][] = [
      ['an undeclared message key', { ...base, message: { ...base.message, extra: '1' } }, 'EIP712_VALUE_INVALID'],
      ['a missing nested field', { ...base, message: { ...base.message, permitted: { token: message.permitted.token } } }, 'EIP712_VALUE_INVALID'],
      ['an unknown referenced type', { ...base, types: { ...base.types, TokenPermissions: [{ name: 'token', type: 'Missing' }] } }, 'EIP712_TYPES_INVALID'],
      ['a recursive type', { ...base, types: { ...base.types, TokenPermissions: [{ name: 'self', type: 'TokenPermissions' }] },
        message: { ...base.message, permitted: { self: {} } } }, 'EIP712_TYPES_RECURSIVE'],
      ['a non-hex bytes element', { ...base, message: { ...base.message, slippageAndActions: { ...message.slippageAndActions, actions: ['0xzz'] } } }, 'EIP712_VALUE_INVALID'],
      ['an amount above uint256', { ...base, message: { ...base.message, permitted: { ...message.permitted, amount: (1n << 256n).toString() } } }, 'EIP712_VALUE_INVALID'],
      ['an undeclared domain key', { ...base, domain: { ...base.domain, extra: 'x' } }, 'EIP712_DOMAIN_INVALID'],
      ['a domain that disagrees with EIP712Domain', { ...base, domain: { name: 'Permit2', version: '1', chainId: 1, verifyingContract: base.domain.verifyingContract } }, 'EIP712_DOMAIN_INVALID'],
      ['an unknown primary type', { ...base, primaryType: 'Other' }, 'EIP712_PRIMARY_TYPE_INVALID'],
    ];
    for (const [, data, code] of variants) expect(() => eip712.hashTypedData(data)).toThrow(code);
    expect(() => eip712.splitSignature('0x' + '1'.repeat(130))).toThrow('EIP712_SIGNATURE_INVALID');
    expect(() => eip712.recoverTypedDataSigner(examples.quoteTrade!.hash, '0x' + '00'.repeat(64) + '1b')).toThrow('EIP712_SIGNATURE_INVALID');
  });
  it('changes the digest when any signed value changes', () => {
    const base = examples.quoteTrade!.eip712, message = base.message as { slippageAndActions: Record<string, unknown> };
    const moved = { ...base, message: { ...base.message, slippageAndActions: { ...message.slippageAndActions, minAmountOut: '1' } } };
    expect(eip712.hashTypedData(moved)).not.toBe(examples.quoteTrade!.hash);
    expect(eip712.hashTypedData({ ...base, domain: { ...base.domain, chainId: 4663 } })).not.toBe(examples.quoteTrade!.hash);
  });
});
