// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001: a bridge whose delivery is verified on the destination while finality is pending (EXEC-02), the
 * settlement sync's stale-answer guard (EXEC-02) and the Assistant's read-only answers to "did it work?" about the current execution (CHAT-01).
 */
import { describe, expect, it } from 'vitest';
import { DESTINATION_OBSERVED_LABEL, DESTINATION_OBSERVED_MESSAGE, projectExecutionLifecycle, type ExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { reviewFixture } from '../test-utils/review-fixture';
import { initialEditor } from './editor';
import { createRouterNode } from './router-authoring';
import { workflowProgressView } from './workflow-progress';
import { EXECUTION_PHASE_LABEL, phaseCompletesStep, phaseLocksResubmission } from './execution-phase';
import { adoptSettlementRead, settlementSyncDue, type SettlementRecord } from './settlement-sync';
import { executionQuestion, executionStatusAnswer, lifecycleRequest, type LifecycleView } from './conversation-lifecycle';
import { translate } from '../i18n/translate';

const hash = `0x${'a'.repeat(64)}`, fill = `0x${'b'.repeat(64)}`;
const workflow = { ...initialEditor().workflow, revision: 1, resourceEdges: [], nodes: [createRouterNode('bridge', { source: 'Base', destination: 'Arbitrum', token: 'USDC',
  amount: '1', recipient: '', slippage: '50', routing: 'AUTO' })] };
const nodeId = workflow.nodes.find(node => node.actionType === 'asset.bridge')!.nodeId;
type Over = { phase?: string; verdict?: string; destination?: unknown; attempts?: unknown[] };
/** The exact router store shape the lifecycle reads (the November 17 Base → Arbitrum run's facts, MOCKED). */
const record = (over: Over = {}) => ({ id: 'xroute-' + 'c'.repeat(32), workflow, provenance: 'PUBLIC_MAINNET', phase: 'DESTINATION_OBSERVED', verdict: 'PENDING',
  destination: { transactionHash: fill, safe: false },
  review: { nodeId, intent: { sourceChain: 'eip155:8453', destinationChain: 'eip155:42161' }, route: { inputToken: { symbol: 'USDC' }, routingProvider: 'across' },
    calls: [{ purpose: 'APPROVAL' }, { purpose: 'BRIDGE_DEPOSIT' }] },
  attempts: [{ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true, receipt: null },
    { step: 'DEPOSIT', state: 'CONFIRMED', transactionHash: hash.replace('a', 'd'), reconciled: true, receipt: null }], ...over });
const lifecycle = (over: Over = {}, kind: 'router' | 'universal' = 'router') => projectExecutionLifecycle(workflow, reviewFixture().context,
  { kind, state: { record: record(over), busy: false, signing: false, recovered: false } } as unknown as ExecutionLifecycleSource);
const view = (live: ExecutionLifecycle): LifecycleView => ({ progress: live, workflowProgress: workflowProgressView({ sequence: null, live }) } as unknown as LifecycleView);

describe('EXEC-02: a delivery observed on the destination while finality is pending', () => {
  it('is "Transfer observed on Arbitrum", still pending, never a completed step and nothing to sign again', () => {
    const live = lifecycle(), destination = live.steps[0]!.operations.at(-1)!;
    expect(destination).toMatchObject({ title: 'Destination settlement', state: 'pending', phase: 'DESTINATION_OBSERVED', hash: fill, wallet: false });
    expect(translate('EN', destination.label, ...destination.labelArgs ?? [])).toBe('Transfer observed on Arbitrum');
    expect(live).toMatchObject({ state: 'active', completed: 0, label: DESTINATION_OBSERVED_LABEL, message: DESTINATION_OBSERVED_MESSAGE });
    expect(phaseCompletesStep('DESTINATION_OBSERVED')).toBe(false); expect(phaseLocksResubmission('DESTINATION_OBSERVED')).toBe(true);
    // The approval and the deposit stay confirmed with their hashes (already confirmed evidence is preserved).
    expect(live.steps[0]!.operations.slice(0, 2).map(op => [op.state, op.hash])).toEqual([['confirmed', hash], ['confirmed', hash.replace('a', 'd')]]);
  });
  it('the whole-workflow progress (Execute, Assistant, Dashboard) says the same', () => {
    const progress = workflowProgressView({ sequence: null, live: lifecycle() })!;
    expect(progress).toMatchObject({ completed: 0, total: 1, finished: false, attention: false });
    expect(progress.steps[0]).toMatchObject({ phase: 'DESTINATION_OBSERVED', text: { key: EXECUTION_PHASE_LABEL.DESTINATION_OBSERVED, args: ['Arbitrum'] } });
  });
  it('keeps "Waiting for delivery" before the fill is observed, and completes only once reconciled', () => {
    const waiting = lifecycle({ phase: 'IN_FLIGHT', destination: null });
    expect(waiting.steps[0]!.operations.at(-1)).toMatchObject({ phase: 'AWAITING_DESTINATION', hash: null });
    expect(waiting.label).toBe('Execution in progress');
    const reconciled = lifecycle({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { transactionHash: fill, safe: true } });
    expect(reconciled).toMatchObject({ state: 'complete', completed: 1, label: 'Execution confirmed' });
    expect(workflowProgressView({ sequence: null, live: reconciled })!.steps[0]!.phase).not.toBe('DESTINATION_OBSERVED');
  });
  it('a divergent or recovery-required run is never worded as observed', () => {
    for (const over of [{ phase: 'RECONCILIATION_REQUIRED', verdict: 'DIVERGENT' }, { phase: 'RECOVERY_REQUIRED' }]) {
      const live = lifecycle(over);
      expect(live.label).not.toBe(DESTINATION_OBSERVED_LABEL);
      expect(live.steps[0]!.operations.at(-1)!.phase).not.toBe('DESTINATION_OBSERVED');
    }
  });
});

describe('EXEC-02: settlement sync re-reads only a settling run and never adopts a stale answer', () => {
  const base: SettlementRecord = { id: 'xroute-1', verdict: 'PENDING', phase: 'IN_FLIGHT', source: { safe: true }, destination: null };
  it('runs only while the deposit is settling', () => {
    for (const phase of ['SOURCE_CONFIRMED', 'IN_FLIGHT', 'DESTINATION_OBSERVED', 'RECOVERY_REQUIRED']) expect(settlementSyncDue({ ...base, phase })).toBe(true);
    for (const phase of ['PREPARED', 'AUTHORIZED', 'SOURCE_SUBMITTED']) expect(settlementSyncDue({ ...base, phase })).toBe(false);
    expect(settlementSyncDue({ ...base, phase: 'RECONCILED', verdict: 'RECONCILED' })).toBe(false);
    expect(settlementSyncDue(null)).toBe(false);
  });
  it('adopts forward progress: observed fill, a final side, reconciliation, refund', () => {
    const observed = { ...base, phase: 'DESTINATION_OBSERVED', destination: { safe: false } };
    expect(adoptSettlementRead(base, observed)).toBe(true);
    expect(adoptSettlementRead(observed, { ...observed, destination: { safe: true } })).toBe(true);
    expect(adoptSettlementRead(observed, { ...observed, phase: 'RECONCILED', verdict: 'RECONCILED', destination: { safe: true } })).toBe(true);
    expect(adoptSettlementRead({ ...base, phase: 'RECOVERY_REQUIRED' }, { ...base, phase: 'REFUNDED', verdict: 'REFUNDED' })).toBe(true);
    expect(adoptSettlementRead(observed, observed)).toBe(true);
  });
  it('always adopts a terminal record, even one whose facts changed (divergent after a reorg, refunded)', () => {
    const observed = { ...base, phase: 'DESTINATION_OBSERVED', destination: { safe: true } };
    expect(adoptSettlementRead(observed, { ...observed, phase: 'RECONCILIATION_REQUIRED', verdict: 'DIVERGENT', destination: { safe: false } })).toBe(true);
    expect(adoptSettlementRead(observed, { ...base, phase: 'REFUNDED', verdict: 'REFUNDED', destination: null })).toBe(true);
  });
  it('adopts a fill verified after the deadline (RECOVERY_REQUIRED → DESTINATION_OBSERVED) and a universal side becoming final', () => {
    expect(adoptSettlementRead({ ...base, phase: 'RECOVERY_REQUIRED' }, { ...base, phase: 'DESTINATION_OBSERVED', destination: { safe: false } })).toBe(true);
    expect(adoptSettlementRead({ ...base, phase: 'DESTINATION_OBSERVED', destination: { safe: false } }, { ...base, phase: 'RECOVERY_REQUIRED' })).toBe(false);
    const universal = { ...base, phase: 'DESTINATION_OBSERVED', source: { final: true }, destination: { final: false } };
    expect(adoptSettlementRead(universal, { ...universal, destination: { final: true } })).toBe(true);
    expect(adoptSettlementRead(universal, { ...universal, source: { final: false } })).toBe(false);
  });
  it('never adopts a read of another owner, even for the same run id', () => {
    expect(adoptSettlementRead({ ...base, owner: '0xAa' }, { ...base, phase: 'DESTINATION_OBSERVED', owner: '0xbb' })).toBe(false);
    expect(adoptSettlementRead({ ...base, owner: '0xAa' }, { ...base, phase: 'DESTINATION_OBSERVED', owner: '0xaa' })).toBe(true);
  });
  it('refuses a late answer that would move the run back, and another run', () => {
    const observed = { ...base, phase: 'DESTINATION_OBSERVED', destination: { safe: false } };
    expect(adoptSettlementRead(observed, base)).toBe(false);
    expect(adoptSettlementRead({ ...observed, destination: { safe: true } }, observed)).toBe(false);
    expect(adoptSettlementRead({ ...observed, phase: 'RECONCILED', verdict: 'RECONCILED' }, observed)).toBe(false);
    expect(adoptSettlementRead(base, { ...observed, id: 'xroute-2' })).toBe(false);
    expect(adoptSettlementRead(null, observed)).toBe(false);
  });
});

describe('CHAT-01: status questions about the current execution', () => {
  it.each([
    ['Deu certo?', 'OUTCOME'], ['Funcionou?', 'OUTCOME'], ['Já terminou?', 'OUTCOME'], ['Qual o status?', 'OUTCOME'], ['A bridge foi concluída?', 'OUTCOME'],
    ['Recebi os tokens?', 'RECEIVED'], ['Preciso assinar novamente?', 'SIGNATURE'],
    ['Did it work?', 'OUTCOME'], ['Was it successful?', 'OUTCOME'], ['Is it complete?', 'OUTCOME'], ['did i receive the tokens', 'RECEIVED'],
    ['Do I need to sign again?', 'SIGNATURE'], ['  deu certo ?? ', 'OUTCOME'],
  ] as const)('“%s” is an execution question (%s)', (text, kind) => { expect(executionQuestion(text)).toBe(kind); });
  it.each(['Continuar', 'swap 10 USDC to WETH on Base', 'bridge 5 USDC from Base to Arbitrum', 'status', 'verificar status', 'what is the proposal?', 'sim'])(
    '“%s” is not one (commands and authoring keep their routes)', text => { expect(executionQuestion(text)).toBeNull(); });
  it('the explicit "status" command still re-reads the record', () => { expect(lifecycleRequest('status')).toBe('STATUS'); expect(lifecycleRequest('Verificar status')).toBe('STATUS'); });

  it('"Deu certo?" after the delivery is observed: the destination fact, finality pending, no new signature — in Portuguese and English', () => {
    const asked = view(lifecycle());
    const pt = executionStatusAnswer(asked, 'OUTCOME', 'PT')!, en = executionStatusAnswer(asked, 'OUTCOME', 'EN')!;
    expect(pt.text).toBe('Transferência observada no destino. Os fundos foram observados na rede de destino. A FloFi continua a verificar a finalização da operação. Não precisa assinar novamente.');
    expect(en.text).toBe(`${DESTINATION_OBSERVED_LABEL}. ${DESTINATION_OBSERVED_MESSAGE}`);
    expect(pt.text).not.toMatch(/proposta pendente/i); expect(en.text).not.toMatch(/completed|concluíd/i);
    expect(pt.notes.at(-1)).toBe('Somente leitura: nada foi proposto, alterado, assinado ou enviado.');
    expect(executionStatusAnswer(asked, 'SIGNATURE', 'PT')!.text).toContain('Não precisa assinar novamente.');
    expect(executionStatusAnswer(asked, 'RECEIVED', 'EN')!.text).toContain('observed on the destination chain');
  });
  it('a reconciled run is "yes"; before the fill is observed "did I receive the tokens?" is not claimed', () => {
    const done = view(lifecycle({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { transactionHash: fill, safe: true } }));
    expect(executionStatusAnswer(done, 'OUTCOME', 'EN')!.text).toBe('Yes. Every action of this execution is confirmed and reconciled on-chain.');
    expect(executionStatusAnswer(done, 'SIGNATURE', 'EN')!.text).toBe('No. Nothing in this execution needs your signature right now.');
    const inFlight = view(lifecycle({ phase: 'IN_FLIGHT', destination: null }));
    const received = executionStatusAnswer(inFlight, 'RECEIVED', 'PT')!.text;
    expect(received).toContain('A entrega ainda não foi observada na rede de destino'); expect(received).toContain('0 de 1 etapas concluídas');
  });
  it('a run whose requests confirmed but whose steps are not reconciled yet is "confirmed, still reconciling", never "yes"', () => {
    const confirmed = lifecycle({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { transactionHash: fill, safe: true } });
    const unreconciled = { ...confirmed, stepEvidence: Object.fromEntries(confirmed.steps.map(step => [step.id, { reconciled: false }])) } as unknown as ExecutionLifecycle;
    expect(executionStatusAnswer({ progress: unreconciled, workflowProgress: null } as unknown as LifecycleView, 'OUTCOME', 'EN')!.text)
      .toBe('Its requests are confirmed on-chain. FloFi is still reconciling the outcome before calling it complete.');
  });
  it('while later steps remain, "do I need to sign again?" says the next step needs its own confirmation', () => {
    const live = lifecycle(), progress = workflowProgressView({ sequence: null, live })!;
    const multi = { progress: live, workflowProgress: { ...progress, total: 2 } } as unknown as LifecycleView;
    const pt = executionStatusAnswer(multi, 'SIGNATURE', 'PT')!.text;
    expect(pt).toMatch(/^Transferência observada no destino\. Não para o que já foi enviado\./); expect(pt).not.toContain('Não precisa assinar novamente');
    const done = view(lifecycle({ phase: 'RECONCILED', verdict: 'RECONCILED', destination: { transactionHash: fill, safe: true } }));
    const step1 = { ...done, workflowProgress: { ...(done as unknown as { workflowProgress: object }).workflowProgress, total: 2, completed: 1, finished: false } } as unknown as LifecycleView;
    expect(executionStatusAnswer(step1, 'SIGNATURE', 'EN')!.text).toMatch(/^Not for what was already sent/);
    expect(executionStatusAnswer(step1, 'OUTCOME', 'EN')!.text).not.toMatch(/^Yes/);
    // "Deu certo?" / "Recebi os tokens?" with later steps left: the transfer and where the workflow stands, never "no signature needed".
    for (const asked of ['OUTCOME', 'RECEIVED'] as const) {
      const text = executionStatusAnswer(multi, asked, 'PT')!.text;
      expect(text).toMatch(/^Transferência observada no destino\. Ainda não terminou: 0 de 2 etapas concluídas/); expect(text).not.toContain('Não precisa assinar');
    }
  });
  it('says the next request is being prepared, or reviewed and waiting for Continue, instead of "no"', () => {
    const approved = view(lifecycle({ phase: 'AUTHORIZED', destination: null, attempts: [{ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true, receipt: null }] }));
    expect(executionStatusAnswer(approved, 'SIGNATURE', 'EN', false, null, true)!.text).toMatch(/^Probably: FloFi is preparing the next request.*If its checks still pass/);
    expect(executionStatusAnswer(approved, 'SIGNATURE', 'PT', false, 'CONFIRM_CONTINUE')!.text).toMatch(/^Só se você continuar/);
  });
  it('a request waiting in the wallet, an unknown outcome and a failed run are each said as such', () => {
    const wallet = view(lifecycle({ phase: 'AUTHORIZED', destination: null, attempts: [{ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true, receipt: null }] }));
    expect(executionStatusAnswer(wallet, 'SIGNATURE', 'EN')!.text).toMatch(/^Not for what was already sent/);
    const unknown = view(lifecycle({ phase: 'SOURCE_SUBMITTED', destination: null, attempts: [{ step: 'DEPOSIT', state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null, reconciled: false, receipt: null }] }));
    expect(executionStatusAnswer(unknown, 'OUTCOME', 'EN')!.text).toMatch(/^FloFi cannot confirm it yet/);
    expect(executionStatusAnswer(unknown, 'SIGNATURE', 'PT')!.text).toMatch(/^Não\. Não assine de novo/);
    const failed = view(lifecycle({ phase: 'SOURCE_SUBMITTED', destination: null, attempts: [{ step: 'DEPOSIT', state: 'REVERTED', transactionHash: hash, reconciled: true, receipt: null }] }));
    expect(executionStatusAnswer(failed, 'OUTCOME', 'EN')!.text).toMatch(/^It did not complete\./);
  });
  it('says the last read failed instead of presenting it as fresh, and answers nothing without an execution', () => {
    expect(executionStatusAnswer(view(lifecycle()), 'OUTCOME', 'EN', true)!.notes[0]).toMatch(/^The last “Check status” did not answer/);
    expect(executionStatusAnswer({ progress: null } as unknown as LifecycleView, 'OUTCOME', 'PT')).toBeNull();
  });
});
