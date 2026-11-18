// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { runAdminCommand } from '../cli-commands';
import { adminConfig } from '../config';
import { adminCsrfToken, sealAdminSession } from '../session';
import { createAdminStore } from '../store';
import { handleFinopsExport, handleFinopsImport } from './http';
import { readFinopsReport } from './report';

const origin = 'https://flofi.example', clock = new Date('2026-11-19T10:00Z');
const env = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const config = adminConfig(env);
if (!config.enabled) throw new Error(config.code);
const key = config.key;
let database: TestDatabase;
type Auth = { cookie: string; csrf: string };
let operator: Auth, viewer: Auth, outsider: Auth;
const options = (tenantId = 'default') => ({ host: { db: database.db, tenantId }, now: () => clock, env });

async function session(role: 'OPERATOR' | 'VIEWER', tenantId: string): Promise<Auth> {
  const store = createAdminStore(database.db, tenantId);
  const principal = await store.grant({ account: '0x' + randomBytes(20).toString('hex'), role, label: null });
  const sessionId = randomBytes(16).toString('hex'), expiresAt = new Date(clock.getTime() + 60_000);
  await store.createSession({ sessionId, principalId: principal.principalId, createdAt: clock, expiresAt });
  return { cookie: 'flofi_admin_session=' + sealAdminSession(key, { sessionId, principalId: principal.principalId, domain: 'flofi.example', issuedAt: clock, expiresAt }),
    csrf: adminCsrfToken(key, sessionId) };
}
function request(path: string, body: unknown, auth?: Auth, overrides: Record<string, string> = {}) {
  return new Request(origin + '/admin/api/finops/' + path, { method: 'POST', body: JSON.stringify(body), headers: {
    host: 'flofi.example', 'x-forwarded-proto': 'https', origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    ...auth ? { cookie: auth.cookie, 'x-flofi-admin-csrf': auth.csrf } : {}, ...overrides,
  } });
}
const invoice = { scope: 'openai', environment: 'production', start: '2026-11-01', end: '2026-11-19',
  source: 'INVOICE', reference: 'November cost', currency: 'USD', net: '25.50', coverage: 'FULL', notes: 'private operator memo' };
const filters = { range: 'custom', from: '2026-11-01', to: '2026-11-18' };
const write = (entry: Record<string, unknown>, auth = operator, replaceId?: string) =>
  handleFinopsImport(request('import', { action: 'manual', entry, replaceId }, auth), options());

beforeAll(async () => {
  database = await createTestDatabase({ migrated: false });
  const { migrate } = await import('@defi-workflow-engine/cloud-runtime');
  await migrate(database.db);
  await database.db.query("INSERT INTO tenants (tenant_id) VALUES ('other-finops')");
  operator = await session('OPERATOR', 'default'); viewer = await session('VIEWER', 'default'); outsider = await session('OPERATOR', 'other-finops');
});
afterAll(async () => { await database?.drop(); });

