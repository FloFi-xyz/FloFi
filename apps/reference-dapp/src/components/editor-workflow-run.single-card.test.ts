// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the Editor's whole-workflow hook for ONE financial card. The card takes this path only where the
 * deployment reports one-step runs (`singleStep`, i.e. its database holds migration 0032): then one Authorize hands ONE wallet batch to the
 * wallet (counted at the wallet double) and nothing else is asked; otherwise the hook stays off and the card keeps its own flow. Read-only
 * presentation copy for the one-step plan never claims more than it is. The hook runs under a minimal in-process hook emulator; every server
 * action and the wallet are doubles (no network).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, effects: [] as (() => unknown)[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const slot = <T>(init: () => T): T => { const k = hooks.at++; if (!(k in hooks.slots)) hooks.slots[k] = init(); return hooks.slots[k] as T; };
  return { ...actual,
    useState: (v: unknown) => { const k = hooks.at; const value = slot(() => typeof v === 'function' ? (v as () => unknown)() : v);
      return [value, (next: unknown) => { hooks.slots[k] = typeof next === 'function' ? (next as (p: unknown) => unknown)(hooks.slots[k]) : next; }]; },
    useRef: (v: unknown) => slot(() => ({ current: v })), useCallback: (f: unknown) => { hooks.at++; return f; },
    useEffect: (f: () => unknown) => { hooks.effects[hooks.at++] = f; } };
});
const availability = vi.hoisted(() => ({ value: { enabled: true, code: null as string | null, singleStep: false } }));
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn(), status: vi.fn(), prepare: vi.fn(), authorizeGroup: vi.fn(), report: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({ editorWorkflowExecutionAvailability: async () => availability.value,
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: server.status, prepareUserFundedGroup: server.prepare, authorizeUserFundedGroup: server.authorizeGroup,
  reportUserFundedBatch: server.report, cancelWorkflowRunHandoff: vi.fn(), resumeWorkflowRunHandoff: vi.fn() }));
/** `silent`: once the batch is sent, the wallet never answers `wallet_getCallsStatus` again (final wallet-execution review). */
const wallet = vi.hoisted(() => ({ requests: [] as string[], silent: false }));
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  walletProfile: async () => { wallet.requests.push('wallet_getCapabilities'); return { eip155: { wallet: 'INJECTED', atomic: { 'eip155:42161': 'supported' }, typedData: true } }; },
  sendWalletBatch: async (request: { id: string }, onSending: () => void) => { onSending(); wallet.requests.push('wallet_sendCalls'); return request.id; },
  // EIP-5792: an id the wallet never received is unknown (5730); once sent, its status reports the batch's transaction.
  walletBatchHashes: async () => { wallet.requests.push('wallet_getCallsStatus');
    if (!wallet.requests.includes('wallet_sendCalls')) throw Object.assign(new Error('Unknown bundle id'), { code: 5730 });
    if (wallet.silent) return new Promise(() => undefined);
    return { hashes: ['0x' + 'ef'.repeat(32)], failed: false }; },
  signSolanaGroup: vi.fn(), signUserOperation: vi.fn() }));
const proof = vi.hoisted(() => ({ proveEvm: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => proof }));
const { useEditorWorkflowRun } = await import('./editor-workflow-run');

const OWNER = '0x' + 'ab'.repeat(20), APPROVAL = 'apr_' + 'c'.repeat(26), GROUP_ID = '0x' + '12'.repeat(32), CHAIN = 'eip155:42161';
const storage = new Map<string, string>();
const workflow = { workflowId: 'wf-single', revision: 3, nodes: [{ chainId: CHAIN, actionType: 'asset.swap.exact-input' }] };
const group = (state: string) => ({ index: 0, chain: CHAIN, strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [0, 0], state, batchId: GROUP_ID, signed: state !== 'PREPARED',
  validUntil: null, feePayer: OWNER, planned: { steps: [{ index: 0, minimum: { units: '1500000', asset: `${CHAIN}/erc20:usdc`, text: '1.5 USDC' } }], calls: 2, approvals: 1,
    healthFactorAfter: null } });
