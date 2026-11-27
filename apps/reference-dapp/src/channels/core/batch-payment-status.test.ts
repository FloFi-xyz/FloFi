// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (reviews CH-3, CH-4): what a chat hears about a run holding a Batch Payment. The run executes one leg per
 * recipient, yet the person authored ONE step: STATUS and notifications number the person's steps (never "Step 4 is ready" for a 2-step workflow)
 * and name the batch as the Batch Payment with its recipients and total. A batch the wallet split and that executed in part says so — FloFi never
 * sends it again and the owner checks each transaction — never "no final outcome yet". A run without a Batch Payment is reported as before.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../../engine/strategy-engine';
import type { HandoffRecord } from '../../platform/index.ts';
import { plannedNotifications, statusReplies } from './status.ts';

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20), D = '0x' + 'd4'.repeat(20);
const STRATEGY = { version: 2, steps: [
  { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] },
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '5', recipient: D }] };
const composed = composeWorkflow(STRATEGY);
if (!composed.ok) throw new Error(composed.code);
const handoff = { handoffId: 'apr_' + 'e'.repeat(26), shareStatus: true, strategy: composed.strategy, workflowHash: composed.workflowHash } as unknown as HandoffRecord;
const ORIGIN = 'https://flofi.test', CONTINUE = `${ORIGIN}/approve#${handoff.handoffId}`;
const OUTBOX_KEY = /^[a-z][a-z0-9_.:-]{2,159}$/;
type Run = Record<string, unknown> & { readonly steps: readonly Record<string, unknown>[] };
const leg = (index: number, state: string, code: string | null = null, hash: string | null = null) => ({ index, action: 'transfer', state, flow: null, stepWorkflowHash: null,
  code, bound: null, outcome: hash ? { executionId: 'x', kind: 'GROUP', status: state, evidence: null, submissions: [{ chain: 'eip155:8453', hash, explorerUrl: null }], spent: [],
    received: [], receiptUrl: null } : null });
const group = (index: number, steps: readonly [number, number], state: string, code: string | null = null) => ({ index, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH',
  signing: 'WHEN_DUE', steps, state, awaitsDelivery: null, code, validUntil: null, feePayer: 'OWNER_WALLET', maxFee: null, gasPaid: null, submissions: [], batchId: null,
  signed: state !== 'PLANNED' && state !== 'PREPARED', planned: null });
const runOf = (patch: Partial<Run>): Run => ({ workflowRunId: 'wfr_' + 'e'.repeat(26), approvalId: handoff.handoffId, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 4,
  currentStep: 0, code: null, workflowHash: composed.workflowHash, expiresAt: '2026-11-09T12:00:00.000Z', completedAt: null, createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z', stepsVisible: true, nextAction: 'OWNER_SIGNS_GROUP', authority: 'NONE', note: null, halted: null, resumable: false,
  steps: [leg(0, 'DELEGATED'), leg(1, 'DELEGATED'), leg(2, 'DELEGATED'), leg(3, 'DELEGATED')], groups: [group(0, [0, 2], 'PREPARED'), group(1, [3, 3], 'PLANNED')], ...patch });
const progressOf = (run: Run) => ({ status: 'APPLIED', expiresAt: '2026-11-09T10:15:00.000Z', runs: [], runsVisible: true, workflowRun: run, note: null }) as never;
const notices = (run: Run, language: 'EN' | 'PT' = 'EN', h: HandoffRecord = handoff) => plannedNotifications(language, h, progressOf(run), ORIGIN).due;
const status = (run: Run, language: 'EN' | 'PT' = 'EN', h: HandoffRecord = handoff) => statusReplies(language, { handoff: h, progress: progressOf(run) })[0]!.text
  .replace(/^[\s\S]*?(?=^(?:Workflow|Fluxo): )/m, '');
const HASH = '0x' + '9'.repeat(64);

