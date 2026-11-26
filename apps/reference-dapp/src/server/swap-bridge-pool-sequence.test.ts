// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PR #254 follow-up (production, beta user): Swap 0.0009 ETH → USDC on Base (Uniswap V3), Bridge 1 USDC Base → Ethereum (Cross-chain Router, LI.FI
 * quote), Pool 1 USDC + 0.001 WETH on Ethereum (Uniswap V3) showed "Simulation failed" with the generic text. Production logs (flofi-api,
 * flow=ethereum-liquidity action=simulate) recorded ROUTER_ISOLATED_ONLY: the pool step's runtime simulated the WHOLE workflow, so the server linted
 * the swap and the Router bridge together with the pool and refused them (a software defect, not a financial rejection). The step-by-step sequence
 * simulates the pool step alone, bound to what the bridge delivered. MOCKED in-process chain only; never public execution evidence.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseAssetRegistry, catalogAsset, catalogPoolOn, parseEthereumTokenList, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createReviewContext, lintWorkflow, reviewContextForChain, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { LIQUIDITY_WETH_SHORTFALL_MESSAGE, simulationError } from '../domain/simulation-presentation';
import { stepNodeKey, stepRuntimeWorkflow, workflowSequence, type CompletedStep } from '../domain/workflow-sequence';
import { routerDetails } from '../domain/router-authoring';
import { createUniswapLiquidityService } from './uniswap-liquidity-service';

