// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createReviewContext, lintWorkflow, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand } from './commands';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Workflow } from './initial-workflow';
import { boundAmount, boundProjection, deliveredByRecord, fundingAllocations, sequenceCursor, stepNodeKey, stepRuntimeWorkflow, validCompletions, workflowSequence, type CompletedStep } from './workflow-sequence';
import { readConcentratedLiquidity, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { amountsFromOwnerRecord } from '../workflow-runs/received-amounts';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', BASE_WETH = '0x4200000000000000000000000000000000000006';
function authorIn(on: ReviewContext, ...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, on, OWNER), on);
    expect(state.error).toBeNull();
  }
  return state.workflow;
}
const author = (...sentences: string[]) => authorIn(context, ...sentences);
const lint = (workflow: Workflow) => lintWorkflow(workflow, context);
const amountOf = (workflow: Workflow) => (workflow.nodes[0]!.userConstraints.find(c => c.kind === 'MAXIMUM_INPUT') as unknown as { quantity: { amount: string } }).quantity.amount;

describe('BUILD-FLOFI-CHAT-E2E-FIX-002 workflow sequence', () => {
  it('shares a producer delivery across consumers without spending the same funding twice', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', 'swap 0.004 WETH to USDC on Base slippage 100 bps',
      'swap 0.004 WETH to USDC on Base slippage 100 bps');
    const sequence = workflowSequence(workflow, lint)!;
    const completed: CompletedStep[] = [{ nodeId: 'node-002', node: '', received: '6000000000000000', runKey: 'producer' }];
    expect(boundAmount(sequence.steps[1]!, completed)).toBe('4000000000000000');
    completed.push({ nodeId: 'node-003', node: '', received: '1', runKey: 'consumer', allocations: fundingAllocations(sequence.steps[1]!, completed) });
    expect(boundAmount(sequence.steps[2]!, completed)).toBe('2000000000000000');
  });
  it('executes swap then liquidity through the existing isolated runtimes and binds only the received token maximum', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', 'add liquidity 5 USDC and 0.01 WETH on Base full range slippage 100 bps');
    const sequence = workflowSequence(workflow, lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    const step = sequence.steps[1]!;
    expect(step.funding).toMatchObject([{ fundedBy: 0, input: { address: BASE_WETH, amount: '10000000000000000' } }]);
    const before = readConcentratedLiquidity(step.projection.nodes[0]! as SemanticWorkflow['nodes'][number]);
    const projected = boundProjection(step, '4000000000000000', context)!;
    const after = readConcentratedLiquidity(projected.nodes[0]! as SemanticWorkflow['nodes'][number]);
    expect(after).toEqual({ ...before, amount0Max: '4000000000000000' });
    expect(() => lint(projected)).not.toThrow();
    expect(boundProjection(step, '0', context)).toBeNull();
    expect(boundProjection(step, null, context)).toBeNull();
  });

  it('resolves both position deposits from their own reconciled producers', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', 'swap 0.001 ETH to USDC on Base slippage 100 bps', 'add liquidity 5 USDC and 0.01 WETH on Base full range slippage 100 bps');
    const step = workflowSequence(workflow, lint)!.steps[2]!;
    expect(step.funding).toHaveLength(2);
    const completed: CompletedStep[] = [{ nodeId: 'node-002', node: '', received: '4000000000000000', runKey: 'first' },
      { nodeId: 'node-003', node: '', received: '3000000', runKey: 'second' }];
    const projected = boundProjection(step, null, context, completed)!;
    expect(readConcentratedLiquidity(projected.nodes[0]! as SemanticWorkflow['nodes'][number])).toMatchObject({ amount0Max: '4000000000000000', amount1Max: '3000000' });
    expect(boundProjection(step, null, context, [{ ...completed[0]!, received: null }, completed[1]!])).toBeNull();
  });

  it('binds native SOL from a universal bridge into Orca wrapped-mint deposit semantics', () => {
    const workflow = author('bridge 10 USDC from Base to Solana receive SOL via best slippage 100 bps',
      'add liquidity 0.1 SOL and 5 USDC ticks -64 to 64 on Solana slippage 100 bps');
    const sequence = workflowSequence(workflow, lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    expect(sequence.steps[1]!.funding).toMatchObject([{ input: { address: null, decimals: 9 }, fundedBy: 0 }]);
    const projected = boundProjection(sequence.steps[1]!, '50000000', context)!;
    expect(readConcentratedLiquidity(projected.nodes[0]! as SemanticWorkflow['nodes'][number])).toMatchObject({ amount0Max: '50000000', amount1Max: '5000000' });
  });

  it('withdrawn and borrowed assets can fund a later swap', () => {
    for (const sentence of ['withdraw 5 USDC from Aave on Base', 'borrow 5 USDC from Aave on Base']) {
      const workflow = author(sentence, 'swap 5 USDC to WETH on Base slippage 100 bps');
      expect(workflowSequence(workflow, lint)?.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    }
  });
  it('reproduces the production failure: Swap + Bridge is refused as one workflow by every runtime', () => {
    expect(() => lint(author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 5 USDC from Base to Arbitrum'))).toThrow('ROUTER_ISOLATED_ONLY');
    expect(() => lint(author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum'))).toThrow('UNIVERSAL_ISOLATED_ONLY');
  });

  it('orders every canonical action and projects each one alone, unchanged, for its own runtime', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum');
    const sequence = workflowSequence(workflow, lint)!;
    expect(sequence.steps.map(step => [step.index, step.nodeId, step.chainId])).toEqual([[0, 'node-002', 'eip155:8453'], [1, 'node-003', 'eip155:8453']]);
    for (const step of sequence.steps) {
      expect(step.projection.nodes).toHaveLength(1);
      expect(step.projection.workflowId).toBe(workflow.workflowId);
      expect(step.projection.revision).toBe(workflow.revision);
      expect({ ...step.projection.nodes[0], dependencies: [] }).toEqual({ ...workflow.nodes.find(n => n.nodeId === step.nodeId), dependencies: [] });
      expect(() => lint(step.projection)).not.toThrow();
    }
  });

  it('a bridge of the swap output is funded by the swap; a bridge of another asset is independent', () => {
    const dependent = workflowSequence(author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum'), lint)!;
    expect(dependent.steps[0]).toMatchObject({ fundedBy: null, input: { chainId: 'eip155:8453', address: BASE_USDC, decimals: 6, amount: '10000000' },
      output: { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 }, ownerReceives: true });
    expect(dependent.steps[1]).toMatchObject({ fundedBy: 0, input: { address: BASE_WETH, amount: '1000000000000000' }, output: { chainId: 'eip155:42161' } });
    const independent = workflowSequence(author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 5 USDC from Base to Arbitrum'), lint)!;
    expect(independent.steps.map(step => step.fundedBy)).toEqual([null, null]);
  });

  it('is not a sequence for one action, or for a workflow a composition runtime executes as a whole', () => {
    expect(workflowSequence(author('swap 10 USDC to WETH on Base slippage 100 bps'), lint)).toBeNull();
    const lending = author(`compose supply 10 USDC to Aave then borrow 2 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner ${OWNER}`);
    expect(() => lint(lending)).not.toThrow();
    expect(workflowSequence(lending, lint)).toBeNull();
  });
  it('two independent swaps that lint together are still a sequence: no runtime serves them as one route', () => {
    const sepolia = createBaseSepoliaReviewContext(), lintSepolia = (workflow: Workflow) => lintWorkflow(workflow, sepolia);
    const swaps = authorIn(sepolia, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
    expect(() => lintSepolia(swaps)).not.toThrow();
    expect(workflowSequence(swaps, lintSepolia)?.steps.map(step => [step.nodeId, step.fundedBy])).toEqual([['node-002', null], ['node-003', null]]);
    const funded = authorIn(sepolia, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'swap 0.0001 WETH to USDC on Base Sepolia slippage 50 bps');
    expect(workflowSequence(funded, lintSepolia)?.steps.map(step => step.fundedBy)).toEqual([null, 0]);
  });

  it('a funded step spends min(authored, delivered), re-authored through its own card command', () => {
    const sequence = workflowSequence(author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum'), lint)!;
    const bridge = sequence.steps[1]!, done = (received: string | null): CompletedStep[] => [{ nodeId: 'node-002', node: '', received, runKey: 'bas-1' }];
    expect(boundAmount(bridge, done('400000000000000'))).toBe('400000000000000');
    expect(boundAmount(bridge, done('5000000000000000'))).toBe('1000000000000000');
    expect(boundAmount(bridge, done(null))).toBeNull();
    expect(boundAmount(sequence.steps[0]!, done('1'))).toBeNull();
    const bound = boundProjection(bridge, '400000000000000', context)!;
    expect(amountOf(bound)).toBe('400000000000000');
    expect(bound.nodes).toHaveLength(1);
    expect(bound.nodes[0]!.nodeId).toBe('node-003');
    expect(() => lint(bound)).not.toThrow();
    expect(boundProjection(bridge, '1000000000000000', context)).toBe(bridge.projection);
    expect(boundProjection(bridge, '0', context)).toBeNull();
  });

  it('keeps the history of executed steps only while they still describe the workflow', () => {
    const workflow = author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum');
    const sequence = workflowSequence(workflow, lint)!;
    const done: CompletedStep[] = [{ nodeId: 'node-002', node: stepNodeKey(workflow.nodes[0]!), received: '1', runKey: 'bas-1' }];
    expect(validCompletions(sequence, workflow, done)).toEqual(done);
    expect(validCompletions(sequence, workflow, [{ ...done[0]!, node: '{}' }])).toEqual([]);
    expect(validCompletions(null, workflow, done)).toEqual([]);
  });

  it('BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: an executed one-action workflow stays its completed first step when the owner adds an action', () => {
    const single = author('swap 10 USDC to WETH on Base slippage 100 bps');
    expect(workflowSequence(single, lint)).toBeNull();
    // What the store records once the single action's own run is final and reconciled (`recordExecutedAction`).
    const executed: CompletedStep[] = [{ nodeId: single.nodes[0]!.nodeId, node: stepNodeKey(single.nodes[0]!), received: '420', runKey: 'pub-1', allocations: [] }];
    const extended = author('swap 10 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum');
    const sequence = workflowSequence(extended, lint)!;
    expect(sequence.steps.map(step => step.nodeId)).toEqual([single.nodes[0]!.nodeId, extended.nodes[1]!.nodeId]);
    // The executed swap is carried as step 1 (never reviewed or sent again); the bridge is the next step, funded by what the swap delivered.
    expect(validCompletions(sequence, extended, executed)).toEqual(executed);
    expect(boundAmount(sequence.steps[1]!, executed)).toBe('420');
    // Changing the executed action itself starts over: the changed action is a new action to review.
    const changed = author('swap 12 USDC to WETH on Base slippage 100 bps', 'bridge 0.001 WETH from Base to Arbitrum');
    expect(validCompletions(workflowSequence(changed, lint), changed, executed)).toEqual([]);
  });

  it('reads only reconciled deliveries of exactly the funded asset', () => {
    const weth = { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 };
    const swap = { quote: { chainId: 8453, outputToken: BASE_WETH }, outcome: { outputReceived: '420' } };
    expect(deliveredByRecord('public', swap, weth)).toBe('420');
    expect(deliveredByRecord('public', { ...swap, outcome: null }, weth)).toBeNull();
    expect(deliveredByRecord('public', { ...swap, quote: { chainId: 8453, outputToken: BASE_USDC } }, weth)).toBeNull();
    const arbWeth = { chainId: 'eip155:42161', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 };
    const universal = { verdict: 'RECONCILED', received: '77', review: { route: { outputToken: { chainId: 'eip155:42161', kind: 'TOKEN', address: arbWeth.address } } } };
    expect(deliveredByRecord('universal', universal, arbWeth)).toBe('77');
    expect(deliveredByRecord('universal', { ...universal, verdict: 'PENDING' }, arbWeth)).toBeNull();
    const native = { verdict: 'RECONCILED', received: '9', review: { route: { outputToken: { chainId: 'eip155:42161', kind: 'NATIVE', address: null } } } };
    expect(deliveredByRecord('universal', native, { chainId: 'eip155:42161', address: null, decimals: 18 })).toBe('9');
    expect(deliveredByRecord('universal', native, arbWeth)).toBeNull();
  });

  it('extracts live service record delivery contracts for both web and durable workflow runs', () => {
    const evm = { quote: { chainId: 8453, outputToken: BASE_WETH, inputToken: BASE_USDC }, outcome: { outputReceived: '420', inputSpent: '100' } };
    expect(amountsFromOwnerRecord(evm)).toEqual({ received: [{ asset: `eip155:8453/erc20:${BASE_WETH}`, amount: '420' }], spent: [{ asset: `eip155:8453/erc20:${BASE_USDC}`, amount: '100' }] });
    expect(amountsFromOwnerRecord({ ...evm, quote: { ...evm.quote, outputToken: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' } })).toMatchObject({
      received: [{ asset: 'eip155:8453/native:ETH', amount: '420' }] });
    const sol = { chainId: 'solana:mainnet', address: 'MixedCaseTokenMint', decimals: 6 };
    const record = { verdict: 'RECONCILED', review: { chain: sol.chainId, input: { mint: 'MixedCaseInputMint' }, output: { mint: sol.address, decimals: 6 } },
      observations: [{ verdict: 'RECONCILED', outputReceived: '350', inputSpent: '100' }] };
    expect(deliveredByRecord('solana-swap', record, sol)).toBe('350');
    expect(deliveredByRecord('solana-swap', record, { ...sol, address: sol.address.toLowerCase() })).toBeNull();
    expect(amountsFromOwnerRecord(record)).toMatchObject({ received: [{ asset: `${sol.chainId}/token:${sol.address}`, amount: '350' }] });
    const aave = { verdict: 'RECONCILED', review: { chain: 'eip155:8453', asset: BASE_USDC, withdraw: {} }, observations: [{ verdict: 'RECONCILED', walletDelta: '5000000' }] };
    expect(deliveredByRecord('supply', aave, { chainId: 'eip155:8453', address: BASE_USDC, decimals: 6 })).toBe('5000000');
    expect(amountsFromOwnerRecord(aave)).toMatchObject({ received: [{ asset: `eip155:8453/erc20:${BASE_USDC}`, amount: '5000000' }] });
    expect(deliveredByRecord('supply', { ...aave, verdict: 'PENDING' }, { chainId: 'eip155:8453', address: BASE_USDC, decimals: 6 })).toBeNull();
  });
});

describe('BUILD-FLOFI-CHAT-E2E-FIX-002 ETH and WETH stay distinct in chat authoring', () => {
  it('BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a native-ETH swap on a catalog mainnet is native ETH (nativeId), never WETH; test networks still refuse it', () => {
    const sepolia = createBaseSepoliaReviewContext();
    const nativeIn = authorIn(context, 'swap 0.01 ETH to USDC on Base slippage 100 bps').nodes.at(-1)!;
    expect(nativeIn.inputs.find(input => input.name === 'amount-in')?.value).toMatchObject({ asset: { chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 } });
    const nativeOut = authorIn(context, 'swap 10 USDC to ETH on Base').nodes.at(-1)!;
    expect(nativeOut.inputs.find(input => input.name === 'asset-out')?.value).toEqual({ chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 });
    const wrap = authorIn(context, 'wrap 0.01 ETH to WETH on Base').nodes.at(-1)!;
    expect(wrap.adapterConstraints.protocols).toEqual(['weth9']);
    expect(authorIn(context, 'unwrap 0.01 WETH on Base').nodes.at(-1)!.inputs.find(input => input.name === 'asset-out')?.value).toMatchObject({ nativeId: 'ETH' });
    expect(() => parseLocalCommand('wrap 0.01 ETH to WETH', initialEditor().workflow, context, OWNER)).toThrow('WRAP_NETWORK_REQUIRED');
    expect(() => parseLocalCommand('swap ETH to USDC on Ethereum', initialEditor().workflow, context, OWNER)).toThrow('SWAP_AMOUNT_REQUIRED');
    expect(() => parseLocalCommand('unwrap 0.01 ETH on Base', initialEditor().workflow, context, OWNER)).toThrow('INVALID_ASSET_PAIR');
    for (const sentence of ['swap 0.01 ETH to USDC on Base Sepolia slippage 50 bps', 'swap 1 USDC for eth on Ethereum Sepolia slippage 50 bps'])
      expect(() => parseLocalCommand(sentence, initialEditor().workflow, sepolia, OWNER), sentence).toThrow('SWAP_NATIVE_ASSET_UNSUPPORTED');
    const weth = authorIn(sepolia, 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps');
    expect(weth.nodes[0]!.inputs.find(input => input.name === 'asset-out')?.value).toMatchObject({ address: '0x4200000000000000000000000000000000000006' });
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 native ETH steps in sequences', () => {
  const NATIVE = { chainId: 'eip155:8453', address: null, decimals: 18 };
  it('Swap ETH → USDC then Bridge USDC: the bridge is funded by the swap\'s reconciled USDC', () => {
    const sequence = workflowSequence(author('swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 5 USDC from Base to Arbitrum'), lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    expect(sequence.steps[0]).toMatchObject({ input: { ...NATIVE, amount: '1000000000000000' }, output: { chainId: 'eip155:8453', address: BASE_USDC, decimals: 6 } });
    expect(() => lint(sequence.steps[0]!.projection)).not.toThrow();
  });
  it('Bridge USDC then Swap USDC → ETH on the destination: a native-ETH output step', () => {
    const sequence = workflowSequence(author('bridge 5 USDC from Arbitrum to Base', 'swap 5 USDC to ETH on Base slippage 100 bps'), lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    expect(sequence.steps[1]!.output).toEqual(NATIVE);
  });
  it('Wrap ETH → WETH then Swap WETH → USDC: the swap spends what the wrap delivered (WETH, never native ETH)', () => {
    const sequence = workflowSequence(author('wrap 0.01 ETH to WETH on Base', 'swap 0.01 WETH to USDC on Base slippage 100 bps'), lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    expect(sequence.steps[0]).toMatchObject({ input: { ...NATIVE, amount: '10000000000000000' }, output: { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 } });
  });
  it('a native-ETH delivery funds only a native-ETH input, and a WETH delivery never does', () => {
    const record = (outputToken: string) => ({ quote: { chainId: 8453, outputToken }, outcome: { outputReceived: '2140000000000000' } });
    expect(deliveredByRecord('public', record('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), NATIVE)).toBe('2140000000000000');
    expect(deliveredByRecord('public', record(BASE_WETH), NATIVE)).toBeNull();
    expect(deliveredByRecord('public', record('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), { chainId: 'eip155:8453', address: BASE_WETH, decimals: 18 })).toBeNull();
  });
});

describe('P0 hotfix (execution continuity): a finished sequence keeps its last step exactly as it executed', () => {
  it('production 2026-11-12: Swap → Bridge (≤ 2 USDC) completed; the bridge is never re-authored with the remainder after completion', () => {
    // Swap 0.001 ETH → USDC delivered 2.5 USDC; the bridge (cap 2 USDC) executed with 2 USDC. Before the hotfix the finished sequence recomputed the
    // bridge's bound as delivered − its own allocation (0.5 USDC), re-authored the bridge, retired its reconciled record ("Review required again").
    const workflow = author('swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    const sequence = workflowSequence(workflow, lint)!, [swap, bridge] = sequence.steps as [typeof sequence.steps[0], typeof sequence.steps[0]];
    const node = (index: number) => stepNodeKey(workflow.nodes.find(item => item.nodeId === sequence.steps[index]!.nodeId)!);
    const afterSwap: CompletedStep[] = [{ nodeId: swap.nodeId, node: node(0), received: '2500000', runKey: 'arbsw-1', kind: 'public', allocations: [] }];
    // Step 2 runs with min(cap, delivered) = 2 USDC: its own projection, unchanged.
    const running = sequenceCursor(sequence, afterSwap);
    expect(running).toMatchObject({ cursor: 1, finished: false });
    const executed = stepRuntimeWorkflow(bridge, running.before, context);
    expect(executed.bound).toBe('2000000');
    expect(executed.workflow).toBe(bridge.projection);
    // The bridge reconciled: both steps completed, the bridge reserved 2 USDC of the swap's delivery.
    const finished = [...afterSwap, { nodeId: bridge.nodeId, node: node(1), received: '1990000', runKey: 'xroute-1', kind: 'router', allocations: fundingAllocations(bridge, afterSwap) }];
    expect(finished[1]!.allocations).toEqual([{ fundedBy: 0, input: bridge.funding[0]!.input, used: '2000000' }]);
    const done = sequenceCursor(sequence, finished);
    expect(done).toMatchObject({ cursor: 1, finished: true });
    expect(done.before).toEqual(afterSwap);
    // The last step's runtime workflow is exactly the one it executed (so its record keeps matching), never the 0.5 USDC remainder.
    const after = stepRuntimeWorkflow(bridge, done.before, context);
    expect(after).toEqual(executed);
    expect(amountOf(after.workflow!)).toBe('2000000');
    // What the old computation produced (kept here as the regression's evidence): the remainder over ALL completions, re-authored.
    expect(boundAmount(bridge, finished)).toBe('500000');
    expect(amountOf(boundProjection(bridge, '500000', context)!)).toBe('500000');
  });
  it('a bridge that spent less than its cap after a smaller delivery keeps that bound once finished', () => {
    const workflow = author('swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum');
    const sequence = workflowSequence(workflow, lint)!, bridge = sequence.steps[1]!;
    const afterSwap: CompletedStep[] = [{ nodeId: sequence.steps[0]!.nodeId, node: '', received: '1500000', runKey: 'arbsw-2', kind: 'public', allocations: [] }];
    const executed = stepRuntimeWorkflow(bridge, sequenceCursor(sequence, afterSwap).before, context);
    expect(executed.bound).toBe('1500000');
    const finished = [...afterSwap, { nodeId: bridge.nodeId, node: '', received: '1490000', runKey: 'xroute-2', allocations: fundingAllocations(bridge, afterSwap) }];
    const after = stepRuntimeWorkflow(bridge, sequenceCursor(sequence, finished).before, context);
    expect(after.bound).toBe('1500000');
    expect(JSON.stringify(after.workflow)).toBe(JSON.stringify(executed.workflow));
    // Over all completions nothing would be left, and the old path refused the bound outright (fundingIssue BOUND_REFUSED / no runtime workflow).
    expect(boundAmount(bridge, finished)).toBe('0');
  });
  it('an empty or partial history never moves the cursor past the first step not completed', () => {
    const sequence = workflowSequence(author('swap 0.001 ETH to USDC on Base slippage 100 bps', 'bridge 2 USDC from Base to Arbitrum'), lint)!;
    expect(sequenceCursor(sequence, [])).toEqual({ cursor: 0, finished: false, before: [] });
  });
});
