// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: incidents are DERIVED, never stored. Each one is a condition the durable state shows right now:
 *
 *   EXECUTION            an execution run whose transaction check stopped or is not scheduled, whose evidence archiving stopped, whose
 *                        outcome is uncertain or partial, whose status is unclassified, that a worker flagged, or (in the range) that failed
 *                        on chain. Classified with the analytics classifier (`analytics/classify.ts`), so Workflows and Support agree.
 *   BACKGROUND_TASK      a stopped (DEAD) background task that belongs to no execution run and was not superseded by a later run of the
 *                        same task (automation evaluations and notifications, delegated executions, workflow-run advances, emails…).
 *   WORKFLOW_RUN         a multi-step workflow run in ATTENTION.
 *   DELEGATED_EXECUTION  a delegated (automation) execution that is UNCERTAIN, HALTED or flagged.
 *   PLATFORM / AI        the System Health and AI Copilot conditions the console already measures (`attention.ts`).
 *
 * Every read is tenant-scoped and bounded (fixed LIMITs over existing indexes). When a source cannot be read, its incidents are omitted and
 * the source is reported unavailable — an empty list never claims that everything is healthy. Nothing here writes.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import type { AttentionItem } from '../../components/admin/admin-ui';
import { classifyRun, FAILED_STATUSES, type ExecutionOutcome } from '../analytics/classify.ts';
import { environmentOf, networkInfo, type AnalyticsEnvironment } from '../analytics/networks.ts';
import { explainCode, type IncidentCategory } from './codes.ts';
import { loadExecutions, type ExecutionSnapshot } from './executions.ts';
import { LIFECYCLE_LABELS, loadExecutionAttention, runAttention, type ConditionCode, type ExecutionAttention, type Lifecycle, type RunAttention,
  type StoppedTaskView } from './lifecycle.ts';
import { loadRunsFacts } from './recovery.ts';
export { EXECUTION_SELECT, loadExecutions, snapshotOf, type ExecutionSnapshot } from './executions.ts';
import { GUIDED_RECOVERY, RECOVERY_ACTIONS, type EligibilityState, type GuidedRecovery, type RecoveryActionId, type RunRecoveryFacts } from './registry.ts';

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
export type IncidentSource = 'EXECUTION' | 'BACKGROUND_TASK' | 'WORKFLOW_RUN' | 'DELEGATED_EXECUTION' | 'PLATFORM' | 'AI_COPILOT';
export type IncidentKind = 'OBSERVATION_STOPPED' | 'OBSERVATION_NOT_SCHEDULED' | 'EVIDENCE_ARCHIVE_STOPPED' | 'OUTCOME_UNCERTAIN' | 'PARTIAL_EXECUTION'
  | 'UNCLASSIFIED_STATUS' | 'RESULT_DIVERGED' | 'ATTENTION_FLAGGED' | 'ATTENTION_HISTORICAL' | 'EXECUTION_FAILED' | 'TASK_STOPPED' | 'WORKFLOW_RUN_ATTENTION' | 'DELEGATED_UNRESOLVED' | 'PLATFORM' | 'AI_COPILOT';
/**
 * Whether funds could be involved: NONE (nothing was submitted), POSSIBLE (a transaction was or may have been submitted with real funds — a
 * mainnet run, or one whose environment is not recognised), TEST_ONLY (on a test network or a mocked chain), UNKNOWN.
 */
export type FundsExposure = 'NONE' | 'POSSIBLE' | 'TEST_ONLY' | 'UNKNOWN';
export type Submitted = 'YES' | 'NO' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type Feature = 'swap' | 'transfer' | 'liquidity' | 'lending' | 'bridge' | 'payment' | 'composition' | 'automation' | 'workflow-run' | 'email' | 'platform'
  | 'ai' | 'other';
export const FEATURE_LABELS: Readonly<Record<Feature, string>> = { swap: 'Swap', transfer: 'Transfer', liquidity: 'Liquidity', lending: 'Lending', bridge: 'Cross-chain',
  payment: 'Payment', composition: 'Composition', automation: 'Automations', 'workflow-run': 'Multi-step workflows', email: 'Email', platform: 'Platform', ai: 'AI Copilot',
  other: 'Other' };

/**
 * The incident's lifecycle (`lifecycle.ts`): ACTIVE, UNDER_INVESTIGATION, HISTORICAL or VERIFIED_RESOLVED, or FINAL for an execution that failed
 * on chain with nothing left to intervene on (shown for diagnosis only). Separate from the transaction outcome (`outcome`).
 */
