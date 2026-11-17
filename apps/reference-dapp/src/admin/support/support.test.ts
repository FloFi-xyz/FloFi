// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: the pure support rules — code explanations, recovery eligibility, incident classification, search
 * shapes, note validation, the evidence timeline and recovery verification. Unknown outcomes are never reported as failures, only registered
 * idempotent tasks are ever offered for recovery, and "accepted" is never "resolved".
 */
import { describe, expect, it } from 'vitest';
import { explainCode, retryableStopReason } from './codes.ts';
import { buildTimeline, freeText, identifierShaped, incidentStatus, isIncidentId, noteText, searchKind, type AttemptRow, type JournalRow, type Note } from './diagnostics.ts';
import { copilotIncidents, delegatedIncident, executionIncident, featureOf, platformIncidents, sortIncidents, submissionOf, taskIncident, workflowRunIncident,
  type ExecutionSnapshot } from './incidents.ts';
import { RUN_ID, verification, stoppedAgainDetail } from './recovery.ts';
import { attentionClearable, GUIDED_RECOVERY, RECOVERY_ACTION_IDS, RECOVERY_ACTIONS, RETRY_LIMIT, stateToken, type RunRecoveryFacts, type WorkFact } from './registry.ts';

const now = new Date('2026-11-14T12:00:00.000Z'), hour = 3_600_000;
const task = (kind: string, state: WorkFact['state'], lastError: string | null = null, id = '7'): WorkFact =>
  ({ id, kind, state, lastError, deliveries: 500, createdAt: new Date(now.getTime() - 9 * 24 * hour), completedAt: state === 'DONE' || state === 'DEAD' ? now : null });
