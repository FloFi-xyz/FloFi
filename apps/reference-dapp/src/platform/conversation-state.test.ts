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
    // WAITING_FOR_RECONCILIATION is the view's fallback, not proof of a submission: the current group's / step's records decide.
    const waiting = { state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION', halted: null, resumable: false, currentStep: 1 } as const;
    expect(workflowRunState({ ...waiting, steps: [{ index: 0, state: 'RECONCILED' }, { index: 1, state: 'AWAITING_OWNER' }] }))
      .toMatchObject({ state: 'STATUS_UNKNOWN', reason: 'STEP_IN_SIGNING_FLOW' });
    expect(workflowRunState({ ...waiting, steps: [{ index: 0, state: 'RECONCILED' }, { index: 1, state: 'UNCERTAIN' }] }).state).toBe('NEEDS_ATTENTION');
    expect(workflowRunState({ ...waiting, groups: [{ state: 'RECONCILED', steps: [0, 0] }, { state: 'SUBMITTED', steps: [1, 2] }] }).state).toBe('PENDING_CONFIRMATION');
    expect(workflowRunState({ ...waiting, groups: [{ state: 'AUTHORIZED', steps: [0, 2] }] })).toMatchObject({ state: 'SUBMITTED', reason: 'GROUP_AUTHORIZED' });
    expect(workflowRunState(waiting).state).toBe('STATUS_UNKNOWN');
    // A wallet batch already reported by the wallet may have executed: never "sign again".
    expect(workflowRunState({ state: 'RUNNING', nextAction: 'OWNER_CONFIRMS_BATCH', halted: null, resumable: false }))
      .toMatchObject({ state: 'SUBMITTED', reason: 'WALLET_BATCH_REPORT_PENDING', nextStep: 'OPEN_SIGNING_LINK' });
    // A claimed multi-step proposal whose run was not read here may have signed steps: unknown, never "awaiting".
    expect(approvalState({ status: 'APPLIED', executionPlan: 'SEQUENTIAL', workflowRun: null })).toMatchObject({ state: 'STATUS_UNKNOWN', reason: 'WORKFLOW_RUN_NOT_READ' });
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

  it('a wallet batch FloFi never heard back about may have executed: never cancelled, halted-final or "not run"', () => {
    for (const state of ['CANCELLED', 'HALTED', 'EXPIRED', 'FAILED']) {
      const s = workflowRunState({ state, nextAction: 'NONE', halted: state === 'HALTED' ? 'STOPPED' : null, resumable: false,
        groups: [{ state: 'SKIPPED', steps: [0, 1], code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] });
      expect(s, state).toMatchObject({ state: 'NEEDS_ATTENTION', reason: 'BATCH_OUTCOME_UNKNOWN', final: false, completed: false });
    }
    expect(workflowRunState({ state: 'CANCELLED', nextAction: 'NONE', halted: null, resumable: false, steps: [{ state: 'SKIPPED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] }).state)
      .toBe('NEEDS_ATTENTION');
  });

  it('every run of a single-flow approval counts; summaries without attempts never invite a second signature', () => {
    const at = (h: number) => `2026-11-24T${String(h).padStart(2, '0')}:00:00.000Z`;
    // An earlier reconciled run is never hidden by a later declined one.
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'RECONCILED', reconciled: true, evidenceOutcome: 'RECONCILED', updatedAt: at(9) },
      { status: 'REJECTED', reconciled: false, updatedAt: at(10) }] }).state).toBe('CONFIRMED');
    // Not started / awaiting the wallet from a summary: a request may be in flight.
    for (const status of ['SIMULATED', 'AUTHORIZED', 'PREPARED']) expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status, reconciled: false }] }).state, status)
      .toBe('STATUS_UNKNOWN');
    // Declined after an earlier action landed (e.g. an ERC-20 approval): never "cancelled".
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'REJECTED', reconciled: false, landed: 'APPROVAL_CONFIRMED' }] }))
      .toMatchObject({ state: 'NEEDS_ATTENTION', reason: 'EARLIER_ACTION_CONFIRMED' });
    // A failure FloFi still observes is not final.
    const observed = approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'FAILED', reconciled: false, terminal: false, observing: true }] });
    expect(observed.final).toBe(false);
    expect(['STATUS_UNKNOWN', 'NEEDS_ATTENTION']).toContain(observed.state);
    // The generic reader's `terminal` is false for a declined/failed run without an error code: that is NOT "still observed".
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'REJECTED', reconciled: false, terminal: false }] }).state).toBe('CANCELLED');
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'FAILED', reconciled: false, terminal: false }] }).state).toBe('FAILED');
    // A reader's own full-fact lifecycle (Pix) is used as computed.
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'PAYMENT_PENDING', reconciled: false,
      lifecycle: { status: 'SETTLEMENT_PENDING', final: false, completed: false } }] })).toMatchObject({ state: 'PENDING_CONFIRMATION', reason: 'DESTINATION_SETTLEMENT_PENDING' });
    // Reconciled with an attention item whose strict check cannot pass: attention, never "pending" forever.
    expect(approvalState({ status: 'APPLIED', runsVisible: true, runs: [{ status: 'RECONCILED', reconciled: false, errorCode: 'X_MISMATCH_NOTE', evidenceOutcome: 'RECONCILED' }] }).state)
      .not.toBe('CONFIRMED');
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

  it('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review MCP-5): each Batch Payment refusal is said as it is, in EN and PT, never as a rate limit or a fallback', () => {
    const fallback = userFacingError('SOMETHING_ELSE'), rateLimit = userFacingError('MCP_SIMULATION_RATE_LIMITED');
    const expected: Readonly<Record<string, readonly [RegExp, RegExp]>> = {
      BATCH_PAYMENT_TOO_MANY_RECIPIENTS: [/at most 8 recipients.*No recipient was dropped/, /no máximo 8 destinatários.*Nenhum destinatário foi descartado/],
      BATCH_PAYMENT_TOO_FEW_RECIPIENTS: [/at least 2 recipients\. To pay one recipient, use a transfer/, /pelo menos 2 destinatários.*use uma transferência/],
      BATCH_PAYMENT_ASSET_MIXED: [/^One Batch Payment pays one asset on one network\. Nothing was signed or sent\.$/, /um único ativo em uma única rede\. Nada foi assinado nem enviado/],
      BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE: [/cannot prove from the chain that the earlier request .*never executed \(for example, an ETH batch\), so it will not ask your wallet again\. Check your wallet.s activity first, then end the run and start a new Review/,
        /não consegue provar pela rede .*\(por exemplo, um lote em ETH\).*não vai pedir de novo à sua carteira.*encerre a execução e comece uma nova Revisão/],
      WALLET_BATCH_PARTIALLY_EXECUTED: [/only some of them succeeded, so part of it executed/, /só algumas deram certo/],
    };
    for (const [code, [en, pt]] of Object.entries(expected)) {
      const plain = userFacingError(code);
      expect(plain.EN, code).toMatch(en);
      expect(plain.PT, code).toMatch(pt);
      expect([plain.EN, plain.PT], code).not.toContain(fallback.EN);
      expect(plain.EN, code).not.toBe(rateLimit.EN);
      expect(plain.EN, code).not.toMatch(/too many requests/i);
      expect(`${plain.EN}\n${plain.PT}`, code).not.toContain(code);
    }
  });

  it('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review M6): an invalid recipient or amount says what each payment needs; every batch refusal has its own text', () => {
    const generic = userFacingError('STRATEGY_SCHEMA_INVALID'), fallback = userFacingError('SOMETHING_ELSE'), rateLimit = userFacingError('MCP_SIMULATION_RATE_LIMITED');
    const recipient = userFacingError('BATCH_PAYMENT_RECIPIENT_INVALID'), amount = userFacingError('BATCH_PAYMENT_AMOUNT_INVALID');
    expect(recipient.EN).toMatch(/valid 0x wallet address: a mixed-case address must match its checksum, and a reserved system address \(0x…000 to 0x…fff\) is never a recipient\..*Nothing was signed or sent/);
    expect(recipient.PT).toMatch(/endereço de carteira 0x válido: um endereço com maiúsculas e minúsculas precisa corresponder ao seu checksum, e um endereço reservado do sistema \(0x…000 a 0x…fff\) nunca é destinatário\..*Nada foi assinado nem enviado/);
    expect(amount.EN).toMatch(/^Every recipient of a Batch Payment needs a positive amount\. Nothing was signed or sent\./);
    expect(amount.PT).toMatch(/^Cada destinatário de um Pagamento em lote precisa de um valor positivo\. Nada foi assinado nem enviado\./);
    const codes = ['BATCH_PAYMENT_RECIPIENT_INVALID', 'BATCH_PAYMENT_AMOUNT_INVALID', 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE', 'BATCH_PAYMENT_TOO_MANY_RECIPIENTS',
      'BATCH_PAYMENT_TOO_FEW_RECIPIENTS', 'BATCH_PAYMENT_ASSET_MIXED'];
    for (const language of ['EN', 'PT'] as const) {
      const texts = codes.map(code => userFacingError(code)[language]);
      // Each code its own family: no two share a text, and none is the generic invalid-details, rate-limit or fallback text.
      expect(new Set(texts).size, language).toBe(codes.length);
      for (const [i, text] of texts.entries()) {
        expect([generic[language], fallback[language], rateLimit[language]], `${language} ${codes[i]}`).not.toContain(text);
        expect(text, `${language} ${codes[i]}`).not.toContain(codes[i]);
      }
    }
  });

  it('final and completed are consistent for every state', () => {
    for (const state of CONVERSATION_STATES) {
      const s = conversationState(state);
      expect(s.completed).toBe(state === 'CONFIRMED');
      if (s.completed) expect(s.final).toBe(true);
    }
  });
});
