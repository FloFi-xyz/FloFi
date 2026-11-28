// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The owner's payment of a FloFi platform fee: the server actions and the EIP-1193 wallet are scripted (offline; nothing is signed, submitted
 * or sent to any network). Each settlement transfer goes begin -> handoff -> eth_sendTransaction (exactly once) -> report; a wallet refusal is a
 * walletFailure, a request that may have reached the network is reported UNKNOWN, and nothing is ever sent twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookHarness } from '../test-utils/hook-harness';
import { payEvmTransfer, usePlatformFeeSettlement } from './platform-fee-settlement';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({
  order: [] as string[], sends: [] as unknown[], provider: null as unknown, record: null as unknown, sendOutcome: null as unknown,
  statuses: [] as unknown[], settle: null as unknown, wallet: null as unknown,
}));
vi.mock('../app/platform-fee-action', () => ({
  platformFeeStatus: vi.fn(async () => ({ ok: true, value: f.statuses.length > 1 ? f.statuses.shift() : f.statuses[0] })),
  platformFeeSettle: vi.fn(async () => { f.order.push('settle'); return f.settle; }),
}));
vi.mock('../app/robinhood-transfer-action', () => ({
  transferStatus: vi.fn(async () => ({ ok: true, value: f.record })),
  transferBegin: vi.fn(async () => { f.order.push('begin'); return { ok: true, value: { record: f.record, transaction: TRANSACTION } }; }),
  transferHandoff: vi.fn(async () => { f.order.push('handoff'); return { ok: true, value: f.record }; }),
  transferReport: vi.fn(async (_id: string, result: { kind: string }) => { f.order.push(`report:${result.kind}`); return { ok: true, value: f.record }; }),
  transferWalletFailure: vi.fn(async (_id: string, diagnostic: { code: string; rejectionCode?: number }) => { f.order.push(`walletFailure:${diagnostic.code}:${diagnostic.rejectionCode}`); return { ok: true, value: f.record }; }),
}));
vi.mock('../app/solana-transfer-action', () => ({ solanaTransferBegin: vi.fn(), solanaTransferStatus: vi.fn(), solanaTransferSubmit: vi.fn(), solanaTransferWalletFailure: vi.fn() }));
vi.mock('./build009-wallet-store', () => ({ useOptionalBuild009Wallet: () => f.wallet, injected: () => f.provider }));
vi.mock('./jupiter-store', () => ({ useOptionalJupiter: () => null }));
vi.mock('../wallet/solana-wallet', () => ({ signWithSolanaWallet: vi.fn() }));
vi.mock('../wallet/flofi-wallet-channel', () => ({ bindFloFiSigning: vi.fn() }));

const OWNER = '0x' + 'a'.repeat(40), RUN = 'bat-' + 'b'.repeat(32), HASH = '0x' + 'c'.repeat(64);
const TRANSACTION = { from: OWNER, to: '0x' + 'd'.repeat(40), value: '0x1', data: '0x', chainId: '0x2105', gas: '0x5208', maxFeePerGas: '0x9', maxPriorityFeePerGas: '0x1', nonce: 5, extra: 'never sent' };
const TRANSFER = { flow: 'base-mainnet-transfer', runId: RUN, chainId: 'eip155:8453', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18, amount: '1', recipient: '0x' + 'e'.repeat(40),
  workflowHash: 'h', workflow: { workflowId: 'flofi-fee-settlement.x.1.0' } };
const reviewed = (attempt: unknown = null) => ({ id: RUN, attempt, authorization: 'commit', review: { commitment: 'commit', account: OWNER, nonce: 5, chain: 'base', transaction: { chainId: '0x2105' } } });
const wallet = { session: async () => ({ account: OWNER, chainId: '0x2105' }), connect: async () => null };

beforeEach(() => {
  f.order = []; f.sends = []; f.record = reviewed(); f.wallet = wallet; f.sendOutcome = { result: HASH };
  f.provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_accounts') return [OWNER];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getTransactionCount') return '0x5';
    if (method === 'eth_sendTransaction') { f.order.push('send'); f.sends.push(params![0]); const o = f.sendOutcome as { result?: string; error?: unknown }; if (o.error) throw o.error; return o.result; }
    throw new Error(`unexpected ${method}`);
  } };
});