const runView = (state: string, groupState: string) => ({ workflowRunId: 'wfr_' + 'c'.repeat(26), approvalId: APPROVAL, state, mode: 'USER_FUNDED', stepCount: 1, currentStep: 0,
  code: null, nextAction: state === 'COMPLETED' ? 'NONE' : 'OWNER_SIGNS_GROUP', steps: [{ index: 0, action: 'swap', state: state === 'COMPLETED' ? 'RECONCILED' : 'DELEGATED' }],
  authority: 'NONE', note: null, groups: [group(groupState)] });
const proposal = (state = 'RUNNING', groupState = 'PREPARED') => ({ view: { workflowRun: { run: runView(state, groupState) } } });
const prepared = { feePayer: OWNER, prepared: { kind: 'EVM_WALLET_BATCH', request: { version: '2.0.0', id: GROUP_ID, chainId: '0xa4b1', from: OWNER, atomicRequired: true,
  calls: [{ to: '0x' + '56'.repeat(20), value: '0x0', data: '0x095ea7b3' }, { to: '0x' + '68'.repeat(20), value: '0x0', data: '0x5ae401dc' }] } } };
const review = { owner: OWNER, workflowHash: '0x' + '2'.repeat(64), validUntil: '2999-01-01T00:00:00.000Z', mode: 'ONE_WALLET_CONFIRMATION', refusal: null, stepCount: 1,
  steps: [{ index: 0, minimum: { units: '1500000', asset: `${CHAIN}/erc20:usdc`, text: '1.5 USDC' } }],
  groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 0], chain: CHAIN }], counts: { walletPrompts: 1 } };

