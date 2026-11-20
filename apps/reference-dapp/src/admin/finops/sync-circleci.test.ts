// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002: CircleCI Usage Export API (asynchronous job, signed CSV downloads). No network, inert token. */
import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { circleCiFinancialAdapter as circleci } from './sync-circleci.ts';

const ORG = '2b3602e4-47d3-420f-97fa-e034c55d919b', PROJECT = 'bdb424bd-4927-4f7f-a360-d9674a7a66b8';
const JOB = '0f7a3b64-9d2c-4a7e-8f00-2c1b9e1f6a01';
const period = { from: '2026-11-01', to: '2026-11-03' };
const env = { FLOFI_FINOPS_CIRCLECI_BILLING_TOKEN: 'inert-fixture' };
const signed = 'https://sfc-va2-ds1-9-customer-stage.s3.amazonaws.com/export-1.csv.gz?X-Amz-Credential=fixture&X-Amz-Signature=fixture';
const HEAD = 'ORGANIZATION_ID,PROJECT_ID,JOB_ID,JOB_RUN_DATE,JOB_NAME,WORKFLOW_ID,WORKFLOW_NAME,JOB_RUN_SECONDS,RESOURCE_CLASS,EXECUTOR,TOTAL_CREDITS,COMPUTE_CREDITS,JOB_BUILD_STATUS';
const row = (project: string, job: string, credits: string, workflow = '11111111-2222-4333-8444-555555555555') =>
  [ORG, project, job, '2026-11-01', 'unit', workflow, 'certification', '120', 'large', 'docker', credits, credits, 'success'].join(',');
const duplicateJob = 'a1111111-2222-4333-8444-555555555555';
const alternateWorkflow = 'a1111111-2222-4333-8444-555555555555';
const csv = [HEAD, row(PROJECT, 'a1111111-2222-4333-8444-555555555555', '12.5'), row(PROJECT, 'a2222222-2222-4333-8444-555555555555', '7.5'),
  [ORG, PROJECT, 'a4444444-2222-4333-8444-555555555555', '2026-11-01', '\\N', '11111111-2222-4333-8444-555555555555',
    'certification', '\\\\N', '\\N', '\\N', '0', '0', 'skipped'].join(','),
  // Another project in the same organization, and a duplicated job row, never add to FloFi's meters.
  row('cccccccc-2222-4333-8444-555555555555', 'a3333333-2222-4333-8444-555555555555', '1000'),
  row(PROJECT, 'a1111111-2222-4333-8444-555555555555', '12.5')].join('\n') + '\n';
const read = (fetch: typeof globalThis.fetch, checkpoint: string | null = null) =>
  circleci.read({ env, period, checkpoint, fetch, signal: AbortSignal.timeout(2_000) });

