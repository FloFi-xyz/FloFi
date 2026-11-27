// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { composeStrategy } from '../engine/strategy-engine';
import { networkIdentity } from './network-registry';
import { initialWorkflow, type Workflow } from './initial-workflow';
import { recoveredRunAttaches, selectOwnerRuntime, type HeldRun, type OwnerRuntimeKind, type OwnerRuntimeSignals } from './runtime-selection';
import { SEQUENCE_RUNTIMES, stepProjection } from './workflow-sequence';
import { canvasWorkflowOfStrategy } from '../editor/workflow-strategy';

const none: HeldRun = { recovered: false, workflow: null };
const quiet = (baseReferenceServed = false, recoveryShell = true): OwnerRuntimeSignals => ({ recoveryShell, solanaTransfer: none, transfer: none, lending: none,
  uniswapLiquidity: none, router: none, solanaComposition: none, solanaLiquidity: none, jupiter: none, supply: { ...none, operation: null },
  publicSwap: { recoveryOnly: false, workflow: null, continuedApproval: false }, baseReferenceServed });
/** Every store that recovers a run from this browser, and the runtime its run is served by. */
const STORES = { solanaTransfer: 'solana-transfer', transfer: 'transfer', lending: 'lending', uniswapLiquidity: 'uniswap-pool', router: 'router',
  solanaComposition: 'solana-composition', solanaLiquidity: 'solana-pool', jupiter: 'solana-swap', supply: 'supply', publicSwap: 'public' } as const satisfies Record<string, OwnerRuntimeKind>;
type Store = keyof typeof STORES;
function recovering(store: Store, run: Workflow, signals: OwnerRuntimeSignals = quiet()): OwnerRuntimeSignals {
  if (store === 'publicSwap') return { ...signals, publicSwap: { recoveryOnly: true, workflow: run, continuedApproval: false } };
  if (store === 'supply') return { ...signals, supply: { recovered: true, workflow: run, operation: 'supply' } };
  return { ...signals, [store]: { recovered: true, workflow: run } };
}
const composed = STRATEGY_EXAMPLES.map(({ id, strategy }) => {
  const result = composeStrategy(strategy); if (!result.ok) throw new Error(`${id} does not compose`);
  return { id, workflow: result.workflow as Workflow };
});
const workflowOf = (id: string) => composed.find(example => example.id === id)!.workflow;
const networks = (workflow: Workflow) => [...new Set(workflow.nodes.filter(n => !n.actionType.startsWith('mock-')).map(n => n.chainId))];

