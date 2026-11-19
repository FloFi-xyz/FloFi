// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: content-free operational outcomes of liquidity position management, written to the existing structured
 * log stream (`createLogger`, the same pipeline as journey timings). One closed schema: an outcome, the protocol, the network, the operation
 * and (for a refusal) FloFi's own closed error code, plus a small count bucket for discovery. Never an address, position id, mint, token id,
 * amount, hash, signature, account or chat text — the schema admits none and anything else is dropped.
 *
 * Off unless the deployment owner sets the existing server switch `FLOFI_JOURNEY_TELEMETRY=on` (docs/privacy/JOURNEY-TELEMETRY.md §10, pending
 * owner and legal review like the journey timings). Operational signals only: never financial evidence, billing input or a decision about a person.
 */
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { journeyTelemetryEnabled } from '../domain/journey-metrics.ts';
import { deploymentEnvironment } from './deployment.ts';

export const LIQUIDITY_OUTCOMES = ['POSITIONS_DISCOVERED', 'INSPECTION_UNAVAILABLE', 'COLLECTION_PREPARED', 'WITHDRAWAL_PREPARED', 'EXIT_PREPARED',
  'SIMULATION_REJECTED', 'WALLET_HANDOFF_FAILED', 'PARTIAL_COMPLETION', 'RECONCILED', 'RECONCILIATION_REQUIRED'] as const;
export type LiquidityOutcome = (typeof LIQUIDITY_OUTCOMES)[number];
const PROTOCOLS = ['UNISWAP_V3', 'ORCA'] as const;
const NETWORKS = ['Base', 'Arbitrum One', 'Ethereum', 'Robinhood Chain', 'Solana'] as const;
const OPERATIONS = ['COLLECT', 'DECREASE', 'EXIT', 'CLOSE'] as const;
export type LiquidityOutcomeEvent = { readonly outcome: LiquidityOutcome; readonly protocol: (typeof PROTOCOLS)[number]; readonly network: string;
  readonly operation?: (typeof OPERATIONS)[number] | null; readonly code?: string | null; readonly count?: number | null;
  /** UNKNOWN: a read that failed before any data (and so its provenance) existed. */ readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED' | 'UNKNOWN' };
type Fields = Readonly<Record<string, string | number | null>>;
/**
 * FloFi's own refusal codes only: upper-case words of at most 24 characters, each starting with a letter, and at most two digits in all
 * (`UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED`). A token id, mint, address or amount can never fit (flofi-data-privacy #2).
 */
const CODE = /^(?=.{3,80}$)[A-Z][A-Z0-9]{0,23}(?:_[A-Z][A-Z0-9]{0,23})*$/;
const codeAllowed = (code: string) => CODE.test(code) && (code.match(/[0-9]/g) ?? []).length <= 2;
/** Discovery counts are bucketed so a line never reveals a wallet's exact holdings. */
const bucket = (count: number) => count <= 0 ? '0' : count === 1 ? '1' : count <= 5 ? '2-5' : count <= 20 ? '6-20' : '21+';

let sink: ((fields: Fields) => void) | null = null;
/** Tests only: capture accepted lines instead of the platform logger. */
export function setLiquidityOutcomeSink(next: ((fields: Fields) => void) | null): void { sink = next; }

/** The closed line for an event, or null when any field falls outside the schema (nothing partial is ever logged). */
export function liquidityOutcomeFields(event: LiquidityOutcomeEvent, env: Readonly<Record<string, string | undefined>>): Fields | null {
  if (!LIQUIDITY_OUTCOMES.includes(event.outcome) || !PROTOCOLS.includes(event.protocol) || !(NETWORKS as readonly string[]).includes(event.network) ||
      (event.operation != null && !OPERATIONS.includes(event.operation)) || (event.code != null && !codeAllowed(event.code)) ||
      (event.count != null && (!Number.isSafeInteger(event.count) || event.count < 0)) || !['PUBLIC_MAINNET', 'MOCKED', 'UNKNOWN'].includes(event.provenance)) return null;
  return { schema: 'flofi.liquidity-lifecycle.v1', evidence: 'OPERATIONAL_SIGNAL', deployment: deploymentEnvironment(env), outcome: event.outcome,
    protocol: event.protocol, network: event.network, operation: event.operation ?? null, code: event.code ?? null,
    positions: event.count == null ? null : bucket(event.count), provenance: event.provenance };
}
/**
 * The structured logger adds the current trace and span ids to every line; this line must not carry them, or it could be joined to a run's other
 * span lines (flofi-data-privacy #1; the journey route likewise runs outside any span). Same pipeline, same redaction, no trace fields.
 */
export const TRACE_FIELDS = ['trace_id', 'span_id', 'parent_span_id'] as const;
export function withoutTraceFields(line: string): string {
  const record = JSON.parse(line) as Record<string, unknown>;
  for (const key of TRACE_FIELDS) delete record[key];
  return JSON.stringify(record);
}
const traceFreeLogger = () => createLogger({ service: 'flofi-liquidity', sink: line => { process.stdout.write(withoutTraceFields(line) + '\n'); } });
/** Never throws and never blocks the financial path: a logging failure is dropped. */
export function recordLiquidityOutcome(event: LiquidityOutcomeEvent, env: Readonly<Record<string, string | undefined>> = process.env): void {
  try {
    if (!sink && !journeyTelemetryEnabled(env.FLOFI_JOURNEY_TELEMETRY)) return;
    const fields = liquidityOutcomeFields(event, env);
    if (!fields) return;
    if (sink) sink(fields);
    else traceFreeLogger().info('liquidity.lifecycle', fields);
  } catch { /* operational signal only */ }
}
