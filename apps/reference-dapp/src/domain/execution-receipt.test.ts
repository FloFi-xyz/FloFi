// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (workstream B): the execution receipt states only what the persisted record proves. */
import { describe, expect, it } from 'vitest';
import { runDetailFixture, detailHash } from '../test-utils/run-detail-fixture';
import { projectExecutionReceipt, readableAmount, receiptDate } from './execution-receipt';
import { portuguese } from '../i18n/pt';

const receipt = (mode: Parameters<typeof runDetailFixture>[0]) => projectExecutionReceipt(runDetailFixture(mode).view);

describe('execution receipt', () => {
  it('a reconciled single swap: operation, outcome, what was sent and received (observed), network, protocol, known cost, wallet and transaction', () => {
    const value = receipt('completed');
    expect(value.title).toBe('Swap');
    expect(value.status).toBe('Completed'); expect(value.tone).toBe('success');
    expect(value.at).toBe('2026-10-06T12:01:00.000Z');
    expect(value.values).toEqual([{ label: 'You sent', value: '100 USDC', observed: true }, { label: 'You received', value: '0.0243 WETH', observed: true }]);
    expect(value.network).toBe('Base Sepolia');
    expect(value.protocol).toBeTruthy();
    // Approval and swap costs are the record's own (one network): never estimated, never zero.
    expect(value.fees).toEqual([{ label: 'Network fee', value: '0.0003 ETH', observed: true }]);
    expect(value.wallet).toMatch(/^0x1{40}$/);
    expect([value.completed, value.total]).toEqual([1, 1]);
    expect(value.transaction).toEqual({ hash: detailHash, explorer: `https://sepolia.basescan.org/tx/${detailHash}`, network: 'Base Sepolia' });
    expect(value.notice).toBeNull();
    expect(value.steps).toEqual([]);
  });
  it.each(['pending', 'unresolved', 'failed', 'declined'] as const)('%s: no received amount and no completed-result words without an observed effect', mode => {
    const value = receipt(mode);
    expect(value.values.some(row => /received/i.test(row.label) && row.observed)).toBe(false);
    expect(value.values.find(row => row.label === 'You sent')).toBeUndefined();
    // The owner's configured amount is labelled as configured, never as sent.
    expect(value.values[0]).toEqual({ label: 'Configured amount', value: '100 USDC', observed: false });
    expect(value.fees).toEqual([]);
    expect(value.status).not.toBe('Completed');
    expect(value.notice?.message).toBeTruthy();
  });
  it('keeps each status distinct', () => {
    expect(receipt('failed').status).toBe('Failed');
    expect(receipt('declined').status).toBe('Transaction not submitted');
    expect(receipt('unresolved').status).toBe('Unresolved');
    expect(receipt('pending').status).toBe('In progress');
    expect(receipt('partial').status).toBe('Partially completed');
  });
  it('a multi-step run lists every step in order with its own outcome; nothing is aggregated across steps or assets', () => {
    const value = receipt('partial');
    expect(value.title).not.toBe('Supply');
    expect(value.values).toEqual([]);
    expect(value.steps.map(step => [step.number, step.action, step.status])).toEqual([[1, 'Supply', 'Completed'], [2, 'Borrow', 'Failed'], [3, 'Swap', 'Not run']]);
    expect(value.steps[1]!.tone).toBe('failed');
    expect(value.notice?.items.length).toBeGreaterThan(0);
  });
  it('a bridge names both networks and states the delivered amount only once reconciled', () => {
    const settled = receipt('bridge-completed'), pending = receipt('bridge-pending');
    expect(settled.network).toBe('Base Sepolia → Arbitrum Sepolia');
    expect(settled.values).toEqual(expect.arrayContaining([{ label: 'You sent', value: '5 USDC', observed: true }, { label: 'You received', value: '4.89 USDC', observed: true }]));
    expect(pending.values.some(row => row.label === 'You received')).toBe(false);
  });
  it('every receipt label has a Portuguese translation', () => {
    const labels = new Set<string>();
    for (const mode of ['completed', 'pending', 'partial', 'failed', 'declined', 'unresolved', 'bridge-completed', 'bridge-pending', 'cow-reconciled', 'recovered'] as const) {
      const value = receipt(mode);
      for (const row of [...value.values, ...value.fees, ...value.steps.flatMap(step => step.values)]) labels.add(row.label);
      for (const step of value.steps) labels.add(step.status);
    }
    for (const label of labels) expect(portuguese[label], label).toBeTruthy();
  });
});

describe('receipt formatting', () => {
  it('formats the date in UTC, in the interface language', () => {
    expect(receiptDate('2026-11-19T10:26:00.000Z', 'PT')).toBe('19 nov. 2026 · 10:26 UTC');
    expect(receiptDate('2026-11-19T10:26:00.000Z', 'EN')).toBe('19 Nov 2026 · 10:26 UTC');
    expect(receiptDate(null, 'EN')).toBeNull(); expect(receiptDate('not a date', 'EN')).toBeNull();
  });
  it('keeps a readable amount without ever rounding a non-zero amount to zero; every digit stays available', () => {
    expect(readableAmount('0.000003724947756 ETH', 'PT')).toEqual({ text: '0,000003724947756 ETH', full: '0,000003724947756 ETH', cut: false });
    expect(readableAmount('0.00055426 WETH', 'EN').text).toBe('0.00055426 WETH');
    expect(readableAmount('1234567.5 USDC', 'PT').text).toBe('1.234.567,5 USDC');
    const long = readableAmount('0.123456789012345678 WETH', 'EN');
    expect(long).toEqual({ text: '0.123456789012… WETH', full: '0.123456789012345678 WETH', cut: true });
    const tiny = readableAmount('0.000000000000000000000000001 ETH', 'EN');
    expect(tiny.text).toBe('0.000000000000000000000000001 ETH'); expect(tiny.text).not.toBe('0 ETH');
    expect(readableAmount('Not recorded in this history', 'PT').text).toBe('Not recorded in this history');
    expect(readableAmount('#4821', 'EN').text).toBe('#4821');
  });
});
