// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, contains, decimal, isoDay, periodDays, units, validateEntry, type Period } from './economics.ts';
import { openAiCostAdapter } from './providers.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';
import type { FinancialMeter } from './sync-store.ts';
import { financialInvalid, financialJson, financialObject, requestFinancial } from './sync-transport.ts';

const start = (day: string) => day + 'T00:00:00Z';
const second = (day: string) => String(Date.parse(start(day)) / 1_000);
const label = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);
function dayBucket(from: number, to: number, period: Period): Period {
  if (!Number.isSafeInteger(from) || from % 86_400 !== 0 || to - from !== 86_400) throw financialInvalid();
  const day = isoDay(new Date(from * 1_000));
  const bucket = { from: day, to: addDays(day, 1) };
  if (!contains(period, bucket)) throw financialInvalid();
  return bucket;
}
const count = (n: unknown): string => {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw financialInvalid();
  return String(n);
};

async function pages(url: URL, init: RequestInit, fetcher: typeof fetch, signal: AbortSignal, accept: (row: unknown) => void,
  meta: (page: Record<string, unknown>) => void = () => undefined) {
  const cursors = new Set<string>();
  for (let index = 0; index < 12; index++) {
    const page = financialJson(await requestFinancial(url, init, fetcher, signal));
    if (!financialObject(page) || !Array.isArray(page.data) || page.data.length > 2_000 || typeof page.has_more !== 'boolean') throw financialInvalid();
    meta(page);
    for (const result of page.data) accept(result);
    if (!page.has_more) return;
    const cursor = page.next_page;
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_=.-]{1,512}$/.test(cursor) || cursors.has(cursor)) throw financialInvalid();
    cursors.add(cursor);
    url.searchParams.set('page', cursor);
  }
  throw financialInvalid();
}

const openAiUsage = {
  completions: { model: true, fields: { num_model_requests: 'requests', input_tokens: 'tokens', output_tokens: 'tokens', input_cached_tokens: 'tokens' } },
  embeddings: { model: true, fields: { num_model_requests: 'requests', input_tokens: 'tokens' } },
  // The Images usage object reports `images` and `num_model_requests` (OpenAI Usage API reference, verified 2026-11-18).
  images: { model: true, fields: { images: 'images', num_model_requests: 'requests' } },
  code_interpreter_sessions: { model: false, fields: { num_sessions: 'sessions' } },
  vector_stores: { model: false, fields: { usage_bytes: 'bytes' } },
} as const;

const openai: FinancialSyncAdapter = {
  id: 'openai',
  configured: env => openAiCostAdapter.credentials(env) !== null,
  async read({ env, period, signal, fetch: fetcher }) {
    const credential = openAiCostAdapter.credentials(env);
    if (!credential) throw new Error('FINOPS_PROVIDER_NOT_CONFIGURED');
    const { project, key } = credential;
    const headers = { Authorization: 'Bearer ' + key };
    const meters: FinancialMeter[] = [], limitations = ['OPENAI_COSTS_PROJECT_SCOPE'];
    const entries = await openAiCostAdapter.read(credential, period, fetcher, signal);
    for (const [category, spec] of Object.entries(openAiUsage)) {
      const url = new URL('https://api.openai.com/v1/organization/usage/' + category);
      url.search = new URLSearchParams({ start_time: second(period.from), end_time: second(period.to), bucket_width: '1d',
        limit: '31', 'project_ids[]': project, 'group_by[]': 'project_id' }).toString();
      if (spec.model) url.searchParams.append('group_by[]', 'model');
      const seen = new Set<string>(), collected: FinancialMeter[] = [];
      try {
        await pages(url, { headers }, fetcher, signal, raw => {
          if (!financialObject(raw) || typeof raw.start_time !== 'number' || typeof raw.end_time !== 'number' || !Array.isArray(raw.results)
              || raw.results.length > 256) throw financialInvalid();
          const bucket = dayBucket(raw.start_time, raw.end_time, period);
          if (seen.has(bucket.from)) throw financialInvalid();
          seen.add(bucket.from);
          const models = new Set<string>();
          for (const result of raw.results) {
            if (!financialObject(result) || result.project_id !== project || spec.model && !label(result.model)) throw financialInvalid();
            const service = spec.model ? category + ':' + String(result.model) : category;
            if (models.has(service)) throw financialInvalid();
            models.add(service);
            for (const [metric, unit] of Object.entries(spec.fields)) {
              if (result[metric] === undefined || result[metric] === null) { limitations.push('OPENAI_USAGE_FIELDS_PARTIAL'); continue; }
              collected.push({ scope: 'openai', environment: 'production', project, service, metric, unit, amount: count(result[metric]), period: bucket });
            }
          }
        });
        meters.push(...collected);
      } catch { limitations.push('OPENAI_USAGE_CATEGORY_UNAVAILABLE'); }
    }
    if (!entries.length && !meters.length) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
    return { kind: 'COMPLETE', entries, meters, coverage: 'PARTIAL', limitations: [...new Set(limitations)] };
  },
};