describe('CH-3: a Batch Payment is one of the person\'s steps in STATUS and notifications', () => {
  it('STATUS lists the person\'s two steps: the Batch Payment with its recipients and total, then the transfer (EN/PT)', () => {
    const en = status(runOf({})), pt = status(runOf({}), 'PT');
    expect(en).toMatch(/^Workflow: running\n1\. Batch Payment of 150 USDC to 3 recipients \(0xa1a1…a1a1, 0xb2b2…b2b2, 0xc3c3…c3c3\) — waiting for your wallet\n2\. Transfer — waiting for your wallet$/);
    expect(pt).toMatch(/^Fluxo: em execução\n1\. Pagamento em lote de 150 USDC para 3 destinatários \(0xa1a1…a1a1, 0xb2b2…b2b2, 0xc3c3…c3c3\) — aguardando a sua carteira\n2\. Transferência — /);
    for (const text of [en, pt]) expect(text).not.toMatch(/^[34]\. /m);
  });

  it('the reconciled batch is announced once as step 1, and the transfer that follows is "Step 2 is ready" — never step 4 (EN/PT)', () => {
    const after = runOf({ currentStep: 3, steps: [leg(0, 'RECONCILED', null, HASH), leg(1, 'RECONCILED', null, HASH), leg(2, 'RECONCILED', null, HASH), leg(3, 'DELEGATED')],
      groups: [group(0, [0, 2], 'RECONCILED'), group(1, [3, 3], 'PLANNED')] });
    for (const language of ['EN', 'PT'] as const) {
      const due = notices(after, language);
      for (const n of due) expect(n.key).toMatch(OUTBOX_KEY);
      const outcomes = due.filter(n => n.key.includes(':wfr:step:'));
      expect(outcomes.map(n => n.key)).toEqual([`notify:${handoff.handoffId}:wfr:step:0:reconciled`]);
      expect(outcomes[0]!.text).toMatch(language === 'EN' ? /\n1\. Batch Payment of 150 USDC to 3 recipients .* — reconciled ✅ · tx 0x9999…9999$/
        : /\n1\. Pagamento em lote de 150 USDC para 3 destinatários .* — reconciliada ✅ · tx 0x9999…9999$/);
      const ready = due.find(n => n.key.includes(':wfr:ready-group:'))!;
      expect(ready.text).toMatch(language === 'EN' ? /^Step 2 is ready for your signature in FloFi: / : /^A etapa 2 está pronta para a sua assinatura no FloFi: /);
      expect(ready.text).toContain(CONTINUE);
      expect(due.map(n => n.text).join('\n')).not.toMatch(/Step 4|etapa 4|^[34]\. /m);
    }
    expect(status(after)).toMatch(/^Workflow: running\n1\. Batch Payment of 150 USDC .* — reconciled ✅ · tx 0x9999…9999\n2\. Transfer — waiting for your wallet$/);
  });

  it('a run whose approval names no Batch Payment, or whose strategy no longer composes to the run\'s hash, is still reported leg by leg', () => {
    const plain = { ...handoff, strategy: undefined } as unknown as HandoffRecord;
    expect(status(runOf({}), 'EN', plain)).toMatch(/^Workflow: running\n1\. Transfer — [^\n]+\n2\. Transfer — [^\n]+\n3\. Transfer — [^\n]+\n4\. Transfer — /);
    expect(status(runOf({ workflowHash: '0x' + '1'.repeat(64) }))).toMatch(/\n4\. Transfer — /);
  });
});

describe('CH-4: a batch that executed in part is never "no final outcome yet"', () => {
  const partial = runOf({ state: 'ATTENTION', code: 'WALLET_BATCH_PARTIALLY_EXECUTED', nextAction: 'WAITING_FOR_RECONCILIATION',
    steps: [leg(0, 'UNCERTAIN', 'WALLET_BATCH_PARTIALLY_EXECUTED', HASH), leg(1, 'UNCERTAIN', 'WALLET_BATCH_PARTIALLY_EXECUTED', HASH),
      leg(2, 'UNCERTAIN', 'WALLET_BATCH_PARTIALLY_EXECUTED', HASH), leg(3, 'DELEGATED')],
    groups: [group(0, [0, 2], 'UNCERTAIN', 'WALLET_BATCH_PARTIALLY_EXECUTED'), group(1, [3, 3], 'PLANNED')] });

  it('the attention notice and STATUS say part of it executed, FloFi never sends it again, and to check each transaction (EN/PT)', () => {
    const en = notices(partial).find(n => n.key.includes(':wfr:attention:'))!, pt = notices(partial, 'PT').find(n => n.key.includes(':wfr:attention:'))!;
    expect(en.key).toBe(`notify:${handoff.handoffId}:wfr:attention:0:partial`);
    expect(en.text).toBe('Part of a batch executed: your wallet sent it as several transactions and only some of them succeeded. FloFi never sends it again. '
      + 'Check each of its transactions in your wallet\'s activity.');
    expect(pt.text).toBe('Parte de um lote foi executada: a sua carteira o enviou como várias transações e só algumas tiveram sucesso. O FloFi nunca o envia de novo. '
      + 'Confira cada uma das transações dele na atividade da sua carteira.');
    for (const text of [en.text, pt.text, status(partial), status(partial, 'PT')]) expect(text).not.toMatch(/no final outcome yet|ainda não tem resultado final/);
    expect(status(partial)).toContain(en.text);
    expect(status(partial, 'PT')).toContain(pt.text);
    // The batch is still one step of the person's workflow.
    expect(status(partial)).toMatch(/\n1\. Batch Payment of 150 USDC [^\n]+ — outcome pending · tx 0x9999…9999\n/);
  });

  it('a run that stops or ends with it says the same, keyed apart from any plain stop', () => {
    const halted = notices({ ...partial, state: 'HALTED', halted: 'STOPPED', nextAction: 'OWNER_DECIDES' }).find(n => n.key.includes(':wfr:halted:'))!;
    expect(halted.key).toMatch(/:partial:/);
    expect(halted.key).toMatch(OUTBOX_KEY);
    expect(halted.text).toMatch(/^Part of a batch executed/);
    expect(halted.text).not.toMatch(/before any step completed/);
    const ended = notices({ ...partial, state: 'CANCELLED', nextAction: 'NONE' }).find(n => n.key.includes(':wfr:ended'))!;
    expect(ended).toMatchObject({ key: `notify:${handoff.handoffId}:wfr:ended:partial`, text: expect.stringMatching(/^Part of a batch executed/) });
  });
});
