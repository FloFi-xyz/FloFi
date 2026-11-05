// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD AAVE-V3-EXPANSION-001: completed sequence steps are restored after a refresh only when their own durable records prove them. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { setActiveNetworkScope } from './network-scope';
import { stepNodeKey, validCompletions, workflowSequence } from './workflow-sequence';
import { completedByRecord, proveCompletions, storedCompletions, type RecordReader, type StoredCompletion } from './sequence-restore';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence/intelligence.test-harness';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
function composed() {
  const s = new CopilotSession(); s.walletChainId = 'eip155:8453';
  s.say('Swap 100 USDC to WETH on Base and supply up to 0.05 of the resulting WETH on Aave', intent.composition([
    act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100' }), act.lending('SUPPLY', { network: 'BASE', asset: 'WETH', amount: '0.05' })]));
  s.apply();
  const sequence = workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!;
  const swapNode = s.workflow.nodes.find(node => node.nodeId === sequence.steps[0]!.nodeId)!;
  return { s, sequence, swapNode };
}
/** The public swap runtime's durable record, final and reconciled, for this workflow's swap node. */
const OWNER = '0x' + '4'.repeat(40);
const swapRecord = (workflowId: string, nodeId: string, received = '31000000000000000', extra: Record<string, unknown> = {}) => ({
  quote: { executionId: 'exec-0001', chainId: 8453, inputToken: USDC, outputToken: WETH }, workflow: { workflowId, nodes: [{ nodeId }] },
  outcome: { inputSpent: '100000000', outputReceived: received }, attempts: [{ account: OWNER.toUpperCase().replace('0X', '0x') }], ...extra });

describe('BUILD AAVE-V3-EXPANSION-001 sequence restoration after a refresh', () => {
  it('restores a completed swap from its own reconciled record, recomputing the delivered WETH that funds the Supply', async () => {
    const { s, sequence, swapNode } = composed();
    const stored: StoredCompletion[] = [{ nodeId: swapNode.nodeId, node: stepNodeKey(swapNode), kind: 'public', runKey: 'exec-0001', received: '31000000000000000' }];
    const reads: string[] = [];
    const read: RecordReader = async (kind, runKey) => { reads.push(`${kind}:${runKey}`); return swapRecord(s.workflow.workflowId, swapNode.nodeId); };
    const { proven, unreadable } = await proveCompletions(stored, s.workflow, sequence, read);
    expect([reads, unreadable]).toEqual([['public:exec-0001'], false]);
    expect(proven).toEqual([{ nodeId: swapNode.nodeId, node: stepNodeKey(swapNode), received: '31000000000000000', runKey: 'exec-0001', kind: 'public', owner: OWNER, allocations: [] }]);
    // The runtime then resumes at the Supply: the swap is never offered again.
    expect(validCompletions(sequence, s.workflow, proven)).toHaveLength(1);
  });
  it('never trusts the stored pointer: unreconciled, divergent, foreign, edited or amount-mismatched records restore nothing', async () => {
    const { s, sequence, swapNode } = composed();
    const pointer: StoredCompletion = { nodeId: swapNode.nodeId, node: stepNodeKey(swapNode), kind: 'public', runKey: 'exec-0001', received: '31000000000000000' };
    const prove = async (record: unknown, item = pointer) => (await proveCompletions([item], s.workflow, sequence, async () => record)).proven;
    // An unreadable record is reported as such (retry), never as "not done" and never as done.
    expect(await proveCompletions([pointer], s.workflow, sequence, async () => null)).toEqual({ proven: [], unreadable: true });
    expect(await prove(null)).toEqual([]);
    expect(await prove({ ...swapRecord(s.workflow.workflowId, swapNode.nodeId), outcome: null })).toEqual([]);
    expect(await prove(swapRecord(s.workflow.workflowId, swapNode.nodeId, '31000000000000000', { divergence: 'RECEIPT_MISMATCH' }))).toEqual([]);
    expect(await prove(swapRecord('another-workflow', swapNode.nodeId))).toEqual([]);
    expect(await prove(swapRecord(s.workflow.workflowId, 'node-999'))).toEqual([]);
    // The record proves a different delivery than the pointer claims: refused, never "corrected" silently.
    expect(await prove(swapRecord(s.workflow.workflowId, swapNode.nodeId, '99'))).toEqual([]);
    // A changed swap node no longer matches the pointer.
    expect(await prove(swapRecord(s.workflow.workflowId, swapNode.nodeId), { ...pointer, node: pointer.node.replace('100000000', '200000000') })).toEqual([]);
    // A reader failure restores nothing and asks for a retry.
    expect(await proveCompletions([pointer], s.workflow, sequence, async () => { throw new Error('SUPPLY_SERVICE_UNAVAILABLE'); })).toEqual({ proven: [], unreadable: true });
  });
  it('parses only well-formed pointers of restorable runtimes for the same workflow', () => {
    const item = { nodeId: 'node-002', node: '{}', kind: 'public', runKey: 'exec-0001', received: '1' };
    expect(storedCompletions({ workflowId: 'w', completed: [item] }, 'w')).toEqual([item]);
    expect(storedCompletions({ workflowId: 'other', completed: [item] }, 'w')).toEqual([]);
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, kind: 'router' }] }, 'w')).toEqual([]);
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, received: '-1' }] }, 'w')).toEqual([]);
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, runKey: 'x' }] }, 'w')).toEqual([]);
    expect(storedCompletions('garbage', 'w')).toEqual([]);
  });
  it('reads finality per runtime: a reconciled Aave run, never a pending one', () => {
    const supply = (verdict: string) => ({ verdict, review: { workflow: { workflowId: 'w', nodes: [{ nodeId: 'node-003' }] } } });
    expect(completedByRecord('supply', supply('RECONCILED'), 'w', 'node-003')).toBe(true);
    expect(completedByRecord('supply', supply('PENDING'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('supply', supply('DIVERGENT'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('router', supply('RECONCILED'), 'w', 'node-003')).toBe(false);
  });
});
