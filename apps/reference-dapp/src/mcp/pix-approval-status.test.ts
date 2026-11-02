// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149 (P0): `get_approval_status` includes the Pix payment runs of a Pix approval — only runs durably bound to that approval,
 * read as its claimant wallet, of the requesting account only — with their real recorded state and canonical lifecycle, and without
 * inventing an approval, a binding or a settlement.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CloudRun } from '../server/flow-runtime';
import type { HandoffRecord, HandoffStore } from '../platform/index.ts';
import { credentialDigest, newCredential } from './oauth/crypto';
import { readOAuthConfig, type OAuthConfig } from './oauth/config';
import { oauthEnv, ORIGIN } from './oauth/oauth-test-harness';
import type { McpState } from './oauth/state';
import { session } from './gateway.test-harness';
import { pixApprovalProgress } from './pix-approval-status';
import type { EvidenceRecord, McpRuntime, Result } from './runtime';

const OWNER = '0x' + 'a'.repeat(40), OTHER = '0x' + 'b'.repeat(40), CLAIMED_AT = '2026-11-01T10:00:00.000Z', LATER = '2026-11-01T10:05:00.000Z';
const runId = (n: number) => 'pay-' + String(n).repeat(32).slice(0, 32);
const BUNDLE = 'sha256:' + 'c'.repeat(64);
const approval = (patch: Partial<HandoffRecord> = {}): HandoffRecord => ({ handoffId: 'apr_' + 'a'.repeat(26), requesterKind: 'MCP_ACCOUNT', requesterRef: 'mcpacct_' + 'a'.repeat(26),
  requesterContext: {}, accountId: 'mcpacct_' + 'a'.repeat(26), grantId: 'grt_' + 'a'.repeat(26), clientId: 'https://claude.ai/client', clientName: 'Claude', strategy: {},
  workflowHash: '0x' + '1'.repeat(64), engineVersion: 'flofi-engine-2', networkEnvironment: 'MAINNET', fundsClass: 'REAL_FUNDS',
  plan: { kind: 'SINGLE_FLOW', flow: 'pix-payment', reason: null, steps: [], networks: [], networkEnvironment: 'MAINNET', fundsClass: 'REAL_FUNDS' } as unknown as HandoffRecord['plan'],
  status: 'APPLIED', claimed: { namespace: 'eip155', address: OWNER }, shareStatus: true, runIds: [runId(1)], expiresAt: new Date(LATER), claimExpiresAt: null,
  claimedAt: new Date(CLAIMED_AT), appliedAt: new Date(CLAIMED_AT), endedAt: null, createdAt: new Date(CLAIMED_AT), signingExpiresAt: null, ...patch });
const summary = (id: string, owner: string, patch: Partial<CloudRun> = {}): CloudRun => ({ runId: id, workflowId: id, flow: 'pix-payment', status: 'SOURCE_SUBMITTED',
  provenance: 'PUBLIC_MAINNET', ownerAccount: owner, errorCode: null, needsObservation: true, attentionRequired: false, hasEvidence: false, createdAt: LATER, updatedAt: LATER,
  attempts: [{ attemptId: `${id}.SOURCE`, step: 'SOURCE', state: 'SUBMITTED', transactionHash: '0x' + 'd'.repeat(64), reconciled: false }], ...patch });
const record = (id: string, owner: string, patch: Record<string, unknown> = {}) => ({ id, state: 'SOURCE_SUBMITTED', facts: { owner: { chainId: 'eip155:8453', address: owner } },
  evidence: null, ...patch });

/** The owner-scoped runtime: a run (and its record) is returned only to the wallet that owns it, as the cloud runtime does. */
function runtime(runs: { run: CloudRun; record: unknown }[], evidence: Result<EvidenceRecord | null> = { ok: true, value: null }, fail: Partial<Record<'run' | 'record', string>> = {}) {
  const find = (id: string, owner: string) => runs.find(r => r.run.runId === id && r.run.ownerAccount?.toLowerCase() === owner.toLowerCase()) ?? null;
  const never = async (): Promise<never> => { throw new Error('UNEXPECTED_RUNTIME_CALL'); };
  return { kind: 'remote', mode: never, preview: never, journal: never,
    runs: vi.fn(never),
    run: vi.fn(async (id: string, owner: string) => fail.run ? { ok: false as const, code: fail.run } : { ok: true as const, value: find(id, owner)?.run ?? null }),
    record: vi.fn(async (_flow: string, id: string, owner: string) => fail.record ? { ok: false as const, code: fail.record } : { ok: true as const, value: find(id, owner)?.record ?? null }),
    evidence: vi.fn(async () => evidence) } satisfies McpRuntime;
}

