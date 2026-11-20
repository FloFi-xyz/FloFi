// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, contains, decimal, divide, isoDay, periodDays, units, validDay, validateEntry, type Entry, type Period } from './economics.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';
import type { FinancialMeter, FinancialSyncResult } from './sync-store.ts';
import { financialJson, financialObject as record, requestFinancial } from './sync-transport.ts';

type ProviderRead = Parameters<FinancialSyncAdapter['read']>[0];
type Env = ProviderRead['env'];
type ProviderResult = Extract<FinancialSyncResult, { kind: 'COMPLETE' }>;
type MeterId = Pick<FinancialMeter, 'scope' | 'environment' | 'project' | 'service'>;
const invalid = (): never => { throw Error('FINOPS_PROVIDER_RESPONSE_INVALID'); };
const scoped = (): never => { throw Error('FINOPS_PROVIDER_SCOPE_MISMATCH'); };
const credential = (value: string | undefined) => value && /^[!-~]{1,1024}$/.test(value) ? value : null;
function required(value: string | undefined): string {
  const key = credential(value);
  if (!key) throw Error('FINOPS_PROVIDER_NOT_CONFIGURED');
  return key;
}
const bearer = (value: string) => ({ Authorization: 'Bearer ' + value });
const dateTime = (day: string) => day + 'T00:00:00Z';
function boundary(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,9})?Z$/.test(value) || !validDay(value.slice(0, 10))) return invalid();
  return value.slice(0, 10);
}
function amountString(value: number, allowNegative = false): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 10_000_000_000 || (value < 0 && !allowNegative)) return invalid();
  return value.toFixed(8).replace(/\.?0+$/, '').replace(/^-0$/, '0');
}
function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return invalid();
  return value;
}
function meter(id: MeterId, period: Period, metric: string, unit: string, value: number, basis?: string): FinancialMeter {
  return { ...id, period, metric, unit, amount: amountString(value, unit === 'USD'), ...(basis ? { basis } : {}) };
}
function complete(entries: Entry[], meters: FinancialMeter[], limitations: readonly string[]): ProviderResult {
  return { kind: 'COMPLETE', entries, meters, coverage: entries.length || meters.length ? 'PARTIAL' : 'UNAVAILABLE', limitations };
}

