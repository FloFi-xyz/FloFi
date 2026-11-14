// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1): the Editor's whole-workflow panel for Swap → Bridge (Arbitrum One → Base), EN and PT, rendered from a given hook state — the
 * Review's one confirmation and the bridge row (what it spends, what arrives on Base, that the run waits for it), the step-by-step reasons for a
 * wallet without atomic batching, and the run's progress from durable facts: "Waiting for delivery on Base" until the bridge reconciled, "X of N
 * steps completed" from reconciled steps only, "Every step reconciled." only once the run COMPLETED. Rendering calls no server action and no wallet.
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
const { EditorWorkflowRunPanel, EXECUTION_REASON, EXECUTION_REFUSAL } = await import('./editor-workflow-run');
const { LocaleProvider, translate } = await import('../i18n/locale');
const { runStepPhase, runProgress, awaitedDelivery, presentedDeliveryState } = await import('../workflow-runs/run-step-phase');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { EditorExecutionReview } from '../editor/workflow-execution';
import type { RunView } from '../workflow-runs/service';
import type { Language } from '../i18n/locale';

const OWNER = '0x' + 'ab'.repeat(20), PAST = '2020-01-01T00:00:00.000Z', FUTURE = '2999-01-01T00:00:00.000Z', ARB = 'eip155:42161', BASE = 'eip155:8453';
const usdc = (chain: string, units: string, text: string) => ({ asset: `${chain}/erc20:0x${chain === ARB ? 'af88' : '8335'}`, units, decimals: 6, symbol: 'USDC', text });
type Group = RunView['groups'][number];
const group = (patch: Partial<Group> = {}): Group => ({ index: 0, chain: ARB, strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [0, 1], state: 'SUBMITTED', awaitsDelivery: null,
  code: null, validUntil: null, feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: null, signed: true, planned: null, ...patch });
const step = (index: number, action: string, state: string) => ({ index, action, state, flow: null, stepWorkflowHash: null, code: null, bound: null, outcome: null });
const runOf = (patch: Partial<RunView>): RunView => ({ workflowRunId: 'wfr_' + 'c'.repeat(26), approvalId: 'apr_' + 'c'.repeat(26), state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 2,
  currentStep: 0, code: null, workflowHash: '0x' + '1'.repeat(64), expiresAt: FUTURE, completedAt: null, createdAt: PAST, updatedAt: PAST, stepsVisible: true,
  steps: [step(0, 'swap', 'RECONCILED'), step(1, 'bridge', 'DELEGATED')], nextAction: 'WAITING_FOR_RECONCILIATION',
  groups: [group({ delivery: { step: 1, chain: BASE, state: 'AWAITING_DESTINATION', fill: null } })], halted: null, resumable: false, authority: 'NONE', note: null, ...patch });
const review = (patch: Partial<EditorExecutionReview> = {}): EditorExecutionReview => ({ workflowHash: '0x' + '1'.repeat(64), stepCount: 2, owner: OWNER, reviewedAt: PAST,
  validUntil: FUTURE, mode: 'ONE_WALLET_CONFIRMATION', reasons: [], refusal: null,
  groups: [{ index: 0, chain: ARB, network: 'Arbitrum One', strategy: 'EVM_WALLET_BATCH', steps: [0, 1], signing: 'UPFRONT', interactions: 1, setup: [], downgrades: [],
    calls: [{ kind: 'ERC20_APPROVE', step: 0 }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }, { kind: 'ERC20_APPROVE', step: 1 }, { kind: 'ACROSS_DEPOSIT', step: 1 }],
    approvals: 2, fee: null, healthFactorAfter: null }],
  steps: [{ index: 0, action: 'swap', network: 'Arbitrum One', chain: ARB, provider: 'Uniswap V3', spend: null, basis: 'EXACT', boundTo: null,
    expected: usdc(ARB, '5000000', '5 USDC'), minimum: usdc(ARB, '4975000', '4.975 USDC'), recipient: null },
  { index: 1, action: 'bridge', network: 'Arbitrum One', chain: ARB, provider: null, spend: usdc(ARB, '4975000', '4.975 USDC'), basis: 'GUARANTEED_MINIMUM', boundTo: 0,
    expected: usdc(BASE, '4966223', '4.966223 USDC'), minimum: usdc(BASE, '4966223', '4.966223 USDC'), recipient: null, destination: 'Base' }],
  counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 4, networkSwitches: 0, oneTimeSetup: [] }, ...patch });
const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'running', review: null, error: null, run: null, updated: [],
  started: true, grouped: true, unrecorded: false, visible: true, earlier: false, stepByStep: false, unloaded: false, canReview: false, following: false,
  followEarlier: vi.fn(), hide: vi.fn(), resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(),
  end: vi.fn(), dismiss: vi.fn(), ...patch });
