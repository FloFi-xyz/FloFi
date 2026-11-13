// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): EntryPoint v0.8 hashing, `Simple7702Account` call data and Circle's USDC paymaster
 * encodings. The fixed vectors were computed once with the lockfile-pinned viem 2.57.8 (`getUserOperationHash` with `entryPointVersion` 0.7 / 0.8,
 * its EIP-7702 initCode rule, `toPackedUserOperation`, `encodePacked`, `encodeFunctionData`, `hashTypedData`) and are pasted here: viem is not a
 * dependency of this package. MOCKED evidence of the encodings, not of deployed bytecode or of Circle's live behaviour.
 */
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import * as u from '../src/erc4337.js';
import * as c from '../src/circle-paymaster.js';
import { abiEncode, bytesOf, hexOf, type Call } from '../src/erc7710.js';

function key() {
  const secret = secp256k1.utils.randomSecretKey(), address = hexOf(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12));
  return { address, sign: (digest: string) => { const sig = secp256k1.sign(bytesOf(digest), secret, { prehash: false, format: 'recovered' }); return hexOf(new Uint8Array([...sig.subarray(1), sig[0]! + 27])); } };
}
const SENDER = '0x1111111111111111111111111111111111111111';
const USDC_1 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FAKE_SIG = '0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b';
const V = {
  paymasterData: '0x00a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000002625a0ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd1b',
  callData: '0x34fcd5be0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000120000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000',
  single: '0xb61d27f6000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004095ea7b300000000000000000000000000000000000000000000000000000000',
  paymasterAndData: '0x0578cfb241215b77442a541325d6a4e6dfe700ec00000000000000000000000000030d4000000000000000000000000000003a9800a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000002625a0ababababababababababababababababababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd1b',
  accountGasLimits: '0x0000000000000000000000000001d4c0000000000000000000000000000493e0',
  gasFees: '0x0000000000000000000000003b9aca00000000000000000000000000b2d05e00',
  h08: '0x49dabd12399d1260f1d75a7d499d903c680ebdf55686c3772bd2cd56b753c5f8',
  h08Auth: '0x45d84bcbefe112c90240cb8b0498260a46fb3991df06ee1abe6c7f794eff2ec5',
  h08Marker: '0x7b415dfb71fc7fbcc0d744e66beee79c66af875211109e16f36d729c16637699',
  h07: '0x53c4eef6f693e70c9eab1a004796911426c6b86d01d2472b2c592d2ece614f99',
  permitDigest: '0x86e676227617ddd19dc828892ee8ada23d5b6b897b30c311305d42d88e009621',
};
const TWO_CALLS: readonly Call[] = [
  { target: USDC_1, value: 0n, data: '0xa9059cbb' + '00'.repeat(12) + '22'.repeat(20) + (1_000_000n).toString(16).padStart(64, '0') },
  { target: '0x3333333333333333333333333333333333333333', value: 5n, data: '0x' }];
const GAS: u.UserOperationGas = { verificationGasLimit: 120_000n, callGasLimit: 300_000n, preVerificationGas: 70_000n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 3_000_000_000n };
const vectorOp = (paymasterAndData = V.paymasterAndData, initCode = '0x'): u.PackedUserOperation => ({ sender: SENDER, nonce: (123n << 64n) | 4n, initCode, callData: V.callData,
  accountGasLimits: V.accountGasLimits, preVerificationGas: 70_000n, gasFees: V.gasFees, paymasterAndData, signature: '0x' });

