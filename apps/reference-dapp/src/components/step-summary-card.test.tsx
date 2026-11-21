// SPDX-License-Identifier: AGPL-3.0-only
/** UX-01 / UX-03: the shared step card and the shortened recipient (full address one click away and always in the accessible name). */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider, type Language } from '../i18n/locale';
import { RecipientShort, StepSummaryCard } from './operation-summary';

const ADDRESS = '0x282091e22697dd3434ad1847fc830e1eff912edc';
const render = (node: React.ReactNode, language: Language = 'EN') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}>{node}</LocaleProvider>);
const items = [{ key: 'a', action: 'swap', title: 'Swap', amount: '3 USDC → ≈ 0.000893 WETH', network: 'Base (8453)' },
  { key: 'b', action: 'transfer', title: 'Send', amount: '0.0008 WETH', network: 'Base', recipient: { address: ADDRESS, own: false } }];

describe('UX-01 / UX-03: StepSummaryCard', () => {
  it('icons variant: each step\'s action icon, its name, its amounts on their own line and its network in a pill (no chain number)', () => {
    const html = render(<StepSummaryCard items={items}/>);
    expect(html).toMatch(/^<div class="operation-summary step-summary-card" data-variant="icons"><ol aria-label="Steps"><li><span class="operation-summary-icon" aria-hidden="true"><svg/);
    expect(html).toContain('<strong class="step-summary-title">Swap</strong><span class="operation-summary-line step-summary-amount">3 USDC → ≈ 0.000893 WETH</span>');
    expect(html).toContain('<span class="operation-summary-chip">Base</span>');
    expect(html).not.toContain('8453');
  });
  it('numbered variant: the step number in a circle and the action icon beside its name', () => {
    const html = render(<StepSummaryCard items={items} variant="numbered"/>, 'PT');
    expect(html).toContain('data-variant="numbered"><ol aria-label="Passos">');
    expect(html).toMatch(/<span class="operation-summary-number" aria-hidden="true">2<\/span><div class="operation-summary-body"><strong class="step-summary-title">Enviar<span class="step-summary-title-icon" aria-hidden="true"><svg/);
  });
  it('Simulate (icons): a recipient is shortened, its accessible name starts with the visible text and states the full address', () => {
    const html = render(<StepSummaryCard items={items}/>);
    expect(html).toContain(`<button type="button" class="step-recipient-toggle" aria-expanded="false" aria-label="0x2820…912edc, show the full address ${ADDRESS}"><code>0x2820…912edc</code></button>`);
    expect(render(<RecipientShort address={ADDRESS} own/>)).toBe('<small class="operation-summary-recipient">Recipient: Your wallet</small>');
    // A short value (not an EVM address) is shown as it is, never shortened.
    expect(render(<RecipientShort address="alice.eth"/>)).toContain('<code>alice.eth</code>');
  });
  it('Execute (numbered, flofi-security review): the recipient is visible IN FULL with its copy control, never shortened', () => {
    const html = render(<StepSummaryCard items={items} variant="numbered"/>);
    expect(html).toContain(`<small class="operation-summary-recipient step-recipient step-recipient-visible">Recipient: <span class="execution-receipt-copy"><span title="${ADDRESS}">${ADDRESS}</span>`);
    expect(html).not.toContain('0x2820…912edc');
  });
  it('renders nothing without steps', () => { expect(render(<StepSummaryCard items={[]}/>)).toBe(''); });
});
