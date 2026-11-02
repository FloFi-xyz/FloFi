// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149: the Automations History never says "Owner executed — reconciling" for a run that was only simulated or refused; it names
 * the intention, simulation, refusal, submission, onchain confirmation (an approval alone included) and reconciliation from the run's records.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_RUN_LABELS, automationRunLabel } from './automation-run-status';
import { HistoryPanel } from './automations-workspace';
import { onceEachRun, recordedRunFacts } from '../automations/run-facts';
import type { OccurrenceView, RuleHistoryView, RunAttemptView, RunView } from '../automations/views';
import type { EngineRuntime } from '../platform/index.ts';
import { portuguese } from '../i18n/pt';
import { portugueseStatusTruth } from '../i18n/pt-status-truth';

const hash = '0x' + 'd'.repeat(64);
const a = (step: string, state: string, patch: Partial<RunAttemptView> = {}): RunAttemptView => ({ step, state, transactionHash: null, reconciled: false, ...patch });
const view = (status: string, attempts: RunAttemptView[] | null = null, patch: Partial<RunView> = {}): RunView => ({ executionId: 'bas-' + '0'.repeat(24), status,
  reconciled: false, terminal: false, errorCode: null, evidenceEnvironment: null, evidenceOutcome: null, evidenceBundleHash: null, needsObservation: false, attempts, ...patch });

