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
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined, sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
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
/** A step's or group's state when its batch was handed to the wallet and never answered (as rendered: the apostrophe is escaped). */
const MAY_HAVE_EXECUTED = 'Its batch may have executed before it expired; check your wallet&#x27;s activity';
const PT_MAY_HAVE_EXECUTED = 'O lote pode ter sido executado antes de expirar; verifique a atividade da sua carteira';

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
  // The run's window outlasts a fresh preparation after the prepared request expires (else the request is the last one: round 6 C1).
  const prepared = runOf({ expiresAt: '3000-01-01T00:00:00.000Z', groups: [group(0, { state: 'PREPARED', validUntil: FUTURE, batchId: '0x' + '12'.repeat(32) }), group(1)] });
  it('USER_FUNDED_PREPARED_STILL_VALID: the wallet was not asked now; until when the earlier request stays valid, from the run view', () => {
    const html = render(state({ run: prepared, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
    expect(html).toContain(`FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until ${time(FUTURE, 'en-US')}`);
    expect(html).toContain('FloFi never prepares a second request that could run alongside it.');
    expect(html).not.toContain('USER_FUNDED_PREPARED_STILL_VALID');
    expect(html).not.toContain('Nothing was sent');
    expect(render(state({ run: prepared, error: 'USER_FUNDED_PREPARED_STILL_VALID' }), 'PT')).toContain(`continua válido on-chain até ${time(FUTURE, 'pt-BR')}`);
  });
  it('without a prepared batch group in the run view: words without a time that stay true once it expired (never a placeholder or the code)', () => {
    for (const run of [null, runOf({}), runOf({ groups: [group(0, { state: 'PREPARED', strategy: 'EVM_USER_OPERATION', validUntil: FUTURE }), group(1)] })]) {
      const html = render(state({ run, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
      expect(html).toContain('FloFi already prepared a request for this step that may still be open in your wallet. Confirm it only within 10 minutes of when it '
        + 'was prepared (after that its on-chain deadline refuses it and your wallet would still pay the fee: reject it), or try again once it has expired; FloFi '
        + 'never prepares a second one that could run alongside it.');
      expect(html).not.toContain('Confirm it there');
      expect(html).not.toMatch(/\{\d\}|USER_FUNDED_PREPARED_STILL_VALID|expired at|stays valid|wait until/);
    }
    expect(render(state({ run: runOf({}), error: 'USER_FUNDED_PREPARED_STILL_VALID' }), 'PT'))
      .toContain('A FloFi já preparou um pedido para esta etapa que ainda pode estar aberto na sua carteira.');
  });
  it('round 4 U1: its validity passed while the refusal is on screen: it says it expired and a fresh one can be asked, never "wait until it expires"', () => {
    const expired = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST }), group(1)] });
    const html = render(state({ run: expired, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
    expect(html).toContain(`The request FloFi prepared expired at ${time(PAST, 'en-US')}; you can ask for a fresh one now.`);
    expect(html).not.toMatch(/stays valid on chain|wait until|\{\d\}|USER_FUNDED_PREPARED_STILL_VALID/);
    expect(render(state({ run: expired, error: 'USER_FUNDED_PREPARED_STILL_VALID' }), 'PT'))
      .toContain(`O pedido que a FloFi preparou expirou às ${time(PAST, 'pt-BR')}; agora você pode pedir um novo.`);
    expect(translate('PT', 'The request FloFi prepared expired at {0}; you can ask for a fresh one now.')).not.toBe('The request FloFi prepared expired at {0}; you can ask for a fresh one now.');
  });
  it('round 4 U1: the same prepared batch is dated by the clock: valid until its time before it, expired at that time after it', () => {
    const until = '2030-06-01T12:00:00.000Z', prepared = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: until }), group(1)] });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(until) - 60_000);
      const before = render(state({ run: prepared, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
      expect(before).toContain(`stays valid on chain until ${time(until, 'en-US')}`);
      expect(before).not.toContain('expired at');
      vi.setSystemTime(Date.parse(until) + 1_000);
      const after = render(state({ run: prepared, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
      expect(after).toContain(`The request FloFi prepared expired at ${time(until, 'en-US')}; you can ask for a fresh one now.`);
      expect(after).not.toMatch(/stays valid on chain|wait until/);
    } finally { vi.useRealTimers(); }
  });
  it('round 4 U1: with two prepared batches, the latest validity decides (never "expired" while one of them is still valid)', () => {
    const both = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST }), group(1, { state: 'PREPARED', validUntil: FUTURE })] });
    const html = render(state({ run: both, error: 'USER_FUNDED_PREPARED_STILL_VALID' }));
    expect(html).toContain(`stays valid on chain until ${time(FUTURE, 'en-US')}`);
    expect(html).not.toContain('expired at');
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
      expect(html).toContain('A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet&#x27;s activity.');
      expect(html).toContain(MAY_HAVE_EXECUTED);
      expect(html).not.toContain('Not run');
      const pt = render(s, 'PT');
      expect(pt).toContain('ele pode ter sido executado antes de expirar');
      expect(pt).toContain(PT_MAY_HAVE_EXECUTED);
      expect(pt).not.toContain('Não executada');
    }
  });
  it('any other ended run keeps "Not run" and says nothing of a batch', () => {
    const plain = runOf({ state: 'CANCELLED', code: 'OWNER_CANCELLED', nextAction: 'NONE', steps: [{ ...step(0, 'SKIPPED'), code: 'OWNER_CANCELLED' }, step(1, 'SKIPPED')],
      groups: [group(0, { state: 'SKIPPED', code: 'OWNER_CANCELLED', steps: [0, 1] })] });
    const html = render(state({ run: plain }));
    expect(html).toContain('Not run');
    expect(html).not.toContain('A batch was handed to your wallet');
    expect(html).not.toContain('may have executed');
  });
  it('every new message has its own PT translation', () => {
    for (const text of ['Its batch may have executed before it expired; check your wallet\'s activity',
      'A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet\'s activity.',
      'Stopped. FloFi submits nothing more of this workflow; you decide what happens next.',
      'Partially completed: the reconciled steps stay done. FloFi submits nothing more of this workflow; you decide what happens next.'])
      expect(translate('PT', text), text).not.toBe(text);
  });
});

