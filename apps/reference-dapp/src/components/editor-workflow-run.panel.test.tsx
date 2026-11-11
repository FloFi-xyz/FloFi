// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Editor's whole-workflow panel (EN/PT), rendered from a given hook state: what it says about a halted run, a refusal, an expired quote,
 * and when it offers "End workflow". Rendering calls no server action and no wallet (every one is a double that refuses to be called).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../app/editor-workflow-execution-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeEditorWorkflow: never, editorWorkflowExecutionAvailability: never, reviewEditorWorkflow: never };
});
vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeUserFundedGroup: never, cancelWorkflowRunHandoff: never, prepareUserFundedGroup: never, reportUserFundedBatch: never, resumeWorkflowRunHandoff: never,
    workflowRunStatusHandoff: never };
});
vi.mock('./user-funded-browser', () => ({ sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { EditorWorkflowRunPanel } = await import('./editor-workflow-run');
const { LocaleProvider } = await import('../i18n/locale');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { EditorExecutionReview } from '../editor/workflow-execution';
import type { RunView } from '../workflow-runs/service';
import type { Language } from '../i18n/locale';
const { translate } = await import('../i18n/locale');

const OWNER = '0x' + 'ab'.repeat(20), APPROVAL = 'apr_' + 'c'.repeat(26), PAST = '2020-01-01T00:00:00.000Z', FUTURE = '2999-01-01T00:00:00.000Z';
type Group = RunView['groups'][number];
const group = (index: number, patch: Partial<Group> = {}): Group => ({ index, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: index ? 'WHEN_DUE' : 'UPFRONT',
  steps: [index, index], state: 'PLANNED', awaitsDelivery: null, code: null, validUntil: null, feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: null,
  signed: false, planned: null, ...patch });
const step = (index: number, state: string) => ({ index, action: 'swap', state, flow: null, stepWorkflowHash: null, code: null, bound: null, outcome: null });
const runOf = (patch: Partial<RunView>): RunView => ({ workflowRunId: 'wfr_' + 'c'.repeat(26), approvalId: APPROVAL, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 2,
  currentStep: 0, code: null, workflowHash: '0x' + '1'.repeat(64), expiresAt: FUTURE, completedAt: null, createdAt: PAST, updatedAt: PAST, stepsVisible: true,
  steps: [step(0, 'DELEGATED'), step(1, 'DELEGATED')], nextAction: 'OWNER_SIGNS_GROUP', groups: [group(0), group(1)], halted: null, resumable: false, authority: 'NONE', note: null,
  ...patch });
const review = (patch: Partial<EditorExecutionReview> = {}): EditorExecutionReview => ({ workflowHash: '0x' + '1'.repeat(64), stepCount: 2, owner: OWNER, reviewedAt: PAST,
  validUntil: FUTURE, mode: 'GROUPED', reasons: [], refusal: null,
  groups: [0, 1].map(i => ({ index: i, chain: 'eip155:8453', network: 'Base', strategy: 'EVM_WALLET_BATCH' as const, steps: [i, i] as const, signing: 'UPFRONT' as const,
    interactions: 1, setup: [], downgrades: [], calls: null, approvals: null, fee: null, healthFactorAfter: null })),
  steps: [0, 1].map(i => ({ index: i, action: 'swap', network: 'Base', chain: 'eip155:8453', provider: null, spend: null, basis: 'EXACT' as const, boundTo: null, expected: null,
    minimum: null, recipient: null })),
  counts: { walletPrompts: 2, atLeast: false, signatures: 2, transactions: 2, batchedCalls: 0, networkSwitches: 0, oneTimeSetup: [] }, ...patch });
const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'running', review: null, error: null, run: null, updated: [],
  started: true, grouped: true, unrecorded: false, visible: true, earlier: false, stepByStep: false, unloaded: false, canReview: false, following: false,
  followEarlier: vi.fn(), hide: vi.fn(), resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(),
  end: vi.fn(), dismiss: vi.fn(), ...patch });
const render = (s: EditorWorkflowRunState, language: Language = 'EN') =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPanel state={s}/></LocaleProvider>);
const END = '>End workflow</button>';

