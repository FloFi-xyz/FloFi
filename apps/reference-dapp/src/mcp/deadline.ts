// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP request deadlines. Every `/api/mcp` request gets ONE budget, created by the gateway when the request arrives:
 *
 *   hard deadline   MCP_REQUEST_BUDGET_MS after arrival: the gateway answers by then whatever is still running (a JSON-RPC error with
 *                   the request id), comfortably below the function limit (`maxDuration` 300 s), so a request never runs until the
 *                   platform kills it with no answer and no log line
 *   tool deadline   MCP_RESPONSE_MARGIN_MS earlier: `signal` aborts, every upstream read in flight is cancelled (the remote runtime's
 *                   fetches carry it) and the tool answers with a classified timeout result instead of waiting
 *   client close    the HTTP request's own signal aborts `signal` too, so work stops when nobody is waiting for it
 *
 * Each upstream operation also has its own cap (`MCP_UPSTREAM_TIMEOUTS`), never more than what remains of the budget. Nothing here
 * retries, resubmits or changes an outcome: a timeout only stops waiting. Whether a write that was in flight took effect is unknown,
 * and callers must say so (see `tools.ts`).
 */
import { randomUUID } from 'node:crypto';
import { CloudDeadlineError } from '../server/cloud-api-client.ts';

/** The route's `maxDuration` (`src/app/api/mcp/route.ts`); the budget below must stay well under it. */
export const MCP_PLATFORM_LIMIT_MS = 300_000;
/** The whole request, gateway work included. */
export const MCP_REQUEST_BUDGET_MS = 150_000;
/** Time kept back from the tools to serialize the answer and close the exchange before the hard deadline. */
export const MCP_RESPONSE_MARGIN_MS = 10_000;
/** Per-operation caps (each attempt is also bounded by what remains of the request budget). */
export const MCP_UPSTREAM_TIMEOUTS = Object.freeze({
  /** Deployment facts (`mode`, `info`) and owner-scoped status reads. */
  read: 15_000,
  /** One read-only simulation preview (quotes, chain reads, transaction simulation). */
  preview: 45_000,
  /** The gateway's own PostgreSQL work before the MCP exchange (OAuth token, wallet links). */
  store: 20_000,
});

/**
 * BUILD-FLOFI-E2E-RELIABILITY-001 (MCP review): per-tool caps inside the request budget. Hosted MCP clients commonly stop waiting for a tool
 * call after about 60 s; a classified timeout answer (an approval request's outcome UNKNOWN, no automatic retry) only helps if it arrives
 * before that, so every tool answers by ~55 s and an approval write by ~50 s. Trade-off: a slow preview that would have finished after 45 s
 * now answers NOT_COMPLETED (retryable) instead of a late success the client would not have received anyway.
 */
export const MCP_TOOL_TIMEOUTS = Object.freeze({ approvalWrite: 50_000, default: 55_000 });

export type BudgetEnd = 'DEADLINE' | 'CLIENT_CLOSED';
export type RequestBudget = {
  /** Correlation id of this request (UUID): returned to the client in every timeout result and logged with every event. */
  readonly requestId: string;
  /** Epoch ms at which the tools stop waiting (`signal` aborts). */
  readonly toolDeadline: number;
  /** Epoch ms at which the gateway answers regardless. */
  readonly hardDeadline: number;
  /** Aborts at the tool deadline or when the client closes the request. */
  readonly signal: AbortSignal;
  /** Milliseconds left before the tool deadline (0 when passed). */
  readonly remaining: () => number;
  /** Why `signal` aborted, or null while the budget is open. */
  readonly ended: () => BudgetEnd | null;
  /** Releases the timer (the gateway calls it once the response is built). */
  readonly dispose: () => void;
};