describe('round 4 U2: a run stopped at its expiry with a batch handed out and never answered (BLOCKED + WALLET_BATCH_OUTCOME_UNKNOWN)', () => {
  const OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
  const unknownStep = (index: number) => ({ ...step(index, 'BLOCKED'), code: OUTCOME_UNKNOWN });
  // What the server sends (`halted` from its records: the handed-out batch is never "nothing sent"), and a view without that field.
  const stopped = runOf({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', steps: [unknownStep(0), unknownStep(1)],
    groups: [group(0, { state: 'BLOCKED', code: OUTCOME_UNKNOWN, steps: [0, 1] })], halted: 'STOPPED' });
  const partial = runOf({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED', currentStep: 1, nextAction: 'OWNER_DECIDES', steps: [step(0, 'RECONCILED'), unknownStep(1)],
    groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'BLOCKED', code: OUTCOME_UNKNOWN })], halted: 'PARTIAL' });
  it('its steps and group may have executed: never "Stopped before submission" or "Not run", with or without the Review in this tab (EN/PT)', () => {
    for (const s of [state({ run: stopped }), state({ run: stopped, review: review() }), state({ run: partial }), state({ run: partial, review: review() })]) {
      const html = render(s);
      expect(html).toContain(MAY_HAVE_EXECUTED);
      expect(html).not.toMatch(/Stopped before submission|Not run/);
      expect(html).toContain('A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet&#x27;s activity.');
      const pt = render(s, 'PT');
      expect(pt).toContain(PT_MAY_HAVE_EXECUTED);
      expect(pt).not.toMatch(/Parada antes do envio|Não executada/);
    }
  });
  it('the halted words never contradict it: not "before any step completed", not "nothing was sent", not that the reconciled funds rest in the wallet', () => {
    const { halted: _halted, ...older } = stopped; void _halted;
    for (const run of [stopped, older as RunView]) {
      const html = render(state({ run }));
      expect(html).toContain('Stopped. FloFi submits nothing more of this workflow; you decide what happens next.');
      expect(html).not.toMatch(/Stopped before any step completed|Stopped before anything was sent|nothing was sent/i);
      expect(render(state({ run }), 'PT')).toContain('Parado. A FloFi não envia mais nada deste fluxo');
    }
    // A view that would read as "nothing sent" (no batch id or plan shown) still fails closed.
    expect(render(state({ run: { ...stopped, halted: 'NOTHING_SENT' } }))).not.toMatch(/Stopped before anything was sent|nothing was sent/i);
    const html = render(state({ run: partial }));
    expect(html).toContain('Partially completed: the reconciled steps stay done. FloFi submits nothing more of this workflow; you decide what happens next.');
    expect(html).not.toContain('their funds rest in your wallet');
    expect(render(state({ run: partial }), 'PT')).toContain('Parcialmente concluído: as etapas reconciliadas ficam feitas. A FloFi não envia mais nada deste fluxo');
  });
  it('a view without the server\'s `resumable` never offers to resume it (a fresh batch could run alongside the one that may have executed)', () => {
    const { resumable: _resumable, ...older } = stopped; void _resumable;
    expect(render(state({ run: older as RunView }))).not.toContain('Resume the workflow');
  });
  it('a request that fails in words FloFi has no entry for never adds "Nothing was sent" next to it', () => {
    const html = render(state({ run: stopped, error: 'SOME_NEW_REFUSAL' }));
    expect(html).toContain('What your wallet already has stands');
    expect(html).not.toContain('Nothing was sent');
  });
  it('a late answer recorded for it keeps that state\'s own words (the code alone never hides a reconciled batch)', () => {
    const answered = runOf({ state: 'COMPLETED', nextAction: 'NONE', steps: [{ ...step(0, 'RECONCILED'), code: OUTCOME_UNKNOWN }, { ...step(1, 'RECONCILED'), code: OUTCOME_UNKNOWN }],
      groups: [group(0, { state: 'RECONCILED', code: OUTCOME_UNKNOWN, signed: true, steps: [0, 1] })] });
    const html = render(state({ run: answered }));
    expect(html).toContain('Reconciled');
    expect(html).not.toContain('may have executed');
  });
  it('any other stop at expiry keeps its own words', () => {
    const plain = runOf({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', steps: [{ ...step(0, 'BLOCKED'), code: 'WORKFLOW_RUN_EXPIRED' }, step(1, 'DELEGATED')],
      groups: [group(0, { state: 'BLOCKED', code: 'WORKFLOW_RUN_EXPIRED' }), group(1)], halted: 'NOTHING_SENT' });
    const html = render(state({ run: plain }));
    expect(html).toContain('Stopped before submission');
    expect(html).toContain('Stopped before anything was sent');
    expect(html).not.toContain('may have executed');
  });
});

