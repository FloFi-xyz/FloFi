// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { composeStrategy } from '../engine/strategy-engine';
import { networkIdentity } from './network-registry';
import { initialWorkflow, type Workflow } from './initial-workflow';
import { recoveredRunAttaches, selectOwnerRuntime, type HeldRun, type OwnerRuntimeKind, type OwnerRuntimeSignals } from './runtime-selection';

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
      const expected = { swap: id.includes('solana') ? 'solana-swap' : 'public', transfer: id.includes('solana') ? 'solana-transfer' : 'transfer', bridge: 'router',
        supply: 'supply', borrow: 'supply', repay: 'supply', withdraw: 'supply', add_liquidity: id.includes('solana') ? 'solana-pool' : 'uniswap-pool',
        lending_composition: 'lending' }[action];
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