const catalog = parseEthereumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/ethereum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-17T00:00:00Z');
const authoringContext = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const contextOf = (workflow: Workflow): ReviewContext => reviewContextForChain(workflow.nodes[0]!.chainId, authoringContext);
const lint = (workflow: Workflow) => lintWorkflow(workflow, contextOf(workflow));
const dirs: string[] = [];
afterEach(async () => { resetNetworkCatalogs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** The reported workflow, authored as the chat authors it. */
function reported(): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of ['swap 0.0009 ETH to USDC on Base slippage 100 bps', 'bridge 1 USDC from Base to Ethereum',
    'add liquidity 1 USDC and 0.001 WETH on Ethereum full range slippage 100 bps']) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, authoringContext, UNI_OWNER), authoringContext);
    expect(state.error, sentence).toBeNull();
  }
  return state.workflow;
}
/** The swap delivered 1.52752 USDC on Base; the bridge delivered 0.98295 USDC on Ethereum (the reported estimates, as reconciled amounts). */
function completedBefore(workflow: Workflow, bridged = '982950'): CompletedStep[] {
  return [{ nodeId: workflow.nodes[0]!.nodeId, node: stepNodeKey(workflow.nodes[0]!), received: '1527520', runKey: 'swap' },
    { nodeId: workflow.nodes[1]!.nodeId, node: stepNodeKey(workflow.nodes[1]!), received: bridged, runKey: 'bridge' }];
}
async function ethereumPool(balances: { usdc?: bigint; weth?: bigint; eth?: bigint } = {}) {
  registerNetworkCatalog(catalog);
  // The pool the chat authored (its own fee tier), stood in for by the MOCKED chain.
  const fee = readConcentratedLiquidity(reported().nodes[2]! as SemanticWorkflow['nodes'][number]).feeTier;
  const a = catalogAsset(catalog, { symbol: 'USDC' })!, b = catalogAsset(catalog, { symbol: 'WETH' })!;
  const profile = catalogPoolOn(1, { symbol: a.symbol, address: a.address!, decimals: a.decimals }, { symbol: b.symbol, address: b.address!, decimals: b.decimals }, fee);
  const chain = createUniswapLiquidityChain({ profile, tick: 200_000, usdc: 10n ** 7n, weth: 10n ** 16n, ...balances });
  const path = await mkdtemp(join(tmpdir(), 'flofi-swap-bridge-pool-')); dirs.push(path);
  const service = createUniswapLiquidityService({ storage: createFileExecutionStorage(path, 'UNISWAP_LIQUIDITY_BUSY'), rpc: async () => { throw Error('NO_FALLBACK'); },
    rpcs: { 'eip155:1': chain.rpc }, now: chain.clock, provenance: 'MOCKED', executionEnabled: true, mockedCodePins: UNI_MOCK_CODE_PINS,
    catalog: { chain: 'eip155:1', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  return { service, chain, usdc: a.address!.toLowerCase(), weth: b.address!.toLowerCase() };
}
/** The pool step as its runtime receives it: alone, on Ethereum, its USDC bound to what the bridge delivered. */
function poolStep(workflow: Workflow, completed: readonly CompletedStep[]) {
  const sequence = workflowSequence(workflow, lint)!;
  const step = sequence.steps[2]!;
  return { step, ...stepRuntimeWorkflow(step, completed, contextOf(step.projection)) };
}

describe('PR #254 follow-up: Swap → Bridge → Pool (production report) simulates the pool step alone', () => {
  it('is one supported step-by-step composition: each step alone for its own runtime, the pool funded by the bridge, the bridge by the swap', () => {
    const workflow = reported();
    expect(workflow.nodes.map(node => [node.actionType, node.chainId])).toEqual([['asset.swap.exact-input', 'eip155:8453'], ['asset.bridge', 'eip155:8453'],
      ['asset.liquidity.concentrated', 'eip155:1']]);
    expect(routerDetails(workflow.nodes[1]!)).toMatchObject({ network: 'base-to-ethereum' });
    // As ONE workflow, no runtime accepts it (the Router bridge executes alone): this is the refusal production recorded.
    expect(() => lintWorkflow(workflow, authoringContext)).toThrow('ROUTER_ISOLATED_ONLY');
    const sequence = workflowSequence(workflow, lint)!;
    expect(sequence.steps.map(step => [step.nodeId, step.chainId, step.fundedBy])).toEqual([[workflow.nodes[0]!.nodeId, 'eip155:8453', null],
      [workflow.nodes[1]!.nodeId, 'eip155:8453', 0], [workflow.nodes[2]!.nodeId, 'eip155:1', 1]]);
    for (const step of sequence.steps) expect(() => lint(step.projection)).not.toThrow();
  });

  it('the pool step spends at most what the bridge delivered (0.98295 USDC), never more than the 1 USDC authored, and keeps its WETH', async () => {
    const workflow = reported(), { usdc, weth } = await ethereumPool();
    const { workflow: runtime, bound } = poolStep(workflow, completedBefore(workflow));
    expect(bound).toBe('982950');
    expect(runtime!.nodes).toHaveLength(1);
    const node = runtime!.nodes[0]!, fields = readConcentratedLiquidity(node as SemanticWorkflow['nodes'][number]);
    // Ethereum's own USDC and WETH (a token, never native ETH), on Ethereum Mainnet.
    expect(node.chainId).toBe('eip155:1');
    expect(fields.token0).toMatchObject({ chainId: 'eip155:1', address: usdc, decimals: 6 });
    expect(fields.token1).toMatchObject({ chainId: 'eip155:1', address: weth, decimals: 18 });
    expect(fields).toMatchObject({ amount0Max: '982950', amount1Max: '1000000000000000' });
    // A larger delivery never raises the authored maximum; an unproven delivery binds nothing (the step waits, nothing is simulated).
    expect(readConcentratedLiquidity(poolStep(workflow, completedBefore(workflow, '1200000')).workflow!.nodes[0]! as SemanticWorkflow['nodes'][number]).amount0Max).toBe('1000000');
    expect(poolStep(workflow, [completedBefore(workflow)[0]!, { ...completedBefore(workflow)[1]!, received: null }]).workflow).toBeNull();
  });

  it('the Ethereum liquidity service accepts the pool step alone and refuses the whole workflow exactly as production did', async () => {
    const workflow = reported(), { service } = await ethereumPool();
    await expect(service.simulate(workflow as unknown as SemanticWorkflow, UNI_OWNER)).rejects.toThrow('ROUTER_ISOLATED_ONLY');
    const { workflow: runtime } = poolStep(workflow, completedBefore(workflow));
    const run = await service.simulate(runtime as unknown as SemanticWorkflow, UNI_OWNER);
    // The reviewed deposit (and so its USDC approval) is bounded by what the bridge delivered, never the authored 1 USDC.
    expect(run.review).toMatchObject({ chainId: 1, intent: { amount0Max: '982950', amount1Max: '1000000000000000' } });
    expect(run.review.approvals.filter(approval => approval.step === 'APPROVE_TOKEN0').every(approval => BigInt(approval.amount) <= 982_950n)).toBe(true);
    expect(run.review.calls.map(call => call.step).at(-1)).toBe('MINT');
  });

  it('a real shortfall on Ethereum stays refused, each with its own actionable reason (never the generic text)', async () => {
    const workflow = reported(), { workflow: runtime } = poolStep(workflow, completedBefore(workflow));
    const generic = simulationError('NOT_A_KNOWN_CODE');
    const refusal = async (balances: { usdc?: bigint; weth?: bigint; eth?: bigint }) => {
      const { service } = await ethereumPool(balances);
      return service.simulate(runtime as unknown as SemanticWorkflow, UNI_OWNER).then(() => null, (cause: unknown) => (cause as Error).message);
    };
    // No WETH: the deposit's WETH is a token; it is never worded as the ETH network fee, and FloFi never wraps ETH for the owner.
    const noWeth = await refusal({ weth: 0n });
    expect(noWeth).toBe('UNISWAP_INSUFFICIENT_WETH');
    expect(simulationError(noWeth!)).toBe(LIQUIDITY_WETH_SHORTFALL_MESSAGE);
    expect(simulationError(noWeth!)).not.toMatch(/network fee/);
    // No ETH for the network fee on Ethereum.
    const noGas = await refusal({ eth: 0n });
    expect(noGas).toBe('UNISWAP_INSUFFICIENT_GAS_ETH');
    expect(simulationError(noGas!)).toBe('Add funds for the network fee, then simulate again.');
    // Less USDC on Ethereum than the bound deposit (the bridged USDC is not there): the balance reason.
    const noUsdc = await refusal({ usdc: 0n });
    expect(noUsdc).toBe('UNISWAP_INSUFFICIENT_USDC');
    expect(simulationError(noUsdc!)).toBe('Your available balance is too low for this workflow.');
    for (const code of [noWeth, noGas, noUsdc]) expect(simulationError(code!)).not.toBe(generic);
  });
});
