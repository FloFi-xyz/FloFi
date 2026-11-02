// SPDX-License-Identifier: AGPL-3.0-only
// Selectively adapted from the delivery's server read adapter. No submission or observation calls.
import { cloudApiBaseUrl, callCloudFlow } from '../../server/cloud-api-client';
import { currentWalletPrincipal, currentWalletPrincipals } from '../../server/session-principal';
import { WALLET_PRINCIPAL_HEADER, normalizePrincipal } from '../../server/run-ownership';
import { embeddedRuntime, flowRuntimeKind } from '../../server/flow-runtime';
import { workflowOwner, WORKFLOW_OWNER_HEADER } from '../../domain/saved-workflow';
import { dashboardRunId, object, optionalText, textValue, toDashboardAttempts, toDashboardRun } from './run-mapping';
import { attemptDependentStatus } from '../../domain/landed-attempts';
import { settledWithEvidence } from '../../domain/canonical-execution-status';
import type { DashboardDetailResponse, DashboardRun, DashboardSnapshot } from './types';

async function connection(expectedAccount: string): Promise<{ connection: DashboardSnapshot['connection']; account: string | null; base: URL | null }> {
  const evm = /^0x[0-9a-f]{40}$/i.test(expectedAccount);
  const expected = evm ? normalizePrincipal(expectedAccount.toLowerCase()) : workflowOwner(`solana:${expectedAccount}`)?.address;
  if (!expected) return { connection: 'SIGN_IN_REQUIRED', account: null, base: null };
  const principal = evm ? await currentWalletPrincipal().catch(() => null) :
    (await currentWalletPrincipals().catch(() => [])).find(p => p.namespace === 'solana' && p.address === expected)?.address;
  if (!principal || principal !== expected) return { connection: 'SIGN_IN_REQUIRED', account: null, base: null };
  try {
    const base = flowRuntimeKind(process.env) === 'embedded' ? new URL('http://127.0.0.1/') : cloudApiBaseUrl();
    return { connection: base ? 'CONNECTED' : 'NOT_CONFIGURED', account: principal, base };
  } catch { return { connection: 'UNAVAILABLE', account: principal, base: null }; }
}
async function cloudGet(base: URL, path: string, account: string, signal?: AbortSignal): Promise<unknown> {
  const principalHeader = /^0x/.test(account) ? { [WALLET_PRINCIPAL_HEADER]: account } : { [WORKFLOW_OWNER_HEADER]: `solana:${account}` };
  if (flowRuntimeKind(process.env) === 'embedded') {
    const { backend } = await embeddedRuntime();
    const url = new URL(path, base);
    const route = backend.routes.find(r => r.method === 'GET' && r.pattern.test(url.pathname));
    if (!route) throw Error('RUN_NOT_FOUND');
    try {
      const response = await route.handler({ method: 'GET', path: url.pathname, query: url.searchParams, headers: principalHeader, body: null, requestId: 'dashboard' }, route.pattern.exec(url.pathname)!);
      return (response.body as { value: unknown }).value;
    } catch (error) { if ((error as { status?: number }).status === 404) throw Error('RUN_NOT_FOUND', { cause: error }); throw error; }
  }
  const target = new URL(path, base.href.endsWith('/') ? base : new URL(base.href + '/'));
  const response = await fetch(target, { method: 'GET', cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000),
    headers: { ...process.env.API_AUTH_TOKEN ? { authorization: `Bearer ${process.env.API_AUTH_TOKEN}` } : {}, ...principalHeader } });
  if (response.status === 404) throw new Error('RUN_NOT_FOUND');
  const body: unknown = await response.json();
  if (!response.ok || !object(body) || body.ok !== true) throw new Error('CLOUD_API_UNAVAILABLE');
  return body.value;
}
/**
 * Issue #149: a run summary does not carry its attempts, so a status that looks not started, declined, failed or confirmed cannot say
 * whether an approval (or an earlier step) already landed onchain. Those runs' own owner-scoped records are read (a few at a time) and their
 * recorded attempts attached; the projection then follows the canonical lifecycle. A read that fails marks the run, so it never reads
 * "nothing was sent". Runs whose summary already carries attempts are not read again.
 */