describe('EntryPoint v0.8 and Simple7702Account (cross-checked with viem 2.57.8)', () => {
  it('packs the gas words and the Simple7702 call data exactly as viem', () => {
    expect(u.packUints(GAS.verificationGasLimit, GAS.callGasLimit)).toBe(V.accountGasLimits);
    expect(u.packUints(GAS.maxPriorityFeePerGas, GAS.maxFeePerGas)).toBe(V.gasFees);
    expect(u.simple7702CallData(TWO_CALLS)).toBe(V.callData);
    expect(u.simple7702CallData([{ target: USDC_1, value: 0n, data: '0x095ea7b3' }])).toBe(V.single);
    expect(u.decodeSimple7702CallData(V.callData)).toEqual(TWO_CALLS.map(x => ({ ...x })));
    expect(u.decodeOwnerAccountCallData('SIMPLE_7702_V0_8', V.single)).toEqual([{ target: USDC_1, value: 0n, data: '0x095ea7b3' }]);
    // Canonical only: a batch of one call, trailing bytes, the DeleGator's ERC-7579 encoding or any other selector are refused.
    const batchOfOne = u.SIMPLE_7702_EXECUTE_BATCH_SELECTOR + hexOf(abiEncode([{ array: { tuple: ['address', 'uint256', 'bytes'] } }], [[[USDC_1, 0n, '0x']]])).slice(2);
    expect(() => u.decodeSimple7702CallData(batchOfOne)).toThrow('ERC4337_CALLDATA_INVALID');
    expect(() => u.decodeSimple7702CallData(V.single + '00')).toThrow('ERC4337_CALLDATA_INVALID');
    expect(() => u.decodeSimple7702CallData(u.batchCallData(TWO_CALLS))).toThrow('ERC4337_CALLDATA_INVALID');
    expect(u.ownerAccountCallData('METAMASK_DELEGATOR_V1_3', TWO_CALLS)).toBe(u.batchCallData(TWO_CALLS));
  });

  it('hashes a v0.8 operation as viem\'s EIP-712 getUserOperationHash, including the EIP-7702 initCode rule; v0.7 with a paymaster unchanged', () => {
    expect(u.userOpHashV08(vectorOp(), 1)).toBe(V.h08);
    expect(u.userOpHashFor(vectorOp(), 1, u.ENTRY_POINT_V0_8)).toBe(V.h08);
    expect(u.userOpHashV08(vectorOp(V.paymasterAndData, u.EIP7702_INIT_CODE_MARKER), 1, { eip7702Delegate: u.SIMPLE_7702_ACCOUNT_V0_8 })).toBe(V.h08Auth);
    expect(u.userOpHashV08(vectorOp(V.paymasterAndData, u.EIP7702_INIT_CODE_MARKER), 1)).toBe(V.h08Marker);
    const v07 = vectorOp('0x6c973ebe80dcd8660841d4356bf15c32460271c9' + V.paymasterAndData.slice(42));
    expect(u.userOpHash(v07, 8453)).toBe(V.h07);
    expect(u.userOpHashFor(v07, 8453, u.ENTRY_POINT_V0_7)).toBe(V.h07);
    expect(() => u.userOpHashFor(v07, 8453, '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789')).toThrow('ERC4337_ENTRY_POINT_UNSUPPORTED');
    // The typed data the owner's wallet signs is exactly the digest's (domain ERC4337/1 on the v0.8 EntryPoint, no entryPoint member).
    const typed = u.entryPointV08TypedData(1, vectorOp());
    expect(typed.domain).toEqual({ name: 'ERC4337', version: '1', chainId: 1, verifyingContract: u.ENTRY_POINT_V0_8 });
    expect(typed.types.PackedUserOperation.map(f => f.name)).toEqual(['sender', 'nonce', 'initCode', 'callData', 'accountGasLimits', 'preVerificationGas', 'gasFees', 'paymasterAndData']);
    expect(() => u.entryPointV08TypedData(1, vectorOp(V.paymasterAndData, u.EIP7702_INIT_CODE_MARKER))).toThrow('ERC4337_INIT_CODE_REFUSED');
  });

  it('accepts only the owner\'s raw ECDSA signature over the v0.8 hash; classifies the owner account by its designator', () => {
    const owner = key(), stranger = key();
    const op = { ...vectorOp(), sender: owner.address };
    expect(u.verifyOwnerUserOpSignatureV08(1, op, owner.sign(u.userOpHashV08(op, 1)))).toBe(true);
    expect(u.verifyOwnerUserOpSignatureV08(1, op, stranger.sign(u.userOpHashV08(op, 1)))).toBe(false);
    // Another chain's or EntryPoint's hash never verifies.
    expect(u.verifyOwnerUserOpSignatureV08(1, op, owner.sign(u.userOpHashV08(op, 8453)))).toBe(false);
    expect(u.ownerAccountKindOfCode('0xef0100' + u.SIMPLE_7702_ACCOUNT_V0_8.slice(2))).toBe('SIMPLE_7702_V0_8');
    expect(u.ownerAccountKindOfCode('0xEF0100' + u.DELEGATOR_IMPLEMENTATION.slice(2).toUpperCase())).toBe('METAMASK_DELEGATOR_V1_3');
    expect(u.ownerAccountKindOfCode('0x')).toBeNull();
    expect(u.ownerAccountKindOfCode('0xef0100' + '1'.repeat(40))).toBeNull();
    expect(u.ownerAccountKindOfCode('0x6080')).toBeNull();
  });

  it('puts the paymaster fields on the bundler wire and reads a paymaster estimate back', () => {
    const op = vectorOp();
    expect(u.toBundlerUserOperationWithPaymaster(op)).toMatchObject({ sender: SENDER, paymaster: c.CIRCLE_PAYMASTER_V08, paymasterVerificationGasLimit: '0x30d40',
      paymasterPostOpGasLimit: '0x3a98', paymasterData: V.paymasterData, callGasLimit: '0x493e0', verificationGasLimit: '0x1d4c0' });
    expect(() => u.toBundlerUserOperationWithPaymaster({ ...op, paymasterAndData: '0x' })).toThrow('ERC4337_PAYMASTER_INVALID');
    expect(() => u.toBundlerUserOperationWithPaymaster({ ...op, initCode: u.EIP7702_INIT_CODE_MARKER })).toThrow('ERC4337_INIT_CODE_REFUSED');
    // The existing owner-paid wire format still refuses any paymaster.
    expect(() => u.toBundlerUserOperation(op)).toThrow('ERC4337_SPONSORED_REFUSED');
    expect(u.bundlerPaymasterGasEstimate({ verificationGasLimit: '0x1', callGasLimit: '0x2', preVerificationGas: '0x3', paymasterVerificationGasLimit: '0x4', paymasterPostOpGasLimit: '0x5' }))
      .toEqual({ verificationGasLimit: 1n, callGasLimit: 2n, preVerificationGas: 3n, paymasterVerificationGasLimit: 4n, paymasterPostOpGasLimit: 5n });
    expect(u.bundlerPaymasterGasEstimate({ verificationGasLimit: '0x1', callGasLimit: '0x2', preVerificationGas: '0x3' })).toMatchObject({ paymasterVerificationGasLimit: 0n });
    expect(() => u.bundlerPaymasterGasEstimate({ verificationGasLimit: '0x0', callGasLimit: '0x2', preVerificationGas: '0x3' })).toThrow('ERC4337_RPC_INVALID');
    const built = u.packedUserOperationWithPaymaster({ sender: SENDER, nonce: 1n, callData: V.single, gas: GAS, paymasterAndData: V.paymasterAndData });
    expect(built.paymasterAndData).toBe(V.paymasterAndData);
    expect(() => u.packedUserOperationWithPaymaster({ sender: SENDER, nonce: 1n, callData: V.single, gas: GAS, paymasterAndData: '0x' })).toThrow('ERC4337_PAYMASTER_INVALID');
  });
});

