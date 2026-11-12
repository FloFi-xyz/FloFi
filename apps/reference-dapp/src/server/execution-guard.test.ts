// SPDX-License-Identifier: AGPL-3.0-only
/** All transports below are in-process test doubles. No RPC, wallet, email or public network is contacted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { erc4337 } from '@defi-workflow-engine/reference-compiler';
import { executionRefusal, guardFlowExecution } from './execution-guard.ts';
import { createSolanaRpc } from './solana-rpc.ts';
import { rawTransactionSender } from './managed-wallet-evm.ts';
import { bundlerRpc, createBundlerClient } from '../user-funded/bundler.ts';
import { guarded } from '../delegation/chains.ts';
import { advanceSolanaSubmission, authorizeGroup, prepareGroup, reconcileEvmGroup, relayUserOperation, type UserFundedDeps } from '../user-funded/groups.ts';
import type { WorkflowComposition } from '../engine/strategy-engine.ts';
import type { WorkflowRequirement } from '../delegation/steps.ts';
import { userFundedPass, type UserFundedPassDeps } from '../workflow-runs/user-funded-pass.ts';
import type { RunRecord, WorkflowRunStore } from '../workflow-runs/pg-store.ts';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const OWNER = '0x' + '11'.repeat(20), SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const pause = (value: string | undefined) => vi.stubEnv('FLOFI_EXECUTION_PAUSED', value);

describe('operator execution pause at actual submission boundaries', () => {
  it('keeps existing controls in charge when unset/false, and fails closed for every malformed configured value', () => {
    expect(executionRefusal({})).toBeNull();
    expect(executionRefusal({ FLOFI_EXECUTION_PAUSED: 'false' })).toBeNull();
    expect(executionRefusal({ FLOFI_EXECUTION_PAUSED: 'true' })).toBe('EXECUTION_PAUSED');
    for (const value of ['', 'TRUE', ' true ', '0', 'disabled'])
      expect(executionRefusal({ FLOFI_EXECUTION_PAUSED: value })).toBe('EXECUTION_PAUSE_CONFIGURATION_INVALID');
  });

  it('blocks new flow wallet handoffs while leaving reports, recovery and reconciliation callable', () => {
    const env = { FLOFI_EXECUTION_PAUSED: 'true' };
    for (const method of ['begin', 'beginSwap', 'beginLiquidity', 'handoff', 'submit', 'submitSwap', 'submitLiquidity', 'broadcast'])
      expect(() => guardFlowExecution(method, env)).toThrow('EXECUTION_PAUSED');
    for (const method of ['report', 'walletFailure', 'observe', 'status', 'recover', 'recoverReview', 'reconcile'])
      expect(() => guardFlowExecution(method, env)).not.toThrow();
  });

  it('blocks a cached EVM raw sender after a pause, and resumes only after an explicit valid value', async () => {
    pause(undefined);
    const transport = vi.fn(async () => Response.json({ result: 'fixture-hash' }));
    const send = rawTransactionSender('https://fixture.invalid/rpc', transport as typeof fetch);
    expect(await send('fixture-bytes')).toEqual({ ok: true, result: 'fixture-hash' });
    pause('true');
    await expect(send('fixture-bytes')).rejects.toThrow('EXECUTION_PAUSED');
    pause('typo');
    await expect(send('fixture-bytes')).rejects.toThrow('EXECUTION_PAUSE_CONFIGURATION_INVALID');
    expect(transport).toHaveBeenCalledTimes(1);
    pause('false');
    await send('fixture-bytes');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('checks a queued Solana send when its turn arrives while allowing receipt/status reads', async () => {
    pause('false');
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      sent.push(method);
      if (method === 'getSlot') await waiting;
      return Response.json({ result: method === 'getSignatureStatuses' ? { value: [] } : 'fixture-result' });
    });
    vi.stubGlobal('fetch', fetcher);
    const rpc = createSolanaRpc('https://fixture.invalid/solana', true);
    const read = rpc('getSlot', []), send = rpc('sendTransaction', ['fixture-bytes']);
    pause('true');
    release();
    await read;
    await expect(send).rejects.toThrow('EXECUTION_PAUSED');
    expect(await rpc('getSignatureStatuses', [[]])).toEqual({ value: [] });
    expect(sent).toEqual(['getSlot', 'getSignatureStatuses']);
    pause('false');
    await rpc('sendTransaction', ['fixture-bytes']);
    expect(sent.at(-1)).toBe('sendTransaction');
  });

  it('blocks a cached ERC-4337 client and direct bundler send without blocking known/receipt lookup', async () => {
    pause('false');
    const op = erc4337.packedUserOperation({ sender: OWNER, nonce: 0n, callData: erc4337.batchCallData([{ target: OWNER, value: 0n, data: '0x' }]),
      gas: { verificationGasLimit: 100_000n, callGasLimit: 100_000n, preVerificationGas: 50_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
      signature: '0x' + 'ab'.repeat(65) });
    const sent: string[] = [];
    const rpc = vi.fn(async (method: string) => {
      sent.push(method);
      return method === 'eth_chainId' ? '0x2105' : method === 'eth_supportedEntryPoints' ? [erc4337.ENTRY_POINT_V0_7]
        : method === 'eth_sendUserOperation' ? erc4337.userOpHash(op, 8453) : null;
    });
    const client = createBundlerClient(8453, rpc);
    await client.verify();
    pause('true');
    await expect(client.send(op)).rejects.toThrow('EXECUTION_PAUSED');
    expect(await client.receipt('fixture-hash')).toBeNull();
    expect(await client.known('fixture-hash')).toBe(false);
    expect(sent).not.toContain('eth_sendUserOperation');
    const transport = vi.fn();
    await expect(bundlerRpc('https://fixture.invalid/bundler', transport as typeof fetch)('eth_sendUserOperation', []))
      .rejects.toThrow('EXECUTION_PAUSED');
    expect(transport).not.toHaveBeenCalled();
    pause('false');
    expect(await client.send(op)).toBe(erc4337.userOpHash(op, 8453));
  });

  it('preserves delegated RPC allowlists and observation while blocking an owner-signed Solana send', async () => {
    pause('true');
    const inner = vi.fn(async () => ({ value: [] }));
    const rpc = guarded(SOLANA, 'owner', 'MOCKED', inner).rpc;
    await expect(rpc('sendTransaction', ['fixture-bytes'])).rejects.toThrow('EXECUTION_PAUSED');
    await rpc('getSignatureStatuses', [[]]);
    expect(inner).toHaveBeenCalledTimes(1);
    await expect(guarded('eip155:8453', 'executor', 'MOCKED', inner).rpc('eth_sendRawTransaction', []))
      .rejects.toThrow('DELEGATION_RPC_METHOD_FORBIDDEN');
  });
});

describe('paused grouped runs keep their reconciliation and durable state', () => {
  const deps = (patch: Partial<UserFundedDeps> = {}): UserFundedDeps => ({ chains: [], evm: () => null, bundler: () => null,
    solana: null, jupiter: null, now: () => new Date('2026-11-12T12:00:00Z'), ...patch });

  it('refuses new preparation and signatures but accepts a late report of a wallet batch already sent', async () => {
    pause('true');
    expect(await prepareGroup(deps(), {} as WorkflowComposition, {} as WorkflowRequirement,
      { runId: 'fixture', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: 'eip155:8453', feePayer: OWNER, stepFrom: 0, stepTo: 0 }))
      .toMatchObject({ ok: false, code: 'EXECUTION_PAUSED' });
    expect(authorizeGroup({ kind: 'SOLANA_SIGN_ALL' }, { kind: 'SOLANA_SIGN_ALL', transactions: [] }, OWNER, new Date()))
      .toMatchObject({ ok: false, code: 'EXECUTION_PAUSED' });
    expect(authorizeGroup({ kind: 'EVM_WALLET_BATCH' }, { kind: 'EVM_WALLET_BATCH', batchId: 'fixture-batch' }, OWNER, new Date()))
      .toMatchObject({ ok: true, value: { batchId: 'fixture-batch' } });
  });

  it('continues checking already-known Solana signatures and holds the next unsent group transaction', async () => {
    pause('true');
    const rpc = vi.fn(async () => ({ value: [{ confirmationStatus: 'finalized', err: null }, null] }));
    const prepared = { kind: 'SOLANA_SIGN_ALL' as const, transactions: [{ lastValidBlockHeight: 100 }, { lastValidBlockHeight: 100 }] };
    const authorization = { transactions: [{ signature: 'fixture-first' }, { signature: 'fixture-second' }] };
    expect(await advanceSolanaSubmission(deps({ solana: rpc }), prepared, authorization, 'fixture-owner'))
      .toEqual({ state: 'WAITING', index: 1, code: 'EXECUTION_PAUSED' });
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValueOnce({ value: [{ confirmationStatus: 'finalized', err: null }, { confirmationStatus: 'finalized', err: null }] });
    expect(await advanceSolanaSubmission(deps({ solana: rpc }), prepared, authorization, 'fixture-owner'))
      .toEqual({ state: 'DONE', index: null, code: null });
  });

  it('holds an unknown user operation for retry instead of failing it when its relay is paused', async () => {
    pause('true');
    const send = vi.fn(), receipt = vi.fn(async () => null), known = vi.fn(async () => false);
    // The EntryPoint says the signed nonce is unconsumed (v0.7: `key << 64 | sequence`, sequence 0): the operation never ran, so reconciliation
    // relays the same signed bytes again — and the pause holds that relay (PENDING), never a failure.
    const key = erc4337.nonceKeyOf('wfr_fixture:g0');
    const rpc = vi.fn(async (method: string) => method === 'eth_call' ? '0x' + (key << 64n).toString(16).padStart(64, '0') : null);
    const d = deps({ evm: () => ({ chain: 'eip155:8453', provenance: 'MOCKED', rpc }),
      bundler: () => ({ chainId: 8453, verify: vi.fn(), estimate: vi.fn(), send, receipt, known }) });
    const op = { sender: OWNER, nonce: erc4337.userOpNonce(key, 0n).toString(), callData: '0x', accountGasLimits: '0x' + '00'.repeat(32), preVerificationGas: '0',
      gasFees: '0x' + '00'.repeat(32) };
    const prepared = { kind: 'EVM_USER_OPERATION' as const, group: { chain: 'eip155:8453' }, op };
    expect(await relayUserOperation(d, prepared, {})).toMatchObject({ ok: false, code: 'EXECUTION_PAUSED' });
    expect(await reconcileEvmGroup(d, prepared, { userOpHash: 'fixture-hash' }, {})).toEqual({ status: 'PENDING' });
    expect(receipt).toHaveBeenCalled();
    expect(known).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('eth_call', [{ to: erc4337.ENTRY_POINT_V0_7, data: erc4337.getNonceCall(OWNER, key) }, 'latest']);
    expect(send).not.toHaveBeenCalled();
  });

  it('reconciles a submitted operation from its owner-paid EntryPoint receipt during the pause', async () => {
    pause('true');
    const userOpHash = '0x' + 'cd'.repeat(32), transactionHash = '0x' + 'ef'.repeat(32);
    const addressTopic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
    const event = { address: erc4337.ENTRY_POINT_V0_7,
      topics: [erc4337.USER_OPERATION_EVENT_TOPIC, userOpHash, addressTopic(OWNER), addressTopic('0x' + '0'.repeat(40))],
      data: '0x' + [0n, 1n, 123n, 12n].map(value => value.toString(16).padStart(64, '0')).join('') };
    const rpc = vi.fn(async () => ({ status: '0x1', blockNumber: '0x1', logs: [event] }));
    const send = vi.fn();
    const d = deps({ evm: () => ({ chain: 'eip155:8453', provenance: 'MOCKED', rpc }), bundler: () => ({ chainId: 8453,
      verify: vi.fn(), estimate: vi.fn(), send, receipt: vi.fn(async () => ({ userOpHash, sender: OWNER, nonce: 0n, success: true, actualGasCost: 123n,
        actualGasUsed: 12n, transactionHash, blockNumber: 1n, logs: [], reason: null })), known: vi.fn() }) });
    expect(await reconcileEvmGroup(d, { kind: 'EVM_USER_OPERATION', group: { chain: 'eip155:8453', owner: OWNER, calls: [], steps: [] } },
      { userOpHash }, {})).toMatchObject({ status: 'RECONCILED', transactions: [transactionHash], gasPaid: { payer: OWNER, amount: '123' } });
    expect(rpc).toHaveBeenCalledWith('eth_getTransactionReceipt', [transactionHash]);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps an authorized worker group unchanged and retryable until execution resumes', async () => {
    pause('true');
    const store = { groups: vi.fn(async () => [{ strategy: 'EVM_USER_OPERATION', state: 'AUTHORIZED', groupIndex: 0, stepFrom: 0, stepTo: 0,
      prepared: { kind: 'EVM_USER_OPERATION' }, authorization: {} }]), steps: vi.fn(async () => []), groupTransition: vi.fn(), transition: vi.fn() };
    const run = { runId: 'fixture', state: 'RUNNING', code: null, currentStep: 0, expiresAt: new Date('2026-11-13T12:00:00Z') } as RunRecord;
    const passDeps: UserFundedPassDeps = { store: store as unknown as WorkflowRunStore, userFunded: deps(), now: deps().now, log: vi.fn(), confirmPass: vi.fn() };
    expect(await userFundedPass(passDeps, run)).toMatchObject({ state: 'RUNNING', code: 'EXECUTION_PAUSED', progressed: false, retryMs: 15_000 });
    expect(store.groupTransition).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
  });

  it('holds a newly authorized group after beta revocation, preserving its durable state and receipt observation', async () => {
    pause('false');
    const owner = { namespace: 'eip155' as const, address: OWNER };
    const group = { strategy: 'EVM_USER_OPERATION', chain: 'eip155:8453', feePayer: OWNER, state: 'AUTHORIZED', groupIndex: 0,
      stepFrom: 0, stepTo: 0, prepared: { kind: 'EVM_USER_OPERATION', group: { chain: 'eip155:8453', owner: OWNER } }, authorization: {} };
    const store = { groups: vi.fn(async () => [group]), steps: vi.fn(async () => []), groupTransition: vi.fn(), transition: vi.fn() };
    const run = { runId: 'fixture', owner, state: 'RUNNING', code: null, currentStep: 0, expiresAt: new Date('2026-11-13T12:00:00Z') } as RunRecord;
    const submissionRefusal = vi.fn(async () => 'BETA_ACCESS_REVOKED'), send = vi.fn(), receipt = vi.fn(async () => null);
    const d = deps({ submissionRefusal, evm: () => ({ chain: 'eip155:8453', provenance: 'MOCKED', rpc: vi.fn() }),
      bundler: () => ({ chainId: 8453, verify: vi.fn(), estimate: vi.fn(), send, receipt, known: vi.fn(async () => false) }) });
    const passDeps: UserFundedPassDeps = { store: store as unknown as WorkflowRunStore, userFunded: d, now: d.now, log: vi.fn(), confirmPass: vi.fn() };
    expect(await userFundedPass(passDeps, run)).toMatchObject({ state: 'RUNNING', code: 'BETA_ACCESS_REVOKED', progressed: false });
    expect(submissionRefusal).toHaveBeenCalledWith(owner, owner);
    expect(store.groupTransition).not.toHaveBeenCalled();
    expect(await reconcileEvmGroup(d, { ...group.prepared, kind: 'EVM_USER_OPERATION' }, { userOpHash: 'fixture-hash' }, {}, owner))
      .toEqual({ status: 'PENDING' });
    expect(receipt).toHaveBeenCalledWith('fixture-hash');
    expect(send).not.toHaveBeenCalled();
  });
});
