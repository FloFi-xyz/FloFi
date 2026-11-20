// SPDX-License-Identifier: AGPL-3.0-only
import { ensureTenant, type Logger } from '@defi-workflow-engine/cloud-runtime';
import type { AdminHost } from '../host.ts';
import { contains, FINOPS_ENVIRONMENTS, validateEntry, validDay, type Entry, type Period, type ScopeId } from './economics.ts';
import {
  claimFinancialSync, configureFinancialSync, failFinancialSync, finishFinancialSync, waitFinancialSync,
  type FinancialProviderId, type FinancialSyncResult,
} from './sync-store.ts';

export { FINANCIAL_PROVIDER_IDS, isFinancialProviderId } from './sync-store.ts';
export type { FinancialMeter, FinancialProviderId, FinancialSyncResult } from './sync-store.ts';

export type FinancialEnv = Readonly<Record<string, string | undefined>>;
type ReadInput = {
  env: FinancialEnv; period: Period; checkpoint: string | null; signal: AbortSignal; fetch: typeof fetch;
};
export type FinancialSyncAdapter = {
  readonly id: FinancialProviderId;
  configured(env: FinancialEnv): boolean;
  read(input: ReadInput): Promise<FinancialSyncResult>;
};

const SCOPES = {
  neon: ['neon-postgres', 'neon-storage'], railway: ['railway-api', 'railway-worker'], vercel: ['vercel'],
  openai: ['openai'], anthropic: ['anthropic'], circleci: ['circleci'], resend: ['resend'], alchemy: ['rpc'],
} satisfies Record<FinancialProviderId, readonly ScopeId[]>;
const TRANSIENT_CODES = new Set(['FINOPS_PROVIDER_UNAVAILABLE', 'FINOPS_PROVIDER_RETRY_LATER', 'FINOPS_PROVIDER_RATE_LIMITED',
  'FINOPS_PROVIDER_TIMEOUT', 'FINOPS_SYNC_SUPERSEDED', 'FINOPS_SYNC_STORE_UNAVAILABLE']);
const PROVIDER_CODES = new Set([...TRANSIENT_CODES, 'FINOPS_PROVIDER_NOT_CONFIGURED', 'FINOPS_PROVIDER_NO_DATA', 'FINOPS_PROVIDER_AUTH_REQUIRED',
  'FINOPS_PROVIDER_ACCESS_DENIED', 'FINOPS_PROVIDER_NOT_ENTITLED', 'FINOPS_PROVIDER_SCOPE_MISMATCH', 'FINOPS_PROVIDER_RESPONSE_INVALID',
  'FINOPS_PROVIDER_POLL_LIMIT', 'FINOPS_PROVIDER_PERIOD_UNAVAILABLE', 'FINOPS_PROVIDER_FORBIDDEN', 'FINOPS_PROVIDER_EXPORT_FAILED',
  'FINOPS_PERIOD_CONFLICT']);
// Labels only: no '@' or '+' (email-shaped), and an address-shaped value is refused below; meters are aggregates without identities.
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,127}$/;
const IDENTITY_SHAPED = /0x[0-9a-fA-F]{40}/;
const SAFE_AMOUNT = /^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,12})?$/;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
const SAFE_CURSOR = /^[A-Za-z0-9._:-]{1,512}$/;
const ADAPTER_TIMEOUT_MS = 15_000;
const invalid = () => new Error('FINOPS_PROVIDER_RESPONSE_INVALID');

export function financialSyncHours(env: FinancialEnv): number {
  const configured = env.FLOFI_FINOPS_SYNC_HOURS;
  if (configured === undefined || configured === '') return 24;
  if (!/^(?:[6-9]|[1-9]\d|1[0-6]\d)$/.test(configured) || Number(configured) > 168) throw new Error('FINOPS_SYNC_CADENCE_INVALID');
  return Number(configured);
}