describe('Editor panel: "End workflow" follows the server\'s own rule (canEndWorkflow)', () => {
  it('a group whose batch the wallet reported NOT sent (blocked, authorization kept) halts a run that can be ended, and only ended', () => {
    const halted = runOf({ state: 'HALTED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED')],
      groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'BLOCKED', signed: true, code: 'EIP5792_BATCH_NOT_SENT' })] });
    const html = render(state({ run: halted }));
    expect(html).toContain(END);
    expect(html).not.toContain('Resume the workflow');
    expect(render(state({ run: halted }), 'PT')).toContain('>Encerrar fluxo</button>');
  });
  it('never while a batch may be executing: authorized in the wallet, sent, or a prepared request still valid', () => {
    for (const g of [group(0, { state: 'AUTHORIZED', signed: true, batchId: '0x' + '12'.repeat(32) }), group(0, { state: 'SUBMITTED', signed: true }),
      group(0, { state: 'PREPARED', validUntil: FUTURE, batchId: '0x' + '12'.repeat(32) })])
      expect(render(state({ run: runOf({ groups: [g, group(1)] }) })), g.state).not.toContain(END);
    expect(render(state({ run: runOf({ groups: [group(0, { state: 'PREPARED', validUntil: FUTURE }), group(1)] }) }))).toContain('the workflow can be ended after that');
    // Its validity over, the prepared request can no longer execute (its on-chain deadline): the run can be ended.
    expect(render(state({ run: runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST }), group(1)] }) }))).toContain(END);
  });
  it('never for a run with a step whose outcome is pending, nor while the wallet is being asked', () => {
    expect(render(state({ run: runOf({ state: 'ATTENTION', steps: [step(0, 'UNCERTAIN'), step(1, 'DELEGATED')], groups: [group(0, { state: 'UNCERTAIN', signed: true }), group(1)] }) })))
      .not.toContain(END);
    expect(render(state({ run: runOf({}), phase: 'wallet' }))).not.toContain(END);
    expect(render(state({ run: runOf({}) }))).toContain(END);
  });
  it('not from here while a user operation the owner signed has not been relayed (only /approve offers to cancel it)', () => {
    expect(render(state({ run: runOf({ groups: [group(0), group(1, { strategy: 'EVM_USER_OPERATION', state: 'AUTHORIZED', signed: true })] }) }))).not.toContain(END);
  });
});

describe('Editor panel: a halted run is described by what reached the chain', () => {
  // The server would resume it (`resumable`: HALTED inside its window, the stopped group BLOCKED and unsigned).
  const stopped = runOf({ state: 'HALTED', nextAction: 'OWNER_DECIDES', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE', steps: [step(0, 'BLOCKED'), step(1, 'DELEGATED')],
    groups: [group(0, { state: 'BLOCKED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' }), group(1)], resumable: true });
  it('its first group refused for good when due, nothing reconciled: stopped before anything was sent, never "partially completed"', () => {
    const html = render(state({ run: stopped }));
    expect(html).toContain('Stopped before anything was sent: your funds stay in your wallet. You can run each step through its own flow from here, or end the workflow.');
    expect(html).not.toContain('Partially completed');
    expect(html).toContain('Resume the workflow');
    expect(html).toContain(END);
    const pt = render(state({ run: stopped }), 'PT');
    expect(pt).toContain('Parado antes de qualquer envio: seus fundos continuam na sua carteira.');
    expect(pt).not.toContain('Parcialmente');
  });
  it('a reconciled step is a partial completion', () => {
    const partial = runOf({ state: 'HALTED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'BLOCKED')],
      groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'BLOCKED' })] });
    expect(render(state({ run: partial }))).toContain('Partially completed: the reconciled steps stay done');
  });
  it('nothing reconciled but something may have been sent: neither "nothing was sent" nor progress it did not make', () => {
    const maybeSent = [{ ...stopped, steps: [step(0, 'FAILED'), step(1, 'DELEGATED')] },
      ...[{ state: 'BLOCKED', signed: true }, { state: 'FAILED', signed: true }, { batchId: '0x' + '12'.repeat(32) },
        { planned: { steps: [], calls: 1, approvals: 0, healthFactorAfter: null } }].map(patch => ({ ...stopped, groups: [group(0, { state: 'BLOCKED', ...patch }), group(1)] }))];
    for (const run of maybeSent) {
      const html = render(state({ run }));
      expect(html, JSON.stringify(run.groups[0])).toContain('Stopped before any step completed. FloFi submits nothing more of this workflow');
      expect(html).not.toContain('Stopped before anything was sent');
      expect(html).not.toContain('Partially completed');
    }
    expect(render(state({ run: maybeSent[0]! }), 'PT')).toContain('Parado antes de qualquer etapa ser concluída');
  });
});