const STILL_VALID = 'USER_FUNDED_PREPARED_STILL_VALID', OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
const at = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** The banner of a run whose batch was handed to the wallet and never answered (as rendered). */
const MAY_HAVE_RUN_NOTE = 'A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet&#x27;s activity.';
const checkWallet = (iso: string) => `The request FloFi prepared expired at ${at(iso, 'en-US')}. FloFi will not ask your wallet for a fresh one: check your wallet&#x27;s `
  + 'activity (it may have executed before it expired), then end the workflow.';

describe('round 5 C1: an expired request offers a fresh one only when this page would actually send one', () => {
  const expired = (patch: Partial<RunView> = {}) => runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST, batchId: '0x' + '12'.repeat(32) }), group(1)], ...patch });
  it('handed to the wallet from this browser and its answer lost (FloFi never asks again): expired, check the wallet and end the workflow', () => {
    for (const refusedGroup of [0, null]) {
      const html = render(state({ run: expired(), error: STILL_VALID, unrecorded: true, refusedGroup }));
      expect(html, String(refusedGroup)).toContain(checkWallet(PAST));
      expect(html).not.toMatch(/ask for a fresh one now|stays valid|wait until/);
      expect(html).toContain(END);
      expect(render(state({ run: expired(), error: STILL_VALID, unrecorded: true, refusedGroup }), 'PT')).toContain(`O pedido que a FloFi preparou expirou às `
        + `${at(PAST, 'pt-BR')}. A FloFi não vai pedir um novo à sua carteira: verifique a atividade da sua carteira`);
    }
    // While the wallet prompt is open a rejection answers it (nothing sent) and the group is offered again: a fresh one can be asked.
    expect(render(state({ run: expired(), error: STILL_VALID, unrecorded: true, phase: 'wallet', refusedGroup: 0 })))
      .toContain(`The request FloFi prepared expired at ${at(PAST, 'en-US')}; you can ask for a fresh one now.`);
  });
  it('the run\'s window no longer outlasts a new preparation (10 minutes): never "ask for a fresh one" or "FloFi prepares a fresh one"', () => {
    const now = Date.parse('2030-06-01T12:00:00.000Z'), validUntil = new Date(now - 60_000).toISOString();
    const run = (minutes: number) => runOf({ expiresAt: new Date(now + minutes * 60_000).toISOString(),
      groups: [group(0, { state: 'PREPARED', validUntil, batchId: '0x' + '12'.repeat(32) }), group(1)] });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      for (const minutes of [5, 10]) {
        const html = render(state({ run: run(minutes), review: review(), error: STILL_VALID, refusedGroup: 0 }));
        expect(html, `${minutes} min`).toContain(checkWallet(validUntil));
        expect(html).toContain('FloFi does not ask your wallet for it again');
        expect(html).not.toMatch(/ask for a fresh one now|FloFi prepares a fresh one/);
      }
      const open = render(state({ run: run(11), review: review(), error: STILL_VALID, refusedGroup: 0 }));
      expect(open).toContain(`The request FloFi prepared expired at ${at(validUntil, 'en-US')}; you can ask for a fresh one now.`);
      expect(open).toContain('reject the request in your wallet; FloFi prepares a fresh one');
    } finally { vi.useRealTimers(); }
  });
  it('every new message has its own PT translation', () => {
    for (const text of ['The request FloFi prepared expired at {0}. FloFi will not ask your wallet for a fresh one: check your wallet\'s activity (it may have executed '
      + 'before it expired), then end the workflow.', 'FloFi already prepared a request for this step that may still be open in your wallet. Confirm it only within '
      + '10 minutes of when it was prepared (after that its on-chain deadline refuses it and your wallet would still pay the fee: reject it), or try again once it '
      + 'has expired; FloFi never prepares a second one that could run alongside it.'])
      expect(translate('PT', text, '12:00:00'), text).not.toBe(translate('EN', text, '12:00:00'));
  });
});

