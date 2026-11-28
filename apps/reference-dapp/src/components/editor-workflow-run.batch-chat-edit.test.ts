// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R09–R12): a chat edit of a Batch Payment's recipients or amounts (`SET_BATCH_PAYMENT`, committed by the
 * real editor reducer) is a new workflow revision, and the Editor's whole-workflow Review of the previous revision is retired by the hook's existing
 * revision binding: nothing reviewed for the old recipient list can be authorized for the new one. The hook runs under a minimal in-process hook
 * emulator; every server action and the wallet are doubles (no network); nothing is signed or sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';

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
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn(), status: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({ editorWorkflowExecutionAvailability: async () => ({ enabled: true, code: null }),
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: server.status, prepareUserFundedGroup: vi.fn(), authorizeUserFundedGroup: vi.fn(),
  reportUserFundedBatch: vi.fn(), reportUserFundedRefusal: vi.fn(), cancelWorkflowRunHandoff: vi.fn(), resumeWorkflowRunHandoff: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: vi.fn(), batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  sendWalletBatch: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: async () => ({}), signSolanaGroup: vi.fn(), signUserOperation: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { useEditorWorkflowRun } = await import('./editor-workflow-run');
const { editorReducer, initialEditor } = await import('../domain/editor');
const { registerFixtureCatalogs } = await import('../domain/intelligence/intelligence.test-harness');

const OWNER = '0x' + 'ab'.repeat(20), CAIO = '0x' + '22'.repeat(20), DAYANE = '0x' + '33'.repeat(20), PEDRO = '0x' + '44'.repeat(20);
const storage = new Map<string, string>();
const review = { owner: OWNER, workflowHash: '0x' + '1'.repeat(64), validUntil: '2999-01-01T00:00:00.000Z', mode: 'ONE_WALLET_CONFIRMATION', refusal: null,
  steps: [{ index: 0 }], groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 0], chain: 'eip155:8453' }] };
type Workflow = ReturnType<typeof initialEditor>['workflow'];
let workflow: Workflow;
const render = () => { hooks.at = 0; return useEditorWorkflowRun({ workflow, evmAccount: OWNER, enabled: true }); };
async function settle() { render(); for (const effect of hooks.effects.filter(Boolean)) effect(); await new Promise(resolve => setTimeout(resolve, 0)); }

beforeEach(() => {
  registerFixtureCatalogs();
  hooks.slots = []; hooks.effects = []; storage.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  for (const f of Object.values(server)) f.mockReset();
  server.review.mockResolvedValue({ ok: true, value: review });
});

describe('R09–R12: a chat edit of the Batch Payment retires the Review of the previous revision', () => {
  it('adding a recipient or changing an amount from the chat drops the Review: Authorize is refused (REVIEW_REQUIRED) and nothing reaches the server', async () => {
    const context = createBaseSepoliaReviewContext();
    const created = editorReducer(initialEditor(), { type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0,
      input: { network: 'Base', asset: 'USDC', payments: [{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }] } }, context);
    expect(created.error).toBeNull();
    workflow = created.workflow;
    const nodeId = workflow.nodes.at(-1)!.nodeId;
    await settle();
    await render().startReview();
    expect(render()).toMatchObject({ phase: 'reviewed', review: { workflowHash: review.workflowHash } });
    for (const payments of [[{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }, { recipient: PEDRO, amount: '10' }],
      [{ recipient: CAIO, amount: '25' }, { recipient: DAYANE, amount: '30' }, { recipient: PEDRO, amount: '10' }]]) {
      // The chat's edit of the SAME card: a new revision of the same workflow.
      const edited = editorReducer({ workflow, error: null }, { type: 'SET_BATCH_PAYMENT', nodeId, source: 'CHAT', baseRevision: workflow.revision,
        input: { network: 'Base', asset: 'USDC', payments } }, context);
      expect(edited.error).toBeNull();
      expect(edited.workflow.revision).toBe(workflow.revision + 1);
      expect(edited.workflow.nodes.at(-1)!.nodeId).toBe(nodeId);
      workflow = edited.workflow;
      await settle();
      expect(render()).toMatchObject({ phase: 'idle', review: null });
      await render().authorize();
      expect(render().error).toBe('REVIEW_REQUIRED');
      expect(server.authorize).not.toHaveBeenCalled();
      // A fresh Review describes the new list; it is the only one Authorize may use.
      await render().startReview();
      expect(render().phase).toBe('reviewed');
    }
    expect(server.review).toHaveBeenCalledTimes(3);
    expect(server.authorize).not.toHaveBeenCalled();
  });
});