export type IncidentLifecycle = Lifecycle | 'FINAL';
export const INCIDENT_LIFECYCLE_LABELS: Readonly<Record<IncidentLifecycle, string>> = { ...LIFECYCLE_LABELS, FINAL: 'Final outcome (informational)' };
export type Incident = {
  readonly id: string; readonly lifecycle: IncidentLifecycle;
  /** Why the lifecycle is what it is, the active conditions and the stopped-task history (execution incidents only). */
  readonly attention: { readonly explanation: string; readonly conditions: readonly ConditionCode[]; readonly stopped: readonly StoppedTaskView[];
    readonly flagged: boolean; readonly ownerReviewPending: boolean } | null; readonly kind: IncidentKind; readonly source: IncidentSource; readonly category: IncidentCategory; readonly severity: Severity;
  readonly eligibility: EligibilityState; readonly title: string; readonly summary: string; readonly component: string; readonly feature: Feature;
  /** When the condition was last recorded (the resource's last update), ISO. */
  readonly at: string;
  readonly environment: AnalyticsEnvironment | null; readonly networks: readonly string[];
  /** The recorded provenance when it maps to no known environment (shown verbatim, never assumed public). */
  readonly provenance: string | null;
  readonly outcome: string; readonly outcomeKnown: boolean; readonly submitted: Submitted; readonly funds: FundsExposure;
  readonly recommended: string;
  /** Registered recovery actions for this resource and whether each is eligible now (re-checked on the server at execution). */
  readonly actions: readonly { readonly id: RecoveryActionId; readonly eligible: boolean; readonly reason: string | null }[];
  readonly guided: GuidedRecovery | null;
  readonly codes: readonly string[];
  readonly resource: { readonly type: 'run' | 'work' | 'workflow-run' | 'delegated' | 'platform' | 'copilot'; readonly id: string };
};

export const FAILED_LOOKBACK_DAYS = 30, TASK_LOOKBACK_DAYS = 90;
const RECOVERY_KINDS = ['reconcile', 'evidence.archive'];

export function featureOf(name: string): Feature {
  if (/^(automation|delegation)\b/.test(name)) return 'automation';
  if (/^workflow-run\b/.test(name)) return 'workflow-run';
  if (/(^flight|email)/.test(name)) return 'email';
  if (/composition/.test(name)) return 'composition';
  if (/(crosschain|router|bridge|across)/.test(name)) return 'bridge';
  if (/(aave|supply|lending)/.test(name)) return 'lending';
  if (/liquidity/.test(name)) return 'liquidity';
  if (/transfer/.test(name)) return 'transfer';
  if (/swap/.test(name)) return 'swap';
  if (/payment/.test(name)) return 'payment';
  return 'other';
}

const OUTCOME_LABELS: Readonly<Record<ExecutionOutcome, string>> = { NOT_STARTED: 'Not started', NOT_EXECUTED: 'Not executed — nothing landed', IN_PROGRESS: 'In progress — not final',
  COMPLETED: 'Completed', FAILED: 'Failed on chain', PARTIAL: 'Partially completed', UNCERTAIN: 'Outcome unknown', UNCLASSIFIED: 'Outcome unknown (unclassified status)' };