describe('CircleCI Usage Export', () => {
  it('creates one export job for the closed range, waits on its checkpoint, then meters only the FloFi project', async () => {
    const create = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(String(request)).toBe(`https://circleci.com/api/v2/organizations/${ORG}/usage_export_job`);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Circle-Token')).toBe('inert-fixture');
      expect(JSON.parse(String(init?.body))).toEqual({ start: '2026-11-01T00:00:00Z', end: '2026-11-02T23:59:59.999Z' });
      return Response.json({ usage_export_job_id: JOB, state: 'created', start: '2026-11-01T00:00:00Z', end: '2026-11-02T23:59:59.999Z', download_urls: [] }, { status: 201 });
    });
    expect(await read(create)).toEqual({ kind: 'WAIT', checkpoint: JOB, retryAfterMs: 300_000 });

    const done = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      if (String(request).startsWith('https://circleci.com/')) {
        expect(String(request)).toBe(`https://circleci.com/api/v2/organizations/${ORG}/usage_export_job/${JOB}`);
        expect(init?.method ?? 'GET').toBe('GET');
        return Response.json({ usage_export_job_id: JOB.toUpperCase(), state: 'completed',
          download_urls: Array.from({ length: 7 }, (_, index) => signed.replace('export-1', 'export-' + (index + 1))) });
      }
      // The signed download carries no CircleCI credential.
      expect(new Headers(init?.headers).get('Circle-Token')).toBeNull();
      expect(init?.redirect).toBe('error');
      const exportPart = String(request).includes('export-1.') ? csv
        : String(request).includes('export-2.') ? [HEAD, row(PROJECT.toUpperCase(), duplicateJob.toUpperCase(), '12.5'),
          row(PROJECT, 'a9999999-2222-4333-8444-555555555555', '8000', alternateWorkflow).replace(ORG, 'ffffffff-2222-4333-8444-555555555555')].join('\n')
          : HEAD + '\n';
      return new Response(new Uint8Array(gzipSync(exportPart)),
        { headers: { 'content-type': 'binary/octet-stream' } });
    });
    const result = await read(done, JOB);
    if (result.kind !== 'COMPLETE') throw Error('expected a snapshot');
    expect(result).toMatchObject({ entries: [], coverage: 'PARTIAL', limitations: ['CIRCLECI_CREDITS_WITHOUT_INVOICED_COST'] });
    const totals = Object.fromEntries(result.meters.map(meter => [meter.metric, meter.amount]));
    expect(totals).toMatchObject({ workflow_runs: '1', job_runs: '2', total_credits: '20', compute_credits: '20', job_run_seconds: '240' });
    expect(result.meters.every(meter => meter.project === PROJECT && meter.scope === 'circleci')).toBe(true);
  });

  it('rejects conflicting rows for a canonical job UUID across parts', async () => {
    const second = signed.replace('export-1', 'export-2');
    const fetch = vi.fn<typeof globalThis.fetch>(async request => {
      const url = String(request);
      if (url.startsWith('https://circleci.com/'))
        return Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: [signed, second] });
      return new Response(url === signed ? csv : [HEAD, row(PROJECT, duplicateJob.toUpperCase(), '15')].join('\n'));
    });
    await expect(read(fetch, JOB)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
  });

  it('keeps the checkpoint while processing and distinguishes missing data from missing parts', async () => {
    const pending = async () => Response.json({ usage_export_job_id: JOB, state: 'processing', download_urls: null });
    await expect(read(pending, JOB)).resolves.toEqual({ kind: 'WAIT', checkpoint: JOB, retryAfterMs: 900_000 });
    const missingJob = async () => new Response(null, { status: 404 });
    await expect(read(missingJob, JOB)).rejects.toThrow('FINOPS_PROVIDER_RETRY_LATER');
    await expect(read(missingJob)).rejects.toThrow('FINOPS_PROVIDER_ACCESS_DENIED');
    for (const download_urls of [null, []]) {
      const empty = async () => Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls });
      await expect(read(empty, JOB)).rejects.toThrow('FINOPS_PROVIDER_NO_COST_DATA');
    }
    for (const status of [403, 404]) {
      const missingPart = async (request: RequestInfo | URL) => String(request).startsWith('https://circleci.com/')
        ? Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: [signed] }) : new Response(null, { status });
      await expect(read(missingPart, JOB)).rejects.toThrow('FINOPS_PROVIDER_RETRY_LATER');
    }
  });

  it('refuses an unsigned or foreign download host and reports a failed export as unavailable', async () => {
    const foreign = async (request: RequestInfo | URL) => String(request).startsWith('https://circleci.com/')
      ? Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: ['https://example.com/export.csv'] }) : new Response(csv);
    await expect(read(foreign, JOB)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
    for (const invalid of [signed.replace('Signature=fixture', 'Signature='), signed + '&X-Amz-Signature=second']) {
      const emptySignature = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: [invalid] }));
      await expect(read(emptySignature, JOB)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
      expect(emptySignature).toHaveBeenCalledTimes(1);
    }
    for (const state of ['failed', 'error', 'timed_out', 'canceled', 'cancelled']) {
      await expect(read(async () => Response.json({ usage_export_job_id: JOB, state, download_urls: [] }), JOB))
        .rejects.toThrow('FINOPS_PROVIDER_EXPORT_FAILED');
    }
    await expect(read(async () => Response.json({ usage_export_job_id: '9f7a3b64-9d2c-4a7e-8f00-2c1b9e1f6a01', state: 'created' }), JOB))
      .rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
    await expect(read(async () => Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: null }), JOB))
      .rejects.toThrow('FINOPS_PROVIDER_NO_COST_DATA');
  });
});