export const NEON_FINANCIAL_ORG = 'org-odd-block-82235574';
// Explicit scope from Neon project discovery and the FloFi release/preview runbooks.
export const NEON_FINANCIAL_PROJECTS = {
  'wandering-mode-28938220': 'production',
  'cool-meadow-65373994': 'preview',
  'frosty-grass-75768827': 'preview',
  'mute-bird-69509890': 'preview',
} as const;
const NEON_PROJECT_IDS = Object.keys(NEON_FINANCIAL_PROJECTS);
const BILLION = 1_000_000_000;
const NEON_METRICS = {
  compute_unit_seconds: ['CU-hour', 3_600],
  root_branch_bytes_month: ['GB-month', BILLION],
  child_branch_bytes_month: ['GB-month', BILLION],
  instant_restore_bytes_month: ['GB-month', BILLION],
  snapshot_storage_bytes_month: ['GB-month', BILLION],
  public_network_transfer_bytes: ['GB', BILLION],
  private_network_transfer_bytes: ['GB', BILLION],
  extra_branches_month: ['branch-hour', 1],
  functions_active_capacity_microseconds: ['capacity-hour', 3_600 * 1_000_000],
  functions_waiting_capacity_microseconds: ['capacity-hour', 3_600 * 1_000_000],
  functions_invocations: ['million-invocations', 1_000_000],
  functions_egress_bytes: ['GB', BILLION],
} as const;
type NeonMetric = keyof typeof NEON_METRICS;
const NEON_BRANCH_METRICS = Object.keys(NEON_METRICS).filter(name => name !== 'extra_branches_month' && name !== 'snapshot_storage_bytes_month');
type NeonBucket = { period: Period; plan: string; meters: Partial<Record<NeonMetric, number>> };
type NeonResource = { project: keyof typeof NEON_FINANCIAL_PROJECTS; branch: string | null; buckets: NeonBucket[] };
function neonPage(payload: unknown, kind: 'projects' | 'branches', requested: Period) {
  if (!record(payload) || !Array.isArray(payload[kind]) || payload[kind].length > 100) return invalid();
  const resources: NeonResource[] = [];
  for (const row of payload[kind] as unknown[]) {
    if (!record(row) || typeof row.project_id !== 'string' || !Array.isArray(row.periods) || row.periods.length > 12) return invalid();
    const project = row.project_id as NeonResource['project'];
    if (!Object.hasOwn(NEON_FINANCIAL_PROJECTS, project)) return scoped();
    const branch = kind === 'branches' ? row.branch_id : null;
    if (kind === 'branches' && (typeof branch !== 'string' || !/^br-[a-z0-9-]{1,75}$/.test(branch))) return invalid();
    const buckets: NeonBucket[] = [];
    for (const window of row.periods as unknown[]) {
      if (!record(window) || typeof window.period_plan !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(window.period_plan)
          || !Array.isArray(window.consumption) || window.consumption.length > 32) return invalid();
      for (const datum of window.consumption as unknown[]) {
        if (!record(datum) || !Array.isArray(datum.metrics) || datum.metrics.length > 24) return invalid();
        const period = { from: boundary(datum.timeframe_start), to: boundary(datum.timeframe_end) };
        if (period.from >= period.to || !contains(requested, period) || buckets.some(b => b.period.from < period.to && period.from < b.period.to)) return invalid();
        const meters: NeonBucket['meters'] = {};
        for (const raw of datum.metrics as unknown[]) {
          if (!record(raw) || typeof raw.metric_name !== 'string') return invalid();
          if (!Object.hasOwn(NEON_METRICS, raw.metric_name)) continue;
          const key = raw.metric_name as NeonMetric;
          if (meters[key] !== undefined) return invalid();
          meters[key] = quantity(raw.value);
        }
        buckets.push({ period, plan: window.period_plan, meters });
      }
    }
    resources.push({ project, branch: typeof branch === 'string' ? branch : null, buckets });
  }
  if (payload.pagination !== undefined && payload.pagination !== null && !record(payload.pagination)) return invalid();
  const cursor = record(payload.pagination) ? payload.pagination.cursor : null;
  if (cursor != null && (typeof cursor !== 'string' || cursor.length > 512 || !/^[!-~]+$/.test(cursor))) return invalid();
  return { resources, cursor: cursor ?? null };
}

async function neonResources(input: ProviderRead, key: string, kind: 'projects' | 'branches') {
  const url = new URL('https://console.neon.tech/api/v2/consumption_history/v2/' + kind);
  url.search = new URLSearchParams({
    org_id: NEON_FINANCIAL_ORG, project_ids: NEON_PROJECT_IDS.join(','), from: dateTime(input.period.from), to: dateTime(input.period.to),
    // Full calendar months can reach beyond the daily API's 60-day lookback.
    granularity: input.period.from.endsWith('-01') && input.period.to.endsWith('-01') ? 'monthly' : 'daily',
    metrics: (kind === 'projects' ? Object.keys(NEON_METRICS) : NEON_BRANCH_METRICS).join(','),
    limit: kind === 'projects' ? '20' : '15',
  }).toString();
  const items = new Map<string, NeonResource>(), seenCursors = new Set<string>();
  for (let page = 0; page < 4; page++) {
    const raw = await requestFinancial(url, { headers: bearer(key) }, input.fetch, input.signal, 750_000).catch((cause: unknown) => {
      // Consumption Metrics v2 returns 404 when the caller cannot access the org.
      if (cause instanceof Error && cause.message === 'FINOPS_PROVIDER_NO_COST_DATA') throw new Error('FINOPS_PROVIDER_ACCESS_DENIED', { cause });
      throw cause;
    });
    const result = neonPage(financialJson(raw), kind, input.period);
    for (const item of result.resources) {
      const id = item.project + ':' + (item.branch ?? '');
      if (items.has(id)) return invalid();
      items.set(id, item);
    }
    if (result.cursor === null) return { items: [...items.values()], truncated: false };
    if (seenCursors.has(result.cursor)) return invalid();
    seenCursors.add(result.cursor);
    url.searchParams.set('cursor', result.cursor);
  }
  return { items: [...items.values()], truncated: true };
}

