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
import { parseCsvRows } from './csv';
import { addDays, FINOPS_SCOPES, isoDay, scopeIds } from './economics';
import { handleFinopsExport, handleFinopsImport } from './http';
import { investorCsv, metricPeriod, readFinopsReport } from './report';

const origin = 'https://flofi.example', clock = new Date('2026-11-19T10:00Z');
const env = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const config = adminConfig(env);
if (!config.enabled) throw new Error(config.code);
const key = config.key;
let database: TestDatabase;
type Auth = { cookie: string; csrf: string };
let operator: Auth, viewer: Auth, outsider: Auth;
const ptaxFixture: typeof fetch = async input => {
  const url = new URL(String(input));
  expect(url.origin).toBe('https://olinda.bcb.gov.br');
  const close = url.searchParams.get('@dataFinalCotacao');
  const value = close === "'11-18-2026'" ? [{ dataHoraCotacao: '2026-11-18 13:00:00.100', cotacaoVenda: 5.41234 }] : [];
  return Response.json({ value });
};
const options = (tenantId = 'default') => ({ host: { db: database.db, tenantId }, now: () => clock, env, fetch: ptaxFixture });

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
      cwd: new URL('../../../', import.meta.url), env: { PATH: process.env.PATH ?? '', DATABASE_MIGRATION_URL: database.url, NODE_ENV: 'test' },
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
    expect((await write({ ...invoice, environment: 'preview', source: 'ASSUMPTION', reference: 'Preview cost assumption', net: '99' })).status).toBe(200);
    const report = await readFinopsReport(options().host, { from: filters.from, to: '2026-11-19' }, clock);
    expect(report.totals.find(scope => scope.id === 'openai')).toMatchObject({ amount: '70', quality: 'VERIFIED' });
    expect(report.metrics.aiCost).toMatchObject({ amount: '70', quality: 'PARTIAL' });
    expect(report.metrics.overall).toMatchObject({ amount: '70', quality: 'PARTIAL' });
    for (const metric of [report.metrics.contribution, report.metrics.result, report.metrics.breakEvenRevenue]) {
      expect(metric).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    }
    expect(report.metrics.revenue).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    expect(report.workflow?.completed).toBe(0);
  });
  it('isolates tenants and exports exact USD, indicative BRL and invoice FX provenance without private metadata', async () => {
    const privateFxSource = '0x' + 'ef'.repeat(20);
    expect((await write({ ...invoice, scope: 'neon-postgres', currency: 'BRL', net: '123.45678901', fxUsd: '0.2', fxSource: privateFxSource })).status).toBe(200);
    const other = await handleFinopsExport(request('export', filters, outsider), options('other-finops'));
    expect(other.status).toBe(200);
    const otherCsv = await other.text();
    // Another tenant's export carries none of this tenant's ledger rows, originals or conversions.
    expect(otherCsv).not.toContain('"70","USD"');
    expect(otherCsv).not.toContain('123.45678901');
    expect(otherCsv).not.toContain('"ledger originals"');
    const result = await handleFinopsExport(request('export', filters, viewer), options());
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const csv = await result.text();
    expect(csv).toContain('"70","USD","VERIFIED","INVOICE"');
    const rows = parseCsvRows(csv, { rows: 1000, columns: 9 }, () => { throw new Error('Invalid investor CSV'); });
    expect(rows).toContainEqual(['providers', 'Neon / PostgreSQL', '2026-11-01', '2026-11-19', '24.6913578', 'USD', 'VERIFIED', 'INVOICE', expect.any(String)]);
    expect(rows).toContainEqual(['providers translation', 'Neon / PostgreSQL', '2026-11-01', '2026-11-19', '133.638023475252', 'BRL', 'VERIFIED',
      expect.stringContaining('historical-period-close · as of 2026-11-18 · 5.41234 BRL/USD · 2026-11-18 13:00:00.100 America/Sao_Paulo'), '']);
    expect(rows).toContainEqual(['ledger originals', 'neon-postgres / production', '2026-11-01', '2026-11-19', '123.45678901', 'BRL', 'VERIFIED',
      'INVOICE · 0.2 USD per BRL · documented ledger FX rate', expect.any(String)]);
    expect(rows).toContainEqual(['ledger estimates and usage', 'openai / preview', '2026-11-01', '2026-11-19', '99', 'USD', 'ESTIMATED', 'ASSUMPTION', expect.any(String)]);
    expect(csv).not.toMatch(/private operator memo|November cost|Preview cost assumption|0x[a-f0-9]{40}|adm_/i);
  });

  it('counts only scoped, credible mainnet gas payer facts without booking sponsorship expense', async () => {
    const owner = '0x' + 'ab'.repeat(20), thirdParty = '0x' + 'cd'.repeat(20), hash = '0x' + 'a'.repeat(64);
    const native = { payer: owner, amount: '37000', source: 'RECEIPT', unit: 'wei' };
    const sponsor = { ...native, payer: thirdParty, source: 'USER_OPERATION_EVENT', sponsored: true };
    const fronted = { ...native, payer: thirdParty, source: 'USER_OPERATION_EVENT', paidInToken: { amount: '15', mechanism: 'CIRCLE_USDC_PAYMASTER' } };
    const solanaOwner = 'FhoWjKCL624Pf7nNzfUXD23Egz8QUP8ZqQtP2aNssZmb', solanaRelayer = '2z8yrtjJc4y3HyF7CE6LXP4KmC2SJV1RKEQtmUtoYZnC';
    const kora = { payer: solanaRelayer, amount: '5000', unit: 'lamports', source: 'SOLANA_META',
      paidInToken: { amount: '0', mechanism: 'PIMLICO_KORA_SPL_FEE' } };
    type Group = { state: 'RECONCILED' | 'FAILED' | 'SUBMITTED' | 'PLANNED'; solana?: boolean; gasPaid?: Record<string, unknown> };
    async function seed(tenant: string, letter: string, environment: 'MAINNET' | 'PUBLIC_TESTNET', groups: Group[]) {
      const handoff = 'apr_' + letter.repeat(26), run = 'wfr_' + letter.repeat(26);
      await database.db.query(`INSERT INTO mcp_handoffs (tenant_id, handoff_id, requester_kind, requester_id, client_id, client_name,
        secret_digest, strategy, workflow_hash, engine_version, network_environment, funds_class, plan, status, expires_at)
        VALUES ($1, $2, 'EDITOR_SESSION', 'editor-fixture', 'editor-fixture', 'Editor fixture', $3, '{}', $4, 'fixture', $5, $6, '{}', 'PENDING', now() + interval '1 day')`,
      [tenant, handoff, Buffer.alloc(32, letter.charCodeAt(0)), hash, environment, environment === 'MAINNET' ? 'REAL_FUNDS' : 'TEST_FUNDS']);
      await database.db.query(`INSERT INTO workflow_runs (tenant_id, run_id, handoff_id, requester_kind, requester_ref, owner_namespace, owner_account,
        wallets, strategy, workflow_hash, engine_version, step_count, mode, state, expires_at)
        VALUES ($1, $2, $3, 'EDITOR_SESSION', 'editor-fixture', 'eip155', $4, jsonb_build_object('eip155', $4::text, 'solana', $6::text), '{}', $5,
          'fixture', 2, 'USER_FUNDED', 'RUNNING', now() + interval '1 day')`, [tenant, run, handoff, owner, hash, solanaOwner]);
      for (const [index, group] of groups.entries()) {
        await database.db.query(`INSERT INTO workflow_run_groups (tenant_id, run_id, group_index, namespace, chain, fee_payer, step_from, step_to, strategy, signing, state)
          VALUES ($1, $2, $3, $4, $5, $6, 0, 1, $7, 'UPFRONT', 'PLANNED')`, [tenant, run, index,
          group.solana ? 'solana' : 'eip155', group.solana ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'eip155:42161', group.solana ? solanaOwner : owner,
          group.solana ? 'SOLANA_SIGN_ALL' : 'EVM_USER_OPERATION']);
        if (group.state === 'PLANNED') continue;
        await database.db.query(`UPDATE workflow_run_groups SET state = $4, submission = '{}', outcome = $5::jsonb, version = 2
          WHERE tenant_id = $1 AND run_id = $2 AND group_index = $3`, [tenant, run, index, group.state, group.gasPaid ? JSON.stringify({ gasPaid: group.gasPaid }) : null]);
      }
    }
    await seed('default', 'a', 'MAINNET', [{ state: 'RECONCILED', gasPaid: native }, { state: 'RECONCILED', gasPaid: fronted },
      { state: 'FAILED', gasPaid: sponsor }, { state: 'SUBMITTED' }, { state: 'PLANNED' },
      { state: 'FAILED', gasPaid: { ...sponsor, source: 'SOLANA_META' } },
      { state: 'FAILED', gasPaid: { ...fronted, paidInToken: { ...fronted.paidInToken, amount: '-1' } } },
      { state: 'FAILED', solana: true, gasPaid: kora }]);
    await seed('default', 'b', 'PUBLIC_TESTNET', [{ state: 'RECONCILED', gasPaid: native }]);
    await seed('other-finops', 'a', 'MAINNET', [{ state: 'FAILED', gasPaid: sponsor }]);
    const now = new Date(), day = isoDay(now), period = { from: addDays(day, -1), to: addDays(day, 1) };
    const report = await readFinopsReport(options().host, period, now);
    expect(report.gas).toEqual({ ownerNative: 1, frontedByRelayer: 2, sponsorObserved: 1, unresolved: 3 });
    expect(report.totals.find(row => row.id === 'gas-sponsorship')).toMatchObject({ amount: null, quality: 'UNAVAILABLE' });
    const outsiderReport = await readFinopsReport(options('other-finops').host, period, now);
    expect(outsiderReport.gas).toEqual({ ownerNative: 0, frontedByRelayer: 0, sponsorObserved: 1, unresolved: 0 });
    const csv = investorCsv(report);
    expect(csv).toContain(`"gas payer evidence","sponsorObserved","${period.from}","${period.to}","1","groups","PARTIAL"`);
    expect(csv).not.toContain(thirdParty);
  });

  it('compares the same closed days when the previous month is shorter', async () => {
    const february = { start: '2027-02-01', end: '2027-03-01' }, march = { start: '2027-03-01', end: '2027-03-29' };
    for (const scope of scopeIds.filter(id => FINOPS_SCOPES[id].required && id !== 'fee-revenue')) {
      for (const window of [february, march, { start: march.end, end: '2027-03-31' }]) {
        expect((await write({ ...invoice, ...window, scope, net: window.start === march.end ? '2' : '28' })).status).toBe(200);
      }
    }
    const report = await readFinopsReport(options().host, { from: march.start, to: '2027-04-01' }, new Date('2027-03-31T12:00:00Z'));
    expect(report.metrics.monthlyChange).toMatchObject({ amount: '0', quality: 'VERIFIED' });
    expect(metricPeriod(report, 'monthlyChange')).toEqual({ from: march.start, to: march.end });
  });
});
