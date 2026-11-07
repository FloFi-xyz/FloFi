// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: ERC-4337 v0.7 user operations of the owner's own EIP-7702 account, and EIP-5792 batches. The
 * encodings are checked against independent re-derivations of the Solidity sources' layouts (`UserOperationLib`, `EIP7702DeleGatorCore`,
 * ERC-7579 `ExecutionLib`/`ModeLib`): MOCKED evidence of the layouts, not of deployed bytecode.
 */
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import * as u from '../src/erc4337.js';
import * as b from '../src/eip5792.js';
import { abiEncode, bytesOf, hexOf, keccakHex, workflowCallData, type Call, type WorkflowCall } from '../src/erc7710.js';

const CHAIN = 8453;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', WETH = '0x4200000000000000000000000000000000000006';
const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481', POOL = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
function key() {
  const secret = secp256k1.utils.randomSecretKey(), address = hexOf(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12));
  return { address, sign: (digest: string) => { const sig = secp256k1.sign(bytesOf(digest), secret, { prehash: false, format: 'recovered' }); return hexOf(new Uint8Array([...sig.subarray(1), sig[0]! + 27])); } };
}
const owner = key();
const WORKFLOW: readonly WorkflowCall[] = [
  { kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER, amount: 100_000_000n },
  { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: ROUTER, tokenIn: USDC, tokenOut: WETH, fee: 500, amountIn: 100_000_000n, amountOutMinimum: 30_000_000_000_000_000n },
  { kind: 'ERC20_APPROVE', token: WETH, spender: POOL, amount: 30_000_000_000_000_000n },
  { kind: 'AAVE_V3_SUPPLY', pool: POOL, asset: WETH, amount: 30_000_000_000_000_000n },
];
const calls: readonly Call[] = WORKFLOW.map(c => workflowCallData(c, owner.address));
const gas: u.UserOperationGas = { verificationGasLimit: 120_000n, callGasLimit: 650_000n, preVerificationGas: 60_000n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 25_000_000n };
const op = u.packedUserOperation({ sender: owner.address, nonce: u.userOpNonce(u.nonceKeyOf('wfg_test'), 0n), callData: u.batchCallData(calls), gas });

describe('execute(batch) call data', () => {
  it('is ERC-7579 execute(bytes32,bytes) with the batch mode and abi.encode(Execution[])', () => {
    expect(u.EXECUTE_SELECTOR).toBe('0xe9ae5c53');
    expect(u.MODE_BATCH_DEFAULT).toBe('0x0100000000000000000000000000000000000000000000000000000000000000');
    const callData = u.batchCallData(calls);
    // Independent re-encoding: selector ‖ abi.encode(bytes32 mode, bytes abi.encode((address,uint256,bytes)[])).
    const executions = hexOf(abiEncode([{ array: { tuple: ['address', 'uint256', 'bytes'] } }], [calls.map(c => [c.target, c.value, c.data])]));
    expect(callData).toBe('0xe9ae5c53' + hexOf(abiEncode(['bytes32', 'bytes'], [u.MODE_BATCH_DEFAULT, executions])).slice(2));
    expect(u.decodeBatchCallData(callData)).toEqual(calls.map(c => ({ ...c })));
  });
  it('refuses an empty batch, too many calls, a single-mode call and foreign selectors', () => {
    expect(() => u.batchCallData([])).toThrow('ERC4337_BATCH_INVALID');
    expect(() => u.batchCallData(Array.from({ length: 17 }, () => calls[0]!))).toThrow('ERC4337_BATCH_INVALID');
    const single = u.EXECUTE_SELECTOR + hexOf(abiEncode(['bytes32', 'bytes'], [u.MODE_SINGLE_DEFAULT, u.encodeBatchExecutions(calls)])).slice(2);
    expect(() => u.decodeBatchCallData(single)).toThrow('ERC4337_MODE_UNSUPPORTED');
    expect(() => u.decodeBatchCallData('0xa9059cbb' + '00'.repeat(64))).toThrow('ERC4337_CALLDATA_INVALID');
  });
});