describe('Issue #149: Automations History run phases', () => {
  it('a simulated or reviewed-only run says nothing was sent, never an execution', () => {
    for (const status of ['SIMULATED', 'QUOTED', 'PREPARED']) expect(automationRunLabel(view(status, []))).toBe('Simulated only — nothing was sent');
    expect(automationRunLabel(view('AUTHORIZED', []))).toBe('Reviewed only — nothing was sent');
    // BUILD-FLOFI-E2E-RELIABILITY-001: attempts that could not be read never prove that nothing was sent (as on the Dashboard).
    expect(automationRunLabel(view('SIMULATED'))).toBe('Status unresolved — no transaction is repeated');
    expect(automationRunLabel(view('AUTHORIZED'))).toBe('Status unresolved — no transaction is repeated');
  });
  it('an approval-only run keeps an attention label when the run is divergent or unresolved', () => {
    const landed = [a('APPROVAL', 'CONFIRMED', { transactionHash: hash })];
    expect(automationRunLabel(view('CONFIRMED', landed))).toBe('Approval confirmed · main action not sent');
    expect(automationRunLabel(view('DIVERGENT', landed, { errorCode: 'RECONCILIATION_MISMATCH' }))).not.toMatch(/^Approval confirmed/);
  });
  it('a refused, cancelled, expired or never-submitted request is a refusal: nothing was sent', () => {
    for (const status of ['CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'EXPIRED', 'NOT_EXECUTED']) expect(automationRunLabel(view(status)), status).toBe('Refused or not submitted — nothing was sent');
    expect(automationRunLabel(view('AUTHORIZED', [a('SWAP', 'REFUSED')]))).toBe('Refused or not submitted — nothing was sent');
    // A recorded error does not turn a refusal into "Execution ended" or an execution.
    expect(automationRunLabel(view('REJECTED', [], { errorCode: 'WALLET_REJECTED', terminal: true }))).toBe('Refused or not submitted — nothing was sent');
  });
  it('submission, onchain confirmation and reconciliation are distinct; only verified evidence is "reconciled"', () => {
    expect(automationRunLabel(view('AUTHORIZED', [a('SWAP', 'PREPARED')]))).toBe('Awaiting your wallet confirmation — nothing sent yet');
    expect(automationRunLabel(view('PENDING', [a('SWAP', 'PENDING')]))).toBe('Submitted — awaiting confirmation');
    expect(automationRunLabel(view('PENDING', [a('SWAP', 'PENDING', { transactionHash: hash })]))).toBe('Transaction sent — awaiting onchain confirmation');
    expect(automationRunLabel(view('CONFIRMED', [a('SWAP', 'CONFIRMED', { transactionHash: hash })]))).toBe('Confirmed onchain — reconciling');
    expect(automationRunLabel(view('SOURCE_CONFIRMED', [a('DEPOSIT', 'CONFIRMED', { transactionHash: hash })]))).toBe('Origin confirmed — settlement pending');
    // The summary says reconciled but FloFi did not verify reconciled evidence for it: never "Execution reconciled".
    expect(automationRunLabel(view('RECONCILED', [a('SWAP', 'CONFIRMED', { reconciled: true })]))).toBe('Outcome recorded — not yet verified as reconciled');
    expect(automationRunLabel(view('RECONCILED', [a('SWAP', 'CONFIRMED', { reconciled: true })], { reconciled: true, terminal: true }))).toBe('Execution reconciled');
    expect(automationRunLabel(view('SUBMISSION_RESULT_UNKNOWN', [a('SWAP', 'SUBMISSION_RESULT_UNKNOWN')]))).toBe('Status unresolved — no transaction is repeated');
    expect(automationRunLabel(view('REVERTED', [a('SWAP', 'REVERTED', { transactionHash: hash })]))).toBe('Transaction reverted');
  });
  it('an approval that landed before a not-started-looking status is shown as such, never as nothing sent or the main action', () => {
    expect(automationRunLabel(view('CONFIRMED', [a('APPROVAL', 'CONFIRMED', { transactionHash: hash })]))).toBe('Approval confirmed · main action not sent');
    expect(automationRunLabel(view('AUTHORIZED', [a('APPROVAL', 'CONFIRMED', { reconciled: true })]))).toBe('Approval confirmed · main action not sent');
    expect(automationRunLabel(view('CANCELLED', [a('APPROVAL', 'CONFIRMED'), a('SWAP', 'CANCELLED')]))).toBe('Approval confirmed · main action not submitted');
  });
  it('never says "Owner executed — reconciling" for any status, with or without attempts', () => {
    const statuses = ['SIMULATED', 'AUTHORIZED', 'PREPARED', 'CANCELLED', 'REJECTED', 'NOT_SUBMITTED', 'PENDING', 'HASH', 'CONFIRMED', 'RECONCILED', 'FAILED', 'UNKNOWN', 'SOMETHING_NEW'];
    for (const status of statuses) for (const attempts of [null, [], [a('SWAP', 'PREPARED')], [a('APPROVAL', 'CONFIRMED')]]) {
      const label = automationRunLabel(view(status, attempts));
      expect(label).not.toBe('Owner executed — reconciling');
      expect(AUTOMATION_RUN_LABELS.includes(label) || label.startsWith('Approval confirmed · '), `${status} ${label}`).toBe(true);
    }
  });
  it('every History and Dashboard status-truth label has a Portuguese translation that keeps no English sentence', () => {
    const labels = [...AUTOMATION_RUN_LABELS, 'Intention only — not simulated or sent yet', 'Run status could not be read now — not evidence that nothing was sent',
      'No run of this exact proposal recorded yet', 'Approval confirmed · main action not sent', 'Approval confirmed · main action not submitted',
      'Approval confirmed · main action awaiting wallet confirmation', 'Approval confirmed · main action pending confirmation', 'Approval confirmed · main action failed',
      'Approval confirmed · main action unresolved', 'Landed onchain'];
    for (const label of labels) {
      const pt = portuguese[label] ?? portugueseStatusTruth[label];
      expect(pt, label).toBeTruthy();
      expect(pt, label).not.toBe(label);
    }
    // New catalogue entries never replace an existing product translation.
    for (const key of Object.keys(portugueseStatusTruth)) if (Object.hasOwn(portuguese, key)) expect(portuguese[key], key).toBe(portugueseStatusTruth[key]);
  });
  it('renders the History with the run phase instead of "Owner executed — reconciling", and an applied proposal with no run as intention only', () => {
    const occurrence = (id: string, runs: RunView[]): OccurrenceView => ({ occurrenceId: id, ruleId: 'aut-1', ruleName: 'Daily ETH', kind: 'SCHEDULE', state: 'COMPLETED',
      dueAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-11-01T11:00:00.000Z', action: null, observations: [], outcome: 'APPROVAL_APPLIED', decidedAt: null,
      approval: { status: 'APPLIED', runs, runsComplete: id !== 'occ-4' }, notifications: [] });
    const history = { rule: { name: 'Daily ETH', timezone: 'UTC' }, entries: [], occurrences: [occurrence('occ-1', [view('SIMULATED', [])]),
      occurrence('occ-2', [view('REJECTED', [], { executionId: 'bas-' + '1'.repeat(24) })]), occurrence('occ-3', []), occurrence('occ-4', [])] } as unknown as RuleHistoryView;
    const html = renderToStaticMarkup(<HistoryPanel history={history} onClose={() => undefined}/>);
    expect(html).not.toContain('Owner executed');
    expect(html).toContain('Simulated only — nothing was sent');
    expect(html).toContain('Refused or not submitted — nothing was sent');
    // A complete read with no run of this exact proposal, and (BUILD-FLOFI-E2E-RELIABILITY-001) a run read that failed: never "intention only".
    expect(html).toContain('No run of this exact proposal recorded yet');
    expect(html).toContain('Run status could not be read now — not evidence that nothing was sent');
    expect(html).not.toContain('Intention only');
  });
});

describe('Issue #149: automation run facts are read once, as the owner, and reduced to public facts', () => {
  const run = { runId: 'bas-' + '0'.repeat(24), workflowId: 'w', flow: 'base-swap', status: 'CONFIRMED', provenance: 'PUBLIC_MAINNET', ownerAccount: '0x' + 'a'.repeat(40),
    errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false, createdAt: '', updatedAt: '',
    attempts: [{ attemptId: 'x.approval.1', step: 'APPROVAL', state: 'CONFIRMED', nonce: '7', transactionHash: hash, reconciled: false, preparedAtBlock: '1' }, null, { step: 'SWAP' }] };
  it('reuses the shared-runs read for the attempts and drops non-public fields', async () => {
    const calls: string[] = [];
    const runtime = { run: async (id: string, owner: string) => { calls.push(`${owner}:${id}`); return { ok: true, value: run } as const; } } as unknown as EngineRuntime;
    const reads = onceEachRun(runtime);
    await reads.run(run.runId, run.ownerAccount);
    const facts = await recordedRunFacts(reads, run.runId, run.ownerAccount);
    expect(calls).toHaveLength(1);
    expect(facts).toEqual({ needsObservation: false, attempts: [{ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: false }] });
    expect(JSON.stringify(facts)).not.toMatch(/nonce|preparedAtBlock|attemptId/);
  });
  it('says nothing about attempts when the run cannot be read, belongs to another run id or the read fails', async () => {
    const answers = [{ ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' }, { ok: true, value: null }, { ok: true, value: { ...run, runId: 'other' } }];
    for (const answer of answers) expect(await recordedRunFacts({ run: async () => answer } as unknown as EngineRuntime, run.runId, run.ownerAccount))
      .toEqual({ needsObservation: null, attempts: null });
    expect(await recordedRunFacts({ run: async () => { throw new Error('offline'); } } as unknown as EngineRuntime, run.runId, run.ownerAccount))
      .toEqual({ needsObservation: null, attempts: null });
  });
});
