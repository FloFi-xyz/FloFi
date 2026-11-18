// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002: OpenAI Costs + Usage and Anthropic Usage and Cost Analytics adapters against recorded response
 * shapes from the providers' current references (no network, no credential: keys below are inert fixtures).
 */
import { describe, expect, it, vi } from 'vitest';
import { aiFinancialAdapters, ANTHROPIC_API_PRODUCTS } from './sync-ai-providers.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';

const [openai, anthropic] = aiFinancialAdapters;
const period = { from: '2026-11-01', to: '2026-11-03' };
const day = (date: string) => Date.parse(date + 'T00:00:00Z') / 1_000;
const env = { FLOFI_FINOPS_OPENAI_ADMIN_KEY: 'inert-fixture', FLOFI_FINOPS_OPENAI_PROJECT_ID: 'proj_flofi',
  FLOFI_FINOPS_ANTHROPIC_ADMIN_KEY: 'inert-fixture', FLOFI_FINOPS_ANTHROPIC_WORKSPACE_ID: 'wrkspc_flofi' };
const read = (adapter: FinancialSyncAdapter, fetch: typeof globalThis.fetch) =>
  adapter.read({ env, period, fetch, signal: AbortSignal.timeout(2_000), checkpoint: null });

describe('OpenAI Costs and Usage', () => {
  const costs = { object: 'page', has_more: false, next_page: null, data: ['2026-11-01', '2026-11-02'].map((from, index) => ({
    object: 'bucket', start_time: day(from), end_time: day(from) + 86_400,
    results: [{ object: 'organization.costs.result', project_id: 'proj_flofi', amount: { value: index + 0.25, currency: 'usd' } }] })) };
  const usage = (category: string) => ({ object: 'page', has_more: false, next_page: null, data: [{ object: 'bucket', start_time: day('2026-11-01'),
    end_time: day('2026-11-02'), results: category === 'images'
      ? [{ object: 'organization.usage.images.result', project_id: 'proj_flofi', model: 'gpt-image-1', images: 3, num_model_requests: 2 }]
      : category === 'completions'
        ? [{ object: 'organization.usage.completions.result', project_id: 'proj_flofi', model: 'gpt-5', num_model_requests: 4, input_tokens: 100,
          output_tokens: 40, input_cached_tokens: 10 }]
        : [] }] });

  it('records project-scoped daily costs, model usage and the documented image fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async request => {
      const url = new URL(String(request));
      expect(url.origin).toBe('https://api.openai.com');
      expect(url.searchParams.getAll('project_ids[]')).toEqual(['proj_flofi']);
      if (url.pathname === '/v1/organization/costs') return Response.json(costs);
      const category = url.pathname.split('/').at(-1)!;
      expect(url.searchParams.get('bucket_width')).toBe('1d');
      expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(31);
      expect(url.searchParams.getAll('group_by[]')).toEqual(['completions', 'embeddings', 'images'].includes(category) ? ['project_id', 'model'] : ['project_id']);
      return Response.json(usage(category));
    });
    const result = await read(openai, fetch);
    expect(result).toMatchObject({ kind: 'COMPLETE', coverage: 'PARTIAL', limitations: ['OPENAI_COSTS_PROJECT_SCOPE'] });
    if (result.kind !== 'COMPLETE') throw Error('unreachable');
    expect(result.entries.map(entry => [entry.period.from, entry.net, entry.currency])).toEqual([['2026-11-01', '0.25', 'USD'], ['2026-11-02', '1.25', 'USD']]);
    expect(result.meters.filter(meter => meter.service === 'images:gpt-image-1').map(meter => [meter.metric, meter.unit, meter.amount]))
      .toEqual([['images', 'images', '3'], ['num_model_requests', 'requests', '2']]);
    expect(result.meters.find(meter => meter.metric === 'output_tokens')).toMatchObject({ service: 'completions:gpt-5', amount: '40', project: 'proj_flofi' });
  });

  it('refuses usage attributed to another project and keeps costs when one usage category is unavailable', async () => {
    const foreign = vi.fn<typeof globalThis.fetch>(async request => {
      const url = new URL(String(request));
      if (url.pathname === '/v1/organization/costs') return Response.json(costs);
      if (url.pathname.endsWith('/completions')) return Response.json({ ...usage('completions'),
        data: [{ ...usage('completions').data[0], results: [{ project_id: 'proj_other', model: 'gpt-5', num_model_requests: 1 }] }] });
      if (url.pathname.endsWith('/images')) return new Response('down', { status: 503 });
      return Response.json(usage('none'));
    });
    const result = await read(openai, foreign);
    expect(result).toMatchObject({ kind: 'COMPLETE', limitations: ['OPENAI_COSTS_PROJECT_SCOPE', 'OPENAI_USAGE_CATEGORY_UNAVAILABLE'] });
    if (result.kind === 'COMPLETE') {
      expect(result.entries).toHaveLength(2);
      expect(result.meters.some(meter => meter.project !== 'proj_flofi')).toBe(false);
    }
  });
});