describe('Editor panel: refusals without a step never show one', () => {
  it('a refusal that arrives as a bare code (a preparation, an authorization) reads in words, never "step SIMULATION_REVERTED"', () => {
    for (const code of ['SIMULATION_REVERTED', 'SWAP_MINIMUM_NOT_MET']) {
      const html = render(state({ run: runOf({}), error: code }));
      expect(html, code).toContain('so your wallet was not asked');
      expect(html, code).not.toContain(code);
      expect(render(state({ run: runOf({}), error: code }), 'PT'), code).toContain('nada foi pedido à sua carteira');
    }
  });
  it('a Review refusal that names its step shows that step; one that does not never invents step 1', () => {
    const named = render(state({ run: null, started: false, review: review({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) }));
    expect(named).toContain('step 2 would fail on chain now');
    const unnamed = render(state({ run: null, started: false, review: review({ refusal: { code: 'SWAP_MINIMUM_NOT_MET', step: null } }) }));
    expect(unnamed).toContain('A swap in this batch would deliver less than its signed minimum now');
    expect(unnamed).not.toContain('step 1');
  });
});

describe('Editor panel: an expired quote says what the owner can still do', () => {
  const expired = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST, batchId: '0x' + '12'.repeat(32) }), group(1)] });
  it('not handed to the wallet from this browser (or the wallet prompt is open): reject it, FloFi prepares a fresh one', () => {
    expect(render(state({ run: expired, review: review() }))).toContain('reject the request in your wallet; FloFi prepares a fresh one');
    expect(render(state({ run: expired, review: review(), unrecorded: true, phase: 'wallet' }))).toContain('reject the request in your wallet');
  });
  it('handed to the wallet and its answer lost: FloFi never asks again, so the owner checks the wallet and may end the workflow', () => {
    const html = render(state({ run: expired, review: review(), unrecorded: true }));
    expect(html).toContain('FloFi does not ask your wallet for it again');
    expect(html).not.toContain('reject the request in your wallet');
    expect(html).toContain(END);
    expect(render(state({ run: expired, review: review(), unrecorded: true }), 'PT')).toContain('a FloFi não pede esse lote de novo à sua carteira');
  });
});

