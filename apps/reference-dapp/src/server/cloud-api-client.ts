// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CLOUD-001 backend-for-frontend forwarding. When API_BASE_URL is configured (cloud deployment), the
 * existing server actions forward their exact contract to the stateless Flofi API instead of running the
 * services in this process. The browser still talks only to its own origin (CSP `connect-src 'self'`); the
 * API token is server-only. Each invocation carries one idempotency key reused across bounded transport
 * retries, so a lost response cannot apply a mutation twice.
 * BUILD-JOURNEY-001: the wallet session principal (verified from the HttpOnly session cookie by the caller) travels in a
 * server-to-server header; the API binds runs to it. The browser never talks to the API, so it can never set that header.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { WALLET_PRINCIPAL_HEADER } from './run-ownership.ts';
import { currentTraceparent } from '@defi-workflow-engine/cloud-runtime';
import { betaIdentityHeaders, type BetaRequestIdentity } from '../flight/beta-context.ts';

export type FlowResult<T> = { ok: true; value: T } | { ok: false; code: string; correlationId?: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const READ_ONLY = new Set(['status', 'mode']);

/**
 * The caller's deadline ended (its `signal` aborted, or its transport threw this). Never retried: the caller is no longer waiting, and
 * for a mutating call whose request may have reached the API the outcome is UNKNOWN (never "not sent"); the caller re-reads status.
 */
export const CLOUD_API_DEADLINE_EXCEEDED = 'CLOUD_API_DEADLINE_EXCEEDED';
export class CloudDeadlineError extends Error {
  constructor() { super(CLOUD_API_DEADLINE_EXCEEDED); this.name = 'CloudDeadlineError'; }
}
const deadlineEnded = (error: unknown, signal: AbortSignal | undefined) => error instanceof CloudDeadlineError || signal?.aborted === true;
const DEADLINE: FlowResult<never> = Object.freeze({ ok: false, code: CLOUD_API_DEADLINE_EXCEEDED });
/** One attempt's signal: its own timeout, and the caller's deadline when given. */
const attemptSignal = (timeoutMs: number, signal: AbortSignal | undefined) => signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
/** The retry pause; with a caller deadline it ends early when the deadline does (the next check then stops the loop). */
const pauseFor = (sleep: ((ms: number) => Promise<void>) | undefined, signal: AbortSignal | undefined) => sleep ?? ((ms: number) => new Promise<void>(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
}));

