// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminHost } from '../host.ts';
import { readAiEconomics } from './ai.ts';
import { addDays, consolidate, decimal, difference, divide, endOfMonth, entryQuality, FINOPS_SCOPES, finopsPeriod, isoDay, perUnit,
  periodDays, selectRecords, totalsFor, unavailable, units, type Indicator, type LedgerRecord, type Period } from './economics.ts';
import { ledgerMissing, readLedger, readSyncState } from './store.ts';
import { writeFinopsCsv } from './csv.ts';
import { modelScenario, SCENARIO_FIELDS, SCENARIO_PRESETS, scenarioKeys, type Scenario } from './scenario.ts';
import { readFinancialMeters, readFinancialSync } from './sync-store.ts';
import { financialConnection } from './sync-labels.ts';
import { brlOf, PTAX_REFERENCE, PTAX_SOURCE, type ReportFx, type ReportFxSet } from './report-fx.ts';

const FINANCIAL_PROVIDER_NAMES = { neon: 'Neon', railway: 'Railway', vercel: 'Vercel', openai: 'OpenAI', anthropic: 'Anthropic',
  circleci: 'CircleCI', alchemy: 'Alchemy', resend: 'Resend' } as const;

export type WorkflowEconomics = {
  created: number; completed: number; failed: number; refunded: number; pending: number; abandoned: number; advanced: number; averageSteps: number | null; newest: string | null;
  dimensions: { action: string; network: string; protocol: string; count: number }[];
};
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the workflow cohort stays the MULTI-STEP workflows (step_count >= 2): one-step Editor runs of a single
 * card (migration 0032) are single actions, never counted as workflows (their meaning, average steps and cost per completed workflow stay unchanged).
 * They are counted as their own cohort instead (final workflow review): they have no execution_runs record, so without it they would be counted nowhere.
 */
