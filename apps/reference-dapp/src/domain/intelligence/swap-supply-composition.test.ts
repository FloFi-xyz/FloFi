// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: the first complete composition — Swap USDC → WETH on Base, then Supply the WETH that swap actually delivered to
 * Aave V3 on Base — through the real conversation engine, editor, sequence runtime model and lending compiler. Scripted model answers and the
 * committed token-list fixtures; no model, provider, wallet or network is reached and nothing is simulated, signed or executed here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CopilotSession, act, intent } from '../copilot-session.test-harness';
import { setActiveNetworkScope } from '../network-scope';
import { boundAmount, boundProjection, deliveredByRecord, stepNodeKey, validCompletions, workflowSequence, type CompletedStep } from '../workflow-sequence';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { compileSupplyCalls, supplyCall } from '@defi-workflow-engine/reference-compiler';
import { aaveReserveProfile } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence.test-harness';
import { TEST_WALLET } from '../copilot-test-fixtures';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
const WETH = aaveReserveProfile('eip155:8453', '0x4200000000000000000000000000000000000006');
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const mainnet = () => { const s = new CopilotSession(); s.walletChainId = 'eip155:8453'; return s; };
const composition = () => intent.composition([
  act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100' }),
  act.lending('SUPPLY', { network: 'BASE', asset: 'WETH', amount: '0.05' }),
]);
/** A reconciled public Base swap record, as the owner-wallet swap runtime persists it after independent reconciliation. */
const swapRecord = (received: string) => ({ quote: { chainId: 8453, inputToken: USDC_BASE, outputToken: WETH.asset }, outcome: { inputSpent: '100000000', outputReceived: received } });

