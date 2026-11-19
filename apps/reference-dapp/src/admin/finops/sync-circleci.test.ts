// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002: CircleCI Usage Export API (asynchronous job, signed CSV downloads). No network, inert token. */
import { describe, expect, it, vi } from 'vitest';
import { circleCiFinancialAdapter as circleci } from './sync-circleci.ts';

const ORG = '2b3602e4-47d3-420f-97fa-e034c55d919b', PROJECT = 'bdb424bd-4927-4f7f-a360-d9674a7a66b8';
const JOB = '0f7a3b64-9d2c-4a7e-8f00-2c1b9e1f6a01';
const period = { from: '2026-11-01', to: '2026-11-03' };
const env = { FLOFI_FINOPS_CIRCLECI_BILLING_TOKEN: 'inert-fixture' };
const signed = 'https://circleci-usage-exports.s3.us-east-1.amazonaws.com/export-1.csv?X-Amz-Credential=fixture&X-Amz-Signature=fixture';
const HEAD = 'organization_id,project_id,job_id,job_run_date,job_name,workflow_id,workflow_name,job_run_seconds,resource_class,executor,total_credits,compute_credits';
const row = (project: string, job: string, credits: string, workflow = '11111111-2222-4333-8444-555555555555') =>
  [ORG, project, job, '2026-11-01', 'unit', workflow, 'certification', '120', 'large', 'docker', credits, credits].join(',');
const csv = [HEAD, row(PROJECT, 'a1111111-2222-4333-8444-555555555555', '12.5'), row(PROJECT, 'a2222222-2222-4333-8444-555555555555', '7.5'),
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
        return Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: [signed] });
      }
      // The signed download carries no CircleCI credential.
      expect(new Headers(init?.headers).get('Circle-Token')).toBeNull();
      return new Response(csv);
    });
    const result = await read(done, JOB);
    if (result.kind !== 'COMPLETE') throw Error('expected a snapshot');
    expect(result).toMatchObject({ entries: [], coverage: 'PARTIAL', limitations: ['CIRCLECI_CREDITS_WITHOUT_INVOICED_COST'] });
    const totals = Object.fromEntries(result.meters.map(meter => [meter.metric, meter.amount]));
    expect(totals).toMatchObject({ workflow_runs: '1', job_runs: '2', total_credits: '20', compute_credits: '20', job_run_seconds: '240' });
    expect(result.meters.every(meter => meter.project === PROJECT && meter.scope === 'circleci')).toBe(true);
  });

  it('refuses an unsigned or foreign download host and reports a failed export as unavailable', async () => {
    const foreign = async (request: RequestInfo | URL) => String(request).startsWith('https://circleci.com/')
      ? Response.json({ usage_export_job_id: JOB, state: 'completed', download_urls: ['https://example.com/export.csv'] }) : new Response(csv);
    await expect(read(foreign, JOB)).rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
    await expect(read(async () => Response.json({ usage_export_job_id: JOB, state: 'failed', download_urls: [] }), JOB))
      .rejects.toThrow('FINOPS_PROVIDER_UNAVAILABLE');
    await expect(read(async () => Response.json({ usage_export_job_id: '9f7a3b64-9d2c-4a7e-8f00-2c1b9e1f6a01', state: 'created' }), JOB))
      .rejects.toThrow('FINOPS_PROVIDER_RESPONSE_INVALID');
  });
});