const COHORT_STEPS = { workflows: 'r.step_count >= 2', 'single-cards': "r.step_count = 1 AND h.requester_kind = 'EDITOR_SESSION'" } as const;
async function readWorkflowEconomics(host: AdminHost, period: Period, cohort: keyof typeof COHORT_STEPS = 'workflows'): Promise<WorkflowEconomics> {
  // Keep this cohort separate from execution_runs, where each component can also have its own record. Mainnet intent does not prove settlement.
  const steps = COHORT_STEPS[cohort];
  return host.db.transaction(async tx => {
    await tx.query("SET LOCAL statement_timeout = '4000'");
    const params = [host.tenantId, period.from + 'T00:00:00Z', period.to + 'T00:00:00Z'];
    const { rows: [data] } = await tx.query<{ created: number; completed: number; failed: number; refunded: number; pending: number; abandoned: number;
      advanced: number; average_steps: number | null; newest: Date | null }>(`SELECT
      count(*) FILTER (WHERE r.created_at >= $2 AND r.created_at < $3)::integer AS created,
      count(*) FILTER (WHERE r.state = 'COMPLETED' AND r.completed_at >= $2 AND r.completed_at < $3
        AND r.step_count = (
        SELECT count(*) FROM workflow_run_steps s WHERE s.tenant_id = r.tenant_id AND s.run_id = r.run_id
          AND s.state = 'RECONCILED' AND s.outcome->'evidence'->>'outcome' = 'RECONCILED'
          AND CASE WHEN s.outcome->>'kind' = 'OWNER_RUN' THEN
            s.outcome->'evidence'->>'environment' = 'MAINNET_EXECUTED'
            AND COALESCE(s.outcome->'evidence'->>'bundleHash', '') <> ''
            AND NOT EXISTS (SELECT 1 FROM workflow_run_steps prior
              WHERE prior.tenant_id = s.tenant_id AND prior.state = 'RECONCILED'
                AND prior.outcome->>'kind' = 'OWNER_RUN' AND prior.outcome->>'flow' = s.outcome->>'flow'
                AND prior.outcome->>'executionId' = s.outcome->>'executionId'
                AND (prior.outcome->>'observedAt', prior.run_id, prior.step_index) < (s.outcome->>'observedAt', s.run_id, s.step_index))
          WHEN s.outcome->>'kind' = 'USER_FUNDED_GROUP' THEN s.outcome->'evidence'->>'environment' = 'PUBLIC_UNVERIFIED' AND EXISTS (
            SELECT 1 FROM workflow_run_groups g WHERE g.tenant_id = s.tenant_id AND g.run_id = s.run_id AND g.state = 'RECONCILED'
              AND s.step_index BETWEEN g.step_from AND g.step_to)
          WHEN s.outcome->>'kind' = 'DELEGATED_STEP' THEN s.outcome->'evidence'->>'environment' = 'PUBLIC_UNVERIFIED' AND EXISTS (
            SELECT 1 FROM delegated_executions d WHERE d.tenant_id = s.tenant_id AND d.workflow_run_id = s.run_id
              AND d.execution_id = s.outcome->>'executionId' AND d.state = 'SETTLED')
          ELSE false END)
        )::integer AS completed,
      count(*) FILTER (WHERE r.state IN ('FAILED','HALTED') AND r.code IS DISTINCT FROM 'BRIDGE_REFUNDED' AND r.updated_at >= $2 AND r.updated_at < $3)::integer AS failed,
      count(*) FILTER (WHERE r.state IN ('FAILED','HALTED') AND r.code = 'BRIDGE_REFUNDED' AND r.updated_at >= $2 AND r.updated_at < $3)::integer AS refunded,
      count(*) FILTER (WHERE r.state IN ('PENDING','RUNNING','ATTENTION') AND r.updated_at >= $2 AND r.updated_at < $3)::integer AS pending,
      count(*) FILTER (WHERE r.state IN ('CANCELLED','EXPIRED') AND r.updated_at >= $2 AND r.updated_at < $3)::integer AS abandoned,
      count(*) FILTER (WHERE r.created_at >= $2 AND r.created_at < $3 AND r.mode IS NOT NULL)::integer AS advanced,
      avg(r.step_count) FILTER (WHERE r.created_at >= $2 AND r.created_at < $3)::float AS average_steps,
      max(r.updated_at) AS newest
      FROM workflow_runs r JOIN mcp_handoffs h ON h.tenant_id = r.tenant_id AND h.handoff_id = r.handoff_id
      WHERE r.tenant_id = $1 AND h.network_environment = 'MAINNET' AND h.funds_class = 'REAL_FUNDS' AND r.created_at < $3 AND r.updated_at >= $2
        AND ${steps}`, params);
    // The plan already provides bounded operation/network/protocol identifiers. No resource, amount, wallet or transaction is selected.
    const { rows } = await tx.query<{ action: string; network: string; protocol: string; count: number }>(`SELECT
      substr(step->>'action', 1, 48) AS action, substr(step->>'network', 1, 48) AS network, substr(step->>'protocol', 1, 48) AS protocol, count(*)::integer
      FROM workflow_runs r JOIN mcp_handoffs h ON h.tenant_id = r.tenant_id AND h.handoff_id = r.handoff_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(h.plan->'steps') = 'array' THEN h.plan->'steps' ELSE '[]'::jsonb END) step
      WHERE r.tenant_id = $1 AND h.network_environment = 'MAINNET' AND h.funds_class = 'REAL_FUNDS' AND r.created_at >= $2 AND r.created_at < $3 AND ${steps}
      GROUP BY 1, 2, 3 ORDER BY 4 DESC, 1, 2, 3 LIMIT 100`, params);
    return { created: data!.created, completed: data!.completed, failed: data!.failed, refunded: data!.refunded, pending: data!.pending,
      abandoned: data!.abandoned, advanced: data!.advanced,
      averageSteps: data!.average_steps, newest: data!.newest?.toISOString() ?? null,
      dimensions: rows.filter(row => [row.action, row.network, row.protocol].every(value => typeof value === 'string' && /^[a-z0-9_-]{1,48}$/i.test(value))) };
  });
}

