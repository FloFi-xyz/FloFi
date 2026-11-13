// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): the bundler transport carries Circle-paid operations on EntryPoint v0.7 or v0.8 — and only
 * those: the method allowlist is unchanged, any other paymaster is refused before the bundler is asked, every call names an EntryPoint the bundler
 * reported, and Circle's paymaster refusals (AA3x) map to what the owner can act on. A JSON-RPC double behind FloFi's own client (no network).
 */
import { describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { BUNDLER_METHODS, bundlerRefusal, circleBundlerRefusal, createBundlerClient } from './bundler.ts';

const OWNER = '0x' + '11'.repeat(20), SIG = '0x' + 'ab'.repeat(65);
const gas = { verificationGasLimit: 100_000n, callGasLimit: 300_000n, preVerificationGas: 50_000n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n };
const calls = [{ target: '0x' + '22'.repeat(20), value: 0n, data: '0xa9059cbb' + '00'.repeat(64) }];
const paymasterAndData = (paymaster: string) => C.circlePaymasterAndData({ paymaster, verificationGasLimit: 200_000n, postOpGasLimit: 15_000n, token: C.circlePinsOf(8453)!.usdc,
  permitAmount: 1_000n, permitSignature: SIG });
const op = (paymaster = C.CIRCLE_PAYMASTER_V08) => erc4337.packedUserOperationWithPaymaster({ sender: OWNER, nonce: 0n, callData: erc4337.simple7702CallData(calls), gas,
  paymasterAndData: paymasterAndData(paymaster), signature: SIG });
function bundler(entryPoints: readonly string[], answers: Record<string, (params: readonly unknown[]) => unknown> = {}) {
  const asked: string[] = [];
  const rpc = async (method: string, params: readonly unknown[]) => {
    asked.push(method);
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_supportedEntryPoints') return [...entryPoints];
    const answer = answers[method];
    if (!answer) throw bundlerRefusal('method not found');
    return answer(params);
  };
  return { client: createBundlerClient(8453, rpc), asked };
}

describe('ADR-0010 bundler transport for Circle-paid operations', () => {
  it('keeps the method allowlist; a v0.8-only bundler serves Circle v0.8 and refuses owner-paid v0.7 operations', async () => {
    expect([...BUNDLER_METHODS].sort()).toEqual(['eth_chainId', 'eth_estimateUserOperationGas', 'eth_getUserOperationByHash', 'eth_getUserOperationReceipt',
      'eth_sendUserOperation', 'eth_supportedEntryPoints']);
    const { client } = bundler([erc4337.ENTRY_POINT_V0_8], {
      eth_estimateUserOperationGas: params => {
        expect(params[1]).toBe(erc4337.ENTRY_POINT_V0_8);
        expect(params[0]).toMatchObject({ paymaster: C.CIRCLE_PAYMASTER_V08, paymasterPostOpGasLimit: '0x3a98' });
        return { verificationGasLimit: '0x1', callGasLimit: '0x2', preVerificationGas: '0x3', paymasterVerificationGasLimit: '0x4', paymasterPostOpGasLimit: '0x5' };
      },
      eth_sendUserOperation: () => erc4337.userOpHashV08(op(), 8453),
    });
    expect(await client.estimateCircle!(op(), erc4337.ENTRY_POINT_V0_8)).toMatchObject({ paymasterVerificationGasLimit: 4n, paymasterPostOpGasLimit: 5n });
    expect(await client.sendCircle!(op(), erc4337.ENTRY_POINT_V0_8)).toBe(erc4337.userOpHashV08(op(), 8453));
    const owner = erc4337.packedUserOperation({ sender: OWNER, nonce: 0n, callData: erc4337.batchCallData(calls), gas });
    await expect(client.estimate(owner)).rejects.toThrow('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
    await expect(client.estimateCircle!(op(C.CIRCLE_PAYMASTER_V07), erc4337.ENTRY_POINT_V0_7)).rejects.toThrow('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
    // A bundler serving neither pinned EntryPoint is refused before anything else.
    await expect(bundler(['0x' + '01'.repeat(20)]).client.estimateCircle!(op(), erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
  });
  it('refuses any other paymaster, or Circle\'s paymaster of the other EntryPoint, before the bundler is asked', async () => {
    const { client, asked } = bundler([erc4337.ENTRY_POINT_V0_7, erc4337.ENTRY_POINT_V0_8]);
    await expect(client.estimateCircle!(op('0x' + '99'.repeat(20)), erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
    await expect(client.sendCircle!(op(C.CIRCLE_PAYMASTER_V07), erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
    await expect(client.sendCircle!({ ...op(), paymasterAndData: '0x' }, erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
    expect(asked.filter(m => m === 'eth_estimateUserOperationGas' || m === 'eth_sendUserOperation')).toEqual([]);
    // The owner-paid path still refuses any paymaster.
    await expect(client.send(op())).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
  });
  it('a foreign hash is refused; Circle\'s paymaster refusals map to what the owner can act on', async () => {
    const { client } = bundler([erc4337.ENTRY_POINT_V0_8], { eth_sendUserOperation: () => '0x' + 'ff'.repeat(32),
      eth_estimateUserOperationGas: () => { throw bundlerRefusal('AA33 reverted: ERC20: transfer amount exceeds balance'); } });
    await expect(client.sendCircle!(op(), erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('USER_OPERATION_HASH_MISMATCH');
    await expect(client.estimateCircle!(op(), erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('CIRCLE_INSUFFICIENT_USDC');
    expect(circleBundlerRefusal(bundlerRefusal('AA33 reverted: EIP2612: invalid signature')).message).toBe('CIRCLE_PERMIT_INVALID');
    expect(circleBundlerRefusal(bundlerRefusal('AA31 paymaster deposit too low')).message).toBe('CIRCLE_PAYMASTER_REFUSED');
    expect(circleBundlerRefusal(bundlerRefusal('AA36 over paymasterVerificationGasLimit')).message).toBe('CIRCLE_PAYMASTER_GAS_INVALID');
    expect(circleBundlerRefusal(bundlerRefusal('AA25 invalid account nonce')).message).toBe('USER_OPERATION_NONCE_INVALID');
    expect(circleBundlerRefusal(new Error('USER_OPERATION_BUNDLER_UNAVAILABLE')).message).toBe('USER_OPERATION_BUNDLER_UNAVAILABLE');
    expect(circleBundlerRefusal(new Error('the provider said no')).message).toBe('USER_OPERATION_REJECTED');
  });
});