const NEON_RATES = {
  launch: { compute: 0.106, privateGb: null, includedChildren: 9, active: 0.10, waiting: 0.025 },
  scale: { compute: 0.222, privateGb: 0.01, includedChildren: 24, active: 0.12, waiting: 0.03 },
  agent: { compute: 0.106, privateGb: 0.01, includedChildren: 24, active: 0.12, waiting: 0.03 },
} as const;
// November 2026 published list-price schedule. Compute rates took effect 2025-11-03;
// paid public egress allowance became 500 GB per project on 2026-06-01.
function neonEstimate(buckets: NeonBucket[], requested: Period): { database: number; functions: number; databaseMeasured: boolean; functionsMeasured: boolean } | null {
  if (requested.from < '2026-06-01' || !buckets.length) return null;
  const plan = buckets[0]!.plan;
  if (!Object.hasOwn(NEON_RATES, plan) || buckets.some(b => b.plan !== plan)) return null;
  const rates = NEON_RATES[plan as keyof typeof NEON_RATES];
  const total = (key: NeonMetric) => buckets.reduce((sum, bucket) => sum + (bucket.meters[key] ?? 0), 0) / NEON_METRICS[key][1];
  const covered = (keys: readonly NeonMetric[]) => buckets.some(b => keys.some(key => b.meters[key] !== undefined));
  // Branch charges are calculated using day buckets only. A monthly average
  // can hide a day above the free concurrency allowance.
  const billableBranches = buckets.filter(b => periodDays(b.period) === 1).reduce((sum, b) =>
    sum + Math.max(0, (b.meters.extra_branches_month ?? 0) - rates.includedChildren * 24), 0);
  return {
    database: total('compute_unit_seconds') * rates.compute
      + (total('root_branch_bytes_month') + total('child_branch_bytes_month')) * 0.35
      + total('instant_restore_bytes_month') * 0.20 + total('snapshot_storage_bytes_month') * 0.09
      + Math.max(0, total('public_network_transfer_bytes') - 500) * 0.10
      + total('private_network_transfer_bytes') * (rates.privateGb ?? 0) + billableBranches / 744 * 1.50,
    functions: total('functions_active_capacity_microseconds') * rates.active
      + total('functions_waiting_capacity_microseconds') * rates.waiting + total('functions_invocations') * 0.60,
    databaseMeasured: covered(['compute_unit_seconds', 'root_branch_bytes_month', 'child_branch_bytes_month', 'instant_restore_bytes_month',
      'snapshot_storage_bytes_month', 'public_network_transfer_bytes']),
    functionsMeasured: covered(['functions_active_capacity_microseconds', 'functions_waiting_capacity_microseconds', 'functions_invocations']),
  };
}

function neonMeters(resource: NeonResource, requested: Period) {
  const values = new Map<NeonMetric, number>();
  for (const bucket of resource.buckets) {
    for (const key of Object.keys(bucket.meters) as NeonMetric[]) values.set(key, (values.get(key) ?? 0) + bucket.meters[key]!);
  }
  const id: MeterId = { scope: 'neon-postgres', environment: NEON_FINANCIAL_PROJECTS[resource.project], project: resource.project,
    service: resource.branch === null ? 'postgresql' : 'branch:' + resource.branch };
  const meters = [...values].map(([key, raw]) => {
    const [unit, divisor] = NEON_METRICS[key];
    const target: MeterId = key.startsWith('functions_') && resource.branch === null ? { ...id, scope: 'neon-storage', service: 'functions' } : id;
    return meter(target, requested, key, unit, raw / divisor);
  });
  const estimate = resource.branch === null ? neonEstimate(resource.buckets, requested) : null;
  const basis = 'NEON_RATE_2026-11-18';
  if (estimate?.databaseMeasured) meters.push(meter(id, requested, 'list_price_estimate', 'USD', estimate.database, basis));
  if (estimate?.functionsMeasured) meters.push(meter({ ...id, service: 'functions', scope: 'neon-storage' }, requested, 'list_price_estimate', 'USD', estimate.functions, basis));
  return meters;
}