async function readExecutionEconomics(host: AdminHost, period: Period) {
  return host.db.transaction(async tx => {
    await tx.query("SET LOCAL statement_timeout = '4000'");
    const { rows: [record] } = await tx.query<{ submitted: number; sourceConfirmedBridges: number; reconciled: number; refunded: number; failed: number; pending: number }>(`SELECT
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM execution_attempts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id
        AND a.transaction_hash IS NOT NULL))::integer AS submitted,
      count(*) FILTER (WHERE r.flow LIKE 'crosschain-%' AND r.needs_observation
        AND r.status IN ('SOURCE_CONFIRMED','IN_FLIGHT','DESTINATION_OBSERVED','RECOVERY_REQUIRED'))::integer AS "sourceConfirmedBridges",
      count(*) FILTER (WHERE r.has_evidence AND NOT r.needs_observation AND r.error_code IS NULL
        AND r.status IN ('RECONCILED','COMPLETED','PAYMENT_SETTLED'))::integer AS reconciled,
      count(*) FILTER (WHERE NOT r.needs_observation AND r.status = 'REFUNDED')::integer AS refunded,
      count(*) FILTER (WHERE NOT r.needs_observation AND r.status IN ('FAILED','REVERTED','DIVERGENT','RECONCILIATION_REQUIRED'))::integer AS failed,
      count(*) FILTER (WHERE r.needs_observation)::integer AS pending
      FROM execution_runs r WHERE r.tenant_id = $1 AND r.provenance = 'PUBLIC_MAINNET' AND r.updated_at >= $2 AND r.updated_at < $3`,
    [host.tenantId, period.from + 'T00:00:00Z', period.to + 'T00:00:00Z']);
    return record!;
  });
}

/** Keep observed payer counts in the operations report. They cannot establish a FloFi invoice or debit. */
async function readGasPayerEvidence(host: AdminHost, period: Period) {
  return host.db.transaction(async tx => {
    await tx.query("SET LOCAL statement_timeout = '4000'");
    const { rows: [row] } = await tx.query<{ ownerNative: number; frontedByRelayer: number; sponsorObserved: number; unresolved: number }>(`WITH facts AS (
      SELECT g.namespace, g.fee_payer, g.outcome->'gasPaid' AS gas
      FROM workflow_run_groups g JOIN workflow_runs r ON r.tenant_id = g.tenant_id AND r.run_id = g.run_id
      JOIN mcp_handoffs h ON h.tenant_id = r.tenant_id AND h.handoff_id = r.handoff_id
      WHERE g.tenant_id = $1 AND g.updated_at >= $2 AND g.updated_at < $3
        AND h.network_environment = 'MAINNET' AND h.funds_class = 'REAL_FUNDS'
        AND (g.submission IS NOT NULL OR jsonb_typeof(g.outcome->'gasPaid') = 'object')
    ), classified AS (
      SELECT CASE
        WHEN gas->>'amount' ~ '^[1-9][0-9]{0,77}$'
          AND (namespace = 'eip155' AND gas->>'unit' = 'wei' AND gas->>'source' IN ('RECEIPT', 'USER_OPERATION_EVENT')
            AND gas->>'payer' ~* '^0x[0-9a-f]{40}$'
          OR namespace = 'solana' AND gas->>'unit' = 'lamports' AND gas->>'source' = 'SOLANA_META'
            AND gas->>'payer' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
        THEN CASE
          WHEN gas->'sponsored' = 'true'::jsonb AND NOT (gas ? 'paidInToken') AND gas->>'source' = 'USER_OPERATION_EVENT'
            AND lower(gas->>'payer') <> fee_payer THEN 'sponsor'
          WHEN NOT (gas ? 'sponsored') AND gas->'paidInToken'->>'amount' ~ '^(0|[1-9][0-9]{0,77})$' AND
            CASE gas->'paidInToken'->>'mechanism'
              WHEN 'CIRCLE_USDC_PAYMASTER' THEN gas->>'source' = 'USER_OPERATION_EVENT' AND lower(gas->>'payer') <> fee_payer
              WHEN 'PIMLICO_KORA_SPL_FEE' THEN gas->>'source' = 'SOLANA_META' AND gas->>'payer' <> fee_payer
              WHEN 'ZEROX_GASLESS_SWAP' THEN gas->>'source' = 'RECEIPT' AND lower(gas->>'payer') <> fee_payer
            END THEN 'relayer'
          WHEN NOT (gas ? 'sponsored' OR gas ? 'paidInToken') AND
            CASE WHEN namespace = 'eip155' THEN lower(gas->>'payer') ELSE gas->>'payer' END = fee_payer THEN 'owner'
        END
      END AS payer FROM facts
    )
    SELECT count(*) FILTER (WHERE payer = 'owner')::int AS "ownerNative",
      count(*) FILTER (WHERE payer = 'relayer')::int AS "frontedByRelayer",
      count(*) FILTER (WHERE payer = 'sponsor')::int AS "sponsorObserved",
      count(*) FILTER (WHERE payer IS NULL)::int AS unresolved FROM classified`,
    [host.tenantId, period.from + 'T00:00:00Z', period.to + 'T00:00:00Z']);
    return row!;
  });
}

