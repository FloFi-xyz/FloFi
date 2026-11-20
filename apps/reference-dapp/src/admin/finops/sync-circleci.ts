// SPDX-License-Identifier: AGPL-3.0-only
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { parseCsvRows } from './csv.ts';
import { decimal, periodDays, units, validDay, type Period } from './economics.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';
import type { FinancialMeter } from './sync-store.ts';
import { financialInvalid, financialJson, financialObject, requestFinancial, requestFinancialBytes } from './sync-transport.ts';

// v2 project metadata for the production certification workflow, resolved
// from the GitHub App's CircleCI project slug rather than the repository name.
const ORG = '2b3602e4-47d3-420f-97fa-e034c55d919b', PROJECT = 'bdb424bd-4927-4f7f-a360-d9674a7a66b8';
const ROOT = 'https://circleci.com/api/v2/organizations/' + ORG + '/usage_export_job';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const safeLabel = /^[a-zA-Z0-9][a-zA-Z0-9_.:/ -]{0,79}$/;
const invalid = (): never => { throw financialInvalid(); };
const creditFields = ['total_credits', 'compute_credits', 'storage_credits', 'network_credits', 'dlc_credits', 'smarter_testing_run_batch_credits'] as const;
const MAX_PART_BYTES = 8_000_000, MAX_EXPORT_BYTES = 100_000_000;
const gunzipAsync = promisify(gunzip);
// The worker process also runs execution work: decompression runs off the event loop and each part yields before it is parsed.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function downloadUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4_096) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  // A signed AWS object-storage URL grants access to one export. No CircleCI
  // credentials accompany the download, and redirects are disabled.
  const objectStorage = /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
    && ['X-Amz-Signature', 'X-Amz-Credential'].every(name => {
      const values = url.searchParams.getAll(name);
      return values.length === 1 && Boolean(values[0]);
    });
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !objectStorage) return invalid();
  return url;
}

async function* exportParts(files: readonly URL[], fetcher: typeof fetch, signal: AbortSignal) {
  let totalBytes = 0;
  for (let offset = 0; offset < files.length; offset += 4) {
    const batch = await Promise.all(files.slice(offset, offset + 4).map(async file => {
      try { return await requestFinancialBytes(file, {}, fetcher, signal, MAX_PART_BYTES); }
      catch (cause) {
        if (cause instanceof Error && ['FINOPS_PROVIDER_NO_COST_DATA', 'FINOPS_PROVIDER_FORBIDDEN'].includes(cause.message))
          throw new Error('FINOPS_PROVIDER_RETRY_LATER', { cause });
        throw cause;
      }
    }));
    for (const bytes of batch) {
      let decoded: Buffer;
      try {
        decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipAsync(bytes, { maxOutputLength: MAX_PART_BYTES }) : bytes;
      } catch { return invalid(); }
      totalBytes += decoded.length;
      if (totalBytes > MAX_EXPORT_BYTES) return invalid();
      await turn();
      try { yield new TextDecoder('utf-8', { fatal: true }).decode(decoded); } catch { return invalid(); }
    }
  }
}

