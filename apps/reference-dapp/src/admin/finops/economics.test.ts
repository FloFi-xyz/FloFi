// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pricedUsage, priceAt, type AiUsage } from './ai';
import { csvCell, parseFinopsCsv, writeFinopsCsv } from './csv';
import { consolidate, decimal, difference, finopsPeriod, perUnit, selectRecords, totalsFor, usdOf,
  validateEntry, type LedgerRecord, type Period } from './economics';
import { fetchBillingEntries, normalizeOpenAiPage } from './providers';
import { METRIC_LABELS, REPORT_LIMITATIONS } from './report';
import { modelScenario, parseScenario, SCENARIO_FIELDS } from './scenario';
import { finopsCopy } from '../../components/admin/finops-copy';

const NOW = new Date('2026-11-18T15:00:00Z');
const period: Period = { from: '2026-11-01', to: '2026-12-01' };
const row = { scope: 'openai', environment: 'production', start: period.from, end: period.to, source: 'INVOICE', reference: 'November project invoice',
  currency: 'USD', net: '10', coverage: 'FULL' };
const entry = (overrides: Record<string, unknown> = {}, id = '1'): LedgerRecord =>
  ({ ...validateEntry({ ...row, ...overrides }), id, updatedAt: NOW.toISOString() });
const amount = (records: LedgerRecord[], input = period) => totalsFor(records, input, true).find(total => total.id === 'openai');

describe('FinOps periods and costs', () => {
  it('localizes investor methodology, KPI labels and scenario assumptions using the application language', () => {
    const en = finopsCopy('EN'), pt = finopsCopy('PT');
    const copy = [...Object.values(METRIC_LABELS), ...REPORT_LIMITATIONS, ...Object.values(SCENARIO_FIELDS).map(field => field.label)];
    for (const message of copy) {
      expect(en.copy(message)).toBe(message);
      expect(pt.copy(message), message).not.toBe(message);
    }
    expect(pt.copy('{0} to {1} UTC', '2026-11-01', '2026-11-18')).toBe('2026-11-01 a 2026-11-18 UTC');
    expect(pt.money(null)).toBe('Indisponível');
    expect(pt.money('1.23', 'USD')).toContain('1,23');
  });
  it('uses strict UTC boundaries, including leap days and inclusive custom input', () => {
    expect(finopsPeriod(NOW, {}).period).toEqual({ from: '2026-11-01', to: '2026-11-19' });
    expect(finopsPeriod(NOW, { range: 'previous' }).period).toEqual({ from: '2026-10-01', to: '2026-11-01' });
    expect(finopsPeriod(NOW, { range: '7d' }).period.from).toBe('2026-11-12');
    expect(finopsPeriod(NOW, { range: '30d' }).period.from).toBe('2026-10-20');
    expect(finopsPeriod(NOW, { range: 'custom', from: '2024-02-29', to: '2024-02-29' })).toEqual({
      valid: true, preset: 'custom', period: { from: '2024-02-29', to: '2024-03-01' },
    });
    for (const day of ['2026-02-29', '2026-11-31', '2026-11-19', '26-03-01']) expect(finopsPeriod(NOW, { range: 'custom', from: day, to: day }).valid).toBe(false);
    expect(finopsPeriod(NOW, { range: 'custom', from: '2024-01-01', to: '2026-11-18' }).valid).toBe(false);
  });
  it('normalizes gross, deductions and taxes and preserves original and converted charges', () => {
    const eur = entry({ currency: 'EUR', gross: '100.2', credits: '5', discounts: '6', taxes: '2.2', net: '91.4', fxUsd: '1.08987654', fxSource: 'November ECB close' });
    expect(eur.currency).toBe('EUR');
    expect(decimal(usdOf(eur)!)).toBe('99.61471576');
    expect(usdOf(entry({ currency: 'EUR' }))).toBeNull();
    expect(() => entry({ currency: 'EUR', fxUsd: '1' })).toThrow('FINOPS_ENTRY_INVALID');
    expect(() => entry({ currency: 'NIL' })).toThrow('FINOPS_ENTRY_INVALID');
    expect(() => entry({ currency: 'USD', fxUsd: '1', fxSource: 'Assumed' })).toThrow('FINOPS_ENTRY_INVALID');
    expect(() => entry({ net: '10', gross: '10', credits: '1', discounts: '0', taxes: '0' })).toThrow('FINOPS_ENTRY_INVALID');
  });
  it('settles source priority without combining invoices with overlapping estimates', () => {
    const invoice = entry(), metered = entry({ source: 'USAGE', net: '15', end: '2026-11-08' }, '2');
    const estimated = entry({ source: 'ASSUMPTION', net: '45' }, '3');
    expect(selectRecords([metered, invoice, estimated]).map(item => item.id)).toEqual(['1']);
    expect(amount([invoice, metered, estimated])).toMatchObject({ amount: '10', quality: 'VERIFIED' });
    expect(amount([invoice], { from: '2026-11-14', to: '2026-11-21' })).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    expect(amount([entry({ source: 'USAGE' })])).toMatchObject({ amount: '10', quality: 'METERED' });
    expect(amount([estimated])).toMatchObject({ amount: '45', quality: 'ESTIMATED' });
    expect(amount([metered])).toMatchObject({ amount: '15', quality: 'PARTIAL' });
    expect(amount([entry({ currency: 'EUR' })])).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    expect(amount([entry({ net: '0' })])).toMatchObject({ amount: '0', quality: 'VERIFIED' });
    const day = entry({ end: '2026-11-02' }), rest = entry({ start: '2026-11-02', net: '5' }, '2');
    expect(amount([day, rest])).toMatchObject({ amount: '15', quality: 'VERIFIED' });
  });
  it('does not turn incomplete inputs into margin or zero-unit economics', () => {
    const subtotal = consolidate(totalsFor([entry()], period, true), scope => scope.category === 'ai', 'billed');
    expect(subtotal).toMatchObject({ amount: '10', quality: 'PARTIAL' });
    const revenue = { amount: '25', quality: 'VERIFIED', source: 'accounting' } as const;
    expect(difference(revenue, subtotal, 'margin')).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    expect(difference(revenue, { ...subtotal, quality: 'VERIFIED' }, 'margin')).toMatchObject({ amount: '15', quality: 'VERIFIED' });
    expect(perUnit(subtotal, 4, 'subset', false)).toMatchObject({ amount: '2.5', quality: 'PARTIAL' });
    expect(perUnit(subtotal, 0, 'no denominator', false)).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
  });
});

