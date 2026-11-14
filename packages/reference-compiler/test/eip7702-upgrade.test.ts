// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): the owner's EIP-7702 authorization of the pinned
 * `Simple7702Account` v0.8, and a v0.8 Circle operation that carries it (the EIP-7702 initCode marker; the signed tuple as the bundler's
 * `eip7702Auth`). The fixed vectors were computed once with the lockfile-pinned viem 2.57.8 (`hashAuthorization`, `privateKeyToAccount(...)
 * .signAuthorization`, `getUserOperationTypedData` / `getUserOperationHash` with `entryPointVersion: '0.8'` and `authorization`, and
 * `formatUserOperationRequest`) and are pasted here: viem is not a dependency of this package. MOCKED evidence of the encodings only.
 */
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import * as u from '../src/erc4337.js';
import * as c from '../src/circle-paymaster.js';
import { bytesOf, hexOf } from '../src/erc7710.js';

const SIMPLE = u.SIMPLE_7702_ACCOUNT_V0_8;
/** viem 2.57.8 `hashAuthorization({ chainId, contractAddress: Simple7702Account v0.8, nonce })`. */
const AUTH_HASHES: readonly (readonly [number, bigint, string])[] = [
  [8453, 0n, '0xa0e2f32aadf3cb41a0b826c942b125f90a103d7f22466af057772f7b6c974a79'],
  [1, 7n, '0x0091c574ac59965dab370c018be26da5ba96388375a80fcb3b782bf3f0e38826'],
  [42161, 255n, '0xa6e8b90e6fe829964a27825ed3aee75d2f71320af237c226118298ff9ffaa9a8'],
  [8453, 1024n, '0xdf944da5617ae02f1329da8779c5564a5209d9ea26be9af15b9a682cb2ac9817'],
];
/** viem 2.57.8: the account of private key 0x11…11 signing `{ chainId: 8453, contractAddress: Simple7702Account, nonce: 3 }`. */
const VIEM_OWNER = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const VIEM_SIGNED = { r: '0x99523b24cd8f5760b35bffeb3f87bc80812f35bf5b466b371694b84ccaaf1f56', s: '0x670580cc93307f7d219223ffe5b0fc2a4b69c402411b42f49dce8a7e37dd180a', yParity: 1 as const };
/** viem 2.57.8 `getUserOperationHash` (0.8) = `hashTypedData(getUserOperationTypedData(...))` of the first-use operation below (factory 0x7702). */
const VIEM_FIRST_USE_HASH = '0x2da35c93695bbbdee409315a1cf6564988923c5fdc5bbfcd6efcd3b0855a9878';
const PAYMASTER_AND_DATA = c.CIRCLE_PAYMASTER_V08 + (200_000n).toString(16).padStart(32, '0') + (15_000n).toString(16).padStart(32, '0') + '00';
const firstUse = (initCode = u.EIP7702_INIT_CODE_MARKER): u.PackedUserOperation => ({ sender: VIEM_OWNER, nonce: (123n << 64n) | 4n, initCode,
  callData: '0xb61d27f600000000', accountGasLimits: u.packUints(120_000n, 300_000n), preVerificationGas: 70_000n, gasFees: u.packUints(1_000_000_000n, 3_000_000_000n),
  paymasterAndData: PAYMASTER_AND_DATA, signature: '0x' });

function key() {
  const secret = secp256k1.utils.randomSecretKey(), address = hexOf(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12));
  return { address, sign: (digest: string) => { const sig = secp256k1.sign(bytesOf(digest), secret, { prehash: false, format: 'recovered' }); return hexOf(new Uint8Array([...sig.subarray(1), sig[0]! + 27])); } };
}
const viemSignature = VIEM_SIGNED.r + VIEM_SIGNED.s.slice(2) + '1c';