describe('Pix approval status: eligible runs only, with their real state', () => {
  it('lists a bound run of the claimant with its recorded state and canonical lifecycle — in flight is never "not started"', async () => {
    const rt = runtime([{ run: summary(runId(1), OWNER), record: record(runId(1), OWNER) }]);
    const progress = await pixApprovalProgress(approval(), rt, ORIGIN);
    expect(progress).toMatchObject({ approvalId: 'apr_' + 'a'.repeat(26), status: 'APPLIED', runsVisible: true, authority: 'NONE',
      runs: [{ executionId: runId(1), flow: 'pix-payment', status: 'SOURCE_SUBMITTED', reconciled: false, terminal: false, receiptUrl: null,
        lifecycle: { status: 'HASH_KNOWN', completed: false } }] });
    expect(rt.run).toHaveBeenCalledWith(runId(1), OWNER);
    expect(rt.runs).not.toHaveBeenCalled();
  });

  it('a wallet result that is unknown stays INCONCLUSIVE, never REJECTED or NOT_STARTED', async () => {
    const run = summary(runId(1), OWNER, { status: 'SUBMISSION_RESULT_UNKNOWN', needsObservation: false, errorCode: 'PAYMENT_WALLET_RESULT_UNKNOWN',
      attempts: [{ attemptId: `${runId(1)}.SOURCE`, step: 'SOURCE', state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null, reconciled: false }] });
    const progress = await pixApprovalProgress(approval(), runtime([{ run, record: record(runId(1), OWNER, { state: 'AUTHORIZED' }) }]), ORIGIN);
    expect(progress.runs[0]!.lifecycle.status).toBe('INCONCLUSIVE');
    expect(progress.runs[0]!.reconciled).toBe(false);
  });

  it('a settled payout is reconciled only with the flow\'s own settled evidence, the same bundle as the record', async () => {
    const settled = summary(runId(1), OWNER, { status: 'PAYMENT_SETTLED', needsObservation: false, hasEvidence: true });
    const good: EvidenceRecord = { bundleHash: BUNDLE, environment: 'PUBLIC_MAINNET', outcome: 'PAYMENT_SETTLED', content: {} };
    const ok = await pixApprovalProgress(approval(), runtime([{ run: settled, record: record(runId(1), OWNER, { state: 'PAYMENT_SETTLED', evidence: { bundleHash: BUNDLE } }) }],
      { ok: true, value: good }), ORIGIN);
    expect(ok.runs).toMatchObject([{ reconciled: true, terminal: true, evidenceOutcome: 'PAYMENT_SETTLED', evidenceBundleHash: BUNDLE,
      lifecycle: { status: 'RECONCILED', completed: true }, receiptUrl: `${ORIGIN}/app/dashboard/runs/${runId(1)}` }]);
    for (const [evidence, recorded] of [[{ ok: true, value: { ...good, bundleHash: 'sha256:' + 'e'.repeat(64) } }, BUNDLE], [{ ok: false, code: 'CLOUD_API_UNAVAILABLE' }, BUNDLE],
      [{ ok: true, value: good }, null], [{ ok: true, value: { ...good, outcome: 'RECONCILED' } }, BUNDLE]] as const) {
      const progress = await pixApprovalProgress(approval(), runtime([{ run: settled, record: record(runId(1), OWNER, { state: 'PAYMENT_SETTLED',
        evidence: recorded ? { bundleHash: recorded } : null }) }], evidence as Result<EvidenceRecord | null>), ORIGIN);
      expect(progress.runs).toMatchObject([{ reconciled: false, receiptUrl: null, evidenceBundleHash: null, lifecycle: { status: 'SETTLEMENT_PENDING', completed: false } }]);
    }
  });
});

describe('Pix approval status: owner and account isolation, and no invented approval', () => {
  it('never lists another wallet\'s run, a run whose record names another owner, an older run or an unbound run', async () => {
    const rt = runtime([
      { run: summary(runId(1), OTHER), record: record(runId(1), OTHER) },                                   // another wallet's run
      { run: summary(runId(2), OWNER), record: record(runId(2), OTHER) },                                   // record names another owner
      { run: summary(runId(3), OWNER, { createdAt: '2026-11-01T09:00:00.000Z' }), record: record(runId(3), OWNER) }, // before the claim
      { run: summary(runId(4), OWNER), record: record(runId(5), OWNER) },                                   // record of another run
      { run: summary(runId(6), OWNER), record: record(runId(6), OWNER) },                                   // eligible, but NOT bound
      { run: summary(runId(7), OWNER, { flow: 'robinhood-transfer' }), record: record(runId(7), OWNER) },  // another flow
    ]);
    const progress = await pixApprovalProgress(approval({ runIds: [runId(1), runId(2), runId(3), runId(4), runId(7), 'xroute-' + 'a'.repeat(32)] }), rt, ORIGIN);
    expect(progress).toMatchObject({ runsVisible: true, runs: [], note: 'No Pix payment run is bound to this approval yet.' });
    // Every read is made AS the claimant; the unbound run and the malformed id are never read.
    expect(rt.run.mock.calls.every(([, owner]) => owner === OWNER)).toBe(true);
    expect(rt.run.mock.calls.map(([id]) => id)).not.toContain(runId(6));
    expect(rt.run.mock.calls.map(([id]) => id)).not.toContain('xroute-' + 'a'.repeat(32));
  });

  it('reads nothing and shows no run unless the approval is applied, claimed by an EVM wallet and shared', async () => {
    for (const patch of [{ status: 'PENDING' as const }, { status: 'CLAIMED' as const }, { shareStatus: false }, { claimed: null, claimedAt: null },
      { claimed: { namespace: 'solana' as const, address: '9'.repeat(43) } }]) {
      const rt = runtime([{ run: summary(runId(1), OWNER), record: record(runId(1), OWNER) }]);
      const progress = await pixApprovalProgress(approval(patch), rt, ORIGIN);
      expect(progress, JSON.stringify(patch)).toMatchObject({ runsVisible: false, runs: [] });
      expect(rt.run).not.toHaveBeenCalled(); expect(rt.record).not.toHaveBeenCalled();
    }
    // The approval's own status is reported exactly as stored: never upgraded to APPLIED or claimed.
    const pending = await pixApprovalProgress(approval({ status: 'PENDING', claimed: null, claimedAt: null, appliedAt: null }), runtime([]), ORIGIN);
    expect(pending).toMatchObject({ status: 'PENDING', claimed: false, applied: false, authority: 'NONE' });
  });

  it('a run that cannot be read is UNKNOWN and the list says it is incomplete — never an empty "no runs"', async () => {
    for (const fail of [{ run: 'MCP_REQUEST_TIMEOUT' }, { record: 'CLOUD_API_UNAVAILABLE' }]) {
      const progress = await pixApprovalProgress(approval(), runtime([{ run: summary(runId(1), OWNER), record: record(runId(1), OWNER) }], undefined, fail), ORIGIN);
      expect(progress).toMatchObject({ runsVisible: true, runs: [], runsComplete: false, runsReadError: fail.run ?? fail.record });
      expect(progress.note).toMatch(/UNKNOWN/);
    }
  });
});