describe('FinOps import, providers and exports', () => {
  const heads = ['scope','environment','start','end','source','reference','currency','net','coverage','notes'];
  const line = ['openai','production',period.from,period.to,'INVOICE','record N1','USD','12.30','FULL','A comma, and "quotes"'];
  it('supports BOM, CRLF and quoted cells and rejects malformed, unsupported or mixed imports', () => {
    const csv = writeFinopsCsv([heads, line]);
    expect(parseFinopsCsv('\uFEFF' + csv)[0]).toMatchObject({ scope: 'openai', net: '12.3', notes: 'A comma, and "quotes"' });
    expect(() => parseFinopsCsv(csv + '"unfinished')).toThrow('FINOPS_ENTRY_INVALID');
    expect(() => parseFinopsCsv(writeFinopsCsv([heads, line, [...line.slice(0, 7), 'bad', 'FULL', 'notes']]))).toThrow('FINOPS_ENTRY_INVALID');
    expect(() => parseFinopsCsv(writeFinopsCsv([heads, [...line.slice(0, 4), 'PROVIDER_COST', ...line.slice(5)]]))).toThrow('FINOPS_ENTRY_INVALID');
    expect(csvCell('=HYPERLINK("example")')).toBe(`"'=HYPERLINK(""example"")"`);
    expect(csvCell('-1.5')).toBe('"-1.5"');
  });
  const start = Date.parse(period.from + 'T00:00:00Z') / 1000;
  const provider = (project = 'proj_flofi', results = [{ project_id: project, amount: { value: 1.1, currency: 'usd' } }]) =>
    ({ data: [{ start_time: start, end_time: start + 86_400, results }], has_more: false });
  it('normalizes provider amounts, excludes empty buckets and refuses shared-account rows', () => {
    expect(normalizeOpenAiPage(provider(), 'proj_flofi', period).entries[0]).toMatchObject({ currency: 'USD', net: '1.1', source: 'PROVIDER_COST' });
    expect(normalizeOpenAiPage(provider(undefined, []), 'proj_flofi', period).entries).toEqual([]);
    expect(() => normalizeOpenAiPage(provider('proj_unrelated'), 'proj_flofi', period)).toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
  });
  it('restricts live synchronization by tenant, query project and preview and respects a long Retry-After', async () => {
    const env = { FLOFI_FINOPS_BILLING_TENANT: 'default', FLOFI_FINOPS_OPENAI_ADMIN_KEY: 'test-only-billing-key', FLOFI_FINOPS_OPENAI_PROJECT_ID: 'proj_flofi' };
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.openai.com');
      expect(url.searchParams.get('project_ids[]')).toBe('proj_flofi');
      expect(url.searchParams.get('group_by[]')).toBe('project_id');
      expect(init?.method).toBe('GET');
      return Response.json(provider());
    };
    await expect(fetchBillingEntries('openai', env, 'other-tenant', period, fetcher)).rejects.toThrow('FINOPS_PROVIDER_NOT_CONFIGURED');
    await expect(fetchBillingEntries('openai', { ...env, VERCEL_ENV: 'preview' }, 'default', period, fetcher)).rejects.toThrow('FINOPS_PROVIDER_NOT_CONFIGURED');
    await expect(fetchBillingEntries('openai', env, 'default', period, fetcher)).resolves.toHaveLength(1);
    expect(calls).toBe(1);
    await expect(fetchBillingEntries('openai', env, 'default', period, async () => new Response(null, {
      status: 429, headers: { 'retry-after': '60' },
    }))).rejects.toThrow('FINOPS_PROVIDER_RETRY_LATER');
  });
});