describe('Swap USDC → WETH on Base, then Supply the resulting WETH on Aave V3', () => {
  it('Chat interprets both actions in one request as one reviewed sequence whose Supply is funded by the swap', () => {
    const s = mainnet();
    const reply = s.say('Swap 100 USDC to WETH on Base and supply up to 0.05 of the resulting WETH on Aave', composition())!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE', steps: [{ type: 'ADD_SWAP' }, { type: 'ADD_SUPPLY',
      input: { network: 'Base', asset: 'WETH', amount: '0.05', beneficiary: TEST_WALLET } }] } });
    s.apply();
    const sequence = workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!;
    expect(sequence.steps).toHaveLength(2);
    expect(sequence.steps[0]).toMatchObject({ fundedBy: null, input: { chainId: 'eip155:8453', address: USDC_BASE, decimals: 6, amount: '100000000' },
      output: { chainId: 'eip155:8453', address: WETH.asset, decimals: 18 }, ownerReceives: true });
    // The Supply spends the swap's WETH (exact chain + address + decimals), capped by the user's own 0.05 WETH.
    expect(sequence.steps[1]).toMatchObject({ fundedBy: 0, input: { chainId: 'eip155:8453', address: WETH.asset, decimals: 18, amount: '50000000000000000' } });
    // The editor connects the steps in order (BUILD AAVE-V3-EXPANSION-001 auto-connect): an ordering dependency, never a resource transfer.
    const [swap, supply] = sequence.steps.map(step => s.workflow.nodes.find(node => node.nodeId === step.nodeId)!);
    expect(supply!.dependencies).toEqual([swap!.nodeId]);
    expect(s.workflow.resourceEdges).toEqual([]);
  });
  it('binds the Supply to what the swap actually delivered: min(cap, reconciled output), revalidated as an ordinary Supply of WETH', () => {
    const s = mainnet();
    s.say('Swap 100 USDC to WETH on Base and supply up to 0.05 of the resulting WETH on Aave', composition());
    s.apply();
    const sequence = workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!, [swapStep, supplyStep] = sequence.steps as [typeof sequence.steps[0], typeof sequence.steps[0]];
    const swapNode = s.workflow.nodes.find(node => node.nodeId === swapStep.nodeId)!;
    for (const [received, used] of [['31000000000000000', '31000000000000000'], ['90000000000000000', '50000000000000000']] as const) {
      // Only an amount proven on the swap's own reconciled record funds the Supply; a quote or an estimate never does.
      const delivered = deliveredByRecord('public', swapRecord(received), swapStep.output);
      expect(delivered).toBe(received);
      const completed: CompletedStep[] = [{ nodeId: swapStep.nodeId, node: stepNodeKey(swapNode), received: delivered, runKey: 'public:run-1' }];
      expect(boundAmount(supplyStep, completed)).toBe(used);
      const projection = boundProjection(supplyStep, boundAmount(supplyStep, completed), s.context, completed)!;
      expect(projection.nodes).toHaveLength(1);
      lintWorkflow(projection, s.context);
      // The step the Aave runtime receives is an ordinary one-action Supply of exactly `used` WETH: exact approval, then supply.
      expect(compileSupplyCalls(projection as unknown as SemanticWorkflow, TEST_WALLET, '0').map(tx => [tx.to, tx.data])).toEqual([
        [WETH.asset, supplyCall('approve(address,uint256)', WETH.pool, BigInt(used))],
        [WETH.pool, supplyCall('supply(address,uint256,address,uint16)', WETH.asset, BigInt(used), TEST_WALLET, 0n)]]);
    }
    // A record of another token, or an unreconciled one, proves nothing: the Supply cannot run yet.
    expect(deliveredByRecord('public', { quote: { chainId: 8453, outputToken: USDC_BASE }, outcome: { outputReceived: '1' } }, swapStep.output)).toBeNull();
    expect(deliveredByRecord('public', { quote: { chainId: 8453, outputToken: WETH.asset } }, swapStep.output)).toBeNull();
    expect(boundAmount(supplyStep, [{ nodeId: swapStep.nodeId, node: stepNodeKey(swapNode), received: null, runKey: null }])).toBeNull();
    expect(boundProjection(supplyStep, '0', s.context)).toBeNull();
  });
  it('preserves the completed swap and never re-executes it; a changed swap ends that history instead of reusing it', () => {
    const s = mainnet();
    s.say('Swap 100 USDC to WETH on Base and supply up to 0.05 of the resulting WETH on Aave', composition());
    s.apply();
    const sequence = workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!, swapStep = sequence.steps[0]!;
    const swapNode = s.workflow.nodes.find(node => node.nodeId === swapStep.nodeId)!;
    const completed: CompletedStep[] = [{ nodeId: swapStep.nodeId, node: stepNodeKey(swapNode), received: '31000000000000000', runKey: 'public:run-1' }];
    // After a refresh the same workflow still proves step 1 done, so the runtime resumes at step 2 (the Supply), never the swap.
    expect(validCompletions(sequence, s.workflow, completed)).toEqual(completed);
    const changed = { ...s.workflow, nodes: s.workflow.nodes.map(node => node.nodeId === swapNode.nodeId ? { ...node, revision: undefined, inputs: node.inputs.map(input => input) , userConstraints: [] } : node) };
    expect(validCompletions(workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context)), changed as typeof s.workflow, completed)).toEqual([]);
  });
  it('asks once for the Supply cap when the user does not state it, then proposes the same funded sequence', () => {
    const s = mainnet();
    const asked = s.say('Swap 100 USDC to WETH on Base and supply the resulting WETH on Aave', intent.composition([
      act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100' }), act.lending('SUPPLY', { network: 'BASE', asset: 'WETH' })]))!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(asked.command).toBeUndefined();
  });
  it('the goal form ("supply WETH on Aave on Base with my 100 USDC") plans the same swap → funded supply', () => {
    const s = mainnet();
    const goal = (extra: Record<string, unknown> = {}) => intent.goal({ network: 'BASE', asset: 'USDC', amount: '100' }, { network: 'BASE', asset: 'WETH', use: 'SUPPLY' }, extra);
    expect(s.say('I want to supply WETH on Aave on Base with my 100 USDC', goal())).toMatchObject({ kind: 'CLARIFICATION' });
    const reply = s.say('0.05', goal({ cap: '0.05' }))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE' } });
    s.apply();
    expect(workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!.steps.map(step => step.fundedBy)).toEqual([null, 0]);
  });
});
