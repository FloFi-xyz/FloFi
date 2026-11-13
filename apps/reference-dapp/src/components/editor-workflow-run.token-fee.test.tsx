// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review UX1–UX4, UX7 (ADR-0010): what the Editor's whole-workflow panel says about a network fee the
 * owner pays in a token, rendered from a given hook state (EN/PT). Rendering calls no server action and no wallet.
 *
 *   UX1  a USDC cap that rose since the Review is shown beside the reviewed one and confirmed; a mechanism change offers "End and review again"
 *        and never "Authorize" again for the group the Review bound
 *   UX2  a Kora fee (Solana) names Pimlico and its own token, never Circle and USDC
 *   UX3  a Circle-paid request's USDC permit is a visible token permission, never "No new token permission"
 *   UX4  the two Circle signatures, one at a time, never the batch calls
 *   UX7  Technical details never say "one wallet confirmation" or "one per group" for a Circle-paid group
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
    workflowRunStatusHandoff: never, permitUserFundedGroup: never };
});
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn(), isCirclePaid: vi.fn(), signCirclePaidGroup: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { EditorWorkflowRunPanel } = await import('./editor-workflow-run');
const { LocaleProvider } = await import('../i18n/locale');
const { CIRCLE_FEE_CAP_ROSE_CONFIRM } = await import('../domain/token-fee');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { EditorExecutionReview } from '../editor/workflow-execution';
import type { RunView } from '../workflow-runs/service';
import type { Language } from '../i18n/locale';
import { swapBridgeReview } from '../domain/review-block-test-harness';

const OWNER = '0x' + 'ab'.repeat(20), USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', PAYMASTER = '0x' + '4'.repeat(40), ENTRY_POINT = '0x' + '5'.repeat(40);
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', FUTURE = '2999-01-01T00:00:00.000Z', PAST = '2020-01-01T00:00:00.000Z';
const gasPayment = { mechanism: 'CIRCLE_USDC_PAYMASTER' as const, maxFee: { token: USDC, symbol: 'USDC', decimals: 6, amount: '210000' }, signatures: 2 as const,
  paymaster: PAYMASTER, entryPoint: ENTRY_POINT, permitCap: '210000' };
/** The board 06 Review, its one group's fee paid from the owner's USDC through Circle (two signatures, no native fee). */
const circleReview = (patch: Partial<EditorExecutionReview> = {}): EditorExecutionReview => {
  const base = swapBridgeReview();
  return { ...base, mode: 'GROUPED', groups: [{ ...base.groups[0]!, fee: null, interactions: 2, gasPayment }],
    counts: { ...base.counts, walletPrompts: 2, signatures: 2 }, ...patch };
};
type Group = RunView['groups'][number];
const group = (index: number, patch: Partial<Group> = {}): Group => ({ index, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [index, index],
  state: 'PLANNED', awaitsDelivery: null, code: null, validUntil: null, feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: null, signed: false,
  planned: null, ...patch });
const runOf = (patch: Partial<RunView>): RunView => ({ workflowRunId: 'wfr_' + 'e'.repeat(26), approvalId: 'apr_' + 'e'.repeat(26), state: 'RUNNING', mode: 'USER_FUNDED',
  stepCount: 2, currentStep: 0, code: null, workflowHash: '0x' + '1'.repeat(64), expiresAt: FUTURE, completedAt: null, createdAt: PAST, updatedAt: PAST, stepsVisible: true,
  steps: [], nextAction: 'OWNER_SIGNS_GROUP', groups: [group(0)], halted: null, resumable: false, authority: 'NONE', note: null, ...patch });
const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'reviewed', review: circleReview(), error: null, run: null,
  updated: [], started: false, grouped: true, unrecorded: false, visible: true, earlier: false, stepByStep: false, unloaded: false, canReview: true, following: false,
  followEarlier: vi.fn(), hide: vi.fn(), resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(),
  end: vi.fn(), dismiss: vi.fn(), endAndReview: vi.fn(), ...patch });
const render = (s: EditorWorkflowRunState, language: Language = 'EN') =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPanel state={s} actionsOutside/></LocaleProvider>);
const visible = (html: string) => html.slice(0, html.indexOf('<details'));
const technicalOf = (html: string) => html.slice(html.indexOf('<details'));

describe('review UX3: a Circle-paid request\'s USDC permit is a visible token permission', () => {
  it('names Circle\'s paymaster, the cap and what stays approved (EN/PT); never "No new token permission"', () => {
    const shown = visible(render(state({})));
    expect(shown).toContain('<dt>Token permission</dt><dd><span class="review-block-permission"><span class="numeric">Uniswap</span> uses up to');
    expect(shown).toContain('Circle&#x27;s paymaster may take up to <span class="numeric">0.21 USDC</span> for the network fee; what is left stays approved until your next USDC permit');
    expect(shown).not.toContain('No new token permission');
    expect(visible(render(state({}), 'PT'))).toContain('O paymaster da Circle pode cobrar até <span class="numeric">0.21 USDC</span> pela taxa de rede');
  });
});

