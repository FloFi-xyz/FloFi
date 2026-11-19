// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { infraFinancialAdapters, NEON_FINANCIAL_ORG, NEON_FINANCIAL_PROJECTS, RAILWAY_FINANCIAL_PROJECT, RAILWAY_PRODUCTION_ENVIRONMENT,
  VERCEL_FINANCIAL_PROJECT, VERCEL_FINANCIAL_TEAM } from './sync-infra-providers.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';

const [neon, railway, vercel, alchemy] = infraFinancialAdapters;
const period = { from: '2026-11-01', to: '2026-11-03' };
const production = 'wandering-mode-28938220', preview = 'frosty-grass-75768827';
const api = 'd56aa713-6ce6-487a-923e-effce2dc950c', worker = '5379d4b0-ea9d-4775-a369-34fa526968db';
const env = { ...Object.fromEntries(['NEON_API_KEY', 'RAILWAY_API_TOKEN', 'VERCEL_BILLING_TOKEN', 'ALCHEMY_USAGE_KEY'].map(name =>
  ['FLOFI_FINOPS_' + name, 'dummy-fixture'])), FLOFI_FINOPS_ALCHEMY_APP_IDS: 'flofi_fixture_app' };
const get = (adapter: FinancialSyncAdapter, fetch: typeof globalThis.fetch, window = period) =>
  adapter.read({ env, period: window, fetch, signal: AbortSignal.timeout(2_000), checkpoint: null });
const midnight = (date: string) => date + 'T00:00:00Z';
function neonResource(project_id: string, period_plan: string, data: Record<string, number>, span = { from: '2026-11-01', to: '2026-11-02' }) {
  return { project_id, periods: [{ period_plan, consumption: [{ timeframe_start: midnight(span.from), timeframe_end: midnight(span.to),
    metrics: Object.entries(data).map(([metric_name, value]) => ({ metric_name, value })) }] }] };
}