/** Developer platform API products (Usage and Cost Analytics API `products[]`, verified 2026-11-18). */
export const ANTHROPIC_API_PRODUCTS = Object.freeze(['messages_api', 'message_batches_api', 'managed_agents_api'] as const);

const anthropic: FinancialSyncAdapter = {
  id: 'anthropic',
  configured: env => Boolean(env.FLOFI_FINOPS_ANTHROPIC_ADMIN_KEY && /^wrkspc_[A-Za-z0-9_-]{1,100}$/.test(env.FLOFI_FINOPS_ANTHROPIC_WORKSPACE_ID ?? '')),
  async read({ env, period, signal, fetch: fetcher }) {
    const project = env.FLOFI_FINOPS_ANTHROPIC_WORKSPACE_ID;
    if (!project || !anthropic.configured(env)) throw new Error('FINOPS_PROVIDER_NOT_CONFIGURED');
    const headers = { 'x-api-key': env.FLOFI_FINOPS_ANTHROPIC_ADMIN_KEY!, 'anthropic-version': '2026-10-21',
      'anthropic-beta': 'analytics-usage-cost-2026-08-24' };
    const costs = new Map<string, bigint>(), meters: FinancialMeter[] = [], seen = new Set<string>();
    const limitations = ['ANTHROPIC_COSTS_BEFORE_CREDITS'];
    // Rows beyond the export watermark are incomplete (data is typically refreshed every four hours).
    let refreshed: number | null = null;
    for (const type of ['cost', 'usage'] as const) {
      const url = new URL('https://api.anthropic.com/v1/organizations/analytics/' + type);
      url.search = new URLSearchParams({ starting_at: start(period.from), ending_at: start(period.to), time_bucket_width: '1d',
        limit: '500', 'workspace_ids[]': project, 'group_by[]': 'workspace_id' }).toString();
      url.searchParams.append('group_by[]', 'model');
      url.searchParams.append('group_by[]', 'product');
      if (type === 'cost') url.searchParams.append('group_by[]', 'cost_type');
      for (const product of ANTHROPIC_API_PRODUCTS) url.searchParams.append('products[]', product);
      await pages(url, { headers }, fetcher, signal, raw => {
        if (!financialObject(raw) || !financialObject(raw.group) || typeof raw.starting_at !== 'string' || typeof raw.ending_at !== 'string') throw financialInvalid();
        const { workspace_id, product, model, cost_type } = raw.group;
        if (workspace_id !== project) { limitations.push('ANTHROPIC_UNATTRIBUTED_WORKSPACE_EXCLUDED'); return; }
        // Only the developer platform's API products are FloFi's operating cost. Seats, Chat, Claude Code, Console and other
        // surfaces are excluded even if the filter were ignored. A null product (code execution) belongs to the API request.
        if (product !== null && !(ANTHROPIC_API_PRODUCTS as readonly unknown[]).includes(product)) {
          limitations.push('ANTHROPIC_NON_API_PRODUCTS_EXCLUDED');
          return;
        }
        const bucket = dayBucket(Date.parse(raw.starting_at) / 1_000, Date.parse(raw.ending_at) / 1_000, period);
        if (model !== null && !label(model)) throw financialInvalid();
        const service = model === null ? 'Unattributed model' : String(model);
        // A null cost type is unattributed like a null product; a missing or non-label value is not a cost dimension.
        const dimensions = type !== 'cost' ? '' : cost_type === null ? 'unattributed' : label(cost_type) ? cost_type : null;
        if (dimensions === null) throw financialInvalid();
        const identity = JSON.stringify([type, bucket.from, product, service, dimensions]);
        if (seen.has(identity)) throw financialInvalid();
        seen.add(identity);
        const add = (metric: string, unit: string, amount: string) =>
          meters.push({ scope: 'anthropic', environment: 'production', project, service,
            metric, unit, amount, period: bucket, basis: [product ?? 'unattributed', dimensions].filter(Boolean).join(':') });
        if (type === 'cost') {
          const cost = raw.cost;
          if (!financialObject(cost) || cost.currency !== 'USD' || typeof cost.amount !== 'string' || !/^-?\d{1,12}(\.\d{1,6})?$/.test(cost.amount))
            throw financialInvalid();
          // Source amounts have six decimals in cents. Eight decimals in USD
          // preserves the full source precision without floating point.
          const amount = units(cost.amount) / 100n;
          costs.set(bucket.from, (costs.get(bucket.from) ?? 0n) + amount);
          add('provider_cost', 'USD', decimal(amount));
          return;
        }
        const usage = raw.usage;
        if (!financialObject(usage)) throw financialInvalid();
        for (const metric of ['uncached_input_tokens', 'output_tokens', 'cache_read_input_tokens', 'requests', 'total_tokens']) {
          if (usage[metric] !== undefined && usage[metric] !== null) add(metric, metric === 'requests' ? 'requests' : 'tokens', count(usage[metric]));
        }
        if (financialObject(usage.cache_creation)) for (const metric of ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens']) {
          if (usage.cache_creation[metric] !== undefined) add(metric, 'tokens', count(usage.cache_creation[metric]));
        }
        if (financialObject(usage.server_tool_use) && usage.server_tool_use.web_search_requests !== undefined)
          add('web_search_requests', 'requests', count(usage.server_tool_use.web_search_requests));
      }, page => {
        const at = page.data_refreshed_at;
        if (at === null || at === undefined) return;
        if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw financialInvalid();
        refreshed = refreshed === null ? Date.parse(at) : Math.min(refreshed, Date.parse(at));
      });
    }
    const complete = (bucket: Period) => refreshed !== null && Date.parse(start(bucket.to)) <= refreshed;
    if ([...costs.keys()].some(day => !complete({ from: day, to: addDays(day, 1) })) || meters.some(m => !complete(m.period))) {
      limitations.push('ANTHROPIC_DAYS_AFTER_EXPORT_WATERMARK_EXCLUDED');
      for (const day of [...costs.keys()]) if (!complete({ from: day, to: addDays(day, 1) })) costs.delete(day);
      meters.splice(0, meters.length, ...meters.filter(m => complete(m.period)));
    }
    const entries = [...costs.entries()].map(([day, amount]) => validateEntry({ scope: 'anthropic', environment: 'production', start: day, end: addDays(day, 1),
      source: 'PROVIDER_COST', reference: 'Anthropic workspace cost analytics before credits', currency: 'USD', net: decimal(amount), coverage: 'PARTIAL' }, true));
    if (!entries.length && !meters.length) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
    if (costs.size < periodDays(period)) limitations.push('ANTHROPIC_CLOSED_DAY_COVERAGE_PARTIAL');
    return { kind: 'COMPLETE', entries, meters, coverage: 'PARTIAL', limitations: [...new Set(limitations)] };
  },
};

export const aiFinancialAdapters = [openai, anthropic] as const;