const neon: FinancialSyncAdapter = {
  id: 'neon',
  configured: (env: Env) => credential(env.FLOFI_FINOPS_NEON_API_KEY) !== null,
  async read(input) {
    const key = required(input.env.FLOFI_FINOPS_NEON_API_KEY);
    const [projects, branches] = await Promise.allSettled([neonResources(input, key, 'projects'), neonResources(input, key, 'branches')]);
    if (projects.status === 'rejected' && branches.status === 'rejected') throw projects.reason;
    const limitations = ['NEON_LIST_PRICE_2026_11', 'NEON_INVOICE_AND_OBJECT_STORAGE_UNAVAILABLE', 'NEON_BRANCH_METERS_OVERLAP_PROJECT_TOTALS'];
    if (projects.status === 'rejected') limitations.push('NEON_PROJECT_METRICS_UNAVAILABLE');
    if (branches.status === 'rejected' || branches.value.truncated) limitations.push('NEON_BRANCH_COVERAGE_PARTIAL');
    if (projects.status === 'fulfilled' && projects.value.items.length < NEON_PROJECT_IDS.length) limitations.push('NEON_PROJECT_COVERAGE_PARTIAL');
    if (input.period.to.endsWith('-01')) limitations.push('NEON_MONTHLY_BRANCH_ESTIMATE_EXCLUDED');
    const resources = [projects, branches].flatMap(result => result.status === 'fulfilled' ? result.value.items : []);
    return complete([], resources.flatMap(resource => neonMeters(resource, input.period)), limitations);
  },
};