describe('round 5 C2: a USER_FUNDED_PREPARED_STILL_VALID refusal whose group moved past PREPARED never says "stays valid … try again"', () => {
  const REFUSAL_WORDS = /already prepared|stays valid|try again|wait until|expired at|USER_FUNDED_PREPARED_STILL_VALID/;
  it('its group answered since (another tab, /approve): the refusal is no longer shown — the group\'s own state says what happened', () => {
    for (const patch of [{ state: 'AUTHORIZED', signed: true, validUntil: FUTURE }, { state: 'SUBMITTED', signed: true, validUntil: FUTURE },
      { state: 'UNCERTAIN', signed: true, validUntil: PAST }, { state: 'RECONCILED', signed: true, validUntil: PAST }, { state: 'FAILED', signed: true, validUntil: PAST },
      { state: 'BLOCKED', signed: true, code: 'EIP5792_BATCH_NOT_SENT', validUntil: FUTURE }]) {
      const html = render(state({ run: runOf({ groups: [group(0, patch), group(1)] }), error: STILL_VALID, refusedGroup: 0 }));
      expect(html, patch.state).not.toMatch(REFUSAL_WORDS);
      expect(render(state({ run: runOf({ groups: [group(0, patch), group(1)] }), error: STILL_VALID, refusedGroup: 0 }), 'PT'), patch.state)
        .not.toMatch(/já preparou|continua válido|tente de novo|expirou às/);
    }
  });
  it('stopped while its batch was unanswered (WALLET_BATCH_OUTCOME_UNKNOWN): the run\'s "may have executed" note instead', () => {
    const stopped = runOf({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', halted: 'STOPPED',
      steps: [{ ...step(0, 'BLOCKED'), code: OUTCOME_UNKNOWN }, { ...step(1, 'BLOCKED'), code: OUTCOME_UNKNOWN }],
      groups: [group(0, { state: 'BLOCKED', code: OUTCOME_UNKNOWN, validUntil: PAST, steps: [0, 1] })] });
    for (const refusedGroup of [0, null]) {
      const html = render(state({ run: stopped, error: STILL_VALID, refusedGroup }));
      expect(html, String(refusedGroup)).toContain(MAY_HAVE_RUN_NOTE);
      if (refusedGroup === 0) expect(html).not.toMatch(REFUSAL_WORDS);
    }
  });
  it('moved past PREPARED otherwise: dated from its own validity with the expired wording; with no time to date it, not shown', () => {
    const blocked = (validUntil: string | null) => runOf({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', halted: 'STOPPED',
      steps: [step(0, 'BLOCKED'), step(1, 'BLOCKED')], groups: [group(0, { state: 'BLOCKED', code: 'WORKFLOW_RUN_EXPIRED', validUntil, steps: [0, 1] })] });
    const html = render(state({ run: blocked(PAST), error: STILL_VALID, refusedGroup: 0 }));
    expect(html).toContain(checkWallet(PAST));
    expect(html).not.toMatch(/stays valid|try again|wait until|ask for a fresh one/);
    for (const validUntil of [FUTURE, null]) expect(render(state({ run: blocked(validUntil), error: STILL_VALID, refusedGroup: 0 })), String(validUntil)).not.toMatch(REFUSAL_WORDS);
  });
  it('the refused group decides, not the latest prepared batch', () => {
    const both = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: PAST }), group(1, { state: 'PREPARED', validUntil: FUTURE })] });
    const first = render(state({ run: both, error: STILL_VALID, refusedGroup: 0 }));
    expect(first).toContain(`The request FloFi prepared expired at ${at(PAST, 'en-US')}; you can ask for a fresh one now.`);
    expect(first).not.toContain('stays valid on chain until');
    expect(render(state({ run: both, error: STILL_VALID, refusedGroup: 1 }))).toContain(`stays valid on chain until ${at(FUTURE, 'en-US')}`);
  });
  it('a run view older than the server\'s preparation (the group still PLANNED there): the undated words, never nothing', () => {
    expect(render(state({ run: runOf({}), error: STILL_VALID, refusedGroup: 0 }))).toContain('FloFi already prepared a request for this step that may still be open');
  });
});

