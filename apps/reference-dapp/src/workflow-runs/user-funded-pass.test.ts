// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 / P0 universal execution: the user-funded pass of a Solana sign-all group, on an in-memory compare-and-set
 * store double and a loopback Solana RPC (MOCKED; no network). What is proven: a signed group is stopped for lack of blockhash budget only
 * while it is AUTHORIZED (provably nothing sent), and once anything may have been sent it is never recorded FAILED while its blockhash is valid.
 */
import { describe, expect, it } from 'vitest';
import type { UserFundedDeps } from '../user-funded/groups.ts';
import type { GroupPatch, GroupRecord, GroupState, RunPatch, RunRecord, RunStepRecord, StepPatch, WorkflowRunStore } from './pg-store.ts';
import type { RunState, StepState } from './state-machine.ts';
import { userFundedPass, type UserFundedPassDeps } from './user-funded-pass.ts';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', NOW = new Date('2026-11-07T10:00:00Z');

async function signedTx(payer: string, lamports: number): Promise<string> {
  const { compileMessageV0, serializeMessageV0, serializeTransaction, toBase64 } = await import('@defi-workflow-engine/reference-compiler');
  return toBase64(serializeTransaction(new Uint8Array(64).fill(1), serializeMessageV0(compileMessageV0(payer, [{ programId: '11111111111111111111111111111111',
    accounts: [{ pubkey: payer, isSigner: true, isWritable: true }], data: new Uint8Array([2, 0, 0, 0, lamports, 0, 0, 0, 0, 0, 0, 0]) }],
  'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', {}))));
}

/** An in-memory store with the pg store's compare-and-set semantics for what the pass touches (run: version + states; group/step: states). */
function memoryStore(run: RunRecord, group: GroupRecord, steps: readonly StepState[]) {
  let r = run, g = group;
  const s: RunStepRecord[] = steps.map((state, stepIndex) => ({ runId: run.runId, stepIndex, state, flow: null, strategy: null, workflowHash: null, bound: null,
    claimedAt: null, outcome: null, code: null, version: 1, updatedAt: NOW }));
  const writes: string[] = [];
  let concurrent: (() => void) | null = null;
  const store = {
    byId: async () => r,
    groups: async () => [g],
    steps: async () => s.map(x => ({ ...x })),
    groupTransition: async (_runId: string, index: number, from: readonly GroupState[], to: GroupState, patch: GroupPatch, _kind?: string,
      expectVersion: number | null = null) => {
      const write = concurrent; concurrent = null; write?.();
      if (index !== g.groupIndex || !from.includes(g.state) || (expectVersion !== null && g.version !== expectVersion)) return null;
      g = { ...g, ...patch, state: to, version: g.version + 1 };
      writes.push(`group:${to}`);
      return g;
    },
    stepTransition: async (_runId: string, index: number, from: readonly StepState[], to: StepState, patch: StepPatch) => {
      const x = s[index];
      if (!x || !from.includes(x.state)) return null;
      s[index] = { ...x, state: to, code: patch.code !== undefined ? patch.code : x.code, version: x.version + 1 };
      writes.push(`step${index}:${to}`);
      return s[index];
    },
    transition: async (_runId: string, expected: { readonly version: number; readonly from: readonly RunState[] }, to: RunState, patch: RunPatch) => {
      if (expected.version !== r.version || !expected.from.includes(r.state)) return null;
      r = { ...r, state: to, version: r.version + 1, code: patch.code !== undefined ? patch.code : r.code };
      writes.push(`run:${to}`);
      return r;
    },
  };
  return { store: store as unknown as WorkflowRunStore, writes, run: () => r, group: () => g, steps: () => s,
    /** Plays a concurrent write to the run (e.g. a status poll that moved its version). */
    setRun: (next: Partial<RunRecord>) => { r = { ...r, ...next }; },
    /** Plays a concurrent pass's write. */
    setGroup: (next: Partial<GroupRecord>) => { g = { ...g, ...next }; },
    /** Plays a concurrent write that lands between this pass's read and its next group write (once). */
    beforeGroupWrite: (next: Partial<GroupRecord>) => { concurrent = () => { g = { ...g, ...next, version: g.version + 1 }; }; } };
}

