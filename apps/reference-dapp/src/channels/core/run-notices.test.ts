// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution (channels review): what a chat hears about a multi-step run, from the run's durable view only. A partial completion never
 * claims nothing later was submitted (a later step may have been sent and failed on chain) and a stop the server did not classify is worded
 * neutrally; a run that halts again after a resume is announced again (the outbox sends each key once); a batch the owner's wallet answered but
 * whose transactions no browser reported yet is announced once with the continuation link, never as "sent"; a run ended while a batch was in
 * the owner's wallet without an answer never reads "not run".
 */
import { describe, expect, it } from 'vitest';
import type { HandoffRecord } from '../../platform/index.ts';
import { plannedNotifications, statusReplies } from './status.ts';

const handoff = { handoffId: 'apr_' + 'd'.repeat(26), shareStatus: true } as HandoffRecord;
const ORIGIN = 'https://flofi.test', CONTINUE = `${ORIGIN}/approve#${handoff.handoffId}`;
/** The durable outbox's key rule (`channel_outbox.dedupe_key`): a key it rejects rolls back the whole notification batch. */
const OUTBOX_KEY = /^[a-z][a-z0-9_.:-]{2,159}$/;
type Run = Record<string, unknown> & { readonly steps: readonly Record<string, unknown>[] };
const step = (index: number, state: string, code: string | null = null) => ({ index, action: 'swap', state, flow: null, stepWorkflowHash: null, code, bound: null, outcome: null });
const group = (index: number, steps: readonly [number, number], state: string, code: string | null = null) => ({ index, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH',
  signing: 'WHEN_DUE', steps, state, awaitsDelivery: null, code, validUntil: null, feePayer: 'OWNER_WALLET', maxFee: null, gasPaid: null, submissions: [], batchId: null,
  signed: state !== 'PLANNED' && state !== 'PREPARED', planned: null });
const runOf = (patch: Partial<Run>): Run => ({ workflowRunId: 'wfr_' + 'd'.repeat(26), approvalId: handoff.handoffId, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 3,
  currentStep: 0, code: null, workflowHash: '0x' + '1'.repeat(64), expiresAt: '2026-11-09T12:00:00.000Z', completedAt: null, createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z', stepsVisible: true, nextAction: 'NONE', authority: 'NONE', note: null, halted: null, resumable: false,
  steps: [step(0, 'DELEGATED'), step(1, 'DELEGATED'), step(2, 'DELEGATED')], groups: [], ...patch });
const progressOf = (run: Run) => ({ status: 'APPLIED', expiresAt: '2026-11-09T10:15:00.000Z', runs: [], runsVisible: true, workflowRun: run, note: null }) as never;
const notices = (run: Run, language: 'EN' | 'PT' = 'EN') => plannedNotifications(language, handoff, progressOf(run), ORIGIN).due;
/** STATUS's run report (below the approval's own line). */
const status = (run: Run, language: 'EN' | 'PT' = 'EN') => statusReplies(language, { handoff, progress: progressOf(run) })[0]!.text.replace(/^[\s\S]*?(?=^(?:Workflow|Fluxo): )/m, '');
const haltNotice = (run: Run, language: 'EN' | 'PT' = 'EN') => notices(run, language).find(n => n.key.includes(':wfr:halted:'))!;

