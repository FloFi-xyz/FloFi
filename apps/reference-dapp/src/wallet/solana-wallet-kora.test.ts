// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0010 §4: an extension wallet (Phantom, Solflare: Wallet Standard `solana:signTransaction`) signs a Kora transaction in the owner's slot 1;
// FloFi's Wallet Standard client passes the exact bytes both ways and the server's K1 check accepts exactly that. MOCKED keys, no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileMessageV0, createMockedSolanaWallet, fromBase64, koraAta, parseTransaction, serializeMessageV0, toBase64, u64Bytes, unsignedTransactionBytes,
  verifyKoraOwnerSigned, KORA_TOKEN_PROGRAM } from '@defi-workflow-engine/reference-compiler';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('extension wallet behind Pimlico\'s Kora fee payer', () => {
  it('returns the owner\'s slot-1 signature with Kora\'s slot empty, and K1 accepts it', async () => {
    const owner = createMockedSolanaWallet(), kora = createMockedSolanaWallet().owner, payee = createMockedSolanaWallet().owner, recipient = createMockedSolanaWallet().owner;
    const terms = { mechanism: 'PIMLICO_KORA_SPL_FEE' as const, feePayer: kora, paymentAddress: payee, paymentAccount: koraAta(payee, USDC), feeAccount: koraAta(owner.owner, USDC),
      token: { symbol: 'USDC', mint: USDC, decimals: 6 }, amount: '3100', quotedFeeLamports: '10000', quotedAt: '2026-11-13T12:00:00.000Z', nativeWorstCaseLamports: '45000' };
    const transfer = { programId: KORA_TOKEN_PROGRAM, data: Uint8Array.from([12, ...u64Bytes(1_000_000n), 6]), accounts: [{ pubkey: terms.feeAccount, isSigner: false, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: false }, { pubkey: koraAta(recipient, USDC), isSigner: false, isWritable: true }, { pubkey: owner.owner, isSigner: true, isWritable: false }] };
    const payment = { ...transfer, data: Uint8Array.from([12, ...u64Bytes(3100n), 6]), accounts: transfer.accounts.map((a, i) => i === 2 ? { ...a, pubkey: terms.paymentAccount } : a) };
    const message = serializeMessageV0(compileMessageV0(kora, [transfer, payment], payee, {}));
    const unsigned = toBase64(unsignedTransactionBytes(message));
    vi.resetModules();
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const account = { address: owner.owner, chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
    const phantom = { name: 'Phantom', chains: ['solana:mainnet'], accounts: [account], icon: 'data:image/svg+xml;base64,PHN2Zy8+', features: {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { signTransaction: async (input: { transaction: Uint8Array }) => [{ signedTransaction: fromBase64(owner.sign(toBase64(input.transaction)), 2048) }] } } };
    target.addEventListener('wallet-standard:app-ready', event => (event as CustomEvent<{ register(w: unknown): void }>).detail.register(phantom));
    const api = await import('./solana-wallet');
    const session = await api.connectSolanaWallet('Phantom');
    const signed = await api.signWithSolanaWallet(session, unsigned);
    const parsed = parseTransaction(fromBase64(signed, 2048));
    expect(parsed.signatures).toHaveLength(2);
    expect(parsed.signatures[0]!.every(byte => byte === 0)).toBe(true);
    expect(verifyKoraOwnerSigned({ message: toBase64(message), owner: owner.owner, gas: terms }, signed, 'SOLANA_TRANSFER').transaction).toBe(signed);
  });
});
