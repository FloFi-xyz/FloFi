// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the EVM transfer store's Execute against the real transfer service on the MOCKED in-process
 * chain (server actions delegate to it), with a scripted EIP-1193 owner wallet. After the owner's one wallet confirmation the store keeps
 * observing (read-only) until the transfer's outcome is final, without a manual "Check confirmation"; a reload with a submitted transfer resumes
 * that follow; nothing is ever begun, handed off or sent again. Loopback only: the chain is an in-process model and nothing is broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createNativeTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { HookHarness } from '../test-utils/hook-harness';
import { createRobinhoodTransferChain, TRANSFER_OWNER, type TransferChain } from '../../e2e/robinhood-transfer-harness.mjs';
import { createRobinhoodTransferService, type RobinhoodTransferService, type TransferRecord } from '../server/robinhood-transfer-service';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
type Observed = { ok: true; value: TransferRecord } | { ok: false; code: string };
const f = vi.hoisted(() => ({
  workflow: null as unknown, service: null as unknown, provider: null as unknown, owner: '',
  /** Delays the shared observation schedule asked for (the real loop runs; only its waiting is skipped). */
  sleeps: [] as number[],
  calls: { begin: 0, handoff: 0, report: [] as string[], observe: 0, failure: 0 },
  /** Runs after every real observation (the test chain mines a block per observation). */
  afterObserve: null as (() => Promise<unknown> | void) | null,
  /** A scripted answer for the next observation instead of the service's. */
  nextObserve: [] as Observed[],
  /** No connected wallet session (`wallet.session()` answers null), and how often the wallet selector was opened (`wallet.connect()`). */
  noSession: false, connects: 0,
}));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ runtimeWorkflow: f.workflow }) }));
vi.mock('./build009-wallet-store', () => ({
  useBuild009Wallet: () => ({ account: f.owner, chainId: '0xb626', session: async () => f.noSession ? null : ({ account: f.owner, chainId: '0xb626' }),
    connect: async () => { f.connects++; return null; }, switchTo: async () => undefined }),
  injected: () => f.provider,
}));
vi.mock('../domain/observation-schedule', async original => {
  const real = await original<typeof import('../domain/observation-schedule')>();
  return { ...real, observeUntilSettled: <T,>(observe: () => Promise<T>, settled: (value: T) => boolean, options: { readonly active?: () => boolean } = {}) =>
    real.observeUntilSettled(observe, settled, { ...options, sleep: async ms => { f.sleeps.push(ms); await new Promise(resolve => setTimeout(resolve, 0)); } }) };
});
vi.mock('../app/robinhood-transfer-action', () => {
  const svc = () => f.service as RobinhoodTransferService;
  const wrap = async <T,>(work: () => Promise<T>) => { try { return { ok: true as const, value: await work() }; } catch (cause) { return { ok: false as const, code: (cause as Error).message }; } };
  return {
    transferSimulate: (workflow: SemanticWorkflow, account: string) => wrap(() => svc().simulate(workflow, account)),
    transferReview: (id: string, commitment: string, workflow: SemanticWorkflow) => wrap(() => svc().review(id, commitment, workflow)),
    transferInvalidate: (id: string) => wrap(() => svc().invalidate(id)),
    transferRecoverReview: (id: string) => wrap(() => svc().recoverReview(id)),
    transferBegin: (id: string, account: string, workflow: SemanticWorkflow) => { f.calls.begin++; return wrap(() => svc().begin(id, account, workflow)); },
    transferHandoff: (id: string) => { f.calls.handoff++; return wrap(() => svc().handoff(id)); },
    transferReport: (id: string, result: Parameters<RobinhoodTransferService['report']>[1]) => { f.calls.report.push(result.kind); return wrap(() => svc().report(id, result)); },
    transferWalletFailure: (id: string, diagnostic: Parameters<RobinhoodTransferService['walletFailure']>[1]) => { f.calls.failure++; return wrap(() => svc().walletFailure(id, diagnostic)); },
    transferObserve: async (id: string) => {
      f.calls.observe++;
      const scripted = f.nextObserve.shift(); if (scripted) return scripted;
      const observed = await wrap(() => svc().observe(id)); await f.afterObserve?.(); return observed;
    },
    transferStatus: (id: string) => wrap(() => svc().load(id)),
  };
});
// Imported after the mocks.
const { RobinhoodTransferProvider, useRobinhoodTransfer, transferFollowSettled, transferFollowable } = await import('./robinhood-transfer-store');

