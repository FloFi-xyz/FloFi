// SPDX-License-Identifier: AGPL-3.0-only
import { adminMutation, codeOf, json, readJsonObject, type AdminHttpOptions } from '../http.ts';
import { FinopsValidationError, finopsPeriod, isScopeId, isoDay, validateEntry } from './economics.ts';
import { parseFinopsCsv } from './csv.ts';
import { beginBillingSync, FinopsConflictError, FinopsSupersededError, ledgerMissing, writeLedger } from './store.ts';
import { configuredBillingScopes, fetchBillingEntries } from './providers.ts';
import { investorCsv, readFinopsReport } from './report.ts';
import { parseScenario } from './scenario.ts';
import { isFinancialProviderId, queueFinancialSync } from './sync-store.ts';

type Options = AdminHttpOptions & { readonly fetch?: typeof fetch };
const failed = (status: number, code: string, details: Record<string, unknown> = {}) => json(status, { ok: false, code, ...details });

export async function handleFinopsImport(request: Request, options: Options = {}) {
  const allowed = await adminMutation(request, options, 'write');
  if (allowed instanceof Response) return allowed;
  const { context, request: base } = allowed, actor = context.principal.principalId;
  const body = await readJsonObject(request);
  if (!body) return failed(400, 'FINOPS_REQUEST_INVALID');
  if (body.action === 'queue-sync') {
    const provider = body.provider;
    if (provider !== 'all' && !isFinancialProviderId(provider)) return failed(400, 'FINOPS_REQUEST_INVALID');
    try { return json(202, { ok: true, ...await queueFinancialSync(base.host, actor, provider) }); }
    catch (error) {
      const code = codeOf(error, 'FINOPS_SYNC_FAILED');
      return failed(['FINOPS_SYNC_SCHEMA_REQUIRED', 'FINOPS_PROVIDER_NOT_CONFIGURED'].includes(code) ? 409 : 503, code);
    }
  }
  if (body.action === 'sync') {
    const env = options.env ?? process.env, scope = body.scope, filter = finopsPeriod(base.now, body);
    if (!isScopeId(scope) || !filter.valid) return failed(400, 'FINOPS_REQUEST_INVALID');
    if (!configuredBillingScopes(env, base.host.tenantId).includes(scope)) return failed(409, 'FINOPS_PROVIDER_NOT_CONFIGURED');
    // Billing buckets are retrieved for closed UTC days. Today's charge may still change.
    const today = isoDay(base.now), period = { ...filter.period, to: filter.period.to < today ? filter.period.to : today };
    if (period.from >= period.to) return failed(400, 'FINOPS_SYNC_NO_CLOSED_DAYS');
    try {
      const startedAt = await beginBillingSync(base.host, actor, scope);
      const rows = await fetchBillingEntries(scope, env, base.host.tenantId, period, options.fetch ?? fetch);
      return json(200, { ok: true, ...await writeLedger(base.host, actor, rows, { action: 'SYNC', period, startedAt }) });
    } catch (error) {
      if (error instanceof FinopsSupersededError) return failed(409, error.message);
      const code = ledgerMissing(error) ? 'FINOPS_LEDGER_NOT_CONFIGURED' : codeOf(error, 'FINOPS_SYNC_FAILED');
      if (code === 'FINOPS_SYNC_RATE_LIMITED') return failed(429, code);
      await base.store.audit({ actor, kind: 'ADMIN_FINOPS_SYNC', outcome: 'FAILED', target: scope, code }).catch(() => undefined);
      return failed(503, code);
    }
  }
  try {
    if (body.action === 'csv') return json(200, { ok: true, ...await writeLedger(base.host, actor, parseFinopsCsv(body.csv), { action: 'CSV' }) });
    if (body.action === 'manual' && body.entry && typeof body.entry === 'object' && !Array.isArray(body.entry)) {
      const replaceId = body.replaceId;
      if (replaceId !== undefined && (typeof replaceId !== 'string' || !/^[1-9]\d{0,18}$/.test(replaceId))) throw new FinopsValidationError('replaceId');
      const entry = validateEntry(body.entry as Record<string, unknown>);
      return json(200, { ok: true, ...await writeLedger(base.host, actor, [entry], { action: 'MANUAL', replaceId }) });
    }
    return failed(400, 'FINOPS_REQUEST_INVALID');
  } catch (error) {
    if (error instanceof FinopsValidationError) return failed(400, error.message, { field: error.field });
    if (error instanceof FinopsConflictError) return failed(409, error.message);
    return failed(503, ledgerMissing(error) ? 'FINOPS_LEDGER_NOT_CONFIGURED' : 'FINOPS_LEDGER_UNAVAILABLE');
  }
}

export async function handleFinopsExport(request: Request, options: AdminHttpOptions = {}) {
  const allowed = await adminMutation(request, options, 'read');
  if (allowed instanceof Response) return allowed;
  const { context, request: base } = allowed, body = await readJsonObject(request);
  if (!body) return failed(400, 'FINOPS_REQUEST_INVALID');
  const filter = finopsPeriod(base.now, body);
  if (!filter.valid) return failed(400, 'FINOPS_PERIOD_INVALID');
  const rawScenario = body.scenario;
  const scenario = rawScenario && typeof rawScenario === 'object' && !Array.isArray(rawScenario)
    ? parseScenario(rawScenario as Record<string, unknown>) : null;
  if (rawScenario !== undefined && !scenario) return failed(400, 'FINOPS_SCENARIO_INVALID');
  try {
    const report = await readFinopsReport(base.host, filter.period, base.now);
    const csv = investorCsv(report, scenario);
    await base.store.audit({ actor: context.principal.principalId, kind: 'ADMIN_FINOPS_EXPORTED', outcome: 'OK', target: 'finops',
      detail: { from: filter.period.from, through: filter.period.to, scenario: scenario !== null } });
    return new Response(csv, { status: 200, headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="flofi-finops-report.csv"',
      'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', vary: 'Cookie',
    } });
  } catch { return failed(503, 'FINOPS_EXPORT_UNAVAILABLE'); }
}