export type DeadlineCode = 'MCP_REQUEST_TIMEOUT' | 'MCP_UPSTREAM_TIMEOUT' | 'MCP_REQUEST_CANCELLED';
/** A deadline that passed (or a client that went away) while an operation was still running. Never a statement about its outcome. */
export class DeadlineError extends Error {
  readonly code: DeadlineCode;
  constructor(code: DeadlineCode) { super(code); this.name = 'DeadlineError'; this.code = code; }
}
export const isDeadlineError = (error: unknown): error is DeadlineError => error instanceof DeadlineError;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createRequestBudget(options: { readonly totalMs?: number; readonly marginMs?: number; readonly parent?: AbortSignal | null;
  readonly now?: () => number; readonly requestId?: string } = {}): RequestBudget {
  const now = options.now ?? Date.now, started = now();
  const totalMs = Math.max(1, Math.min(options.totalMs ?? MCP_REQUEST_BUDGET_MS, MCP_PLATFORM_LIMIT_MS - 30_000));
  const marginMs = Math.max(0, Math.min(options.marginMs ?? MCP_RESPONSE_MARGIN_MS, Math.floor(totalMs / 2)));
  const hardDeadline = started + totalMs, toolDeadline = hardDeadline - marginMs;
  const controller = new AbortController();
  let ended: BudgetEnd | null = null;
  const end = (why: BudgetEnd) => { if (ended) return; ended = why; controller.abort(new DeadlineError(why === 'DEADLINE' ? 'MCP_REQUEST_TIMEOUT' : 'MCP_REQUEST_CANCELLED')); };
  const timer = setTimeout(() => end('DEADLINE'), Math.max(0, toolDeadline - now()));
  const parent = options.parent ?? null, onParent = () => end('CLIENT_CLOSED');
  if (parent?.aborted) onParent(); else parent?.addEventListener('abort', onParent, { once: true });
  return { requestId: options.requestId && REQUEST_ID.test(options.requestId) ? options.requestId : randomUUID(), toolDeadline, hardDeadline,
    signal: controller.signal, remaining: () => Math.max(0, toolDeadline - now()), ended: () => ended,
    // BUILD-FLOFI-E2E-RELIABILITY-001 (MCP review): the answer is already buffered when the request is disposed, so any read still running
    // (one its own cap or the gateway's deadline answer left behind) is aborted instead of loading the upstream for nobody. `ended` is not
    // set: disposing is not a deadline, and nothing classifies the request after it.
    dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', onParent); if (!controller.signal.aborted) controller.abort(new DeadlineError('MCP_REQUEST_CANCELLED')); } };
}

/**
 * Waits for `operation` at most `capMs` and never past the budget. The operation receives a signal that aborts at whichever comes first,
 * so a cancellable read (a fetch) actually stops. On expiry this rejects with `DeadlineError` — `MCP_UPSTREAM_TIMEOUT` for the
 * operation's own cap, `MCP_REQUEST_TIMEOUT` / `MCP_REQUEST_CANCELLED` for the request's. A late result of a non-cancellable operation
 * is discarded; nothing is retried.
 */
export async function withinBudget<T>(budget: RequestBudget | null | undefined, capMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ownCap = AbortSignal.timeout(Math.max(1, budget ? Math.min(capMs, budget.remaining()) : capMs));
  const capIsOwn = !budget || capMs <= budget.remaining();
  const signal = budget ? AbortSignal.any([budget.signal, ownCap]) : ownCap;
  const reason = (): DeadlineError => budget?.ended() === 'CLIENT_CLOSED' ? new DeadlineError('MCP_REQUEST_CANCELLED')
    : budget?.ended() === 'DEADLINE' || !capIsOwn ? new DeadlineError('MCP_REQUEST_TIMEOUT') : new DeadlineError('MCP_UPSTREAM_TIMEOUT');
  if (signal.aborted) throw reason();
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => { onAbort = () => reject(reason()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([operation(signal), expired]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/**
 * A `fetch` for the remote runtime whose requests also abort with the budget. Once the budget has ended, a transport failure is
 * reported as the classified, NON-retryable `CLOUD_API_DEADLINE_EXCEEDED` (see `cloud-api-client.ts`), so no retry loop keeps going.
 */
export function budgetTransport(budget: RequestBudget): typeof fetch {
  return async (input, init) => {
    if (budget.signal.aborted) throw new CloudDeadlineError();
    const signal = init?.signal ? AbortSignal.any([init.signal, budget.signal]) : budget.signal;
    try { return await globalThis.fetch(input, { ...init, signal }); }
    catch (error) { if (budget.signal.aborted) throw new CloudDeadlineError(); throw error; }
  };
}