describe('EIP-7702 authorization of the pinned Simple7702Account (cross-checked with viem 2.57.8)', () => {
  it('hashes the tuple exactly as viem (0x05 ‖ rlp([chainId, address, nonce]))', () => {
    for (const [chainId, nonce, hash] of AUTH_HASHES) expect(u.eip7702AuthorizationHash({ chainId, address: SIMPLE, nonce })).toBe(hash);
  });
  it('reads viem\'s signed authorization back: same tuple, same signer, same bundler `eip7702Auth`', () => {
    const tuple = { chainId: 8453, address: SIMPLE, nonce: 3n };
    const signed = u.signedEip7702Authorization(tuple, viemSignature, VIEM_OWNER);
    expect(signed).toEqual({ ...tuple, ...VIEM_SIGNED });
    expect(u.recoverEip7702AuthorizationSigner(signed)).toBe(VIEM_OWNER);
    // viem's formatAuthorization (lower-cased address): quantities, 32-byte r/s, one-byte yParity.
    expect(u.toBundlerEip7702Auth(signed)).toEqual({ address: SIMPLE, chainId: '0x2105', nonce: '0x3', r: VIEM_SIGNED.r, s: VIEM_SIGNED.s, yParity: '0x01' });
    expect(u.fromBundlerEip7702Auth(u.toBundlerEip7702Auth(signed))).toEqual(signed);
    // v as 0/1 is read the same way.
    expect(u.signedEip7702Authorization(tuple, VIEM_SIGNED.r + VIEM_SIGNED.s.slice(2) + '01', VIEM_OWNER)).toEqual(signed);
  });
  it('refuses a chain-agnostic tuple (chainId 0), a nonce beyond uint64, another signer, another tuple and a high-s signature', () => {
    expect(() => u.eip7702AuthorizationHash({ chainId: 0, address: SIMPLE, nonce: 0n })).toThrow('EIP7702_AUTHORIZATION_CHAIN_INVALID');
    expect(() => u.eip7702AuthorizationHash({ chainId: 8453, address: SIMPLE, nonce: 1n << 64n })).toThrow('EIP7702_AUTHORIZATION_NONCE_INVALID');
    const tuple = { chainId: 8453, address: SIMPLE, nonce: 3n };
    expect(() => u.signedEip7702Authorization(tuple, viemSignature, '0x' + '1'.repeat(40))).toThrow('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
    expect(() => u.signedEip7702Authorization({ ...tuple, nonce: 4n }, viemSignature, VIEM_OWNER)).toThrow('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
    expect(() => u.signedEip7702Authorization({ ...tuple, chainId: 1 }, viemSignature, VIEM_OWNER)).toThrow('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
    expect(() => u.signedEip7702Authorization({ ...tuple, address: '0x' + '9'.repeat(40) }, viemSignature, VIEM_OWNER)).toThrow('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
    const n = secp256k1.Point.CURVE().n, highS = '0x' + (n - BigInt(VIEM_SIGNED.s)).toString(16).padStart(64, '0');
    expect(() => u.signedEip7702Authorization(tuple, VIEM_SIGNED.r + highS.slice(2) + '1b', VIEM_OWNER)).toThrow('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
    expect(() => u.fromBundlerEip7702Auth({ ...u.toBundlerEip7702Auth(u.signedEip7702Authorization(tuple, viemSignature, VIEM_OWNER)), yParity: '0x02' }))
      .toThrow('EIP7702_AUTHORIZATION_INVALID');
  });
});

describe('a v0.8 Circle operation that upgrades the owner inside itself (cross-checked with viem 2.57.8)', () => {
  it('hashes and types the first-use operation with the delegate in place of the marker, exactly as viem', () => {
    const op = firstUse();
    expect(u.userOpHashV08(op, 8453, { eip7702Delegate: SIMPLE })).toBe(VIEM_FIRST_USE_HASH);
    expect(u.userOpHashFor(op, 8453, u.ENTRY_POINT_V0_8, SIMPLE)).toBe(VIEM_FIRST_USE_HASH);
    const typed = u.entryPointV08TypedData(8453, op, u.ENTRY_POINT_V0_8, SIMPLE);
    expect(typed.message.initCode).toBe(SIMPLE);
    // The typed data's own digest is the operation's identity (what the bundler and the receipt name).
    const owner = key(), mine = { ...op, sender: owner.address }, signature = owner.sign(u.userOpHashV08(mine, 8453, { eip7702Delegate: SIMPLE }));
    expect(u.verifyOwnerUserOpSignatureV08(8453, mine, signature, u.ENTRY_POINT_V0_8, SIMPLE)).toBe(true);
    // Signed without the delegate (the bare marker), or for another delegate: never the operation the EntryPoint validates.
    expect(u.verifyOwnerUserOpSignatureV08(8453, mine, signature)).toBe(false);
    expect(u.verifyOwnerUserOpSignatureV08(8453, mine, signature, u.ENTRY_POINT_V0_8, '0x' + '9'.repeat(40))).toBe(false);
    // The marker is typed only with its delegate; a delegate is never typed into an operation without the marker; v0.7 never takes one.
    expect(() => u.entryPointV08TypedData(8453, op)).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(() => u.entryPointV08TypedData(8453, firstUse('0x'), u.ENTRY_POINT_V0_8, SIMPLE)).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(() => u.userOpHashFor(op, 8453, u.ENTRY_POINT_V0_7, SIMPLE)).toThrow('ERC4337_ENTRY_POINT_UNSUPPORTED');
  });
  it('puts the marker as viem\'s `factory: 0x7702` and the signed authorization on the wire — only together, only the sender\'s own', () => {
    const op = firstUse(), signed = u.signedEip7702Authorization({ chainId: 8453, address: SIMPLE, nonce: 3n }, viemSignature, VIEM_OWNER);
    expect(u.toBundlerUserOperationWithPaymaster(op, signed)).toMatchObject({ sender: VIEM_OWNER, factory: '0x7702', factoryData: '0x',
      eip7702Auth: { address: SIMPLE, chainId: '0x2105', nonce: '0x3', yParity: '0x01' }, paymaster: c.CIRCLE_PAYMASTER_V08 });
    // The bundler double reads it back to the same packed operation (the 20-byte marker).
    expect(u.packRpcUserOperation(u.toBundlerUserOperationWithPaymaster(op, signed))).toMatchObject({ initCode: u.EIP7702_INIT_CODE_MARKER, sender: VIEM_OWNER });
    expect(() => u.toBundlerUserOperationWithPaymaster(op)).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(() => u.toBundlerUserOperationWithPaymaster(firstUse('0x'), signed)).toThrow('ERC4337_EIP7702_AUTH_REFUSED');
    expect(() => u.toBundlerUserOperationWithPaymaster({ ...op, sender: '0x' + '1'.repeat(40) }, signed)).toThrow('ERC4337_EIP7702_AUTH_REFUSED');
    // An already delegated account's operation carries neither (unchanged wire format).
    expect(u.toBundlerUserOperationWithPaymaster(firstUse('0x'))).not.toHaveProperty('eip7702Auth');
    // Final review (P3): a sender ALREADY delegated sends the marker alone (never a consumed authorization beside it, never without the marker).
    expect(u.toBundlerUserOperationWithPaymaster(op, undefined, { delegated: true })).toMatchObject({ factory: '0x7702', factoryData: '0x' });
    expect(u.toBundlerUserOperationWithPaymaster(op, undefined, { delegated: true })).not.toHaveProperty('eip7702Auth');
    expect(() => u.toBundlerUserOperationWithPaymaster(op, signed, { delegated: true })).toThrow('ERC4337_EIP7702_AUTH_REFUSED');
    expect(() => u.toBundlerUserOperationWithPaymaster(firstUse('0x'), undefined, { delegated: true })).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(u.toBundlerUserOperationWithPaymaster(firstUse('0x'))).not.toHaveProperty('factory');
  });
  it('the Circle operation check accepts the marker only for an upgrade to Simple7702Account v0.8 and the operation without it otherwise', () => {
    const owner = key(), pins = c.circlePinsOf(8453)!;
    const permit = c.circlePermit({ chainId: 8453, entryPoint: u.ENTRY_POINT_V0_8, owner: owner.address, cap: 2_000_000n, nonce: 0n });
    const op = { ...u.packedUserOperationWithPaymaster({ sender: owner.address, nonce: 1n, callData: u.simple7702CallData([{ target: pins.usdc, value: 0n, data: '0x' }]),
      gas: { verificationGasLimit: 120_000n, callGasLimit: 300_000n, preVerificationGas: 70_000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n },
      paymasterAndData: c.circlePaymasterAndData({ paymaster: c.CIRCLE_PAYMASTER_V08, verificationGasLimit: 200_000n, postOpGasLimit: 15_000n, token: pins.usdc,
        permitAmount: 2_000_000n, permitSignature: owner.sign(c.permitDigest(permit)) }) }), initCode: u.EIP7702_INIT_CODE_MARKER };
    const x = { chainId: 8453, entryPoint: u.ENTRY_POINT_V0_8, owner: owner.address, accountKind: 'SIMPLE_7702_V0_8' as const, permitCap: 2_000_000n, permitNonce: 0n };
    expect(c.assertCirclePaymasterOperation(op, { ...x, eip7702Upgrade: true }).paymaster).toBe(c.CIRCLE_PAYMASTER_V08);
    expect(() => c.assertCirclePaymasterOperation(op, x)).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(() => c.assertCirclePaymasterOperation({ ...op, initCode: '0x' }, { ...x, eip7702Upgrade: true })).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(() => c.assertCirclePaymasterOperation({ ...op, initCode: u.EIP7702_INIT_CODE_MARKER + '00' }, { ...x, eip7702Upgrade: true })).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(c.assertCirclePaymasterOperation({ ...op, initCode: '0x' }, x).paymaster).toBe(c.CIRCLE_PAYMASTER_V08);
  });
});