describe('round 5 C4: a step or group carrying WALLET_BATCH_OUTCOME_UNKNOWN words the halted or ended run as "may have executed", whatever its state', () => {
  // A view recorded before the server refused answers after a stop: the code stays on items that show an answered state.
  const answeredSteps = [{ ...step(0, 'FAILED'), code: OUTCOME_UNKNOWN }, { ...step(1, 'FAILED'), code: OUTCOME_UNKNOWN }];
  const answeredGroup = group(0, { state: 'FAILED', code: OUTCOME_UNKNOWN, signed: true, steps: [0, 1] });
  it('halted: never "Stopped before any step completed" or "before anything was sent" next to it (EN/PT)', () => {
    for (const halted of ['STOPPED', 'NOTHING_SENT', null] as const) {
      const run = runOf({ state: 'HALTED', halted, code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES', steps: answeredSteps, groups: [answeredGroup] });
      const html = render(state({ run }));
      expect(html, String(halted)).toContain('Stopped. FloFi submits nothing more of this workflow; you decide what happens next.');
      expect(html).toContain(MAY_HAVE_RUN_NOTE);
      expect(html).not.toMatch(/Stopped before any step completed|Stopped before anything was sent|nothing was sent/i);
      const pt = render(state({ run }), 'PT');
      expect(pt).toContain('Parado. A FloFi não envia mais nada deste fluxo');
      expect(pt).toContain('ele pode ter sido executado antes de expirar');
      expect(pt).not.toMatch(/Parado antes de qualquer/);
    }
    const partial = runOf({ state: 'HALTED', halted: 'PARTIAL', currentStep: 1, code: 'WORKFLOW_RUN_EXPIRED', nextAction: 'OWNER_DECIDES',
      steps: [step(0, 'RECONCILED'), { ...step(1, 'FAILED'), code: OUTCOME_UNKNOWN }], groups: [group(0, { state: 'RECONCILED', signed: true }), group(1, { state: 'FAILED', code: OUTCOME_UNKNOWN, signed: true })] });
    expect(render(state({ run: partial }))).not.toContain('their funds rest in your wallet');
  });
  it('ended: the note says the batch may have executed', () => {
    const ended = runOf({ state: 'CANCELLED', code: 'OWNER_CANCELLED', nextAction: 'NONE', steps: answeredSteps, groups: [answeredGroup] });
    expect(render(state({ run: ended }))).toContain(MAY_HAVE_RUN_NOTE);
  });
});

describe('round 5 C6: copy for the new codes (EN/PT)', () => {
  it('WALLET_BATCH_ANSWERED_AFTER_STOP: it may have executed and FloFi could not record it — never "Nothing was sent"', () => {
    const stopped = runOf({ state: 'HALTED', halted: 'STOPPED', nextAction: 'OWNER_DECIDES', steps: [{ ...step(0, 'BLOCKED'), code: OUTCOME_UNKNOWN }, step(1, 'DELEGATED')],
      groups: [group(0, { state: 'BLOCKED', code: OUTCOME_UNKNOWN }), group(1)] });
    const html = render(state({ run: stopped, error: 'WALLET_BATCH_ANSWERED_AFTER_STOP' }));
    expect(html).toContain('Your wallet reported a batch for a step FloFi had already stopped: it may have executed. Check your wallet&#x27;s activity; FloFi could not record it.');
    expect(html).not.toMatch(/Nothing was sent|WALLET_BATCH_ANSWERED_AFTER_STOP/);
    expect(render(state({ run: stopped, error: 'WALLET_BATCH_ANSWERED_AFTER_STOP' }), 'PT')).toContain('a FloFi não conseguiu registrá-lo');
  });
  it('SOLANA_GROUP_STEP_DEPENDENT: why a Solana step is signed once the output it spends has landed', () => {
    const s = state({ run: null, started: false, review: review({ mode: 'STEP_BY_STEP', reasons: ['SOLANA_GROUP_STEP_DEPENDENT:1'] }) });
    const html = render(s);
    expect(html).toContain('A Solana step that spends what an earlier step of the same batch delivers is signed once that output has landed (one more wallet prompt).');
    expect(html).not.toContain('Not available for this step');
    expect(render(s, 'PT')).toContain('Uma etapa na Solana que gasta o que uma etapa anterior do mesmo lote entrega');
  });
});

/** The state words of the steps list (the group facts use other markup). */
const stepLabels = (html: string) => [...html.matchAll(/class="workflow-run-state">([^<]*)</g)].map(m => m[1]);
const BATCH = '0x' + '12'.repeat(32);

describe('round 6 C1: a still-valid request says "wait, then try again" only when a fresh one will be possible at its expiry', () => {
  const now = Date.parse('2030-06-01T12:00:00.000Z'), validUntil = new Date(now + 2 * 60_000).toISOString();
  /** The run's window ends `minutes` after the prepared request's validity. */
  const run = (minutes: number, patch: Partial<RunView> = {}) => runOf({ expiresAt: new Date(Date.parse(validUntil) + minutes * 60_000).toISOString(),
    groups: [group(0, { state: 'PREPARED', validUntil, batchId: BATCH }), group(1)], ...patch });
  const last = (locale: string) => `FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until ${at(validUntil, locale)}, and your `
    + 'wallet may hold it. If your wallet shows it, confirm it there before then. FloFi will not prepare another request for this step.';
  it('the window ends within a new preparation\'s validity after it: confirm it before then, no new request to come (EN/PT)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      for (const minutes of [1, 5, 10]) {
        const html = render(state({ run: run(minutes), error: STILL_VALID, refusedGroup: 0 }));
        expect(html, `${minutes} min`).toContain(last('en-US'));
        expect(html).not.toMatch(/wait until|try again/);
        const pt = render(state({ run: run(minutes), error: STILL_VALID, refusedGroup: 0 }), 'PT');
        expect(pt).toContain(`continua válido on-chain até ${at(validUntil, 'pt-BR')}`);
        expect(pt).toContain('confirme-o lá antes disso. A FloFi não vai preparar outro pedido para esta etapa.');
        expect(pt).not.toMatch(/aguarde até|tente de novo/);
      }
      // A window that outlasts a fresh preparation after it: wait, then try again (unchanged).
      const open = render(state({ run: run(11), error: STILL_VALID, refusedGroup: 0 }));
      expect(open).toContain(`otherwise wait until ${at(validUntil, 'en-US')}, then try again`);
      expect(open).not.toContain('will not prepare another one');
    } finally { vi.useRealTimers(); }
  });
  it('nor when this page would not ask for one: its request was handed to the wallet and the answer lost, or the run is not running', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      expect(render(state({ run: run(60), error: STILL_VALID, refusedGroup: 0, unrecorded: true }))).toContain(last('en-US'));
      expect(render(state({ run: run(60, { state: 'HALTED', nextAction: 'OWNER_DECIDES' }), error: STILL_VALID, refusedGroup: 0 }))).toContain(last('en-US'));
      // The run view's own prepared batch dates it when no group is named.
      expect(render(state({ run: run(5), error: STILL_VALID }))).toContain(last('en-US'));
    } finally { vi.useRealTimers(); }
  });
  it('the new message has its own PT translation', () => {
    const text = 'FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until {0}, and your wallet may hold it. If your wallet '
      + 'shows it, confirm it there before then. FloFi will not prepare another request for this step.';
    expect(translate('PT', text, '12:00:00')).not.toBe(translate('EN', text, '12:00:00'));
  });
});