describe('Anthropic Usage and Cost Analytics', () => {
  const refreshed = '2026-11-03T04:02:11Z';
  const costRow = (date: string, product: string | null, amount: string, workspace = 'wrkspc_flofi') => ({ starting_at: date + 'T00:00:00Z',
    ending_at: new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().replace('.000', ''),
    group: { workspace_id: workspace, model: 'claude-sonnet-5-5', product, cost_type: 'tokens' }, cost: { currency: 'USD', amount, list_amount: amount, requests: null } });
  const usageRow = (date: string, product: string | null) => ({ ...costRow(date, product, '0'), cost: undefined,
    group: { workspace_id: 'wrkspc_flofi', model: 'claude-sonnet-5-5', product },
    usage: { uncached_input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50, requests: 7, cache_creation: { ephemeral_5m_input_tokens: 20 } } });
  function provider(rows: { cost: unknown[]; usage: unknown[] }, watermark: string | null = refreshed) {
    return vi.fn<typeof globalThis.fetch>(async (request, init) => {
      const url = new URL(String(request)), headers = new Headers(init?.headers);
      expect(url.origin + url.pathname).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/organizations\/analytics\/(cost|usage)$/);
      expect([headers.get('anthropic-beta'), headers.get('anthropic-version'), headers.get('x-api-key')])
        .toEqual(['analytics-usage-cost-2026-08-24', '2026-10-21', 'inert-fixture']);
      expect(url.searchParams.getAll('products[]')).toEqual([...ANTHROPIC_API_PRODUCTS]);
      expect(url.searchParams.getAll('workspace_ids[]')).toEqual(['wrkspc_flofi']);
      expect(url.searchParams.get('time_bucket_width')).toBe('1d');
      const type = url.pathname.endsWith('/cost') ? 'cost' : 'usage';
      return Response.json({ data: rows[type], data_refreshed_at: watermark, has_more: false, next_page: null });
    });
  }

  it('records API product costs from cents, excludes other surfaces and keeps usage meters', async () => {
    const result = await read(anthropic, provider({
      cost: [costRow('2026-11-01', 'messages_api', '1250.500000'), costRow('2026-11-01', 'message_batches_api', '49.500000'),
        costRow('2026-11-02', 'claude_code', '99999.000000'), costRow('2026-11-02', null, '100.000000')],
      usage: [usageRow('2026-11-01', 'messages_api'), usageRow('2026-11-02', 'chat')],
    }));
    if (result.kind !== 'COMPLETE') throw Error('unexpected wait');
    expect(result.entries.map(entry => [entry.period.from, entry.net, entry.currency, entry.source]))
      .toEqual([['2026-11-01', '13', 'USD', 'PROVIDER_COST'], ['2026-11-02', '1', 'USD', 'PROVIDER_COST']]);
    expect(result.limitations).toEqual(expect.arrayContaining(['ANTHROPIC_COSTS_BEFORE_CREDITS', 'ANTHROPIC_NON_API_PRODUCTS_EXCLUDED']));
    expect(result.meters.filter(meter => meter.metric === 'requests').map(meter => [meter.period.from, meter.amount])).toEqual([['2026-11-01', '7']]);
    expect(result.meters.find(meter => meter.metric === 'ephemeral_5m_input_tokens')).toMatchObject({ amount: '20', unit: 'tokens' });
  });

  it('excludes days after the export watermark instead of recording a partial day as a complete cost', async () => {
    const result = await read(anthropic, provider({ cost: [costRow('2026-11-01', 'messages_api', '100'), costRow('2026-11-02', 'messages_api', '100')],
      usage: [usageRow('2026-11-02', 'messages_api')] }, '2026-11-02T08:00:00Z'));
    if (result.kind !== 'COMPLETE') throw Error('unexpected wait');
    expect(result.entries.map(entry => entry.period.from)).toEqual(['2026-11-01']);
    expect(result.meters.some(meter => meter.period.from === '2026-11-02')).toBe(false);
    expect(result.limitations).toEqual(expect.arrayContaining(['ANTHROPIC_DAYS_AFTER_EXPORT_WATERMARK_EXCLUDED', 'ANTHROPIC_CLOSED_DAY_COVERAGE_PARTIAL']));
  });

  it('records nothing for another workspace and treats an expired cursor as a transient retry', async () => {
    await expect(read(anthropic, provider({ cost: [costRow('2026-11-01', 'messages_api', '100', 'wrkspc_other')], usage: [] })))
      .rejects.toThrow('FINOPS_PROVIDER_NO_COST_DATA');
    await expect(read(anthropic, async () => new Response('{"type":"error"}', { status: 410 }))).rejects.toThrow('FINOPS_PROVIDER_RETRY_LATER');
  });
});