const render = (s: EditorWorkflowRunState, language: Language = 'EN') =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPanel state={s}/></LocaleProvider>);

describe('P0 hotfix E1: the Editor panel for Swap → Bridge', () => {
  it('the Review: ONE wallet confirmation on Arbitrum One, 4 batched calls, the bridge spends the swap\'s minimum and arrives on Base; the run waits for it', () => {
    const html = render(state({ review: review(), phase: 'reviewed', started: false, canReview: true }));
    expect(html).toContain('data-mode="ONE_WALLET_CONFIRMATION"');
    expect(html).toContain('All 2 steps run as ONE wallet confirmation on Arbitrum One');
    expect(html).toContain('Then FloFi waits for the bridge delivery on Base and completes the workflow once it has verified it');
    expect(html).toContain('Spends (the minimum step 1 guarantees)');
    expect(html).toContain('Arrives on Base</dt><dd>4.966223 USDC');
    expect(html).toContain('FloFi waits for this delivery on Base and verifies it before the workflow completes.');
    expect(html).toContain('4 calls in the batch (2 token approvals)');
    expect(html).toContain('one wallet confirmation · 1 on-chain transaction · 4 calls batched · 1 signature');
    // The swap keeps its slippage minimum; the bridge's exact delivery is not called a "minimum".
    expect(html.match(/Minimum \(your slippage limit\)/g)).toHaveLength(1);
    // While the wallet holds the request, its four calls in plain words: the bridge's deposit included.
    const wallet = render(state({ review: review(), phase: 'wallet', started: true }));
    expect(wallet).toContain('This request has 4 calls:');
    expect(wallet).toContain('Swap on Uniswap (step 1)');
    expect(wallet).toContain('Bridge deposit on Across (step 2)');
    expect(render(state({ review: review(), phase: 'wallet', started: true }), 'PT')).toContain('Depósito da ponte na Across (passo 2)');
    const pt = render(state({ review: review(), phase: 'reviewed', started: false, canReview: true }), 'PT');
    expect(pt).toContain('Chega na Base');
    expect(pt).toContain('Depois, a FloFi aguarda a entrega da ponte na Base');
  });

  it('a wallet without atomic batching: the step-by-step path says why, and that the bridge\'s own flow may ask again (EN/PT)', () => {
    const plain = review({ mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'],
      groups: [{ ...review().groups[0]!, strategy: 'EVM_OWNER_STEP', calls: null, approvals: null, interactions: 2, downgrades: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'] }],
      counts: { walletPrompts: 2, atLeast: true, signatures: 2, transactions: 2, batchedCalls: 0, networkSwitches: 0, oneTimeSetup: [] } });
    const html = render(state({ review: plain, phase: 'reviewed', started: false, canReview: true, stepByStep: true }));
    expect(html).toContain('This workflow needs a confirmation in your wallet for each step on its own.');
    expect(html).toContain('Your wallet does not offer atomic batching on this network, so each step is confirmed in your wallet.');
    expect(html).toContain('The bridge then runs through its own review: its token approval and its deposit may each ask your wallet once more.');
    expect(html).toContain('at least 2 wallet confirmations');
    expect(html).not.toContain('Then FloFi waits for the bridge delivery');
    const pt = render(state({ review: plain, phase: 'reviewed', started: false, canReview: true, stepByStep: true }), 'PT');
    expect(pt).toContain('A ponte então passa pela própria revisão');
  });

  it('the run: the swap reconciled, the bridge "Waiting for delivery on Base", 1 of 2 steps completed — never "Completed" before the last reconciliation', () => {
    const run = runOf({});
    const html = render(state({ run }));
    expect(html).toContain('Waiting for delivery on Base');
    expect(html).toContain('1 of 2 steps completed');
    expect(html).toContain('Confirmed on Arbitrum One · Waiting for delivery on Base');
    expect(html).toContain('Your batch is confirmed on Arbitrum One. FloFi is waiting for the delivery on Base and keeps checking even if you leave this page');
    expect(html).not.toContain('Every step reconciled.');
    expect(html).not.toContain('>End workflow</button>');
    const pt = render(state({ run }), 'PT');
    expect(pt).toContain('Aguardando a entrega na Base');
    expect(pt).toContain('1 de 2 etapas concluídas');
    // Completed only once the bridge reconciled: both steps counted, the run's result shown.
    const done = runOf({ state: 'COMPLETED', completedAt: PAST, nextAction: 'NONE', steps: [step(0, 'swap', 'RECONCILED'), step(1, 'bridge', 'RECONCILED')],
      groups: [group({ state: 'RECONCILED', delivery: { step: 1, chain: BASE, state: 'DELIVERED', fill: { hash: '0x' + 'f'.repeat(64), explorerUrl: null } } })] });
    const finished = render(state({ run: done, phase: 'done' }));
    expect(finished).toContain('2 of 2 steps completed');
    expect(finished).toContain('Every step reconciled.');
    expect(finished).not.toContain('Waiting for delivery');
  });

  it('the shared phase rules: reconciled steps only count; a delivery not observed past its deadline is an unknown outcome, never "failed"', () => {
    const waiting = runOf({});
    expect(runStepPhase(waiting, waiting.steps[1]!)).toEqual({ phase: 'AWAITING_DESTINATION', network: 'Base' });
    expect(runStepPhase(waiting, waiting.steps[0]!)).toEqual({ phase: 'RECONCILED', network: null });
    expect(runProgress(waiting)).toEqual({ completed: 1, total: 2 });
    expect(awaitedDelivery(waiting)).toEqual({ source: 'Arbitrum One', destination: 'Base', step: 1 });
    const missing = runOf({ state: 'ATTENTION', steps: [step(0, 'swap', 'RECONCILED'), step(1, 'bridge', 'UNCERTAIN')],
      groups: [group({ state: 'UNCERTAIN', code: 'BRIDGE_DELIVERY_NOT_OBSERVED', delivery: { step: 1, chain: BASE, state: 'NOT_OBSERVED', fill: null } })] });
    expect(runStepPhase(missing, missing.steps[1]!)).toEqual({ phase: 'OUTCOME_UNKNOWN', network: null });
    expect(awaitedDelivery(missing)).toBeNull();
    expect(render(state({ run: missing }))).toContain('Outcome unknown');
    // A deposit or fill that disagrees with what was signed (or a reorganized block) is never shown as "Waiting for delivery": outcome unknown.
    for (const code of ['ROUTER_FILL_MISMATCH', 'ROUTER_SOURCE_REORGANIZED', 'BRIDGE_DEPOSIT_EVENT_MISMATCH'])
      expect(presentedDeliveryState({ state: 'UNCERTAIN', code }, 'AWAITING_DESTINATION')).toBe('NOT_OBSERVED');
    // A delivery still awaited (the group open, or held for another reason) keeps its words.
    expect(presentedDeliveryState({ state: 'SUBMITTED', code: null }, 'AWAITING_DESTINATION')).toBe('AWAITING_DESTINATION');
    expect(presentedDeliveryState({ state: 'UNCERTAIN', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }, 'AWAITING_DESTINATION')).toBe('AWAITING_DESTINATION');
    expect(presentedDeliveryState({ state: 'UNCERTAIN', code: 'ROUTER_FILL_MISMATCH' }, 'DELIVERED')).toBe('DELIVERED');
    // A run without a bridge keeps its own words (no phase invented).
    expect(runStepPhase(runOf({ groups: [group({})] }), step(1, 'swap', 'DELEGATED'))).toBeNull();
  });

  it('every new bridge reason and refusal has words in English and Brazilian Portuguese', () => {
    for (const code of ['USER_OPERATION_BRIDGE_SIGNED_WHEN_DUE', 'USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED', 'USER_FUNDED_BRIDGE_PAIR_UNSUPPORTED', 'USER_FUNDED_BRIDGE_ASSET_UNSUPPORTED',
      'USER_FUNDED_BRIDGE_DESTINATION_UNREADABLE', 'USER_FUNDED_BRIDGE_RECIPIENT_NOT_OWNER']) {
      expect(EXECUTION_REASON[code], code).toEqual(expect.any(String));
      expect(translate('PT', EXECUTION_REASON[code]!), code).not.toBe(EXECUTION_REASON[code]);
    }
    for (const code of ['BRIDGE_QUOTE_UNAVAILABLE', 'BRIDGE_FEE_ABOVE_LIMIT', 'BRIDGE_QUOTE_VALIDITY_SHORT', 'BRIDGE_FILL_DEADLINE_SHORT', 'BRIDGE_EXCLUSIVITY_INVALID',
      'SIMULATION_BRIDGE_DEPOSIT_MISMATCH', 'ROUTER_DEPOSITS_PAUSED', 'ROUTER_FILLS_PAUSED', 'ROUTER_UNEXPECTED_CONTRACT', 'ACROSS_CALLDATA_MISMATCH']) {
      expect(EXECUTION_REFUSAL[code], code).toEqual(expect.any(String));
      expect(translate('PT', EXECUTION_REFUSAL[code]!), code).not.toBe(EXECUTION_REFUSAL[code]);
    }
  });
});