type Ledger = { status: 'available' | 'missing' | 'failed'; records: LedgerRecord[]; complete: boolean };
async function readCosts(host: AdminHost, period: Period): Promise<Ledger> {
  try { return { status: 'available', ...await readLedger(host, period) }; }
  catch (error) { return { status: ledgerMissing(error) ? 'missing' : 'failed', records: [], complete: false }; }
}
const recordedAmount = (row: LedgerRecord) => row.source === 'INVOICE' || row.source === 'ACCOUNTING' || row.source === 'PROVIDER_COST';
const reportedCosts = (ledger: Ledger, period: Period) => totalsFor(ledger.records.filter(recordedAmount), period, ledger.complete);
const samePeriod = (a: Period, b: Period) => a.from === b.from && a.to === b.to;
const comparableDays = (closed: Period, previous: Period) => Math.min(periodDays(closed), periodDays(previous));
const allExpenses = (scope: (typeof FINOPS_SCOPES)[keyof typeof FINOPS_SCOPES]) => scope.category !== 'revenue';
export const REPORT_LIMITATIONS = [
  'Reports use UTC periods with an inclusive first day and an exclusive end boundary. Indivisible billing records spanning a boundary are excluded.',
  'Higher-authority invoice records supersede overlapping provider reports and estimates for the same service and environment. No estimate is added to a bill.',
  'An invoice or accounting record also supersedes overlapping provider-reported costs of the same service in any environment. Provider-reported costs are shown as PROVIDER_REPORTED until reconciled.',
  'Missing provider coverage or exchange rates are unavailable. A partial total is the sum of covered amounts. Currency conversion uses the entry’s documented USD per unit rate.',
  'Recorded expenses include invoices and provider-reported costs. Usage and estimates are shown separately from recorded expenses.',
  'Workflow counts cover canonical multi-step mainnet workflow runs; one-step single-card runs are counted separately. Legacy or single-flow runs, draft creation, complete simulation and approval counts, and exact cross-channel attribution are unavailable.',
  'Single-card attempts an owner deleted from History (never sent: ended before any wallet request, or rejected and proven unsent) leave the single-card counts, including for closed periods; completed runs and costs are unaffected.',
  'Collected revenue uses reconciled accounting records. Deferred 10 bps obligations, nominal step values, and user-paid network fees are excluded. Gross volume and fee eligibility are unavailable.',
  'The infrastructure-adjusted result excludes corporate expenses outside the available ledger and is an operating indicator.',
] as const;

