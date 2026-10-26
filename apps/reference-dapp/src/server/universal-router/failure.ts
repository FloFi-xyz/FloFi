// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';

export type UniversalFailure = { readonly ok: false; readonly code: string; readonly correlationId: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
/** Never log exception text, stack, provider bodies, RPC URLs, wallet payloads or signatures. */
export function reportUniversalFailure(cause: unknown, operation: string,
  log: (fields: Record<string, string>) => void = fields => console.warn(JSON.stringify(fields))): UniversalFailure {
  const code = cause instanceof Error && CODE.test(cause.message) ? cause.message : 'UNIVERSAL_SERVICE_UNAVAILABLE';
  const correlationId = randomUUID();
  const inner = cause instanceof Error && cause.cause instanceof Error && CODE.test(cause.cause.message) ? cause.cause.message : 'UNCLASSIFIED';
  log({ event: 'bridge.operation_failed', operation: /^[a-zA-Z]{1,40}$/.test(operation) ? operation : 'unknown', code, causeCode: inner, correlationId });
  return { ok: false, code, correlationId };
}