/** Like the database: every kind whose newest task is DEAD has a stopped history (stopped items are never pruned). */
const facts = (over: Partial<RunRecoveryFacts> = {}): RunRecoveryFacts => {
  const latest = over.latest ?? { reconcile: task('reconcile', 'DEAD', 'OBSERVATION_BUDGET_EXHAUSTED') };
  const stoppedKinds = Object.values(latest).filter(t => t.state === 'DEAD').map(t => ({ kind: t.kind, count: 1, lastError: t.lastError, lastStoppedAt: now, newestState: 'DEAD' as const }));
  return { runId: 'bas-1', flow: 'base-swap', status: 'SUBMISSION_RESULT_UNKNOWN', needsObservation: true, attentionRequired: true, hasEvidence: false, evidenceArchived: false,
    logVersion: 4, unresolvedDeadKinds: ['reconcile'], recentRecoveries: 0, ...over, latest, stoppedKinds: over.stoppedKinds ?? stoppedKinds };
};
const run = (over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot => ({ runId: 'bas-1', workflowId: 'wf-1', flow: 'base-swap', status: 'SUBMISSION_RESULT_UNKNOWN',
  provenance: 'PUBLIC_MAINNET', errorCode: null, needsObservation: true, attentionRequired: true, hasEvidence: false, createdAt: new Date(now.getTime() - 10 * 24 * hour),
  updatedAt: new Date(now.getTime() - hour), attempts: [{ step: 'SWAP', state: 'SUBMISSION_RESULT_UNKNOWN', hash: false, reconciled: false }], journalAuthorized: true,
  chains: ['eip155:8453'], ...over });
const resume = RECOVERY_ACTIONS['execution.resume-observation'], archive = RECOVERY_ACTIONS['execution.retry-evidence-archive'];

describe('code explanations', () => {
  it('explains exact codes, then patterns, then falls back explicitly', () => {
    expect(explainCode('OBSERVATION_BUDGET_EXHAUSTED')).toMatchObject({ remedy: 'TRANSIENT', category: 'BACKGROUND', deployment: 'NO', known: true });
    expect(explainCode('ROUTER_STATE_CORRUPT')).toMatchObject({ remedy: 'CODE', deployment: 'CODE' });
    expect(explainCode('BASE_RPC_TIMEOUT')).toMatchObject({ remedy: 'TRANSIENT', category: 'QUOTE_PROVIDER' });
    expect(explainCode('UNIVERSAL_SUBMISSION_EXPIRED_NOT_EXECUTED')).toMatchObject({ remedy: 'USER', category: 'TRANSACTION_SUBMISSION' });
    expect(explainCode('TRANSFER_PUBLIC_TESTNET_NOT_ENABLED')).toMatchObject({ remedy: 'CONFIGURATION', deployment: 'CONFIG' });
    expect(explainCode('ZZZ_SOMETHING_NEW')).toMatchObject({ known: false, category: 'UNKNOWN', remedy: 'UNKNOWN' });
    expect(explainCode(null)).toBeNull();
    expect(explainCode('<script>')).toMatchObject({ code: 'UNCLASSIFIED_ERROR' });
  });
  it('only transient stop reasons are retryable', () => {
    expect(retryableStopReason('OBSERVATION_BUDGET_EXHAUSTED')).toBe(true);
    expect(retryableStopReason('BASE_RPC_TIMEOUT')).toBe(true);
    for (const code of ['WORK_PAYLOAD_INVALID', 'WORK_KIND_UNKNOWN', 'SWAP_STATE_CORRUPT', 'WORK_HANDLER_FAILED', null]) expect(retryableStopReason(code)).toBe(false);
  });
});

describe('recovery registry', () => {
  it('registers exactly two actions, both re-queueing existing idempotent read-only/archival tasks', () => {
    expect(RECOVERY_ACTION_IDS.sort()).toEqual(['execution.resume-observation', 'execution.retry-evidence-archive']);
    expect(Object.values(RECOVERY_ACTIONS).map(action => action.workKind).sort()).toEqual(['evidence.archive', 'reconcile']);
    for (const action of Object.values(RECOVERY_ACTIONS)) {
      expect(action.permission).toBe('recover');
      expect(action.auditKind).toBe('SUPPORT_RECOVERY');
      expect(action.fundsInvolved).toMatch(/^No funds move/);
      expect(action.preconditions.length).toBeGreaterThan(2);
    }
    expect(GUIDED_RECOVERY.copilotRestore.href).toMatch(/^\/admin\/ai-settings/);
  });
  it('resume observation: eligible only for a stopped, retryable check of an execution that still needs one', () => {
    expect(resume.check(facts())).toEqual({ eligible: true });
    expect(resume.check(facts({ latest: {}, unresolvedDeadKinds: [], attentionRequired: false }))).toEqual({ eligible: true }); // not scheduled at all
    // Flagged, but the check itself did not stop: not a registered condition (and never a way to clear the flag).
    expect(resume.check(facts({ latest: { reconcile: task('reconcile', 'DONE') }, unresolvedDeadKinds: [] })))
      .toMatchObject({ eligible: false, state: 'INVESTIGATION', code: 'SUPPORT_CONDITION_NOT_REGISTERED' });
    expect(resume.check(facts({ needsObservation: false }))).toMatchObject({ eligible: false, state: 'NONE', code: 'SUPPORT_NOTHING_TO_RECOVER' });
    expect(resume.check(facts({ latest: { reconcile: task('reconcile', 'LEASED') } }))).toMatchObject({ eligible: false, state: 'WAITING_EXTERNAL', code: 'SUPPORT_ALREADY_SCHEDULED' });
    expect(resume.check(facts({ latest: { reconcile: task('reconcile', 'READY') } }))).toMatchObject({ code: 'SUPPORT_ALREADY_SCHEDULED' });
    expect(resume.check(facts({ latest: { reconcile: task('reconcile', 'DEAD', 'BASE_SWAP_STATE_CORRUPT') } })))
      .toMatchObject({ eligible: false, state: 'ENGINEERING', code: 'SUPPORT_STOP_REASON_NOT_RETRYABLE' });
    expect(resume.check(facts({ recentRecoveries: RETRY_LIMIT }))).toMatchObject({ eligible: false, state: 'ENGINEERING', code: 'SUPPORT_RETRY_LIMIT_REACHED' });
  });
  it('evidence archiving: only an unarchived bundle whose archiving stopped', () => {
    const base = facts({ needsObservation: false, hasEvidence: true, latest: { 'evidence.archive': task('evidence.archive', 'DEAD', 'OBSERVATION_BUDGET_EXHAUSTED') },
      unresolvedDeadKinds: ['evidence.archive'] });
    expect(archive.check(base)).toEqual({ eligible: true });
    expect(archive.check({ ...base, evidenceArchived: true })).toMatchObject({ state: 'NONE' });
    expect(archive.check({ ...base, hasEvidence: false })).toMatchObject({ state: 'NONE' });
    expect(archive.check({ ...base, latest: {}, unresolvedDeadKinds: [] })).toMatchObject({ eligible: false, code: 'SUPPORT_CONDITION_NOT_REGISTERED' });
  });
  it('the state token changes with every fact eligibility reads', () => {
    const token = stateToken(facts(), 'execution.resume-observation');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(stateToken(facts(), 'execution.resume-observation')).toBe(token);
    for (const changed of [facts({ logVersion: 5 }), facts({ status: 'PENDING' }), facts({ attentionRequired: false }), facts({ latest: { reconcile: task('reconcile', 'DEAD', 'X', '8') } }),
      facts({ unresolvedDeadKinds: ['reconcile', 'evidence.archive'] })]) expect(stateToken(changed, 'execution.resume-observation')).not.toBe(token);
    expect(stateToken(facts(), 'execution.retry-evidence-archive')).not.toBe(token);
  });
  it('the attention flag is cleared only when no other stopped task holds it', () => {
    expect(attentionClearable(facts(), 'reconcile')).toBe(true);
    expect(attentionClearable(facts({ unresolvedDeadKinds: ['reconcile', 'evidence.archive'] }), 'reconcile')).toBe(false);
    expect(attentionClearable(facts({ attentionRequired: false }), 'reconcile')).toBe(false);
    expect(attentionClearable(facts({ latest: {}, unresolvedDeadKinds: [] }), 'reconcile')).toBe(false); // nothing of ours set it
    expect(attentionClearable(facts({ latest: { reconcile: task('reconcile', 'DONE') }, unresolvedDeadKinds: [] }), 'reconcile')).toBe(false);
  });
});

describe('incident classification', () => {
  it('a stopped check of a possibly-submitted transaction is a high-severity, recoverable confirmation incident with an unknown outcome', () => {
    const incident = executionIncident(run(), facts(), now)!;
    expect(incident).toMatchObject({ id: 'run:bas-1', kind: 'OBSERVATION_STOPPED', category: 'CONFIRMATION', severity: 'HIGH', eligibility: 'RECOVERABLE_NOW',
      submitted: 'UNKNOWN', funds: 'POSSIBLE', outcomeKnown: false, environment: 'MAINNET', networks: ['Base'], codes: ['OBSERVATION_BUDGET_EXHAUSTED'] });
    expect(incident.outcome).toMatch(/unknown/i);
    expect(incident.outcome).not.toMatch(/fail/i);
    expect(incident.actions).toEqual([{ id: 'execution.resume-observation', eligible: true, reason: null }]);
  });
  it('a check that is running is not an incident; a permanently stopped one needs engineering', () => {
    expect(executionIncident(run({ attentionRequired: false }), facts({ attentionRequired: false, latest: { reconcile: task('reconcile', 'LEASED') }, unresolvedDeadKinds: [] }), now)).toBeNull();
    expect(executionIncident(run(), facts({ latest: { reconcile: task('reconcile', 'DEAD', 'WORK_PAYLOAD_INVALID') } }), now)).toMatchObject({ eligibility: 'ENGINEERING' });
  });
  it('an unscheduled check is reported only after the sweeper had time to re-queue it', () => {
    const quiet = run({ attentionRequired: false }), f = facts({ attentionRequired: false, latest: {}, unresolvedDeadKinds: [] });
    expect(executionIncident(quiet, f, now)).toMatchObject({ kind: 'OBSERVATION_NOT_SCHEDULED', eligibility: 'RECOVERABLE_NOW' });
    expect(executionIncident({ ...quiet, updatedAt: new Date(now.getTime() - 60_000) }, f, now)).toBeNull();
  });
  it('uncertain, partial, unclassified and failed executions are classified without guessing', () => {
    const idle = facts({ needsObservation: false, attentionRequired: false, latest: {}, unresolvedDeadKinds: [] });
    expect(executionIncident(run({ status: 'RECOVERY_REQUIRED', needsObservation: false, attentionRequired: false }), idle, now))
      .toMatchObject({ kind: 'OUTCOME_UNCERTAIN', eligibility: 'USER_ACTION', outcome: 'Outcome unknown', actions: [] });
    expect(executionIncident(run({ status: 'INCONCLUSIVE', needsObservation: false, attentionRequired: false }), idle, now))
      .toMatchObject({ kind: 'OUTCOME_UNCERTAIN', eligibility: 'INVESTIGATION' });
    expect(executionIncident(run({ status: 'PARTIALLY_COMPLETED', needsObservation: false, attentionRequired: false, attempts: [{ step: 'SWAP', state: 'CONFIRMED', hash: true, reconciled: true }] }),
      idle, now)).toMatchObject({ kind: 'PARTIAL_EXECUTION', severity: 'HIGH', eligibility: 'USER_ACTION', funds: 'POSSIBLE' });
    expect(executionIncident(run({ status: 'BRAND_NEW_STATE', needsObservation: false, attentionRequired: false }), idle, now))
      .toMatchObject({ kind: 'UNCLASSIFIED_STATUS', eligibility: 'ENGINEERING' });
    expect(executionIncident(run({ status: 'REVERTED', errorCode: 'SWAP_REVERTED', needsObservation: false, attentionRequired: false,
      attempts: [{ step: 'SWAP', state: 'REVERTED', hash: true, reconciled: false }] }), idle, now))
      .toMatchObject({ kind: 'EXECUTION_FAILED', severity: 'LOW', eligibility: 'USER_ACTION', outcomeKnown: true, submitted: 'YES' });
    expect(executionIncident(run({ status: 'RECONCILED', needsObservation: false, attentionRequired: false, hasEvidence: true,
      attempts: [{ step: 'SWAP', state: 'CONFIRMED', hash: true, reconciled: true }] }), { ...idle, hasEvidence: true, evidenceArchived: true }, now)).toBeNull();
  });
  it('evidence archiving that stopped is low severity and recoverable', () => {
    const done = run({ status: 'RECONCILED', needsObservation: false, hasEvidence: true, attempts: [{ step: 'SWAP', state: 'CONFIRMED', hash: true, reconciled: true }] });
    expect(executionIncident(done, facts({ needsObservation: false, hasEvidence: true, latest: { 'evidence.archive': task('evidence.archive', 'DEAD', 'OBSERVATION_BUDGET_EXHAUSTED') },
      unresolvedDeadKinds: ['evidence.archive'] }), now)).toMatchObject({ kind: 'EVIDENCE_ARCHIVE_STOPPED', severity: 'LOW', eligibility: 'RECOVERABLE_NOW', outcome: 'Completed' });
  });
  it('submission is read from facts consistently with the Workflows classifier', () => {
    const idle = { needsObservation: false, attentionRequired: false, hasEvidence: false };
    expect(submissionOf(run({ ...idle, attempts: [{ step: 'S', state: 'PENDING', hash: true, reconciled: false }] }))).toBe('YES');
    expect(submissionOf(run({ ...idle, attempts: [{ step: 'S', state: 'PENDING', hash: false, reconciled: false }] }))).toBe('YES'); // post-broadcast state
    expect(submissionOf(run({ ...idle, attempts: [{ step: 'S', state: 'SUBMITTING', hash: false, reconciled: false }] }))).toBe('UNKNOWN');
    expect(submissionOf(run({ ...idle, attempts: [{ step: 'S', state: 'RECONCILIATION_REQUIRED', hash: false, reconciled: false }] }))).toBe('UNKNOWN');
    expect(submissionOf(run({ ...idle, attempts: [{ step: 'S', state: 'PREPARED', hash: false, reconciled: false }] }))).toBe('NO');
    // A swap handed to the owner's wallet: PREPARED, but the flow observes it by nonce — not "nothing was submitted".
    expect(submissionOf(run({ ...idle, needsObservation: true, attempts: [{ step: 'S', state: 'PREPARED', hash: false, reconciled: false }] }))).toBe('UNKNOWN');
    // A Solana composition carries no attempts; its started phases count as submitted, as in Workflows.
    expect(submissionOf(run({ ...idle, flow: 'solana-devnet-composition', status: 'BOUND', attempts: [] }))).toBe('YES');
  });
  it('test-network and mocked runs never claim real funds and are capped below high severity', () => {
    for (const provenance of ['PUBLIC_TESTNET', 'MOCKED']) expect(executionIncident(run({ provenance }), facts(), now)).toMatchObject({ funds: 'TEST_ONLY', severity: 'MEDIUM' });
    expect(executionIncident(run({ provenance: 'FORK_REPLAY' }), facts(), now)).toMatchObject({ funds: 'POSSIBLE', environment: null, provenance: 'FORK_REPLAY' });
  });
  it('stopped tasks, workflow runs and delegated executions are never offered an Admin retry', () => {
    const delegation = taskIncident({ id: '9', kind: 'delegation.execute', runId: null, lastError: 'OBSERVATION_BUDGET_EXHAUSTED', deliveries: 500, createdAt: now, completedAt: now });
    expect(delegation).toMatchObject({ actions: [], severity: 'HIGH', funds: 'UNKNOWN', eligibility: 'INVESTIGATION', feature: 'automation' });
    expect(taskIncident({ id: '1', kind: 'automation.notify', runId: null, lastError: 'WORK_KIND_UNKNOWN', deliveries: 1, createdAt: now, completedAt: now }))
      .toMatchObject({ actions: [], eligibility: 'ENGINEERING' });
    expect(workflowRunIncident({ runId: 'wfr_a', state: 'ATTENTION', code: null, mode: 'DELEGATED', requesterKind: 'AUTOMATION_RULE', currentStep: 1, stepCount: 2, updatedAt: now }))
      .toMatchObject({ actions: [], severity: 'HIGH', category: 'AUTOMATION' });
    expect(delegatedIncident({ executionId: 'dex_a', state: 'UNCERTAIN', code: null, attention: false, currentStep: 0, stepCount: 1, updatedAt: now }))
      .toMatchObject({ actions: [], severity: 'HIGH', outcome: 'Outcome unknown', funds: 'POSSIBLE' });
  });
  it('platform and AI conditions map to guidance; only AI configuration links to its versioned restore', () => {
    const platform = platformIncidents([{ key: 'api', tone: 'bad', title: 'The Railway API is not ready', detail: 'API_TIMEOUT' }, { key: 'dead', tone: 'warn', title: 'x' },
      { key: 'schema', tone: 'bad', title: 'Schema' }], now);
    expect(platform.map(i => [i.id, i.eligibility])).toEqual([['platform:api', 'INVESTIGATION'], ['platform:schema', 'ENGINEERING']]);
    const ai = copilotIncidents([{ key: 'copilot-invalid', tone: 'bad', title: 'Invalid' }, { key: 'copilot-key-ANTHROPIC', tone: 'bad', title: 'Key' }], now);
    expect(ai.map(i => [i.eligibility, i.guided?.id ?? null])).toEqual([['REQUIRES_CONFIRMATION', 'config.copilot-restore'], ['ENGINEERING', null]]);
  });
  it('sorts by severity, then newest first; features come from flow and task names', () => {
    const a = taskIncident({ id: '1', kind: 'flight.email', runId: null, lastError: null, deliveries: 1, createdAt: now, completedAt: new Date(now.getTime() - hour) });
    const b = taskIncident({ id: '2', kind: 'delegation.execute', runId: null, lastError: null, deliveries: 1, createdAt: now, completedAt: new Date(now.getTime() - 2 * hour) });
    expect(sortIncidents([a, b]).map(i => i.id)).toEqual(['work:2', 'work:1']);
    expect(['crosschain-router-base-to-robinhood', 'base-aave', 'uniswap-liquidity', 'base-mainnet-transfer', 'jupiter-swap', 'pix-payment', 'workflow-run.advance']
      .map(featureOf)).toEqual(['bridge', 'lending', 'liquidity', 'transfer', 'swap', 'payment', 'workflow-run']);
  });
});

describe('search, notes and timeline', () => {
  it('accepts only closed identifier shapes', () => {
    expect(searchKind(`0x${'ab'.repeat(32)}`)).toEqual({ kind: 'TRANSACTION_HASH', value: `0x${'ab'.repeat(32)}` });
    expect(searchKind(`0x${'AB'.repeat(20)}`)).toEqual({ kind: 'WALLET', value: `0x${'ab'.repeat(20)}` });
    expect(searchKind(`wfr_${'a'.repeat(26)}`)?.kind).toBe('WORKFLOW_RUN');
    expect(searchKind(`dex_${'b'.repeat(26)}`)?.kind).toBe('DELEGATED_EXECUTION');
    expect(searchKind('run:bas-1')?.kind).toBe('INCIDENT');
    expect(searchKind('12345')?.kind).toBe('WORK_ITEM');
    expect(searchKind('bas-0123456789abcdef')?.kind).toBe('EXECUTION_OR_WORKFLOW');
    expect(searchKind('5'.repeat(88))?.kind).toBe('TRANSACTION_HASH'); // a Solana signature
    for (const bad of ['', '   ', 'alice@example.com', "x' OR 1=1 --", 'some words here', 'a'.repeat(200)]) expect(searchKind(bad)).toBeNull();
  });
  it('audit free text refuses personal identifiers but keeps operational detail', () => {
    for (const ok of ['RPC outage resolved; customer ticket 1234', 'outage on 2026-11-14', 'see rhx-0123456789abcdef0123456789abcdef', 'Provider outage resolved'])
      expect([ok, identifierShaped(ok)]).toEqual([ok, false]);
    for (const bad of [`wallet 0x${'ab'.repeat(20)}`, 'mail joe@example.com', 'call 11 9999 99999', '@joe asked', `sig ${'5'.repeat(88)}`, 'card 4111111111111111'])
      expect([bad, identifierShaped(bad), freeText(bad, 3, 500)]).toEqual([bad, true, null]);
    // Wallet- or hash-shaped ids never reach an audit target.
    expect([RUN_ID.test(`0x${'ab'.repeat(20)}`), RUN_ID.test('bas-0123456789abcdef'), isIncidentId(`run:0x${'ab'.repeat(20)}`), isIncidentId('run:bas-1')]).toEqual([false, true, false, true]);
  });
  it('notes are bounded plain text', () => {
    expect(noteText('  RPC   outage resolved  ')).toBe('RPC outage resolved');
    for (const bad of ['', 'ab', 'x'.repeat(501), '<script>alert(1)</script>', 'line\u0007bell', 'bidi \u202e override', 'zero\u200bwidth', 'lone \ud800 surrogate', 42])
      expect(noteText(bad)).toBeNull();
    const note = (kind: Note['kind']): Note => ({ eventId: '1', at: now.toISOString(), actor: 'adm_x', incidentId: 'run:a', kind, text: 'x', textState: 'AVAILABLE' });
    expect([incidentStatus([]), incidentStatus([note('FINDING')]), incidentStatus([note('ESCALATION'), note('FINDING')]), incidentStatus([note('RESOLUTION')])])
      .toEqual(['NEW', 'INVESTIGATING', 'ESCALATED', 'RESOLUTION_NOTED']);
  });
  it('the timeline marks observed, inferred, unknown and unavailable facts and never turns an unknown outcome into a failure', () => {
    const journal: JournalRow[] = [
      { sequence: 0, level: 'workflow', entityId: 'w', attemptId: null, fromState: null, toState: 'DRAFT', recordedAt: new Date(now.getTime() - 5 * hour) },
      { sequence: 1, level: 'workflow', entityId: 'w', attemptId: null, fromState: 'SIMULATED', toState: 'AUTHORIZED', recordedAt: new Date(now.getTime() - 4 * hour) }];
    const attempts: AttemptRow[] = [{ attemptId: 'a', step: 'SWAP', state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null, reconciled: false, createdAt: now, updatedAt: now }];
    const evidence = Object.fromEntries(buildTimeline(run(), journal, attempts).map(m => [m.key, m.evidence]));
    expect(evidence).toEqual({ created: 'OBSERVED', validated: 'INFERRED', simulated: 'INFERRED', authorized: 'OBSERVED', submitted: 'UNKNOWN', observed: 'UNKNOWN',
      result: 'UNKNOWN', final: 'UNKNOWN' });
    const none = Object.fromEntries(buildTimeline(run({ attempts: [], needsObservation: false, attentionRequired: false, status: 'SIMULATED' }), [], []).map(m => [m.key, m.evidence]));
    expect(none).toMatchObject({ validated: 'UNAVAILABLE', simulated: 'UNAVAILABLE', authorized: 'NOT_REACHED', submitted: 'NOT_REACHED' });
    const confirmed = buildTimeline(run({ status: 'RECONCILED', needsObservation: false, attentionRequired: false, hasEvidence: true }), journal,
      [{ ...attempts[0]!, state: 'CONFIRMED', transactionHash: `0x${'1'.repeat(64)}`, reconciled: true }]);
    expect(confirmed.find(m => m.key === 'result')).toMatchObject({ evidence: 'OBSERVED' });
    expect(confirmed.find(m => m.key === 'final')).toMatchObject({ evidence: 'OBSERVED' });
    // A confirmed approval does not make a multi-step run "confirmed" while its swap's result is unknown.
    const multi = buildTimeline(run({ attempts: [{ step: 'APPROVAL', state: 'CONFIRMED', hash: true, reconciled: true },
      { step: 'SWAP', state: 'SUBMISSION_RESULT_UNKNOWN', hash: false, reconciled: false }] }), journal,
    [{ ...attempts[0]!, attemptId: 'ap', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: `0x${'2'.repeat(64)}`, reconciled: true }, attempts[0]!]);
    expect(multi.find(m => m.key === 'result')).toMatchObject({ evidence: 'UNKNOWN' });
  });
});

describe('recovery verification', () => {
  const row = (over: Partial<Parameters<typeof verification>[1]> = {}) => ({ item_state: null, last_error: null, status: 'PENDING', needs_observation: true, evidence_archived: false, ...over });
  it('distinguishes accepted, resolved, stopped again and inconclusive', () => {
    expect(verification('reconcile', row({ item_state: 'READY' })).status).toBe('PENDING_VERIFICATION');
    expect(verification('reconcile', row({ item_state: 'LEASED' })).status).toBe('PENDING_VERIFICATION');
    expect(verification('reconcile', row({ item_state: 'DEAD', last_error: 'OBSERVATION_BUDGET_EXHAUSTED' }))).toMatchObject({ status: 'STOPPED_AGAIN', code: 'OBSERVATION_BUDGET_EXHAUSTED' });
    expect(verification('reconcile', row({ item_state: 'DONE', needs_observation: false, status: 'RECONCILED' })).status).toBe('RESOLVED');
    expect(verification('reconcile', row({ item_state: 'DONE' })).status).toBe('INCONCLUSIVE');
    expect(verification('reconcile', row({ needs_observation: false })).status).toBe('RESOLVED');
    expect(verification('evidence.archive', row({ item_state: 'DONE', evidence_archived: true })).status).toBe('RESOLVED');
    expect(verification('evidence.archive', row({ item_state: 'DONE' })).status).toBe('INCONCLUSIVE');
  });
});

// BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (ADMIN-01): an Arbitrum → Base run whose nonce was consumed by a different transaction (MOCKED codes) and
// was resumed three times: each resumed check stopped again with the same stable evidence after one or two deliveries.
describe('why a recovered check stopped again', () => {
  const row = (over: Partial<Parameters<typeof verification>[1]> = {}) => ({ item_state: 'DEAD' as const, last_error: null, status: 'SUBMISSION_RESULT_UNKNOWN',
    needs_observation: true, evidence_archived: false, ...over });
  it('a stable nonce conflict is the designed stop, not a temporary failure, and never a settlement', () => {
    const stopped = verification('reconcile', row({ last_error: 'NONCE_CONFLICT_STABLE_OPERATOR_REVIEW', deliveries: 2 }));
    expect(stopped).toMatchObject({ status: 'STOPPED_AGAIN', code: 'NONCE_CONFLICT_STABLE_OPERATOR_REVIEW', runStatus: 'SUBMISSION_RESULT_UNKNOWN' });
    expect(stopped.detail).toMatch(/^Stopped again after 2 checks: the nonce-conflict investigation found exactly the same evidence/);
    expect(stopped.detail).toContain('not a temporary failure'); expect(stopped.detail).toContain('stops again');
    expect(stopped.detail).toContain('outcome stays UNKNOWN'); expect(stopped.detail).not.toMatch(/\b(resolved|succeeded|reconciled)\b/i); expect(stopped.detail).toContain('nothing was submitted, repeated or marked as settled');
  });
  it('a temporary RPC or provider condition is said to be temporary', () => {
    const detail = stoppedAgainDetail('ROUTER_RPC_TIMEOUT', 1);
    expect(detail).toMatch(/^Stopped again after 1 check on a temporary condition: External service unavailable \(ROUTER_RPC_TIMEOUT\)/);
    expect(stoppedAgainDetail('OBSERVATION_BUDGET_EXHAUSTED', null)).toContain('temporary condition: Background check gave up');
  });
  it('any other stop names its code without guessing, and a missing count is not invented', () => {
    expect(stoppedAgainDetail('ROUTER_STORE_CORRUPT', 3)).toBe('The task stopped again after 3 checks without a final result (Stored state failed validation: ROUTER_STORE_CORRUPT). '
      + 'The execution is flagged for attention again.');
    expect(stoppedAgainDetail(null, null)).toBe('The task stopped again without a final result. The execution is flagged for attention again.');
  });
});