describe('PackedUserOperation v0.7', () => {
  it('packs the gas words high ‖ low exactly as UserOperationLib', () => {
    expect(op.accountGasLimits).toBe('0x' + (120_000n).toString(16).padStart(32, '0') + (650_000n).toString(16).padStart(32, '0'));
    expect(op.gasFees).toBe('0x' + (1_000_000n).toString(16).padStart(32, '0') + (25_000_000n).toString(16).padStart(32, '0'));
    expect(u.userOperationGas(op)).toEqual(gas);
    expect(op.initCode).toBe('0x'); expect(op.paymasterAndData).toBe('0x');
    expect(u.maxPrefund(gas)).toBe((120_000n + 650_000n + 60_000n) * 25_000_000n);
  });
  it('computes the EntryPoint userOpHash (keccak(abi.encode(keccak(encode(op)), entryPoint, chainId)))', () => {
    const inner = keccakHex(abiEncode(['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
      [op.sender, op.nonce, keccakHex(bytesOf('0x')), keccakHex(bytesOf(op.callData)), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccakHex(bytesOf('0x'))]));
    expect(u.userOpHash(op, CHAIN)).toBe(keccakHex(abiEncode(['bytes32', 'address', 'uint256'], [inner, u.ENTRY_POINT_V0_7, BigInt(CHAIN)])));
    expect(u.userOpHash(op, 1)).not.toBe(u.userOpHash(op, CHAIN));
  });
  it('refuses a sponsored or factory-bearing operation and absurd gas', () => {
    expect(() => u.assertUserFundedOperation({ ...op, paymasterAndData: '0x' + 'ab'.repeat(52) })).toThrow('ERC4337_SPONSORED_REFUSED');
    expect(() => u.assertUserFundedOperation({ ...op, initCode: '0x1234' })).toThrow('ERC4337_INIT_CODE_REFUSED');
    expect(() => u.assertUserFundedOperation({ ...op, gasFees: u.packUints(30_000_000n, 25_000_000n) })).toThrow('ERC4337_GAS_INVALID');
    expect(() => u.toBundlerUserOperation({ ...op, paymasterAndData: '0x01' })).toThrow('ERC4337_SPONSORED_REFUSED');
    expect(() => u.bundlerGasEstimate({ verificationGasLimit: '0x1', callGasLimit: '0x1', preVerificationGas: '0x1', paymasterPostOpGasLimit: '0x10' })).toThrow('ERC4337_SPONSORED_REFUSED');
  });
  it('unpacks for the bundler and reads an estimate back', () => {
    expect(u.toBundlerUserOperation(op)).toEqual({ sender: owner.address, nonce: '0x' + op.nonce.toString(16), callData: op.callData, callGasLimit: '0x9eb10', verificationGasLimit: '0x1d4c0',
      preVerificationGas: '0xea60', maxFeePerGas: '0x17d7840', maxPriorityFeePerGas: '0xf4240', signature: '0x' });
    expect(u.bundlerGasEstimate({ verificationGasLimit: '0x1d4c0', callGasLimit: '0x9eb10', preVerificationGas: '0xea60' })).toEqual({ verificationGasLimit: 120_000n, callGasLimit: 650_000n, preVerificationGas: 60_000n });
  });
});

describe('the delegator account EIP-712 digest', () => {
  it('hashes the struct with the account domain (verifyingContract = the owner) and the EntryPoint', () => {
    const domain = keccakHex(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [keccakHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), keccakHex('EIP7702StatelessDeleGator'), keccakHex('1'), BigInt(CHAIN), owner.address]));
    const struct = keccakHex(abiEncode(['bytes32', 'address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'address'],
      [u.PACKED_USER_OP_TYPEHASH, op.sender, op.nonce, keccakHex(bytesOf('0x')), keccakHex(bytesOf(op.callData)), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccakHex(bytesOf('0x')), u.ENTRY_POINT_V0_7]));
    expect(u.delegatorUserOpDigest(CHAIN, op)).toBe(keccakHex(new Uint8Array([0x19, 0x01, ...bytesOf(domain), ...bytesOf(struct)])));
    expect(u.PACKED_USER_OP_TYPEHASH).toBe(keccakHex('PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,address entryPoint)'));
    const typed = u.delegatorUserOpTypedData(CHAIN, op);
    expect(typed.domain).toEqual({ name: 'EIP7702StatelessDeleGator', version: '1', chainId: CHAIN, verifyingContract: owner.address });
    expect(typed.message.entryPoint).toBe(u.ENTRY_POINT_V0_7);
    expect(typed.primaryType).toBe('PackedUserOperation');
  });
  it('recovers the owner from the owner signature and nobody else from anything else', () => {
    const signature = owner.sign(u.delegatorUserOpDigest(CHAIN, op));
    expect(u.recoverUserOpSigner(CHAIN, op, signature)).toBe(owner.address);
    expect(u.verifyOwnerUserOpSignature(CHAIN, op, signature)).toBe(true);
    // Another chain, another EntryPoint, one more wei of gas, a changed call: the same signature no longer recovers to the owner.
    expect(u.verifyOwnerUserOpSignature(1, op, signature)).toBe(false);
    expect(u.verifyOwnerUserOpSignature(CHAIN, op, signature, '0x' + '11'.repeat(20))).toBe(false);
    expect(u.verifyOwnerUserOpSignature(CHAIN, { ...op, gasFees: u.packUints(1_000_000n, 25_000_001n) }, signature)).toBe(false);
    const more = u.batchCallData(WORKFLOW.map(c => c.kind === 'AAVE_V3_SUPPLY' ? { ...c, amount: c.amount + 1n } : c).map(c => workflowCallData(c, owner.address)));
    expect(u.verifyOwnerUserOpSignature(CHAIN, { ...op, callData: more }, signature)).toBe(false);
    expect(u.verifyOwnerUserOpSignature(CHAIN, { ...op, nonce: op.nonce + 1n }, signature)).toBe(false);
    // A stranger's signature over the exact digest is not the owner's.
    expect(u.verifyOwnerUserOpSignature(CHAIN, op, key().sign(u.delegatorUserOpDigest(CHAIN, op)))).toBe(false);
    expect(u.verifyOwnerUserOpSignature(CHAIN, op, '0x' + '00'.repeat(65))).toBe(false);
  });
});

