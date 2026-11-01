// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: Privy signs only after FloFi's server matched the request to its reviewed attempt (or, for a message, to FloFi's
 * own sign-in message), and the providers' error contract holds: a refusal before Privy was asked is that refusal; a cancel in Privy is a
 * rejection (nothing signed); anything else after Privy was asked is unknown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifySigningFailure } from './flofi-signing';

const gate = vi.fn(), messageGate = vi.fn();
vi.mock('../app/flofi-wallet-action', () => ({ floFiSigningGate: (...args: unknown[]) => gate(...args), floFiMessageGate: (...args: unknown[]) => messageGate(...args) }));
const privy = { ready: true, authenticated: true, embedded: [] as { ecosystem: string; address: string; imported: boolean }[], canSign: vi.fn<(ecosystem: string, address: string) => boolean>(() => true),
  signEvmTransaction: vi.fn(), signEvmMessage: vi.fn(), signSolanaTransaction: vi.fn(), signSolanaMessage: vi.fn() };
let current: typeof privy | null = privy;
vi.mock('../accounts/privy-context', async importOriginal => ({ ...await importOriginal<object>(), currentFloFiPrivy: () => current }));
const { requestThroughPrivy } = await import('./flofi-privy-signer');

const OWNER = '0x' + '1'.repeat(40);
const evm = { op: 'evm_sign_transaction' as const, address: OWNER, signing: { flow: 'base-mainnet-transfer', runId: `bat-${'a'.repeat(32)}` },
  tx: { from: OWNER, to: '0x' + '2'.repeat(40), value: '0x1', data: '0x', chainId: '0x2105', nonce: '0x0', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1' } };
const solana = { op: 'solana_sign_transaction' as const, address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', chain: 'solana:mainnet' as const,
  transaction: btoa(String.fromCharCode(1, ...new Array(64).fill(0), 0x80, 1, 0, 0)), signing: { flow: 'jupiter-swap', runId: `jupiter-${'b'.repeat(32)}` } };
const SUMMARY = { flow: 'base-mainnet-transfer', runId: evm.signing.runId, network: 'Base', chain: 'eip155:8453', realFunds: true, action: 'Send', owner: OWNER,
  lines: [{ label: 'You send', value: '0.000000000000000001 ETH' }], expiresAt: null };
const code = async (run: Promise<unknown>) => run.then(() => 'OK', (error: Error) => error.message);

beforeEach(() => { vi.clearAllMocks(); current = privy; privy.ready = true; privy.authenticated = true; privy.embedded = []; privy.canSign.mockImplementation(() => true); });

describe('Privy signing behind the reviewed-attempt gate', () => {
  it('asks the server first and hands Privy exactly the reviewed EIP-1559 fields on the attempt’s chain', async () => {
    gate.mockResolvedValue({ ok: true, value: SUMMARY });
    privy.signEvmTransaction.mockResolvedValue('0x02abcdef');
    await expect(requestThroughPrivy(evm)).resolves.toEqual({ signedTransaction: '0x02abcdef' });
    expect(gate).toHaveBeenCalledWith(evm);
    // Privy's confirmation screen states FloFi's own server summary of the reviewed attempt.
    expect(privy.signEvmTransaction).toHaveBeenCalledWith(OWNER, { to: evm.tx.to, value: '0x1', data: '0x', chainId: 8453, nonce: '0x0', gas: '0x5208',
      maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1' }, { title: 'FloFi reviewed strategy', action: 'Send',
      description: `Base (real funds) · You send: 0.000000000000000001 ETH · FloFi run ${evm.signing.runId}` });
    expect(gate.mock.invocationCallOrder[0]!).toBeLessThan(privy.signEvmTransaction.mock.invocationCallOrder[0]!);
  });
  it('never asks Privy when the server finds no matching Review, and reports that as a refusal before any signature', async () => {
    gate.mockResolvedValue({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_NO_MATCHING_REVIEW');
    expect(await code(requestThroughPrivy(solana))).toBe('FLOFI_WALLET_NO_MATCHING_REVIEW');
    expect(privy.signEvmTransaction).not.toHaveBeenCalled();
    expect(privy.signSolanaTransaction).not.toHaveBeenCalled();
    expect(classifySigningFailure('FLOFI_WALLET_NO_MATCHING_REVIEW')).toBe('refused');
    gate.mockRejectedValue(new Error('network'));
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_REVIEW_UNAVAILABLE');
  });
  it('without a Privy session nothing is asked, and the refusal precedes any signature', async () => {
    privy.authenticated = false;
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_SIGN_IN_REQUIRED');
    current = null;
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_SIGN_IN_REQUIRED');
    expect(gate).not.toHaveBeenCalled();
    expect(classifySigningFailure('FLOFI_WALLET_SIGN_IN_REQUIRED')).toBe('refused');
  });
  it('refuses before the gate (claiming nothing) when this page cannot sign with the wallet: not listed, or not loaded yet', async () => {
    privy.canSign.mockImplementation(() => false);
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_ACCOUNT_MISMATCH');
    privy.embedded = [{ ecosystem: 'solana', address: solana.address, imported: false }];
    expect(await code(requestThroughPrivy(solana))).toBe('FLOFI_WALLET_NOT_READY');
    expect(privy.canSign).toHaveBeenCalledWith('solana', solana.address);
    expect(gate).not.toHaveBeenCalled();
    expect(privy.signEvmTransaction).not.toHaveBeenCalled();
    expect(privy.signSolanaTransaction).not.toHaveBeenCalled();
    expect(classifySigningFailure('FLOFI_WALLET_ACCOUNT_MISMATCH')).toBe('refused');
    expect(classifySigningFailure('FLOFI_WALLET_NOT_READY')).toBe('refused');
  });
  it('a cancel in Privy is a rejection; any other failure after Privy was asked is unknown, never a refusal', async () => {
    gate.mockResolvedValue({ ok: true, value: SUMMARY });
    privy.signEvmTransaction.mockRejectedValueOnce(new Error('User exited the modal'));
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_REJECTED');
    privy.signEvmTransaction.mockRejectedValueOnce(new Error('Request timed out'));
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_SUBMISSION_UNKNOWN');
    privy.signSolanaTransaction.mockRejectedValueOnce(new Error('iframe error'));
    expect(await code(requestThroughPrivy(solana))).toBe('FLOFI_WALLET_SIGNATURE_UNKNOWN');
    expect(classifySigningFailure('FLOFI_WALLET_REJECTED')).toBe('rejected');
    expect(classifySigningFailure('FLOFI_WALLET_SUBMISSION_UNKNOWN')).toBe('unknown');
  });
  it('signs the exact Solana wire transaction it was given and returns Privy’s signed bytes', async () => {
    gate.mockResolvedValue({ ok: true, value: SUMMARY });
    privy.signSolanaTransaction.mockImplementation(async (_address: string, bytes: Uint8Array) => { const signed = bytes.slice(); signed[1] = 7; return signed; });
    const result = await requestThroughPrivy(solana) as { signedTransaction: string };
    const sent = privy.signSolanaTransaction.mock.calls[0]![1] as Uint8Array;
    expect(btoa(String.fromCharCode(...sent))).toBe(solana.transaction);
    expect(atob(result.signedTransaction).charCodeAt(1)).toBe(7);
  });
  it('signs a message only after the server confirmed it is FloFi’s own sign-in message for this wallet', async () => {
    messageGate.mockResolvedValueOnce({ ok: false, code: 'FLOFI_WALLET_MESSAGE_UNSUPPORTED' });
    expect(await code(requestThroughPrivy({ op: 'evm_sign_message', address: OWNER, message: 'Sign this arbitrary text' }))).toBe('FLOFI_WALLET_MESSAGE_UNSUPPORTED');
    expect(privy.signEvmMessage).not.toHaveBeenCalled();
    messageGate.mockResolvedValueOnce({ ok: true, value: null });
    privy.signSolanaMessage.mockResolvedValueOnce(new Uint8Array(64).fill(1));
    await expect(requestThroughPrivy({ op: 'solana_sign_message', address: solana.address, message: 'hello' })).resolves.toEqual({ signature: '01'.repeat(64) });
    expect(messageGate).toHaveBeenLastCalledWith('solana', solana.address, 'hello');
  });
});

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 Privy confirmation text', () => {
  it('states the Review deadline from FloFi\'s server summary, and nothing when there is none', async () => {
    const { privyReview } = await import('./flofi-privy-signer');
    expect(privyReview({ ...SUMMARY, flow: 'base-mainnet-transfer', expiresAt: '2026-11-01T12:34:56.000Z' } as Parameters<typeof privyReview>[0]).description)
      .toBe('Base (real funds) · Confirm before 12:34:56 UTC · You send: 0.000000000000000001 ETH · FloFi run ' + evm.signing.runId);
    expect(privyReview(SUMMARY as Parameters<typeof privyReview>[0]).description).not.toMatch(/Confirm before/);
  });
});