describe('FinOps ledger authorization and rollout on disposable PostgreSQL', () => {
  it('fails closed on schema 28 and refuses a preview migration against shared platform state', async () => {
    expect(await assertSchemaCompatible(database.db)).toMatchObject({ version: 28 });
    expect(await (await write(invoice)).json()).toMatchObject({ code: 'FINOPS_LEDGER_NOT_CONFIGURED' });
    const command = promisify(execFile);
    await expect(command(process.execPath, ['backend/admin-cli.ts', 'finops-migrate', '--preview-branch', 'finops-review'], {
      cwd: new URL('../../../', import.meta.url), env: { PATH: process.env.PATH ?? '', DATABASE_URL: database.url, NODE_ENV: 'test' },
    })).rejects.toMatchObject({ code: 1, stderr: 'PREVIEW_DATABASE_NOT_DEDICATED\n' });
    expect(await assertSchemaCompatible(database.db)).toMatchObject({ version: 28 });
  });
  it('applies only the pinned migration, and requires every database client to carry the certificate', async () => {
    await expect(runAdminCommand('finops-migrate', {}, database.db, 'default')).resolves.toEqual({ applied: [29] });
    await expect(runAdminCommand('finops-migrate', {}, database.db, 'default')).resolves.toEqual({ applied: [] });
    expect(await assertSchemaCompatible(database.db)).toMatchObject({ version: 29, application: 28 });
    const old = CERTIFIED_FORWARD_MIGRATIONS.filter(cert => cert.base.version !== 28);
    await expect(assertSchemaCompatible(database.db, SHIPPED_MIGRATIONS, old)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  });
  it('requires the real admin session, operator authorization, origin, and CSRF for writes', async () => {
    expect((await handleFinopsImport(request('import', { action: 'manual', entry: invoice }, undefined, { cookie: 'flofi_session=ordinary' }), options())).status).toBe(401);
    expect((await write(invoice, viewer)).status).toBe(403);
    expect((await handleFinopsImport(request('import', { action: 'manual', entry: invoice }, operator, { origin: 'https://example.test' }), options())).status).toBe(403);
    expect((await handleFinopsImport(request('import', { action: 'manual', entry: invoice }, operator, { 'x-flofi-admin-csrf': 'mismatch' }), options())).status).toBe(403);
    expect((await handleFinopsImport(request('import', { action: 'manual', entry: invoice }, outsider), options())).status).toBe(401);
    expect((await handleFinopsExport(request('export', filters), options())).status).toBe(401);
    expect((await handleFinopsExport(request('export', filters, operator, { 'x-flofi-admin-csrf': 'mismatch' }), options())).status).toBe(403);
  });
  it('serializes concurrent duplicates and audits the authorized batch without amount, currency, or notes', async () => {
    const both = await Promise.all([write(invoice), write(invoice)]);
    expect(await Promise.all(both.map(response => response.json()))).toEqual(expect.arrayContaining([
      { ok: true, inserted: 1, duplicate: 0 }, { ok: true, inserted: 0, duplicate: 1 },
    ]));
    const result = await database.db.query<{ id: string }>('SELECT record_id::text AS id FROM finops_cost_records WHERE tenant_id = $1', ['default']);
    expect(result.rows).toHaveLength(1);
    const originalId = result.rows[0]!.id;
    expect((await write({ ...invoice, net: '70' })).status).toBe(409);
    expect((await write({ ...invoice, net: '70' }, operator, originalId)).status).toBe(200);
    expect((await write({ ...invoice, net: '100' }, operator, originalId)).status).toBe(409);
    await expect(database.db.query('UPDATE finops_cost_records SET updated_at = clock_timestamp()')).rejects.toThrow();
    const events = await createAdminStore(database.db, 'default').recentAudit(20);
    expect(events.filter(event => event.kind === 'ADMIN_FINOPS_IMPORT')).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain('private operator memo');
  });
  it('prevalidates CSV atomically and excludes overlapping estimates from confirmed actuals', async () => {
    const headings = 'scope,environment,start,end,source,reference,currency,net,coverage\n';
    const usage = 'openai,production,2026-11-03,2026-11-04,USAGE,Measured day,USD,90,FULL';
    const invalid = 'openai,production,2026-11-04,2026-11-05,USAGE,Measured day,XXX,no,FULL';
    const submit = (csv: string) => handleFinopsImport(request('import', { action: 'csv', csv }, operator), options());
    expect((await submit(headings + usage + '\n' + invalid)).status).toBe(400);
    expect(await (await submit(headings + usage)).json()).toEqual({ ok: true, inserted: 1, duplicate: 0 });
    expect(await (await submit(headings + usage)).json()).toEqual({ ok: true, inserted: 0, duplicate: 1 });
    const report = await readFinopsReport(options().host, { from: filters.from, to: '2026-11-19' }, clock);
    expect(report.totals.find(scope => scope.id === 'openai')).toMatchObject({ amount: '70', quality: 'VERIFIED' });
    expect(report.metrics.aiCost).toMatchObject({ amount: '70', quality: 'PARTIAL' });
    expect(report.metrics.revenue).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    expect(report.workflow?.completed).toBe(0);
  });
  it('isolates tenants and exports aggregate provenance without private ledger metadata', async () => {
    const other = await handleFinopsExport(request('export', filters, outsider), options('other-finops'));
    expect(other.status).toBe(200);
    expect(await other.text()).not.toContain('"70","USD"');
    const result = await handleFinopsExport(request('export', filters, viewer), options());
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const csv = await result.text();
    expect(csv).toContain('"70","USD","VERIFIED","INVOICE"');
    expect(csv).not.toMatch(/private operator memo|November cost|0x[a-f0-9]{40}|adm_/i);
  });
});