export async function readFinopsReport(host: AdminHost, period: Period, now: Date) {
  const current = finopsPeriod(now, {}).period, previous = finopsPeriod(now, { range: 'previous' }).period;
  const ledgerPromise = readCosts(host, period);
  const [ledger, month, prior, ai, workflow, sync, integrations, executions, gas, singleCards] = await Promise.all([
    ledgerPromise, samePeriod(current, period) ? ledgerPromise : readCosts(host, current),
    samePeriod(previous, period) ? ledgerPromise : readCosts(host, previous), readAiEconomics(host, period, now).catch(() => null),
    readWorkflowEconomics(host, period).catch(() => null), readSyncState(host).catch(() => []),
    readFinancialSync(host).catch(() => ({ available: false, unreadable: true as const, providers: [] as never[] })),
    readExecutionEconomics(host, period).catch(() => null),
    readGasPayerEvidence(host, period).catch(() => null),
    readWorkflowEconomics(host, period, 'single-cards').catch(() => null),
  ]);
  const totals = reportedCosts(ledger, period);
  const billing = 'Net scoped provider costs and reconciled invoices, including applicable credits, discounts and taxes.';
  const overall = consolidate(totals, allExpenses, billing);
  const infrastructure = consolidate(totals, scope => allExpenses(scope) && !scope.variable, billing);
  const aiCost = consolidate(totals, scope => scope.category === 'ai', billing);
  const variable = consolidate(totals, scope => scope.variable, billing);
  const revenue = consolidate(totals, scope => scope.category === 'revenue', 'Administrator-reconciled platform fee accounting records.');
  const incompleteMargin = 'Complete cost and realized revenue coverage is required for margins.';
  const contribution = revenue.quality === 'PARTIAL' || variable.quality === 'PARTIAL' ? unavailable(incompleteMargin)
    : difference(revenue, variable, 'Reconciled revenue less identified variable operating costs.');
  const result = revenue.quality === 'PARTIAL' || overall.quality === 'PARTIAL' ? unavailable(incompleteMargin)
    : difference(revenue, overall, 'Reconciled revenue less identified variable, fixed and shared operating costs.');
  const closed = { from: current.from, to: isoDay(now) };
  const elapsed = periodDays(closed);
  const knownClosed = consolidate(reportedCosts(month, closed), allExpenses, billing);
  const projectionSource = 'Covered closed UTC days in this month × calendar-month days ÷ elapsed days. Expenses are assumed to accrue linearly.';
  const projected = elapsed > 0 && knownClosed.amount !== null
    ? { amount: decimal(divide(units(knownClosed.amount) * BigInt(periodDays({ from: current.from, to: endOfMonth(now) })), BigInt(elapsed))),
      quality: (knownClosed.quality === 'PARTIAL' ? 'PARTIAL' : 'ESTIMATED') as Indicator['quality'], source: projectionSource }
    : unavailable(projectionSource);
  const costPerChat = perUnit(overall, ai?.chats.observed ?? 0, 'Period expenses ÷ recorded Web interpretations and Channel Core turns. Other interactions may be missing.', false);
  const costPerCompleted = perUnit(overall, workflow?.completed ?? 0, 'Period expenses ÷ recorded completions in the canonical mainnet workflow cohort.', false);
  const costPerActive = unavailable('Cross-channel distinct active user denominator is unavailable.');
  const directSimulated = unavailable('Workflow-linked direct costs and complete successful simulation counts are unavailable.');
  const directCompleted = unavailable('Workflow-linked direct costs are unavailable.');
  const costPerSimulated = unavailable('Cross-surface successful simulation denominator is unavailable.');
  const breakEvenRevenue = overall.amount !== null && overall.quality !== 'PARTIAL'
    ? { ...overall, source: 'Reconciled revenue required to cover the selected period’s recorded operating costs.' }
    : unavailable('Complete cost coverage is required to calculate an actual break-even revenue target.');
  const currentTotals = reportedCosts(month, current);
  const monthToDate = consolidate(currentTotals, allExpenses, billing);
  const previousMonth = consolidate(reportedCosts(prior, previous), allExpenses, billing);
  // Like for like: this month's closed days against the same number of days at the start of the previous month.
  const matchedDays = comparableDays(closed, previous);
  const thisSameDays = { from: closed.from, to: addDays(closed.from, matchedDays) };
  const priorSameDays = { from: previous.from, to: addDays(previous.from, matchedDays) };
  const currentToDate = samePeriod(closed, thisSameDays) ? knownClosed : consolidate(reportedCosts(month, thisSameDays), allExpenses, billing);
  const previousToDate = consolidate(reportedCosts(prior, priorSameDays), allExpenses, billing);
  const monthlyChange = matchedDays > 0 && currentToDate.amount !== null && previousToDate.amount !== null
      && currentToDate.quality !== 'PARTIAL' && previousToDate.quality !== 'PARTIAL'
    ? difference(currentToDate, previousToDate, 'Recorded costs over the same number of closed UTC days at the start of each month.')
    : unavailable('Comparable periods with complete coverage are required for a monthly cost change.');
  const metrics = { monthToDate, previousMonth, monthlyChange, projected, aiCost, variable, infrastructure, overall, costPerActive, costPerChat, costPerSimulated,
    costPerCompleted, directSimulated, directCompleted, revenue, contribution, result, breakEvenRevenue };
  const providerRows = await Promise.all(integrations.providers.map(async provider => {
    // Alchemy reports compute units only; its cost cell is the whole RPC scope (any RPC invoice), labelled as such.
    const name = provider.id === 'alchemy' ? 'Alchemy (RPC providers total)' : FINANCIAL_PROVIDER_NAMES[provider.id];
    const cost = consolidate(currentTotals, scope => scope.provider === (provider.id === 'alchemy' ? 'RPC providers' : FINANCIAL_PROVIDER_NAMES[provider.id]), billing);
    const overlapping = provider.coverage.filter(coverage => coverage.period.from < period.to && coverage.period.to > period.from).slice(0, 3);
    const meters = (await Promise.all(overlapping.map(async coverage => {
      const measurements = await readFinancialMeters(host, provider.id, coverage.period.from).catch(() => []);
      return measurements.map(meter => ({ ...meter, collectedAt: coverage.collectedAt }));
    }))).flat();
    // A selected period can intersect a provider's monthly aggregate without
    // containing it. Include only meters whose whole period fits.
    return { ...provider, name, cost, connection: financialConnection(provider, cost.amount, now),
      meters: meters.filter(meter => meter.period.from >= period.from && meter.period.to <= period.to) };
  }));
  const selected = new Set((selectRecords(ledger.records)).map(record => record.id));
  return { period, current, previous, metrics, ai, workflow, singleCards, sync, integrations: { ...integrations, providers: providerRows }, executions, gas, totals, ledger: { status: ledger.status, complete: ledger.complete,
    records: ledger.records.map(row => ({ ...row, selected: selected.has(row.id) })) } };
}
export type FinopsReport = Awaited<ReturnType<typeof readFinopsReport>> & { readonly fx?: ReportFxSet };
export type MetricId = keyof FinopsReport['metrics'];
export const METRIC_LABELS: Record<MetricId, string> = {
  monthToDate: 'Month-to-date infrastructure and operating costs', previousMonth: 'Previous month infrastructure and operating costs',
  monthlyChange: 'Observed month-to-month cost difference (same days)',
  projected: 'Projected end-of-month costs', aiCost: 'Provider and ledger AI costs', variable: 'Variable operating costs',
  infrastructure: 'Fixed and shared expenses', overall: 'Infrastructure and operating costs', costPerActive: 'Cost per active user',
  costPerChat: 'Allocated cost per observed chat interaction', costPerSimulated: 'Allocated cost per simulated workflow',
  costPerCompleted: 'Fully allocated cost per completed workflow', directSimulated: 'Direct cost per simulated workflow',
  directCompleted: 'Direct cost per completed workflow', revenue: 'Reconciled collected revenue', contribution: 'Contribution margin',
  result: 'Infrastructure-adjusted operating result', breakEvenRevenue: 'Break-even revenue target',
};