async function usageMeters(csvs: AsyncIterable<string>, period: Period): Promise<FinancialMeter[]> {
  const totals = new Map<string, { amount: bigint; unit: string; metric: string; service: string }>();
  const jobs = new Map<string, string>(), workflows = new Set<string>();
  function add(metric: string, unit: string, service: string, amount: bigint) {
    const key = JSON.stringify([metric, unit, service]), previous = totals.get(key)?.amount ?? 0n;
    // The engine and schema 30 accept at most 3,000 meters per snapshot.
    if (totals.size >= 3_000 && !totals.has(key)) return invalid();
    totals.set(key, { amount: previous + amount, unit, metric, service });
  }
  for await (const csv of csvs) {
    const [header, ...rows] = parseCsvRows(csv, { rows: 45_000, columns: 160 }, invalid);
    const head = header?.map(name => name.toLowerCase());
    if (!head || head.length !== new Set(head).size) return invalid();
    const columns = new Map(head.map((column, index) => [column, index]));
    if (['organization_id', 'project_id', 'job_id', 'job_run_date', 'job_name', 'workflow_id', 'workflow_name', 'job_run_seconds', 'resource_class',
      'executor', 'total_credits', 'job_build_status'].some(name => !columns.has(name))) return invalid();
    for (const cells of rows) {
      if (head.length !== cells.length) return invalid();
      const field = (name: string) => cells[columns.get(name) ?? -1] ?? '';
      // The API exports an organization. Retain only aggregate metrics for the
      // exact verified FloFi project and discard other rows and all user data.
      if (field('organization_id').toLowerCase() !== ORG || field('project_id').toLowerCase() !== PROJECT) continue;
      const id = field('job_id').toLowerCase(), workflow = field('workflow_id').toLowerCase(), date = field('job_run_date');
      if (!uuid.test(id) || !uuid.test(workflow) || !validDay(date) || date < period.from || date >= period.to) return invalid();
      const status = field('job_build_status');
      if (!/^[a-z_]{1,32}$/.test(status)) return invalid();
      const detail = JSON.stringify([workflow, date, status, ...['job_name', 'workflow_name', 'executor', 'resource_class', 'job_run_seconds',
        ...creditFields].map(field)]);
      if (jobs.has(id)) {
        if (jobs.get(id) !== detail) return invalid();
        continue;
      }
      jobs.set(id, detail);
      if (jobs.size > 90_000) return invalid();
      const job = field('job_name'), workflowName = field('workflow_name'), executor = field('executor'), resource = field('resource_class');
      if (workflowName && !safeLabel.test(workflowName)) return invalid();
      const service = [workflowName || 'workflow', job || 'job', executor || 'executor unavailable', resource || 'class unavailable'].join(' / ').slice(0, 128).trimEnd();
      const numeric = (name: string) => {
        const n = field(name);
        if (!/^\d{1,10}(\.\d{1,8})?$/.test(n)) return invalid();
        return units(n);
      };
      if (!workflows.has(workflow)) {
        workflows.add(workflow);
        add('workflow_runs', 'runs', workflowName || 'workflow', units('1'));
      }
      // Skipped jobs have no executor and cannot be counted as executed work.
      // The export can represent their missing duration with a Snowflake NULL marker.
      if (status === 'skipped') {
        if (!['', '\\N', '\\\\N'].includes(field('job_run_seconds')) ||
          creditFields.some(name => field(name) !== '' && numeric(name) !== 0n)) return invalid();
        continue;
      }
      if (![job, executor, resource].every(value => safeLabel.test(value) || value === '')) return invalid();
      add('job_runs', 'runs', service, units('1'));
      if (field('job_run_seconds') !== '') add('job_run_seconds', 'seconds', service, numeric('job_run_seconds'));
      for (const metric of creditFields) if (field(metric) !== '') add(metric, 'credits', service, numeric(metric));
    }
  }
  return [...totals.values()].map(row => ({ scope: 'circleci', environment: 'production', project: PROJECT, period, ...row, amount: decimal(row.amount) }));
}

export const circleCiFinancialAdapter: FinancialSyncAdapter = {
  id: 'circleci',
  configured: env => Boolean(env.FLOFI_FINOPS_CIRCLECI_BILLING_TOKEN),
  async read({ env, period, checkpoint, signal, fetch: fetcher }) {
    const key = env.FLOFI_FINOPS_CIRCLECI_BILLING_TOKEN;
    if (!key) throw new Error('FINOPS_PROVIDER_NOT_CONFIGURED');
    const days = periodDays(period);
    if (days < 1 || days > 31 || checkpoint && !uuid.test(checkpoint)) return invalid();
    const headers = { 'Circle-Token': key, Accept: 'application/json' };
    const url = new URL(checkpoint ? ROOT + '/' + checkpoint : ROOT);
    const start = period.from + 'T00:00:00Z';
    const end = new Date(Date.parse(period.to + 'T00:00:00Z') - 1).toISOString();
    const raw = await requestFinancial(url, checkpoint ? { headers } : { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ start, end }) }, fetcher, signal).catch((cause: unknown) => {
      // A missing API job or organization has not reported an empty export.
      if (cause instanceof Error && cause.message === 'FINOPS_PROVIDER_NO_COST_DATA')
        throw new Error(checkpoint ? 'FINOPS_PROVIDER_RETRY_LATER' : 'FINOPS_PROVIDER_ACCESS_DENIED', { cause });
      throw cause;
    });
    const response = financialJson(raw);
    if (!financialObject(response) || typeof response.usage_export_job_id !== 'string' || !uuid.test(response.usage_export_job_id)
        || checkpoint && response.usage_export_job_id.toLowerCase() !== checkpoint.toLowerCase() || typeof response.state !== 'string') return invalid();
    if (typeof response.start === 'string' && Date.parse(response.start) !== Date.parse(start)
        || typeof response.end === 'string' && Date.parse(response.end) !== Date.parse(end)) return invalid();
    // A failed export job never completes: the next synchronization requests a new export instead of polling this one again.
    if (['failed', 'error', 'timed_out', 'canceled', 'cancelled'].includes(response.state)) throw new Error('FINOPS_PROVIDER_EXPORT_FAILED');
    const files = response.download_urls;
    if (response.state === 'created' || response.state === 'processing') {
      if (files != null && (!Array.isArray(files) || files.length)) return invalid();
      return { kind: 'WAIT', checkpoint: response.usage_export_job_id, retryAfterMs: (checkpoint ? 15 : 5) * 60_000 };
    }
    if (response.state !== 'completed' || !checkpoint) return invalid();
    if (files === null) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
    if (!Array.isArray(files) || files.length > 32 || new Set(files).size !== files.length) return invalid();
    const downloads = files.map(downloadUrl);
    const meters = await usageMeters(exportParts(downloads, fetcher, signal), period);
    if (!meters.length) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
    return { kind: 'COMPLETE', entries: [], meters, coverage: 'PARTIAL', limitations: ['CIRCLECI_CREDITS_WITHOUT_INVOICED_COST'] };
  },
};