describe('Neon Consumption Metrics v2', () => {
  it('reads only the four FloFi projects, follows branch cursors, and converts monthly price inputs without adding branch allocations to project totals', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (request, init) => {
      const url = new URL(String(request));
      expect(url.origin).toBe('https://console.neon.tech');
      expect(url.searchParams.get('org_id')).toBe(NEON_FINANCIAL_ORG);
      expect(url.searchParams.get('project_ids')?.split(',').sort()).toEqual(Object.keys(NEON_FINANCIAL_PROJECTS).sort());
      expect(url.searchParams.get('granularity')).toBe('daily');
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
      if (url.pathname.endsWith('/projects')) return Response.json({ projects: [
        neonResource(production, 'launch', { compute_unit_seconds: 3600, root_branch_bytes_month: 1e9, instant_restore_bytes_month: 1e9,
          public_network_transfer_bytes: 501e9, extra_branches_month: 240, functions_active_capacity_microseconds: 3.6e9, functions_invocations: 1e6 }),
        neonResource(preview, 'scale', { compute_unit_seconds: 7200, private_network_transfer_bytes: 2e9 }),
      ] });
      expect(url.searchParams.get('metrics')).not.toContain('extra_branches_month');
      expect(url.searchParams.get('metrics')).not.toContain('snapshot_storage_bytes_month');
      if (!url.searchParams.has('cursor')) return Response.json({ branches: [{ ...neonResource(production, 'launch', { compute_unit_seconds: 3600 }),
        branch_id: 'br-main-fixture' }], pagination: { cursor: 'branch-fixture-cursor' } });
      expect(url.searchParams.get('cursor')).toBe('branch-fixture-cursor');
      return Response.json({ branches: [{ ...neonResource(preview, 'scale', { child_branch_bytes_month: 2e9 }), branch_id: 'br-preview-fixture' }] });
    });
    const result = await get(neon, fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ kind: 'COMPLETE', coverage: 'PARTIAL', entries: [], meters: expect.arrayContaining([
      expect.objectContaining({ project: production, service: 'postgresql', metric: 'compute_unit_seconds', amount: '1', unit: 'CU-hour' }),
      expect.objectContaining({ project: production, service: 'postgresql', metric: 'list_price_estimate', amount: '0.8043871', basis: 'NEON_RATE_2026-11-18' }),
      expect.objectContaining({ project: production, service: 'functions', metric: 'list_price_estimate', amount: '0.7' }),
      expect.objectContaining({ project: production, service: 'branch:br-main-fixture', metric: 'compute_unit_seconds', amount: '1' }),
      expect.objectContaining({ project: preview, environment: 'preview', metric: 'list_price_estimate', amount: '0.464' }),
    ]) });
    if (result.kind === 'COMPLETE') expect(result.meters.filter(m => m.metric === 'list_price_estimate')).toHaveLength(3);
  });

  it('uses monthly granularity for historical periods and preserves metered Enterprise resources without imposing public rates', async () => {
    const historical = { from: '2026-09-01', to: '2026-10-01' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async request => {
      const url = new URL(String(request));
      expect(url.searchParams.get('granularity')).toBe('monthly');
      return Response.json(url.pathname.endsWith('/branches') ? { branches: [] } : { projects: [
        neonResource(production, 'enterprise', { compute_unit_seconds: 3_600, extra_branches_month: 1_020 }, historical),
      ] });
    });
    expect(await get(neon, fetch, historical)).toEqual({ kind: 'COMPLETE', coverage: 'PARTIAL', entries: [],
      limitations: expect.arrayContaining(['NEON_MONTHLY_BRANCH_ESTIMATE_EXCLUDED']), meters: [
        expect.objectContaining({ amount: '1', metric: 'compute_unit_seconds', period: historical }),
        expect.objectContaining({ amount: '1020', metric: 'extra_branches_month', period: historical }),
      ] });
  });

  it('excludes an unexpected project and preserves the independently scoped endpoint with partial coverage', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async request => String(request).includes('/v2/projects?')
      ? Response.json({ projects: [neonResource('roundfi-project', 'launch', { compute_unit_seconds: 999 })] })
      : Response.json({ branches: [{ ...neonResource(production, 'launch', { compute_unit_seconds: 3_600 }), branch_id: 'br-fixture' }] }));
    const result = await get(neon, fetch);
    expect(result).toMatchObject({ kind: 'COMPLETE', coverage: 'PARTIAL', limitations: expect.arrayContaining(['NEON_PROJECT_METRICS_UNAVAILABLE']),
      meters: [expect.objectContaining({ project: production, amount: '1' })] });
  });

  it('rejects a repeated cursor when neither endpoint supplies validated data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async request => String(request).includes('/v2/projects?')
      ? Response.json({ projects: [], pagination: { cursor: 'same-page' } })
      : new Response('provider private message', { status: 503 }));
    await expect(get(neon, fetch)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('Railway Public GraphQL usage', () => {
  const item = (serviceId: string, measurement: string, value: number, tags: Record<string, string> = {}) =>
    ({ measurement, value, tags: { serviceId, projectId: RAILWAY_FINANCIAL_PROJECT, environmentId: RAILWAY_PRODUCTION_ENVIRONMENT, ...tags } });

  it('meters both production services, limits its query to the audited project, and separates public list prices from accounting', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (request, init) => {
      expect(String(request)).toBe('https://backboard.railway.com/graphql/v2');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: expect.stringContaining('groupBy: [PROJECT_ID, ENVIRONMENT_ID, SERVICE_ID]'), variables: {
        project: RAILWAY_FINANCIAL_PROJECT, start: midnight(period.from), end: midnight(period.to),
        measurements: expect.arrayContaining(['CPU_USAGE', 'MEMORY_USAGE_GB', 'NETWORK_TX_GB', 'DISK_USAGE_GB', 'BACKUP_USAGE_GB']),
      } });
      return Response.json({ data: { usage: [item(api, 'CPU_USAGE', 21_600), item(api, 'MEMORY_USAGE_GB', 43_200), item(api, 'DISK_USAGE_GB', 43_200),
        item(worker, 'NETWORK_TX_GB', 2), item(worker, 'NETWORK_RX_GB', 100), item(api, 'CPU_USAGE', 10_000, { environmentId: 'preview-unrelated' }),
        item(api, 'CPU_USAGE', 10_000, { projectId: 'roundfi-unrelated' }), item('another-service', 'CPU_USAGE', 10_000)] } });
    });
    const result = await get(railway, fetch);
    expect(result).toMatchObject({ kind: 'COMPLETE', coverage: 'PARTIAL', entries: [], meters: expect.arrayContaining([
      expect.objectContaining({ scope: 'railway-api', service: 'flofi-api', metric: 'list_price_estimate', amount: '20.15', basis: 'RAILWAY_CLI_5.49.1' }),
      expect.objectContaining({ scope: 'railway-worker', service: 'flofi-worker', metric: 'list_price_estimate', amount: '0.1' }),
    ]) });
    if (result.kind === 'COMPLETE') expect(result.meters).toHaveLength(7);
  });

  it('rejects duplicate metering dimensions instead of adding a second charge', async () => {
    const row = item(api, 'CPU_USAGE', 15);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: { usage: [row, row] } }));
    await expect(get(railway, fetch)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
  });

  it('exposes a fixed authentication error for a GraphQL permission failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: null, errors: [
      { message: 'Denied internal details', extensions: { code: 'FORBIDDEN' } },
    ] }));
    await expect(get(railway, fetch)).rejects.toThrow('FINOPS_PROVIDER_FORBIDDEN');
  });
});

