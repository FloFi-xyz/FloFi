// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { investorCsv, type FinopsReport } from '../../admin/finops/report';
import { finopsCopy } from './finops-copy';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
const { FinopsAi, FinopsCostBreakdown, FinopsCoverage, FinopsExchangeReference, FinopsFilters, FinopsInfrastructure, FinopsOverview, FinopsRevenue, FinopsWorkflow } = await import('./finops-views');
const { FinopsIntegrations, FinopsScenario } = await import('./finops-controls');
const { scenarioKeys } = await import('../../admin/finops/scenario');
const { LocaleProvider } = await import('../../i18n/locale');

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
    expect(page).toContain('Partial financial coverage for the selected period');
    expect(page).toContain('are not the complete cost of operating FloFi');
    // The revenue that is not recorded is unavailable, never $0.00; its reason is said beside it.
    expect(headlines).toContain('Unavailable');
    expect(headlines).not.toContain('$0.00');
    // A micro-cost per chat shows four significant digits, its recorded value in the accessible text.
    expect(page).toContain('$0.0001235');
    expect(page).toContain('Recorded value: $0.00012345');
    // Fixed and selected periods are annotated beside each indicator.
    expect(page).toMatch(/data-scope="fixed">Month to date · 2026-11-01 to 2026-11-19 UTC/);
    expect(page).toContain('data-scope="selected">Selected period');
  });

  it('labels monthly comparisons by closed days even for a different selected period', () => {
    const view = report();
    const firstDay = { ...view, period: view.previous, current: { from: '2026-11-01', to: '2026-11-02' } };
    const comparison = (value: FinopsReport) => html(createElement(FinopsOverview, { report: value, language: 'EN' }));
    expect(comparison({ ...view, period: view.previous })).toContain('Closed days of the current month · 2026-11-01 to 2026-11-18 UTC');
    expect(comparison(firstDay)).toContain('No closed UTC days in the current month');
  });

  it('keeps every existing quality classification and the cost sources by quality, as counts only', () => {
    const page = html(createElement(FinopsOverview, { report: report(), language: 'EN' }));
    expect(page).toContain('Cost sources by data quality');
    expect(page).toMatch(/PROVIDER_REPORTED<\/span> 2 cost sources/);
    expect(page).not.toMatch(/\d+%/);
  });

  it('keeps every service row and rounds ordinary investor amounts while preserving the exact export', () => {
    const dashboard = html(createElement(FinopsCostBreakdown, { report: report(), language: 'EN' }));
    expect(dashboard).toMatch(/Railway<\/span><br\/><small>flofi-api<\/small><\/th><td>infrastructure<\/td><td class="admin-num"><span class="admin-amount">Unavailable/);
    expect(dashboard).toContain('$0.1768');
    const investor = html(createElement(FinopsCostBreakdown, { report: report(), language: 'EN', mode: 'report' }));
    expect(investor).toContain('$0.18');
    expect(investor).not.toContain('$0.1768<');
    const portuguese = html(createElement(FinopsCostBreakdown, { report: report(), language: 'PT', mode: 'report' }));
    expect(portuguese).toMatch(/US\$\s0,18/);
    expect(investorCsv(report())).toContain('"0.17676573","USD","PROVIDER_REPORTED"');
  });

  it('renders both currencies and their FX reference while keeping unavailable BRL distinct from USD', () => {
    const indicative = { asOf: '2026-11-19', policy: 'current-indicative', quote: { rate: '5.41234', publishedAt: '2026-11-19 13:00:00' } } as const;
    const previous = { asOf: '2026-10-31', policy: 'historical-period-close', quote: null } as const;
    const rates = { indicative, selected: indicative, previous };
    const view = { ...report(), fx: rates };
    const en = html(createElement(FinopsCostBreakdown, { report: view, language: 'EN', mode: 'report' }));
    expect(en).toContain('$0.18');
    expect(en).toMatch(/Approx\. R\$\s?0\.96/);
    const pt = html(createElement(FinopsCostBreakdown, { report: view, language: 'PT', mode: 'report' }));
    expect(pt).toMatch(/US\$\s0,18/);
    expect(pt).toMatch(/Aprox\. R\$\s0,96/);
    const reference = html(createElement(FinopsExchangeReference, { rates, language: 'PT' }));
    expect(reference).toContain('Banco Central do Brasil · PTAX de venda');
    expect(reference).toContain('5,41234 BRL por USD · 2026-11-19 13:00:00 (horário de São Paulo)');
    expect(reference).toContain('Conversão para BRL indisponível');
    const missing = html(createElement(FinopsCostBreakdown, {
      report: { ...view, fx: { ...rates, selected: { ...indicative, quote: null } } }, language: 'EN', mode: 'report' }));
    expect(missing).toContain('$0.18');
    expect(missing).toContain('BRL conversion unavailable');
  });

  it('never shows a non-zero investor amount as zero next to its BRL conversion', () => {
    const quote = { rate: '5.41234', publishedAt: '2026-11-19 13:00:00' };
    const rate = { asOf: '2026-11-19', policy: 'current-indicative', quote } as const;
    const tiny = { ...report(), fx: { indicative: rate, selected: rate, previous: rate },
      totals: [{ id: 'openai', amount: '0.004', quality: 'PROVIDER_REPORTED', complete: true, updatedAt: '2026-11-19T00:00:00.000Z', sources: ['PROVIDER_COST'] }] } as unknown as FinopsReport;
    const en = html(createElement(FinopsCostBreakdown, { report: tiny, language: 'EN', mode: 'report' }));
    expect(en).toContain('$0.004<');
    expect(en).not.toContain('$0.00<');
    expect(en).toMatch(/Approx\. R\$\s?0\.02</);
    const pt = html(createElement(FinopsCostBreakdown, { report: tiny, language: 'PT', mode: 'report' }));
    expect(pt).toMatch(/US\$\s0,004</);
  });

  it('keeps the CSV integration status current: no old error for a removed credential, and an unavailable state said', () => {
    const removed = { id: 'vercel', name: 'Vercel', configured: false, active: false, lastAttempt: '2026-11-18T10:00:00.000Z', lastSuccess: null,
      nextSync: null, errorCode: 'FINOPS_PROVIDER_NOT_ENTITLED', coverage: [], meters: [], cost: { amount: null, quality: 'UNAVAILABLE' }, connection: 'UNCONFIGURED' };
    const view = { ...report(), integrations: { available: true, providers: [removed] } } as unknown as FinopsReport;
    const rows = investorCsv(view).split('\n').filter(line => line.startsWith('"integration status"'));
    expect(rows).toEqual([expect.stringContaining('"vercel"')]);
    expect(rows[0]).toContain('"UNCONFIGURED"');
    expect(rows[0]).not.toContain('NOT_ENTITLED');
    expect(html(createElement(FinopsCostBreakdown, { report: view, language: 'EN' }))).not.toContain('Latest sync failed');
    const unavailable = investorCsv({ ...report(), integrations: { available: false, providers: [] } } as unknown as FinopsReport);
    expect(unavailable).toContain('"integration status","all"');
    expect(unavailable).toContain('"UNAVAILABLE","Automatic synchronization state unavailable"');
  });

  it('marks usage and estimate records as excluded from recorded expenses in the reconciliation table', () => {
    const record = { id: 7, scope: 'openai', environment: 'production', period: { from: '2026-11-01', to: '2026-11-02' }, source: 'ASSUMPTION',
      reference: 'Planning estimate', notes: null, currency: 'USD', net: '12.5', gross: null, credits: null, discounts: null, taxes: null,
      fxUsd: null, fxSource: null, coverage: 'FULL', updatedAt: '2026-11-19T00:00:00.000Z', selected: true };
    const view = { ...report(), ledger: { status: 'available', complete: true, records: [record] } } as unknown as FinopsReport;
    const page = html(createElement(FinopsInfrastructure, { report: view, language: 'EN' }));
    expect(page).toContain('Excluded from recorded expenses (usage or estimate)');
    expect(page).not.toContain('Superseded in totals');
    expect(page).toContain('$12.50');
  });

  it('uses the latest success and only indicates a failure newer than both sync paths', () => {
    const view = report();
    const legacy = { scope: 'openai', lastAttempt: '2026-11-19T19:00:00.000Z', lastSuccess: '2026-11-19T19:00:00.000Z', lastFailed: null };
    const oldAttempt = '2026-11-19T18:00:00.000Z';
    const automatic: FinopsReport['integrations']['providers'][number] = {
      id: 'openai', name: 'OpenAI', configured: true, active: false, nextSync: null, coverage: [], meters: [],
      lastAttempt: oldAttempt, lastSuccess: '2026-11-19T17:00:00.000Z', errorCode: 'FINOPS_PROVIDER_ACCESS_DENIED', cost: view.metrics.aiCost, connection: 'ERROR',
    };
    const page = (lastAttempt: string) => html(createElement(FinopsCostBreakdown, { language: 'EN',
      report: { ...view, sync: [legacy], integrations: { available: true, providers: [{ ...automatic, lastAttempt }] } } }));
    expect(page(oldAttempt)).toContain('2026-11-19 19:00 UTC');
    expect(page(oldAttempt)).not.toContain('Latest sync failed');
    expect(page('2026-11-19T20:00:00.000Z')).toContain('Latest sync failed 2026-11-19 20:00 UTC');
  });

  it('shows no English quality code in the Portuguese AI and workflow sections', () => {
    for (const section of [FinopsAi, FinopsWorkflow]) {
      const page = html(createElement(section, { report: report(), language: 'PT' }));
      expect(page).not.toMatch(/\b(?:PARTIAL|UNAVAILABLE|VERIFIED|ESTIMATED)\b/);
    }
  });

  it('keeps the recorded AI cost visible when AI telemetry cannot be read', () => {
    const ai = html(createElement(FinopsAi, { report: { ...report(), ai: null }, language: 'EN' }));
    expect(ai).toContain('AI telemetry is temporarily unavailable.');
    expect([...ai.matchAll(/admin-finops-group-card" aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(['Costs']);
    expect(ai).toMatch(/Provider and ledger AI costs<\/dt><dd><span class="admin-finops-figure"><span class="admin-amount"[^>]*>\$0\.1768/);
    expect(ai).not.toContain('AI list-price estimate');
  });

  it('counts only periods with synchronized data; a confirmed-empty period stays a listed coverage gap', () => {
    const gap = { period: { from: '2026-09-01', to: '2026-10-01' }, collectedAt: '2026-11-19T10:00:00.000Z', quality: 'UNAVAILABLE',
      limitations: ['FINOPS_PROVIDER_RESPONSE_INVALID'], meterCount: 0 };
    const usage = { period: { from: '2026-10-01', to: '2026-11-01' }, collectedAt: '2026-11-19T10:00:00.000Z', quality: 'PARTIAL', limitations: [], meterCount: 4 };
    const circleci = { id: 'circleci', name: 'CircleCI', configured: true, active: false, lastAttempt: null, lastSuccess: '2026-11-19T10:00:00.000Z',
      nextSync: null, errorCode: null, meters: [], cost: { amount: null, quality: 'UNAVAILABLE' }, connection: 'USAGE_SYNCHRONIZED' };
    const table = (coverage: readonly (typeof gap)[]) => html(createElement(FinopsIntegrations,
      { integrations: { available: true, providers: [{ ...circleci, coverage }] } as unknown as FinopsReport['integrations'] }));
    expect(table([gap])).toContain('No synchronized period');
    expect(table([gap])).not.toContain('synchronized periods');
    expect(table([usage, gap])).toContain('1 synchronized period<');
    // Inclusive UTC days, the singular, and a failed period's labelled reason.
    expect(table([usage, gap])).toContain('2026-09-01 to 2026-09-30 UTC · UNAVAILABLE · 0 usage measurements · The provider returned data FloFi could not verify.');
    expect(table([{ ...usage, meterCount: 1 }])).toContain('2026-10-01 to 2026-10-31 UTC · PARTIAL · 1 usage measurement<');
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

  it('says the ledger is unavailable (never "no records") when it cannot be read, and opens every disclosure in the investor report', () => {
    const missing = { ...report(), ledger: { status: 'missing', complete: true, records: [] } } as unknown as FinopsReport;
    const page = html(createElement(FinopsOverview, { report: missing, language: 'EN' }));
    expect(page).toContain('Cost coverage unavailable');
    expect(page).toContain('The billing ledger is not provisioned yet');
    // The Infrastructure section keeps the exact sentence the admin console certifies; the summary never repeats it.
    expect(page).not.toContain('Billing ledger unavailable.');
    expect(html(createElement(FinopsCoverage, { language: 'EN', mode: 'report' }))).toContain('<details class="admin-details" open="">');
    expect(html(createElement(FinopsCoverage, { language: 'EN' }))).not.toContain('open=""');
  });

  it('groups every Growth Simulator assumption exactly once and marks results as estimates', () => {
    const page = html(createElement(LocaleProvider, { initialLanguage: 'EN', children: createElement(FinopsScenario) }));
    expect(page.match(/<input type="number"/g)).toHaveLength(scenarioKeys.length);
    expect([...page.matchAll(/<legend>([^<]+)<\/legend>/g)].map(match => match[1])).toEqual(['User and activity assumptions', 'Workflow and completion assumptions',
      'Revenue assumptions', 'Variable costs', 'Gas sponsorship assumptions', 'Fixed infrastructure costs']);
  });
});
