// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the public view of a USER_FUNDED run — what the owner sees, what a requester (MCP client, channel) sees
 * with and without shared status — passes the MCP output guard, and never gives a requester the owner's wallet, batch id or fee figures.
 */
import { describe, expect, it } from 'vitest';
import { assertSafeOutput } from '../mcp/simulation.ts';
import type { GroupRecord, RunRecord, RunStepRecord } from './pg-store.ts';
import { runView } from './service.ts';

const OWNER = '0x' + '1a'.repeat(20), HASH = '0x' + 'ab'.repeat(32), SOL_SIG = '5'.repeat(88);
const SWAP = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const run = { runId: 'wfr_' + 'a'.repeat(26), handoffId: 'apr_' + 'a'.repeat(26), mode: 'USER_FUNDED', state: 'RUNNING', stepCount: 3, currentStep: 2, code: null,
  strategy: { version: 2, steps: [SWAP, { ...SWAP, amount: '5' }, { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.01', recipient: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' }] },
  workflowHash: '0x' + '1'.repeat(64), completedAt: null, expiresAt: new Date('2026-11-08T00:00:00Z'), createdAt: new Date('2026-11-07T00:00:00Z'),
  updatedAt: new Date('2026-11-07T00:00:00Z') } as unknown as RunRecord;
const step = (stepIndex: number, state: string): RunStepRecord => ({ runId: run.runId, stepIndex, state, flow: null, strategy: null, workflowHash: '0x' + String(stepIndex).repeat(64),
  bound: stepIndex === 1 ? { amountFrom: 0, asset: { chainId: 'eip155:8453', address: '0x' + '42'.repeat(20), decimals: 6 }, cap: '5', received: '9', used: '5' } : null,
  claimedAt: null, outcome: null, code: null, version: 1, updatedAt: run.updatedAt } as unknown as RunStepRecord);
const group = (patch: Partial<GroupRecord>): GroupRecord => ({ runId: run.runId, groupIndex: 0, namespace: 'eip155', chain: 'eip155:8453', feePayer: OWNER, stepFrom: 0, stepTo: 1,
  strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', awaitsDelivery: null, state: 'RECONCILED', code: null, validUntil: null, version: 3,
  prepared: { kind: 'EVM_WALLET_BATCH', request: { id: '0x' + 'cd'.repeat(32) }, fee: { maxCost: '1000', unit: 'wei', estimated: true } },
  authorization: { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'cd'.repeat(32) }, submission: { hashes: [HASH] },
  outcome: { status: 'RECONCILED', transactions: [HASH], gasPaid: { amount: '900', unit: 'wei', payer: OWNER } }, ...patch } as unknown as GroupRecord);
const groups = [group({}), group({ groupIndex: 1, namespace: 'solana', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', feePayer: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  stepFrom: 2, stepTo: 2, strategy: 'SOLANA_SIGN_ALL', state: 'SUBMITTED', submission: { hashes: [SOL_SIG] }, outcome: null,
  authorization: { kind: 'SOLANA_SIGN_ALL', transactions: [] } })];
const store = { steps: async () => [step(0, 'RECONCILED'), step(1, 'RECONCILED'), step(2, 'DELEGATED')], groups: async () => groups };

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 user-funded run view', () => {
  it('passes the MCP output guard for the owner and for requesters, shared or not', async () => {
    for (const options of [{ outcomes: true, owner: true }, { outcomes: true }, { outcomes: false }]) {
      const view = await runView({ store }, run, options);
      expect(() => assertSafeOutput({ workflowRun: view })).not.toThrow();
    }
  });
  it('a requester never sees the owner\'s wallet, batch id or fees; shared status adds hashes and the gas amount only', async () => {
    const owner = await runView({ store }, run, { outcomes: true, owner: true });
    expect(owner.groups[0]).toMatchObject({ feePayer: OWNER, batchId: '0x' + 'cd'.repeat(32), maxFee: { amount: '1000' }, gasPaid: { payer: OWNER }, submissions: [{ hash: HASH }] });
    const shared = await runView({ store }, run, { outcomes: true });
    expect(shared.groups[0]).toMatchObject({ feePayer: 'OWNER_WALLET', batchId: null, maxFee: null, gasPaid: { amount: '900', payer: 'OWNER_WALLET' }, submissions: [{ hash: HASH }] });
    expect(JSON.stringify(shared)).not.toContain(OWNER.slice(2));
    const hidden = await runView({ store }, run, { outcomes: false });
    expect(hidden.groups[0]).toMatchObject({ feePayer: 'OWNER_WALLET', batchId: null, maxFee: null, gasPaid: null, submissions: [] });
    // A bound step's own hash encodes its resolved amount: withheld with the amounts.
    expect(hidden.steps.map(s => s.stepWorkflowHash)).toEqual(['0x' + '0'.repeat(64), null, '0x' + '2'.repeat(64)]);
  });
  it('a Solana group\'s signatures are listed only once reconciled (they are known before anything is sent)', async () => {
    const owner = await runView({ store }, run, { outcomes: true, owner: true });
    expect(owner.groups[1]!.submissions).toEqual([]);
  });
});
