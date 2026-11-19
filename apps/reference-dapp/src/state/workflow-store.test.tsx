// SPDX-License-Identifier: AGPL-3.0-only
/** P0 hotfix (execution continuity): the Editor's sequence keeps its identity, its Canvas and its final result across reloads and completion. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { HookHarness } from '../test-utils/hook-harness';
import { WorkflowProvider, useWorkflow } from './workflow-store';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { EDITOR_WORKFLOW_STORAGE_KEY, persistEditor } from '../domain/editor-persistence';
import { SEQUENCE_RUN_STORAGE_KEY } from '../domain/sequence-restore';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';
import type { LiquidityPositionChoice } from '../domain/liquidity-positions';
import type { LiquidityPositionPoolInput } from '../domain/commands';
import { STAGED_POSITION_KEY } from './workflow-store';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const initialContext = { registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry };
const context = createReviewContext(initialContext);
const OWNER = '0x1111111111111111111111111111111111111111';
function author(workflowId: string, ...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) { state = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, OWNER), context); expect(state.error).toBeNull(); }
  return { ...state.workflow, workflowId } as Workflow;
}
const amountOf = (workflow: Workflow) => (workflow.nodes[0]!.userConstraints.find(c => c.kind === 'MAXIMUM_INPUT') as unknown as { quantity: { amount: string } }).quantity.amount;
let host: HookHarness, store: ReturnType<typeof useWorkflow>, storage: Map<string, string>;
function Probe() { store = useWorkflow(); return <span>{store.state.workflow.nodes.length}</span>; }
const render = (persistCanvas = true) => host.render(() => renderToStaticMarkup(<WorkflowProvider initialContext={initialContext} initialWorkflowId="workflow-server-random-1" persistCanvas={persistCanvas}><Probe/></WorkflowProvider>));
beforeEach(() => {
  host = new HookHarness(); storage = new Map();
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { documentElement: { lang: '' } }));
  const session = new Map<string, string>(), sessionStorage = { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => { session.set(key, value); },
    removeItem: (key: string) => { session.delete(key); } };
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage, sessionStorage, setTimeout, clearTimeout, setInterval, clearInterval }));
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('P0 hotfix (execution continuity): WorkflowProvider', () => {
  it('a reload of the Editor puts the remembered Swap → Bridge back with its identity; /approve (no persistence) never does', () => {
    const workflow = author('workflow-stable-1', 'swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    persistEditor({ setItem: (key, value) => storage.set(key, value) }, workflow);
    render(false);
    expect(store.state.workflow.nodes).toHaveLength(0);
    expect(store.state.workflow.workflowId).toBe('workflow-server-random-1');
    host.unmount(); host = new HookHarness();
    render(true);
    expect(JSON.stringify(store.state.workflow)).toBe(JSON.stringify(workflow));
    expect(store.sequence?.steps).toHaveLength(2);
    expect(store.sequence?.cursor).toBe(0);
  });
  it('the Canvas is remembered as it changes, and "Create new workflow" replaces it with a fresh empty identity', () => {
    render(true);
    expect(JSON.parse(storage.get(EDITOR_WORKFLOW_STORAGE_KEY)!)).toMatchObject({ workflowId: 'workflow-server-random-1', workflow: null });
    const workflow = author('workflow-stable-2', 'swap 0.001 ETH to USDC on Base slippage 100 bps');
    store.restoreWorkflow(workflow as never); render(true);
    expect(JSON.parse(storage.get(EDITOR_WORKFLOW_STORAGE_KEY)!).workflowId).toBe('workflow-stable-2');
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
    store.createNewWorkflow(); render(true);
    expect(JSON.parse(storage.get(EDITOR_WORKFLOW_STORAGE_KEY)!)).toMatchObject({ workflowId: 'workflow-00000000-0000-4000-8000-000000000001', workflow: null });
  });
  it('production 2026-11-12: after the last step completes, the runtime workflow is still exactly the step that executed (no "Review required again")', () => {
    const workflow = author('workflow-stable-3', 'swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    persistEditor({ setItem: (key, value) => storage.set(key, value) }, workflow);
    render(true);
    expect(store.runtimeWorkflow.nodes.map(node => node.nodeId)).toEqual([store.sequence!.steps[0]!.nodeId]);
    store.completeSequenceStep(0, { received: '2500000', runKey: 'arbsw-0123456789abcdef', kind: 'public', owner: OWNER }); render(true);
    expect(store.sequence).toMatchObject({ cursor: 1, finished: false, bound: '2000000' });
    const executed = JSON.stringify(store.runtimeWorkflow);
    expect(amountOf(store.runtimeWorkflow)).toBe('2000000');
    // The step pointers are kept under the stable identity, so a reload re-proves them from the runtimes' records.
    expect(JSON.parse(storage.get(SEQUENCE_RUN_STORAGE_KEY + 'workflow-stable-3')!).completed).toMatchObject([{ kind: 'public', runKey: 'arbsw-0123456789abcdef', received: '2500000' }]);
    store.completeSequenceStep(1, { received: '1990000', runKey: 'xroute-0123456789abcdef0123456789abcdef', kind: 'router', owner: OWNER }); render(true);
    expect(store.sequence).toMatchObject({ cursor: 1, finished: true, bound: '2000000', fundingIssue: null });
    expect(store.sequence!.completed).toHaveLength(2);
    expect(JSON.stringify(store.runtimeWorkflow)).toBe(executed);
    // Completing it again (a late re-render of the same record) changes nothing.
    store.completeSequenceStep(1, { received: '1990000', runKey: 'xroute-0123456789abcdef0123456789abcdef', kind: 'router', owner: OWNER }); render(true);
    expect(store.sequence!.completed).toHaveLength(2);
    expect(JSON.stringify(store.runtimeWorkflow)).toBe(executed);
  });
});

/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the staged choice of MANAGE_LIQUIDITY_POSITION (chat or Dashboard), and what clears it. */
describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: staged position choice', () => {
  const OWNER_SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', MINT = 'Fm7mfcbKeHsUo2u8nDWjpcAfNudKk7XqzGu1QW8k6PJx';
  const choice = (operation: LiquidityPositionChoice['operation'], partBps: number | null = null): LiquidityPositionChoice => ({
    position: { protocol: 'ORCA', chain: ORCA.chain, network: 'Solana', manager: ORCA.programs.whirlpool, pool: ORCA.pool.address, positionId: MINT, owner: OWNER_SOLANA },
    operation, partBps, close: operation === 'EXIT' });
  const pool: LiquidityPositionPoolInput = { token0: { symbol: 'SOL', address: ORCA.token0.mint, decimals: 9 }, token1: { symbol: 'USDC', address: ORCA.token1.mint, decimals: 6 },
    feeTier: 3000, tickLower: -19_200, tickUpper: -18_560, amount0: '1000000', amount1: '150000', slippageBps: 100 };
  const manage = (c: LiquidityPositionChoice) => ({ type: 'MANAGE_LIQUIDITY_POSITION' as const, choice: c, pool, source: 'CHAT' as const, baseRevision: store.state.workflow.revision });

  it('a chat MANAGE_LIQUIDITY_POSITION stages its exact choice; re-staging the same node is not NO_CHANGE; any other command, undo or new workflow clears it', () => {
    render(true);
    expect(store.commitChatCommand(manage(choice('DECREASE', 2_500)))).toMatchObject({ ok: true }); render(true);
    expect(store.stagedPosition).toMatchObject({ positionId: MINT, operation: 'DECREASE_PARTIAL', partBps: 2_500, choice: choice('DECREASE', 2_500), serial: 1,
      workflowId: store.state.workflow.workflowId, revision: store.state.workflow.revision });
    // The same position, another operation: re-dispatched as its own command (never NO_CHANGE), and the staged choice follows it.
    expect(store.commitChatCommand(manage(choice('EXIT')))).toMatchObject({ ok: true }); render(true);
    expect(store.stagedPosition).toMatchObject({ operation: 'EXIT', serial: 2, revision: store.state.workflow.revision });
    // Undo of the staging command restores an earlier revision: the staged choice no longer describes it.
    store.undo(); render(true);
    expect(store.stagedPosition).toBeNull();
    // Another command clears it too.
    expect(store.commitChatCommand(manage(choice('COLLECT')))).toMatchObject({ ok: true }); render(true);
    expect(store.stagedPosition?.operation).toBe('COLLECT');
    store.dispatch(parseLocalCommand('swap 0.001 ETH to USDC on Base slippage 100 bps', store.state.workflow, context, OWNER)); render(true);
    expect(store.stagedPosition).toBeNull();
    expect(store.commitChatCommand(manage(choice('COLLECT')))).toMatchObject({ ok: false, error: 'POSITION_WORKFLOW_HAS_OTHER_STEPS' }); render(true);
    expect(store.stagedPosition).toBeNull();
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000002' });
    store.createNewWorkflow(); render(true);
    expect(store.stageLiquidityPosition(choice('EXIT'), pool)).toMatchObject({ ok: true }); render(true);
    expect(store.stagedPosition).toMatchObject({ operation: 'EXIT', choice: choice('EXIT') });
    store.clearStagedPosition(); render(true);
    expect(store.stagedPosition).toBeNull();
    // An invalid choice is never staged.
    expect(store.stageLiquidityPosition({ ...choice('EXIT'), close: false }, pool)).toEqual({ ok: false, error: 'LIQUIDITY_POSITION_CHOICE_INVALID' });
  });

  it('a reload of the same Editor tab keeps the staged choice on exactly its workflow (never as a deposit), and drops it for another workflow', () => {
    render(true);
    expect(store.commitChatCommand(manage(choice('DECREASE', 5_000)))).toMatchObject({ ok: true }); render(true);
    const staged = store.stagedPosition, workflow = store.state.workflow;
    expect(JSON.parse((window as unknown as { sessionStorage: Storage }).sessionStorage.getItem(STAGED_POSITION_KEY)!)).toMatchObject({ choice: choice('DECREASE', 5_000) });
    persistEditor({ setItem: (key, value) => storage.set(key, value) }, workflow);
    host.unmount(); host = new HookHarness(); render(true);
    expect(JSON.stringify(store.state.workflow)).toBe(JSON.stringify(workflow));
    expect(store.stagedPosition).toMatchObject({ operation: 'DECREASE_PARTIAL', partBps: 5_000, choice: staged!.choice });
    // /approve and embedded signing never read it.
    host.unmount(); host = new HookHarness(); render(false);
    expect(store.stagedPosition).toBeNull();
  });
});