export function financialSyncEnabled(env: FinancialEnv, tenantId: string): boolean {
  return env.FLOFI_FINOPS_SYNC === 'enabled' && env.FLOFI_FINOPS_BILLING_TENANT === tenantId && env.VERCEL_ENV !== 'preview';
}

function within(billingPeriod: Period, period: Period): boolean {
  return validDay(period.from) && validDay(period.to) && period.from < period.to && contains(billingPeriod, period);
}

function validateResult(id: FinancialProviderId, requested: Period, result: FinancialSyncResult): FinancialSyncResult {
  if (result.kind === 'WAIT') {
    if (!SAFE_CURSOR.test(result.checkpoint) || !Number.isSafeInteger(result.retryAfterMs) || result.retryAfterMs < 0) throw invalid();
    return result;
  }
  if (result.kind !== 'COMPLETE' || !['FULL', 'PARTIAL', 'UNAVAILABLE'].includes(result.coverage) || result.entries.length > 300
      || result.meters.length > 3_000 || result.limitations.length > 16 || !result.limitations.every(code => SAFE_REASON.test(code))
      || result.coverage === 'UNAVAILABLE' && (result.entries.length > 0 || result.meters.length > 0)
      || result.coverage === 'FULL' && result.entries.length === 0 && result.meters.length === 0) throw invalid();
  const allowed: readonly ScopeId[] = SCOPES[id];
  const entries: Entry[] = [];
  const facts = new Set<string>();
  for (const row of result.entries) {
    if (!allowed.includes(row.scope) || row.source !== 'PROVIDER_COST' || !within(requested, row.period)) throw invalid();
    const key = JSON.stringify([row.scope, row.environment, row.period.from, row.period.to]);
    if (facts.has(key)) throw invalid();
    facts.add(key);
    try {
      entries.push(validateEntry({ ...row, start: row.period.from, end: row.period.to,
        gross: row.gross ?? undefined, credits: row.credits ?? undefined, discounts: row.discounts ?? undefined, taxes: row.taxes ?? undefined,
        fxUsd: row.fxUsd ?? undefined, fxSource: row.fxSource ?? undefined, notes: row.notes ?? undefined }, true));
    } catch { throw invalid(); }
  }
  facts.clear();
  const meters = result.meters.map(({ scope, environment, project, service, metric, unit, amount, period, basis }) => {
    if (!allowed.includes(scope) || !FINOPS_ENVIRONMENTS.includes(environment) || !within(requested, period)
      || ![project, service, metric, unit].every(part => typeof part === 'string' && SAFE_DIMENSION.test(part) && !IDENTITY_SHAPED.test(part))
      || typeof amount !== 'string' || !SAFE_AMOUNT.test(amount)
      || basis !== undefined && (typeof basis !== 'string' || !SAFE_DIMENSION.test(basis) || IDENTITY_SHAPED.test(basis))) throw invalid();
    const key = JSON.stringify([scope, environment, project, service, metric, unit, period.from, period.to, basis]);
    if (facts.has(key)) throw invalid();
    facts.add(key);
    return { scope, environment, project, service, metric, unit, amount, period, ...basis !== undefined ? { basis } : {} };
  });
  if (Buffer.byteLength(JSON.stringify(meters)) > 1_180_000) throw invalid();
  return { kind: 'COMPLETE', entries, meters, coverage: result.coverage, limitations: [...new Set(result.limitations)] };
}

function safeCode(cause: unknown, source: 'adapter' | 'store'): string {
  const code = cause instanceof Error ? cause.message : '';
  if (PROVIDER_CODES.has(code)) return code;
  return source === 'adapter' ? 'FINOPS_PROVIDER_UNAVAILABLE' : 'FINOPS_SYNC_STORE_UNAVAILABLE';
}