describe('review fix U1: every wallet batch expires on chain', () => {
  const transferOnly = review({ steps: [0, 1].map(i => ({ index: i, action: 'transfer', network: 'Base', chain: 'eip155:8453', provider: null, spend: null,
    basis: 'EXACT' as const, boundTo: null, expected: null, minimum: null, recipient: OWNER })) });
  it('a transfer-only batch is told its on-chain deadline too (a deadline guard carries it), never "does not expire on chain"', () => {
    const html = render(state({ run: null, started: false, review: transferOnly }));
    expect(html).toContain('Confirm the wallet request promptly: about 10 minutes after FloFi prepares it, an on-chain deadline refuses the whole batch');
    expect(html).not.toContain('does not expire on chain');
    expect(html).not.toContain('Each swap');
    expect(render(state({ run: null, started: false, review: transferOnly }), 'PT')).toContain('um prazo on-chain recusa o lote inteiro');
  });
  it('a batched swap adds that its minimum is fixed when FloFi prepares the request', () => {
    expect(render(state({ run: null, started: false, review: review() }))).toContain('Each swap&#x27;s minimum is fixed when FloFi prepares the request.');
  });
});

describe('review fixes U2/U3/U4: refusals of the batch path in plain words (EN/PT)', () => {
  const time = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const prepared = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: FUTURE, batchId: '0x' + '12'.repeat(32) }), group(1)] });
  it('USER_FUNDED_PREPARED_STILL_VALID: the wallet was not asked now; until when the earlier request stays valid, from the run view', () => {
    const html = render(state({ run: prepared, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
    expect(html).toContain(`FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until ${time(FUTURE, 'en-US')}`);
    expect(html).toContain('FloFi never prepares a second request that could run alongside it.');
    expect(html).not.toContain('USER_FUNDED_PREPARED_STILL_VALID');
    expect(html).not.toContain('Nothing was sent');
    expect(render(state({ run: prepared, error: 'USER_FUNDED_PREPARED_STILL_VALID' }), 'PT')).toContain(`continua válido on-chain até ${time(FUTURE, 'pt-BR')}`);
  });
  it('without a valid prepared group in the run view: the same words without a time (never a placeholder or the code)', () => {
    for (const run of [runOf({}), runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST }), group(1)] })]) {
      const html = render(state({ run, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
      expect(html).toContain('stays valid on chain for a few more minutes at most');
      expect(html).not.toMatch(/\{\d\}|USER_FUNDED_PREPARED_STILL_VALID/);
    }
    expect(render(state({ run: runOf({}), error: 'USER_FUNDED_PREPARED_STILL_VALID' }), 'PT')).toContain('por no máximo mais alguns minutos');
  });
  it('WALLET_BATCH_ANSWER_MISMATCH: it may have run twice; never "nothing was sent"', () => {
    const html = render(state({ run: runOf({}), error: 'WALLET_BATCH_ANSWER_MISMATCH' }));
    expect(html).toContain('Your wallet reported a different batch for this step than the one FloFi recorded: it may have run twice.');
    expect(html).not.toMatch(/Nothing was sent|was not asked|WALLET_BATCH_ANSWER_MISMATCH/);
    expect(render(state({ run: runOf({}), error: 'WALLET_BATCH_ANSWER_MISMATCH' }), 'PT')).toContain('pode ter sido executado duas vezes');
  });
  it('WALLET_ATTEMPT_UNRECORDABLE: the wallet was not asked; what the owner can do', () => {
    const html = render(state({ run: runOf({}), error: 'WALLET_ATTEMPT_UNRECORDABLE' }));
    expect(html).toContain('This browser could not keep a record of the request, so FloFi did not ask your wallet');
    expect(html).toContain('Allow site storage or use another browser, then try again.');
    expect(render(state({ run: runOf({}), error: 'WALLET_ATTEMPT_UNRECORDABLE' }), 'PT')).toContain('Permita o armazenamento do site');
  });
});