export function cloudApiBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): URL | null {
  const raw = env.API_BASE_URL;
  if (!raw) return null;
  let url: URL; try { url = new URL(raw); } catch { throw new Error('CLOUD_API_CONFIGURATION_INVALID'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) throw new Error('CLOUD_API_CONFIGURATION_INVALID');
  return url;
}

export async function callCloudFlow<T>(flow: string, method: string, args: readonly unknown[], options: {
  env?: Readonly<Record<string, string | undefined>>; transport?: typeof fetch; sleep?: (ms: number) => Promise<void>; principal?: string | null;
  timeoutMs?: number; maxAttempts?: number; correlationId?: string; betaIdentity?: BetaRequestIdentity | null;
  /** The caller's deadline: aborts the request in flight and ends the retries (`CLOUD_API_DEADLINE_EXCEEDED`). */
  signal?: AbortSignal } = {}): Promise<FlowResult<T>> {
  const env = options.env ?? process.env, transport = options.transport ?? fetch, signal = options.signal;
  const sleep = pauseFor(options.sleep, signal);
  let base: URL | null;
  try { base = cloudApiBaseUrl(env); } catch (error) { return { ok: false, code: (error as Error).message }; }
  if (!base) return { ok: false, code: 'CLOUD_API_NOT_CONFIGURED' };
  const target = new URL(`v1/flows/${encodeURIComponent(flow)}/${encodeURIComponent(method)}`, base.href.endsWith('/') ? base : new URL(base.href + '/'));
  const key = READ_ONLY.has(method) ? null : randomUUID();
  const traceparent = currentTraceparent() ?? `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
  const attempts = Math.max(1, Math.min(4, options.maxAttempts ?? 4));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return DEADLINE;
    let response: Response;
    try {
      response = await transport(target, { method: 'POST', cache: 'no-store', redirect: 'error', signal: attemptSignal(options.timeoutMs ?? 240_000, signal),
        headers: { 'content-type': 'application/json', traceparent, ...betaIdentityHeaders(options.betaIdentity), ...env.API_AUTH_TOKEN ? { authorization: `Bearer ${env.API_AUTH_TOKEN}` } : {},
          ...key ? { 'idempotency-key': key } : {}, ...options.principal ? { [WALLET_PRINCIPAL_HEADER]: options.principal } : {} }, body: JSON.stringify({ args }) });
    } catch (error) {
      // The caller stopped waiting: no retry (a mutation that may have arrived is UNKNOWN to the caller, never "not sent").
      if (deadlineEnded(error, signal)) return DEADLINE;
      // The request may or may not have arrived; the same idempotency key makes the retry safe.
      if (attempt < attempts - 1) { await sleep(500 * 2 ** attempt); continue; }
      return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
    }
    let body: unknown = null;
    try { body = await response.json(); } catch (error) { if (deadlineEnded(error, signal)) return DEADLINE; }
    const result = body as { ok?: unknown; value?: unknown; code?: unknown; correlationId?: unknown } | null;
    if (response.status === 409 && result?.code === 'IDEMPOTENCY_IN_PROGRESS' && attempt < attempts - 1) { await sleep(1_000 * (attempt + 1)); continue; }
    if ([502, 503, 504].includes(response.status) && attempt < attempts - 1) { await sleep(500 * 2 ** attempt); continue; }
    if (response.ok && result?.ok === true && 'value' in result) return { ok: true, value: result.value as T };
    if (result?.ok === false && typeof result.code === 'string' && CODE.test(result.code)) return { ok: false, code: result.code, ...typeof result.correlationId === 'string' && /^[a-f0-9-]{36}$/.test(result.correlationId) ? { correlationId: result.correlationId } : {} };
    return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
  }
  return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
}

/**
 * BUILD-MCP-001: a read-only simulation preview on the API (`POST /v1/previews/:flow`). Nothing durable happens there, so the
 * call carries no idempotency key and no principal; a transport failure is simply retried.
 */
export async function previewCloudFlow<T>(flow: string, args: readonly unknown[], options: {
  betaIdentity?: BetaRequestIdentity | null;
  env?: Readonly<Record<string, string | undefined>>; transport?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; maxAttempts?: number; purpose?: 'SIMULATION' | 'QUOTE';
  /** The caller's deadline: aborts the preview in flight and ends the retries (`CLOUD_API_DEADLINE_EXCEEDED`). */
  signal?: AbortSignal } = {}): Promise<FlowResult<T>> {
  const env = options.env ?? process.env, transport = options.transport ?? fetch, signal = options.signal;
  const sleep = pauseFor(options.sleep, signal);
  let base: URL | null;
  try { base = cloudApiBaseUrl(env); } catch (error) { return { ok: false, code: (error as Error).message }; }
  if (!base) return { ok: false, code: 'CLOUD_API_NOT_CONFIGURED' };
  const target = new URL(`v1/previews/${encodeURIComponent(flow)}`, base.href.endsWith('/') ? base : new URL(base.href + '/'));
  const attempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3)), timeoutMs = options.timeoutMs ?? 240_000;
  // P0 catalog reliability: the API stops the preview a little before this attempt's own timeout (backend/app.ts PREVIEW_DEADLINE_HEADER), so a slow
  // preview comes back as a classified CLOUD_PREVIEW_TIMEOUT while FloFi still waits — never as an anonymous transport failure.
  const deadline = String(Math.max(100, Math.min(999_999, timeoutMs - Math.min(1_500, Math.floor(timeoutMs / 10)))));
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return DEADLINE;
    let response: Response;
    try {
      response = await transport(target, { method: 'POST', cache: 'no-store', redirect: 'error', signal: attemptSignal(timeoutMs, signal),
        headers: { 'content-type': 'application/json', 'x-flofi-deadline-ms': deadline, ...betaIdentityHeaders(options.betaIdentity), ...currentTraceparent() ? { traceparent: currentTraceparent()! } : {},
          ...env.API_AUTH_TOKEN ? { authorization: `Bearer ${env.API_AUTH_TOKEN}` } : {} }, body: JSON.stringify({ args, ...options.purpose ? { purpose: options.purpose } : {} }) });
    } catch (error) {
      if (deadlineEnded(error, signal)) return DEADLINE;
      if (attempt < attempts - 1) { await sleep(500 * 2 ** attempt); continue; }
      return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
    }
    let body: unknown = null;
    try { body = await response.json(); } catch (error) { if (deadlineEnded(error, signal)) return DEADLINE; }
    const result = body as { ok?: unknown; value?: unknown; code?: unknown; correlationId?: unknown } | null;
    if ([502, 503, 504].includes(response.status) && attempt < attempts - 1) { await sleep(500 * 2 ** attempt); continue; }
    // An API deployed before BUILD-MCP-001 has no preview route.
    if (response.status === 404) return { ok: false, code: 'CLOUD_API_PREVIEW_UNAVAILABLE' };
    if (response.ok && result?.ok === true && 'value' in result) return { ok: true, value: result.value as T };
    if (result?.ok === false && typeof result.code === 'string' && CODE.test(result.code)) return { ok: false, code: result.code, ...typeof result.correlationId === 'string' && /^[a-f0-9-]{36}$/.test(result.correlationId) ? { correlationId: result.correlationId } : {} };
    return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
  }
  return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
}

/**
 * BUILD-MCP-001: one run (`GET /v1/runs/:id`) or a page of its journal, as `principal` — the API answers 404 for any run that
 * principal does not own, exactly as for a wallet session. `null` means not found or not owned (indistinguishable).
 */
export async function readCloudRun<T>(runId: string, principal: string, options: { env?: Readonly<Record<string, string | undefined>>; transport?: typeof fetch;
  journal?: { after: number | null; limit: number }; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FlowResult<T | null>> {
  const env = options.env ?? process.env, transport = options.transport ?? fetch, signal = options.signal;
  if (signal?.aborted) return DEADLINE;
  let base: URL | null;
  try { base = cloudApiBaseUrl(env); } catch (error) { return { ok: false, code: (error as Error).message }; }
  if (!base) return { ok: false, code: 'CLOUD_API_NOT_CONFIGURED' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) return { ok: false, code: 'RUN_ID_INVALID' };
  const query = options.journal ? `/journal?${new URLSearchParams({ limit: String(options.journal.limit), ...options.journal.after === null ? {} : { after: String(options.journal.after) } })}` : '';
  const target = new URL(`v1/runs/${encodeURIComponent(runId)}${query}`, base.href.endsWith('/') ? base : new URL(base.href + '/'));
  try {
    const response = await transport(target, { method: 'GET', cache: 'no-store', redirect: 'error', signal: attemptSignal(options.timeoutMs ?? 30_000, signal),
      headers: { ...env.API_AUTH_TOKEN ? { authorization: `Bearer ${env.API_AUTH_TOKEN}` } : {}, [WALLET_PRINCIPAL_HEADER]: principal } });
    if (response.status === 404) return { ok: true, value: null };
    const body = await response.json() as { ok?: unknown; value?: unknown };
    if (!response.ok || body.ok !== true || !body.value || typeof body.value !== 'object') return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
    return { ok: true, value: body.value as T };
  } catch (error) { return deadlineEnded(error, signal) ? DEADLINE : { ok: false, code: 'CLOUD_API_UNAVAILABLE' }; }
}

export type CloudRunSummary = { runId: string; flow: string; status: string; ownerAccount: string | null; hasEvidence: boolean; updatedAt: string };
/** BUILD-JOURNEY-001: the signed-in wallet's most recent runs of one flow (the API filters by the principal header). */
export async function listCloudRuns(flow: string, principal: string, options: { env?: Readonly<Record<string, string | undefined>>; transport?: typeof fetch;
  timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FlowResult<CloudRunSummary[]>> {
  const env = options.env ?? process.env, transport = options.transport ?? fetch, signal = options.signal;
  if (signal?.aborted) return DEADLINE;
  let base: URL | null;
  try { base = cloudApiBaseUrl(env); } catch (error) { return { ok: false, code: (error as Error).message }; }
  if (!base) return { ok: false, code: 'CLOUD_API_NOT_CONFIGURED' };
  const target = new URL(`v1/runs?${new URLSearchParams({ flow, limit: '25' })}`, base.href.endsWith('/') ? base : new URL(base.href + '/'));
  try {
    const response = await transport(target, { method: 'GET', cache: 'no-store', redirect: 'error', signal: attemptSignal(options.timeoutMs ?? 30_000, signal),
      headers: { ...env.API_AUTH_TOKEN ? { authorization: `Bearer ${env.API_AUTH_TOKEN}` } : {}, [WALLET_PRINCIPAL_HEADER]: principal } });
    const body = await response.json() as { ok?: unknown; value?: { items?: unknown } };
    if (!response.ok || body.ok !== true || !Array.isArray(body.value?.items)) return { ok: false, code: 'CLOUD_API_UNAVAILABLE' };
    return { ok: true, value: (body.value.items as CloudRunSummary[]).filter(r => r.ownerAccount === principal && r.flow === flow)
      .map(r => ({ runId: r.runId, flow: r.flow, status: r.status, ownerAccount: r.ownerAccount, hasEvidence: r.hasEvidence, updatedAt: r.updatedAt })) };
  } catch (error) { return deadlineEnded(error, signal) ? DEADLINE : { ok: false, code: 'CLOUD_API_UNAVAILABLE' }; }
}