export function createFinancialSyncEngine(input: {
  host: AdminHost; env: FinancialEnv; adapters: readonly FinancialSyncAdapter[]; fetcher?: typeof fetch;
}) {
  const { host, env } = input;
  const hours = financialSyncHours(env);
  const eligible = financialSyncEnabled(env, host.tenantId);
  const adapters = new Map(eligible ? input.adapters.filter(adapter => adapter.configured(env)).map(adapter => [adapter.id, adapter]) : []);
  const enabled = [...adapters.keys()];
  let configured = false;
  async function runOnce(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (!eligible || signal.aborted) return false;
    if (!configured) {
      await ensureTenant(host.db, host.tenantId);
      configured = await configureFinancialSync(host, enabled);
    }
    if (!configured || !enabled.length || signal.aborted) return false;
    const lease = await claimFinancialSync(host, enabled, hours);
    if (!lease || signal.aborted) return false;
    const adapter = adapters.get(lease.id);
    const planned = lease.plans[0];
    if (!adapter || !planned) throw new Error('FINOPS_SYNC_PLAN_INVALID');
    let result: FinancialSyncResult;
    try {
      const adapterSignal = AbortSignal.any([signal, AbortSignal.timeout(ADAPTER_TIMEOUT_MS)]);
      const deadline = new Promise<never>((_, reject) => {
        adapterSignal.addEventListener('abort', () => reject(new Error('FINOPS_PROVIDER_TIMEOUT')), { once: true });
      });
      result = validateResult(lease.id, planned.period, await Promise.race([deadline,
        adapter.read({ env, period: planned.period, checkpoint: lease.checkpoint, signal: adapterSignal, fetch: input.fetcher ?? fetch })]));
    } catch (cause) {
      // Process shutdown lets the lease expire so the next worker resumes it.
      if (cause instanceof Error && cause.message === 'FINOPS_PROVIDER_NO_COST_DATA') {
        // A missing billing period has no amount. Persist its gap and continue
        // the other periods, which may still be available from the provider.
        result = { kind: 'COMPLETE', entries: [], meters: [], coverage: 'UNAVAILABLE', limitations: ['FINOPS_PROVIDER_NO_DATA'] };
      } else if (!signal.aborted) {
        const code = safeCode(cause, 'adapter');
        await failFinancialSync(host, lease, code, hours, TRANSIENT_CODES.has(code));
        return true;
      } else return true;
    }
    if (signal.aborted) return true;
    try {
      if (result.kind === 'WAIT') await waitFinancialSync(host, lease, result.checkpoint, result.retryAfterMs, hours);
      else await finishFinancialSync(host, lease, result, hours);
    } catch (cause) {
      const code = safeCode(cause, 'store');
      await failFinancialSync(host, lease, code, hours, TRANSIENT_CODES.has(code));
    }
    return true;
  }
  return { runOnce };
}

/** One job at a time on a pool owned by this side loop, outside the execution worker's queue and concurrency budget. */
export function startFinancialSync(input: Parameters<typeof createFinancialSyncEngine>[0] & { logger: Logger }) {
  const engine = createFinancialSyncEngine(input);
  const shutdown = new AbortController();
  let timer: NodeJS.Timeout | null = null, current: Promise<void> | undefined;
  function schedule(delay: number) {
    if (shutdown.signal.aborted) return;
    timer = setTimeout(() => {
      current = engine.runOnce(shutdown.signal).then(
        worked => schedule(worked ? 1_000 : 60_000),
        (cause: unknown) => {
          // A closed FINOPS_* code is logged as is; anything else (a driver error) is never logged verbatim.
          const code = cause instanceof Error && /^FINOPS_[A-Z0-9_]{3,64}$/.test(cause.message) ? cause.message : 'FINOPS_SYNC_STORE_UNAVAILABLE';
          input.logger.warn('finops.sync_tick_failed', { code });
          schedule(60_000);
        });
    }, delay);
    timer.unref();
  }
  // Leave worker startup and its first execution pass ahead of Financial Sync.
  schedule(5_000);
  return { async stop() {
    shutdown.abort();
    if (timer) clearTimeout(timer);
    await current;
  } };
}
