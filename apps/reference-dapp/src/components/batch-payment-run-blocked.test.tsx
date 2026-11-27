// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (FE-BATCH-04, WS02 review F2): the reason a lone Batch Payment's whole-workflow action is closed, read from
 * the REAL hook state the Editor passes (`useEditorWorkflowRun` under a minimal in-process hook emulator; every server action and the wallet are
 * doubles, no network). Only a Review proves the one atomic approval is unavailable; a held hook, a missing account session, a transient failure and
 * a pending answer each keep their own reason. Nothing is signed or sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, effects: [] as (() => unknown)[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const slot = <T,>(init: () => T): T => { const k = hooks.at++; if (!(k in hooks.slots)) hooks.slots[k] = init(); return hooks.slots[k] as T; };
  return { ...actual,
    useState: (v: unknown) => { const k = hooks.at; const value = slot(() => typeof v === 'function' ? (v as () => unknown)() : v);
      return [value, (next: unknown) => { hooks.slots[k] = typeof next === 'function' ? (next as (p: unknown) => unknown)(hooks.slots[k]) : next; }]; },
    useRef: (v: unknown) => slot(() => ({ current: v })), useCallback: (f: unknown) => { hooks.at++; return f; },
    useEffect: (f: () => unknown) => { hooks.effects[hooks.at++] = f; } };
});
const availability = vi.hoisted(() => ({ value: { enabled: true, code: null as string | null, singleStep: false } as { enabled: boolean; code: string | null; singleStep: boolean },
  pending: false }));
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn(), status: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({
  editorWorkflowExecutionAvailability: () => availability.pending ? new Promise(() => undefined) : Promise.resolve(availability.value),
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: server.status, prepareUserFundedGroup: vi.fn(), authorizeUserFundedGroup: vi.fn(),
  reportUserFundedBatch: vi.fn(), reportUserFundedRejection: vi.fn(), cancelWorkflowRunHandoff: vi.fn(), resumeWorkflowRunHandoff: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  walletProfile: async () => ({ eip155: { wallet: 'INJECTED', atomic: { 'eip155:8453': 'supported' }, typedData: true } }),
  sendWalletBatch: vi.fn(), walletBatchHashes: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { BATCH_RUN_BLOCKED, batchPaymentRunBlocked, useEditorWorkflowRun } = await import('./editor-workflow-run');

const OWNER = '0x' + 'ab'.repeat(20), CHAIN = 'eip155:8453';
/** A lone Batch Payment card (one EVM node; the hook reads only its chain). */
const workflow = { workflowId: 'wf-batch-blocked', revision: 2, nodes: [{ chainId: CHAIN, actionType: 'asset.transfer.batch' }] };
const review = (mode: string, refusal: { code: string; step: number | null } | null = null) => ({ owner: OWNER, workflowHash: '0x' + '2'.repeat(64),
  validUntil: '2999-01-01T00:00:00.000Z', mode, refusal, stepCount: 3, steps: [], groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 2], chain: CHAIN }],
  counts: { walletPrompts: 1 }, reasons: mode === 'STEP_BY_STEP' ? ['WALLET_ATOMIC_BATCH_UNSUPPORTED'] : [] });
const render = (enabled = true) => { hooks.at = 0; return useEditorWorkflowRun({ workflow, evmAccount: OWNER, enabled }); };
async function settle() { for (const effect of hooks.effects.filter(Boolean)) effect(); await new Promise(resolve => setTimeout(resolve, 0)); }
/** The hook after its availability answer, then (optionally) after a Review the owner asked for. */
async function shown(options: { readonly enabled?: boolean; readonly review?: unknown } = {}) {
  render(options.enabled); await settle();
  const state = render(options.enabled);
  if (options.review === undefined) return state;
  server.review.mockResolvedValue(options.review);
  await state.startReview(); await settle();
  return render(options.enabled);
}

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; availability.pending = false; availability.value = { enabled: true, code: null, singleStep: false };
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  server.review.mockReset(); server.authorize.mockReset(); server.status.mockReset();
});

describe('F2: a lone Batch Payment\'s closed action names the hook state\'s own reason', () => {
  it('a held hook (a restore, or an execution of this visit on another path) is held, never "cannot run on this deployment"', async () => {
    const state = await shown({ enabled: false });
    expect(state).toMatchObject({ held: true, available: false, canReview: false, availability: { known: true, code: null } });
    expect(batchPaymentRunBlocked(state)).toBe(BATCH_RUN_BLOCKED.HELD);
    // The same deployment with the hook enabled: open for its Review.
    hooks.slots = []; hooks.effects = [];
    expect(batchPaymentRunBlocked(await shown())).toBeNull();
  });

  it('a pending availability answer is checking; an answer that failed for a moment is held; an answer of "off" is unavailable', async () => {
    availability.pending = true;
    expect(batchPaymentRunBlocked(await shown())).toBe(BATCH_RUN_BLOCKED.CHECKING);
    hooks.slots = []; hooks.effects = []; availability.pending = false;
    availability.value = { enabled: false, code: 'ACCOUNT_SESSION_REQUIRED', singleStep: false };
    expect(batchPaymentRunBlocked(await shown())).toBe(BATCH_RUN_BLOCKED.SIGN_IN);
    hooks.slots = []; hooks.effects = [];
    availability.value = { enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED', singleStep: false };
    expect(batchPaymentRunBlocked(await shown())).toBe(BATCH_RUN_BLOCKED.UNAVAILABLE);
  });

  it('a Review refused for want of an account session asks to sign in; a transient failure stays open; only a step-by-step Review is atomic only', async () => {
    const session = await shown({ review: { ok: false, code: 'ACCOUNT_SESSION_REQUIRED' } });
    expect(session).toMatchObject({ error: 'ACCOUNT_SESSION_REQUIRED', stepByStep: true });
    expect(batchPaymentRunBlocked(session)).toBe(BATCH_RUN_BLOCKED.SIGN_IN);
    hooks.slots = []; hooks.effects = [];
    const transient = await shown({ review: { ok: false, code: 'EDITOR_REVIEW_RATE_LIMITED' } });
    expect(transient).toMatchObject({ error: 'EDITOR_REVIEW_RATE_LIMITED', canReview: true });
    expect(batchPaymentRunBlocked(transient)).toBeNull();
    hooks.slots = []; hooks.effects = [];
    const atomicOnly = await shown({ review: { ok: true, value: review('STEP_BY_STEP') } });
    expect(atomicOnly.review?.mode).toBe('STEP_BY_STEP');
    expect(batchPaymentRunBlocked(atomicOnly)).toBe(BATCH_RUN_BLOCKED.ATOMIC_ONLY);
    hooks.slots = []; hooks.effects = [];
    const grouped = await shown({ review: { ok: true, value: review('ONE_WALLET_CONFIRMATION') } });
    expect(grouped.grouped).toBe(true);
    expect(batchPaymentRunBlocked(grouped)).toBeNull();
  });
});