export const RAILWAY_FINANCIAL_PROJECT = 'e0ea4b67-f266-48e9-bab9-a7e5dfe55887';
export const RAILWAY_PRODUCTION_ENVIRONMENT = 'f73761bc-42aa-48f2-9caa-2026abbf7188';
const RAILWAY_FINANCIAL_SERVICES = {
  'd56aa713-6ce6-487a-923e-effce2dc950c': ['railway-api', 'flofi-api'],
  '5379d4b0-ea9d-4775-a369-34fa526968db': ['railway-worker', 'flofi-worker'],
} as const;
const RAILWAY_METRICS = {
  CPU_USAGE: ['vCPU-minute', 20 / 43_200],
  MEMORY_USAGE_GB: ['GB-minute', 10 / 43_200],
  NETWORK_TX_GB: ['GB', 0.05],
  NETWORK_RX_GB: ['GB', null],
  DISK_USAGE_GB: ['GB-minute', 0.15 / 43_200],
  BACKUP_USAGE_GB: ['GB-minute', 0.15 / 43_200],
  EPHEMERAL_DISK_USAGE_GB: ['GB-minute', null],
} as const;
type RailwayMetric = keyof typeof RAILWAY_METRICS;
const RAILWAY_USAGE_QUERY = `query FloFiUsage($project: String!, $start: DateTime!, $end: DateTime!, $measurements: [MetricMeasurement!]!) {
  usage(projectId: $project, startDate: $start, endDate: $end, measurements: $measurements,
    groupBy: [PROJECT_ID, ENVIRONMENT_ID, SERVICE_ID], includeDeleted: true) {
    measurement value tags { projectId environmentId serviceId }
  }
}`;
function railwayMeters(payload: unknown, period: Period): FinancialMeter[] {
  if (!record(payload)) return invalid();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    const denied = payload.errors.some(e => record(e) && (record(e.extensions) && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(String(e.extensions.code))
      || typeof e.message === 'string' && /unauthorized|not authorized|forbidden|permission denied|not authenticated/i.test(e.message)));
    const limited = payload.errors.some(e => record(e) && typeof e.message === 'string' && /^Too many usage queries are running at once\./.test(e.message));
    throw Error(denied ? 'FINOPS_PROVIDER_FORBIDDEN' : limited ? 'FINOPS_PROVIDER_RATE_LIMITED' : 'FINOPS_PROVIDER_RESPONSE_INVALID');
  }
  if (!record(payload.data) || !Array.isArray(payload.data.usage) || payload.data.usage.length > 10_000) return invalid();
  const meters: FinancialMeter[] = [];
  const usageByMetric = new Map<string, { serviceId: keyof typeof RAILWAY_FINANCIAL_SERVICES; metric: RailwayMetric; usage: number }>();
  const estimates = new Map<string, { id: MeterId; cost: number }>();
  for (const value of payload.data.usage as unknown[]) {
    if (!record(value) || !record(value.tags) || typeof value.measurement !== 'string') return invalid();
    const { serviceId, environmentId, projectId } = value.tags;
    if (environmentId !== RAILWAY_PRODUCTION_ENVIRONMENT || projectId !== RAILWAY_FINANCIAL_PROJECT || typeof serviceId !== 'string'
        || !Object.hasOwn(RAILWAY_FINANCIAL_SERVICES, serviceId)) continue;
    if (!Object.hasOwn(RAILWAY_METRICS, value.measurement)) continue;
    const metric = value.measurement as RailwayMetric, key = serviceId + ':' + metric;
    // The live Railway resolver emits additive fragments even with identical requested tags.
    // Collapse them before creating the unique snapshot meter, retaining the exact production scope.
    usageByMetric.set(key, { serviceId: serviceId as keyof typeof RAILWAY_FINANCIAL_SERVICES, metric,
      usage: quantity((usageByMetric.get(key)?.usage ?? 0) + quantity(value.value)) });
  }
  for (const { serviceId, metric, usage } of usageByMetric.values()) {
    const [scope, service] = RAILWAY_FINANCIAL_SERVICES[serviceId];
    const [unit, rate] = RAILWAY_METRICS[metric];
    const id: MeterId = { scope, service, project: RAILWAY_FINANCIAL_PROJECT, environment: 'production' };
    meters.push(meter(id, period, metric, unit, usage));
    if (rate !== null) estimates.set(serviceId, { id, cost: (estimates.get(serviceId)?.cost ?? 0) + usage * rate });
  }
  // Public Railway CLI v5.49.1 rates estimate scoped resources. Workspace
  // allowance, subscription, negotiated prices and invoices are unallocated.
  return [...meters, ...[...estimates.values()].map(({ id, cost }) => meter(id, period, 'list_price_estimate', 'USD', cost, 'RAILWAY_CLI_5.49.1'))];
}

const railway: FinancialSyncAdapter = {
  id: 'railway',
  configured: (env: Env) => credential(env.FLOFI_FINOPS_RAILWAY_API_TOKEN) !== null,
  async read(input) {
    const key = required(input.env.FLOFI_FINOPS_RAILWAY_API_TOKEN);
    const raw = await requestFinancial(new URL('https://backboard.railway.com/graphql/v2'), {
      headers: { ...bearer(key), 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify({ query: RAILWAY_USAGE_QUERY, variables: { project: RAILWAY_FINANCIAL_PROJECT,
        start: dateTime(input.period.from), end: dateTime(input.period.to), measurements: Object.keys(RAILWAY_METRICS) } }),
    }, input.fetch, input.signal, 1_000_000);
    return complete([], railwayMeters(financialJson(raw), input.period), ['RAILWAY_LIST_PRICE_CLI_5_49_1', 'RAILWAY_WORKSPACE_BILLING_UNALLOCATED']);
  },
};

export const VERCEL_FINANCIAL_TEAM = 'team_absG3FziUYYbVkInIRrJDUYU';
export const VERCEL_FINANCIAL_PROJECT = 'prj_2fqdtcn7AUVmGxGswx6OAAIleIe6';
function providerLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,73}$/.test(value) ? value : fallback;
}
function vercelTags(value: unknown): Record<string, unknown> | null {
  if (record(value)) return value;
  if (typeof value !== 'string' || !value.startsWith('{') || value.length > 8_000) return null;
  const decoded = financialJson(value);
  return record(decoded) ? decoded : null;
}