describe('BUILD-FLOFI-UNIVERSAL-E2E-001 owner-wallet runtime selection', () => {
  it('reproduces the incident: a recovered Solana Mainnet Jupiter run never serves a Base Sepolia workflow', () => {
    const baseSepolia = workflowOf('swap-base-sepolia'), solanaMainnet = workflowOf('swap-solana');
    expect(networkIdentity(networks(solanaMainnet)[0])?.name).toBe('Solana');
    const runtime = selectOwnerRuntime(baseSepolia, recovering('jupiter', solanaMainnet));
    expect(runtime).toMatchObject({ kind: 'public', solanaPath: false, publicPath: true });
    // The same recovered run still serves the visit's untouched draft (its run is shown again) and its own workflow.
    expect(selectOwnerRuntime(initialWorkflow(), recovering('jupiter', solanaMainnet)).kind).toBe('solana-swap');
    expect(selectOwnerRuntime(solanaMainnet, recovering('jupiter', solanaMainnet)).kind).toBe('solana-swap');
  });

  it('routes every composed action and network to its own runtime', () => {
    const kinds = Object.fromEntries(composed.map(({ id, workflow }) => [id, selectOwnerRuntime(workflow, quiet(true)).kind]));
    for (const [id, kind] of Object.entries(kinds)) {
      const action = STRATEGY_EXAMPLES.find(example => example.id === id)!.strategy.action;
      const expected = { swap: id.includes('solana') ? 'solana-swap' : 'public', transfer: id.includes('solana') ? 'solana-transfer' : 'transfer',
        // P0 catalog reliability: the Solana ⇄ EVM directions are Universal Router rows, and (BUILD-FLOFI-POST-257-HOTFIX-001) so are the EVM bridges
        // with their own destination asset; every other bridge example is a certified Router route.
        bridge: id.includes('solana') || id.endsWith('-native-to-stable') ? 'universal' : 'router',
        supply: 'supply', borrow: 'supply', repay: 'supply', withdraw: 'supply', add_liquidity: id.includes('solana') ? 'solana-pool' : 'uniswap-pool',
        lending_composition: 'lending',
        // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: no browser runtime executes a Batch Payment card: only the whole-workflow run does (atomically).
        batch_payment: null }[action];
      expect([id, kind]).toEqual([id, expected]);
    }
  });

  it('serves Arbitrum One and Ethereum positions with the owner-wallet position runtime (they fell through to the local fork runtime)', () => {
    for (const id of ['add-liquidity-arbitrum', 'add-liquidity-ethereum', 'add-liquidity-base', 'add-liquidity-robinhood', 'add-liquidity-base-sepolia', 'add-liquidity-ethereum-sepolia'])
      expect([id, selectOwnerRuntime(workflowOf(id), quiet()).kind]).toEqual([id, 'uniswap-pool']);
  });

  it.each(Object.keys(STORES) as Store[])('a recovered %s run never takes over another workflow, on any network boundary', store => {
    for (const served of [false, true]) for (const current of composed) {
      const own = selectOwnerRuntime(current.workflow, quiet(served));
      for (const run of composed) {
        if (run.id === current.id) continue;
        expect([current.id, run.id, selectOwnerRuntime(current.workflow, recovering(store, run.workflow, quiet(served)))]).toEqual([current.id, run.id, own]);
      }
    }
  });

  it.each(Object.entries(STORES) as [Store, OwnerRuntimeKind][])('a recovered %s run is still shown on the untouched draft of the visit that recovers it', (store, kind) => {
    for (const run of composed) {
      expect(selectOwnerRuntime(initialWorkflow(), recovering(store, run.workflow)).kind).toBe(kind);
      // A workflow created afresh in this visit never gets a persisted run back.
      expect(selectOwnerRuntime(initialWorkflow(), recovering(store, run.workflow, quiet(false, false))).kind).toBeNull();
    }
  });

  it('keeps the recovered Aave operation on the untouched draft only', () => {
    const run = workflowOf('withdraw-arbitrum');
    const signals = { ...quiet(), supply: { recovered: true, workflow: run, operation: 'withdraw' as const } };
    expect(selectOwnerRuntime(initialWorkflow(), signals)).toMatchObject({ kind: 'supply', withdrawPath: true, supplyPath: true });
    expect(selectOwnerRuntime(workflowOf('swap-solana-devnet'), signals)).toMatchObject({ kind: 'solana-swap', withdrawPath: false, supplyPath: false });
    expect(selectOwnerRuntime(workflowOf('add-liquidity-solana-devnet'), signals)).toMatchObject({ kind: 'solana-pool', supplyPath: false });
  });

  it('attaches a recovered run only to the untouched draft or to exactly its own reviewed workflow', () => {
    const run = workflowOf('swap-base-sepolia'), held = { recovered: true, workflow: run };
    expect(recoveredRunAttaches(initialWorkflow(), held)).toBe(true);
    expect(recoveredRunAttaches(run, held)).toBe(true);
    expect(recoveredRunAttaches(structuredClone(run) as Workflow, held)).toBe(true);
    expect(recoveredRunAttaches({ ...run, revision: run.revision + 1 }, held)).toBe(false);
    expect(recoveredRunAttaches(workflowOf('swap-ethereum-sepolia'), held)).toBe(false);
    expect(recoveredRunAttaches({ ...initialWorkflow(), revision: 1 }, held)).toBe(false);
    expect(recoveredRunAttaches(initialWorkflow(), { recovered: false, workflow: run })).toBe(false);
    expect(recoveredRunAttaches(initialWorkflow(), { recovered: true, workflow: null })).toBe(false);
  });
});

/**
 * KAN-20 (WS02 evaluation T8, section B): a mixed EVM → Solana workflow with a Solana Batch Payment keeps the Editor's per-step path (the preexisting
 * EVM-only whole-workflow predicate of PR #251), where the batch step has no per-card runtime: its own projection selects none (so the sequence issue
 * blocks it; it runs through /approve instead), while the bridge step keeps its runtime. A batch is never handed to a single-transfer runtime.
 */
describe('KAN-20: a Solana Batch Payment step of a mixed workflow has no per-step runtime', () => {
  const SA = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', SB = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty';
  // SOL, so the batch is not funded by the bridge's USDC delivery (an unbound mixed workflow: the Canvas reads it back to the same strategy).
  const BATCH = { action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: [{ recipient: SA, amount: '0.01' }, { recipient: SB, amount: '0.02' }] };
  const BRIDGE = STRATEGY_EXAMPLES.find(example => example.id === 'bridge-base-solana')!.strategy;
  it('the batch step selects no runtime and is not a sequence runtime; the bridge step is', () => {
    const opened = canvasWorkflowOfStrategy({ version: 2, steps: [BRIDGE, BATCH] });
    if (!opened.ok) throw new Error(opened.code);
    const mixed = opened.workflow as Workflow;
    const batch = mixed.nodes.find(n => n.actionType === 'asset.transfer.batch')!, bridge = mixed.nodes.find(n => !n.actionType.startsWith('mock-') && n !== batch)!;
    expect(batch.adapterConstraints.adapters.map(a => a.id)).toEqual(['solana.batch-payment']);
    expect(networks(mixed).sort()).toEqual(['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
    const batchKind = selectOwnerRuntime(stepProjection(mixed, batch as Parameters<typeof stepProjection>[1]), quiet()).kind;
    expect(batchKind).toBeNull();
    expect(SEQUENCE_RUNTIMES).not.toContain(batchKind);
    const bridgeKind = selectOwnerRuntime(stepProjection(mixed, bridge as Parameters<typeof stepProjection>[1]), quiet()).kind;
    expect(bridgeKind).toBe('universal');
    expect(SEQUENCE_RUNTIMES).toContain(bridgeKind);
    // A lone Solana batch card is the same: no per-card runtime (only the whole-workflow run executes it, atomically).
    expect(selectOwnerRuntime(workflowOf('batch-payment-solana'), quiet(true)).kind).toBeNull();
  });
});
