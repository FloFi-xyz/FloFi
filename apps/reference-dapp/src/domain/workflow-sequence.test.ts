// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createReviewContext, lintWorkflow, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand } from './commands';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Workflow } from './initial-workflow';
import { boundAmount, boundProjection, deliveredByRecord, stepNodeKey, validCompletions, workflowSequence, type CompletedStep } from './workflow-sequence';

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