/** Keep source precision until posting to the ledger's eight-decimal scale. */
function vercelCost(value: unknown): bigint {
  if (typeof value !== 'string') return invalid();
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,16}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value);
  if (!match) return invalid();
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const scale = 16 - fraction.length + Number(exponent);
  if (scale < 0 || scale > 25) return invalid();
  const cost = BigInt(whole! + fraction) * 10n ** BigInt(scale);
  if (cost >= 10n ** 26n) return invalid();
  return sign === '-' ? -cost : cost;
}
const vercelLedgerAmount = (cost: bigint) => decimal(divide(cost, 100_000_000n));

function vercelResult(raw: string, period: Period) {
  const rows = raw.split(/\r?\n/);
  if (rows.length > 30_000) return invalid();
  const daily = new Map<string, { currency: string; cost: bigint }>();
  const sums = new Map<string, { service: string; metric: string; unit: string; total: number }>();
  const moneySums = new Map<string, { service: string; metric: string; total: bigint }>();
  const seen = new Set<string>();
  let sharedExcluded = false, estimatedExcluded = false, nonDailyExcluded = false;
  const add = (service: string, metric: string, unit: string, amount: number) => {
    const key = [service, metric, unit].join('|');
    if (sums.size + moneySums.size >= 300 && !sums.has(key)) return invalid();
    sums.set(key, { service, metric, unit, total: (sums.get(key)?.total ?? 0) + amount });
  };
  const addMoney = (service: string, metric: string, amount: bigint) => {
    const key = [service, metric].join('|');
    if (sums.size + moneySums.size >= 300 && !moneySums.has(key)) return invalid();
    moneySums.set(key, { service, metric, total: (moneySums.get(key)?.total ?? 0n) + amount });
  };
  for (const line of rows) {
    if (!line.trim()) continue;
    if (line.length > 32_768) return invalid();
    // The documented format is a decimal string. Preserve numeric JSON tokens
    // verbatim as well, using the pinned Node runtime's reviver source.
    const row = financialJson(line, (key, value: unknown, context?: { source?: string }) =>
      key === 'BilledCost' && typeof value === 'number' ? context?.source : value);
    if (!record(row)) return invalid();
    if (row.SubAccountId !== VERCEL_FINANCIAL_TEAM || vercelTags(row.Tags)?.ProjectId !== VERCEL_FINANCIAL_PROJECT) { sharedExcluded = true; continue; }
    const from = boundary(row.ChargePeriodStart), to = boundary(row.ChargePeriodEnd);
    if (to !== addDays(from, 1) || !contains(period, { from, to })) { nonDailyExcluded = true; continue; }
    if (typeof row.BillingCurrency !== 'string' || !/^[A-Z]{3}$/.test(row.BillingCurrency)) return invalid();
    const cost = vercelCost(row.BilledCost), currency = row.BillingCurrency;
    // The stream has no charge-ID field. A duplicate complete row is
    // ambiguous, so refuse the snapshot instead of recording it twice.
    const identity = JSON.stringify(Object.keys(row).sort().map(key => [key, key === 'BilledCost' ? cost.toString() : row[key]]));
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    const service = providerLabel(row.ServiceName, 'Vercel');
    const resource = providerLabel(row.SkuId, 'usage');
    if (row.ConsumedQuantity !== null && row.ConsumedQuantity !== undefined) {
      const unit = providerLabel(row.ConsumedUnit, '');
      if (!unit) return invalid();
      const consumed = typeof row.ConsumedQuantity === 'string' && /^\d{1,16}(?:\.\d{1,16})?$/.test(row.ConsumedQuantity)
        ? Number(row.ConsumedQuantity) : row.ConsumedQuantity;
      add(service, resource, unit, quantity(consumed));
    }
    if (row.x_CostAttribution != null) {
      estimatedExcluded = true;
      if (currency === 'USD' && ['calibrated_estimate', 'uncalibrated_estimate'].includes(String(row.x_CostAttribution))) addMoney(service, 'allocated_cost_estimate', cost);
      continue;
    }
    const prior = daily.get(from);
    if (prior && prior.currency !== currency) return invalid();
    daily.set(from, { currency, cost: (prior?.cost ?? 0n) + cost });
    if (currency === 'USD') addMoney(service, 'billed_cost', cost);
  }
  const entries = [...daily].map(([start, day]) => validateEntry({ scope: 'vercel', environment: 'shared', start, end: addDays(start, 1),
    source: 'PROVIDER_COST', reference: 'Vercel FOCUS v1.3 project-attributed BilledCost', currency: day.currency, net: vercelLedgerAmount(day.cost), coverage: 'PARTIAL' }, true));
  const id = { scope: 'vercel', project: VERCEL_FINANCIAL_PROJECT, environment: 'shared' } as const;
  const meters = [...sums.values()].map(({ service, metric, unit, total }) => meter({ ...id, service }, period, metric, unit, total));
  for (const { service, metric, total } of moneySums.values()) {
    meters.push({ ...id, service, period, metric, unit: 'USD', amount: vercelLedgerAmount(total) });
  }
  return complete(entries, meters, ['VERCEL_PROJECT_FOCUS_ONLY',
    ...sharedExcluded ? ['VERCEL_UNALLOCATED_CHARGES_EXCLUDED'] : [],
    ...estimatedExcluded ? ['VERCEL_ESTIMATED_ALLOCATIONS_EXCLUDED'] : [],
    ...nonDailyExcluded ? ['VERCEL_NON_DAILY_CHARGES_EXCLUDED'] : []]);
}