export function metricPeriod(report: FinopsReport, key: MetricId): Period {
  if (key === 'monthToDate') return report.current;
  if (key === 'previousMonth') return report.previous;
  if (key === 'monthlyChange') {
    const closed = { from: report.current.from, to: addDays(report.current.to, -1) };
    return { from: closed.from, to: addDays(closed.from, comparableDays(closed, report.previous)) };
  }
  if (key === 'projected') return { from: report.current.from, to: endOfMonth(new Date(report.current.from + 'T00:00:00Z')) };
  return report.period;
}

export function metricFx(fx: ReportFxSet | undefined, key: MetricId) {
  if (key === 'monthToDate' || key === 'projected' || key === 'monthlyChange') return fx?.indicative;
  return key === 'previousMonth' ? fx?.previous : fx?.selected;
}

export function investorCsv(report: FinopsReport, scenario: Scenario | null = null): string {
  const { ai, workflow, period } = report;
  const rows: (string | number | null)[][] = [['section','indicator','start_utc','end_utc_exclusive','amount','unit','quality','source','freshness_utc']];
  function addBrl(section: string, label: string, range: Period, amount: string | null, quality: string, fx: ReportFx | undefined) {
    if (!fx) return;
    const brl = brlOf(amount, fx);
    rows.push([section + ' translation', label, range.from, range.to, brl, 'BRL', brl === null ? 'UNAVAILABLE' : quality,
      `${PTAX_SOURCE} · indicative presentation · ${fx.policy} · as of ${fx.asOf} · ${fx.quote?.rate ?? 'unavailable'} BRL/USD · ${fx.quote?.publishedAt ?? 'unavailable'} America/Sao_Paulo · ${PTAX_REFERENCE}`, null]);
  }
  for (const key of Object.keys(METRIC_LABELS) as MetricId[]) {
    const metric = report.metrics[key], range = metricPeriod(report, key);
    rows.push(['overview', METRIC_LABELS[key], range.from, range.to, metric.amount, 'USD', metric.quality, metric.source, null]);
    addBrl('overview', METRIC_LABELS[key], range, metric.amount, metric.quality, metricFx(report.fx, key));
  }
  for (const total of report.totals) {
    const scope = FINOPS_SCOPES[total.id];
    rows.push(['providers', scope.provider + ' / ' + scope.name, period.from, period.to, total.amount, 'USD', total.quality,
      total.sources.join(', ') || 'No available scoped record', total.updatedAt]);
    addBrl('providers', scope.provider + ' / ' + scope.name, period, total.amount, total.quality, report.fx?.selected);
  }
  for (const record of report.ledger.records) {
    if (!record.selected || record.period.from < period.from || record.period.to > period.to) continue;
    const section = recordedAmount(record) ? 'ledger originals' : 'ledger estimates and usage';
    rows.push([section, record.scope + ' / ' + record.environment, record.period.from, record.period.to, record.net, record.currency, entryQuality(record),
      [record.source, record.fxUsd ? `${record.fxUsd} USD per ${record.currency} · documented ledger FX rate` : ''].filter(Boolean).join(' · '), record.updatedAt]);
  }
  if (ai) {
    rows.push(['AI', 'Estimated list-price sample', period.from, period.to, ai.costEstimate.amount, 'USD', ai.costEstimate.quality, ai.costEstimate.source, ai.freshness]);
    for (const { usage, estimate, pricedRequests } of ai.models) {
      const model = /^(?:gpt-|o[1-9](?:-|$)|claude-)[a-z0-9.-]{0,90}$/i.test(usage.model) ? usage.model : 'Unknown response model';
      rows.push(['AI', [usage.provider, model, usage.surface].join(' / '), period.from, period.to,
        estimate?.toFixed(8) ?? null, 'USD', estimate === null ? 'UNAVAILABLE' : pricedRequests === usage.requests ? 'ESTIMATED' : 'PARTIAL',
        'Reported provider calls priced with versioned standard rates', ai.freshness]);
    }
    for (const [label, amount] of [['Recorded provider calls', ai.calls.requests], ['Reported input samples', ai.calls.inputSamples], ['Reported output samples', ai.calls.outputSamples],
      ['Observed chat interactions', ai.chats.observed], ['Tool calls', ai.toolCalls], ['Tool failures', ai.toolFailures],
      ['Mean provider latency (ms)', ai.calls.meanLatency]] as const) {
      rows.push(['AI coverage', label, period.from, period.to, amount, 'count', 'PARTIAL', 'Server aggregates', ai.freshness]);
    }
    for (const day of ai.daily) rows.push(['AI daily', 'Daily list-price estimate', day.day, addDays(day.day, 1),
      day.estimate?.toFixed(8) ?? null, 'USD', day.estimate === null ? 'UNAVAILABLE' : day.pricedRequests === day.requests ? 'ESTIMATED' : 'PARTIAL',
      `${day.pricedRequests} priced of ${day.requests} recorded provider calls`, ai.freshness]);
  }
  if (scenario) {
    for (const key of scenarioKeys) rows.push(['scenario assumptions', SCENARIO_FIELDS[key].label, null, null, scenario[key], null, 'ESTIMATED', 'Administrator-entered assumption', null]);
    for (const users of new Set([scenario.users, ...SCENARIO_PRESETS])) {
      const model = modelScenario({ ...scenario, users });
      for (const [label, amount, unit] of [
        ['Workflows initiated', model.workflows, 'count'], ['Workflows completed', model.completed, 'count'], ['Chats', model.chats, 'count'],
        ['AI spend', model.ai, 'USD'], ['Workflow spend', model.workflow, 'USD'], ['Gas sponsorship', model.gas, 'USD'],
        ['Total operating costs', model.total, 'USD'], ['Collected fee revenue', model.revenue, 'USD'], ['Contribution', model.contribution, 'USD'],
        ['Infrastructure-adjusted result', model.result, 'USD'], ['Break-even workflow volume', model.breakEvenWorkflows, 'count'],
      ] as const) rows.push(['scenario results', users + ' users / ' + label, null, null, amount, unit, 'ESTIMATED', 'Scenario assumptions', null]);
    }
  }
  if (workflow) {
    for (const [label, amount] of [['Created', workflow.created], ['Completed and reconciled', workflow.completed], ['Failed or halted', workflow.failed],
      ['Refunded workflows', workflow.refunded], ['Pending workflows', workflow.pending],
      ['Cancelled or expired', workflow.abandoned], ['Average steps', workflow.averageSteps]] as const) {
      rows.push(['workflows', label, period.from, period.to, amount, 'count', 'PARTIAL', 'Canonical mainnet workflow runs', workflow.newest]);
    }
  }
  if (report.singleCards) {
    const single = report.singleCards;
    for (const [label, amount] of [['Created', single.created], ['Completed and reconciled', single.completed], ['Failed or halted', single.failed],
      ['Refunded', single.refunded], ['Pending', single.pending], ['Cancelled or expired', single.abandoned]] as const) {
      rows.push(['single-card runs', label, period.from, period.to, amount, 'count', 'PARTIAL', 'One-step single-card mainnet runs, separate from workflows', single.newest]);
    }
  }
  if (report.executions) for (const [label, amount] of Object.entries(report.executions))
    rows.push(['executions', label, period.from, period.to, amount, 'count', 'PARTIAL', 'Durable mainnet execution records, separate from workflows', null]);
  if (report.gas) for (const [label, amount] of Object.entries(report.gas))
    rows.push(['gas payer evidence', label, period.from, period.to, amount, 'groups', 'PARTIAL', 'Recorded mainnet workflow groups, operational evidence only', null]);
  // An unreadable or unactivated synchronization state is said, never an empty section. A removed credential's old error is not current.
  if (!report.integrations.available)
    rows.push(['integration status', 'all', period.from, period.to, null, null, 'UNAVAILABLE', 'Automatic synchronization state unavailable', null]);
  for (const provider of report.integrations.providers) {
    rows.push(['integration status', provider.id, period.from, period.to, null, null,
      provider.connection,
      provider.configured ? provider.errorCode : null, provider.lastSuccess]);
    for (const coverage of provider.coverage) {
      if (coverage.period.from >= period.to || coverage.period.to <= period.from) continue;
      rows.push(['financial integrations', provider.id, coverage.period.from, coverage.period.to, coverage.meterCount, 'metrics',
        coverage.quality, coverage.limitations.join(', '), coverage.collectedAt]);
    }
  }
  for (const provider of report.integrations.providers) for (const meter of provider.meters) {
    // Meters are detail, never additive: a USD meter repeats a provider cost row (or an estimate kept out of the totals).
    const money = meter.unit === 'USD', estimate = meter.metric.includes('estimate');
    const qualifier = estimate ? 'Usage-based estimate. Exclude from costs. ' : money ? 'Detail of provider costs. Exclude from totals. ' : '';
    rows.push(['financial meters', provider.id + ' / ' + meter.service + ' / ' + meter.metric, meter.period.from, meter.period.to, meter.amount,
      meter.unit, estimate ? 'ESTIMATED' : money ? 'PROVIDER_REPORTED' : 'METERED',
      qualifier + (meter.basis ?? 'Scoped provider usage API'), meter.collectedAt]);
  }
  for (const limitation of REPORT_LIMITATIONS) rows.push(['methodology', limitation, period.from, period.to, null, null, null, null, null]);
  return writeFinopsCsv(rows);
}
export const inclusiveEnd = (period: Period) => addDays(period.to, -1);