const POINTER = 'gryloo:rh-demo-001:transfer';
const workflow = (): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'rh-follow', revision: 1, resourceEdges: [],
  nodes: [createNativeTransferNode('node-002', { chain: 'eip155:46630', amount: '1000000000000', recipient: 'CONNECTED_OWNER' })] });
let host: HookHarness, store: ReturnType<typeof useRobinhoodTransfer>, chain: TransferChain, values: Map<string, string>;
/** Every wallet request method, in order: the proof that `eth_sendTransaction` happens exactly once. */
const requests: string[] = [];
/** `awaiting`: the submitted transfer still needs its confirmations when the wallet returns the hash (the chain then mines one block per observation). */
const wallet = { awaiting: false };
/** Each distinct (run, attempt state, error) the store presented, in order. */
const shown: string[] = [];
function Probe() {
  store = useRobinhoodTransfer();
  const r = store.record, entry = r ? `${r.id.slice(0, 4)}:${r.attempt?.state ?? 'none'}:${r.verdict}:${r.error ?? ''}` : 'none';
  if (shown.at(-1) !== entry) shown.push(entry);
  return null;
}
const read = () => host.render(() => renderToStaticMarkup(<RobinhoodTransferProvider><Probe/></RobinhoodTransferProvider>));
async function settle(rounds = 20) { for (let i = 0; i < rounds; i++) { await new Promise(resolve => setTimeout(resolve, 0)); read(); } }
/** Runs one store action, rendering on every turn until it finished (so each record the store presented is seen), then settles. */
async function act(action: () => Promise<void>) {
  let finished = false; const done = action().finally(() => { finished = true; });
  while (!finished) { await new Promise(resolve => setTimeout(resolve, 0)); read(); }
  await done; await settle();
}
/** Renders until `check` holds (bounded by time, not turns, so a loaded CI machine does not cut a slow but correct follow short). */
async function until(check: () => boolean) { const deadline = Date.now() + 15_000; while (!check() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 2)); read(); } read(); }
const sends = () => requests.filter(method => method === 'eth_sendTransaction').length;
const mineOnObserve = () => { f.afterObserve = () => chain.rpc('MOCK_mine', [1]); };

beforeEach(async () => {
  host = new HookHarness(); requests.length = 0; shown.length = 0; wallet.awaiting = false;
  f.sleeps = []; f.calls = { begin: 0, handoff: 0, report: [], observe: 0, failure: 0 }; f.afterObserve = null; f.nextObserve = []; f.noSession = false; f.connects = 0;
  f.owner = TRANSFER_OWNER;
  chain = createRobinhoodTransferChain();
  f.service = createRobinhoodTransferService({ rpc: chain.rpc, journalDir: await mkdtemp(join(tmpdir(), 'flofi-transfer-store-')), provenance: 'MOCKED' });
  f.workflow = workflow();
  f.provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    requests.push(method);
    if (method === 'eth_accounts') return [TRANSFER_OWNER];
    if (method === 'eth_chainId') return '0xb626';
    if (method === 'eth_getTransactionCount') return chain.rpc('eth_getTransactionCount', params);
    if (method === 'eth_sendTransaction') {
      const hash = await chain.rpc('MOCK_submit', [params[0]]);
      // The model mines the transfer with its confirmations at once; `awaiting` leaves it in its block, still awaiting two confirmations.
      if (wallet.awaiting) chain.state.block -= 3;
      return hash;
    }
    throw new Error('MOCK_WALLET_METHOD_DENIED');
  } };
  values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) } });
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

