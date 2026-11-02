// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import type { CloudRun } from '../server/flow-runtime';
import type { EvidenceRecord, McpRuntime, Result } from '../mcp/runtime';
import type { HandoffRecord, HandoffStore } from './handoff-store';
import { approvalProgress, sharedRuns, sharedRunsRead } from './approvals';

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

describe('BUILD-FLOFI-E2E-RELIABILITY-001 a failed run read is never "no runs"', () => {
  it('a failed listing or run/record read marks the shared runs incomplete (state UNKNOWN), never an empty, complete list', async () => {
    for (const fail of ['runs', 'run', 'record'] as const) {
      const { runtime, progress } = setup();
      (runtime[fail] as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' });
      const value = await progress();
      expect(value, fail).toMatchObject({ runsVisible: true, runsComplete: false, runsReadError: 'RUNS_READ_FAILED', runs: [] });
      expect(value.note, fail).toMatch(/UNKNOWN \(not "not started"\)/);
    }
    // A complete read carries no incompleteness flag at all.
    expect('runsComplete' in await setup().progress()).toBe(false);
  });
  it('sharedRuns refuses an incomplete read (SERVICE_UNAVAILABLE for developers) instead of returning an empty list', async () => {
    const { runtime } = setup(), store = { bindRuns: vi.fn(async () => undefined) } as unknown as HandoffStore;
    (runtime.runs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' });
    await expect(sharedRuns(handoff, runtime, store)).rejects.toThrow('CLOUD_RUNTIME_UNAVAILABLE');
    expect(await sharedRuns(handoff, runtime, store)).toHaveLength(1);
    expect(await sharedRuns({ ...handoff, shareStatus: false }, runtime, store)).toBeNull();
  });
});

describe('BUILD-FLOFI-E2E-RELIABILITY-001 shared runs window (automations and developers reviews)', () => {
  const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
  const other = (i: number): CloudRun => ({ ...run, runId: `rhx-${String(i).padStart(32, '0')}`, status: 'SIMULATED', hasEvidence: false, createdAt: at(i), updatedAt: at(i) });
  function windowed(listed: CloudRun[], own: CloudRun, evidenceRead: Result<EvidenceRecord | null> = { ok: true, value: evidence }) {
    const byId = new Map([...listed, own].map(r => [r.runId, r]));
    const runtime = { kind: 'embedded', runs: vi.fn(async () => ({ ok: true as const, value: listed })),
      run: vi.fn(async (id: string) => ({ ok: true as const, value: byId.get(id) ?? null })),
      // Only the approval's own run reviewed this workflow; every other run of the wallet reviewed something else.
      record: vi.fn(async (_flow: string, id: string) => ({ ok: true as const, value: id === own.runId ? { review: { workflow } } : { review: { workflow: { other: true } } } })),
      evidence: vi.fn(async () => evidenceRead) } as unknown as McpRuntime;
    const store = { bindRuns: vi.fn(async () => undefined) } as unknown as HandoffStore;
    return { runtime, store };
  }

  it('a run already bound to the approval is read whatever newer runs the wallet made; unexamined runs make the read truncated', async () => {
    const own = { ...run, createdAt: at(1), updatedAt: at(1) }, newer = Array.from({ length: 24 }, (_, i) => other(i + 2)).reverse();
    const { runtime, store } = windowed(newer, own);
    const read = await sharedRunsRead({ ...handoff, runIds: [own.runId] }, runtime, store);
    expect(read).toMatchObject({ complete: true, truncated: true, runs: [{ executionId: own.runId, reconciled: true }] });
    // Unbound: the oldest and the newest after the claim are examined (an approval's own run usually starts right after it is applied).
    const unbound = windowed([...newer, own], own);
    expect((await sharedRunsRead(handoff, unbound.runtime, unbound.store))?.runs.map(r => r.executionId)).toEqual([own.runId]);
    expect(unbound.store.bindRuns).toHaveBeenCalledWith(handoff.handoffId, [own.runId]);
  });

  it('no run found while older runs were not examined is never "no run" on MCP', async () => {
    const { runtime, store } = windowed(Array.from({ length: 25 }, (_, i) => other(i + 1)).reverse(), { ...run, runId: 'rhx-' + 'f'.repeat(32) });
    const progress = await approvalProgress(handoff, runtime, store);
    expect(progress).toMatchObject({ runs: [], runsTruncated: true });
    expect(progress.note).toMatch(/older ones/);
  });

  it('a run with evidence whose evidence read failed makes the read incomplete (its outcome is unknown, not unreconciled)', async () => {
    const own = { ...run, createdAt: at(1), updatedAt: at(1) };
    const { runtime, store } = windowed([own], own, { ok: false, code: 'EVIDENCE_UNAVAILABLE' });
    expect(await sharedRunsRead(handoff, runtime, store)).toMatchObject({ complete: false, runs: [{ executionId: own.runId, reconciled: false }] });
    await expect(sharedRuns(handoff, runtime, store)).rejects.toThrow('CLOUD_RUNTIME_UNAVAILABLE');
  });
});
