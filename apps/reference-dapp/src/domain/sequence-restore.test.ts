// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD AAVE-V3-EXPANSION-001: completed sequence steps are restored after a refresh only when their own durable records prove them. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { setActiveNetworkScope } from './network-scope';
import { stepNodeKey, validCompletions, workflowSequence } from './workflow-sequence';
import { completedByRecord, ownerByRecord, proveCompletions, storedCompletions, type RecordReader, type StoredCompletion } from './sequence-restore';
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
    // P0 hotfix (execution continuity): the certified Router's pointer is restorable now (the bridge of Swap → Bridge is re-proven after a
    // reload instead of being dropped, which offered the executed bridge again); a runtime with no run-id reader still is not.
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, kind: 'router', runKey: 'xroute-' + 'a'.repeat(32) }] }, 'w')).toEqual([{ ...item, kind: 'router', runKey: 'xroute-' + 'a'.repeat(32) }]);
    // P0 hotfix (FIX 2): the universal Router's pointer is restorable too; a runtime with no run-id reader still is not.
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, kind: 'universal' }] }, 'w')).toEqual([{ ...item, kind: 'universal' }]);
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, kind: 'uniswap-pool' }] }, 'w')).toEqual([]);
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, received: '-1' }] }, 'w')).toEqual([]);
    expect(storedCompletions({ workflowId: 'w', completed: [{ ...item, runKey: 'x' }] }, 'w')).toEqual([]);
    expect(storedCompletions('garbage', 'w')).toEqual([]);
  });
  it('reads finality per runtime: a reconciled Aave run, never a pending one', () => {
    const supply = (verdict: string) => ({ verdict, review: { workflow: { workflowId: 'w', nodes: [{ nodeId: 'node-003' }] } } });
    expect(completedByRecord('supply', supply('RECONCILED'), 'w', 'node-003')).toBe(true);
    expect(completedByRecord('supply', supply('PENDING'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('supply', supply('DIVERGENT'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('uniswap-pool', supply('RECONCILED'), 'w', 'node-003')).toBe(false);
  });
  it('P0 hotfix: a Router bridge counts again only from its own reconciled record (its owner read from that record)', () => {
    const bridge = (verdict: string, workflowId = 'w') => ({ verdict, owner: OWNER, workflow: { workflowId, nodes: [{ nodeId: 'node-003' }] } });
    expect(completedByRecord('router', bridge('RECONCILED'), 'w', 'node-003')).toBe(true);
    expect(completedByRecord('router', bridge('PENDING'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('router', bridge('REFUNDED'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('router', bridge('RECONCILED', 'other'), 'w', 'node-003')).toBe(false);
    expect(completedByRecord('router', bridge('RECONCILED'), 'w', 'node-009')).toBe(false);
    expect(ownerByRecord('router', bridge('RECONCILED'))).toBe(OWNER);
  });
  it('P0 FIX 2: a universal bridge (Swap USDC → WETH, then Bridge WETH Base → Arbitrum One) is re-proven after a reload, never offered again', async () => {
    const s = new CopilotSession(); s.walletChainId = 'eip155:8453';
    s.say('swap 2 USDC to WETH on Base then bridge 0.0003 WETH from Base to Arbitrum', intent.composition([
      act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH', amount: '2' }),
      act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'WETH', amount: '0.0003', routing: 'BEST' })]));
    s.apply();
    const sequence = workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
    const [swapStep, bridgeStep] = sequence.steps, swapNode = s.workflow.nodes.find(node => node.nodeId === swapStep!.nodeId)!;
    const bridgeNode = s.workflow.nodes.find(node => node.nodeId === bridgeStep!.nodeId)!;
    const universal = (verdict: string, extra: Record<string, unknown> = {}) => ({ format: 'flofi.universal-bridge-run.v1', verdict, owner: OWNER,
      workflow: { workflowId: s.workflow.workflowId, nodes: [{ nodeId: bridgeNode.nodeId }] }, received: '299000000000000',
      review: { route: { sourceChain: 'eip155:8453', destinationChain: 'eip155:42161',
        outputToken: { chainId: 'eip155:42161', kind: 'TOKEN', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 } } }, ...extra });
    const stored: StoredCompletion[] = [
      { nodeId: swapNode.nodeId, node: stepNodeKey(swapNode), kind: 'public', runKey: 'exec-0001', received: '600000000000000' },
      { nodeId: bridgeNode.nodeId, node: stepNodeKey(bridgeNode), kind: 'universal', runKey: 'xuni-' + 'a'.repeat(32), received: null }];
    const reads: string[] = [];
    const read = (bridge: unknown): RecordReader => async (kind, runKey, sourceChain) => { reads.push(`${kind}:${runKey}:${sourceChain}`);
      return kind === 'public' ? swapRecord(s.workflow.workflowId, swapNode.nodeId, '600000000000000', { quote: { executionId: 'exec-0001', chainId: 8453, inputToken: USDC, outputToken: WETH },
        outcome: { inputSpent: '2000000', outputReceived: '600000000000000' } }) : bridge; };
    const both = await proveCompletions(stored, s.workflow, sequence, read(universal('RECONCILED')));
    // Each record is read with its step's source chain (the universal reader asks as that ecosystem's wallet only).
    expect(reads).toEqual(['public:exec-0001:eip155:8453', 'universal:xuni-' + 'a'.repeat(32) + ':eip155:8453']);
    expect(both.unreadable).toBe(false);
    expect(both.proven.map(step => [step.kind, step.owner])).toEqual([['public', OWNER], ['universal', OWNER]]);
    // Both proven: the workflow is finished after the reload; the bridge is never current again.
    expect(validCompletions(sequence, s.workflow, both.proven)).toHaveLength(2);
    // A bridge that is not reconciled (pending, refunded, divergent) or not this workflow's stays withheld; the swap alone is restored.
    for (const record of [universal('PENDING'), universal('REFUNDED'), universal('DIVERGENT'), universal('RECONCILED', { workflow: { workflowId: 'other', nodes: [{ nodeId: bridgeNode.nodeId }] } })])
      expect((await proveCompletions(stored, s.workflow, sequence, read(record))).proven.map(step => step.kind)).toEqual(['public']);
    // A bridge record that cannot be read is reported as unreadable (retry), never as a new step.
    expect(await proveCompletions(stored, s.workflow, sequence, read(null))).toMatchObject({ unreadable: true, proven: [{ kind: 'public' }] });
    expect(ownerByRecord('universal', universal('RECONCILED'))).toBe(OWNER);
    // Across ecosystems the source wallet is not the one that received (flofi-workflow review): no owner is named.
    expect(ownerByRecord('universal', universal('RECONCILED', { review: { route: { sourceChain: 'eip155:8453', destinationChain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } } }))).toBeNull();
  });
});