/** A loopback Solana RPC: block heights per commitment, signature statuses, and every sendTransaction payload. */
function solanaChain() {
  const state = { confirmed: 100, finalized: 90, fail: false, onHeight: null as (() => void) | null, statuses: new Map<string, { confirmationStatus: string; err: unknown }>(),
    sent: [] as string[] };
  const rpc: NonNullable<UserFundedDeps['solana']> = async (method, params) => {
    if (method === 'getBlockHeight') {
      state.onHeight?.();
      if (state.fail) throw new Error('SOLANA_RPC_UNAVAILABLE');
      return (params[0] as { commitment: string }).commitment === 'finalized' ? state.finalized : state.confirmed;
    }
    if (method === 'getSignatureStatuses') return { value: (params[0] as string[]).map(sig => state.statuses.get(sig) ?? null) };
    if (method === 'sendTransaction') { state.sent.push(String(params[0])); return 'sent'; }
    throw new Error(`UNEXPECTED_${method}`);
  };
  return { state, rpc };
}

async function setup(opts: { readonly transactions?: number; readonly stepFrom?: number; readonly groupState?: GroupState } = {}) {
  const n = opts.transactions ?? 3, from = opts.stepFrom ?? 0;
  const txs = await Promise.all(Array.from({ length: n }, (_, i) => signedTx(OWNER, i + 1)));
  const prepared = { kind: 'SOLANA_SIGN_ALL', owner: OWNER, transactions: txs.map((_, i) => ({ stepIndex: from + i, kind: 'TRANSFER', owner: OWNER, lastValidBlockHeight: 150,
    minimumOut: null, spend: { asset: `${SOLANA}/token:So11111111111111111111111111111111111111112`, amount: '1' } })) };
  const authorization = { kind: 'SOLANA_SIGN_ALL', transactions: txs.map((transaction, i) => ({ signature: `sig${i}`, transaction })), at: NOW.toISOString() };
  const run = { runId: 'wfr_' + 'p'.repeat(26), handoffId: 'h', requester: { kind: 'MCP', ref: 'r' }, owner: { namespace: 'solana', address: OWNER }, wallets: { solana: OWNER },
    strategy: {}, workflowHash: '0x', engineVersion: 'test', stepCount: from + n, mode: 'USER_FUNDED', state: 'RUNNING', currentStep: from, authorizationId: null, code: null,
    completedAt: null, expiresAt: new Date(NOW.getTime() + 3_600_000), version: 7, createdAt: NOW, updatedAt: NOW } as unknown as RunRecord;
  const group = { runId: run.runId, groupIndex: from > 0 ? 1 : 0, namespace: 'solana', chain: SOLANA, feePayer: OWNER, stepFrom: from, stepTo: from + n - 1,
    strategy: 'SOLANA_SIGN_ALL', signing: 'WHEN_DUE', awaitsDelivery: null, state: opts.groupState ?? 'AUTHORIZED', prepared, authorization, submission: null, outcome: null,
    code: null, validUntil: new Date(NOW.getTime() + 20_000), version: 3, updatedAt: NOW } as GroupRecord;
  const steps: StepState[] = [...Array.from({ length: from }, () => 'RECONCILED' as const), ...Array.from({ length: n }, () => 'DELEGATED' as const)];
  const mem = memoryStore(run, group, steps), chain = solanaChain(), logs: string[] = [];
  const userFunded: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, solana: chain.rpc, now: () => NOW };
  const deps = (solana: UserFundedDeps['solana'] = chain.rpc): UserFundedPassDeps => ({ store: mem.store, userFunded: { ...userFunded, solana }, now: () => NOW,
    log: event => { logs.push(event); }, confirmPass: async () => { throw new Error('UNEXPECTED_CONFIRM_PASS'); } });
  return { mem, chain, deps, logs, txs };
}

