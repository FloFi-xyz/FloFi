// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review UX6 (ADR-0010 §4, §6): a Solana network fee paid in USDC/USDT through Pimlico's Kora fee payer
 * says who is paid, in which token, where the owner reads the fee — the Canvas Review's "Network fee, at most" row and the compact chat card's
 * "Network fee" row — not only under Technical details. A native fee keeps its own words. Rendering only.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from '../domain/editor';
import type { SimulationSource } from '../domain/simulation-presentation';
import type { ReviewAuthorization, ReviewWallet } from '../domain/review-presentation';
import type { ConversationReview } from '../domain/conversation-lifecycle';
import { paidToPimlicoNote } from '../domain/gas-payment';
import { LocaleProvider, type Language } from '../i18n/locale';
import { ReviewSummaryPanel } from './review-summary-panel';
import { ConversationReviewCard } from './conversation-cards';

const context = createBaseSepoliaReviewContext();
const workflow = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '100', slippage: '50', source: 'CHAT', baseRevision: 0 }, context).workflow;
const authorization: ReviewAuthorization = { key: 'review-key', manifest: null, owner: null, chain: null, ready: true, accepted: false, approve: () => undefined, approvals: [],
  tokens: [], limits: [], technical: null };
const wallet: ReviewWallet = { account: 'Owner11111111111111111111111111111111111111', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', environment: 'mainnet', changed: false };
const gas = (symbol: 'USDC' | 'USDT') => ({ mechanism: 'PIMLICO_KORA_SPL_FEE', feePayer: 'KoraFeePayer1111111111111111111111111111111',
  paymentAddress: 'KoraPayment11111111111111111111111111111111', amount: '3100', token: { symbol, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } });
/** A Jupiter swap reviewed with Pimlico's Kora fee payer (the owner repays the fee in `symbol`), or with the owner's own SOL (no `symbol`). */
const snapshot = (kind: SimulationSource['kind'], state: object): SimulationSource => ({ kind, state: { busy: false, error: null, retired: false, ...state } }) as SimulationSource;
const jupiter = (symbol: 'USDC' | 'USDT' | null): SimulationSource => snapshot('solana-swap', { record: {
  provenance: 'PUBLIC_MAINNET', error: null, verdict: 'PENDING', review: { format: 'gryloo.jupiter-review.v1', workflow, expiresAt: '2999-01-01T00:00:00.000Z', cluster: 'mainnet-beta',
    input: { symbol: 'USDC', decimals: 6 }, output: { symbol: 'SOL', decimals: 9 }, slippageBps: 50,
    quote: { otherAmountThreshold: '95000000', outAmount: '100000000', priceImpactPct: '0', routePlan: [] }, estimatedFeeLamports: '10000',
    simulationResult: { inputSpent: '10000000', outputReceived: '100000000', accountCreationLamports: '0', feeLamports: '10000' }, ...symbol ? { gas: gas(symbol) } : {} } } });
const panel = (source: SimulationSource, language: Language = 'EN') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}>
  <ReviewSummaryPanel workflow={workflow} context={context} source={source} authorization={authorization} wallet={wallet} technical={<p>SUMMARY</p>}/></LocaleProvider>);
const visible = (html: string) => html.slice(0, html.indexOf('<details'));

describe('review UX6: the Canvas Review row names Pimlico and the token', () => {
  it('"Network fee, at most 0.0031 USDC" with "Paid from your USDC to Pimlico." beside it, visibly (EN/PT)', () => {
    const shown = visible(panel(jupiter('USDC')));
    expect(shown).toContain('<dt>Network fee, at most</dt><dd><span class="numeric">0.0031 USDC</span><small class="review-block-qualifier">Paid from your USDC to Pimlico.</small></dd>');
    expect(visible(panel(jupiter('USDT'), 'PT'))).toContain('<small class="review-block-qualifier">Paga com os seus USDT à Pimlico.</small>');
  });
  it('a native fee row is unchanged (no qualifier, no Pimlico)', () => {
    const shown = visible(panel(jupiter(null)));
    expect(shown).toContain('<dt>Estimated network fee</dt><dd class="numeric">0.00001 SOL</dd>');
    expect(shown).not.toContain('Pimlico');
  });
  it('only a Kora ceiling note is taken as "who is paid" (never another fee line\'s note)', () => {
    expect(paidToPimlicoNote({ note: 'Paid from your USDC to Pimlico.', treatment: 'CEILING' })).toBe('Paid from your USDC to Pimlico.');
    expect(paidToPimlicoNote({ note: 'Paid from your USDC to Pimlico.', treatment: 'INCLUDED' })).toBeNull();
    expect(paidToPimlicoNote({ note: 'Includes execution and L1 data fees.', treatment: 'CEILING' })).toBeNull();
    expect(paidToPimlicoNote({ treatment: 'CEILING' })).toBeNull();
  });
});

describe('review UX6: the compact chat card\'s network fee names Pimlico and the token', () => {
  const step: ConversationReview['steps'][number] = { number: 1, action: 'Swap', input: '10 USDC', pair: 'USDC → SOL', networks: 'Solana', provider: 'Jupiter',
    result: '0.1 SOL', resultLabel: 'Quoted output', minimum: '0.095 SOL', slippage: '0.50%', priceImpact: '0%', details: [], destination: null };
  const review = (fees: ConversationReview['fees']): ConversationReview => ({ status: 'ready', label: 'Ready', message: 'Ready', canConfirm: true, steps: [step], fees,
    limits: [], warnings: [], approvals: [], walletRequests: [], providerSteps: [], account: null, network: 'Solana', expiresAt: null, unknown: [], simulationProblem: null,
    sequence: null, totals: { additional: [], ceilings: [], excludes: [] }, flofiFee: { value: 'Not charged', note: 'Not charged.', recorded: false } });
  const card = (fees: ConversationReview['fees'], language: 'EN' | 'PT' = 'EN') => visible(renderToStaticMarkup(createElement(ConversationReviewCard, { review: review(fees), language })));
  it('"at most 0.0031 USDC · Paid from your USDC to Pimlico." (EN/PT)', () => {
    const kora = [{ label: 'Network fee', value: '0.0031 USDC', note: 'Paid from your USDC to Pimlico.', treatment: 'CEILING' as const }];
    expect(card(kora)).toContain('<dt>Network fee</dt><dd>at most 0.0031 USDC · Paid from your USDC to Pimlico.</dd>');
    expect(card(kora, 'PT')).toContain('Paga com os seus USDC à Pimlico.');
  });
  it('a native fee keeps its own words', () => {
    const html = card([{ label: 'Maximum network fee', value: '0.00001 SOL', note: 'Fee ceiling, not an additional charge.', treatment: 'CEILING' }]);
    expect(html).toContain('<dt>Network fee</dt><dd>at most 0.00001 SOL</dd>');
    expect(html).not.toContain('Pimlico');
  });
});
