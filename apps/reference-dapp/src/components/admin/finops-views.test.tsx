// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FinopsReport } from '../../admin/finops/report';
import { finopsCopy } from './finops-copy';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
const { FinopsAi, FinopsCostBreakdown, FinopsFilters, FinopsOverview, FinopsRevenue, FinopsWorkflow } = await import('./finops-views');

const metric = (amount: string | null, quality: string, source = 'Recorded basis.') => ({ amount, quality, source });
/** A FinOps report as `readFinopsReport` returns it (test fixture only): partial coverage, a micro-cost and unavailable indicators. */
function report(): FinopsReport {
  const period = { from: '2026-11-01', to: '2026-11-20' };
  return {
    period, current: period, previous: { from: '2026-10-01', to: '2026-11-01' },
    metrics: {
      monthToDate: metric('41.17676573', 'PARTIAL'), previousMonth: metric('88.5', 'PROVIDER_REPORTED'),
      monthlyChange: metric(null, 'UNAVAILABLE', 'Comparable periods with complete coverage are required for a monthly cost change.'),
      projected: metric('63.8', 'PARTIAL'), aiCost: metric('0.17676573', 'PROVIDER_REPORTED'), variable: metric('0.17676573', 'PARTIAL'),
      infrastructure: metric('41', 'PARTIAL'), overall: metric('41.17676573', 'PARTIAL'),
      costPerActive: metric(null, 'UNAVAILABLE', 'Cross-channel distinct active user denominator is unavailable.'), costPerChat: metric('0.00012345', 'PARTIAL'),
      costPerSimulated: metric(null, 'UNAVAILABLE', 'Cross-surface successful simulation denominator is unavailable.'), costPerCompleted: metric('2.5', 'PARTIAL'),
      directSimulated: metric(null, 'UNAVAILABLE', 'Workflow-linked direct costs and complete successful simulation counts are unavailable.'),
      directCompleted: metric(null, 'UNAVAILABLE', 'Workflow-linked direct costs are unavailable.'), revenue: metric(null, 'UNAVAILABLE', 'Administrator-reconciled platform fee accounting records.'),
      contribution: metric(null, 'UNAVAILABLE', 'Complete cost and realized revenue coverage is required for margins.'),
      result: metric(null, 'UNAVAILABLE', 'Complete cost and realized revenue coverage is required for margins.'),
      breakEvenRevenue: metric(null, 'UNAVAILABLE', 'Complete cost coverage is required to calculate an actual break-even revenue target.'),
    },
    ai: { freshness: '2026-11-19T09:00:00.000Z', coverage: { truncated: false, outsideRetention: false, ledgerAvailable: true },
      calls: { requests: 40, inputSamples: 38, outputSamples: 38, successes: 39, pricedRequests: 30, meanLatency: 812 }, chats: { web: 21, channels: 4, observed: 25 },
      toolCalls: 12, toolFailures: 1, costEstimate: metric('0.17676573', 'PARTIAL'), daily: [], models: [], legacy: [] },
    workflow: { created: 12, advanced: 9, completed: 7, failed: 1, abandoned: 2, averageSteps: 2.4, newest: '2026-11-19T08:00:00.000Z', dimensions: [] },
    sync: [], integrations: { available: true, providers: [] }, executions: null,
    totals: [
      { id: 'railway-api', amount: null, quality: 'UNAVAILABLE', complete: false, updatedAt: null, sources: [] },
      { id: 'neon-postgres', amount: '41', quality: 'PROVIDER_REPORTED', complete: true, updatedAt: '2026-11-19T00:00:00.000Z', sources: ['PROVIDER_COST'] },
      { id: 'openai', amount: '0.17676573', quality: 'PROVIDER_REPORTED', complete: true, updatedAt: '2026-11-19T00:00:00.000Z', sources: ['PROVIDER_COST'] },
    ],
    ledger: { status: 'available', complete: true, records: [] },
  } as unknown as FinopsReport;
}
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe('FinOps presentation (BUILD-FLOFI-UX-EDITOR-FINOPS-001)', () => {
  it('reads small amounts with adaptive precision, never as zero, and keeps the recorded value', () => {
    const { display } = finopsCopy('EN');
    expect(display('0.17676573')).toEqual({ text: '$0.1768', exact: '$0.17676573' });
    expect(display('0.00012345').text).toBe('$0.0001235');
    expect(display('1234.5678').text).toBe('$1,234.57');
    expect(display('0').text).toBe('$0.00');
    expect(display(null)).toEqual({ text: 'Unavailable', exact: 'Unavailable' });
    expect(finopsCopy('PT').display(null).text).toBe('Indisponível');
  });

  it('leads with four headline indicators and states partial coverage next to them; unavailable stays unavailable', () => {
    const page = html(createElement(FinopsOverview, { report: report(), language: 'EN' }));
    const headlines = page.slice(page.indexOf('aria-label="Headline indicators"'), page.indexOf('admin-finops-coverage'));
    expect([...headlines.matchAll(/admin-finops-metric-label">([^<]+)</g)].map(match => match[1])).toEqual(['Month-to-date infrastructure and operating costs',
      'Projected end-of-month costs', 'Fully allocated cost per completed workflow', 'Reconciled collected revenue']);
    expect(page).toContain('Partial financial coverage');
    expect(page).toContain('are not the complete cost of operating FloFi');
    // The revenue that is not recorded is unavailable, never $0.00; its reason is said beside it.
    expect(headlines).toContain('Unavailable');
    expect(headlines).not.toContain('$0.00');
    // A micro-cost per chat shows four significant digits, its recorded value in the accessible text.
    expect(page).toContain('$0.0001235');
    expect(page).toContain('Recorded value: $0.00012345');
    // Month-to-date and the projection are fixed calendar periods; the others cover the selected period.
    expect(page).toMatch(/data-scope="fixed">Month to date · 2026-11-01 to 2026-11-19 UTC/);
    expect(page).toContain('data-scope="selected">Selected period');
  });

  it('keeps every existing quality classification and the cost sources by quality, as counts only', () => {
    const page = html(createElement(FinopsOverview, { report: report(), language: 'EN' }));
    expect(page).toContain('Cost sources by data quality');
    expect(page).toMatch(/PROVIDER_REPORTED<\/span> 2 cost sources/);
    expect(page).not.toMatch(/\d+%/);
  });

  it('keeps every service row with its provider, value and quality, and the investor report keeps exact precision', () => {
    const dashboard = html(createElement(FinopsCostBreakdown, { report: report(), language: 'EN' }));
    expect(dashboard).toMatch(/Railway<\/span><br\/><small>flofi-api<\/small><\/th><td>infrastructure<\/td><td class="admin-num"><span class="admin-amount">Unavailable/);
    expect(dashboard).toContain('$0.1768');
    const investor = html(createElement(FinopsCostBreakdown, { report: report(), language: 'EN', mode: 'report' }));
    expect(investor).toContain('$0.17676573');
    expect(investor).not.toContain('$0.1768<');
  });

  it('separates AI usage, reliability and costs; lifecycle counts first; revenue, costs, margins and break-even apart', () => {
    const ai = html(createElement(FinopsAi, { report: report(), language: 'EN' }));
    expect([...ai.matchAll(/admin-finops-group-card" aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(['Usage', 'Reliability', 'Costs']);
    expect(ai).toContain('MCP and Developer API have no model-call coverage here.');
    const workflow = html(createElement(FinopsWorkflow, { report: report(), language: 'EN' }));
    expect([...workflow.matchAll(/<li><span>([^<]+)<\/span><strong>/g)].map(match => match[1])).toEqual(['Created', 'Started mode', 'Completed and reconciled',
      'Failed or halted', 'Cancelled or expired']);
    expect(workflow).toContain('Single-flow and legacy operations are outside this counting cohort.');
    const revenue = html(createElement(FinopsRevenue, { report: report(), language: 'EN' }));
    expect([...revenue.matchAll(/<h3 class="admin-finops-subhead">([^<]+)</g)].map(match => match[1])).toEqual(['Collected revenue', 'Operating costs', 'Margins', 'Break-even']);
    expect(revenue).toContain('Deferred 10 bps obligations do not contribute to collected revenue.');
  });

  it('shows the selected period once, with the custom UTC dates only for a custom period', () => {
    const current = html(createElement(FinopsFilters, { language: 'EN', action: '/admin/finops', filter: { preset: 'current', period: { from: '2026-11-01', to: '2026-11-20' }, valid: true } }));
    expect(current).toContain('Selected period: <strong>Current month</strong>');
    expect(current).toMatch(/<fieldset class="admin-finops-custom-dates" hidden="" disabled="">/);
    const custom = html(createElement(FinopsFilters, { language: 'EN', action: '/admin/finops', filter: { preset: 'custom', period: { from: '2026-11-03', to: '2026-11-10' }, valid: true } }));
    expect(custom).toMatch(/<fieldset class="admin-finops-custom-dates">/);
    expect(custom).toContain('value="2026-11-09"');
  });
});
