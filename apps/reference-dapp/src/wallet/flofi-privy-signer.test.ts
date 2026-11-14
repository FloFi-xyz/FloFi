// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: Privy signs only after FloFi's server matched the request to its reviewed attempt (or, for a message, to FloFi's
 * own sign-in message), and the providers' error contract holds: a refusal before Privy was asked is that refusal; a cancel in Privy is a
 * rejection (nothing signed); anything else after Privy was asked is unknown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { classifySigningFailure } from './flofi-signing';

const gate = vi.fn(), messageGate = vi.fn();
vi.mock('../app/flofi-wallet-action', () => ({ floFiSigningGate: (...args: unknown[]) => gate(...args), floFiMessageGate: (...args: unknown[]) => messageGate(...args) }));
const privy = { ready: true, authenticated: true, embedded: [] as { ecosystem: string; address: string; imported: boolean }[], canSign: vi.fn<(ecosystem: string, address: string) => boolean>(() => true),
  signEvmTransaction: vi.fn(), signEvmMessage: vi.fn(), signSolanaTransaction: vi.fn(), signSolanaMessage: vi.fn(), signEvmTypedData: vi.fn(), signEvmAuthorization: vi.fn() };
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
/** Privy's answer: the request's exact EIP-1559 fields (or a patched copy) with a well-formed signature. */
const signedEvm = (patch: Partial<erc7710.Eip1559> = {}) => erc7710.signedEip1559({ chainId: 8453n, nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21_000n,
  to: evm.tx.to, value: 1n, data: '0x', ...patch }, 1, 0x1234n, 0x5678n).raw;
const code = async (run: Promise<unknown>) => run.then(() => 'OK', (error: Error) => error.message);

beforeEach(() => { vi.clearAllMocks(); current = privy; privy.ready = true; privy.authenticated = true; privy.embedded = []; privy.canSign.mockImplementation(() => true); });

describe('Privy signing behind the reviewed-attempt gate', () => {
  it('asks the server first and hands Privy exactly the reviewed EIP-1559 fields on the attempt’s chain', async () => {
    gate.mockResolvedValue({ ok: true, value: SUMMARY });
    privy.signEvmTransaction.mockResolvedValue(signedEvm());
    await expect(requestThroughPrivy(evm)).resolves.toEqual({ signedTransaction: signedEvm() });
    expect(gate).toHaveBeenCalledWith(evm);
    // Privy's confirmation screen states FloFi's own server summary of the reviewed attempt.
    expect(privy.signEvmTransaction).toHaveBeenCalledWith(OWNER, { to: evm.tx.to, value: '0x1', data: '0x', chainId: 8453, nonce: '0x0', gas: '0x5208',
      maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1' }, { title: 'FloFi reviewed strategy', action: 'Send',
      description: `Base (real funds) · You send: 0.000000000000000001 ETH · FloFi run ${evm.signing.runId}` });
    expect(gate.mock.invocationCallOrder[0]!).toBeLessThan(privy.signEvmTransaction.mock.invocationCallOrder[0]!);
  });
  it('drops bytes Privy signed with any field other than the approved one (never broadcast; the outcome is unknown)', async () => {
    gate.mockResolvedValue({ ok: true, value: SUMMARY });
    for (const patch of [{ nonce: 1n }, { maxFeePerGas: 20n }, { maxPriorityFeePerGas: 2n }, { gasLimit: 21_001n }, { chainId: 1n }, { value: 2n }, { to: '0x' + '3'.repeat(40) }]) {
      privy.signEvmTransaction.mockResolvedValueOnce(signedEvm(patch));
      expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_SIGNATURE_UNKNOWN');
    }
    privy.signEvmTransaction.mockResolvedValueOnce('0x02abcdef');
    expect(await code(requestThroughPrivy(evm))).toBe('FLOFI_WALLET_SIGNATURE_UNKNOWN');
    expect(classifySigningFailure('FLOFI_WALLET_SIGNATURE_UNKNOWN')).toBe('unknown');
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
    const deadline = { ...SUMMARY, flow: 'base-mainnet-transfer', expiresAt: '2026-11-01T12:34:56.000Z' } as Parameters<typeof privyReview>[0];
    expect(privyReview(deadline, 0).description)
      .toBe('Base (real funds) · Confirm before 12:34:56 UTC · You send: 0.000000000000000001 ETH · FloFi run ' + evm.signing.runId);
    // In the person's own clock, with its offset (São Paulo is UTC-3; getTimezoneOffset is positive west of UTC).
    expect(privyReview(deadline, 180).description).toMatch(/· Confirm before 09:34:56 UTC-03:00 ·/);
    expect(privyReview(deadline, -330).description).toMatch(/· Confirm before 18:04:56 UTC\+05:30 ·/);
    expect(privyReview(SUMMARY as Parameters<typeof privyReview>[0]).description).not.toMatch(/Confirm before/);
  });
});