describe('Vercel team FOCUS charges', () => {
  const row = { SubAccountId: VERCEL_FINANCIAL_TEAM, Tags: { ProjectId: VERCEL_FINANCIAL_PROJECT }, BilledCost: '1.25', BillingCurrency: 'USD',
    ChargePeriodStart: '2026-11-01T00:00:00.000Z', ChargePeriodEnd: '2026-11-02T00:00:00.000Z',
    ServiceName: 'Fluid Compute', SkuId: 'function-cpu', ConsumedQuantity: 4, ConsumedUnit: 'CPU-hours', x_CostAttribution: null };
  const response = (...rows: object[]) => new Response(rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  it('reads a scoped JSONL response, separates attribution estimates from ledger costs, and excludes unmatched projects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (request, init) => {
      const url = new URL(String(request));
      expect(url.origin + url.pathname).toBe('https://api.vercel.com/v1/billing/charges');
      expect(url.searchParams.get('teamId')).toBe(VERCEL_FINANCIAL_TEAM);
      expect(url.searchParams.get('from')).toBe(midnight(period.from));
      expect(url.searchParams.get('to')).toBe(midnight(period.to));
      expect(init?.redirect).toBe('error');
      return response(row, { ...row, ServiceName: 'Network Transfer', BilledCost: '-0.15', ConsumedQuantity: null },
        { ...row, Tags: JSON.stringify(row.Tags), ServiceName: 'Builds', x_CostAttribution: 'calibrated_estimate', BilledCost: '2' },
        { ...row, SubAccountId: 'team_unrelated', BilledCost: '100' }, { ...row, Tags: { ProjectName: 'flofi', ProjectId: 'prj_unrelated' }, BilledCost: '100' },
        { ...row, ChargePeriodEnd: '2026-11-03T00:00:00.000Z', BilledCost: '100' });
    });
    expect(await get(vercel, fetch)).toMatchObject({ kind: 'COMPLETE', coverage: 'PARTIAL',
      entries: [{ scope: 'vercel', environment: 'shared', source: 'PROVIDER_COST', net: '1.1', coverage: 'PARTIAL', period: { from: '2026-11-01', to: '2026-11-02' } }],
      meters: expect.arrayContaining([
        expect.objectContaining({ service: 'Fluid Compute', metric: 'billed_cost', unit: 'USD', amount: '1.25' }),
        expect.objectContaining({ service: 'Fluid Compute', metric: 'function-cpu', unit: 'CPU-hours', amount: '4' }),
        expect.objectContaining({ service: 'Builds', metric: 'allocated_cost_estimate', amount: '2' }),
      ]), limitations: expect.arrayContaining(['VERCEL_UNALLOCATED_CHARGES_EXCLUDED', 'VERCEL_ESTIMATED_ALLOCATIONS_EXCLUDED', 'VERCEL_NON_DAILY_CHARGES_EXCLUDED']) });
  });

  it('does not turn an empty FloFi slice into a provider cost of zero', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...row, Tags: {} }));
    expect(await get(vercel, fetch)).toMatchObject({ kind: 'COMPLETE', coverage: 'UNAVAILABLE', entries: [], meters: [] });
  });

  it('refuses uncertain exact duplicate charge rows', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(row, row));
    await expect(get(vercel, fetch)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
  });

  it.each([[401, 'FORBIDDEN'], [403, 'FORBIDDEN'], [404, 'NO_COST_DATA'], [429, 'RATE_LIMITED'], [503, 'UNAVAILABLE']])(
    'sanitizes HTTP %i without returning a monetary entry', async (status, reason) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('provider private details', { status }));
      await expect(get(vercel, fetch)).rejects.toThrow('FINOPS_PROVIDER_' + reason);
    });
});