function vercelNotFound(body: string) {
  const payload = financialJson(body);
  if (!record(payload) || !record(payload.error)) return 'FINOPS_PROVIDER_RESPONSE_INVALID';
  const { code, message } = payload.error;
  if (code === 'plan_not_found' || typeof message === 'string' && message.trim().toLowerCase() === 'plan not found') return 'FINOPS_PROVIDER_NOT_ENTITLED';
  if (code === 'costs_not_found') return 'FINOPS_PROVIDER_NO_COST_DATA';
  return 'FINOPS_PROVIDER_RESPONSE_INVALID';
}

const vercel: FinancialSyncAdapter = {
  id: 'vercel',
  configured: (env: Env) => credential(env.FLOFI_FINOPS_VERCEL_BILLING_TOKEN) !== null,
  async read(input) {
    const key = required(input.env.FLOFI_FINOPS_VERCEL_BILLING_TOKEN);
    const url = new URL('https://api.vercel.com/v1/billing/charges');
    url.search = new URLSearchParams({ teamId: VERCEL_FINANCIAL_TEAM, from: dateTime(input.period.from), to: dateTime(input.period.to) }).toString();
    const raw = await requestFinancial(url, { headers: bearer(key) }, input.fetch, input.signal, 3_000_000, vercelNotFound);
    return vercelResult(raw, input.period);
  },
};

function alchemyConfig(env: Env) {
  const key = credential(env.FLOFI_FINOPS_ALCHEMY_USAGE_KEY);
  const ids = env.FLOFI_FINOPS_ALCHEMY_APP_IDS?.split(',').map(value => value.trim()) ?? [];
  const days = env.FLOFI_FINOPS_ALCHEMY_LOOKBACK_DAYS ?? '7';
  if (!key || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length || !ids.every(id => /^[A-Za-z0-9_-]{1,80}$/.test(id))
      || !['1', '7', '90'].includes(days)) return null;
  return { key, ids, lookbackDays: Number(days) };
}

