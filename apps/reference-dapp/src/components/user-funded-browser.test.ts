// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: what a wallet's EIP-5792 batch status means for the run. Only status 400 (not included on chain) is "nothing was
 * sent"; a batch that failed by the chain's rules (500) or landed partially (600) reached the chain and its owner paid for it.
 */
import { describe, expect, it } from 'vitest';
import { eip5792 } from '@defi-workflow-engine/reference-compiler';
import { batchOutcome } from './user-funded-browser';

const HASH = '0x' + 'ab'.repeat(32);
const status = (code: number, receipts: unknown[] = []) => eip5792.callsStatus({ version: '2.0.0', id: '0x01', chainId: '0xa4b1', status: code, atomic: true, receipts });
const receipt = { transactionHash: HASH, status: '0x0', blockNumber: '0x10', gasUsed: '0x5208', logs: [] };

describe('wallet batch status → run report', () => {
  it('pending stays pending; confirmed reports its transactions', () => {
    expect(batchOutcome(status(100))).toBeNull();
    expect(batchOutcome(status(200, [{ ...receipt, status: '0x1' }]))).toEqual({ hashes: [HASH], failed: false });
  });
  it('only an off-chain failure (400) without receipts is reported as not sent', () => {
    expect(batchOutcome(status(400))).toEqual({ hashes: [], failed: true });
  });
  it('a chain-rules failure (500) or a partial batch (600) is never "not sent": receipts are reported, none yet keeps it pending', () => {
    expect(batchOutcome(status(500, [receipt]))).toEqual({ hashes: [HASH], failed: false });
    expect(batchOutcome(status(600, [receipt]))).toEqual({ hashes: [HASH], failed: false });
    expect(batchOutcome(status(500))).toBeNull();
    expect(batchOutcome(status(600))).toBeNull();
    expect(batchOutcome(status(200))).toBeNull();
  });
});