async function authorized() {
  read(); await settle();
  await act(() => store.simulate());
  await act(() => store.review());
  expect(store.record?.authorization).toBe(store.record?.review.commitment);
  expect(store.retired).toBe(false);
}
/** A transfer the wallet sent before the browser closed: the server holds it as SUBMITTING, only the browser pointer knows its hash. */
async function sentBeforeReload() {
  const service = f.service as RobinhoodTransferService, w = f.workflow as SemanticWorkflow;
  const simulated = await service.simulate(w, TRANSFER_OWNER), record = await service.review(simulated.id, simulated.review.commitment, w);
  const begun = await service.begin(record.id, TRANSFER_OWNER, w); await service.handoff(record.id);
  const hash = await chain.rpc('MOCK_submit', [begun.transaction]) as string; chain.state.block -= 3;
  values.set(POINTER, JSON.stringify({ id: record.id, hash }));
  return { id: record.id, hash };
}

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the transfer is followed to its final outcome after one wallet confirmation', () => {
  it('keeps observing read-only until the transfer is reconciled, with no further owner action and one wallet submission', async () => {
    await authorized();
    wallet.awaiting = true; mineOnObserve();
    await act(() => store.execute());
    // Two observations still awaited confirmations; the third reconciled. Nobody clicked "Check confirmation" (store.observe was never called).
    expect(f.calls.observe).toBe(3);
    expect(f.sleeps).toEqual([2_000, 2_000]);
    expect(store.record).toMatchObject({ verdict: 'RECONCILED', error: null, attempt: { state: 'CONFIRMED', reconciled: true } });
    expect(store.record?.evidence?.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(shown.filter(entry => entry.endsWith(':PENDING:PENDING:AWAITING_CONFIRMATIONS'))).toHaveLength(1);
    expect(shown.at(-1)).toMatch(/:CONFIRMED:RECONCILED:$/);
    expect(store).toMatchObject({ busy: false, error: null, signing: false });
    // Strictly read-only after the hash: one begin, one hand-off, one HASH report, one wallet submission.
    expect(sends()).toBe(1);
    expect(f.calls).toMatchObject({ begin: 1, handoff: 1, report: ['HASH'], failure: 0 });
    expect(chain.transactions).toHaveLength(1);
  });

  it('a transfer that confirms at once is reconciled by the first observation and not followed further', async () => {
    await authorized();
    await act(() => store.execute());
    expect(f.calls.observe).toBe(1);
    expect(f.sleeps).toEqual([]);
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(sends()).toBe(1);
  });

  it('stops on a divergent verdict (reverted transfer) and never resends', async () => {
    await authorized();
    chain.state.fault = 'revert';
    await act(() => store.execute());
    expect(store.record).toMatchObject({ verdict: 'DIVERGENT', attempt: { state: 'REVERTED' } });
    expect(f.calls.observe).toBe(1);
    expect(sends()).toBe(1);
    expect(f.calls.begin).toBe(1);
  });

  it('a failed follow keeps the honest pending transfer, says it is unknown (never "nothing sent"), and the manual check still works', async () => {
    await authorized();
    wallet.awaiting = true;
    f.nextObserve = [{ ok: false, code: 'TRANSFER_SERVICE_UNAVAILABLE' }];
    await act(() => store.execute());
    expect(f.calls.observe).toBe(1);
    expect(store.error).toBe('TRANSFER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING');
    expect(store.record?.attempt).toMatchObject({ state: 'PENDING', reconciled: false });
    expect(store.record?.attempt?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The existing manual check stays available; it is only unnecessary in the normal case.
    chain.state.block += 2;
    await act(() => store.observe());
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(store.error).toBeNull();
    expect(sends()).toBe(1);
    expect(f.calls.begin).toBe(1);
  });

  it('a simulation FloFi starts by itself never opens the wallet selector; the owner\'s own Simulate still does (final wallet-execution review)', async () => {
    read(); await settle();
    f.noSession = true;
    await act(() => store.simulate({ interactive: false }));
    expect(f.connects).toBe(0);
    expect(store.error).toBe('TRANSFER_WALLET_REQUIRED');
    expect(store.record).toBeNull();
    expect(requests).toEqual([]);
    // The owner's own click asks for the wallet as before (the double declines).
    await act(() => store.simulate());
    expect(f.connects).toBe(1);
    expect(store.error).toBe('TRANSFER_WALLET_REQUIRED');
    // With a connected session the non-interactive simulation proceeds read-only.
    f.noSession = false;
    await act(() => store.simulate({ interactive: false }));
    expect(f.connects).toBe(1);
    expect(store.error).toBeNull();
    expect(store.record?.review.commitment).toBeTruthy();
    expect(sends()).toBe(0);
  });

  it('a classified observation code keeps its own meaning', async () => {
    await authorized();
    wallet.awaiting = true;
    f.nextObserve = [{ ok: false, code: 'TRANSFER_RPC_RATE_LIMITED' }];
    await act(() => store.execute());
    expect(store.error).toBe('TRANSFER_RPC_RATE_LIMITED');
    expect(store.record?.attempt?.state).toBe('PENDING');
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: a reload with a submitted transfer resumes the follow', () => {
  it('reports the saved hash once, then follows read-only until reconciled; nothing is begun, handed off or sent', async () => {
    const { id, hash } = await sentBeforeReload();
    mineOnObserve();
    read(); await until(() => store.record?.verdict === 'RECONCILED');
    expect(store.record).toMatchObject({ id, verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: true } });
    expect(f.calls.report).toEqual(['HASH']);
    expect(f.calls.observe).toBe(3);
    expect(f.sleeps).toEqual([2_000, 2_000]);
    expect(f.calls).toMatchObject({ begin: 0, handoff: 0, failure: 0 });
    expect(requests).toEqual([]);
    expect(chain.transactions).toHaveLength(1);
  });

  it('a recovered run that is already final, or has no hash, is not followed', async () => {
    const { id } = await sentBeforeReload();
    chain.state.block += 2; await (f.service as RobinhoodTransferService).report(id, { kind: 'HASH', hash: JSON.parse(values.get(POINTER)!).hash });
    await (f.service as RobinhoodTransferService).observe(id);
    read(); await settle();
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(f.calls.observe).toBe(0);
    // An uncertain request without a hash stays for the explicit observation (the e2e lost-response contract), not an automatic follow.
    host.unmount(); host = new HookHarness();
    const service = f.service as RobinhoodTransferService, w = f.workflow as SemanticWorkflow;
    const simulated = await service.simulate(w, TRANSFER_OWNER), second = await service.review(simulated.id, simulated.review.commitment, w);
    await service.begin(second.id, TRANSFER_OWNER, w); await service.handoff(second.id); await service.report(second.id, { kind: 'UNKNOWN' });
    values.set(POINTER, JSON.stringify({ id: second.id }));
    read(); await settle();
    expect(store.record).toMatchObject({ id: second.id, attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null } });
    expect(f.calls.observe).toBe(0);
  });

  it('stops following when the provider unmounts', async () => {
    await sentBeforeReload();
    read(); await until(() => f.calls.observe >= 2);
    host.unmount();
    const seen = f.calls.observe;
    await settle(40);
    expect(f.calls.observe).toBeLessThanOrEqual(seen + 1);
    const after = f.calls.observe;
    await settle(40);
    expect(f.calls.observe).toBe(after);
    expect(requests).toEqual([]);
  });

  it('never replaces a newer run with the followed run\'s observation', async () => {
    const { id } = await sentBeforeReload();
    read(); await until(() => f.calls.observe >= 1);
    expect(store.record?.id).toBe(id);
    // The owner starts a new, separate transfer while the earlier one is still being followed (a pending transfer never blocks a new simulation).
    await act(() => store.simulate());
    const newer = store.record!;
    expect(newer.id).not.toBe(id);
    const seen = f.calls.observe;
    await settle(40);
    expect(store.record?.id).toBe(newer.id);
    expect(f.calls.observe).toBeLessThanOrEqual(seen + 1);
    expect(requests.filter(method => method === 'eth_sendTransaction')).toEqual([]);
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the follow stops on every final verdict', () => {
  const base = { verdict: 'PENDING', notSubmitted: undefined, attempt: { state: 'PENDING', reconciled: false, transactionHash: '0x' + 'a'.repeat(64) } };
  const record = (patch: { verdict?: string; notSubmitted?: boolean; attempt?: Record<string, unknown> | null }) =>
    ({ ...base, ...patch, attempt: patch.attempt === null ? null : { ...base.attempt, ...patch.attempt } }) as unknown as TransferRecord;
  it('keeps following a submitted transfer without a final outcome', () => {
    for (const state of ['PENDING', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN']) expect(transferFollowSettled(record({ attempt: { state } }))).toBe(false);
    expect(transferFollowable(record({}))).toBe(true);
    expect(transferFollowable(record({ attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null } }))).toBe(false);
  });
  it('stops on reconciled, failed, reverted, divergent, cancelled and not-submitted outcomes', () => {
    expect(transferFollowSettled(record({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', reconciled: true } }))).toBe(true);
    expect(transferFollowSettled(record({ verdict: 'DIVERGENT', attempt: { state: 'REVERTED' } }))).toBe(true);
    expect(transferFollowSettled(record({ verdict: 'DIVERGENT', attempt: { state: 'RECONCILIATION_REQUIRED' } }))).toBe(true);
    // A divergence recorded while the attempt still read PENDING (e.g. a relayed duplicate) is final too.
    expect(transferFollowSettled(record({ verdict: 'DIVERGENT' }))).toBe(true);
    expect(transferFollowSettled(record({ attempt: { state: 'CANCELLED', transactionHash: null } }))).toBe(true);
    expect(transferFollowSettled(record({ attempt: { state: 'NOT_FOUND', transactionHash: null } }))).toBe(true);
    expect(transferFollowSettled(record({ notSubmitted: true, attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null } }))).toBe(true);
    expect(transferFollowSettled(record({ attempt: null }))).toBe(true);
    expect(transferFollowable(record({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', reconciled: true } }))).toBe(false);
  });
});
