// SPDX-License-Identifier: AGPL-3.0-only
/** P0 approved UX (boards 06–07): the Review / blocker panel is presentation only — no authorize control, the server's own numbers, no codes in copy. */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from '../domain/editor';
import type { SimulationSource } from '../domain/simulation-presentation';
import type { ReviewAuthorization, ReviewWallet } from '../domain/review-presentation';
import type { NativeFeeShortfall } from '../user-funded/groups';
import { ReviewSummaryPanel } from './review-summary-panel';
import { EditorStepper, stepLook } from './editor-stepper';

const context = createBaseSepoliaReviewContext();
const workflow = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50', source: 'CHAT', baseRevision: 0 }, context).workflow;
const authorization: ReviewAuthorization = { key: null, manifest: null, owner: null, chain: null, ready: false, accepted: false, approve: null, approvals: [], tokens: [], limits: [], technical: null };
const wallet: ReviewWallet = { account: '0x90f5' + 'a'.repeat(32) + 'd303', chain: 'eip155:8453', environment: 'mainnet', changed: false };
const blocked = (error: string): SimulationSource => ({ kind: 'unavailable', state: { error, busy: false } });
const render = (source: SimulationSource, feeShortfall: NativeFeeShortfall | null = null) => renderToStaticMarkup(createElement(ReviewSummaryPanel, {
  workflow, context, source, authorization, wallet, feeShortfall, technical: createElement('p', null, 'SUMMARY') }));

describe('blocker panel (board 07)', () => {
  it('states the server numbers for a native-fee shortfall, the address to copy, and keeps the raw code in technical details only', () => {
    const html = render(blocked('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE'), { kind: 'NATIVE_FEE_SHORTFALL', chainId: 'eip155:8453', owner: wallet.account!, unit: 'wei',
      balance: '120000000000000', maxFee: '300000000000001', nativeSpend: '0', required: '300000000000001', shortfall: '180000000000001' });
    expect(html).toContain('Not enough ETH on Base for the network fee');
    expect(html).toContain('0.00012 ETH'); expect(html).toContain('0.000301 ETH'); expect(html).toContain('0.000181 ETH');
    expect(html).toContain('Copy address'); expect(html).toContain('0x90f5…d303');
    const visible = html.replace(/<details[\s\S]*<\/details>/, '');
    expect(visible).not.toMatch(/USER_FUNDED_|BETA_|bps|eip155:/);
    expect(html).toMatch(/<details class="review-panel-technical"><summary>Technical details, for support<\/summary><p class="review-panel-code"><code>USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE<\/code>/);
    expect(html).not.toMatch(/Authorize in wallet|Approve &amp; Continue|data-lifecycle-action/);
  });
  it('names a Flight refusal and links to where it is fixed, never a failed simulation', () => {
    const html = render(blocked('BETA_WALLET_NOT_LINKED'));
    expect(html).toContain('Wallet not linked to your FloFi account');
    expect(html).toContain('href="/app/credentials"'); expect(html).not.toContain('Simulation failed');
  });
  it('without server numbers, states the classified sentence and invents none', () => {
    const html = render(blocked('INSUFFICIENT_GAS_FUNDS'));
    expect(html).toContain('Add funds for the network fee, then simulate again.');
    expect(html).not.toMatch(/You have|The fee can reach|Missing, at least/);
  });
});

describe('Review panel (board 06)', () => {
  it('shows "You are authorizing" without any authorize control; the footer owns the one primary action', () => {
    const html = render({ kind: 'unavailable', state: { error: null, busy: false } });
    expect(html).toContain('You are authorizing'); expect(html).toContain('<details class="review-panel-technical"><summary>Technical details</summary><p>SUMMARY</p>');
    expect(html).not.toMatch(/<button[^>]*class="primary"|Authorize in wallet/);
  });
});

describe('Editor stepper looks (board 03b)', () => {
  it('current, reachable and closed — never done', () => {
    expect([0, 1, 2].map(index => stepLook(index, 1, index === 2))).toEqual(['reachable', 'current', 'closed']);
    const html = renderToStaticMarkup(createElement(EditorStepper, { tab: 'Build', setTab: () => undefined, disabled: true, closedReason: 'Choose the network in the chat first' }));
    expect([...html.matchAll(/data-step-look="([a-z]+)"/g)].map(match => match[1])).toEqual(['current', 'closed', 'closed']);
    expect(html).toContain('title="Choose the network in the chat first"'); expect(html).not.toMatch(/✓|done|completed/i);
  });
});