describe('Circle USDC paymaster encodings and the permit', () => {
  it('pins the paymaster per chain and EntryPoint (no v0.7 paymaster on Ethereum)', () => {
    expect(c.circlePaymasterOf(1, u.ENTRY_POINT_V0_8)).toBe(c.CIRCLE_PAYMASTER_V08);
    expect(c.circlePaymasterOf(1, u.ENTRY_POINT_V0_7)).toBeNull();
    expect(c.circlePaymasterOf(8453, u.ENTRY_POINT_V0_7)).toBe(c.CIRCLE_PAYMASTER_V07);
    expect(c.circlePaymasterOf(42161, u.ENTRY_POINT_V0_8)).toBe(c.CIRCLE_PAYMASTER_V08);
    expect(c.circlePaymasterOf(4663, u.ENTRY_POINT_V0_7)).toBeNull();
    expect(c.circlePinsOf(8453)?.usdc).toBe(USDC_BASE);
    expect(c.circlePaymastersOf(8453)).toEqual([c.CIRCLE_PAYMASTER_V07, c.CIRCLE_PAYMASTER_V08]);
    expect(c.circlePaymastersOf(1)).toEqual([c.CIRCLE_PAYMASTER_V08]);
  });

  it('encodes paymasterData and paymasterAndData exactly as viem\'s encodePacked / toPackedUserOperation, and decodes them strictly', () => {
    expect(c.encodeCirclePaymasterData({ token: USDC_1, permitAmount: 2_500_000n, permitSignature: FAKE_SIG })).toBe(V.paymasterData);
    expect(c.circlePaymasterAndData({ paymaster: c.CIRCLE_PAYMASTER_V08, verificationGasLimit: 200_000n, postOpGasLimit: 15_000n, token: USDC_1, permitAmount: 2_500_000n,
      permitSignature: FAKE_SIG })).toBe(V.paymasterAndData);
    expect(c.decodeCirclePaymasterData(V.paymasterData)).toEqual({ mode: 0, token: USDC_1, permitAmount: 2_500_000n, permitSignature: FAKE_SIG });
    expect(() => c.decodeCirclePaymasterData('0x01' + V.paymasterData.slice(4))).toThrow('CIRCLE_PAYMASTER_DATA_INVALID');
    expect(() => c.decodeCirclePaymasterData(V.paymasterData + '00')).toThrow('CIRCLE_PAYMASTER_DATA_INVALID');
    expect(() => c.decodeCirclePaymasterData(V.paymasterData.slice(0, -2))).toThrow('CIRCLE_PAYMASTER_DATA_INVALID');
    expect(() => c.encodeCirclePaymasterData({ token: USDC_1, permitAmount: 0n, permitSignature: FAKE_SIG })).toThrow('CIRCLE_PERMIT_CAP_INVALID');
    expect(() => c.circlePaymasterAndData({ paymaster: c.CIRCLE_PAYMASTER_V08, verificationGasLimit: 0n, postOpGasLimit: 15_000n, token: USDC_1, permitAmount: 1n,
      permitSignature: FAKE_SIG })).toThrow('CIRCLE_PAYMASTER_GAS_INVALID');
  });

  it('builds the permit Circle\'s paymaster executes: viem\'s digest, the pinned domain, spender = paymaster, the never-expiring deadline', () => {
    const permit = { chainId: 1, token: USDC_1, owner: SENDER, spender: c.CIRCLE_PAYMASTER_V08, value: 2_500_000n, nonce: 7n, deadline: c.CIRCLE_PERMIT_DEADLINE };
    expect(c.permitDigest(permit)).toBe(V.permitDigest);
    expect(c.PERMIT_TYPEHASH).toBe('0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9');
    expect(c.circlePermit({ chainId: 1, entryPoint: u.ENTRY_POINT_V0_8, owner: SENDER, cap: 2_500_000n, nonce: 7n })).toEqual(permit);
    expect(() => c.circlePermit({ chainId: 1, entryPoint: u.ENTRY_POINT_V0_7, owner: SENDER, cap: 1n, nonce: 0n })).toThrow('CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED');
    // Never an unlimited or empty allowance.
    expect(() => c.circlePermit({ chainId: 1, entryPoint: u.ENTRY_POINT_V0_8, owner: SENDER, cap: (1n << 256n) - 1n, nonce: 0n })).toThrow('CIRCLE_PERMIT_CAP_INVALID');
    expect(() => c.circlePermit({ chainId: 1, entryPoint: u.ENTRY_POINT_V0_8, owner: SENDER, cap: 0n, nonce: 0n })).toThrow('CIRCLE_PERMIT_CAP_INVALID');
    const typed = c.permitTypedData(permit);
    expect(typed.domain).toEqual({ name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC_1 });
    expect(typed.message).toEqual({ owner: SENDER, spender: c.CIRCLE_PAYMASTER_V08, value: '2500000', nonce: '7', deadline: ((1n << 256n) - 1n).toString() });
    const owner = key();
    const mine = { ...permit, owner: owner.address };
    expect(c.recoverPermitSigner(mine, owner.sign(c.permitDigest(mine)))).toBe(owner.address);
    // A permit signed for another nonce recovers someone else: FiatToken would revert it.
    expect(c.recoverPermitSigner(mine, owner.sign(c.permitDigest({ ...mine, nonce: 8n })))).not.toBe(owner.address);
    expect(() => c.recoverPermitSigner(mine, '0x1234')).toThrow('CIRCLE_PERMIT_INVALID');
  });

  it('computes the USDC cap with exact integer math (surcharge, margin, a USDC price that only ever raises it), rounded up', () => {
    // 0.001 ETH at $3,000 = $3 → × 1.10 × 1.20 = 3.96 USDC.
    expect(c.circleUsdcWorstCase({ nativeWei: 10n ** 15n, ethUsd: 3_000n * 10n ** 8n })).toBe(3_960_000n);
    // USDC at $0.99 raises it (3.96 / 0.99 = 4); USDC above $1 is counted as $1.
    expect(c.circleUsdcWorstCase({ nativeWei: 10n ** 15n, ethUsd: 3_000n * 10n ** 8n, usdcUsd: 99_000_000n })).toBe(4_000_000n);
    expect(c.circleUsdcWorstCase({ nativeWei: 10n ** 15n, ethUsd: 3_000n * 10n ** 8n, usdcUsd: 101_000_000n })).toBe(3_960_000n);
    // Never rounded in the owner's favour: one wei of gas costs at least one USDC unit.
    expect(c.circleUsdcWorstCase({ nativeWei: 1n, ethUsd: 3_000n * 10n ** 8n })).toBe(1n);
    expect(c.circleUsdcWorstCase({ nativeWei: 0n, ethUsd: 3_000n * 10n ** 8n })).toBe(0n);
    expect(c.circleUsdcWorstCase({ nativeWei: 123_456_789_012_345n, ethUsd: 3_123_45678901n, surchargeBps: 0n, marginBps: 0n }))
      .toBe((123_456_789_012_345n * 3_123_45678901n * 10n ** 6n + 10n ** 26n - 1n) / 10n ** 26n);
    expect(() => c.circleUsdcWorstCase({ nativeWei: 1n, ethUsd: 0n })).toThrow('CIRCLE_PRICE_INVALID');
    expect(c.circleMaxNativeCost(GAS, { verificationGasLimit: 200_000n, postOpGasLimit: 15_000n })).toBe((120_000n + 300_000n + 70_000n + 215_000n) * 3_000_000_000n);
    expect(c.circlePostOpGasLimit(null)).toBe(15_000n);
    expect(c.circlePostOpGasLimit(40_000n)).toBe(40_000n);
    expect(() => c.circlePostOpGasLimit(10n ** 6n)).toThrow('CIRCLE_PAYMASTER_GAS_UNBOUNDED');
  });

  it('decodes the on-chain views it verifies (string, address, uint) strictly', () => {
    expect(c.decodeStringAnswer(hexOf(abiEncode(['bytes'], ['0x' + Buffer.from('USD Coin').toString('hex')])))).toBe('USD Coin');
    expect(c.decodeAddressAnswer('0x' + u.ENTRY_POINT_V0_7.slice(2).padStart(64, '0'))).toBe(u.ENTRY_POINT_V0_7);
    expect(c.decodeUintAnswer('0x' + (7n).toString(16).padStart(64, '0'))).toBe(7n);
    expect(() => c.decodeUintAnswer('0x')).toThrow('CIRCLE_RPC_INVALID');
    expect(c.permitNoncesCall(SENDER)).toBe('0x7ecebe00' + SENDER.slice(2).padStart(64, '0'));
    expect(c.CIRCLE_SELECTORS.entryPoint).toBe('0xb0d691fe');
  });
});

