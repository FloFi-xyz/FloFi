// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { BuildEstimateResult } from '../domain/build-estimate';
import { buildEstimateFailureMessage } from '../domain/build-estimate';
/** Safe diagnostics only: no exception text, stacks, URLs, payloads or credentials. */
export function quoteFailure(cause: unknown, correlationId?: string): Extract<BuildEstimateResult, { ok: false }> {
  const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'ESTIMATE_UNAVAILABLE';
  const id = correlationId && /^[a-f0-9-]{36}$/.test(correlationId) ? correlationId : randomUUID();
  console.warn(JSON.stringify({ event: 'swap.quote_failed', code, correlationId: id }));
  return { ok: false, code, reason: buildEstimateFailureMessage(code), correlationId: id };
}
