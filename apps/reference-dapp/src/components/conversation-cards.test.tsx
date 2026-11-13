// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 (owner request: the chat Review was too long): the visible Review is one short block per step — network and
 * provider, Sends, Receives ≈, Minimum, Network fee, Destination — plus permissions and material warnings; exact values, every fee line, FloFi's
 * fee, the quote expiry, limits and evidence caveats are under a closed Technical details disclosure. Amounts shorten in the safe direction.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationReview } from '../domain/conversation-lifecycle';
import { ConversationReviewCard, compactNetworkFee, shortAmount } from './conversation-cards';

const step = (patch: Partial<ConversationReview['steps'][number]> = {}): ConversationReview['steps'][number] => ({
  number: 1, action: 'Swap', input: '2 USDC', pair: 'USDC → ETH', networks: 'Arbitrum One', provider: 'Uniswap', result: '0.001023456789123456 ETH',
  resultLabel: 'Quoted output', minimum: '0.001018339505177839 ETH', slippage: '0.50%', priceImpact: '0.01%', details: [], destination: null, ...patch });
const review = (patch: Partial<ConversationReview> = {}): ConversationReview => ({
  status: 'ready', label: 'Ready', message: 'Ready', canConfirm: true, steps: [step()],
  fees: [{ label: 'Estimated network fee', value: '0.000001234567891234 ETH', treatment: 'ADDITIONAL' },
    { label: 'Maximum network fee', value: '0.000004000000000001 ETH', note: 'Fee ceiling, not an additional charge.', treatment: 'CEILING' },
    { label: 'Route fee total', value: '0.002 USDC', note: 'Included in the quoted output; network fees are separate.', treatment: 'INCLUDED' }],
  limits: [{ label: 'Max slippage', value: '0.50%' }], warnings: [
    { severity: 'attention', message: 'Destination delivery is quoted. The simulation checks the source transactions; delivery and refunds are not simulated.', technical: true },
    { severity: 'attention', message: 'Funds go to an address other than the signing wallet. Confirm it belongs to the intended recipient.' }],
  approvals: [{ symbol: 'USDC', value: 'Exactly 2', spender: 'Uniswap', network: 'Arbitrum One' }], walletRequests: [], providerSteps: [],
  account: '0x4b212af0a923256961487ae72499ca79f920b3ce', network: 'Arbitrum One', expiresAt: Date.UTC(2026, 10, 13, 4, 0), unknown: [], simulationProblem: null,
  sequence: null, totals: { additional: ['0.000001234567891234 ETH'], ceilings: ['0.000004000000000001 ETH'], excludes: [] },
  flofiFee: { value: 'Not charged', note: 'FloFi\'s 0.1% fee per completed workflow is not collected on-chain, and this route records no fee obligation yet.', recorded: false },
  ...patch });
const visible = (html: string) => html.slice(0, html.indexOf('<details'));
const technical = (html: string) => html.slice(html.indexOf('<details'));