describe('round 6 C2: no "Authorize" for a due wallet batch the run\'s window no longer lets FloFi prepare (WORKFLOW_RUN_EXPIRED)', () => {
  const now = Date.parse('2030-06-01T12:00:00.000Z');
  const run = (minutes: number, first: Group = group(0)) => runOf({ expiresAt: new Date(now + minutes * 60_000).toISOString(), groups: [first, group(1)] });
  const WINDOW = 'This workflow&#x27;s time window has ended, or ends too soon for a new wallet request, so FloFi does not prepare another one for it. If a request '
    + 'is still open in your wallet, check your wallet&#x27;s activity; you can end the workflow once no request of it can still execute.';
  const PT_WINDOW = 'A janela de tempo deste fluxo terminou, ou termina cedo demais para um novo pedido à carteira, então a FloFi não prepara outro pedido para ele.';
  it('the window has passed or ends within a new preparation\'s validity (10 minutes): no Authorize; the panel says why (EN/PT)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      for (const minutes of [-1, 1, 5, 10]) {
        const html = render(state({ run: run(minutes) }));
        expect(html, `${minutes} min`).not.toContain('Authorize steps');
        expect(html).toContain(WINDOW);
        expect(html).not.toMatch(/Nothing was sent/i);
        const pt = render(state({ run: run(minutes) }), 'PT');
        expect(pt).not.toContain('Autorizar as etapas');
        expect(pt).toContain(PT_WINDOW);
      }
      const open = render(state({ run: run(11) }));
      expect(open).toContain('Authorize steps 1–1 now');
      expect(open).not.toContain(WINDOW);
    } finally { vi.useRealTimers(); }
  });
  it('a request FloFi already prepared is handed out again while it is valid: Authorize stays until its validity passes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const valid = render(state({ run: run(8, group(0, { state: 'PREPARED', validUntil: new Date(now + 5 * 60_000).toISOString(), batchId: BATCH })) }));
      expect(valid).toContain('Authorize steps 1–1 now');
      expect(valid).not.toContain(WINDOW);
      const expired = render(state({ run: run(8, group(0, { state: 'PREPARED', validUntil: new Date(now - 60_000).toISOString(), batchId: BATCH })) }));
      expect(expired).not.toContain('Authorize steps');
      expect(expired).toContain(WINDOW);
      // An unreadable window fails closed.
      expect(render(state({ run: { ...run(60), expiresAt: 'not a time' } }))).not.toContain('Authorize steps');
    } finally { vi.useRealTimers(); }
  });
  it('WORKFLOW_RUN_EXPIRED reads in words, never "Nothing was sent" (a prepared batch may still be in the wallet), and is not said twice (EN/PT)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      for (const run_ of [run(5, group(0, { state: 'PREPARED', validUntil: new Date(now - 60_000).toISOString(), batchId: BATCH })), run(60), runOf({})]) {
        const html = render(state({ run: run_, error: 'WORKFLOW_RUN_EXPIRED' }));
        expect(html.split(WINDOW).length - 1).toBe(1);
        expect(html).not.toMatch(/Nothing was sent|WORKFLOW_RUN_EXPIRED/);
        expect(render(state({ run: run_, error: 'WORKFLOW_RUN_EXPIRED' }), 'PT')).toContain(PT_WINDOW);
      }
    } finally { vi.useRealTimers(); }
  });
  it('while the wallet prompt is open, an expired request is rejected there even when no fresh one follows (EN/PT)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const validUntil = new Date(now - 60_000).toISOString(), short = run(5, group(0, { state: 'PREPARED', validUntil, batchId: BATCH }));
      const html = render(state({ run: short, review: review(), phase: 'wallet', unrecorded: true }));
      expect(html).toContain(`its quote expired at ${at(validUntil, 'en-US')}: reject the request in your wallet; FloFi does not prepare another one for this workflow`);
      expect(html).not.toMatch(/FloFi prepares a fresh one|does not ask your wallet for it again/);
      expect(render(state({ run: short, review: review(), phase: 'wallet', unrecorded: true }), 'PT'))
        .toContain('recuse a solicitação na sua carteira; a FloFi não prepara outra para este fluxo');
      // Once the wallet was asked and its answer lost (FloFi never asks again), the wallet's activity is checked instead.
      const asked = render(state({ run: short, review: review(), unrecorded: true }));
      expect(asked).toContain('FloFi does not ask your wallet for it again');
      expect(asked).not.toContain('reject the request in your wallet');
      // A window that outlasts a fresh preparation keeps "FloFi prepares a fresh one".
      expect(render(state({ run: run(60, group(0, { state: 'PREPARED', validUntil, batchId: BATCH })), review: review(), phase: 'wallet', unrecorded: true })))
        .toContain('reject the request in your wallet; FloFi prepares a fresh one');
    } finally { vi.useRealTimers(); }
  });
  it('a request declined in the wallet once the window no longer allows a new one never says "authorize again" (EN/PT)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const closed = run(5, group(0, { state: 'PREPARED', validUntil: new Date(now - 60_000).toISOString(), batchId: BATCH }));
      const html = render(state({ run: closed, review: review(), error: 'WALLET_REQUEST_REJECTED' }));
      expect(html).toContain('You declined the request in your wallet. Nothing was sent. FloFi does not prepare another request for this workflow; you can end it.');
      expect(html).not.toMatch(/authorize again/);
      expect(render(state({ run: closed, review: review(), error: 'WALLET_REQUEST_REJECTED' }), 'PT')).toContain('A FloFi não prepara outro pedido para este fluxo; você pode encerrá-lo.');
      // A window that still allows a fresh request keeps "You can authorize again".
      expect(render(state({ run: run(60), review: review(), error: 'WALLET_REQUEST_REJECTED' }))).toContain('You can authorize again');
    } finally { vi.useRealTimers(); }
  });
  it('every new message has its own PT translation', () => {
    for (const text of ['This workflow\'s time window has ended, or ends too soon for a new wallet request, so FloFi does not prepare another one for it. If a request is '
      + 'still open in your wallet, check your wallet\'s activity; you can end the workflow once no request of it can still execute.',
    'its quote expired at {0}: reject the request in your wallet; FloFi does not prepare another one for this workflow'])
      expect(translate('PT', text, '12:00:00'), text).not.toBe(translate('EN', text, '12:00:00'));
  });
});