const render = (single = true) => { hooks.at = 0; return useEditorWorkflowRun({ workflow, evmAccount: OWNER, enabled: true, single }); };
/** Runs the effects of the last render (React would after it) and lets their promises settle. */
async function settle() { for (const effect of hooks.effects.filter(Boolean)) effect(); await new Promise(resolve => setTimeout(resolve, 0)); }

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; storage.clear(); wallet.requests.length = 0; wallet.silent = false; proof.proveEvm.mockReset(); vi.useRealTimers();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  vi.stubGlobal('crypto', { randomUUID: () => 'nonce-' + Math.random().toString(16).slice(2) });
  server.review.mockReset().mockResolvedValue({ ok: true, value: review });
  server.authorize.mockReset().mockResolvedValue({ ok: true, value: { approvalId: APPROVAL, proposal: proposal(), prepared } });
  server.status.mockReset().mockResolvedValue({ ok: true, value: proposal() });
  server.authorizeGroup.mockReset().mockResolvedValue({ ok: true, value: proposal('RUNNING', 'AUTHORIZED') });
  server.report.mockReset().mockResolvedValue({ ok: true, value: proposal('COMPLETED', 'RECONCILED') });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: one card in the Editor\'s whole-workflow hook', () => {
  it('stays off for one card until the deployment reports one-step runs (the card keeps its own flow); a multi-step workflow is unaffected', async () => {
    availability.value = { enabled: true, code: null, singleStep: false };
    render(); await settle();
    expect(render()).toMatchObject({ available: false, canReview: false });
    expect(render(false)).toMatchObject({ available: true, canReview: true });
  });

  it('one Authorize → exactly ONE wallet batch, no sign-in prompt with a valid session, automatic report to the completed run', async () => {
    availability.value = { enabled: true, code: null, singleStep: true };
    render(); await settle();
    expect(render()).toMatchObject({ available: true, canReview: true });
    await render().startReview();
    expect(render()).toMatchObject({ phase: 'reviewed', grouped: true, stepByStep: false });
    await render().authorize();
    expect(render().error).toBeNull();
    // Prompt-raising wallet requests: exactly one wallet_sendCalls. Capabilities and status reads never prompt; no personal_sign was needed.
    expect(wallet.requests.filter(m => m === 'wallet_sendCalls')).toHaveLength(1);
    expect(wallet.requests.filter(m => !['wallet_getCapabilities', 'wallet_getCallsStatus'].includes(m))).toEqual(['wallet_sendCalls']);
    expect(proof.proveEvm).not.toHaveBeenCalled();
    expect(server.authorizeGroup).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: GROUP_ID });
    expect(server.report).toHaveBeenCalledWith(APPROVAL, 0, ['0x' + 'ef'.repeat(32)], false);
    expect(render()).toMatchObject({ started: true, run: { state: 'COMPLETED', stepCount: 1 }, authorizedFor: { workflowId: 'wf-single', revision: 3 } });
    // A reload of the same Canvas follows the completed run by its stored id; nothing is reviewed, prepared or sent again.
    hooks.slots = []; hooks.effects = []; server.status.mockResolvedValue({ ok: true, value: proposal('COMPLETED', 'RECONCILED') });
    // Followed at once — even before (or without) the deployment's one-step answer: a started card is never offered through its own flow again.
    availability.value = { enabled: true, code: null, singleStep: false };
    render(); await settle(); render(); await settle(); render(); await settle();
    expect(render()).toMatchObject({ available: true, started: true, run: { state: 'COMPLETED' } });
    expect(wallet.requests.filter(m => m === 'wallet_sendCalls')).toHaveLength(1);
    expect(server.authorize).toHaveBeenCalledTimes(1);
  });

  it('a wallet that never answers its batch status after the one send never holds the panel: each read is bounded, nothing is reported or resent', async () => {
    availability.value = { enabled: true, code: null, singleStep: true };
    render(); await settle();
    await render().startReview();
    wallet.silent = true;
    vi.useFakeTimers();
    const authorizing = render().authorize();
    // 60 bounded status reads (30 s each) with their 2 s pauses: the follow ends, the run keeps observing server-side.
    await vi.advanceTimersByTimeAsync(60 * 32_000 + 1_000);
    await authorizing;
    vi.useRealTimers();
    expect(render()).toMatchObject({ phase: 'running', error: null });
    expect(wallet.requests.filter(m => m === 'wallet_sendCalls')).toHaveLength(1);
    expect(wallet.requests.filter(m => m === 'wallet_getCallsStatus').length).toBeGreaterThanOrEqual(60);
    expect(server.report).not.toHaveBeenCalled();
    // The panel's actions are free again: the owner's "Check my wallet" reads the status once more (bounded too) and never sends.
    wallet.silent = false;
    await render().checkWallet();
    expect(server.report).toHaveBeenCalledWith(APPROVAL, 0, ['0x' + 'ef'.repeat(32)], false);
    expect(wallet.requests.filter(m => m === 'wallet_sendCalls')).toHaveLength(1);
  });

  it('a Review that plans the card step by step (no atomic batching) is offered step by step: the Editor goes back to the card\'s own flow', async () => {
    availability.value = { enabled: true, code: null, singleStep: true };
    server.review.mockResolvedValue({ ok: true, value: { ...review, mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'],
      groups: [{ strategy: 'EVM_OWNER_STEP', steps: [0, 0], chain: CHAIN }] } });
    render(); await settle();
    await render().startReview();
    expect(render()).toMatchObject({ grouped: false, stepByStep: true });
    expect(wallet.requests.filter(m => m === 'wallet_sendCalls')).toHaveLength(0);
  });
  it('a stored run of this card dominates whatever the deployment answers (an expired account session): never offered through its own flow', async () => {
    availability.value = { enabled: false, code: 'ACCOUNT_SESSION_REQUIRED', singleStep: false };
    storage.set('flofi.editor-workflow-runs.v2', JSON.stringify([{ workflowId: 'wf-single', approvalId: APPROVAL, workflowHash: review.workflowHash, owner: OWNER, revision: 3,
      at: '2026-11-21T00:00:00.000Z' }]));
    server.status.mockResolvedValue({ ok: false, code: 'EVM_WALLET_PROOF_REQUIRED' });
    render(); await settle(); render(); await settle();
    // The run is this workflow's (started), shown (the panel offers to load its progress), and available: the shell keeps it primary.
    expect(render()).toMatchObject({ started: true, available: true, visible: true, canReview: false, unloaded: true, error: 'EDITOR_RUN_SIGN_IN_REQUIRED' });
    expect(wallet.requests).toEqual([]);
    expect(proof.proveEvm).not.toHaveBeenCalled();
  });
});