describe('BUILD-FLOFI-MAINNET-EXEC-002 compact chat Review', () => {
  it('shortens a minimum and a receipt down, what is sent or paid up, and keeps other text unchanged', () => {
    expect(shortAmount('0.001018339505177839 ETH', 'down')).toBe('0.00101833 ETH');
    expect(shortAmount('0.000004000000000001 ETH', 'up')).toBe('0.00000400001 ETH');
    expect(shortAmount('2 USDC', 'up')).toBe('2 USDC');
    expect(shortAmount('Send 1 USDC to your wallet', 'down')).toBe('Send 1 USDC to your wallet');
    expect(compactNetworkFee(review().fees)).toEqual({ estimate: '0.00000123457 ETH', maximum: '0.00000400001 ETH' });
  });
  it('a swap: one heading line and five short figures visible; exact values, fees, FloFi fee, expiry and caveats under a closed disclosure', () => {
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review(), language: 'EN' }));
    const top = visible(html), rest = technical(html);
    expect(top).toContain('<strong>1. Swap · Arbitrum One · Uniswap</strong>');
    expect(top).toMatch(/<dt>Sends<\/dt><dd title="2 USDC">2 USDC<\/dd>/);
    expect(top).toMatch(/<dt>Receives<\/dt><dd title="0.001023456789123456 ETH">≈ 0.00102345 ETH<\/dd>/);
    expect(top).toMatch(/<dt>Minimum<\/dt><dd title="0.001018339505177839 ETH">0.00101833 ETH<\/dd>/);
    expect(top).toContain('<dt>Network fee</dt><dd>≈ 0.00000123457 ETH · at most 0.00000400001 ETH</dd>');
    // Material: the permission and a recipient warning stay visible; the evidence caveat and the long notes do not.
    expect(top).toContain('<dt>Permission</dt><dd>Exactly 2 USDC → Uniswap</dd>');
    expect(top).toContain('Funds go to an address other than the signing wallet');
    for (const moved of ['Destination delivery is quoted', 'FloFi fee', 'Quote expiry', 'Route fee total', 'Max slippage', 'Estimates from this simulation', 'Fee ceiling'])
      expect(top, moved).not.toContain(moved);
    expect(html).toMatch(/<details class="conversation-review-technical review-block-technical"><summary>Technical details<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    for (const kept of ['0.001023456789123456 ETH', '0.001018339505177839 ETH', 'Quoted output', 'Max slippage', 'Route fee total', 'FloFi fee', 'Quote expiry',
      'Total additional payable costs', 'Destination delivery is quoted', 'Estimates from this simulation, not executed results.']) expect(rest, kept).toContain(kept);
    // The full-precision Expected receipt is the first text of its value (a browser spec compares it with the Simulate panel).
    expect(rest).toMatch(/<dt>Expected receipt<\/dt><dd>0.001023456789123456 ETH<small>Quoted output<\/small><\/dd>/);
  });
  it('a bridge shows its destination shortened, with the full address as its title and under Technical details', () => {
    const solana = '8xYk2PvDDaGkR9ZnAwzXeVGkXzW1sTdQfWw3mVdKk2P1';
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [step({ action: 'Bridge', networks: 'Arbitrum One → Solana',
      provider: 'Relay', input: '0.0005 WETH', result: '1.9 USDC', minimum: '1.881 USDC', destination: solana })], approvals: [] }), language: 'EN' }));
    expect(visible(html)).toContain('<strong>1. Bridge · Arbitrum One → Solana · Relay</strong>');
    expect(visible(html)).toContain(`<dt>Destination</dt><dd title="${solana}"><code>8xYk2P…k2P1</code></dd>`);
    expect(technical(html)).toContain(`<code>${solana}</code>`);
  });
  it('reads in Portuguese', () => {
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review(), language: 'PT' }));
    for (const label of ['<dt>Envia</dt>', '<dt>Recebe</dt>', '<dt>Mínimo</dt>', '<dt>Taxa de rede</dt>', '<dt>Permissão</dt>', '<summary>Detalhes técnicos</summary>', 'no máximo'])
      expect(html, label).toContain(label);
    expect(html).toContain('aria-label="Revisão do fluxo"');
  });
  it('a sequence keeps one item per action with its state and funding; only the current step has figures', () => {
    const sequence = { total: 2, current: 1, finished: false, issue: null, awaitingDelivery: false, steps: [
      { number: 1, action: 'Swap', amount: '2 USDC', detail: null, network: 'Arbitrum One', state: 'CURRENT', delivered: null, funding: null },
      { number: 2, action: 'Bridge', amount: '0.001 WETH', detail: null, network: 'Arbitrum One → Solana', state: 'NEXT', delivered: null,
        funding: { from: 1, bound: null, cap: '0.001 WETH' } }] } as unknown as ConversationReview['sequence'];
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ sequence }), language: 'EN' }));
    expect(html.match(/data-sequence-state=/g)).toHaveLength(2);
    expect(html).toContain('Funded by step 1: spends the smaller of 0.001 WETH and what step 1 actually delivers');
    expect(html).toContain('This workflow runs as 2 separate wallet transactions');
    expect(html.match(/conversation-review-compact"/g)).toHaveLength(1);
  });
});