describe('payEvmTransfer', () => {
  it('begins, hands off, sends the exact reviewed transaction once and reports its hash', async () => {
    await payEvmTransfer(wallet, TRANSFER);
    expect(f.order).toEqual(['begin', 'handoff', 'send', `report:HASH`]);
    expect(f.sends).toEqual([{ from: OWNER, to: TRANSACTION.to, value: '0x1', data: '0x', chainId: '0x2105', gas: '0x5208', maxFeePerGas: '0x9', maxPriorityFeePerGas: '0x1' }]);
  });
  it('records a wallet refusal as a walletFailure and never reports a hash or sends again', async () => {
    f.sendOutcome = { error: { code: 4001, message: 'User rejected' } };
    await expect(payEvmTransfer(wallet, TRANSFER)).rejects.toThrow('TRANSFER_REJECTED');
    expect(f.order).toEqual(['begin', 'handoff', 'send', 'walletFailure:TRANSFER_REJECTED:4001']);
    expect(f.sends).toHaveLength(1);
  });
  it('reports UNKNOWN when the request may have reached the network, and does not resend', async () => {
    f.sendOutcome = { error: new Error('socket hang up') };
    await expect(payEvmTransfer(wallet, TRANSFER)).rejects.toThrow('TRANSFER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING');
    expect(f.order).toEqual(['begin', 'handoff', 'send', 'report:UNKNOWN']);
    expect(f.sends).toHaveLength(1);
  });
  it('refuses a wallet on another account or chain before preparing anything', async () => {
    await expect(payEvmTransfer({ ...wallet, session: async () => ({ account: '0x' + '9'.repeat(40), chainId: '0x2105' }) }, TRANSFER)).rejects.toThrow('TRANSFER_WRONG_ACCOUNT');
    await expect(payEvmTransfer({ ...wallet, session: async () => ({ account: OWNER, chainId: '0x1' }) }, TRANSFER)).rejects.toThrow('TRANSFER_WRONG_CHAIN');
    expect(f.order).toEqual([]);
  });
  it('only observes a transfer whose attempt already began (never begins or sends it again)', async () => {
    f.record = reviewed({ state: 'PENDING' });
    await payEvmTransfer(wallet, TRANSFER);
    expect(f.order).toEqual([]);
  });
  it('does not touch the wallet when the nonce moved since the Review', async () => {
    f.record = { ...reviewed(), review: { ...reviewed().review, nonce: 4 } };
    await expect(payEvmTransfer(wallet, TRANSFER)).rejects.toThrow(/NONCE/);
    expect(f.sends).toEqual([]);
  });
});

const status = (state: string | null) => ({ policyId: 'p', rateBps: 80, collection: { active: true, code: null }, authorized: null,
  ledger: state ? { state, lines: [], transfers: [], transactions: [], code: null, attention: false } : null });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('usePlatformFeeSettlement', () => {
  it('reads the status, and on pay settles, signs each transfer once, then follows the ledger until COLLECTED', async () => {
    f.statuses = [status('DUE'), status('DUE'), status('COLLECTION_PENDING'), status('COLLECTED')];
    f.settle = { ok: true, value: { state: 'COLLECTION_PENDING', transfers: [TRANSFER] } };
    const host = new HookHarness(), read = () => host.render(() => usePlatformFeeSettlement({ runId: 'run-1' }, { pollMs: 0, maxPolls: 5 }));
    read(); await flush();
    expect(read().status?.ledger?.state).toBe('DUE');
    await read().pay(); await flush();
    expect(f.order).toEqual(['settle', 'begin', 'handoff', 'send', 'report:HASH']);
    expect(read().status?.ledger?.state).toBe('COLLECTED');
    expect(read().busy).toBe(false);
    host.unmount();
  });
  it('shows a closed code and signs nothing when the server refuses the settlement', async () => {
    f.statuses = [status('DUE')];
    f.settle = { ok: false, code: 'PLATFORM_FEE_NOT_DUE' };
    const host = new HookHarness(), read = () => host.render(() => usePlatformFeeSettlement({ runId: 'run-1' }, { pollMs: 0, maxPolls: 1 }));
    read(); await flush(); await read().pay(); await flush();
    expect(read().error).toBe('PLATFORM_FEE_NOT_DUE');
    expect(f.order).toEqual(['settle']);
    host.unmount();
  });
});
