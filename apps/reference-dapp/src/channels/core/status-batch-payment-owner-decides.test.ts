// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review SEC-3): a Batch Payment request handed to the owner's wallet, never answered, past its deadline,
 * that the chain can never prove unsent is never handed out again; the server says the owner decides (`nextAction` OWNER_DECIDES on a RUNNING or
 * ATTENTION run). A chat never reports its legs as "waiting for your wallet": they may have executed, and the owner checks the wallet's activity,
 * ends the run and starts a new Review (EN/PT). Every other run is reported as before.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../../engine/strategy-engine';
import type { HandoffRecord } from '../../platform/index.ts';
import { plannedNotifications, statusReplies } from './status.ts';

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20), D = '0x' + 'd4'.repeat(20);
const STRATEGY = { version: 2, steps: [
  { action: 'batch_payment', network: 'base', asset: 'ETH', recipients: [{ recipient: A, amount: '0.001' }, { recipient: B, amount: '0.002' }, { recipient: C, amount: '0.003' }] },
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '5', recipient: D }] };
const composed = composeWorkflow(STRATEGY);
if (!composed.ok) throw new Error(composed.code);
const handoff = { handoffId: 'apr_' + 'f'.repeat(26), shareStatus: true, strategy: composed.strategy, workflowHash: composed.workflowHash } as unknown as HandoffRecord;
const ORIGIN = 'https://flofi.test';
type Run = Record<string, unknown> & { readonly steps: readonly Record<string, unknown>[] };
const leg = (index: number, state: string) => ({ index, action: 'transfer', state, flow: null, stepWorkflowHash: null, code: null, bound: null, outcome: null });
const group = (index: number, steps: readonly [number, number], state: string, code: string | null = null, signed = false) => ({ index, chain: 'eip155:8453',
  strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', steps, state, awaitsDelivery: null, code, validUntil: '2026-11-09T10:10:00.000Z', feePayer: 'OWNER_WALLET', maxFee: null,
  gasPaid: null, submissions: [], batchId: null, signed, planned: null });
/** The SEC-3 run: its Batch Payment group PREPARED and never answered (unsigned, no recorded refusal); the server says the owner decides. */
const unprovable = (patch: Partial<Run> = {}): Run => ({ workflowRunId: 'wfr_' + 'f'.repeat(26), approvalId: handoff.handoffId, state: 'RUNNING', mode: 'USER_FUNDED',
  stepCount: 4, currentStep: 0, code: null, workflowHash: composed.workflowHash, expiresAt: '2026-11-09T12:00:00.000Z', completedAt: null,
  createdAt: '2026-11-09T10:00:00.000Z', updatedAt: '2026-11-09T10:00:00.000Z', stepsVisible: true, nextAction: 'OWNER_DECIDES', authority: 'NONE', note: null,
  halted: null, resumable: false, steps: [leg(0, 'DELEGATED'), leg(1, 'DELEGATED'), leg(2, 'DELEGATED'), leg(3, 'DELEGATED')],
  groups: [group(0, [0, 2], 'PREPARED'), group(1, [3, 3], 'PLANNED')], ...patch });
const progressOf = (run: Run) => ({ status: 'APPLIED', expiresAt: '2026-11-09T10:15:00.000Z', runs: [], runsVisible: true, workflowRun: run, note: null }) as never;
const status = (run: Run, language: 'EN' | 'PT' = 'EN', h: HandoffRecord = handoff) => statusReplies(language, { handoff: h, progress: progressOf(run) })[0]!.text
  .replace(/^[\s\S]*?(?=^(?:Workflow|Fluxo): )/m, '');
const WAITING = /waiting for your wallet|aguardando a sua carteira/;
const DECIDES = {
  EN: 'FloFi never recorded your wallet\'s answer to this Batch Payment request, and the chain cannot prove it was never sent, so FloFi never hands it to your '
    + 'wallet again: it may have executed. Check your wallet\'s activity, then end the run in FloFi and start a new Review.',
  PT: 'O FloFi nunca registrou a resposta da sua carteira a este pedido de Pagamento em lote, e a rede não consegue provar que ele nunca foi enviado, então o FloFi '
    + 'nunca o entrega de novo à sua carteira: ele pode ter sido executado. Confira a atividade da sua carteira, depois encerre o fluxo no FloFi e comece uma nova Revisão.',
} as const;

describe('review SEC-3: an unprovable Batch Payment request is the owner\'s decision in a chat, never "waiting for your wallet"', () => {
  it.each(['RUNNING', 'ATTENTION'] as const)('a %s run: the batch may have executed, the next step is not signed, and the owner decides (EN/PT)', state => {
    const run = unprovable({ state });
    const en = status(run), pt = status(run, 'PT');
    expect(en).toMatch(/\n1\. Batch Payment of 0\.006 ETH to 3 recipients \([^)]+\) — outcome unknown — it may have executed; check your wallet's activity\n2\. Transfer — not signed\n/);
    expect(pt).toMatch(/\n1\. Pagamento em lote de 0\.006 ETH para 3 destinatários \([^)]+\) — resultado desconhecido — pode ter sido executada; confira a atividade da sua carteira\n2\. Transferência — não assinada\n/);
    expect(en.endsWith(DECIDES.EN)).toBe(true);
    expect(pt.endsWith(DECIDES.PT)).toBe(true);
    for (const text of [en, pt]) {
      expect(text).not.toMatch(WAITING);
      expect(text).not.toMatch(/ready for your signature|pronta para a sua assinatura/);
    }
    // Nothing is announced as ready to sign, nor as waiting for the wallet.
    for (const language of ['EN', 'PT'] as const)
      for (const n of plannedNotifications(language, handoff, progressOf(run), ORIGIN).due) expect(n.text).not.toMatch(WAITING);
  });

  it('a run the owner can still sign, a recorded wallet refusal, a halted run and a run without a Batch Payment never get the SEC-3 wording', () => {
    const signs = status(unprovable({ nextAction: 'OWNER_SIGNS_GROUP' }));
    expect(signs).toMatch(/\n1\. Batch Payment of 0\.006 ETH [^\n]+ — waiting for your wallet\n2\. Transfer — waiting for your wallet$/);
    const refused = status(unprovable({ groups: [group(0, [0, 2], 'PREPARED', 'WALLET_BATCH_REFUSAL_RECORDED'), group(1, [3, 3], 'PLANNED')] }));
    const halted = status(unprovable({ state: 'HALTED', halted: 'STOPPED' }));
    const plain = status(unprovable(), 'EN', { ...handoff, strategy: undefined } as unknown as HandoffRecord);
    for (const text of [signs, refused, halted, plain]) {
      expect(text).not.toContain(DECIDES.EN);
      expect(text).not.toMatch(/outcome unknown/);
    }
    // Leg by leg (the approval names no Batch Payment): reported exactly as before.
    expect(plain).toMatch(/^Workflow: running\n1\. Transfer — waiting for your wallet\n2\. Transfer — waiting for your wallet\n3\. Transfer — waiting for your wallet\n4\. Transfer — waiting for your wallet$/);
  });
});