describe('Alchemy scoped Usage Admin API', () => {
  afterEach(() => vi.useRealTimers());
  const item = (amount: string, app = 'flofi_fixture_app') => ({ startTime: '2026-11-02T00:00:00Z', endTime: '2026-11-03T00:00:00Z', isPartial: false,
    dimensions: { app }, amount, unit: 'ALCHEMY_COMPUTE_UNIT' });

  it('requests only configured apps, combines a split product bucket across pages, and stores no account-wide dollars', async () => {
    vi.setSystemTime(new Date('2026-11-09T17:00:00Z'));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (request, init) => {
      expect(String(request)).toBe('https://admin-api.alchemy.com/v1/usage/time-series');
      expect(init?.method).toBe('POST');
      const query = JSON.parse(String(init?.body));
      expect(query).toMatchObject({ startTime: '2026-11-02T00:00:00Z', endTime: '2026-11-02T23:59:59Z', granularity: 'day',
        products: ['SUPERNODE_CU', 'SUPERNODE_ENHANCED_CU'], metrics: ['amount'], filters: { appIds: ['flofi_fixture_app'] }, groupBy: ['app'] });
      if (!query.cursor) return Response.json({ data: { data: [item('12')], cursor: 'fixture_next' } });
      expect(query.cursor).toBe('fixture_next');
      return Response.json({ data: { data: [item('7.25')] } });
    });
    expect(await get(alchemy, fetch)).toEqual({ kind: 'COMPLETE', coverage: 'PARTIAL', entries: [], limitations: expect.arrayContaining([
      'ALCHEMY_UNALLOCATED_ACCOUNT_CHARGES_EXCLUDED', 'ALCHEMY_PLAN_RETENTION_PARTIAL',
    ]), meters: [{ scope: 'rpc', service: 'Alchemy RPC', environment: 'shared', project: 'flofi_fixture_app', metric: 'compute_units',
      unit: 'CU', amount: '19.25', period: { from: '2026-11-02', to: '2026-11-03' } }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unrelated or unattributed app usage', async () => {
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: { data: [item('17', 'unrelated_fixture_app')] } }));
    await expect(get(alchemy, fetch)).rejects.toThrow('FINOPS_PROVIDER_SCOPE_MISMATCH');
  });

  it('reports older periods as unavailable under plan retention without requesting unrelated summary amounts', async () => {
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await get(alchemy, fetch)).toMatchObject({ coverage: 'UNAVAILABLE', meters: [], entries: [],
      limitations: expect.arrayContaining(['ALCHEMY_PLAN_RETENTION_PARTIAL']) });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('requires separate, valid, server-side configuration for each infrastructure provider', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const adapter of infraFinancialAdapters) {
    expect(adapter.configured({})).toBe(false);
    expect(adapter.configured(env)).toBe(true);
    await expect(adapter.read({ env: { RAILWAY_TOKEN: 'unrelated-runtime-token' }, fetch, period, signal: new AbortController().signal,
      checkpoint: null })).rejects.toThrow('FINOPS_PROVIDER_NOT_CONFIGURED');
  }
  expect(fetch).not.toHaveBeenCalled();
});