async function alchemyWindow(input: ProviderRead, key: string, ids: readonly string[], window: Period): Promise<FinancialMeter[]> {
  const endpoint = new URL('https://admin-api.alchemy.com/v1/usage/time-series');
  const headers = { ...bearer(key), 'Content-Type': 'application/json' };
  const request = { startTime: dateTime(window.from), endTime: addDays(window.to, -1) + 'T23:59:59Z',
    granularity: 'day', products: ['SUPERNODE_CU'], metrics: ['amount'], filters: { appIds: ids }, groupBy: ['app'] };
  const buckets = new Map<string, { id: MeterId; period: Period; amount: bigint }>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const text = await requestFinancial(endpoint, { headers, method: 'POST', body: JSON.stringify({ ...request, ...(cursor ? { cursor } : {}) }) },
      input.fetch, input.signal);
    const result = financialJson(text);
    if (!record(result) || !record(result.data) || !Array.isArray(result.data.data) || result.data.data.length > 1_000) return invalid();
    const data = result.data;
    for (const row of data.data as unknown[]) {
      if (!record(row) || !record(row.dimensions) || typeof row.isPartial !== 'boolean') return invalid();
      const app = row.dimensions.app;
      if (typeof app !== 'string' || !ids.includes(app)) return scoped();
      if (row.isPartial) continue;
      const period = { from: boundary(row.startTime), to: boundary(row.endTime) };
      if (period.to !== addDays(period.from, 1) || !contains(window, period) || row.unit !== 'ALCHEMY_COMPUTE_UNIT'
          || typeof row.amount !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,8})?$/.test(row.amount)) return invalid();
      const identity = app + ':' + period.from;
      const id: MeterId = { scope: 'rpc', environment: 'shared', project: app, service: 'Alchemy RPC' };
      // The API documents that the same product bucket may continue on another
      // page. Sum aligned group values only after validating every page.
      buckets.set(identity, { id, period, amount: (buckets.get(identity)?.amount ?? 0n) + units(row.amount) });
    }
    if (data.cursor == null) return [...buckets.values()].map(({ id, period, amount }) =>
      ({ ...id, period, metric: 'compute_units', unit: 'CU', amount: decimal(amount), basis: 'SUPERNODE_CU' }));
    if (typeof data.cursor !== 'string' || !/^[!-~]{1,512}$/.test(data.cursor) || cursors.has(data.cursor)) return invalid();
    cursor = data.cursor;
    cursors.add(cursor);
  }
  return invalid();
}

const alchemy: FinancialSyncAdapter = {
  id: 'alchemy',
  configured: (env: Env) => alchemyConfig(env) !== null,
  async read(input) {
    const config = alchemyConfig(input.env);
    if (!config) throw Error('FINOPS_PROVIDER_NOT_CONFIGURED');
    // The Free plan does not provide the app breakdown needed to attribute CUs.
    if (config.lookbackDays === 1) throw Error('FINOPS_PROVIDER_NOT_ENTITLED');
    const today = isoDay(new Date()), cutoff = addDays(today, -config.lookbackDays);
    const from = input.period.from < cutoff ? cutoff : input.period.from;
    const to = input.period.to > today ? today : input.period.to;
    const limitations = ['ALCHEMY_APP_USAGE_ONLY', 'ALCHEMY_UNALLOCATED_ACCOUNT_CHARGES_EXCLUDED'];
    if (from !== input.period.from || to !== input.period.to) limitations.push('ALCHEMY_PLAN_RETENTION_PARTIAL');
    if (from >= to) return complete([], [], limitations);
    const split = addDays(from, 30);
    const spans = split < to ? [{ from, to: split }, { from: split, to }] : [{ from, to }];
    const results = await Promise.all(spans.map(window => alchemyWindow(input, config.key, config.ids, window)));
    return complete([], results.flat(), limitations);
  },
};

export const infraFinancialAdapters = [neon, railway, vercel, alchemy] as const;