describe('assertCirclePaymasterOperation', () => {
  const owner = key(), stranger = key();
  const base = (input: { chainId: number; kind: u.OwnerAccountKind; signer?: typeof owner; nonce?: bigint; cap?: bigint; signedCap?: bigint; token?: string; paymaster?: string;
    postOp?: bigint; sender?: string; initCode?: string }) => {
    const entryPoint = u.OWNER_ACCOUNT_KINDS[input.kind].entryPoint, pins = c.circlePinsOf(input.chainId)!;
    const paymaster = input.paymaster ?? c.circlePaymasterOf(input.chainId, entryPoint) ?? c.CIRCLE_PAYMASTER_V08;
    const cap = input.cap ?? 2_500_000n;
    const permit = { chainId: input.chainId, token: pins.usdc, owner: owner.address, spender: paymaster, value: input.signedCap ?? cap, nonce: input.nonce ?? 3n,
      deadline: c.CIRCLE_PERMIT_DEADLINE };
    const signature = (input.signer ?? owner).sign(c.permitDigest(permit));
    const op = u.packedUserOperationWithPaymaster({ sender: input.sender ?? owner.address, nonce: 1n, callData: u.ownerAccountCallData(input.kind, TWO_CALLS), gas: GAS,
      paymasterAndData: c.circlePaymasterAndData({ paymaster, verificationGasLimit: 200_000n, postOpGasLimit: input.postOp ?? 15_000n, token: input.token ?? pins.usdc,
        permitAmount: cap, permitSignature: signature }) });
    return { op: { ...op, initCode: input.initCode ?? '0x' }, expect: { chainId: input.chainId, entryPoint, owner: owner.address, accountKind: input.kind, permitCap: input.signedCap ?? cap,
      permitNonce: 3n } };
  };
  it('accepts the owner\'s Circle operation on Base (DeleGator, v0.7) and Ethereum (Simple7702, v0.8)', () => {
    const b = base({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3' });
    expect(c.assertCirclePaymasterOperation(b.op, b.expect)).toMatchObject({ paymaster: c.CIRCLE_PAYMASTER_V07, postOpGasLimit: 15_000n, data: { permitAmount: 2_500_000n } });
    const e = base({ chainId: 1, kind: 'SIMPLE_7702_V0_8' });
    expect(c.assertCirclePaymasterOperation(e.op, e.expect).paymaster).toBe(c.CIRCLE_PAYMASTER_V08);
  });
  it('refuses every deviation with its closed code', () => {
    const refuse = (input: Parameters<typeof base>[0], code: string, patch: Partial<c.CircleOperationExpectation> = {}) => {
      const b = base(input);
      expect(() => c.assertCirclePaymasterOperation(b.op, { ...b.expect, ...patch })).toThrow(code);
    };
    refuse({ chainId: 1, kind: 'METAMASK_DELEGATOR_V1_3' }, 'CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', paymaster: c.CIRCLE_PAYMASTER_V08 }, 'CIRCLE_PAYMASTER_NOT_PINNED');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', paymaster: '0x' + '9'.repeat(40) }, 'CIRCLE_PAYMASTER_NOT_PINNED');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', token: '0x' + '4'.repeat(40) }, 'CIRCLE_PAYMASTER_TOKEN_INVALID');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3' }, 'CIRCLE_PERMIT_AMOUNT_MISMATCH', { permitCap: 2_400_000n });
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', signer: stranger }, 'CIRCLE_PERMIT_INVALID');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3' }, 'CIRCLE_PERMIT_INVALID', { permitNonce: 4n });
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', postOp: 200_000n }, 'CIRCLE_PAYMASTER_GAS_INVALID');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', sender: stranger.address }, 'CIRCLE_OPERATION_SENDER_INVALID');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3', initCode: u.EIP7702_INIT_CODE_MARKER }, 'ERC4337_INIT_CODE_REFUSED');
    refuse({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3' }, 'CIRCLE_CHAIN_UNSUPPORTED', { chainId: 4663 });
    const b = base({ chainId: 8453, kind: 'METAMASK_DELEGATOR_V1_3' });
    expect(() => c.assertCirclePaymasterOperation({ ...b.op, paymasterAndData: '0x' }, b.expect)).toThrow('CIRCLE_PAYMASTER_DATA_INVALID');
    // A Simple7702 call data on a DeleGator account (or the reverse) is not the account's own encoding.
    expect(() => c.assertCirclePaymasterOperation({ ...b.op, callData: u.simple7702CallData(TWO_CALLS) }, b.expect)).toThrow('ERC4337_CALLDATA_INVALID');
  });
});
