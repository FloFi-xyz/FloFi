// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the in-conversation Review's words and the "no worse than confirmed" rule a fresh simulation must meet. */
import { describe, expect, it } from 'vitest';
import { nativeReviewLines } from './review.ts';
import { noWorse, openUntil, publicNativeSession } from './service.ts';
import type { NativeReview, NativeSession } from './session-store.ts';

const OWNER = 'Hx1cS5y3m5sQ2q9C8kz7GtbRZCXzFVxN3NVCBDy2yBx7', RECIPIENT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const transfer: NativeReview = { flow: 'solana-transfer', runId: 'soltx-' + 'a'.repeat(32), commitment: 'c'.repeat(64), expiresAt: '2026-11-26T12:00:60.000Z'.replace(':60', ':59'),
  owner: OWNER, network: 'Solana', action: 'transfer', pay: { symbol: 'SOL', amount: '10000000', decimals: 9 }, receive: null, recipient: RECIPIENT,
  maximumNetworkCostLamports: '2044280', feeToken: null };
const swap: NativeReview = { ...transfer, flow: 'jupiter-swap', runId: 'jup-' + 'b'.repeat(32), action: 'swap', recipient: null, pay: { symbol: 'USDC', amount: '1000000', decimals: 6 },
  receive: { symbol: 'SOL', amount: '6812345', decimals: 9, minimum: '6778283' }, maximumNetworkCostLamports: '10000' };

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native Review', () => {
  it('words a transfer and a swap with FloFi\'s display rule, in both languages', () => {
    expect(nativeReviewLines(transfer, 'EN')).toEqual(['Review: transfer on Solana', 'You send: 0.01 SOL', `To: ${RECIPIENT}`, `From your wallet: ${OWNER}`,
      'Network fee and account deposits, at most: 0.00204428 SOL', 'Valid until 12:00:59 UTC',
      'Nothing is signed or sent yet. Your wallet shows this exact transaction next; only your approval there sends it.']);
    expect(nativeReviewLines(swap, 'PT')).toEqual(expect.arrayContaining(['Revisão: troca na Solana', 'Você paga: 1 USDC', 'Você recebe (estimado): ≈ 0,00681235 SOL',
      'Mínimo recebido: 0,00677828 SOL']));
  });
  it('continues on a fresh simulation only when its terms are no worse than what the owner confirmed', () => {
    expect(noWorse(transfer, { ...transfer, runId: 'soltx-' + 'c'.repeat(32), maximumNetworkCostLamports: '2044280' })).toBe(true);
    expect(noWorse(transfer, { ...transfer, maximumNetworkCostLamports: '2044281' })).toBe(false);
    expect(noWorse(transfer, { ...transfer, recipient: OWNER })).toBe(false);
    expect(noWorse(transfer, { ...transfer, pay: { ...transfer.pay, amount: '10000001' } })).toBe(false);
    expect(noWorse(transfer, { ...transfer, maximumNetworkCostLamports: null, feeToken: { symbol: 'USDC', amount: '1', decimals: 6 } })).toBe(false);
    expect(noWorse(swap, { ...swap, receive: { ...swap.receive!, amount: '6790000', minimum: '6778283' } })).toBe(true);
    // An incoherent fresh quote (its estimate below its own guaranteed minimum) never passes.
    expect(noWorse(swap, { ...swap, receive: { ...swap.receive!, amount: '6000000', minimum: '6778283' } })).toBe(false);
    expect(noWorse(swap, { ...swap, receive: { ...swap.receive!, minimum: '6778282' } })).toBe(false);
    expect(noWorse(swap, { ...swap, receive: { ...swap.receive!, symbol: 'USDT' } })).toBe(false);
    expect(noWorse(swap, { ...swap, owner: RECIPIENT })).toBe(false);
  });
  it('a wallet request already sent stays open while its Review is valid, even past the session\'s validity; afterwards it reads as expired', () => {
    const session = { id: 'nsg_' + 'a'.repeat(26), wallet: 'phantom', state: 'AWAITING_SIGNATURE', expiresAt: '2026-11-26T12:00:00.000Z', outcome: null,
      review: { ...transfer, expiresAt: '2026-11-26T12:00:40.000Z' } } as unknown as NativeSession;
    expect(openUntil(session)).toBe(Date.parse('2026-11-26T12:00:40.000Z'));
    // Past the session's own validity, the request is still out: never "expired, nothing was sent".
    expect(publicNativeSession(session, new Date('2026-11-26T12:00:10.000Z'))).toMatchObject({ state: 'AWAITING_SIGNATURE', outcome: null });
    // Past the Review: a late signature is refused before the flow, so "nothing was sent" is now true.
    expect(publicNativeSession(session, new Date('2026-11-26T12:00:41.000Z'))).toMatchObject({ state: 'ENDED', outcome: { code: 'NATIVE_SESSION_EXPIRED', afterSignature: false } });
    // Any other waiting state ends with the session itself.
    expect(publicNativeSession({ ...session, state: 'REVIEW_READY' }, new Date('2026-11-26T12:00:10.000Z'))).toMatchObject({ state: 'ENDED' });
  });
});
