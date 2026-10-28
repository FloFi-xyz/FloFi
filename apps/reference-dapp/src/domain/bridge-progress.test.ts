// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { projectBridgeProgress } from './bridge-progress';
import type { ExecutionLifecycleSource, LifecycleOperation } from './execution-lifecycle';
const hash = '0x' + 'a'.repeat(64);
const operation = (id: string, state = 'confirmed', approval = false) => ({ id, state, hash, approval, chain: 'eip155:8453' }) as LifecycleOperation;
function source(kind: 'router' | 'universal', changes: Record<string, unknown> = {}) {
  return { kind, state: { record: { verdict: 'PENDING', source: { transactionHash: hash, safe: true, final: true }, destination: null, ...changes } } } as unknown as ExecutionLifecycleSource;
}
describe.each(['router', 'universal'] as const)('%s bridge evidence stages', kind => {
  const stages = (changes = {}, operations = [operation('DEPOSIT'), operation('destination', 'pending')]) => projectBridgeProgress(source(kind, changes), operations)!;
  it('keeps source confirmation separate from delivery and final reconciliation', () => {
    const result = stages();
    expect(result.find(s => s.id === 'source')?.status).toBe('Confirmed');
    expect(result.find(s => s.id === 'delivery')?.status).toBe('Awaiting observation');
    expect(result.find(s => s.id === 'reconciliation')?.status).toBe('Pending');
    expect(result).toHaveLength(5);
  });
  it('includes authorization only when the workflow actually contains it', () => {
    expect(stages({}, [operation('APPROVAL', 'confirmed', true), operation('DEPOSIT')])[0]).toMatchObject({ id: 'authorization', status: 'Confirmed' });
  });
  it('does not turn a provider completion hint, elapsed time or RPC outage into financial completion', () => {
    const result = stages({ lastHint: { status: 'DONE' }, observation: { outcome: 'TEMPORARY_FAILURE' } });
    expect(result.find(s => s.id === 'source')?.status).toBe('Confirmed');
    expect(result.find(s => s.id === 'transfer')?.status).toBe('Awaiting observation');
    expect(result.find(s => s.id === 'reconciliation')?.status).toBe('Pending');
  });
  it('requires finality on both sides and durable evidence for final reconciliation', () => {
    const destination = { transactionHash: hash, safe: true, final: true };
    expect(stages({ verdict: 'RECONCILED', destination }).at(-1)?.status).not.toBe('Confirmed');
    expect(stages({ verdict: 'RECONCILED', destination, evidence: { bundle: { outcome: 'RECONCILED' } } }).at(-1)?.status).toBe('Confirmed');
    expect(stages({ verdict: 'RECONCILED', destination: { ...destination, safe: false, final: false }, evidence: {} }).at(-1)?.status).not.toBe('Confirmed');
  });
  it('retains source/destination hashes while finality is pending', () => {
    const result = stages({ destination: { transactionHash: hash, safe: false, final: false } });
    expect(result.find(s => s.id === 'delivery')).toMatchObject({ hash, status: 'Awaiting observation' });
  });
  it('does not mark a refused wallet request as a failed on-chain transaction', () => {
    const result = stages({ source: null }, [{ ...operation('DEPOSIT', 'failed'), hash: null }]);
    expect(result.find(s => s.id === 'submission')?.status).toBe('Not submitted');
    expect(result.every(s => s.status !== 'Failed with evidence')).toBe(true);
  });
});
