// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-#254 hotfix (the Uniswap pool's PR #254 fix, applied to Orca): an Orca pool step of a step-by-step sequence (Swap → Bridge → Orca Pool,
 * Bridge to Solana → Orca Pool) is simulated, reviewed and authorized ALONE, as its runtime step (`runtimeWorkflow`), never as the whole Canvas
 * (which the Orca compiler refuses with any other step in it: SOLANA_LIQUIDITY_ISOLATED_ONLY). MOCKED loopback Solana chain; no public submission.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, createMockedSolanaDevnetOrca, createMockedSolanaWallet, orcaLiquidityIntent } from '@defi-workflow-engine/reference-compiler';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext, lintWorkflow, reviewContextForChain } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { HookHarness } from '../test-utils/hook-harness';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { stepNodeKey, stepRuntimeWorkflow, workflowSequence } from '../domain/workflow-sequence';
import { createOrcaLiquidityService, type OrcaLiquidityService } from '../server/orca-liquidity-service';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({
  canonical: null as unknown, runtime: null as unknown, sequenceRestore: null as unknown, service: null as unknown, owner: '', statusRecord: null as unknown,
  simulated: [] as unknown[], invalidated: [] as string[],
}));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: f.canonical }, runtimeWorkflow: f.runtime, sequenceRestore: f.sequenceRestore, stagedPosition: null }) }));
vi.mock('./jupiter-store', () => ({ useJupiter: () => ({ session: { chain: 'solana:mainnet', account: { address: f.owner } } }) }));
vi.mock('../app/solana-liquidity-action', () => {
  const off = async () => ({ ok: false as const, code: 'ORCA_LIQUIDITY_DEVNET_UNUSED' });
  return { solanaLiquidityInfo: async () => ({ ok: true, value: { executionEnabled: false } }), solanaLiquidityPrice: off, solanaLiquidityPositions: off, solanaLiquiditySimulate: off,
    solanaLiquidityReview: off, solanaLiquidityInvalidate: off, solanaLiquidityBegin: off, solanaLiquidityWalletFailure: off, solanaLiquiditySubmit: off, solanaLiquidityObserve: off,
    solanaLiquidityStatus: off };
});
vi.mock('../app/solana-mainnet-liquidity-action', () => {
  const svc = () => f.service as OrcaLiquidityService;
  const wrap = async <T,>(action: () => Promise<T>) => { try { return { ok: true as const, value: await action() }; } catch (cause) { return { ok: false as const, code: (cause as Error).message }; } };
  return {
    solanaMainnetLiquidityInfo: async () => ({ ok: true, value: { executionEnabled: true } }), solanaMainnetLiquidityPrice: () => wrap(() => svc().price()),
    solanaMainnetLiquidityPositions: (owner: string) => wrap(() => svc().positions(owner)),
    solanaMainnetLiquiditySimulate: (workflow: SemanticWorkflow, owner: string, request: Parameters<OrcaLiquidityService['simulate']>[2]) => {
      f.simulated.push(workflow); return wrap(() => svc().simulate(workflow, owner, request)); },
    solanaMainnetLiquidityReview: (id: string, commitment: string, workflow: SemanticWorkflow) => wrap(() => svc().review(id, commitment, workflow)),
    solanaMainnetLiquidityInvalidate: (id: string) => { f.invalidated.push(id); return wrap(() => svc().invalidate(id)); },
    solanaMainnetLiquidityBegin: (id: string, owner: string, workflow: SemanticWorkflow) => wrap(() => svc().begin(id, owner, workflow)),
    solanaMainnetLiquidityWalletFailure: (id: string, diagnostic: Parameters<OrcaLiquidityService['walletFailure']>[1]) => wrap(() => svc().walletFailure(id, diagnostic)),
    solanaMainnetLiquiditySubmit: (id: string, signed: string) => wrap(() => svc().submit(id, signed)),
    solanaMainnetLiquidityObserve: (id: string) => wrap(() => svc().observe(id)),
    solanaMainnetLiquidityStatus: (id: string) => f.statusRecord ? Promise.resolve({ ok: true as const, value: f.statusRecord }) : wrap(() => svc().load(id)),
  };
});
// Imported after the mocks.
const { SolanaLiquidityProvider, useSolanaLiquidity } = await import('./solana-liquidity-store');

const authoring = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const contextOf = (workflow: Workflow) => reviewContextForChain(workflow.nodes[0]!.chainId, authoring);
const lint = (workflow: Workflow) => lintWorkflow(workflow, contextOf(workflow));
const POOL = 'add liquidity 0.01 SOL and 0.3 USDC ticks -39104 to -36992 on Solana slippage 100 bps';
/** Bridge to Solana → Orca Pool, authored as the chat authors it. */
function bridgeThenPool(): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of ['bridge 5 USDC from Base to Solana via best slippage 100 bps', POOL]) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, authoring), authoring);
    if (state.error) throw new Error(state.error);
  }
  return state.workflow;
}
/** The Orca step as its runtime receives it: alone, its USDC bound to what the bridge delivered. */
function poolStep(workflow: Workflow, delivered: string) {
  const sequence = workflowSequence(workflow, lint)!, step = sequence.steps[1]!;
  const runtime = stepRuntimeWorkflow(step, [{ nodeId: workflow.nodes[0]!.nodeId, node: stepNodeKey(workflow.nodes[0]!), received: delivered, runKey: 'bridge' }], contextOf(step.projection));
  return runtime.workflow as unknown as SemanticWorkflow;
}

