// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { erc4337 } from '@defi-workflow-engine/reference-compiler';
import { bundlerRefusal, bundlerRpc, createBundlerClient } from './bundler.ts';
import { readUserFundedConfig } from './config.ts';
import { assertUserFundedSubmission } from './gas-payer.ts';

const OWNER = '0x' + '11'.repeat(20), EXECUTOR = '0x' + 'ee'.repeat(20);
const gas = { verificationGasLimit: 100_000n, callGasLimit: 300_000n, preVerificationGas: 50_000n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n };
const calls = [{ target: '0x' + '22'.repeat(20), value: 0n, data: '0xa9059cbb' + '00'.repeat(64) }];
const op = erc4337.packedUserOperation({ sender: OWNER, nonce: 0n, callData: erc4337.batchCallData(calls), gas, signature: '0x' + 'ab'.repeat(65) });
const fetchDouble = (answers: Record<string, (params: unknown[]) => unknown>) => (async (_url: string | URL | Request, init?: RequestInit) => {
  const { method, params, id } = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
  const answer = answers[method];
  if (!answer) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'method not found' } }));
  try { return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: answer(params) })); }
  catch (cause) { return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: (cause as Error).message } })); }
}) as unknown as typeof fetch;

describe('bundler client', () => {
  const good = { eth_chainId: () => '0x2105', eth_supportedEntryPoints: () => [erc4337.ENTRY_POINT_V0_7], eth_estimateUserOperationGas: () => ({ verificationGasLimit: '0x1', callGasLimit: '0x2', preVerificationGas: '0x3' }),
    eth_sendUserOperation: () => erc4337.userOpHash(op, 8453), eth_getUserOperationReceipt: () => null, eth_getUserOperationByHash: () => null };
  it('verifies the chain and EntryPoint v0.7 before anything, then sends and checks the hash', async () => {
    const client = createBundlerClient(8453, bundlerRpc('https://bundler.example/v1', fetchDouble(good)));
    expect(await client.estimate(op)).toEqual({ verificationGasLimit: 1n, callGasLimit: 2n, preVerificationGas: 3n });
    expect(await client.send(op)).toBe(erc4337.userOpHash(op, 8453));
    expect(await client.receipt('0x' + '00'.repeat(32))).toBeNull();
    expect(await client.known('0x' + '00'.repeat(32))).toBe(false);
  });
  it('refuses another chain, another EntryPoint, a foreign hash, a sponsored operation and forbidden methods', async () => {
    await expect(createBundlerClient(1, bundlerRpc('https://b', fetchDouble(good))).estimate(op)).rejects.toThrow('USER_OPERATION_BUNDLER_CHAIN_MISMATCH');
    await expect(createBundlerClient(8453, bundlerRpc('https://b', fetchDouble({ ...good, eth_supportedEntryPoints: () => ['0x' + '01'.repeat(20)] }))).estimate(op)).rejects.toThrow('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
    await expect(createBundlerClient(8453, bundlerRpc('https://b', fetchDouble({ ...good, eth_sendUserOperation: () => '0x' + 'ff'.repeat(32) }))).send(op)).rejects.toThrow('USER_OPERATION_HASH_MISMATCH');
    await expect(createBundlerClient(8453, bundlerRpc('https://b', fetchDouble(good))).send({ ...op, paymasterAndData: '0x01' })).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
    await expect(createBundlerClient(8453, bundlerRpc('https://b', fetchDouble(good))).send({ ...op, signature: '0x' })).rejects.toThrow('USER_OPERATION_SIGNATURE_INVALID');
    await expect(bundlerRpc('https://b', fetchDouble(good))('eth_sendRawTransaction', [])).rejects.toThrow('USER_OPERATION_RPC_METHOD_FORBIDDEN');
    await expect(bundlerRpc('https://b', (async () => { throw new Error('down'); }) as unknown as typeof fetch)('eth_chainId', [])).rejects.toThrow('USER_OPERATION_BUNDLER_UNAVAILABLE');
  });
  it('maps EntryPoint validation codes to what the owner can act on', () => {
    expect(bundlerRefusal('AA21 didn\'t pay prefund').message).toBe('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
    expect(bundlerRefusal('AA25 invalid account nonce').message).toBe('USER_OPERATION_NONCE_INVALID');
    expect(bundlerRefusal('AA24 signature error').message).toBe('USER_OPERATION_SIGNATURE_INVALID');
    expect(bundlerRefusal('AA20 account not deployed').message).toBe('EVM_ACCOUNT_NOT_UPGRADED');
    expect(bundlerRefusal('AA31 paymaster deposit too low').message).toBe('ERC4337_SPONSORED_REFUSED');
    expect(bundlerRefusal('replacement underpriced').message).toBe('USER_OPERATION_FEE_TOO_LOW');
    expect(bundlerRefusal('x'.repeat(500)).detail).toHaveLength(200);
    const rejected = createBundlerClient(8453, bundlerRpc('https://b', fetchDouble({ ...good, eth_sendUserOperation: () => { throw new Error('AA21 didn\'t pay prefund'); } })));
    return expect(rejected.send(op)).rejects.toThrow('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
  });
});

describe('configuration', () => {
  const base = { FLOFI_USER_FUNDED_EXECUTION: 'enabled', FLOFI_USER_FUNDED_CHAINS: 'eip155:8453,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', FLOFI_BUNDLER_RPC_8453: 'https://bundler.example/base',
    FLOFI_DELEGATION_RPC_8453: 'https://rpc.example/base' };
  it('reads a complete configuration, with the delegation RPC as the read fallback', () => {
    expect(readUserFundedConfig(base)).toMatchObject({ enabled: true, chains: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], bundlers: { 'eip155:8453': 'https://bundler.example/base' },
      rpc: { 'eip155:8453': 'https://rpc.example/base' }, solanaNonceAccounts: false });
    expect(readUserFundedConfig({})).toEqual({ enabled: false, code: 'USER_FUNDED_NOT_ENABLED' });
  });
  it('fails closed on every malformed value', () => {
    const bad = (patch: Record<string, string | undefined>) => (readUserFundedConfig({ ...base, ...patch }) as { reason?: string }).reason;
    expect(bad({ FLOFI_USER_FUNDED_EXECUTION: 'yes' })).toBe('FLOFI_USER_FUNDED_EXECUTION');
    expect(bad({ FLOFI_USER_FUNDED_CHAINS: 'eip155:11155111' })).toBe('FLOFI_USER_FUNDED_CHAINS');
    expect(bad({ FLOFI_USER_FUNDED_CHAINS: 'eip155:1,eip155:1' })).toBe('FLOFI_USER_FUNDED_CHAINS');
    expect(bad({ FLOFI_BUNDLER_RPC_8453: 'http://bundler.example' })).toBe('FLOFI_BUNDLER_RPC_8453');
    expect(bad({ FLOFI_BUNDLER_RPC_8453: 'https://user:pw@bundler.example' })).toBe('FLOFI_BUNDLER_RPC_8453');
    expect(bad({ FLOFI_DELEGATION_RPC_8453: undefined })).toBe('FLOFI_USER_FUNDED_RPC_8453');
    expect(bad({ FLOFI_SOLANA_NONCE_ACCOUNTS: 'maybe' })).toBe('FLOFI_SOLANA_NONCE_ACCOUNTS');
  });
});

describe('gas payer invariant', () => {
  it('accepts only the owner wallet as fee payer, with no sponsorship and no FloFi-controlled address', () => {
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER.toUpperCase().replace('0X', '0x'), sponsorship: '0x', flofiControlled: [EXECUTOR] })).not.toThrow();
    expect(() => assertUserFundedSubmission({ kind: 'EVM_TRANSACTION', feePayer: EXECUTOR, ownerWallet: OWNER, flofiControlled: [EXECUTOR] })).toThrow('EXECUTOR_GAS_PAYER_REFUSED');
    expect(() => assertUserFundedSubmission({ kind: 'EVM_TRANSACTION', feePayer: '0x' + '33'.repeat(20), ownerWallet: OWNER })).toThrow('GAS_PAYER_NOT_OWNER');
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: '0x' + 'ab'.repeat(52) })).toThrow('GAS_SPONSORSHIP_REFUSED');
    expect(() => assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: 'So11111111111111111111111111111111111111112', ownerWallet: 'so11111111111111111111111111111111111111112' })).toThrow('GAS_PAYER_NOT_OWNER');
    expect(() => assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: '', ownerWallet: OWNER })).toThrow('GAS_PAYER_UNKNOWN');
  });
});