describe('review fix U6: Resume is offered exactly when the server would accept it (run.resumable)', () => {
  const blocked = runOf({ state: 'HALTED', nextAction: 'OWNER_DECIDES', steps: [step(0, 'BLOCKED'), step(1, 'DELEGATED')],
    groups: [group(0, { state: 'BLOCKED', code: 'USER_FUNDED_SIMULATION_UNAVAILABLE' }), group(1)] });
  it('the server refuses it (e.g. the run\'s window passed): no Resume and no "you can run each step" even for a BLOCKED unsigned group', () => {
    const html = render(state({ run: { ...blocked, resumable: false } }));
    expect(html).not.toContain('Resume the workflow');
    expect(html).not.toContain('You can run each step through its own flow');
    expect(html).toContain(END);
  });
  it('the server accepts it for a group this page would not have guessed (an owner-step group\'s BLOCKED step)', () => {
    const ownerStep = runOf({ state: 'HALTED', nextAction: 'OWNER_DECIDES', steps: [step(0, 'BLOCKED'), step(1, 'PENDING')],
      groups: [group(0, { strategy: 'EVM_OWNER_STEP', state: 'PLANNED' }), group(1)], resumable: true });
    expect(render(state({ run: ownerStep }))).toContain('Resume the workflow');
    expect(render(state({ run: { ...ownerStep, resumable: false } }))).not.toContain('Resume the workflow');
  });
  it('a view without the field falls back to this page\'s own reading', () => {
    const { resumable: _resumable, ...older } = blocked; void _resumable;
    expect(render(state({ run: older as RunView }))).toContain('Resume the workflow');
  });
});

describe('review fix U7: a partial completion and an ended run claim nothing they cannot prove', () => {
  const OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
  it('a partial completion points to the step that stopped, never "nothing later was submitted"', () => {
    const partial = runOf({ state: 'HALTED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), step(1, 'FAILED')],
      groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'FAILED', signed: true })] });
    const html = render(state({ run: partial }));
    expect(html).toContain('Partially completed: the reconciled steps stay done and their funds rest in your wallet. The step that stopped shows what happened to it.');
    expect(html).not.toMatch(/nothing later/i);
    expect(render(state({ run: partial }), 'PT')).toContain('A etapa que parou mostra o que aconteceu com ela.');
  });
  const ended = runOf({ state: 'CANCELLED', code: 'OWNER_CANCELLED', nextAction: 'NONE', steps: [{ ...step(0, 'SKIPPED'), code: OUTCOME_UNKNOWN }, { ...step(1, 'SKIPPED'), code: OUTCOME_UNKNOWN }],
    groups: [group(0, { state: 'SKIPPED', code: OUTCOME_UNKNOWN, steps: [0, 1] })] });
  it('ended while a batch handed to the wallet was never answered: it may have executed; its steps are never "Not run"', () => {
    for (const s of [state({ run: ended }), state({ run: ended, review: review() })]) {
      const html = render(s);
      expect(html).toContain('A batch was handed to your wallet and its answer never reached FloFi: it may have executed before it expired. Check your wallet&#x27;s activity.');
      expect(html).toContain('Outcome unknown: check your wallet');
      expect(html).not.toContain('Not run');
      const pt = render(s, 'PT');
      expect(pt).toContain('ele pode ter sido executado antes de expirar');
      expect(pt).toContain('Resultado desconhecido: verifique sua carteira');
      expect(pt).not.toContain('Não executada');
    }
  });
  it('any other ended run keeps "Not run" and says nothing of a batch', () => {
    const plain = runOf({ state: 'CANCELLED', code: 'OWNER_CANCELLED', nextAction: 'NONE', steps: [{ ...step(0, 'SKIPPED'), code: 'OWNER_CANCELLED' }, step(1, 'SKIPPED')],
      groups: [group(0, { state: 'SKIPPED', code: 'OWNER_CANCELLED', steps: [0, 1] })] });
    const html = render(state({ run: plain }));
    expect(html).toContain('Not run');
    expect(html).not.toContain('A batch was handed to your wallet');
    expect(html).not.toContain('Outcome unknown');
  });
  it('every new message has its own PT translation', () => {
    for (const text of ['Outcome unknown: check your wallet', 'A batch was handed to your wallet and its answer never reached FloFi: it may have executed before it expired. Check your wallet\'s activity.'])
      expect(translate('PT', text), text).not.toBe(text);
  });
});
