// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution (channels review): what a chat hears about a multi-step run, from the run's durable view only. A partial completion never
 * claims nothing later was submitted (a later step may have been sent and failed on chain) and a stop the server did not classify is worded
 * neutrally; a run that halts again after a resume is announced again (the outbox sends each key once); a batch the owner's wallet answered but
 * whose transactions no browser reported yet is announced once with the continuation link, never as "sent", and only once the batch's validity
 * passed (an ordinary confirmation passes through that state while /approve pings); a run halted or ended while a batch was in the owner's
 * wallet without an answer never reads "not run", "stopped before submission" or "stopped before any step completed": it may have executed.
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
    expect(status(ended)).toBe('Workflow: ended\n1. Swap — outcome unknown — it may have executed; check your wallet\'s activity\n'
      + '2. Swap — outcome unknown — it may have executed; check your wallet\'s activity\n3. Swap — not run');
    expect(status(ended, 'PT')).toContain('1. Troca — resultado desconhecido — pode ter sido executada; confira a atividade da sua carteira');
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

  it('a run halted at its expiry while its batch was in the wallet unanswered says the batch may have executed — never "stopped before…" (EN/PT)', () => {
    const U = 'WALLET_BATCH_OUTCOME_UNKNOWN', entered = '2026-11-09T12:00:05.000Z';
    // How the server classifies it (STOPPED: a prepared batch is never "nothing sent"), and views that would otherwise read "nothing sent" or nothing.
    for (const halted of ['STOPPED', 'NOTHING_SENT', null] as const) {
      const run = runOf({ state: 'HALTED', halted, currentStep: 0, code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', updatedAt: entered,
        steps: [step(0, 'BLOCKED', U), step(1, 'BLOCKED', U), step(2, 'DELEGATED')], groups: [group(0, [0, 1], 'BLOCKED', U), group(1, [2, 2], 'PLANNED')] });
      expect(status(run), String(halted)).toBe('Workflow: stopped\n1. Swap — outcome unknown — it may have executed; check your wallet\'s activity\n'
        + '2. Swap — outcome unknown — it may have executed; check your wallet\'s activity\n3. Swap — not signed');
      expect(status(run, 'PT')).toMatch(/^Fluxo: interrompido\n1\. Troca — resultado desconhecido — pode ter sido executada; confira a atividade da sua carteira\n/);
      const due = notices(run);
      expect(due.find(n => n.key.endsWith(':wfr:step:0:blocked:wallet_batch_outcome_unknown'))!.text)
        .toBe('Workflow: stopped\n1. Swap — outcome unknown — it may have executed; check your wallet\'s activity');
      const halt = haltNotice(run);
      expect(halt.key).toBe(`notify:${handoff.handoffId}:wfr:halted:0:${halted?.toLowerCase() ?? 'none'}:workflow_run_expired:unknown:${Date.parse(entered)}`);
      expect(halt.key).toMatch(OUTBOX_KEY);
      expect(halt.text).toBe('Workflow stopped. A batch was handed to your wallet and its answer never reached FloFi: it may have executed before its on-chain deadline. '
        + 'Check your wallet\'s activity. FloFi submits nothing more of it; open FloFi to decide what happens next.');
      expect(haltNotice(run, 'PT').text).toMatch(/^Fluxo interrompido\. Um lote foi entregue à sua carteira .* pode ter sido executado .* Confira a atividade da sua carteira\./);
      for (const language of ['EN', 'PT'] as const) {
        const said = [status(run, language), ...notices(run, language).map(n => n.text)].join('\n');
        expect(said, `${halted} ${language}`).not.toMatch(/before any step completed|before anything was sent|nothing was sent|stopped before submission|not run|antes de concluir|antes de qualquer envio|parada antes do envio|não executada/);
      }
    }
    // After an earlier step reconciled: partially completed, the batch may have executed — never "their funds rest in your wallet".
    const partial = runOf({ state: 'HALTED', halted: 'PARTIAL', currentStep: 1, code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', updatedAt: entered,
      steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED', U), step(2, 'BLOCKED', U)], groups: [group(0, [0, 0], 'RECONCILED'), group(1, [1, 2], 'BLOCKED', U)] });
    expect(haltNotice(partial).text).toBe('Workflow partially completed: the reconciled steps stay done. A batch was handed to your wallet and its answer never reached '
      + 'FloFi: it may have executed before its on-chain deadline. Check your wallet\'s activity. FloFi submits nothing more of it; open FloFi to decide what happens next.');
    expect(haltNotice(partial, 'PT').text).toMatch(/^Fluxo parcialmente concluído: as etapas reconciliadas ficam feitas\. Um lote foi entregue/);
    for (const language of ['EN', 'PT'] as const) expect(haltNotice(partial, language).text).not.toMatch(/rest in your wallet|ficam na sua carteira/);
    expect(status(partial)).toMatch(/^Workflow: partially completed\n1\. Swap — reconciled ✅\n2\. Swap — outcome unknown — it may have executed/);
    // Any end of such a run (expired, failed, ended by its owner) says the batch may have executed, never only its code.
    for (const state of ['EXPIRED', 'FAILED', 'CANCELLED']) {
      const over = runOf({ state, code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'NONE', steps: [step(0, 'BLOCKED', U), step(1, 'BLOCKED', U), step(2, 'SKIPPED', 'WORKFLOW_RUN_EXPIRED')],
        groups: [group(0, [0, 1], 'BLOCKED', U), group(1, [2, 2], 'SKIPPED', 'WORKFLOW_RUN_EXPIRED')] });
      const { due, done } = plannedNotifications('EN', handoff, progressOf(over), ORIGIN);
      expect(done, state).toBe(true);
      expect(due.find(n => n.key.endsWith(':wfr:ended'))!.text, state).toBe('Workflow ended. A batch was handed to your wallet and its answer never reached FloFi: it may '
        + 'have executed before its on-chain deadline. Check your wallet\'s activity.');
    }
  });

  it('round 5 C5: a grouped step waits for the wallet only while the run can ask for it; in a halted or ended run it reads "not signed" (EN/PT)', () => {
    const steps = [step(0, 'RECONCILED'), step(1, 'DELEGATED'), step(2, 'DELEGATED')];
    const groups = [group(0, [0, 0], 'RECONCILED'), group(1, [1, 1], 'PLANNED'), { ...group(2, [2, 2], 'PLANNED'), strategy: 'EVM_USER_OPERATION', signed: true }];
    for (const state of ['RUNNING', 'ATTENTION']) {
      const run = runOf({ state, currentStep: 1, nextAction: 'OWNER_SIGNS_GROUP', steps, groups });
      expect(status(run), state).toMatch(/\n2\. Swap — waiting for your wallet\n3\. Swap — signed in your wallet$/);
      expect(status(run, 'PT'), state).toMatch(/\n2\. Troca — aguardando a sua carteira\n3\. Troca — assinada na sua carteira$/);
    }
    for (const [state, halted] of [['HALTED', 'PARTIAL'], ['CANCELLED', null], ['EXPIRED', null], ['FAILED', null]] as const) {
      const run = runOf({ state, halted, currentStep: 1, nextAction: state === 'HALTED' ? 'OWNER_DECIDES' : 'NONE', steps, groups });
      const en = status(run), pt = status(run, 'PT');
      expect(en, state).toMatch(/\n2\. Swap — not signed\n3\. Swap — signed in your wallet$/);
      expect(pt, state).toMatch(/\n2\. Troca — não assinada\n3\. Troca — assinada na sua carteira$/);
      expect(en, state).not.toContain('waiting for your wallet');
      expect(pt, state).not.toContain('aguardando a sua carteira');
    }
  });

  it('a batch answered during an ordinary confirmation is not announced; once its validity has passed it is, once, with the continuation link', () => {
    const validUntil = '2026-11-09T10:10:00.000Z';
    const waiting = (until: string | null) => runOf({ currentStep: 0, nextAction: 'OWNER_CONFIRMS_BATCH',
      groups: [{ ...group(0, [0, 1], 'AUTHORIZED'), validUntil: until }, group(1, [2, 2], 'PLANNED')] });
    const answered = (run: Run, at?: string, language: 'EN' | 'PT' = 'EN') => (at ? plannedNotifications(language, handoff, progressOf(run), ORIGIN, new Date(at))
      : plannedNotifications(language, handoff, progressOf(run), ORIGIN)).due.filter(n => n.key.includes(':batch-answered:'));
    // /approve pings while the owner's page waits for the wallet to report the batch final: nothing reaches the chat inside the batch's validity.
    for (const at of ['2026-11-09T10:00:20.000Z', '2026-11-09T10:05:00.000Z', '2026-11-09T10:09:59.999Z']) {
      expect(answered(waiting(validUntil), at), at).toEqual([]);
      expect(answered(waiting(validUntil), at, 'PT'), at).toEqual([]);
    }
    // Once the validity has passed: announced, once (the outbox sends each key once), with the continuation link.
    const sent = new Set<string>(), deliver = (at: string) => answered(waiting(validUntil), at).filter(n => !sent.has(n.key) && (sent.add(n.key), true));
    expect(deliver('2026-11-09T10:10:00.000Z')).toEqual([{ key: `notify:${handoff.handoffId}:wfr:batch-answered:0`, text: 'Your wallet answered the batch request for '
      + `steps 1–2; FloFi has not recorded its transactions yet. If FloFi is not open, open it so your wallet can report them and FloFi can reconcile them: ${CONTINUE}\n`
      + 'Do not send the batch again: it may already have executed.' }]);
    expect(deliver('2026-11-09T10:10:20.000Z')).toEqual([]);
    expect(deliver('2026-11-09T11:00:00.000Z')).toEqual([]);
    expect(answered(waiting(validUntil), '2026-11-09T10:12:00.000Z', 'PT')[0]!.text).toContain(CONTINUE);
    // The check's own clock by default (the notifier passes none): a validity still ahead is silent, one already passed is announced.
    expect(answered(waiting(new Date(Date.now() + 5 * 60_000).toISOString()))).toEqual([]);
    expect(answered(waiting(new Date(Date.now() - 1_000).toISOString()))).toHaveLength(1);
    // A view without a readable validity is announced (never silent about an answered batch).
    for (const until of [null, 'not-a-date']) expect(answered(waiting(until), '2026-11-09T10:00:20.000Z'), String(until)).toHaveLength(1);
  });
});
