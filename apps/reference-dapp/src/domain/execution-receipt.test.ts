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
    // The destination delivery goes to the reviewed recipient (not necessarily the owner): "Delivered", never "You received".
    expect(settled.values).toEqual(expect.arrayContaining([{ label: 'You sent', value: '5 USDC', observed: true }, { label: 'Delivered', value: '4.89 USDC', observed: true }]));
    expect(settled.values.some(row => row.label === 'You received')).toBe(false);
    expect(pending.values.some(row => ['You received', 'Delivered'].includes(row.label))).toBe(false);
  });
  it('says a completed swap\'s received amount is not recorded when the record did not observe it (never zero, never the quote)', () => {
    const { view } = runDetailFixture('completed');
    const evidence = view.progress!.evidence!;
    const operations = Object.fromEntries(Object.entries(evidence.operations).map(([id, op]) => [id, { ...op, values: op.values.filter(value => value.label !== 'Actual received') }]));
    const value = projectExecutionReceipt({ ...view, progress: { ...view.progress!, evidence: { ...evidence, operations } } });
    expect(value.values).toContainEqual({ label: 'Received amount', value: 'Not recorded in this history', observed: false });
    expect(value.values.some(row => row.label === 'You received')).toBe(false);
  });
  it('keeps network costs per network and never sums them', () => {
    const { view } = runDetailFixture('completed');
    const evidence = { ...view.progress!.evidence!, knownCosts: [{ label: 'Known network cost · Base (8453)', value: '0.0001 ETH' }, { label: 'Known network cost · Arbitrum One', value: '0.0002 ETH' }] };
    const value = projectExecutionReceipt({ ...view, progress: { ...view.progress!, evidence } });
    expect(value.fees).toEqual([{ label: 'Network fee · {0}', args: ['Base'], value: '0.0001 ETH', observed: true },
      { label: 'Network fee · {0}', args: ['Arbitrum One'], value: '0.0002 ETH', observed: true }]);
    expect(portuguese['Network fee · {0}']).toBeTruthy();
  });
  it('names a step that expired, was cancelled or refunded as such, never "Failed"', () => {
    const { view } = runDetailFixture('partial');
    const steps = view.progress!.steps.map((step, index) => index === 1 ? { ...step, state: 'expired' as const } : index === 2 ? { ...step, state: 'cancelled' as const } : step);
    const value = projectExecutionReceipt({ ...view, progress: { ...view.progress!, steps } });
    expect(value.steps.map(step => step.status)).toEqual(['Completed', 'Expired', 'Cancelled']);
    const refunded = view.progress!.steps.map((step, index) => index === 1 ? { ...step, state: 'cancelled' as const, operations: step.operations.map(op => ({ ...op, label: 'Refunded' })) } : step);
    expect(projectExecutionReceipt({ ...view, progress: { ...view.progress!, steps: refunded } }).steps[1]!.status).toBe('Refunded');
  });
  it('names the owner\'s own wallet for a send authored to the connected owner', () => {
    const { view } = runDetailFixture('completed');
    const steps = view.progress!.steps.map(step => ({ ...step, recipient: 'CONNECTED_OWNER' }));
    expect(projectExecutionReceipt({ ...view, progress: { ...view.progress!, steps } }).recipient).toMatch(/^0x1{40}$/);
  });
  it('says on the receipt itself when a record is not a public-chain execution (flofi-wallet-execution review)', () => {
    expect(receipt('completed').provenance).toBeNull();
    expect(receipt('cow-reconciled').provenance).toBe('Local execution · no public-chain transactions');
    const { view } = runDetailFixture('completed');
    expect(projectExecutionReceipt({ ...view, run: { ...view.run, provenance: 'MOCKED' } }).provenance).toBe('Mocked local execution');
    expect(projectExecutionReceipt({ ...view, run: { ...view.run, provenance: 'FORK_REPRODUCED' } }).provenance).toBe('Local fork');
    expect(portuguese['Mocked local execution']).toBeTruthy(); expect(portuguese['Local execution · no public-chain transactions']).toBeTruthy();
  });
  it('a saved record never calls itself the current execution record', () => {
    const { view } = runDetailFixture('completed');
    const value = projectExecutionReceipt({ ...view, current: false, attention: ['Awaiting an execution status check'], message: 'All workflow steps are confirmed in the current execution record.' });
    expect(value.notice?.message).toBe('All workflow steps are confirmed in the saved execution record.');
    expect(projectExecutionReceipt({ ...view, current: true, attention: ['x'], message: 'All workflow steps are confirmed in the current execution record.' }).notice?.message)
      .toBe('All workflow steps are confirmed in the current execution record.');
  });
  it('links the transaction the owner\'s wallet sent (a bridge deposit), never the provider\'s fill', () => {
    expect(receipt('bridge-completed').transaction?.hash).toBe(detailHash);
  });
  it('shows no fee row when nothing reached a network', () => {
    expect(receipt('declined').submitted).toBe(false);
    expect(receipt('completed').submitted).toBe(true);
  });
  it('every receipt label has a Portuguese translation', () => {
    const labels = new Set<string>();
    for (const mode of ['completed', 'pending', 'partial', 'failed', 'declined', 'unresolved', 'bridge-completed', 'bridge-pending', 'cow-reconciled', 'recovered'] as const) {
      const value = receipt(mode);
      for (const row of [...value.values, ...value.fees, ...value.steps.flatMap(step => step.values)]) labels.add(row.label);
      for (const step of value.steps) labels.add(step.status);
    }
    for (const label of ['Delivered', 'Expired', 'Cancelled', 'Refunded', 'Received amount', 'Not recorded in this history']) labels.add(label);
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
    // BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001: six significant digits, marked "≈" when not exact; `full` keeps every recorded digit.
    expect(readableAmount('0.000003724947756 ETH', 'PT')).toEqual({ text: '≈ 0,00000372495 ETH', full: '0,000003724947756 ETH', cut: true });
    expect(readableAmount('0.00055426 WETH', 'EN')).toEqual({ text: '0.00055426 WETH', full: '0.00055426 WETH', cut: false });
    expect(readableAmount('1234567.5 USDC', 'PT')).toEqual({ text: '≈ 1,23457 mi USDC', full: '1.234.567,5 USDC', cut: true });
    const long = readableAmount('0.123456789012345678 WETH', 'EN');
    expect(long).toEqual({ text: '≈ 0.123457 WETH', full: '0.123456789012345678 WETH', cut: true });
    const tiny = readableAmount('0.000000000000000000000000001 ETH', 'EN');
    expect(tiny.text).toBe('0.000000000000000000000000001 ETH'); expect(tiny.text).not.toBe('0 ETH');
    expect(readableAmount('Not recorded in this history', 'PT').text).toBe('Not recorded in this history');
    expect(readableAmount('#4821', 'EN').text).toBe('#4821');
  });
});
