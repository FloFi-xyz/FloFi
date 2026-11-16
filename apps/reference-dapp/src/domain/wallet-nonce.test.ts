// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { classifyWalletNonce, observeWalletNonce, refusalNote, reviewNonceRefusal, WALLET_NONCE_COPY, WALLET_NONCE_MAX_READS, WALLET_NONCE_REFUSAL, walletNonceMessage, walletNonceQuantity, walletNonceRefusal } from './wallet-nonce';
import { simulationError } from './simulation-presentation';
import { translate } from '../i18n/locale';

const noSleep = () => Promise.resolve();
const reads = (...values: unknown[]) => { const queue = [...values]; return vi.fn(async () => queue.length > 1 ? queue.shift() : queue[0]); };

describe('wallet nonce classification (Incident A)', () => {
  it('parses only canonical quantities (or a safe integer) and never coerces', () => {
    expect(walletNonceQuantity('0x10')).toBe(16n);
    expect(walletNonceQuantity('0x0')).toBe(0n);
    expect(walletNonceQuantity(17)).toBe(17n);
    for (const bad of ['16', '0x', '0xzz', '0x0010', '0x00', '0x' + 'f'.repeat(17), -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined, {}, ['0x1']]) expect(walletNonceQuantity(bad)).toBeNull();
  });
  it('classifies aligned, lagging, ahead and unreadable wallet answers against the reviewed nonce', () => {
    expect(classifyWalletNonce(16n, '0x10')).toEqual({ relation: 'ALIGNED', wallet: 16n });
    expect(classifyWalletNonce(16n, '0xf')).toEqual({ relation: 'WALLET_BEHIND', wallet: 15n });
    expect(classifyWalletNonce(16n, '0x11')).toEqual({ relation: 'WALLET_AHEAD', wallet: 17n });
    expect(classifyWalletNonce(16n, 'nope')).toEqual({ relation: 'INVALID', wallet: null });
  });

  it('EOA with aligned latest and pending: one read, no wait, the send may proceed', async () => {
    const read = reads('0x10'), sleep = vi.fn(noSleep);
    expect(await observeWalletNonce({ reviewed: 16n, read, sleep })).toEqual({ reviewed: '16', wallet: '16', relation: 'ALIGNED', reads: 1 });
    expect(read).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });
  it('a lagging wallet view (Aave confirmed just before the bridge) is re-read and proceeds once it catches up', async () => {
    const read = reads('0xf', '0x10'), stillCurrent = vi.fn();
    expect(await observeWalletNonce({ reviewed: 16n, read, sleep: noSleep, stillCurrent })).toEqual({ reviewed: '16', wallet: '16', relation: 'ALIGNED', reads: 2 });
    expect(stillCurrent).toHaveBeenCalledTimes(1);
  });
  it('a wallet view that never catches up stays refused after the bounded reads (never sent with a different nonce)', async () => {
    const read = reads('0xf');
    const evidence = await observeWalletNonce({ reviewed: 16n, read, sleep: noSleep });
    expect(evidence).toEqual({ reviewed: '16', wallet: '15', relation: 'WALLET_BEHIND', reads: WALLET_NONCE_MAX_READS });
    expect(read).toHaveBeenCalledTimes(WALLET_NONCE_MAX_READS);
    expect(walletNonceRefusal('UNIVERSAL', evidence)).toBe('UNIVERSAL_WALLET_NONCE_BEHIND');
  });
  it('a wallet holding another pending transaction (count ahead) is never waited out or skipped ahead', async () => {
    const read = reads('0x11', '0x10'), sleep = vi.fn(noSleep);
    const evidence = await observeWalletNonce({ reviewed: 16n, read, sleep });
    expect(evidence.relation).toBe('WALLET_AHEAD'); expect(read).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    expect(walletNonceRefusal('UNIVERSAL', evidence)).toBe('UNIVERSAL_WALLET_NONCE_AHEAD');
  });
  it('an unreadable answer fails closed with the flow’s historical code', async () => {
    const evidence = await observeWalletNonce({ reviewed: 16n, read: reads(null), sleep: noSleep });
    expect(evidence).toMatchObject({ relation: 'INVALID', wallet: null, reads: 1 });
    expect(walletNonceRefusal('UNIVERSAL', evidence)).toBe('UNIVERSAL_WALLET_NONCE_MISMATCH');
    expect(walletNonceRefusal('ROUTER', evidence, 'RESPONSE_INVALID')).toBe('ROUTER_WALLET_NONCE_RESPONSE_INVALID');
    expect(walletNonceRefusal('ROUTER', { relation: 'ALIGNED' })).toBeNull();
  });
  it('stops waiting the moment the run, workflow or wallet changes (the session check throws its own code)', async () => {
    const read = reads('0xf', '0x10');
    await expect(observeWalletNonce({ reviewed: 16n, read, sleep: noSleep, stillCurrent: () => { throw new Error('UNIVERSAL_WRONG_OWNER'); } })).rejects.toThrow('UNIVERSAL_WRONG_OWNER');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('caps the number of reads even when a caller asks for more', async () => {
    const read = reads('0x1');
    expect((await observeWalletNonce({ reviewed: 9n, read, sleep: noSleep, maxReads: 50 })).reads).toBe(WALLET_NONCE_MAX_READS);
  });

  it('words each refusal plainly, says nothing was sent, and keeps only FloFi’s own chain change as "another transaction took the slot"', () => {
    for (const code of ['UNIVERSAL_WALLET_NONCE_BEHIND', 'ROUTER_WALLET_NONCE_AHEAD', 'SUPPLY_WALLET_NONCE_MISMATCH', 'UNISWAP_WALLET_NONCE_RESPONSE_INVALID', 'TRANSFER_WALLET_NONCE_MISMATCH']) {
      expect(WALLET_NONCE_REFUSAL.test(code)).toBe(true);
      const text = simulationError(code);
      expect(text).toBe(walletNonceMessage(code)); expect(text).toMatch(/nothing was sent|No transaction was sent/); expect(text).not.toMatch(/nonce|[0-9]/i);
      expect(translate('PT', text)).not.toBe(text);
    }
    expect(simulationError('UNIVERSAL_WALLET_NONCE_MISMATCH')).toBe('Your wallet and the network reported different transaction numbers. No transaction was sent by FloFi. Check pending wallet transactions, then refresh and review this step again.');
    expect(simulationError('UNIVERSAL_NONCE_CHANGED')).toMatch(/Another transaction from this wallet took the next transaction slot/);
    expect(walletNonceMessage('UNIVERSAL_NONCE_CHANGED')).toBeNull();
  });
  it('review fixes: unreadable answers have their own sentence; Review-nonce flows word a higher count neutrally; refusals are named from their code', () => {
    expect(walletNonceMessage('TRANSFER_WALLET_NONCE_RESPONSE_INVALID')).toBe(WALLET_NONCE_COPY.INVALID);
    expect(translate('PT', WALLET_NONCE_COPY.INVALID)).not.toBe(WALLET_NONCE_COPY.INVALID);
    expect(reviewNonceRefusal('TRANSFER', { relation: 'WALLET_AHEAD' }, 'RESPONSE_INVALID')).toBe('TRANSFER_WALLET_NONCE_MISMATCH');
    expect(reviewNonceRefusal('TRANSFER', { relation: 'INVALID' }, 'RESPONSE_INVALID')).toBe('TRANSFER_WALLET_NONCE_RESPONSE_INVALID');
    expect(reviewNonceRefusal('SUPPLY', { relation: 'WALLET_BEHIND' })).toBe('SUPPLY_WALLET_NONCE_BEHIND');
    expect(reviewNonceRefusal('SUPPLY', { relation: 'ALIGNED' })).toBeNull();
    expect([refusalNote('ROUTER', 4001), refusalNote('UNIVERSAL', 4100), refusalNote('UNIVERSAL', 4200)]).toEqual(['ROUTER_REJECTED', 'UNIVERSAL_WALLET_UNAUTHORIZED', 'UNIVERSAL_WALLET_METHOD_UNSUPPORTED']);
  });
  it('Incident B: a single swap short of ETH says the real limitation (no USDC fee for a single swap yet) and keeps the Insufficient balance title', async () => {
    const { simulationStatusPresentation } = await import('./simulation-presentation');
    const text = simulationError('INSUFFICIENT_GAS_FUNDS');
    expect(text).toMatch(/^Add funds for the network fee, then simulate again\. This swap pays its network fee in ETH/);
    expect(text).toMatch(/not available for a single swap yet, so nothing was signed/);
    expect(simulationStatusPresentation({ status: 'blocked', message: text, expiresAt: null, steps: [], fees: [], warnings: [] }).label).toBe('Insufficient balance');
    expect(translate('PT', text)).toMatch(/^Adicione fundos/);
    // Other native shortfalls keep their existing sentence.
    expect(simulationError('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE')).toBe('Add funds for the network fee, then simulate again.');
  });
});