describe('nonces and receipts', () => {
  it('composes a 192-bit key and a 64-bit sequence; a distinct key per group', () => {
    const k1 = u.nonceKeyOf('wfg_a'), k2 = u.nonceKeyOf('wfg_b');
    expect(k1).not.toBe(k2); expect(k1 < 1n << 192n).toBe(true);
    expect(u.userOpNonceParts(u.userOpNonce(k1, 7n))).toEqual({ key: k1, sequence: 7n });
    expect(() => u.userOpNonce(k1, 1n << 64n)).toThrow('ERC4337_NONCE_INVALID');
    expect(u.getNonceCall(owner.address, k1)).toBe('0x35567e1a' + owner.address.slice(2).padStart(64, '0') + k1.toString(16).padStart(64, '0'));
    expect(u.decodeGetNonce('0x' + (k1 << 64n | 3n).toString(16).padStart(64, '0'))).toBe(k1 << 64n | 3n);
  });
  it('finds the UserOperationEvent of this operation among a transaction logs and reads the gas the account paid', () => {
    const hash = u.userOpHash(op, CHAIN);
    const topic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
    const logs = [
      { address: u.ENTRY_POINT_V0_7, topics: [u.USER_OPERATION_EVENT_TOPIC, '0x' + 'ee'.repeat(32), topic(owner.address), topic('0x' + '00'.repeat(20))], data: hexOf(abiEncode(['uint256', 'bool', 'uint256', 'uint256'], [1n, true, 1n, 1n])) },
      { address: u.ENTRY_POINT_V0_7, topics: [u.USER_OPERATION_EVENT_TOPIC, hash, topic(owner.address), topic('0x' + '00'.repeat(20))], data: hexOf(abiEncode(['uint256', 'bool', 'uint256', 'uint256'], [op.nonce, false, 123_456_789n, 400_000n])) },
      { address: '0x' + '22'.repeat(20), topics: [u.USER_OPERATION_EVENT_TOPIC, hash, topic(owner.address), topic('0x' + '00'.repeat(20))], data: '0x' },
    ];
    expect(u.userOperationEvent(logs, hash)).toEqual({ userOpHash: hash, sender: owner.address, paymaster: '0x' + '00'.repeat(20), nonce: op.nonce, success: false, actualGasCost: 123_456_789n, actualGasUsed: 400_000n });
    expect(u.userOperationEvent(logs, '0x' + 'dd'.repeat(32))).toBeNull();
    expect(u.bundlerReceipt(null)).toBeNull();
    expect(u.bundlerReceipt({ userOpHash: hash, sender: owner.address, nonce: '0x1', success: true, actualGasCost: '0x10', actualGasUsed: '0x20', receipt: { transactionHash: '0x' + 'ab'.repeat(32), blockNumber: '0x64', logs } }))
      .toMatchObject({ success: true, actualGasCost: 16n, transactionHash: '0x' + 'ab'.repeat(32), blockNumber: 100n });
    expect(() => u.bundlerReceipt({ userOpHash: hash, sender: owner.address, nonce: '0x1', success: 'yes', actualGasCost: '0x10', actualGasUsed: '0x20', receipt: { transactionHash: '0x' + 'ab'.repeat(32), blockNumber: '0x64' } })).toThrow('ERC4337_RPC_INVALID');
  });
});