describe('review UX7: Technical details of a Circle-paid group say two signatures and one operation', () => {
  it('never "One wallet confirmation", "calls in the batch" or "one per group" for it (EN/PT)', () => {
    const technical = technicalOf(render(state({})));
    expect(technical).toContain('All 2 steps run as ONE operation on Base from your own account: two signatures in your wallet');
    expect(technical).toContain('Two signatures: a USDC permit for the fee, then the operation · 4 calls in the operation (2 token approvals)');
    expect(technical).toContain('Network fee, at most 0.21 USDC — paid from your USDC through Circle');
    for (const wrong of ['One wallet confirmation: one atomic transaction', 'one per group', 'calls in the batch', 'ONE wallet confirmation'])
      expect(technical, wrong).not.toContain(wrong);
    expect(technicalOf(render(state({}), 'PT'))).toContain('As 2 etapas rodam como UMA operação em Base da sua própria conta');
    // A grouped workflow with a Circle-paid group: wallet requests, never "one per group".
    const grouped = technicalOf(render(state({ review: circleReview({ groups: [circleReview().groups[0]!, { ...swapBridgeReview().groups[0]!, index: 1, steps: [1, 1],
      calls: null, fee: null, signing: 'WHEN_DUE' }], counts: { ...circleReview().counts, walletPrompts: 3 } }) })));
    expect(grouped).toContain('All 2 steps run in 3 wallet requests: a group whose network fee is paid from your USDC through Circle asks for two signatures');
    expect(grouped).not.toContain('one per group');
  });
  it('a native group keeps its own words', () => {
    const technical = technicalOf(render(state({ review: swapBridgeReview() })));
    expect(technical).toContain('One wallet confirmation: one atomic transaction · 4 calls in the batch (2 token approvals)');
    expect(technical).not.toContain('Circle');
  });
});

describe('review UX2: a token fee names who receives it, by network', () => {
  const koraGroup = group(1, { chain: SOLANA, strategy: 'SOLANA_SIGN_ALL', steps: [1, 1], state: 'PREPARED',
    maxFee: { amount: '4200', unit: 'token', estimated: false, token: { symbol: 'USDT', decimals: 6 } } });
  const circleGroup = group(0, { state: 'PREPARED', strategy: 'EVM_USER_OPERATION', maxFee: { amount: '210000', unit: 'token', estimated: false,
    token: { address: USDC, symbol: 'USDC', decimals: 6 } } });
  it('a Kora fee on Solana: "paid from your USDT to Pimlico", never Circle or USDC (run view after a reload, EN/PT)', () => {
    const html = render(state({ review: null, phase: 'running', started: true, canReview: false, run: runOf({ groups: [circleGroup, koraGroup] }) }));
    expect(html).toContain('Network fee, at most 0.0042 USDT · paid from your USDT to Pimlico');
    expect(html).toContain('Network fee, at most 0.21 USDC — paid from your USDC through Circle');
    expect(html.match(/through Circle/g)).toHaveLength(1);
    const pt = render(state({ review: null, phase: 'running', started: true, canReview: false, run: runOf({ groups: [circleGroup, koraGroup] }) }), 'PT');
    expect(pt).toContain('Taxa de rede, no máximo 0.0042 USDT · paga com os seus USDT à Pimlico');
  });
  it('the same with the Review in this tab (a later Solana group prepared when due), and what was paid', () => {
    const review = swapBridgeReview({ mode: 'GROUPED', groups: [swapBridgeReview().groups[0]!, { ...swapBridgeReview().groups[0]!, index: 1, chain: SOLANA, network: 'Solana',
      strategy: 'SOLANA_SIGN_ALL', steps: [1, 1], calls: null, fee: null, signing: 'WHEN_DUE' }] });
    const html = render(state({ review, phase: 'running', started: true, canReview: false, run: runOf({ groups: [group(0, { state: 'RECONCILED', signed: true }), koraGroup] }) }));
    expect(html).toContain('Network fee, at most 0.0042 USDT · paid from your USDT to Pimlico');
    expect(html).not.toContain('through Circle');
    const paid = render(state({ review, phase: 'running', started: true, canReview: false, run: runOf({ groups: [group(0, { state: 'RECONCILED', signed: true }),
      { ...koraGroup, state: 'RECONCILED', signed: true, gasPaid: { amount: '5000', unit: 'lamports', payer: 'kora', paidInToken: { symbol: 'USDT', decimals: 6, amount: '4100' } } }] }) }));
    expect(paid).toContain('Network fees paid: 0.0041 USDT from your wallet to Pimlico');
  });
});