describe('channel run notices (P0 universal execution)', () => {
  it('a partial completion says the reconciled steps stay done and points to the step that stopped — never "nothing later was submitted" (EN/PT)', () => {
    // Step 2's group was sent and failed on chain after step 1 reconciled: something later WAS submitted.
    const partial = runOf({ state: 'HALTED', halted: 'PARTIAL', currentStep: 1, code: 'USER_FUNDED_BATCH_REVERTED', nextAction: 'OWNER_DECIDES',
      steps: [step(0, 'RECONCILED'), step(1, 'FAILED', 'USER_FUNDED_BATCH_REVERTED'), step(2, 'FAILED', 'USER_FUNDED_BATCH_REVERTED')] });
    const en = haltNotice(partial).text, pt = haltNotice(partial, 'PT').text;
    expect(en).toBe('Workflow partially completed: the reconciled steps stay done and their funds rest in your wallet. See FloFi for the step that stopped.');
    expect(pt).toBe('Fluxo parcialmente concluído: as etapas reconciliadas ficam feitas e os fundos delas ficam na sua carteira. Veja no FloFi a etapa que parou.');
    for (const text of [en, pt, status(partial), status(partial, 'PT')]) expect(text).not.toMatch(/nothing later|nada posterior|was submitted|foi enviado/i);
    expect(status(partial)).toMatch(/^Workflow: partially completed\n1\. Swap — reconciled ✅\n2\. Swap — failed/);
  });

  it('a HALTED run the server did not classify is worded neutrally — never "partially completed", never "nothing was sent" (EN/PT)', () => {
    for (const halted of [null, undefined, 'SOMETHING_NEW']) {
      const run = runOf({ state: 'HALTED', halted, currentStep: 1, code: 'X_CODE', nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED', 'X_CODE')] });
      for (const language of ['EN', 'PT'] as const) {
        const said = [status(run, language), haltNotice(run, language).text].join('\n');
        expect(said, String(halted)).not.toMatch(/partially|parcialmente|before anything was sent|antes de qualquer envio|before any step completed|antes de concluir/);
      }
      expect(status(run)).toMatch(/^Workflow: stopped\n/);
      expect(status(run, 'PT')).toMatch(/^Fluxo: interrompido\n/);
      expect(haltNotice(run).text).toBe('Workflow stopped. FloFi submits nothing more of it; open FloFi to see what each step did and decide what happens next.');
      expect(haltNotice(run, 'PT').text).toMatch(/^Fluxo interrompido\. O FloFi não envia mais nada dele/);
    }
  });

  it('stopped before anything was sent offers to run each step through its own flow only while the server would accept Resume (EN/PT)', () => {
    const nothing = (resumable: boolean) => runOf({ state: 'HALTED', halted: 'NOTHING_SENT', resumable, code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', nextAction: 'OWNER_DECIDES',
      steps: [step(0, 'BLOCKED', 'USER_FUNDED_SIMULATION_UNAVAILABLE'), step(1, 'BLOCKED', 'USER_FUNDED_SIMULATION_UNAVAILABLE'), step(2, 'DELEGATED')] });
    expect(haltNotice(nothing(true)).text).toBe('Workflow stopped before anything was sent: your funds stay in your wallet. In FloFi you can run each step through its own flow, or end it.');
    expect(haltNotice(nothing(false)).text).toBe('Workflow stopped before anything was sent: your funds stay in your wallet. Open FloFi to decide what happens next.');
    expect(haltNotice(nothing(false), 'PT').text).not.toMatch(/executar cada etapa/);
    expect(haltNotice(nothing(true), 'PT').text).toMatch(/executar cada etapa pelo próprio fluxo/);
  });

  it('halt → resume → halt again is announced again, also at the same step with the same code; a step stopped again with a new code too', () => {
    const sent = new Set<string>();
    /** The outbox: a key already enqueued is never sent again (`notify.ts` → `channel_outbox` UNIQUE dedupe_key). */
    const deliver = (run: Run) => notices(run).filter(n => !sent.has(n.key) && (sent.add(n.key), true));
    const halted = (updatedAt: string, code: string) => runOf({ state: 'HALTED', halted: 'PARTIAL', currentStep: 1, code, updatedAt, nextAction: 'OWNER_DECIDES',
      resumable: true, mode: 'CONFIRM_EACH_STEP', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED', code), step(2, 'PENDING')] });
    const first = deliver(halted('2026-11-09T10:05:00.000Z', 'FLOW_NOT_ENABLED_IN_DEPLOYMENT'));
    expect(first.map(n => n.key)).toEqual([`notify:${handoff.handoffId}:wfr:step:0:reconciled`, `notify:${handoff.handoffId}:wfr:step:1:blocked:flow_not_enabled_in_deployment`,
      `notify:${handoff.handoffId}:wfr:halted:1:partial:flow_not_enabled_in_deployment:${Date.parse('2026-11-09T10:05:00.000Z')}`]);
    // A repeated read of the same halt sends nothing.
    expect(deliver(halted('2026-11-09T10:05:00.000Z', 'FLOW_NOT_ENABLED_IN_DEPLOYMENT'))).toEqual([]);
    // The owner resumes; step 2 is ready again and runs (nothing new to announce while it runs).
    expect(deliver(runOf({ state: 'RUNNING', currentStep: 1, mode: 'CONFIRM_EACH_STEP', nextAction: 'OWNER_SIGNS_STEP', updatedAt: '2026-11-09T10:06:00.000Z',
      steps: [step(0, 'RECONCILED'), step(1, 'READY'), step(2, 'PENDING')] })).map(n => n.key)).toEqual([`notify:${handoff.handoffId}:wfr:ready:1`]);
    // It halts again at the same step for the same reason: a NEW halt, announced once.
    const again = deliver(halted('2026-11-09T10:07:00.000Z', 'FLOW_NOT_ENABLED_IN_DEPLOYMENT'));
    expect(again.map(n => n.text)).toEqual(['Workflow partially completed: the reconciled steps stay done and their funds rest in your wallet. See FloFi for the step that stopped.']);
    expect(deliver(halted('2026-11-09T10:07:00.000Z', 'FLOW_NOT_ENABLED_IN_DEPLOYMENT'))).toEqual([]);
    // Resumed and stopped once more with another reason: the step's new stop and the run's new halt are both announced.
    const third = deliver(halted('2026-11-09T10:09:00.000Z', 'SIMULATION_FAILED'));
    expect(third.map(n => n.key)).toEqual([`notify:${handoff.handoffId}:wfr:step:1:blocked:simulation_failed`,
      `notify:${handoff.handoffId}:wfr:halted:1:partial:simulation_failed:${Date.parse('2026-11-09T10:09:00.000Z')}`]);
    expect(third[0]!.text).toBe('Workflow: partially completed\n2. Swap — stopped before submission');
    for (const key of sent) expect(key).toMatch(OUTBOX_KEY);
  });

  it('a later step that needs attention is announced too (the first one\'s notice never shadows it)', () => {
    const attention = (currentStep: number) => runOf({ state: 'ATTENTION', currentStep, mode: 'CONFIRM_EACH_STEP', nextAction: 'WAITING_FOR_RECONCILIATION',
      steps: [step(0, currentStep === 0 ? 'UNCERTAIN' : 'RECONCILED'), step(1, currentStep === 1 ? 'UNCERTAIN' : 'PENDING'), step(2, 'PENDING')] });
    const first = notices(attention(0)).find(n => n.text.startsWith('A submitted step'))!, later = notices(attention(1)).find(n => n.text.startsWith('A submitted step'))!;
    expect(first.key).not.toBe(later.key);
    expect(later.key).toMatch(OUTBOX_KEY);
  });

  it('a batch the owner\'s wallet answered but no browser reported yet is announced once, with the continuation link, never as sent (EN/PT)', () => {
    const waiting = runOf({ currentStep: 0, nextAction: 'OWNER_CONFIRMS_BATCH', groups: [group(0, [0, 1], 'AUTHORIZED'), group(1, [2, 2], 'PLANNED')] });
    const due = notices(waiting).filter(n => n.key.includes(':batch-answered:'));
    expect(due).toEqual([{ key: `notify:${handoff.handoffId}:wfr:batch-answered:0`, text: 'Your wallet answered the batch request for steps 1–2; FloFi has not recorded its '
      + `transactions yet. If FloFi is not open, open it so your wallet can report them and FloFi can reconcile them: ${CONTINUE}\nDo not send the batch again: it may already have executed.` }]);
    expect(due[0]!.key).toMatch(OUTBOX_KEY);
    const pt = notices(waiting, 'PT').find(n => n.key.includes(':batch-answered:'))!.text;
    expect(pt).toContain('A sua carteira respondeu ao pedido do lote das etapas 1–2');
    expect(pt).toContain(CONTINUE);
    for (const text of [due[0]!.text, pt]) expect(text).not.toMatch(/\bsent\b|\bwas sent\b|foi enviad/);
    // A later single-step group: its own notice, its own step.
    const later = runOf({ currentStep: 2, nextAction: 'OWNER_CONFIRMS_BATCH', steps: [step(0, 'RECONCILED'), step(1, 'RECONCILED'), step(2, 'DELEGATED')],
      groups: [group(0, [0, 1], 'RECONCILED'), group(1, [2, 2], 'AUTHORIZED')] });
    expect(notices(later).find(n => n.key.includes(':batch-answered:'))).toMatchObject({ key: `notify:${handoff.handoffId}:wfr:batch-answered:2`,
      text: expect.stringMatching(/^Your wallet answered the batch request for step 3;/) });
    // Without the owner's consent nothing reaches the chat; without an origin there is no link to send.
    expect(plannedNotifications('EN', { ...handoff, shareStatus: false }, progressOf(waiting), ORIGIN).due).toEqual([]);
    expect(plannedNotifications('EN', handoff, progressOf(waiting)).due.some(n => n.key.includes(':batch-answered:'))).toBe(false);
  });

  it('a run ended while a batch was in the owner\'s wallet without an answer never reads "not run": its outcome is unknown, check the wallet (EN/PT)', () => {
    const ended = runOf({ state: 'CANCELLED', code: 'WORKFLOW_RUN_CANCELLED_BY_OWNER', nextAction: 'NONE',
      steps: [step(0, 'SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN'), step(1, 'SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN'), step(2, 'SKIPPED', 'WORKFLOW_RUN_CANCELLED_BY_OWNER')],
      groups: [group(0, [0, 1], 'SKIPPED', 'WALLET_BATCH_OUTCOME_UNKNOWN'), group(1, [2, 2], 'SKIPPED', 'WORKFLOW_RUN_CANCELLED_BY_OWNER')] });
    expect(status(ended)).toBe('Workflow: ended\n1. Swap — outcome unknown — check your wallet\'s activity\n2. Swap — outcome unknown — check your wallet\'s activity\n3. Swap — not run');
    expect(status(ended, 'PT')).toContain('1. Troca — resultado desconhecido — confira a atividade da sua carteira');
    const { due, done } = plannedNotifications('EN', handoff, progressOf(ended), ORIGIN);
    expect(done).toBe(true);
    expect(due.find(n => n.key.endsWith(':wfr:ended'))!.text).toBe('Workflow ended. A batch was handed to your wallet and its answer never reached FloFi: it may have '
      + 'executed before its on-chain deadline. Check your wallet\'s activity.');
    expect(plannedNotifications('PT', handoff, progressOf(ended), ORIGIN).due.find(n => n.key.endsWith(':wfr:ended'))!.text).toMatch(/pode ter sido executado/);
    // An ordinary end keeps its code.
    const plain = runOf({ ...ended, steps: [step(0, 'SKIPPED', 'WORKFLOW_RUN_CANCELLED_BY_OWNER')], groups: [] });
    expect(plannedNotifications('EN', handoff, progressOf(plain), ORIGIN).due.find(n => n.key.endsWith(':wfr:ended'))!.text)
      .toBe('Workflow ended without completing (WORKFLOW_RUN_CANCELLED_BY_OWNER). See FloFi for details.');
  });
});