async function withAttempts(base: URL, account: string, runs: readonly DashboardRun[], budgetMs = 10_000): Promise<DashboardRun[]> {
  // BUILD-FLOFI-E2E-RELIABILITY-001 (workflow review): a run that verified evidence already settled needs no read, and all reads share one
  // total budget — a hung API marks the rest as unreadable (never "nothing was sent") instead of holding the whole Dashboard.
  const out = [...runs], pending = out.map((run, index) => ({ run, index }))
    .filter(({ run }) => !run.attempts && attemptDependentStatus(run.status) && !(settledWithEvidence(run) && !run.needsObservation));
  const budget = AbortSignal.timeout(budgetMs);
  const expired = new Promise<never>((_, reject) => { budget.addEventListener('abort', () => reject(new Error('DASHBOARD_ATTEMPT_BUDGET')), { once: true }); });
  expired.catch(() => undefined);
  for (let i = 0; i < pending.length; i += 5) await Promise.all(pending.slice(i, i + 5).map(async ({ run, index }) => {
    try {
      if (budget.aborted) throw new Error('DASHBOARD_ATTEMPT_BUDGET');
      const raw = await Promise.race([cloudGet(base, `v1/runs/${encodeURIComponent(run.runId)}`, account, budget), expired]);
      // The same owner-scoped record, or nothing: a record of another run or owner never lends its attempts.
      const own = toDashboardRun(raw, account);
      out[index] = own?.runId === run.runId && own.attempts ? { ...run, attempts: own.attempts } : { ...run, attemptsUnavailable: true };
    } catch { out[index] = { ...run, attemptsUnavailable: true }; }
  }));
  return out;
}
export async function loadDashboardSnapshot(expectedAccount: string, cursor: string | null = null, options: { readonly attemptBudgetMs?: number } = {}): Promise<DashboardSnapshot> {
  const scope = await connection(expectedAccount);
  const empty: DashboardSnapshot = { connection: scope.connection, account: scope.account, runs: [], hasMore: false };
  if (!scope.base || !scope.account) return empty;
  try {
    if (cursor !== null && !/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) throw Error('CURSOR_INVALID');
    const query = new URLSearchParams({ limit: '25', ...cursor ? { cursor } : {} });
    const value = await cloudGet(scope.base, `v1/runs?${query}`, scope.account);
    if (!object(value) || !Array.isArray(value.items)) throw new Error('CLOUD_API_UNAVAILABLE');
    const runs = value.items.flatMap(item => { const run = toDashboardRun(item, scope.account!); return run ? [run] : []; });
    return { ...empty, runs: await withAttempts(scope.base, scope.account, runs, options.attemptBudgetMs), hasMore: Boolean(optionalText(value.next)), next: optionalText(value.next) };
  } catch { return { ...empty, connection: 'UNAVAILABLE' }; }
}

/** Details are resolved only after the owned index record is checked. Unknown IDs never become example runs. */
export async function loadDashboardRunDetail(expectedAccount: string, runId: string): Promise<DashboardDetailResponse> {
  const scope = await connection(expectedAccount);
  const empty: DashboardDetailResponse = { connection: scope.connection, account: scope.account, detail: null };
  if (!scope.base || !scope.account) return empty;
  if (!dashboardRunId(runId)) return { ...empty, connection: 'NOT_FOUND' };
  try {
    const raw = await cloudGet(scope.base, `v1/runs/${encodeURIComponent(runId)}`, scope.account);
    const run = toDashboardRun(raw, scope.account);
    if (!run || run.runId !== runId || !object(raw)) return { ...empty, connection: 'NOT_FOUND' };
    const [evidence, record] = await Promise.allSettled([
      cloudGet(scope.base, `v1/runs/${encodeURIComponent(runId)}/evidence`, scope.account),
      // Existing status is a read-only load. Never call observe, begin, recover, handoff or report.
      flowRuntimeKind(process.env) === 'embedded' || !/^0x/.test(scope.account)
        ? cloudGet(scope.base, `v1/runs/${encodeURIComponent(runId)}/record`, scope.account).then(value => ({ ok: true as const, value }))
        : callCloudFlow<unknown>(run.flow, 'status', [runId], { principal: scope.account }),
    ]);
    const evidenceRaw = evidence.status === 'fulfilled' && Array.isArray(evidence.value) ? evidence.value : null;
    const recordRaw = record.status === 'fulfilled' && record.value.ok ? record.value.value : null;
    return { ...empty, detail: { run, record: recordRaw, recordUnavailable: recordRaw === null, evidenceUnavailable: evidenceRaw === null,
      attempts: toDashboardAttempts(raw.attempts),
      evidence: (evidenceRaw ?? []).filter(object).filter(item => optionalText(item.bundleHash)).map(item => ({ bundleHash: textValue(item.bundleHash), environment: textValue(item.environment),
        outcome: textValue(item.outcome), verified: item.verified === true, createdAt: optionalText(item.createdAt) })) } };
  } catch (cause) { return { ...empty, connection: cause instanceof Error && cause.message === 'RUN_NOT_FOUND' ? 'NOT_FOUND' : 'UNAVAILABLE' }; }
}
