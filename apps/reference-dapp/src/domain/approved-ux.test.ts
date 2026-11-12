// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { blockerExplanation, countdown, feeShortfallView, isExplainRequest, nativeAmount, nativeBalance, networkQuestionPending, simulateFooterStatus, walletRequestView } from './approved-ux';
import type { NativeFeeShortfall } from '../user-funded/groups';
import { translate } from '../i18n/locale';
import { firstPlaceholder } from './build-entry';

const evidence: NativeFeeShortfall = { kind: 'NATIVE_FEE_SHORTFALL', chainId: 'eip155:8453', owner: '0x90f5' + 'a'.repeat(32) + 'd303', unit: 'wei',
  balance: '120000000000000', maxFee: '300000000000001', nativeSpend: '0', required: '300000000000001', shortfall: '180000000000001' };

describe('approved UX footer (boards 06–07)', () => {
  const base = { busy: false, status: 'ready' as const, label: 'Ready', expiresAt: 100_000, now: 40_000, executionStarted: false };
  it('counts down the simulation validity, turns to attention under 15 s and says expired at 0', () => {
    expect(countdown(52_000)).toBe('0:52'); expect(countdown(61_400)).toBe('1:02'); expect(countdown(-5)).toBe('0:00');
    expect(simulateFooterStatus(base)).toEqual({ tone: 'ready', text: 'Simulation valid for {0}', parameters: ['1:00'] });
    expect(simulateFooterStatus({ ...base, now: 90_000 })).toMatchObject({ tone: 'attention', parameters: ['0:10'] });
    expect(simulateFooterStatus({ ...base, now: 100_000 })).toEqual({ tone: 'attention', text: 'Expired, simulate again' });
  });
  it('names a blocker and says "Nothing was sent" only while no execution of this workflow started', () => {
    expect(simulateFooterStatus({ ...base, status: 'blocked', label: 'Insufficient balance' })).toEqual({ tone: 'blocked', text: 'Insufficient balance', detail: 'Nothing was sent' });
    expect(simulateFooterStatus({ ...base, status: 'blocked', label: 'Insufficient balance', executionStarted: true })).toEqual({ tone: 'blocked', text: 'Insufficient balance', detail: null });
  });
  it('a running simulation and a pending network question override everything else', () => {
    expect(simulateFooterStatus({ ...base, busy: true })).toEqual({ tone: 'neutral', text: 'Simulating workflow…' });
    expect(simulateFooterStatus({ ...base, networkQuestion: true, status: 'blocked' })).toEqual({ tone: 'attention', text: 'Choose the network in the chat to simulate' });
    expect(simulateFooterStatus({ ...base, expiresAt: null, status: 'attention' })).toBeNull();
  });
});

describe('fee shortfall projection (board 07): the server numbers, never understated', () => {
  it('rounds requirements and shortfalls UP and the balance DOWN, to at most 6 decimals', () => {
    expect(nativeAmount('300000000000001')).toBe('0.000301'); expect(nativeBalance('120000000000999')).toBe('0.00012');
    expect(nativeAmount('1')).toBe('< 0.000001'); expect(nativeBalance('1')).toBe('< 0.000001'); expect(nativeAmount('0')).toBe('0'); expect(nativeAmount('x')).toBe('—');
    expect(feeShortfallView(evidence)).toEqual({ network: 'Base', symbol: 'ETH', owner: evidence.owner, balance: '0.00012', fee: '0.000301', sends: null, required: '0.000301', missing: '0.000181' });
    // A request that also sends native ETH: the fee ceiling is shown on its own, never the fee plus the amount sent.
    const sending = { ...evidence, nativeSpend: '1000000000000000', required: '1300000000000001', shortfall: '1180000000000001' };
    expect(feeShortfallView(sending)).toMatchObject({ fee: '0.000301', sends: '0.001', required: '0.001301', missing: '0.001181' });
    expect(blockerExplanation({ title: 't', message: 'm', feeShortfall: sending })?.parameters).toEqual(['Base', 'ETH', '0x90f5…d303', '0.00012', '0.000301', '0.001181', '0.001']);
    expect(feeShortfallView({ ...evidence, chainId: 'eip155:999' })).toBeNull(); expect(feeShortfallView(null)).toBeNull();
  });
});