let host: HookHarness, store: ReturnType<typeof useSolanaLiquidity>, dir: string;
function Probe() { store = useSolanaLiquidity(); return null; }
const read = () => host.render(() => renderToStaticMarkup(<SolanaLiquidityProvider><Probe/></SolanaLiquidityProvider>));
async function settle() { for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 0)); read(); } }
async function act(action: () => Promise<void>) { const done = action(); await settle(); await done; await settle(); }

beforeEach(async () => {
  host = new HookHarness(); f.simulated = []; f.invalidated = []; f.sequenceRestore = null; f.statusRecord = null;
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: mainnet }), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  f.owner = wallet.owner;
  dir = await mkdtemp(join(tmpdir(), 'flofi-orca-store-'));
  f.service = createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, profile: mainnet, provenance: 'MOCKED', executionEnabled: true, now: () => Date.parse('2026-10-13T12:00:00.000Z') });
  const canonical = bridgeThenPool();
  f.canonical = canonical; f.runtime = poolStep(canonical, '200000');
});
afterEach(async () => { host.unmount(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

describe('post-#254 hotfix: an Orca pool step of a step-by-step sequence is simulated alone (Bridge to Solana → Orca Pool)', () => {
  it('simulates the runtime step (bound to the delivered 0.2 USDC), never the whole Canvas, and its Review stays current', async () => {
    read(); await settle();
    await act(() => store.simulate('OPEN'));
    expect(store.error).toBeNull();
    expect(f.simulated).toEqual([f.runtime]);
    expect(store.record?.review.workflow).toEqual(f.runtime);
    // The deposit never spends more USDC than the bridge delivered (authored 0.3 USDC), and keeps its authored SOL maximum: nothing is inserted.
    expect(store.record?.review.intent).toMatchObject({ amount0Max: '10000000', amount1Max: '200000' });
    expect(store.retired).toBe(false);
    // The whole Canvas, as this store used to send it, is refused for the universal bridge it carries (the linter runs before the Orca compiler,
    // which refuses any other step too: SOLANA_LIQUIDITY_ISOLATED_ONLY).
    await expect((f.service as OrcaLiquidityService).simulate(f.canonical as SemanticWorkflow, f.owner, { operation: 'OPEN', positionMint: store.record!.review.accounts.positionMint }))
      .rejects.toThrow('UNIVERSAL_ISOLATED_ONLY');
    expect(() => orcaLiquidityIntent(f.canonical as SemanticWorkflow, f.owner)).toThrow('SOLANA_LIQUIDITY_ISOLATED_ONLY');
  });

  it('keeps a reviewed authorization while the sequence is being restored, and invalidates it once the restored step differs', async () => {
    read(); await settle();
    await act(() => store.simulate('OPEN'));
    await act(() => store.review());
    expect(store.record?.authorization).toBe(store.record?.review.commitment);
    // A reload re-proves the completed bridge: until then the runtime step is not settled (here: a different bound amount) and nothing is invalidated.
    f.sequenceRestore = { stepIndex: 1 }; f.runtime = poolStep(f.canonical as Workflow, '150000');
    read(); await settle();
    expect(f.invalidated).toEqual([]);
    expect(store.record?.authorization).toBe(store.record?.review.commitment);
    // Restored, the step really differs from the reviewed one: the authorization is invalidated (and only then).
    f.sequenceRestore = null;
    read(); await settle();
    expect(f.invalidated).toEqual([store.record!.id]);
    expect(store.record?.authorization).toBeNull();
  });

  it('flofi-liquidity review: never invalidates a settled run (a completed Orca step once the sequence moved on), keeping its reconciled result', async () => {
    read(); await settle();
    await act(() => store.simulate('OPEN'));
    await act(() => store.review());
    // The step's run, reconciled (fixture), recovered after a reload; the sequence's runtime step is no longer the one it reviewed.
    const settled = { ...store.record!, verdict: 'RECONCILED' as const };
    host.unmount(); host = new HookHarness(); f.statusRecord = settled;
    vi.stubGlobal('window', { localStorage: { getItem: () => JSON.stringify({ id: settled.id, network: 'Solana' }), setItem: () => undefined } });
    f.runtime = poolStep(f.canonical as Workflow, '150000');
    read(); await settle();
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(store.retired).toBe(true);
    expect(f.invalidated).toEqual([]);
    expect(store.record?.authorization).toBe(settled.authorization);
  });
});