describe('FinOps model pricing and growth scenarios', () => {
  const ai: AiUsage = { day: '2026-11-18', provider: 'ANTHROPIC', model: 'claude-sonnet-4-5-20250929', surface: 'TELEGRAM', requests: 2,
    successes: 2, duration_ms: 200, input_tokens: 1_000_000, input_samples: 2, output_tokens: 100_000, output_samples: 2, cached_input_tokens: 200_000,
    cached_input_samples: 2, cache_write_tokens: 100_000, cache_write_samples: 2, reasoning_tokens: 50_000, reasoning_samples: 2 };
  it('prices only known canonical IDs, chooses the effective version, and never double bills reasoning', () => {
    expect(pricedUsage(ai)).toBeCloseTo(4.035, 10);
    expect(pricedUsage({ ...ai, reasoning_tokens: 0 })).toBe(pricedUsage(ai));
    expect(pricedUsage({ ...ai, cached_input_samples: 0 })).toBeNull();
    expect(pricedUsage({ ...ai, model: 'claude-sonnet-4-5' })).toBeNull();
    expect(pricedUsage({ ...ai, day: '2026-11-17' })).toBeNull();
    const current = priceAt(ai.provider, ai.model, ai.day)!;
    expect(priceAt(ai.provider, ai.model, '2026-12-02', [current, { ...current, effective: '2026-12-01', output: 16 }])?.output).toBe(16);
  });
  it('charges variable and sponsor costs on initiated workflows, and computes break-even on net contribution', () => {
    const input = parseScenario({ users: '1000', chats: '4', workflows: '2', completion: '50', eligibleVolume: '200',
      fee: '0.1', ai: '0.01', workflowCost: '0.02', gas: '0.01', infrastructure: '100' })!;
    expect(modelScenario(input)).toMatchObject({ chats: 4000, workflows: 2000, completed: 1000, ai: 40, workflow: 40, gas: 20, variable: 100,
      total: 200, revenue: 200, contribution: 100, result: 0, breakEvenUsers: 1000, breakEvenWorkflows: 2000 });
    expect(modelScenario({ ...input, fee: 0 }).breakEvenWorkflows).toBeNull();
    expect(parseScenario({ ...input, fee: '0' })).toBeNull();
  });
});
