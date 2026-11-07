// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: what a reconciled bridge delivery contributes to later steps — actual settlement only (never a quote),
 * only when the flow reconciled it, and with its recipient so a run can refuse a delivery to anyone but its own destination wallet.
 */
import { describe, expect, it } from 'vitest';
import { amountsFromOwnerRecord } from './received-amounts.ts';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', BASE = 'eip155:8453';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const record = (patch: Record<string, unknown> = {}) => ({ verdict: 'RECONCILED', received: '24848243',
  review: { recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', route: { sourceChain: BASE, destinationChain: SOLANA, inputAmount: '25000000',
    inputToken: { kind: 'TOKEN', address: USDC_BASE }, outputToken: { kind: 'TOKEN', address: USDC_SOL }, expectedOutput: '24973108', minimumOutput: '24848243' } }, ...patch });

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 bridge delivery facts', () => {
  it('a reconciled EVM → Solana delivery funds later steps with the DELIVERED amount on the destination chain, and names its recipient', () => {
    const facts = amountsFromOwnerRecord(record());
    expect(facts).toMatchObject({ received: [{ asset: `${SOLANA}/token:${USDC_SOL}`, amount: '24848243' }], spent: [{ asset: `${BASE}/erc20:${USDC_BASE}`, amount: '25000000' }],
      recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', recipientChain: SOLANA });
  });
  it('a refunded, divergent or failed bridge delivered nothing a later step may spend (never the quote)', () => {
    for (const verdict of ['REFUNDED', 'DIVERGENT', 'FAILED', 'PENDING']) expect(amountsFromOwnerRecord(record({ verdict })).received).toEqual([]);
    // Without a delivery there is nothing to bind, whatever the route's expected or minimum output was.
    expect(amountsFromOwnerRecord(record({ received: null })).received).toEqual([]);
  });
});
