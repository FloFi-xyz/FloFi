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
import { ConversationReviewCard, MATERIAL_STEP_DETAILS, compactNetworkFee, shortAmount, type CompactReviewStep } from './conversation-cards';

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
  // The real value shape (`reviewApprovalValue`): the value already names its token.
  approvals: [{ symbol: 'USDC', value: 'Exactly 2 USDC', spender: 'Uniswap', network: 'Arbitrum One' }], walletRequests: [], providerSteps: [],
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
    expect(compactNetworkFee(review().fees)).toEqual({ estimate: '0.00000123457 ETH', maximum: '0.00000400001 ETH', unreadable: false });
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
  it('a bridge shows its destination in full (review round 2: a shortened address invites look-alike mistakes), and under Technical details', () => {
    const solana = '8xYk2PvDDaGkR9ZnAwzXeVGkXzW1sTdQfWw3mVdKk2P1';
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [step({ action: 'Bridge', networks: 'Arbitrum One → Solana',
      provider: 'Relay', input: '0.0005 WETH', result: '1.9 USDC', minimum: '1.881 USDC', destination: solana })], approvals: [] }), language: 'EN' }));
    expect(visible(html)).toContain('<strong>1. Bridge · Arbitrum One → Solana · Relay</strong>');
    // Not one of the wallets the card knows: the address alone, wrapping allowed.
    expect(visible(html)).toContain(`<div data-wrap="true"><dt>Destination</dt><dd><code>${solana}</code></dd></div>`);
    expect(visible(html)).not.toContain('…k2P1');
    expect(technical(html)).toContain(`<code>${solana}</code>`);
  });
  it('tags the destination "Your wallet" when it is the signing wallet or the step says it is one of the owner\'s wallets', () => {
    const owner = '0x4b212af0a923256961487ae72499ca79f920b3ce', solana = '8xYk2PvDDaGkR9ZnAwzXeVGkXzW1sTdQfWw3mVdKk2P1', checksummed = '0x4B212aF0A923256961487ae72499CA79F920b3Ce';
    const signing = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [step({ action: 'Bridge', destination: checksummed })] }), language: 'EN' }));
    expect(visible(signing)).toContain(`<div data-wrap="true" data-destination-owned="true"><dt>Destination</dt><dd><code>${checksummed}</code><span class="conversation-review-owned"> · Your wallet</span></dd></div>`);
    const told: CompactReviewStep = { ...step({ action: 'Bridge', destination: solana }), destinationOwned: true };
    const owned = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [told] }), language: 'PT' }));
    expect(visible(owned)).toContain(`<code>${solana}</code><span class="conversation-review-owned"> · Sua carteira</span>`);
    // An explicit "not the owner's" wins over a match with the signing wallet.
    const notOwned: CompactReviewStep = { ...step({ action: 'Bridge', destination: owner }), destinationOwned: false };
    expect(visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [notOwned] }), language: 'EN' })))).not.toContain('Your wallet');
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
  it('keeps every warning that is not an evidence caveat visible, info included; only technical caveats move under Technical details', () => {
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ warnings: [
      { severity: 'info', message: 'The route pays the provider in ETH.' },
      { severity: 'blocking', message: 'Liquidity is not available for this amount.' },
      { severity: 'info', message: 'Delivery is quoted, not simulated.', technical: true }] }), language: 'EN' }));
    expect(visible(html)).toContain('<li data-severity="info">The route pays the provider in ETH.</li>');
    expect(visible(html)).toContain('<li data-severity="blocking">Liquidity is not available for this amount.</li>');
    expect(visible(html)).not.toContain('Delivery is quoted, not simulated.');
    expect(technical(html)).toContain('<li data-severity="info">Delivery is quoted, not simulated.</li>');
    expect(technical(html)).not.toContain('The route pays the provider in ETH.');
  });
  it('keeps the material step details visible (health factor, step status, funding, bound amount, token mint); other details stay technical', () => {
    expect(MATERIAL_STEP_DETAILS).toEqual(['Health factor after', 'Step status', 'Funded by', 'Bound amount', 'Token mint', 'Signatures']);
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const details = [{ label: 'Health factor after', value: '2.41' }, { label: 'Step status', value: 'Already completed' }, { label: 'Funded by', value: '100% of the swap’s reconciled output' },
      { label: 'Bound amount', value: '0.001 WETH' }, { label: 'Token mint', value: mint }, { label: 'Route pools', value: 'USDC/WETH 0.05%' }, { label: 'Tick range', value: '-120–120' }];
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [step({ details })] }), language: 'EN' }));
    const top = visible(html);
    expect(top).toContain('<div data-wrap="true" data-detail="Health factor after"><dt>Health factor after</dt><dd>2.41</dd></div>');
    expect(top).toContain('<dt>Step status</dt><dd>Already completed</dd>');
    expect(top).toContain('<dt>Funded by</dt><dd>100% of the swap’s reconciled output</dd>');
    expect(top).toContain('<dt>Bound amount</dt><dd>0.001 WETH</dd>');
    expect(top).toContain(`<dt>Token mint</dt><dd><code>${mint}</code></dd>`);
    for (const moved of ['Route pools', 'Tick range']) { expect(top, moved).not.toContain(moved); expect(technical(html), moved).toContain(moved); }
    const pt = visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [step({ details })] }), language: 'PT' })));
    for (const label of ['<dt>Fator de saúde após</dt>', '<dt>Estado da etapa</dt><dd>Já concluída</dd>', '<dt>Financiada por</dt><dd>100% do resultado reconciliado do swap</dd>',
      '<dt>Valor vinculado</dt>', '<dt>Mint do token</dt>']) expect(pt, label).toContain(label);
  });
  it('a multi-step Review (not a sequence) shows its network fee once, after the steps; a single step keeps it in its block', () => {
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ steps: [step(), step({ number: 2, action: 'Bridge', input: '0.001 WETH',
      networks: 'Arbitrum One → Base', provider: 'Across', result: '0.00099 WETH', minimum: '0.00098 WETH' })] }), language: 'EN' }));
    const top = visible(html);
    expect(top.match(/<dt>Network fee<\/dt>/g)).toHaveLength(1);
    expect(top).toContain('<dl class="conversation-review-compact conversation-review-extra"><div data-shared-fee="true"><dt>Network fee</dt><dd>≈ 0.00000123457 ETH · at most 0.00000400001 ETH</dd></div>');
    expect(top.indexOf('data-shared-fee')).toBeGreaterThan(top.lastIndexOf('</ol>'));
    const single = visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review(), language: 'EN' })));
    expect(single.match(/<dt>Network fee<\/dt>/g)).toHaveLength(1);
    expect(single).not.toContain('data-shared-fee');
  });
  it('an unreadable network-fee amount shows "See Technical details" instead of a sum that leaves it out', () => {
    const fees = [{ label: 'Estimated network fee', value: '0.000001 ETH', treatment: 'ADDITIONAL' as const },
      { label: 'Maximum network fee', value: 'about 4 gwei per unit', treatment: 'CEILING' as const }];
    expect(compactNetworkFee(fees)).toEqual({ estimate: '0.000001 ETH', maximum: null, unreadable: true });
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ fees }), language: 'EN' }));
    expect(visible(html)).toContain('<dt>Network fee</dt><dd>See Technical details</dd>');
    expect(technical(html)).toContain('about 4 gwei per unit');
    expect(visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ fees }), language: 'PT' })))).toContain('<dt>Taxa de rede</dt><dd>Veja os detalhes técnicos</dd>');
  });
  it('shows FloFi\'s fee as a visible line when the route records it; the note and the whole breakdown stay under Technical details', () => {
    const flofiFee = { value: '0.002000000000000001 USDC', note: 'FloFi records this 0.1% fee obligation on the completed workflow.', recorded: true };
    const html = renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ flofiFee }), language: 'EN' }));
    expect(visible(html)).toContain('<div data-flofi-fee="obligation"><dt>FloFi fee</dt><dd title="0.002000000000000001 USDC">0.00200001 USDC</dd></div>');
    expect(visible(html)).not.toContain('FloFi records this 0.1% fee obligation');
    expect(technical(html)).toContain('<div data-treatment="OBLIGATION" data-flofi-fee="obligation"><dt>FloFi fee</dt><dd>0.002000000000000001 USDC<small>FloFi records this 0.1% fee obligation on the completed workflow.</small></dd></div>');
  });
  it('a permission names its token once: the value\'s own symbol is not repeated; a value without it gets the symbol', () => {
    const top = visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review(), language: 'EN' })));
    expect(top).toContain('<dt>Permission</dt><dd>Exactly 2 USDC → Uniswap</dd>');
    expect(top).not.toContain('USDC USDC');
    const unlimited = visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review({ approvals: [
      { symbol: 'WETH', value: 'Unlimited approval', spender: 'Across', network: 'Arbitrum One' }] }), language: 'EN' })));
    expect(unlimited).toContain('<dt>Permission</dt><dd>Unlimited approval WETH → Across</dd>');
  });
});
