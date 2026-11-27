// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (WS02 evaluation B.4, T7): the Editor's whole-workflow path never runs a workflow that mixes EVM and Solana steps in place — the preexisting
 * client predicate (`evmWorkflow` excludes any Solana chain; it predates this BUILD, B.3) is unchanged by the Solana Batch Payment path, which opens only
 * to workflows made of Solana Batch Payments alone. Such a mixed workflow keeps the Editor's per-step path and runs as a whole through /approve. With
 * an EVM wallet, a Solana wallet or both connected, it is never reviewed or authorized here. The hook runs under a minimal in-process hook emulator;
 * every server action and the wallet are doubles (no network).
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
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({ editorWorkflowExecutionAvailability: async () => ({ enabled: true, code: null }),
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: vi.fn(), prepareUserFundedGroup: vi.fn(), authorizeUserFundedGroup: vi.fn(), reportUserFundedBatch: vi.fn(),
  reportUserFundedRefusal: vi.fn(), cancelWorkflowRunHandoff: vi.fn(), resumeWorkflowRunHandoff: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  sendWalletBatch: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: async () => ({}), signSolanaGroup: vi.fn(), signUserOperation: vi.fn() }));
const proof = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: proof.hook }));
const { useEditorWorkflowRun } = await import('./editor-workflow-run');

const BASE = 'eip155:8453', SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const EVM_OWNER = '0x' + 'ab'.repeat(20), SOLANA_OWNER = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb';
const node = (actionType: string, chainId: string) => ({ actionType, chainId });
const workflowOf = (workflowId: string, ...nodes: ReturnType<typeof node>[]) => ({ workflowId, revision: 1, nodes });

/** Renders the hook, runs its effects once (the availability answer), and renders again, as React would. */
async function settle(workflow: ReturnType<typeof workflowOf>, wallets: { evmAccount: string | null; solanaAccount?: string | null }) {
  hooks.slots = []; hooks.effects = [];
  const render = () => { hooks.at = 0; return useEditorWorkflowRun({ workflow, ...wallets, enabled: true }); };
  render();
  for (const effect of hooks.effects) effect?.();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return render();
}

beforeEach(() => {
  server.review.mockReset(); server.authorize.mockReset();
  proof.hook.mockReset().mockImplementation(() => ({ proveEvm: vi.fn(), proveSolana: vi.fn() }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});

describe('T7: a workflow mixing EVM and Solana steps is never run in place in the Editor (preexisting, unchanged)', () => {
  const mixedTransfer = workflowOf('wf-mixed', node('bridge.cross-chain', BASE), node('asset.transfer', SOLANA));
  const mixedBatch = workflowOf('wf-mixed-batch', node('bridge.cross-chain', BASE), node('asset.transfer.batch', SOLANA));
  for (const [name, workflow] of [['an EVM bridge, then a Solana transfer', mixedTransfer], ['an EVM bridge, then a Solana Batch Payment', mixedBatch]] as const) {
    it(`${name}: not reviewable, step by step, for an EVM wallet, a Solana wallet or both; nothing asked of the server`, async () => {
      for (const wallets of [{ evmAccount: EVM_OWNER }, { evmAccount: null, solanaAccount: SOLANA_OWNER }, { evmAccount: EVM_OWNER, solanaAccount: SOLANA_OWNER }]) {
        const state = await settle(workflow, wallets);
        expect(state, JSON.stringify(wallets)).toMatchObject({ available: true, canReview: false, stepByStep: true });
        expect(state).not.toHaveProperty('namespace');
      }
      // Its whole-workflow path is the EVM one (the Solana sign-in is never asked for it here).
      expect(proof.hook.mock.calls.every(call => call[0] === 'eip155' && call[1] === undefined)).toBe(true);
      expect(server.review).not.toHaveBeenCalled();
      expect(server.authorize).not.toHaveBeenCalled();
    });
  }
  it('a Solana-only workflow without a Batch Payment stays step by step; an EVM-only workflow is reviewable exactly as before', async () => {
    expect(await settle(workflowOf('wf-sol', node('asset.transfer', SOLANA), node('swap.exact-input', SOLANA)), { evmAccount: EVM_OWNER, solanaAccount: SOLANA_OWNER }))
      .toMatchObject({ canReview: false, stepByStep: true });
    expect(await settle(workflowOf('wf-evm', node('swap.exact-input', BASE), node('asset.transfer', BASE)), { evmAccount: EVM_OWNER }))
      .toMatchObject({ canReview: true, stepByStep: false });
    expect(server.review).not.toHaveBeenCalled();
  });
});