describe('EIP-5792 batches', () => {
  it('builds an atomic-required request without capabilities and reads capabilities and statuses', () => {
    const request = b.sendCallsRequest(CHAIN, owner.address, calls);
    expect(request).toMatchObject({ version: '2.0.0', chainId: '0x2105', from: owner.address, atomicRequired: true });
    expect(request.calls).toHaveLength(4); expect(request.calls[0]).toEqual({ to: USDC, value: '0x0', data: calls[0]!.data });
    expect('capabilities' in request).toBe(false);
    expect(b.atomicCapability({ '0x2105': { atomic: { status: 'supported' } }, '0x1': { atomic: { status: 'unsupported' } } }, CHAIN)).toBe('supported');
    expect(b.atomicCapability({ '0x2105': { atomic: { status: 'ready' } } }, CHAIN)).toBe('ready');
    expect(b.atomicCapability({ '0x1': { atomic: { status: 'supported' } } }, CHAIN)).toBe('unsupported');
    expect(b.atomicCapability(null, CHAIN)).toBe('unsupported');
    expect(b.sendCallsId({ id: '0x1234' })).toBe('0x1234');
    const status = b.callsStatus({ version: '2.0.0', id: '0x1234', chainId: '0x2105', status: 200, atomic: true, receipts: [{ logs: [], status: '0x1', blockHash: '0x', blockNumber: '0x10', gasUsed: '0x5208', transactionHash: '0x' + 'cd'.repeat(32) }] });
    expect(status).toEqual({ status: 'CONFIRMED', code: 200, atomic: true, receipts: [{ transactionHash: '0x' + 'cd'.repeat(32), success: true, blockNumber: 16n, gasUsed: 21_000n, logs: [] }] });
    expect(b.callsStatus({ status: 100, atomic: true }).status).toBe('PENDING');
    expect(b.callsStatus({ status: 500, atomic: true, receipts: [] }).status).toBe('CHAIN_FAILURE');
    expect(() => b.callsStatus({ status: 200, receipts: [{ transactionHash: 'nope' }] })).toThrow('EIP5792_RESPONSE_INVALID');
  });
});
