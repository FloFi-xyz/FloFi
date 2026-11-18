// SPDX-License-Identifier: AGPL-3.0-only
import { parseCsvRows } from './csv.ts';
import { decimal, periodDays, units, validDay, type Period } from './economics.ts';
import type { FinancialSyncAdapter } from './sync-engine.ts';
import type { FinancialMeter } from './sync-store.ts';
import { financialInvalid, financialJson, financialObject, requestFinancial } from './sync-transport.ts';

// v2 project metadata for the production certification workflow, resolved
// from the GitHub App's CircleCI project slug rather than the repository name.
const ORG = '2b3602e4-47d3-420f-97fa-e034c55d919b', PROJECT = 'bdb424bd-4927-4f7f-a360-d9674a7a66b8';
const ROOT = 'https://circleci.com/api/v2/organizations/' + ORG + '/usage_export_job';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const safeLabel = /^[a-zA-Z0-9][a-zA-Z0-9_.:/ -]{0,79}$/;
const invalid = (): never => { throw financialInvalid(); };
const creditFields = ['total_credits', 'compute_credits', 'storage_credits', 'network_credits', 'dlc_credits', 'smarter_testing_run_batch_credits'] as const;

function downloadUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4_096) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  // A signed AWS object-storage URL grants access to one export. No CircleCI
  // credentials accompany the download, and redirects are disabled.
  const objectStorage = /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
    && url.searchParams.has('X-Amz-Signature') && url.searchParams.has('X-Amz-Credential');
  if (url.port || !objectStorage) return invalid();
  return url;
}

function usageMeters(csvs: readonly string[], period: Period): FinancialMeter[] {
  const totals = new Map<string, { amount: bigint; unit: string; metric: string; service: string }>();
  const jobs = new Set<string>(), workflows = new Set<string>();
  function add(metric: string, unit: string, service: string, amount: bigint) {
    const key = JSON.stringify([metric, unit, service]), previous = totals.get(key)?.amount ?? 0n;
    if (totals.size > 4_000 && !totals.has(key)) return invalid();
    totals.set(key, { amount: previous + amount, unit, metric, service });
  }
  for (const csv of csvs) {
    const [head, ...rows] = parseCsvRows(csv, { rows: 45_000, columns: 160 }, invalid);
    if (!head || head.length !== new Set(head).size) return invalid();
    const columns = new Map(head.map((column, index) => [column, index]));
    if (['organization_id', 'project_id', 'job_id', 'job_run_date', 'job_name', 'workflow_id', 'workflow_name', 'job_run_seconds', 'resource_class',
      'executor', 'total_credits'].some(name => !columns.has(name))) return invalid();
    for (const cells of rows) {
      if (head.length !== cells.length) return invalid();
      const field = (name: string) => cells[columns.get(name) ?? -1] ?? '';
      // The API exports an organization. Retain only aggregate metrics for the
      // exact verified FloFi project and discard other rows and all user data.
      if (field('organization_id') !== ORG || field('project_id') !== PROJECT) continue;
      const id = field('job_id'), workflow = field('workflow_id'), date = field('job_run_date');
      if (!uuid.test(id) || !uuid.test(workflow) || !validDay(date) || date < period.from || date >= period.to) return invalid();
      if (jobs.has(id)) continue;
      jobs.add(id);
      if (jobs.size > 90_000) return invalid();
      const job = field('job_name'), workflowName = field('workflow_name'), executor = field('executor'), resource = field('resource_class');
      if (![job, workflowName, executor, resource].every(value => safeLabel.test(value) || value === '')) return invalid();
      const service = [workflowName || 'workflow', job || 'job', executor || 'executor unavailable', resource || 'class unavailable'].join(' / ').slice(0, 200);
      const numeric = (name: string) => {
        const n = field(name);
        if (!/^\d{1,10}(\.\d{1,8})?$/.test(n)) return invalid();
        return units(n);
      };
      if (!workflows.has(workflow)) {
        workflows.add(workflow);
        add('workflow_runs', 'runs', workflowName || 'workflow', units('1'));
      }
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
    const response = financialJson(await requestFinancial(url, checkpoint ? { headers } : { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ start, end }) }, fetcher, signal));
    if (!financialObject(response) || typeof response.usage_export_job_id !== 'string' || !uuid.test(response.usage_export_job_id)
        || checkpoint && response.usage_export_job_id !== checkpoint || typeof response.state !== 'string') return invalid();
    if (typeof response.start === 'string' && Date.parse(response.start) !== Date.parse(start)
        || typeof response.end === 'string' && Date.parse(response.end) !== Date.parse(end)) return invalid();
    if (['failed', 'error', 'timed_out', 'canceled', 'cancelled'].includes(response.state)) throw new Error('FINOPS_PROVIDER_UNAVAILABLE');
    const files = response.download_urls;
    if (!Array.isArray(files) || !files.length) {
      return { kind: 'WAIT', checkpoint: response.usage_export_job_id, retryAfterMs: 5 * 60_000 };
    }
    if (files.length > 6 || new Set(files).size !== files.length) return invalid();
    const csvs = await Promise.all(files.map(file => requestFinancial(downloadUrl(file), {}, fetcher, signal, 8_000_000)));
    const meters = usageMeters(csvs, period);
    if (!meters.length) throw new Error('FINOPS_PROVIDER_NO_COST_DATA');
    return { kind: 'COMPLETE', entries: [], meters, coverage: 'PARTIAL', limitations: ['CIRCLECI_CREDITS_WITHOUT_INVOICED_COST'] };
  },
};
