// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, contains, decimal, isoDay, periodDays, units, validateEntry, type Entry, type Period, type ScopeId } from './economics.ts';
import { retryAfterSeconds } from '../../server/copilot-service.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Credentials = { readonly key: string; readonly project: string };
type BillingAdapter = {
  readonly scope: ScopeId;
  readonly credentials: (env: Env) => Credentials | null;
  readonly read: (credentials: Credentials, period: Period, fetcher: typeof fetch, signal?: AbortSignal) => Promise<Entry[]>;
};

const MAX_BYTES = 256_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const invalid = () => new Error('FINOPS_PROVIDER_RESPONSE_INVALID');

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw invalid();
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const piece = await reader.read();
      if (piece.done) break;
      size += piece.value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw invalid(); }
      chunks.push(piece.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

async function getPage(url: URL, headers: HeadersInit, fetcher: typeof fetch, overall: AbortSignal): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = AbortSignal.any([overall, AbortSignal.timeout(3_000)]);
    let response: Response | undefined;
    try { response = await fetcher(url, { headers, signal, redirect: 'error', cache: 'no-store', method: 'GET' }); }
    catch {
      if (overall.aborted || attempt === 2) throw new Error('FINOPS_PROVIDER_UNAVAILABLE');
    }
    if (response?.ok) {
      try { return await readBoundedJson(response); }
      catch (error) {
        if (!signal.aborted) throw invalid();
        if (overall.aborted || attempt === 2) throw error;
      }
    }
    if (response && !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error('FINOPS_PROVIDER_UNAVAILABLE');
    }
    const advised = retryAfterSeconds(response?.headers.get('retry-after'));
    // A wait above the on-demand budget belongs to the next administrator-initiated sync.
    if (advised !== null && advised > 2 || overall.aborted) throw new Error('FINOPS_PROVIDER_RETRY_LATER');
    await new Promise<void>(resolve => setTimeout(resolve, Math.max((advised ?? 0) * 1_000, 150 * 2 ** attempt + Math.floor(Math.random() * 100))));
  }
  throw new Error('FINOPS_PROVIDER_UNAVAILABLE');
}

export function normalizeOpenAiPage(input: unknown, project: string, period: Period): { entries: Entry[]; next: string | null; days: string[] } {
  if (!isRecord(input) || !Array.isArray(input.data) || input.data.length > 180 || typeof input.has_more !== 'boolean') throw invalid();
  const days: string[] = [], entries: Entry[] = [];
  for (const bucket of input.data) {
    if (!isRecord(bucket) || typeof bucket.start_time !== 'number' || typeof bucket.end_time !== 'number' ||
        !Number.isSafeInteger(bucket.start_time) || !Number.isSafeInteger(bucket.end_time) || bucket.start_time % 86_400 !== 0 ||
        bucket.end_time - bucket.start_time !== 86_400 || !Array.isArray(bucket.results) || bucket.results.length > 50) throw invalid();
    const start = isoDay(new Date(bucket.start_time * 1000)), end = addDays(start, 1);
    if (!contains(period, { from: start, to: end }) || days.includes(start)) throw invalid();
    days.push(start);
    let currency: string | null = null, net = 0n;
    for (const result of bucket.results) {
      if (!isRecord(result) || result.project_id !== project || !isRecord(result.amount) || typeof result.amount.currency !== 'string' ||
          typeof result.amount.value !== 'number' || !Number.isFinite(result.amount.value) || Math.abs(result.amount.value) >= 1e10) throw invalid();
      const original = result.amount.currency.toUpperCase();
      if (currency !== null && currency !== original) throw invalid();
      currency = original;
      net += units(result.amount.value.toFixed(8));
    }
    // A daily bucket with no project-scoped values is unknown. An explicit provider zero remains a zero.
    if (currency !== null) entries.push(validateEntry({ scope: 'openai', environment: 'production', start, end, source: 'PROVIDER_COST',
      reference: 'OpenAI Costs API project scoped', currency, net: decimal(net), coverage: 'FULL' }, true));
  }
  const next = input.has_more ? input.next_page : null;
  if (next !== null && (typeof next !== 'string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(next))) throw invalid();
  if (input.has_more && !next) throw invalid();
  return { entries, next, days };
}

const openAi: BillingAdapter = {
  scope: 'openai',
  credentials(env) {
    const key = env.FLOFI_FINOPS_OPENAI_ADMIN_KEY?.trim(), project = env.FLOFI_FINOPS_OPENAI_PROJECT_ID?.trim();
    return key && key.length <= 1024 && project && /^proj_[A-Za-z0-9_-]{1,100}$/.test(project) ? { key, project } : null;
  },
  async read({ key, project }, period, fetcher, signal) {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.search = new URLSearchParams({
      start_time: String(Date.parse(period.from + 'T00:00:00Z') / 1000), end_time: String(Date.parse(period.to + 'T00:00:00Z') / 1000),
      bucket_width: '1d', limit: '180', 'project_ids[]': project, 'group_by[]': 'project_id',
    }).toString();
    const timeout = AbortSignal.timeout(12_000), overall = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const days = new Set<string>(), cursors = new Set<string>(), entries: Entry[] = [];
    for (let pageNo = 0; pageNo < 4; pageNo++) {
      const page = normalizeOpenAiPage(await getPage(url, { Authorization: 'Bearer ' + key }, fetcher, overall), project, period);
      if (page.days.some(day => days.has(day))) throw invalid();
      for (const day of page.days) days.add(day);
      entries.push(...page.entries);
      if (page.next === null) return entries;
      if (cursors.has(page.next)) throw invalid();
      cursors.add(page.next);
      url.searchParams.set('page', page.next);
    }
    throw invalid();
  },
};
export const openAiCostAdapter = openAi;

const ADAPTERS: readonly BillingAdapter[] = [openAi];

function availableAdapter(adapter: BillingAdapter, env: Env, tenantId: string) {
  if (env.VERCEL_ENV === 'preview' || env.FLOFI_FINOPS_BILLING_TENANT !== tenantId) return null;
  return adapter.credentials(env);
}

export const configuredBillingScopes = (env: Env, tenantId: string) =>
  ADAPTERS.filter(adapter => availableAdapter(adapter, env, tenantId) !== null).map(adapter => adapter.scope);

export async function fetchBillingEntries(scope: ScopeId, env: Env, tenantId: string, period: Period, fetcher: typeof fetch) {
  const adapter = ADAPTERS.find(item => item.scope === scope);
  const credentials = adapter && availableAdapter(adapter, env, tenantId);
  if (!adapter || !credentials) throw new Error('FINOPS_PROVIDER_NOT_CONFIGURED');
  if (periodDays(period) > 92) throw new Error('FINOPS_SYNC_RANGE_TOO_LARGE');
  const rows = await adapter.read(credentials, period, fetcher);
  if (!rows.length) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
  return rows;
}
