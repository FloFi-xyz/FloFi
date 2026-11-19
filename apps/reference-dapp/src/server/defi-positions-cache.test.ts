// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: after the owner's own position operation lands, the Dashboard (and the chat's position facts) must not keep
 * serving the pre-operation scan for its 30 s cache window. `forgetWalletPositions` drops only a cached scan of THAT wallet that started before the
 * change; a scan started after it, and other wallets' scans, are kept. Offline: the Solana scan of an unconfigured network answers
 * NETWORK_UNAVAILABLE without any read.
 */
import { describe, expect, it } from 'vitest';
import { forgetWalletPositions, readWalletPositions } from './defi-positions';

const SOLANA = { namespace: 'solana' as const, address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' };
const OTHER = { namespace: 'solana' as const, address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' };

describe('the wallet-scoped position scan cache after a position operation', () => {
  it('drops the owner\'s scan that predates the operation, keeps a newer one and other wallets\' scans', async () => {
    const before = Date.now();
    const first = readWalletPositions(SOLANA), other = readWalletPositions(OTHER);
    expect(await first).toEqual([expect.objectContaining({ protocol: 'Orca Whirlpools', status: 'NETWORK_UNAVAILABLE', positions: [] })]);
    await other;
    // Cached: the same read is served again.
    expect(readWalletPositions(SOLANA)).toBe(first);
    // A change that happened BEFORE the cached scan started leaves it (the scan already saw it).
    expect(forgetWalletPositions(SOLANA, before - 1_000)).toBe(false);
    expect(readWalletPositions(SOLANA)).toBe(first);
    // The owner's operation landed after the scan started: that scan is dropped and the next read scans again.
    expect(forgetWalletPositions(SOLANA, Date.now() + 1)).toBe(true);
    const fresh = readWalletPositions(SOLANA);
    expect(fresh).not.toBe(first);
    await fresh;
    expect(readWalletPositions(SOLANA)).toBe(fresh);
    // Another wallet's scan is untouched; nothing cached, or an unreadable time, drops nothing.
    expect(readWalletPositions(OTHER)).toBe(other);
    expect(forgetWalletPositions({ namespace: 'eip155', address: '0x' + '3'.repeat(40) }, Date.now() + 1)).toBe(false);
    expect(forgetWalletPositions(SOLANA, Number.NaN)).toBe(false);
    expect(readWalletPositions(SOLANA)).toBe(fresh);
  });
});
