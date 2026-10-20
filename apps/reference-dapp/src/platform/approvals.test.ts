// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import type { CloudRun } from '../server/flow-runtime';
import type { EvidenceRecord, McpRuntime, Result } from '../mcp/runtime';
import type { HandoffRecord, HandoffStore } from './handoff-store';
import { approvalProgress } from './approvals';

const composition = composeWorkflow(STRATEGY_EXAMPLES.find(e => e.id === 'transfer-ethereum-sepolia')!.strategy);
if (!composition.ok) throw new Error(composition.code);
const workflow = composition.steps[0]!.workflow;
const owner = '0x' + '1'.repeat(40), now = '2026-10-19T10:00:00.000Z';
const handoff = { handoffId: 'apr_test', status: 'APPLIED', shareStatus: true, claimed: { namespace: 'eip155', address: owner },
  claimedAt: new Date(now), expiresAt: new Date(now), plan: { flow: 'robinhood-transfer', steps: [] }, runIds: [], workflowHash: composition.workflowHash } as unknown as HandoffRecord;
const run: CloudRun = { runId: 'rhx-' + 'a'.repeat(32), workflowId: 'w', flow: 'robinhood-transfer', status: 'RECONCILED', provenance: 'PUBLIC_TESTNET',
  ownerAccount: owner, errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: true, createdAt: now, updatedAt: now, attempts: [] };
const evidence: EvidenceRecord = { bundleHash: 'sha256:' + 'a'.repeat(64), environment: 'MOCKED', outcome: 'RECONCILED', content: {} };
function setup(patch: Partial<CloudRun> = {}, result: Result<EvidenceRecord | null> = { ok: true, value: evidence }) {
  const current = { ...run, ...patch }, never = async (): Promise<never> => { throw new Error('UNEXPECTED_RUNTIME_CALL'); };
  const runtime: McpRuntime = { kind: 'embedded', mode: never, preview: never, journal: never,
    runs: vi.fn(async () => ({ ok: true as const, value: [current] })), run: vi.fn(async () => ({ ok: true as const, value: current })),
    record: vi.fn(async () => ({ ok: true as const, value: { review: { workflow } } })), evidence: vi.fn(async () => result) };
  const store = { bindRuns: vi.fn(async () => undefined) } as unknown as HandoffStore;
  return { runtime, progress: (h = handoff) => approvalProgress(h, runtime, store, 'https://flofi.test') };
}

describe('shared proposal status requires independently reconciled evidence before a receipt', () => {
  it.each([
    { ok: false, code: 'EVIDENCE_UNAVAILABLE' }, { ok: true, value: null },
    { ok: true, value: { ...evidence, outcome: 'DIVERGENT' } }, { ok: true, value: { ...evidence, bundleHash: '' } },
    { ok: true, value: { ...evidence, environment: '' } },
  ] satisfies Result<EvidenceRecord | null>[])('fails closed when the summary has evidence but its read is incomplete (%j)', async result => {
    const { progress } = setup({}, result);
    expect((await progress()).runs).toMatchObject([{ reconciled: false, terminal: false, receiptUrl: null }]);
  });

  it.each(['SIMULATED', 'AUTHORIZED', 'PREPARED', 'SUBMITTING', 'PENDING', 'CONFIRMED'])('never promotes %s to executed from an inconsistent evidence flag', async status => {
    expect((await setup({ status }).progress()).runs).toMatchObject([{ status, reconciled: false, receiptUrl: null }]);
  });

  it('keeps observation and errors from becoming successful receipts', async () => {
    for (const patch of [{ needsObservation: true }, { errorCode: 'DIVERGENT' }, { hasEvidence: false }])
      expect((await setup(patch).progress()).runs).toMatchObject([{ reconciled: false, receiptUrl: null }]);
  });

  it('returns a scoped receipt only after a successful evidence read, with its actual environment', async () => {
    const { progress, runtime } = setup();
    expect((await progress()).runs).toMatchObject([{ reconciled: true, terminal: true, evidenceEnvironment: 'MOCKED',
      evidenceOutcome: 'RECONCILED', receiptUrl: `https://flofi.test/app/dashboard/runs/${run.runId}` }]);
    expect(runtime.evidence).toHaveBeenCalledWith('robinhood-transfer', run.runId, owner);
  });

  it('never reads or shares runs when the owner revokes status sharing', async () => {
    const { progress, runtime } = setup();
    expect(await progress({ ...handoff, shareStatus: false })).toMatchObject({ runsVisible: false, runs: [] });
    expect(runtime.runs).not.toHaveBeenCalled(); expect(runtime.evidence).not.toHaveBeenCalled();
  });
});
