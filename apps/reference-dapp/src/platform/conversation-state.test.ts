// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canonicalRunLifecycle, CANONICAL_EXECUTION_STATUSES } from '../domain/canonical-execution-status.ts';
import { approvalState, authoringState, CONVERSATION_STATES, conversationState, executionState, simulationState, userFacingError, validationState,
  workflowRunState } from './conversation-state.ts';

describe('BUILD-FLOFI-UNIVERSAL-CHANNELS-001 conversational lifecycle', () => {
  it('authoring states come only from the deterministic engine', () => {
    expect(authoringState('COMPOSED', 0).state).toBe('DRAFT_CREATED');
    expect(authoringState('REVIEWED', 0)).toMatchObject({ state: 'REVIEW_REQUIRED', nextStep: 'REQUEST_APPROVAL', final: false, completed: false });
    expect(authoringState('REVIEWED', 2)).toMatchObject({ state: 'VALIDATION_REQUIRED', reason: 'REVIEW_BLOCKERS', nextStep: 'FIX_REQUEST' });
    expect(simulationState()).toMatchObject({ state: 'SIMULATION_COMPLETED', completed: false });
    expect(validationState({ valid: false, issues: [{ rule: 'required' }] })).toMatchObject({ state: 'MISSING_INFORMATION', nextStep: 'PROVIDE_DETAILS' });
    expect(validationState({ valid: false, issues: [{ rule: 'pattern' }] }).state).toBe('VALIDATION_REQUIRED');
    expect(validationState({ valid: true, reviewSummary: { block: 1 } }).state).toBe('VALIDATION_REQUIRED');
    expect(validationState({ valid: true, reviewSummary: { block: 0 } }).state).toBe('REVIEW_REQUIRED');
  });

  it('maps every canonical execution status, and only a reconciled outcome is completed', () => {
    for (const status of CANONICAL_EXECUTION_STATUSES) {
      const s = executionState({ status, final: false, completed: false });
      expect(CONVERSATION_STATES).toContain(s.state);
      expect(s.completed).toBe(s.state === 'CONFIRMED');
      if (s.completed) expect(['RECONCILED', 'RECONCILED_WITH_ATTENTION']).toContain(status);
    }
    // A reconciled label whose evidence check failed is never reported as confirmed.
    expect(executionState({ status: 'RECONCILED', final: true, completed: true }, { reconciled: false }).state).toBe('PENDING_CONFIRMATION');
    expect(executionState(canonicalRunLifecycle({ status: 'SUBMITTING' })).state).toBe('NEEDS_ATTENTION');
    expect(executionState(canonicalRunLifecycle({ status: 'REJECTED' }))).toMatchObject({ state: 'CANCELLED', reason: 'SIGNATURE_REJECTED_OR_NOT_SUBMITTED' });
  });

  it('approval handoff states, terminal and pending', () => {
    expect(approvalState({ status: 'PENDING' })).toMatchObject({ state: 'AWAITING_WALLET_CONNECTION', nextStep: 'OPEN_SIGNING_LINK' });
    expect(approvalState({ status: 'CLAIMED' }).state).toBe('AWAITING_SIGNATURE');
    expect(approvalState({ status: 'EXPIRED' })).toMatchObject({ state: 'EXPIRED', final: true });
    expect(approvalState({ status: 'STALE' })).toMatchObject({ state: 'EXPIRED', reason: 'NO_LONGER_REPRODUCIBLE' });
    expect(approvalState({ status: 'REVOKED' })).toMatchObject({ state: 'CANCELLED', reason: 'WITHDRAWN' });
    expect(approvalState({ status: 'SUPERSEDED' })).toMatchObject({ state: 'CANCELLED', reason: 'SUPERSEDED' });
    expect(approvalState({ status: 'SOMETHING_NEW' }).state).toBe('STATUS_UNKNOWN');
  });

  it('an applied approval never claims progress it cannot read', () => {
    expect(approvalState({ status: 'APPLIED', runsVisible: false })).toMatchObject({ state: 'STATUS_UNKNOWN', reason: 'NOT_SHARED' });
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runsComplete: false, runs: [] })).toMatchObject({ state: 'STATUS_UNKNOWN', reason: 'RUNS_READ_FAILED' });
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [] }).state).toBe('AWAITING_SIGNATURE');
    const confirmed = approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'RECONCILED', reconciled: true, evidenceOutcome: 'RECONCILED' }] });
    expect(confirmed).toMatchObject({ state: 'CONFIRMED', completed: true });
    // The latest run decides; a run whose evidence did not pass the strict check is still pending.
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [
      { status: 'RECONCILED', reconciled: false, evidenceOutcome: null, updatedAt: '2026-11-24T10:00:00Z' },
    ] }).state).toBe('PENDING_CONFIRMATION');
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [
      { status: 'REVERTED', reconciled: false, updatedAt: '2026-11-24T09:00:00Z' }, { status: 'POSTED', reconciled: false, updatedAt: '2026-11-24T10:00:00Z' },
    ] }).state).toBe('SUBMITTED');
  });

  it('multi-step runs: partial execution is never reported as complete or as not run', () => {
    expect(workflowRunState({ state: 'COMPLETED', nextAction: 'NONE', halted: null, resumable: false }).state).toBe('CONFIRMED');
    expect(workflowRunState({ state: 'HALTED', nextAction: 'OWNER_DECIDES', halted: 'PARTIAL', resumable: true }))
      .toMatchObject({ state: 'PARTIALLY_EXECUTED', reason: 'RESUMABLE', final: false, completed: false });
    expect(workflowRunState({ state: 'HALTED', nextAction: 'OWNER_DECIDES', halted: 'STOPPED', resumable: false }).state).toBe('NEEDS_ATTENTION');
    expect(workflowRunState({ state: 'FAILED', nextAction: 'NONE', halted: null, resumable: false, steps: [{ state: 'RECONCILED' }, { state: 'FAILED' }] }))
      .toMatchObject({ state: 'PARTIALLY_EXECUTED', final: true });
    expect(workflowRunState({ state: 'RUNNING', nextAction: 'OWNER_SIGNS_STEP', halted: null, resumable: false, steps: [{ state: 'RECONCILED' }, { state: 'AWAITING_OWNER' }] }))
      .toMatchObject({ state: 'AWAITING_SIGNATURE', reason: 'NEXT_STEP' });
    expect(workflowRunState({ state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION', halted: null, resumable: false }).state).toBe('PENDING_CONFIRMATION');
    // A claimed multi-step proposal whose run was not read here may have signed steps: unknown, never "awaiting".
    expect(approvalState({ status: 'APPLIED', executionPlan: 'SEQUENTIAL', workflowRun: null })).toMatchObject({ state: 'STATUS_UNKNOWN', reason: 'READ_GET_APPROVAL_STATUS' });
  });

  it('a multi-step run decides whatever the handoff reads (its run starts at the claim and can sign while CLAIMED, then EXPIRED or REVOKED)', () => {
    const running = { state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP', halted: null, resumable: false, steps: [{ state: 'RECONCILED' }, { state: 'AWAITING_OWNER' }] };
    for (const status of ['CLAIMED', 'EXPIRED', 'REVOKED', 'SUPERSEDED', 'STALE'])
      expect(approvalState({ status, executionPlan: 'SEQUENTIAL', claimed: true, workflowRun: running }), status).toMatchObject({ state: 'AWAITING_SIGNATURE', reason: 'NEXT_STEP' });
    expect(approvalState({ status: 'EXPIRED', executionPlan: 'SEQUENTIAL', claimed: true, workflowRun: { ...running, state: 'COMPLETED', nextAction: 'NONE' } }).state).toBe('CONFIRMED');
    expect(approvalState({ status: 'REVOKED', executionPlan: 'SEQUENTIAL', claimed: true, workflowRun: { ...running, state: 'HALTED', halted: 'PARTIAL', resumable: false } }))
      .toMatchObject({ state: 'PARTIALLY_EXECUTED', final: true });
    // Claimed, run not read: unknown — never EXPIRED / CANCELLED / awaiting.
    for (const status of ['CLAIMED', 'EXPIRED', 'REVOKED']) expect(approvalState({ status, executionPlan: 'SEQUENTIAL', claimed: true }).state, status).toBe('STATUS_UNKNOWN');
    // Never claimed: nothing could have been signed.
    expect(approvalState({ status: 'EXPIRED', executionPlan: 'SEQUENTIAL', claimed: false }).state).toBe('EXPIRED');
    expect(approvalState({ status: 'PENDING', executionPlan: 'SEQUENTIAL', claimed: false }).state).toBe('AWAITING_WALLET_CONNECTION');
    // Only recent runs examined and none found: unknown, never "in the signing page".
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [], runsTruncated: true })).toMatchObject({ state: 'STATUS_UNKNOWN', reason: 'RUNS_TRUNCATED' });
  });

  it('plain-language refusals never expose the code and exist in EN and PT', () => {
    const codes = ['QUOTE_PROVIDER_TIMEOUT', 'CLOUD_API_PREVIEW_UNAVAILABLE', 'MCP_SIMULATION_RATE_LIMITED', 'MCP_WALLET_LINK_REQUIRED', 'MCP_INSUFFICIENT_SCOPE',
      'BETA_ACCESS_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_REVOKED', 'RUN_NOT_FOUND', 'TEST_NETWORK_NOT_AVAILABLE', 'STRATEGY_INVALID', 'MCP_INTERNAL_ERROR',
      'MCP_HANDOFF_LIMIT', 'APPROVAL_NOT_CANCELLABLE', 'INSUFFICIENT_BALANCE'];
    for (const code of codes) {
      const plain = userFacingError(code);
      expect(plain.EN.length).toBeGreaterThan(20);
      expect(plain.PT.length).toBeGreaterThan(20);
      expect(plain.EN).not.toContain(code);
      expect(plain.PT).not.toContain(code);
      expect(plain.EN).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
    expect(userFacingError('QUOTE_PROVIDER_TIMEOUT').EN).toContain('answer in time');
    expect(userFacingError('CLOUD_API_PREVIEW_UNAVAILABLE').EN).toBe('The current quote is temporarily unavailable. You can try again without rebuilding your workflow.');
    expect(userFacingError('MCP_HANDOFF_LIMIT').EN).toContain('open approval requests');
    expect(userFacingError('SOMETHING_ELSE').EN).toContain('did not sign or send anything');
    // Narrow families: provider/catalog codes that merely contain TOKEN are not "reconnect"; expiry never claims that nothing was signed.
    expect(userFacingError('BASE_TOKEN_LIST_UNAVAILABLE').EN).not.toMatch(/reconnect/);
    expect(userFacingError('KORA_FEE_TOKEN_UNSUPPORTED').EN).not.toMatch(/reconnect/);
    expect(userFacingError('APPROVAL_EXPIRED').EN).not.toMatch(/nothing was signed/i);
    expect(userFacingError('PORTFOLIO_NOT_AVAILABLE').EN).toMatch(/balances, positions or history/);
    expect(userFacingError('MCP_CLOUD_RUNTIME_REQUIRED').EN).not.toMatch(/missing or invalid/);
  });

  it('final and completed are consistent for every state', () => {
    for (const state of CONVERSATION_STATES) {
      const s = conversationState(state);
      expect(s.completed).toBe(state === 'CONFIRMED');
      if (s.completed) expect(s.final).toBe(true);
    }
  });
});