const KNOWN_OUTCOMES = new Set<ExecutionOutcome>(['COMPLETED', 'FAILED', 'NOT_EXECUTED', 'PARTIAL', 'NOT_STARTED']);
const MAYBE_BROADCAST = new Set(['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'NOT_FOUND', 'UNKNOWN', 'RECONCILIATION_REQUIRED']);
/** Attempt states that exist only after a transaction reached the network. */
const BROADCAST = new Set(['HASH', 'PENDING', 'CONFIRMED', 'REVERTED', 'SETTLED', 'PARTIALLY_FILLED', 'REFUND_PENDING', 'REFUNDED']);
const provenNotExecuted = (run: ExecutionSnapshot) => !run.needsObservation && (run.status === 'FAILED' || run.status === 'NOT_EXECUTED') && !!run.errorCode
  && /_SUBMISSION_EXPIRED_NOT_EXECUTED$/.test(run.errorCode) && !run.hasEvidence && run.attempts.every(attempt => !attempt.hash);
const OWNER_RECOVERABLE = new Set(['RECOVERY_REQUIRED', 'RECONCILIATION_REQUIRED', 'SUBMISSION_RESULT_UNKNOWN', 'NOT_FOUND']);

/**
 * What the durable facts say about submission, consistent with the Workflows classifier: a hash, evidence, a post-broadcast attempt state or a
 * started composition phase is YES; a possibly-broadcast attempt, or a run the flow still asks to observe (e.g. a swap handed to the owner's
 * wallet, observed by nonce), is UNKNOWN; otherwise NO.
 */
export function submissionOf(run: ExecutionSnapshot): Submitted {
  if (run.hasEvidence || run.attempts.some(a => a.hash || BROADCAST.has(a.state))) return 'YES';
  if (run.attempts.some(a => MAYBE_BROADCAST.has(a.state))) return 'UNKNOWN';
  if (classifyRun(run).submitted) return 'YES';
  return run.needsObservation ? 'UNKNOWN' : 'NO';
}

function actionStates(facts: RunRecoveryFacts | undefined, ids: readonly RecoveryActionId[]) {
  return ids.map(id => {
    const check = facts ? RECOVERY_ACTIONS[id].check(facts) : { eligible: false as const, state: 'INVESTIGATION' as const, code: 'SUPPORT_FACTS_UNAVAILABLE', reason: 'Recovery facts could not be read.' };
    return { id, eligible: check.eligible, reason: check.eligible ? null : check.reason, state: check.eligible ? null : check.state };
  });
}

/**
 * The incident one execution run represents right now, or null. Pure: every input is a durable fact. Its kind and lifecycle come from the shared
 * attention model (`lifecycle.ts`), so Support, Workflows, System Health and the Overview count the same runs the same way.
 */
export function executionIncident(run: ExecutionSnapshot, facts: RunRecoveryFacts | undefined, now: Date, attention: RunAttention = runAttention(run, facts, null, now)): Incident | null {
  const c = classifyRun(run), submitted = submissionOf(run), environment = environmentOf(run.provenance);
  const realFunds = environment === 'MAINNET' || environment === null;
  const funds: FundsExposure = submitted === 'NO' ? 'NONE' : realFunds ? 'POSSIBLE' : 'TEST_ONLY';
  const reconcile = facts?.latest.reconcile, evidence = facts?.latest['evidence.archive'];
  const crossChain = featureOf(run.flow) === 'bridge', has = (code: ConditionCode) => attention.conditions.includes(code);
  let kind: IncidentKind | null = null;
  if (has('OBSERVATION_EXHAUSTED')) kind = 'OBSERVATION_STOPPED';
  else if (has('OBSERVATION_NOT_SCHEDULED')) kind = 'OBSERVATION_NOT_SCHEDULED';
  else if (has('EVIDENCE_ARCHIVE_STOPPED')) kind = 'EVIDENCE_ARCHIVE_STOPPED';
  else if (has('OUTCOME_UNKNOWN')) kind = 'OUTCOME_UNCERTAIN';
  else if (has('PARTIAL_EXECUTION')) kind = 'PARTIAL_EXECUTION';
  else if (has('UNCLASSIFIED_STATUS')) kind = 'UNCLASSIFIED_STATUS';
  else if (has('RESULT_DIVERGED')) kind = 'RESULT_DIVERGED';
  else if (has('TASK_STOPPED') || has('RETRY_PENDING') || has('FACTS_UNAVAILABLE')) kind = 'ATTENTION_FLAGGED';
  else if (attention.lifecycle === 'HISTORICAL' || attention.lifecycle === 'VERIFIED_RESOLVED') kind = 'ATTENTION_HISTORICAL';
  else if (c.outcome === 'FAILED') kind = 'EXECUTION_FAILED';
  if (!kind) return null;
  const lifecycle: IncidentLifecycle = attention.lifecycle ?? 'FINAL';

  const code = explainCode(run.errorCode), stopped = kind === 'EVIDENCE_ARCHIVE_STOPPED' ? evidence : reconcile;
  const codes = [...new Set([run.errorCode, stopped?.state === 'DEAD' ? stopped.lastError : null, ...attention.stopped.map(s => s.code)]
    .filter((x): x is string => !!x))];
  const actionIds: RecoveryActionId[] = kind === 'OBSERVATION_STOPPED' || kind === 'OBSERVATION_NOT_SCHEDULED' ? ['execution.resume-observation']
    : kind === 'EVIDENCE_ARCHIVE_STOPPED' ? ['execution.retry-evidence-archive'] : [];
  const actions = actionStates(facts, actionIds);
  let eligibility: EligibilityState, severity: Severity, title: string, summary: string, recommended: string, category: IncidentCategory;
  switch (kind) {
    case 'OBSERVATION_STOPPED':
    case 'OBSERVATION_NOT_SCHEDULED': {
      category = crossChain ? 'CROSS_CHAIN' : 'CONFIRMATION';
      severity = funds === 'POSSIBLE' ? 'HIGH' : 'MEDIUM';
      title = kind === 'OBSERVATION_STOPPED' ? 'Transaction check stopped' : 'Transaction check not scheduled';
      summary = kind === 'OBSERVATION_STOPPED'
        ? 'FloFi stopped checking this execution’s transaction before reaching a final answer. Until it is checked again, its result stays unknown.'
        : run.attentionRequired ? 'This execution still needs its transaction checked, but no check is queued, and the background sweeper never re-queues a flagged execution.'
        : 'This execution still needs its transaction checked, but no check is queued. The background sweeper normally re-queues it within a minute — the worker may not be running.';
      const action = actions[0]!;
      eligibility = action.eligible ? 'RECOVERABLE_NOW' : action.state ?? 'INVESTIGATION';
      recommended = action.eligible ? 'Resume the transaction check. It only reads the network and cannot submit anything.' : action.reason ?? 'Investigate.';
      break;
    }
    case 'EVIDENCE_ARCHIVE_STOPPED': {
      category = 'BACKGROUND'; severity = 'LOW'; title = 'Evidence archiving stopped';
      summary = 'The execution finished and was reconciled, but copying its Evidence Bundle to the evidence store stopped. The execution itself is unaffected.';
      const action = actions[0]!;
      eligibility = action.eligible ? 'RECOVERABLE_NOW' : action.state ?? 'INVESTIGATION';
      recommended = action.eligible ? 'Retry evidence archiving.' : action.reason ?? 'Investigate.';
      break;
    }
    case 'OUTCOME_UNCERTAIN':
      category = crossChain ? 'CROSS_CHAIN' : 'CONFIRMATION'; severity = funds === 'POSSIBLE' ? 'HIGH' : 'MEDIUM'; title = 'Outcome unknown';
      summary = 'FloFi cannot establish whether this execution’s transaction landed. It is not treated as failed or successful.';
      if (has('RETRY_PENDING')) {
        eligibility = 'WAITING_EXTERNAL';
        recommended = 'A transaction check was queued again and has not finished. Wait for the worker, then check this page again; the outcome stays unknown until then.';
      } else if (OWNER_RECOVERABLE.has(run.status)) {
        eligibility = 'USER_ACTION';
        recommended = 'Ask the owner to open this execution in FloFi: the app offers its reviewed recovery or reconciliation step, which runs with their own wallet. The Admin cannot act on their behalf.';
      } else { eligibility = 'INVESTIGATION'; recommended = 'Compare the transaction on a block explorer with the timeline below, then record your findings as a note.'; }
      break;
    case 'PARTIAL_EXECUTION':
      category = crossChain ? 'CROSS_CHAIN' : 'TRANSACTION_SUBMISSION'; severity = realFunds ? 'HIGH' : 'MEDIUM'; title = 'Partially completed';
      summary = 'Some steps of this execution completed and others did not. Funds may be in an intermediate position.';
      eligibility = 'USER_ACTION'; recommended = 'Ask the owner to open the workflow and review the failed step; FloFi shows them their recovery options. Never retry it for them.';
      break;
    case 'UNCLASSIFIED_STATUS':
      category = 'UNKNOWN'; severity = 'MEDIUM'; title = 'Status not recognised';
      summary = `The flow reported a status (${run.status}) that Admin analytics does not classify. Its outcome is shown as unknown.`;
      eligibility = 'ENGINEERING'; recommended = 'Escalate: the status must be classified in code before support can reason about it.';
      break;
    case 'RESULT_DIVERGED':
      category = crossChain ? 'CROSS_CHAIN' : 'TRANSACTION_SUBMISSION'; severity = funds === 'POSSIBLE' ? 'HIGH' : 'MEDIUM'; title = 'Result differs from the review';
      summary = 'The transaction was observed, but its effects do not match what the owner reviewed. Funds may have moved differently from the review.';
      eligibility = 'INVESTIGATION';
      recommended = 'Compare the receipt and its events with the reviewed effects in the timeline below, record findings as a note and escalate. Never retry it for the owner.';
      break;
    case 'ATTENTION_FLAGGED': {
      const retrying = has('RETRY_PENDING') && !has('TASK_STOPPED') && !has('FACTS_UNAVAILABLE');
      category = 'BACKGROUND'; severity = 'MEDIUM';
      title = has('FACTS_UNAVAILABLE') ? 'Flagged — task facts unavailable' : retrying ? 'Stopped task queued again' : 'Background task stopped';
      summary = has('FACTS_UNAVAILABLE') ? 'This execution is flagged, and its background-task facts could not be read. It is kept open rather than assumed resolved.'
        : retrying ? 'A task that had stopped for this execution was queued again and has not finished. The incident stays open until it does.'
        : `A background task for this execution stopped (${attention.stopped.filter(s => s.status === 'UNRESOLVED').map(s => s.kind).join(', ')}).`;
      eligibility = retrying ? 'WAITING_EXTERNAL' : 'INVESTIGATION';
      recommended = retrying ? 'Wait for the worker to finish the task, then check this page again.' : 'Review the timeline and background tasks below. No automatic recovery is registered for this condition.';
      break;
    }
    case 'ATTENTION_HISTORICAL':
      category = 'BACKGROUND'; severity = 'LOW'; eligibility = 'NONE';
      title = lifecycle === 'VERIFIED_RESOLVED' ? 'Earlier attention — resolution verified' : 'Earlier attention — no active condition';
      summary = attention.explanation;
      recommended = lifecycle === 'VERIFIED_RESOLVED' ? 'Nothing to do. The original flag and history are kept for accountability.'
        : 'Nothing is demonstrably wrong now, but resolution is not verified. Review the history below if this execution is questioned; record findings as a note.';
      break;
    default:
      category = code?.category ?? 'TRANSACTION_SUBMISSION'; severity = 'LOW'; title = 'Failed on chain';
      summary = submitted === 'YES' ? 'A transaction of this execution was submitted and the network rejected it. The result is final.'
        : 'The service recorded a final failure; whether a transaction reached the network is not established from the recorded attempts.';
      eligibility = code?.remedy === 'CODE' || code?.remedy === 'CONFIGURATION' ? 'ENGINEERING' : code?.remedy === 'UNKNOWN' || !code ? 'INVESTIGATION' : 'USER_ACTION';
      recommended = code?.userAction ?? 'Ask the owner to review the failed step and start again with a fresh quote if it is still wanted.';
  }
  return { id: `run:${run.runId}`, lifecycle, attention: { explanation: attention.explanation, conditions: attention.conditions, stopped: attention.stopped,
      flagged: attention.flagged, ownerReviewPending: attention.ownerReviewPending }, kind, source: 'EXECUTION', category, severity, eligibility, title, summary, component: run.flow, feature: featureOf(run.flow),
    at: run.updatedAt.toISOString(), environment, provenance: environment ? null : run.provenance, networks: run.chains.map(chain => networkInfo(chain).name),
    outcome: has('OUTCOME_UNKNOWN') ? OUTCOME_LABELS.UNCERTAIN : provenNotExecuted(run) ? 'Not executed — expired before it could land (service verdict)'
      : OUTCOME_LABELS[c.outcome], outcomeKnown: !has('OUTCOME_UNKNOWN') && KNOWN_OUTCOMES.has(c.outcome) && !run.needsObservation, submitted, funds, recommended,
    actions: actions.map(({ id, eligible, reason }) => ({ id, eligible, reason })), guided: null, codes, resource: { type: 'run', id: run.runId } };
}

export type StoppedTask = { readonly id: string; readonly kind: string; readonly runId: string | null; readonly lastError: string | null; readonly deliveries: number;
  readonly createdAt: Date; readonly completedAt: Date };
/** A stopped background task outside the execution-run recovery kinds. Never recoverable from the Admin (its handlers can have effects). */
export function taskIncident(task: StoppedTask): Incident {
  const code = explainCode(task.lastError), feature = featureOf(task.kind), delegated = /^delegation\b/.test(task.kind);
  const eligibility: EligibilityState = code?.remedy === 'CODE' || code?.remedy === 'CONFIGURATION' ? 'ENGINEERING' : 'INVESTIGATION';
  return { id: `work:${task.id}`, lifecycle: 'ACTIVE' as const, attention: null, kind: 'TASK_STOPPED', source: 'BACKGROUND_TASK', category: feature === 'automation' ? 'AUTOMATION' : 'BACKGROUND',
    severity: delegated ? 'HIGH' : feature === 'automation' ? 'MEDIUM' : 'LOW', eligibility, title: 'Background task stopped',
    summary: `A “${task.kind}” task stopped after ${task.deliveries} attempt${task.deliveries === 1 ? '' : 's'} and will not run again on its own.`,
    component: task.kind, feature, at: task.completedAt.toISOString(), environment: null, provenance: null, networks: [],
    outcome: delegated ? 'Unknown — check the delegated execution' : 'Not applicable', outcomeKnown: !delegated, submitted: delegated ? 'UNKNOWN' : 'NOT_APPLICABLE',
    funds: delegated ? 'UNKNOWN' : 'NONE',
    recommended: (eligibility === 'ENGINEERING' ? 'Escalate to engineering: ' : 'Investigate before anything else: ') +
      're-running this kind of task from the Admin is not permitted, because it can create proposals, notifications or delegated transactions.',
    actions: [], guided: null, codes: task.lastError ? [task.lastError] : [], resource: { type: 'work', id: task.id } };
}

export type WorkflowRunRow = { readonly runId: string; readonly state: string; readonly code: string | null; readonly mode: string | null; readonly requesterKind: string;
  readonly currentStep: number; readonly stepCount: number; readonly updatedAt: Date };
export function workflowRunIncident(run: WorkflowRunRow): Incident {
  const delegated = run.mode === 'DELEGATED', code = explainCode(run.code);
  return { id: `wfr:${run.runId}`, lifecycle: 'ACTIVE' as const, attention: null, kind: 'WORKFLOW_RUN_ATTENTION', source: 'WORKFLOW_RUN', category: run.requesterKind === 'AUTOMATION_RULE' ? 'AUTOMATION' : code?.category ?? 'TRANSACTION_SUBMISSION',
    severity: delegated ? 'HIGH' : 'MEDIUM', eligibility: code?.remedy === 'USER' ? 'USER_ACTION' : 'INVESTIGATION', title: 'Multi-step workflow needs attention',
    summary: `Step ${Math.min(run.currentStep + 1, run.stepCount)} of ${run.stepCount} could not continue automatically${delegated ? ' (delegated mode)' : ''}.`,
    component: 'workflow-run', feature: 'workflow-run', at: run.updatedAt.toISOString(), environment: null, provenance: null, networks: [], outcome: 'Not final', outcomeKnown: false,
    submitted: 'UNKNOWN', funds: 'UNKNOWN', recommended: code?.userAction ?? 'Ask the owner to open the workflow and review the step; investigate the step’s execution before anything else.',
    actions: [], guided: null, codes: run.code ? [run.code] : [], resource: { type: 'workflow-run', id: run.runId } };
}

export type DelegatedRow = { readonly executionId: string; readonly state: string; readonly code: string | null; readonly attention: boolean; readonly currentStep: number;
  readonly stepCount: number; readonly updatedAt: Date };
export function delegatedIncident(row: DelegatedRow): Incident {
  const uncertain = row.state === 'UNCERTAIN';
  return { id: `dex:${row.executionId}`, lifecycle: 'ACTIVE' as const, attention: null, kind: 'DELEGATED_UNRESOLVED', source: 'DELEGATED_EXECUTION', category: 'AUTOMATION', severity: uncertain ? 'HIGH' : 'MEDIUM',
    eligibility: 'INVESTIGATION', title: uncertain ? 'Delegated execution outcome unknown' : row.state === 'HALTED' ? 'Delegated execution halted' : 'Delegated execution flagged',
    summary: `An automation’s delegated execution is ${row.state.toLowerCase()} at step ${Math.min(row.currentStep + 1, row.stepCount)} of ${row.stepCount}.`,
    component: 'delegated-execution', feature: 'automation', at: row.updatedAt.toISOString(), environment: null, provenance: null, networks: [],
    outcome: uncertain ? 'Outcome unknown' : 'Not final', outcomeKnown: false, submitted: 'UNKNOWN', funds: 'POSSIBLE',
    recommended: 'Investigate on the Automations page and the network. Delegated executions are never retried from the Admin.',
    actions: [], guided: null, codes: row.code ? [row.code] : [], resource: { type: 'delegated', id: row.executionId } };
}

/** Platform conditions from System Health. `attention` and `dead` are skipped: their executions and tasks are listed individually. */
const PLATFORM: Readonly<Record<string, { category: IncidentCategory; eligibility: EligibilityState; recommended: string }>> = {
  db: { category: 'PLATFORM', eligibility: 'WAITING_EXTERNAL', recommended: 'Check the database provider’s status. FloFi cannot recover its own database from the Admin.' },
  schema: { category: 'PLATFORM', eligibility: 'ENGINEERING', recommended: 'Apply the shipped migrations through the normal deployment process.' },
  'db-slow': { category: 'PLATFORM', eligibility: 'WAITING_EXTERNAL', recommended: 'Watch System Health; persistent slowness needs the database provider.' },
  api: { category: 'PLATFORM', eligibility: 'INVESTIGATION', recommended: 'Check the Railway service and its logs.' },
  'api-slow': { category: 'PLATFORM', eligibility: 'WAITING_EXTERNAL', recommended: 'Watch System Health; persistent slowness needs the Railway service checked.' },
  queue: { category: 'BACKGROUND', eligibility: 'INVESTIGATION', recommended: 'Open System Health.' },
  overdue: { category: 'BACKGROUND', eligibility: 'INVESTIGATION', recommended: 'Check that the Railway worker is running. Queued work is processed as soon as it is.' },
  leases: { category: 'BACKGROUND', eligibility: 'WAITING_EXTERNAL', recommended: 'Expired leases are reclaimed by the next worker that polls; check that one is running.' },
  runs: { category: 'BACKGROUND', eligibility: 'INVESTIGATION', recommended: 'Open System Health.' },
  scheduler: { category: 'AUTOMATION', eligibility: 'INVESTIGATION', recommended: 'Open System Health.' },
  rules: { category: 'AUTOMATION', eligibility: 'ENGINEERING', recommended: 'Enable the scheduler on the worker (FLOFI_AUTOMATIONS=enabled) through the deployment configuration.' },
};
export function platformIncidents(items: readonly AttentionItem[], at: Date): Incident[] {
  return items.flatMap(item => {
    const spec = PLATFORM[item.key];
    if (!spec) return [];
    return [{ id: `platform:${item.key}`, lifecycle: 'ACTIVE' as const, attention: null, kind: 'PLATFORM' as const, source: 'PLATFORM' as const, category: spec.category, severity: item.tone === 'bad' ? 'HIGH' as const : 'MEDIUM' as const,
      eligibility: spec.eligibility, title: item.title, summary: typeof item.detail === 'string' ? item.detail : 'Measured by System Health.', component: 'platform',
      feature: 'platform' as const, at: at.toISOString(), environment: null, provenance: null, networks: [], outcome: 'Not applicable', outcomeKnown: true, submitted: 'NOT_APPLICABLE' as const,
      funds: 'NONE' as const, recommended: spec.recommended, actions: [], guided: null, codes: [], resource: { type: 'platform' as const, id: item.key } }];
  });
}
export function copilotIncidents(items: readonly AttentionItem[], at: Date): Incident[] {
  return items.map(item => {
    const config = item.key === 'copilot-invalid' || item.key === 'copilot-unconfigured', key = /^copilot-key-/.test(item.key) || item.key === 'copilot-unavailable';
    const eligibility: EligibilityState = config ? 'REQUIRES_CONFIRMATION' : key ? 'ENGINEERING' : 'INVESTIGATION';
    return { id: `copilot:${item.key}`, lifecycle: 'ACTIVE' as const, attention: null, kind: 'AI_COPILOT' as const, source: 'AI_COPILOT' as const, category: 'AI_COPILOT' as const,
      severity: item.tone === 'bad' ? 'HIGH' as const : 'MEDIUM' as const, eligibility, title: item.title,
      summary: typeof item.detail === 'string' ? item.detail : 'Measured by AI Settings.', component: 'ai-copilot', feature: 'ai' as const, at: at.toISOString(),
      environment: null, provenance: null, networks: [], outcome: 'Not applicable', outcomeKnown: true, submitted: 'NOT_APPLICABLE' as const, funds: 'NONE' as const,
      recommended: config ? 'Restore a known-good version (or save valid settings) in AI Settings; that page validates and audits the change.'
        : key ? 'Install the provider’s API key in the Vercel environment and redeploy, or select a connected provider in AI Settings.' : 'Open AI Settings.',
      actions: [], guided: config ? GUIDED_RECOVERY.copilotRestore : null, codes: [], resource: { type: 'copilot' as const, id: item.key } };
  });
}

export const LIMITS = Object.freeze({ recent: 300, tasks: 100, workflowRuns: 100, delegated: 100 });
export type SourceStatus = { readonly source: IncidentSource; readonly ok: boolean; readonly code: string | null; readonly truncated: boolean };
export type Discovery = { readonly incidents: Incident[]; readonly sources: SourceStatus[];
  /** The shared execution-attention model (null when it could not be read). The same figures System Health, the Overview and Workflows show. */
  readonly attention: ExecutionAttention | null };
const failure = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}/.test(error.message) ? error.message.slice(0, 80) : 'QUERY_FAILED';

/** Every current incident from the durable sources (bounded). Platform and AI conditions are added by the caller from their own probes. */
export async function discoverIncidents(db: Database, tenantId: string, now: Date,
  shared: Promise<ExecutionAttention | null> | null = null): Promise<Discovery> {
  const sources: SourceStatus[] = [], incidents: Incident[] = [];
  const failedSince = new Date(now.getTime() - FAILED_LOOKBACK_DAYS * 86_400_000);
  let attention: ExecutionAttention | null = null;
  const executions = (async () => {
    try {
      // Every run with an attention lifecycle (the shared model), plus executions that failed on chain in the lookback (shown for diagnosis).
      const [model, recent] = await Promise.all([shared ? shared.then(a => { if (!a) throw new Error('EXECUTION_ATTENTION_UNAVAILABLE'); return a; })
          : loadExecutionAttention(db, tenantId, now),
        db.query<{ run_id: string }>(`SELECT run_id FROM execution_runs WHERE tenant_id = $1 AND updated_at >= $2 AND status = ANY($3::text[]) AND NOT attention_required
          ORDER BY updated_at DESC LIMIT ${LIMITS.recent + 1}`, [tenantId, failedSince, [...FAILED_STATUSES]])]);
      attention = model;
      for (const entry of model.entries) { const incident = executionIncident(entry.run, entry.facts, now, entry.attention); if (incident) incidents.push(incident); }
      const seen = new Set(model.entries.map(entry => entry.run.runId)), ids = recent.rows.slice(0, LIMITS.recent).map(row => row.run_id).filter(id => !seen.has(id));
      const [runs, facts] = await Promise.all([loadExecutions(db, tenantId, ids), loadRunsFacts(db, tenantId, ids, now)]);
      for (const run of runs) { const incident = executionIncident(run, facts.get(run.runId), now); if (incident) incidents.push(incident); }
      sources.push({ source: 'EXECUTION', ok: true, code: null, truncated: model.truncated || recent.rows.length > LIMITS.recent });
    } catch (error) { sources.push({ source: 'EXECUTION', ok: false, code: failure(error), truncated: false }); }
  })();
  const tasks = (async () => {
    try {
      // Stopped tasks that no later run of the same task superseded. Recovery kinds tied to an execution are reported with that execution.
      const { rows } = await db.query<{ id: string; kind: string; run_id: string | null; last_error: string | null; deliveries: number; created_at: Date; completed_at: Date }>(
        `SELECT d.id::text AS id, d.kind, d.run_id, d.last_error, d.deliveries, d.created_at, d.completed_at FROM work_items d
          WHERE d.tenant_id = $1 AND d.state = 'DEAD' AND d.completed_at >= $3 AND NOT (d.kind = ANY($2::text[]) AND d.run_id IS NOT NULL)
            AND NOT (d.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM execution_runs e WHERE e.tenant_id = d.tenant_id AND e.run_id = d.run_id))
            AND NOT EXISTS (SELECT 1 FROM work_items n WHERE n.tenant_id = d.tenant_id AND n.kind = d.kind AND n.dedupe_key = d.dedupe_key AND n.id > d.id)
          ORDER BY d.completed_at DESC LIMIT ${LIMITS.tasks + 1}`, [tenantId, RECOVERY_KINDS, new Date(now.getTime() - TASK_LOOKBACK_DAYS * 86_400_000)]);
      for (const row of rows.slice(0, LIMITS.tasks)) incidents.push(taskIncident({ id: row.id, kind: row.kind, runId: row.run_id, lastError: row.last_error,
        deliveries: row.deliveries, createdAt: row.created_at, completedAt: row.completed_at }));
      sources.push({ source: 'BACKGROUND_TASK', ok: true, code: null, truncated: rows.length > LIMITS.tasks });
    } catch (error) { sources.push({ source: 'BACKGROUND_TASK', ok: false, code: failure(error), truncated: false }); }
  })();
  const workflowRuns = (async () => {
    try {
      const { rows } = await db.query<{ run_id: string; state: string; code: string | null; mode: string | null; requester_kind: string; current_step: number; step_count: number;
        updated_at: Date }>(`SELECT run_id, state, code, mode, requester_kind, current_step, step_count, updated_at FROM workflow_runs
          WHERE tenant_id = $1 AND state = 'ATTENTION' ORDER BY updated_at DESC LIMIT ${LIMITS.workflowRuns + 1}`, [tenantId]);
      for (const row of rows.slice(0, LIMITS.workflowRuns)) incidents.push(workflowRunIncident({ runId: row.run_id, state: row.state, code: row.code, mode: row.mode,
        requesterKind: row.requester_kind, currentStep: row.current_step, stepCount: row.step_count, updatedAt: row.updated_at }));
      sources.push({ source: 'WORKFLOW_RUN', ok: true, code: null, truncated: rows.length > LIMITS.workflowRuns });
    } catch (error) { sources.push({ source: 'WORKFLOW_RUN', ok: false, code: failure(error), truncated: false }); }
  })();
  const delegated = (async () => {
    try {
      const { rows } = await db.query<{ execution_id: string; state: string; code: string | null; attention: boolean; current_step: number; step_count: number; updated_at: Date }>(
        `SELECT execution_id, state, code, attention, current_step, step_count, updated_at FROM delegated_executions
          WHERE tenant_id = $1 AND state NOT IN ('SETTLED', 'BLOCKED', 'FAILED') AND (state IN ('UNCERTAIN', 'HALTED') OR attention)
          ORDER BY updated_at DESC LIMIT ${LIMITS.delegated + 1}`, [tenantId]);
      for (const row of rows.slice(0, LIMITS.delegated)) incidents.push(delegatedIncident({ executionId: row.execution_id, state: row.state, code: row.code,
        attention: row.attention, currentStep: row.current_step, stepCount: row.step_count, updatedAt: row.updated_at }));
      sources.push({ source: 'DELEGATED_EXECUTION', ok: true, code: null, truncated: rows.length > LIMITS.delegated });
    } catch (error) { sources.push({ source: 'DELEGATED_EXECUTION', ok: false, code: failure(error), truncated: false }); }
  })();
  await Promise.all([executions, tasks, workflowRuns, delegated]);
  return { incidents, sources, attention };
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export const sortIncidents = (list: readonly Incident[]): Incident[] =>
  [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || (a.id < b.id ? -1 : 1));