describe('get_approval_status over MCP: only the requesting account\'s Pix approval', () => {
  const env = { FLOFI_MCP: 'enabled', ...oauthEnv() };
  const config = readOAuthConfig(env) as OAuthConfig;
  const accounts = { A: 'mcpacct_' + 'a'.repeat(26), B: 'mcpacct_' + 'b'.repeat(26) };
  const tokens = { A: newCredential('access'), B: newCredential('access') };
  const digestOf = (token: string) => credentialDigest(config.keys.token, token).toString('hex');
  const h = approval();
  const state = {
    oauth: { authenticate: async (digest: Buffer) => {
      const who = (Object.keys(tokens) as ('A' | 'B')[]).find(k => digestOf(tokens[k]) === digest.toString('hex'));
      return who ? { accountId: accounts[who], grantId: 'grt_' + who.toLowerCase().repeat(26), clientId: 'https://claude.ai/client', clientName: 'Claude',
        scopes: ['flofi.strategy', 'flofi.runs', 'flofi.approval'], resource: config.resource, familyId: 'fam_' + 'a'.repeat(26), expiresAt: new Date(Date.now() + 3_600_000) } : null;
    }, allow: async () => true },
    // The real store scopes every read to the requester; this fake does the same.
    handoffs: { forRequester: async (id: string, scope: { kind: string; ref: string }) => id === h.handoffId && scope.kind === h.requesterKind && scope.ref === h.requesterRef ? h : null,
      bindRuns: vi.fn(async () => undefined) } as unknown as HandoffStore,
    links: { active: async () => [] }, workflowRuns: {},
  } as unknown as McpState;

  it('the owning account sees its bound Pix run; another account gets APPROVAL_NOT_FOUND and nothing is read', async () => {
    const rt = runtime([{ run: summary(runId(1), OWNER), record: record(runId(1), OWNER) }]);
    const own = await session({ env, token: tokens.A, state, runtime: rt }).callTool('get_approval_status', { approvalId: h.handoffId });
    expect(own.isError, own.text).toBe(false);
    expect(own.output).toMatchObject({ ok: true, status: 'APPLIED', runsVisible: true, runs: [{ executionId: runId(1), status: 'SOURCE_SUBMITTED',
      lifecycle: { status: 'HASH_KNOWN' } }] });
    expect(own.text).not.toContain(OWNER);
    const reads = rt.run.mock.calls.length;
    const other = await session({ env, token: tokens.B, state, runtime: rt }).callTool('get_approval_status', { approvalId: h.handoffId });
    expect(other).toMatchObject({ isError: true, output: { ok: false, code: 'APPROVAL_NOT_FOUND' } });
    expect(rt.run.mock.calls.length).toBe(reads);
    expect(other.text).not.toContain(runId(1));
  });

  it('a Pix status read that times out is STATUS_UNKNOWN, never an empty run list', async () => {
    const rt = { ...runtime([]), run: vi.fn(() => new Promise<never>(() => undefined)) } as unknown as McpRuntime;
    const result = await session({ env, token: tokens.A, state, runtime: rt, budgetMs: 2_000, marginMs: 1_000 }).callTool('get_approval_status', { approvalId: h.handoffId });
    expect(result).toMatchObject({ isError: true, output: { ok: false, code: 'MCP_REQUEST_TIMEOUT', outcome: 'STATUS_UNKNOWN', next: ['get_approval_status'] } });
  });
});