describe('review UX1: the panel asks to confirm a higher cap, and offers a way forward after a mechanism change', () => {
  const run = runOf({ groups: [group(0, { state: 'PREPARED', strategy: 'EVM_USER_OPERATION', validUntil: FUTURE })] });
  it('the cap that rose, beside the reviewed one, with its own confirmation (EN/PT)', () => {
    const updated = [{ index: 0, kind: 'fee' as const, reviewed: '0.21 USDC', now: '0.210413 USDC', code: CIRCLE_FEE_CAP_ROSE_CONFIRM }];
    const html = render(state({ run, started: true, canReview: false, phase: 'confirm-update', updated }));
    expect(html).toContain('Prices moved since your review. Confirm what your wallet will be asked:');
    expect(html).toContain(`data-update-code="${CIRCLE_FEE_CAP_ROSE_CONFIRM}">Network fee, at most 0.210413 USDC — paid from your USDC through Circle (reviewed 0.21 USDC:`);
    expect(html).toContain('>Confirm and continue in my wallet</button>');
    expect(html).not.toContain('these minimums');
    expect(html).not.toContain('ETH arrived');
    expect(render(state({ run, started: true, canReview: false, phase: 'confirm-update', updated }), 'PT'))
      .toContain('Taxa de rede, no máximo 0.210413 USDC — paga com seu USDC pela Circle (revisado: 0.21 USDC;');
    // Never shown before: the cap alone.
    expect(render(state({ run, started: true, canReview: false, phase: 'confirm-update', updated: [{ index: 0, kind: 'fee', reviewed: null, now: '0.21 USDC' }] })))
      .toContain('<li>Network fee, at most 0.21 USDC — paid from your USDC through Circle</li>');
  });
  it('a mechanism change: its words, "End and review again", and no "Authorize" for the group the Review bound (EN/PT)', () => {
    const html = render(state({ run, started: true, canReview: false, phase: 'running', error: 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED' }));
    expect(html).toContain('How the network fee is paid changed since your review: your ETH on this network now covers it, or no longer does. Nothing was sent. End this workflow and review it again');
    expect(html).toContain('>End and review again</button>');
    expect(html).not.toContain('Authorize steps 1–1 now');
    expect(render(state({ run, started: true, canReview: false, phase: 'running', error: 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED' }), 'PT'))
      .toContain('>Encerrar e revisar de novo</button>');
    // Any other error keeps the due group's "Authorize", and no "End and review again".
    const other = render(state({ run, started: true, canReview: false, phase: 'running', error: 'CIRCLE_PAYMASTER_REFUSED' }));
    expect(other).toContain('Authorize steps 1–1 now');
    expect(other).not.toContain('End and review again');
  });
  it('never "End and review again" while the run cannot be ended yet (a prepared wallet batch is still valid)', () => {
    const held = runOf({ groups: [group(0, { state: 'PREPARED', strategy: 'EVM_WALLET_BATCH', validUntil: FUTURE })] });
    const html = render(state({ run: held, started: true, canReview: false, phase: 'running', error: 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED' }));
    expect(html).not.toContain('End and review again');
    expect(html).toContain('the workflow can be ended after that');
  });
});

describe('review UX4: the two Circle signatures, one at a time', () => {
  const run = runOf({ groups: [group(0, { state: 'PREPARED', strategy: 'EVM_USER_OPERATION', validUntil: FUTURE })] });
  it('signature 1: the USDC permit and its cap; never "REQUEST 1 OF 2", the batch calls, or "every call of the batch" (EN/PT)', () => {
    const html = render(state({ run, started: true, canReview: false, phase: 'wallet', signing: { stage: 1, cap: '210000' } }));
    expect(html).toContain('EXECUTION · SIGNATURE 1 OF 2');
    expect(html).toContain('Signature 1 of 2: USDC permit, at most 0.21 USDC.');
    expect(html).toContain('Sign the USDC permit in your wallet. It sends no transaction.');
    for (const wrong of ['REQUEST 1 OF 2', 'Swap on Uniswap (step 1)', 'every call of the batch', 'This request has']) expect(html, wrong).not.toContain(wrong);
    const pt = render(state({ run, started: true, canReview: false, phase: 'wallet', signing: { stage: 1, cap: '210000' } }), 'PT');
    expect(pt).toContain('EXECUÇÃO · ASSINATURA 1 DE 2');
    expect(pt).toContain('Assinatura 1 de 2: permissão de USDC, no máximo 0.21 USDC.');
  });
  it('signature 2: the operation, once the permit step answered', () => {
    const html = render(state({ run, started: true, canReview: false, phase: 'wallet', signing: { stage: 2, cap: '210000' } }));
    expect(html).toContain('EXECUTION · SIGNATURE 2 OF 2');
    expect(html).toContain('Signature 2 of 2: the operation.');
    expect(html).toContain('Sign the operation in your wallet. It sends no transaction: FloFi relays it.');
    expect(html).not.toContain('every call of the batch');
  });
  it('a wallet batch keeps its request view', () => {
    const batch = runOf({ groups: [group(0, { state: 'PREPARED', validUntil: FUTURE, steps: [0, 1], planned: { steps: [], calls: 4, approvals: 2, healthFactorAfter: null } })] });
    const html = render(state({ review: swapBridgeReview(), run: batch, started: true, canReview: false, phase: 'wallet' }));
    expect(html).toContain('EXECUTION · REQUEST 1 OF 1');
    expect(html).toContain('It shows every call of the batch and the network fee.');
  });
});