describe('the assistant explains the active blocker (board 07)', () => {
  it('recognizes vague requests in English and Portuguese, alone or combined, and nothing else', () => {
    for (const text of ['explain', 'Why?', 'why', 'não entendi', 'me explique melhor', 'me explique melhor, nao entendi', 'Por quê?', 'O que aconteceu?', 'explain better!'])
      expect(isExplainRequest(text), text).toBe(true);
    for (const text of ['swap 2 usdc for eth', 'explain the fee and then add a bridge to arbitrum please', 'yes', 'simular de novo', '', 'why did my swap on base fail yesterday'])
      expect(isExplainRequest(text), text).toBe(false);
  });
  it('states the same three numbers and the next action, in the interface language', () => {
    const facts = blockerExplanation({ title: 'Insufficient balance', message: 'Add funds for the network fee, then simulate again.', feeShortfall: evidence })!;
    const en = translate('EN', facts.text, ...facts.parameters), pt = translate('PT', facts.text, ...facts.parameters);
    for (const text of [en, pt]) { expect(text).toContain('0.00012'); expect(text).toContain('0.000301'); expect(text).toContain('0.000181'); expect(text).toContain('0x90f5…d303'); }
    expect(en).toMatch(/Simulate again\. Nothing was sent\./); expect(pt).toMatch(/Simular novamente\. Nada foi enviado\./);
    expect(blockerExplanation({ title: 'Wallet not linked to your FloFi account', message: 'x' })).toBeNull();
  });
});

describe('Chat entry and network question (boards 03 and 05)', () => {
  it('detects a network question from FloFi options only (never from the person)', () => {
    expect(networkQuestionPending([{ role: 'flofi', options: ['Base', 'Arbitrum One', 'Ethereum', 'Robinhood Chain'] }])).toBe(true);
    expect(networkQuestionPending([{ role: 'ai', options: ['Base (8453)', 'Solana'] }])).toBe(true);
    expect(networkQuestionPending([{ role: 'flofi', options: ['Add another step', 'Review'] }])).toBe(false);
    expect(networkQuestionPending([{ role: 'you', options: ['Base', 'Solana'] }])).toBe(false);
    expect(networkQuestionPending([])).toBe(false);
  });
  it('selects the first bracketed part of a chip template', () => {
    expect(firstPlaceholder('Swap [amount] [token] for [token] on [network]')).toEqual({ start: 5, end: 13 });
    expect(firstPlaceholder('Trocar [valor] [token]')).toEqual({ start: 7, end: 14 }); expect(firstPlaceholder('no placeholder')).toBeNull();
  });
});

describe('walletRequestView (board 08)', () => {
  const review = (atLeast = false) => ({ counts: { walletPrompts: 2, atLeast },
    groups: [{ index: 0, steps: [0, 0] as [number, number], calls: [{ kind: 'ERC20_APPROVE', step: 0 }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }] },
      { index: 1, steps: [1, 1] as [number, number], calls: null }],
    steps: [{ index: 0, action: 'swap' }, { index: 1, action: 'bridge' }] });
  const run = (currentStep: number, planned: readonly ({ calls: number; approvals: number } | null)[]) => ({ currentStep,
    groups: [{ index: 0, steps: [0, 0] as [number, number], planned: planned[0] ?? null }, { index: 1, steps: [1, 1] as [number, number], planned: planned[1] ?? null }] });
  it('before a run: the Review\'s first group, its prepared calls in plain words', () => {
    expect(walletRequestView(review(), null)).toEqual({ request: 1, of: 2, calls: 2, itemized: true, items: [{ text: 'Token permission for step {0}', parameters: ['1'] },
      { text: 'Swap on Uniswap (step {0})', parameters: ['1'] }] });
  });
  it('itemizes the Review\'s calls only when the prepared group agrees with them', () => {
    expect(walletRequestView(review(), run(0, [{ calls: 2, approvals: 1 }]))).toMatchObject({ request: 1, calls: 2, itemized: true });
    // Prepared again (e.g. the allowance changed): the wallet\'s own count, described by the request\'s steps.
    expect(walletRequestView(review(), run(0, [{ calls: 1, approvals: 0 }]))).toEqual({ request: 1, of: 2, calls: 1, itemized: false,
      items: [{ text: 'Step {0}: {1}', parameters: ['1', 'swap'] }] });
  });
  it('a later group: its own prepared count, or only its steps while it is not prepared yet', () => {
    expect(walletRequestView(review(), run(1, [{ calls: 2, approvals: 1 }, null]))).toEqual({ request: 2, of: 2, calls: null, itemized: false,
      items: [{ text: 'Step {0}: {1}', parameters: ['2', 'bridge'] }] });
    expect(walletRequestView(review(), run(1, [{ calls: 2, approvals: 1 }, { calls: 3, approvals: 1 }]))).toMatchObject({ request: 2, calls: 3, itemized: false });
  });
  it('never guesses a group: a current step outside every group shows no header', () => {
    expect(walletRequestView(review(), run(5, [null, null]))).toBeNull();
  });
  it('never claims a total when the Review counts only a lower bound', () => {
    expect(walletRequestView(review(true), run(0, [null]))?.of).toBeNull();
  });
  it('words the deadline guard without a step and is null without a group', () => {
    const guarded = { ...review(), groups: [{ index: 0, steps: [0, 0] as [number, number], calls: [{ kind: 'DEADLINE_GUARD', step: -1 }] }] };
    expect(walletRequestView(guarded, null)?.items).toEqual([{ text: 'Expiry check: the request is refused after its deadline', parameters: [] }]);
    expect(walletRequestView({ ...review(), groups: [] }, null)).toBeNull();
  });
});
