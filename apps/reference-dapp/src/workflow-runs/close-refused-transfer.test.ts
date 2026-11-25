// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0-001 security: a client-supplied pre-send RPC code must not close a still-valid PREPARED batch.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { closeRefusedTransferBatch } from './service.ts';
import type { GroupRecord, RunRecord, WorkflowRunStore } from './pg-store.ts';

const OWNER = '0x' + '11'.repeat(20);
const REQUEST = '0x' + '22'.repeat(32);
const handout = randomBytes(32).toString('base64url');
const handoutHash = createHash('sha256').update(handout).digest('hex');
const preparedAt = '2026-11-25T14:00:00.000Z';

function prepared(validUntil: Date) {
  return {
    kind: 'EVM_WALLET_BATCH',
    owner: OWNER,
    fromBlock: '1000',
    ownerNonce: '0',
    preparedAt,
    handoutHash,
    group: {
      chain: 'eip155:8453',
      calls: [
        { kind: 'DEADLINE_GUARD', deadline: String(Math.floor(validUntil.getTime() / 1000)) },
        { kind: 'NATIVE_TRANSFER' },
      ],
    },
    request: { id: REQUEST, atomicRequired: true, calls: [{ value: '0x1' }, { value: '0x0' }] },
  };
}

function group(validUntil: Date, version = 1): GroupRecord {
  return {
    groupIndex: 0, stepFrom: 0, stepTo: 0, strategy: 'EVM_WALLET_BATCH', chain: 'eip155:8453', state: 'PREPARED',
    code: null, version, validUntil, prepared: prepared(validUntil), authorization: null, submission: null,
    outcome: null, planned: null, signed: false, batchId: null,
  } as unknown as GroupRecord;
}

function run(): RunRecord {
  return { runId: 'wfr_test', state: 'RUNNING', mode: 'USER_FUNDED', version: 3, stepCount: 1,
    owner: OWNER, wallets: { eip155: OWNER } } as unknown as RunRecord;
}

describe('closeRefusedTransferBatch', () => {
  it('refuses a forged pre-send RPC code while the prepared batch may still execute', async () => {
    const validUntil = new Date(Date.now() + 10 * 60_000);
    const cancel = vi.fn();
    const store = {
      groups: async () => [group(validUntil)],
      cancel,
    } as unknown as WorkflowRunStore;
    const deps = {
      store,
      now: () => new Date(),
      log: () => undefined,
      userFunded: { evm: () => ({ rpc: async () => '0x0' }) },
    };
    await expect(closeRefusedTransferBatch(deps as never, run(), [{ namespace: 'eip155', address: OWNER }], REQUEST, handout, 4200))
      .rejects.toThrow('WORKFLOW_RUN_DECLINE_NOT_PROVEN');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('ends an expired unanswered native transfer without claiming a proven pre-send refusal', async () => {
    const validUntil = new Date(Date.now() - 3 * 60_000);
    const cancel = vi.fn(async () => run());
    const store = {
      groups: async () => [group(validUntil)],
      cancel,
    } as unknown as WorkflowRunStore;
    const deps = {
      store,
      now: () => new Date(),
      log: () => undefined,
      userFunded: { evm: () => ({ rpc: async () => { throw new Error('unused'); } }) },
    };
    await closeRefusedTransferBatch(deps as never, run(), [{ namespace: 'eip155', address: OWNER }], REQUEST, handout, 5750);
    expect(cancel).toHaveBeenCalledWith('wfr_test', 3, 'OWNER_CANCELLED', expect.any(Date));
  });
});