describe('typed data (BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: a reviewed 0x Gasless trade or approval)', async () => {
  const { createTestWallet } = await import('../../../../packages/reference-reconciler/test/test-wallet.ts');
  const { eip712 } = await import('@defi-workflow-engine/reference-compiler');
  const wallet = createTestWallet(), stranger = createTestWallet();
  const typedData = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }], Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, domain: { name: 'Global Dollar', version: '1', chainId: 4663,
    verifyingContract: '0x' + '5'.repeat(40) }, primaryType: 'Permit', message: { owner: wallet.address, spender: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    value: '100000000', nonce: 0, deadline: '1800000000' } };
  const request = { op: 'evm_sign_typed_data' as const, address: wallet.address, typedData, signing: { flow: 'robinhood-swap', runId: `rhs-${'c'.repeat(24)}` } };
  const summary = { ...SUMMARY, flow: 'robinhood-swap', runId: request.signing.runId, network: 'Robinhood Chain', chain: 'eip155:4663', action: 'Token approval (signature)',
    lines: [{ label: 'Approve', value: '100 USDG' }] };
  it('asks the server first, then Privy, and returns only this wallet\'s signature of exactly the approved typed data', async () => {
    gate.mockResolvedValue({ ok: true, value: summary });
    const signature = wallet.signDigest(eip712.hashTypedData(typedData));
    privy.signEvmTypedData.mockResolvedValue(signature);
    await expect(requestThroughPrivy(request)).resolves.toEqual({ signature });
    expect(gate).toHaveBeenCalledWith(request);
    expect(privy.signEvmTypedData).toHaveBeenCalledWith(wallet.address, typedData, expect.objectContaining({ action: 'Token approval (signature)' }));
    expect(gate.mock.invocationCallOrder[0]!).toBeLessThan(privy.signEvmTypedData.mock.invocationCallOrder[0]!);
  });
  it('drops a signature by another key, refuses before Privy when the gate refuses, and maps a cancel to a rejection', async () => {
    gate.mockResolvedValue({ ok: true, value: summary });
    privy.signEvmTypedData.mockResolvedValueOnce(stranger.signDigest(eip712.hashTypedData(typedData)));
    expect(await code(requestThroughPrivy(request))).toBe('FLOFI_WALLET_SIGNATURE_UNKNOWN');
    gate.mockResolvedValueOnce({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    privy.signEvmTypedData.mockClear();
    expect(await code(requestThroughPrivy(request))).toBe('FLOFI_WALLET_NO_MATCHING_REVIEW');
    expect(privy.signEvmTypedData).not.toHaveBeenCalled();
    privy.signEvmTypedData.mockRejectedValueOnce(Object.assign(new Error('closed'), { privyErrorCode: 'user_exited_auth_flow' }));
    expect(classifySigningFailure(await code(requestThroughPrivy(request)))).not.toBe('refused');
  });
});

describe('EIP-7702 authorization (owner requirement: FloFi Wallet + Circle, the upgrade inside a Circle-paid group)', async () => {
  const { createTestWallet } = await import('../../../../packages/reference-reconciler/test/test-wallet.ts');
  const { erc4337 } = await import('@defi-workflow-engine/reference-compiler');
  const wallet = createTestWallet(), stranger = createTestWallet();
  const authorization = { chainId: 8453, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: '9' };
  const tuple = { chainId: 8453, address: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: 9n };
  const request = { op: 'evm_sign_authorization' as const, address: wallet.address, authorization, signing: { flow: 'base-circle-gas', runId: `wfr_${'a'.repeat(26)}` } };
  const summary = { ...SUMMARY, flow: 'base-circle-gas', runId: request.signing.runId, action: 'Smart account upgrade (signature)', lines: [{ label: 'Upgrade', value: 'x' }] };
  it('asks the server first (consent and tuple bound there), then Privy with exactly the tuple, and returns only this wallet\'s signature of it', async () => {
    gate.mockResolvedValue({ ok: true, value: summary });
    const signature = wallet.signDigest(erc4337.eip7702AuthorizationHash(tuple));
    privy.signEvmAuthorization.mockResolvedValue(signature);
    await expect(requestThroughPrivy(request)).resolves.toEqual({ signature });
    expect(gate).toHaveBeenCalledWith(request);
    expect(privy.signEvmAuthorization).toHaveBeenCalledWith(wallet.address, { chainId: 8453, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: 9n });
    expect(gate.mock.invocationCallOrder[0]!).toBeLessThan(privy.signEvmAuthorization.mock.invocationCallOrder[0]!);
  });
  it('never asks Privy without the consent the gate requires; drops a signature of another tuple or key (nothing used)', async () => {
    gate.mockResolvedValueOnce({ ok: false, code: 'FLOFI_WALLET_UPGRADE_CONSENT_REQUIRED' });
    expect(await code(requestThroughPrivy(request))).toBe('FLOFI_WALLET_UPGRADE_CONSENT_REQUIRED');
    expect(classifySigningFailure('FLOFI_WALLET_UPGRADE_CONSENT_REQUIRED')).toBe('refused');
    expect(privy.signEvmAuthorization).not.toHaveBeenCalled();
    gate.mockResolvedValue({ ok: true, value: summary });
    for (const signature of [stranger.signDigest(erc4337.eip7702AuthorizationHash(tuple)), wallet.signDigest(erc4337.eip7702AuthorizationHash({ ...tuple, nonce: 10n })),
      wallet.signDigest(erc4337.eip7702AuthorizationHash({ ...tuple, address: '0x' + '12'.repeat(20) }))]) {
      privy.signEvmAuthorization.mockResolvedValueOnce(signature);
      expect(await code(requestThroughPrivy(request))).toBe('FLOFI_WALLET_SIGNATURE_UNKNOWN');
    }
    privy.signEvmAuthorization.mockRejectedValueOnce(Object.assign(new Error('closed'), { privyErrorCode: 'user_exited_auth_flow' }));
    expect(await code(requestThroughPrivy(request))).toBe('FLOFI_WALLET_REJECTED');
  });
});