describe('round 6 C4: a user-funded step is worded by its group — never "authorized" for a group nothing was signed for', () => {
  const signedFirst = (patch: Partial<RunView> = {}) => runOf({ groups: [group(0, { state: 'AUTHORIZED', signed: true, batchId: BATCH }), group(1)], ...patch });
  it('signed: "Signed in your wallet"; unsigned while the run runs: "Waiting for your wallet" — with or without the Review in this tab (EN/PT)', () => {
    for (const runState of ['RUNNING', 'ATTENTION']) for (const review_ of [null, review()]) {
      const s = state({ run: signedFirst({ state: runState }), review: review_ });
      expect(stepLabels(render(s)), runState).toEqual(['Signed in your wallet', 'Waiting for your wallet']);
      expect(stepLabels(render(s, 'PT'))).toEqual(['Assinada na sua carteira', 'Aguardando sua carteira']);
    }
  });
  it('unsigned in a halted or ended run: "Not signed" (EN/PT)', () => {
    for (const runState of ['HALTED', 'CANCELLED', 'EXPIRED', 'FAILED']) {
      const s = state({ run: signedFirst({ state: runState, nextAction: runState === 'HALTED' ? 'OWNER_DECIDES' : 'NONE' }) });
      expect(stepLabels(render(s)), runState).toEqual(['Signed in your wallet', 'Not signed']);
      expect(stepLabels(render(s, 'PT'))).toEqual(['Assinada na sua carteira', 'Não assinada']);
    }
  });
  it('never "Authorized" or "Authorized in the batch"; a batch that may have executed keeps its own words', () => {
    for (const run of [runOf({}), signedFirst(), signedFirst({ state: 'HALTED', nextAction: 'OWNER_DECIDES' })])
      for (const s of [state({ run }), state({ run, review: review() })]) expect(render(s)).not.toMatch(/>Authorized|Authorized in the batch/);
    const unknown = runOf({ state: 'HALTED', nextAction: 'OWNER_DECIDES', steps: [step(0, 'DELEGATED'), { ...step(1, 'DELEGATED'), code: OUTCOME_UNKNOWN }],
      groups: [group(0, { state: 'AUTHORIZED', signed: true, batchId: BATCH }), group(1, { code: OUTCOME_UNKNOWN })] });
    expect(stepLabels(render(state({ run: unknown })))).toEqual(['Signed in your wallet', 'Its batch may have executed before it expired; check your wallet&#x27;s activity']);
  });
  it('the new labels have their own PT translations', () => {
    for (const text of ['Signed in your wallet', 'Not signed', 'Waiting for your wallet']) expect(translate('PT', text), text).not.toBe(text);
  });
});

describe('BUILD-FLOFI-MAINNET-EXEC-002 review round 2: a sponsored batch\'s gas after a reload', () => {
  it('without the Review in this tab, a reconciled sponsored group says FloFi paid its gas; an owner-paid one keeps "network fees paid" (EN/PT)', () => {
    const run = runOf({ state: 'COMPLETED', steps: [step(0, 'RECONCILED'), step(1, 'RECONCILED')], groups: [
      group(0, { state: 'RECONCILED', signed: true, gasPaid: { amount: '2000000000000', unit: 'wei', payer: 'FLOFI_PAYMASTER', sponsored: true } }),
      group(1, { state: 'RECONCILED', signed: true, gasPaid: { amount: '3000000000000', unit: 'wei', payer: OWNER } })] });
    const html = render(state({ run, review: null }));
    expect(html).toContain('Gas paid by FloFi: 0.000002 ETH');
    expect(html).toContain('network fees paid: 0.000003 ETH');
    expect(html).not.toContain('network fees paid: 0.000002 ETH');
    expect(render(state({ run, review: null }), 'PT')).toContain('Gás pago pela FloFi: 0.000002 ETH');
  });
});