describe('P0 universal execution: the Solana sign-all pass decides the send budget only while nothing was sent', () => {
  it('an AUTHORIZED group without the budget is BLOCKED before anything is sent: steps BLOCKED, run FAILED, sendTransaction never called', async () => {
    const { mem, chain, deps, logs } = await setup();
    // 3 transactions need 75 blocks; the shortest blockhash leaves 40.
    chain.state.confirmed = 110;
    const pass = await userFundedPass(deps(), mem.run());
    expect(pass).toMatchObject({ state: 'FAILED', code: 'SOLANA_GROUP_SIGNED_TOO_LATE' });
    expect(mem.group()).toMatchObject({ state: 'BLOCKED', code: 'SOLANA_GROUP_SIGNED_TOO_LATE', submission: null });
    expect(mem.steps().map(s => [s.state, s.code])).toEqual([0, 1, 2].map(() => ['BLOCKED', 'SOLANA_GROUP_SIGNED_TOO_LATE']));
    expect(mem.run()).toMatchObject({ state: 'FAILED', code: 'SOLANA_GROUP_SIGNED_TOO_LATE' });
    expect(chain.state.sent).toEqual([]);
    expect(logs).toEqual(['workflow_run.group_blocked']);
    // Nothing more happens on later passes: nothing is ever sent.
    await userFundedPass(deps(), mem.run());
    expect(chain.state.sent).toEqual([]);
  });

  it('after earlier reconciled steps the run HALTS instead (the owner ends it); still nothing of the group is sent', async () => {
    const { mem, chain, deps } = await setup({ stepFrom: 1, transactions: 2 });
    chain.state.confirmed = 101;
    expect(await userFundedPass(deps(), mem.run())).toMatchObject({ state: 'HALTED', code: 'SOLANA_GROUP_SIGNED_TOO_LATE' });
    expect(mem.group().state).toBe('BLOCKED');
    expect(mem.steps().map(s => s.state)).toEqual(['RECONCILED', 'BLOCKED', 'BLOCKED']);
    expect(chain.state.sent).toEqual([]);
  });

  it('an unreadable block height decides nothing: the group stays AUTHORIZED, nothing is written or sent, the pass retries', async () => {
    const { mem, chain, deps } = await setup();
    chain.state.fail = true;
    expect(await userFundedPass(deps(), mem.run())).toEqual({ state: 'RUNNING', code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE', retryMs: 15_000, progressed: false });
    expect(await userFundedPass(deps(null), mem.run())).toEqual({ state: 'RUNNING', code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE', retryMs: 15_000, progressed: false });
    expect(mem.writes).toEqual([]);
    expect(mem.group().state).toBe('AUTHORIZED');
    expect(chain.state.sent).toEqual([]);
  });

  it('regression: once SUBMITTED and the first transaction sent, a short budget never records the group FAILED while its blockhash is valid', async () => {
    const { mem, chain, deps, txs } = await setup();
    // Pass 1: the budget is there (80 ≥ 75): every signature is recorded first, nothing is sent in the same write.
    chain.state.confirmed = 70;
    expect(await userFundedPass(deps(), mem.run())).toMatchObject({ progressed: true });
    expect(mem.group()).toMatchObject({ state: 'SUBMITTED', submission: { kind: 'SOLANA_SIGN_ALL', hashes: ['sig0', 'sig1', 'sig2'] } });
    expect(chain.state.sent).toEqual([]);
    // Pass 2: the first transaction is sent.
    expect(await userFundedPass(deps(), mem.run())).toMatchObject({ state: 'RUNNING', retryMs: 2_000 });
    expect(chain.state.sent).toEqual([txs[0]]);
    // Pass 3: still unknown (a sent transaction stays unknown until processed); the group's budget is short now (30 < 75) but the blockhash
    // is valid (120 ≤ 150): it may still land, so the group stays SUBMITTED (never FAILED with nothing reconciled) and at most the SAME bytes go again.
    chain.state.confirmed = 120;
    expect(await userFundedPass(deps(), mem.run())).toMatchObject({ state: 'RUNNING', retryMs: 2_000 });
    expect(mem.group().state).toBe('SUBMITTED');
    expect(mem.run().state).toBe('RUNNING');
    expect(mem.steps().map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED', 'DELEGATED']);
    expect(new Set(chain.state.sent)).toEqual(new Set([txs[0]]));
    expect(mem.writes).toEqual(['group:SUBMITTED']);
  });

  it('a concurrent pass that submitted the group first wins: a late SHORT read never blocks it nor fails the run while its send may be in flight', async () => {
    const { mem, chain, deps } = await setup();
    chain.state.confirmed = 110;
    // Between this pass's height read and its write, another pass (which read the budget a moment earlier) moved the group to SUBMITTED.
    chain.state.onHeight = () => { chain.state.onHeight = null; mem.setGroup({ state: 'SUBMITTED', submission: { kind: 'SOLANA_SIGN_ALL', hashes: ['sig0', 'sig1', 'sig2'] } }); };
    expect(await userFundedPass(deps(), mem.run())).toMatchObject({ state: 'RUNNING', progressed: true });
    expect(mem.group().state).toBe('SUBMITTED');
    expect(mem.steps().map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED', 'DELEGATED']);
    expect(mem.run()).toMatchObject({ state: 'RUNNING', version: 7 });
    expect(mem.writes).toEqual([]);
  });
});

describe('review fix R1: run expiry never blocks a batch the owner\'s wallet may still confirm, and never a group that moved on', () => {
  const EVM = 'eip155:42161', EOA = '0x' + '1a'.repeat(20);
  /** A run past its window at a single group of two grouped steps (an EVM wallet batch unless patched). */
  function expired(patch: Partial<GroupRecord>) {
    const run = { runId: 'wfr_' + 'q'.repeat(26), handoffId: 'h', requester: { kind: 'MCP', ref: 'r' }, owner: { namespace: 'eip155', address: EOA }, wallets: { eip155: EOA },
      strategy: {}, workflowHash: '0x', engineVersion: 'test', stepCount: 2, mode: 'USER_FUNDED', state: 'RUNNING', currentStep: 0, authorizationId: null, code: null,
      completedAt: null, expiresAt: new Date(NOW.getTime() - 60_000), version: 7, createdAt: NOW, updatedAt: NOW } as unknown as RunRecord;
    const group = { runId: run.runId, groupIndex: 0, namespace: 'eip155', chain: EVM, feePayer: EOA, stepFrom: 0, stepTo: 1, strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE',
      awaitsDelivery: null, state: 'PREPARED', prepared: { kind: 'EVM_WALLET_BATCH', group: { calls: [] }, request: { id: '0x' + 'cd'.repeat(32) } }, authorization: null,
      submission: null, outcome: null, code: null, validUntil: new Date(NOW.getTime() + 120_000), version: 3, updatedAt: NOW, ...patch } as GroupRecord;
    const mem = memoryStore(run, group, ['DELEGATED', 'DELEGATED']), logs: string[] = [];
    const deps: UserFundedPassDeps = { store: mem.store, userFunded: null, now: () => NOW, log: event => { logs.push(event); },
      confirmPass: async () => { throw new Error('UNEXPECTED_CONFIRM_PASS'); } };
    return { mem, deps, logs };
  }

  it('a wallet batch still inside its validity at the run\'s expiry stays PREPARED (its answer must still be taken): nothing is written; looked at again at its validUntil', async () => {
    const { mem, deps } = expired({});
    expect(await userFundedPass(deps, mem.run())).toEqual({ state: 'RUNNING', code: 'OWNER_SIGNS_GROUP', retryMs: 120_000, progressed: false });
    expect(mem.writes).toEqual([]);
    expect(mem.group().state).toBe('PREPARED');
  });

  it('an AUTHORIZED wallet batch (the wallet already sent it) is never blocked for expiry: FloFi waits for its hashes', async () => {
    const { mem, deps } = expired({ state: 'AUTHORIZED', authorization: { kind: 'EVM_WALLET_BATCH', batchId: '0x' + 'cd'.repeat(32) } });
    expect(await userFundedPass(deps, mem.run())).toMatchObject({ state: 'RUNNING', code: 'OWNER_REPORTS_BATCH' });
    expect(mem.writes).toEqual([]);
  });

  it('once its validity passed it is blocked, and the run HALTS (the batch may have executed, its answer lost): never FAILED; a group never handed out FAILS', async () => {
    const handed = expired({ validUntil: new Date(NOW.getTime() - 1_000) });
    expect(await userFundedPass(handed.deps, handed.mem.run())).toMatchObject({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED' });
    // Round 4 F1: the group and its steps say the batch's outcome is unknown (never the bare expiry, which surfaces word as "not run"); the run
    // keeps the reason it stopped.
    expect(handed.mem.group()).toMatchObject({ state: 'BLOCKED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' });
    expect(handed.mem.steps().map(s => [s.state, s.code])).toEqual([['BLOCKED', 'WALLET_BATCH_OUTCOME_UNKNOWN'], ['BLOCKED', 'WALLET_BATCH_OUTCOME_UNKNOWN']]);
    expect(handed.mem.run()).toMatchObject({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED' });
    expect(handed.mem.writes).toEqual(['group:BLOCKED', 'step0:BLOCKED', 'step1:BLOCKED', 'run:HALTED']);
    expect(handed.logs).toEqual(['workflow_run.group_blocked']);
    // A group whose earlier batches were handed out (kept for reconciliation while it waits to be prepared again) is just as unknown.
    const history = expired({ state: 'PLANNED', prepared: { kind: 'EVM_WALLET_BATCH', superseded: [{ group: { calls: [] }, fromBlock: null }] }, validUntil: null });
    expect(await userFundedPass(history.deps, history.mem.run())).toMatchObject({ state: 'HALTED', code: 'WORKFLOW_RUN_EXPIRED' });
    expect(history.mem.steps().map(s => s.code)).toEqual(['WALLET_BATCH_OUTCOME_UNKNOWN', 'WALLET_BATCH_OUTCOME_UNKNOWN']);
    const never = expired({ state: 'PLANNED', prepared: null, validUntil: null });
    expect(await userFundedPass(never.deps, never.mem.run())).toMatchObject({ state: 'FAILED', code: 'WORKFLOW_RUN_EXPIRED' });
    expect(never.mem.group()).toMatchObject({ state: 'BLOCKED', code: 'WORKFLOW_RUN_EXPIRED' });
    expect(never.mem.steps().map(s => [s.state, s.code])).toEqual([['BLOCKED', 'WORKFLOW_RUN_EXPIRED'], ['BLOCKED', 'WORKFLOW_RUN_EXPIRED']]);
  });

  it('an authorization that lands between the pass\'s read and its write is never blocked (only from the state and version the pass read)', async () => {
    // A user operation the owner signs just as the run expires: the expired pass read it PREPARED; the signature is recorded first.
    const { mem, deps } = expired({ strategy: 'EVM_USER_OPERATION', prepared: { kind: 'EVM_USER_OPERATION' }, validUntil: new Date(NOW.getTime() + 3_600_000) });
    mem.beforeGroupWrite({ state: 'AUTHORIZED', authorization: { kind: 'EVM_USER_OPERATION', signature: '0x' } });
    expect(await userFundedPass(deps, mem.run())).toMatchObject({ state: 'RUNNING', progressed: true });
    expect(mem.group()).toMatchObject({ state: 'AUTHORIZED', code: null });
    expect(mem.steps().map(s => s.state)).toEqual(['DELEGATED', 'DELEGATED']);
    expect(mem.run()).toMatchObject({ state: 'RUNNING', version: 7 });
    expect(mem.writes).toEqual([]);
  });

  it('a same-state rewrite that lands between the read and the write (a batch prepared again in place) is never blocked', async () => {
    const { mem, deps } = expired({ validUntil: new Date(NOW.getTime() - 1_000) });
    mem.beforeGroupWrite({ validUntil: new Date(NOW.getTime() + 600_000) });
    expect(await userFundedPass(deps, mem.run())).toMatchObject({ state: 'RUNNING', progressed: true });
    expect(mem.group()).toMatchObject({ state: 'PREPARED', version: 4 });
    expect(mem.writes).toEqual([]);
  });

  it('the run\'s version moved after the pass read it (a status poll): once the group is blocked, the run still stops — from its CURRENT version', async () => {
    for (const [patch, to] of [[{ validUntil: new Date(NOW.getTime() - 1_000) }, 'HALTED'], [{ state: 'PLANNED', prepared: null, validUntil: null }, 'FAILED']] as const) {
      const { mem, deps, logs } = expired(patch as Partial<GroupRecord>);
      const read = mem.run();
      // The run moves on (same state, a new version) between this pass's read and its group write.
      const store = { ...mem.store, groupTransition: async (...args: Parameters<WorkflowRunStore['groupTransition']>) => {
        mem.setRun({ version: mem.run().version + 1 });
        return mem.store.groupTransition(...args);
      } } as WorkflowRunStore;
      expect(await userFundedPass({ ...deps, store }, read)).toMatchObject({ state: to, code: 'WORKFLOW_RUN_EXPIRED' });
      // Never a blocked group and blocked steps under a run left RUNNING (nothing would ever move it again).
      expect(mem.group().state).toBe('BLOCKED');
      expect(mem.steps().map(s => s.state)).toEqual(['BLOCKED', 'BLOCKED']);
      expect(mem.run()).toMatchObject({ state: to, code: 'WORKFLOW_RUN_EXPIRED', version: read.version + 2 });
      expect(mem.writes).toEqual(['group:BLOCKED', 'step0:BLOCKED', 'step1:BLOCKED', `run:${to}`]);
      expect(logs).toEqual(['workflow_run.group_blocked']);
    }
  });

  it('a run that ended meanwhile (cancelled) is never moved again by the pass that blocked its group', async () => {
    const { mem, deps } = expired({ validUntil: new Date(NOW.getTime() - 1_000) });
    const read = mem.run();
    const store = { ...mem.store, groupTransition: async (...args: Parameters<WorkflowRunStore['groupTransition']>) => {
      mem.setRun({ state: 'CANCELLED', version: mem.run().version + 1 });
      return mem.store.groupTransition(...args);
    } } as WorkflowRunStore;
    expect(await userFundedPass({ ...deps, store }, read)).toMatchObject({ state: 'RUNNING', progressed: true });
    expect(mem.run()).toMatchObject({ state: 'CANCELLED', version: read.version + 1 });
    expect(mem.writes).toEqual(['group:BLOCKED', 'step0:BLOCKED', 'step1:BLOCKED']);
  });
});
