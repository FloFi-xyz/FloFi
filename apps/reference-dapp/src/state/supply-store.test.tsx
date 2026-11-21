// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the Aave lending store's Execute against the real supply service on the MOCKED in-process
 * Aave model (server actions delegate to it), with a scripted EIP-1193 owner wallet. After the owner's one wallet confirmation the store keeps
 * observing (read-only) until the request's outcome is final, without a manual "Check confirmation"; a reload with a submitted request resumes
 * that follow; nothing is ever begun, handed off or sent again (a reconciled approval never starts the Supply by itself). Loopback only: the
 * chain is an in-process model and nothing is broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSupplyNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { AAVE_V3_BASE_SEPOLIA as p } from '@defi-workflow-engine/action-registry';
import { HookHarness } from '../test-utils/hook-harness';
import { supplyModel, SUPPLY_OWNER } from '../../e2e/supply-fixtures';
import { createSupplyService, type SupplyRecord, type SupplyService } from '../server/supply-service';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
type Observed = { ok: true; value: SupplyRecord } | { ok: false; code: string };
const f = vi.hoisted(() => ({
  workflow: null as unknown, service: null as unknown, provider: null as unknown, owner: '', chain: '',
  /** Delays the shared observation schedule asked for (the real loop runs; only its waiting is skipped). */
  sleeps: [] as number[],
  calls: { begin: 0, handoff: 0, report: [] as string[], observe: 0, failure: 0 },
  /** Runs after every real observation (the test model mines a block per observation). */
  afterObserve: null as (() => void) | null,
  /** A scripted answer for the next observation instead of the service's. */
  nextObserve: [] as Observed[],
}));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ runtimeWorkflow: f.workflow }) }));
vi.mock('./build009-wallet-store', () => ({
  useBuild009Wallet: () => ({ account: f.owner, chainId: f.chain, session: async () => ({ account: f.owner, chainId: f.chain }), connect: async () => null,
    switchTo: async () => undefined }),
  injected: () => f.provider,
}));
vi.mock('../domain/observation-schedule', async original => {
  const real = await original<typeof import('../domain/observation-schedule')>();
  return { ...real, observeUntilSettled: <T,>(observe: () => Promise<T>, settled: (value: T) => boolean, options: { readonly active?: () => boolean } = {}) =>
    real.observeUntilSettled(observe, settled, { ...options, sleep: async ms => { f.sleeps.push(ms); await new Promise(resolve => setTimeout(resolve, 0)); } }) };
});
vi.mock('../app/supply-action', () => {
  const svc = () => f.service as SupplyService;
  const wrap = async <T,>(work: () => Promise<T>) => { try { return { ok: true as const, value: await work() }; } catch (cause) { return { ok: false as const, code: (cause as Error).message }; } };
  type Step = Parameters<SupplyService['report']>[1];
  return {
    supplySimulate: (workflow: SemanticWorkflow, account: string) => wrap(() => svc().simulate(workflow, account)),
    supplyReview: (id: string, commitment: string, workflow: SemanticWorkflow) => wrap(() => svc().review(id, commitment, workflow)),
    supplyInvalidate: (id: string) => wrap(() => svc().invalidate(id)),
    supplyRecoverReview: (id: string) => wrap(() => svc().recoverReview(id)),
    supplyBegin: (id: string, account: string, workflow: SemanticWorkflow) => { f.calls.begin++; return wrap(() => svc().begin(id, account, workflow)); },
    supplyHandoff: (id: string, step: Step, walletManagedNonce?: boolean) => { f.calls.handoff++; return wrap(() => svc().handoff(id, step, walletManagedNonce)); },
    supplyReport: (id: string, step: Step, result: Parameters<SupplyService['report']>[2]) => { f.calls.report.push(result.kind); return wrap(() => svc().report(id, step, result)); },
    supplyWalletFailure: (id: string, diagnostic: Parameters<SupplyService['walletFailure']>[1]) => { f.calls.failure++; return wrap(() => svc().walletFailure(id, diagnostic)); },
    supplyWalletTrace: (id: string, diagnostic: Parameters<SupplyService['walletTrace']>[1]) => wrap(() => svc().walletTrace(id, diagnostic)),
    supplyObserve: async (id: string) => {
      f.calls.observe++;
      const scripted = f.nextObserve.shift(); if (scripted) return scripted;
      const observed = await wrap(() => svc().observe(id)); f.afterObserve?.(); return observed;
    },
    supplyStatus: (id: string) => wrap(() => svc().load(id)),
  };
});
// Imported after the mocks.
const { SupplyProvider, useSupply, supplyFollowSettled, supplyFollowable } = await import('./supply-store');

const POINTER = 'gryloo:build012a:supply';
const workflow = (): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'supply-follow', revision: 1, resourceEdges: [],
  nodes: [createSupplyNode('supply', { chain: p.chain, asset: { chainId: p.chain, address: p.asset, decimals: 6 }, amount: '10000000', beneficiary: SUPPLY_OWNER })] });
let host: HookHarness, store: ReturnType<typeof useSupply>, model: ReturnType<typeof supplyModel>, values: Map<string, string>;
/** Every wallet request method, in order: the proof that `eth_sendTransaction` happens exactly once per owner confirmation. */
const requests: string[] = [];
/** `awaiting`: the submitted request still needs its confirmations when the wallet returns the hash (the model then mines one block per observation). */
const wallet = { awaiting: false };
/** Each distinct (run, attempt states, error) the store presented, in order. */
const shown: string[] = [];
function Probe() {
  store = useSupply();
  const r = store.record, entry = r ? `${r.attempts.map(a => `${a.step}=${a.state}`).join(',')}:${r.verdict}:${r.error ?? ''}` : 'none';
  if (shown.at(-1) !== entry) shown.push(entry);
  return null;
}
const read = () => host.render(() => renderToStaticMarkup(<SupplyProvider><Probe/></SupplyProvider>));
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
const mineOnObserve = () => { f.afterObserve = () => { model.state.block += 1; }; };

beforeEach(async () => {
  host = new HookHarness(); requests.length = 0; shown.length = 0; wallet.awaiting = false;
  f.sleeps = []; f.calls = { begin: 0, handoff: 0, report: [], observe: 0, failure: 0 }; f.afterObserve = null; f.nextObserve = [];
  f.owner = SUPPLY_OWNER; f.chain = p.chainHex;
  model = supplyModel();
  f.service = createSupplyService({ rpc: model.rpc, journalDir: await mkdtemp(join(tmpdir(), 'flofi-supply-store-')), provenance: 'MOCKED' });
  f.workflow = workflow();
  f.provider = { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    requests.push(method);
    if (method === 'eth_accounts') return [SUPPLY_OWNER];
    if (method === 'eth_chainId') return p.chainHex;
    if (method === 'eth_getTransactionCount') return model.rpc('eth_getTransactionCount', params);
    if (method === 'eth_sendTransaction') {
      // The wallet assigns the reviewed nonce, as MetaMask does.
      const assigned = { ...params[0] as Record<string, string>, nonce: await model.rpc('eth_getTransactionCount', [SUPPLY_OWNER, 'pending']) };
      const hash = await model.rpc('MOCK_submit', [assigned]);
      // The model mines the request with its confirmations at once; `awaiting` leaves it in its block, still awaiting two confirmations.
      if (wallet.awaiting) model.state.block -= 2;
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
/** A Supply the wallet sent before the browser closed: the server holds it as SUBMITTING, only the browser pointer knows its hash. */
async function sentBeforeReload() {
  const service = f.service as SupplyService, w = f.workflow as SemanticWorkflow;
  model.state.allowance = 10_000_000n;
  const simulated = await service.simulate(w, SUPPLY_OWNER), record = await service.review(simulated.id, simulated.review.commitment, w);
  const begun = await service.begin(record.id, SUPPLY_OWNER, w); await service.handoff(record.id, begun.step);
  const hash = await model.rpc('MOCK_submit', [begun.transaction]) as string; model.state.block -= 2;
  values.set(POINTER, JSON.stringify({ id: record.id, step: begun.step, hash }));
  return { id: record.id, hash };
}

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the lending request is followed to its final outcome after one wallet confirmation', () => {
  it('keeps observing read-only until the Supply is reconciled, with no further owner action and one wallet submission', async () => {
    model.state.allowance = 10_000_000n; // No approval needed: the Supply is the single wallet request.
    await authorized();
    wallet.awaiting = true; mineOnObserve();
    await act(() => store.execute());
    // Two observations still awaited confirmations; the third reconciled. Nobody clicked "Check confirmation" (store.observe was never called).
    expect(f.calls.observe).toBe(3);
    expect(f.sleeps).toEqual([2_000, 2_000]);
    expect(store.record).toMatchObject({ verdict: 'RECONCILED', error: null, attempts: [{ step: 'SUPPLY', state: 'CONFIRMED', reconciled: true }] });
    expect(store.record?.evidence?.bundle.environment).toBe('MOCKED');
    expect(shown).toContain('SUPPLY=PENDING:PENDING:AWAITING_CONFIRMATIONS');
    expect(shown.at(-1)).toBe('SUPPLY=CONFIRMED:RECONCILED:');
    expect(store).toMatchObject({ busy: false, error: null, signing: false });
    // Strictly read-only after the hash: one begin, one hand-off, one HASH report, one wallet submission.
    expect(sends()).toBe(1);
    expect(f.calls).toMatchObject({ begin: 1, handoff: 1, report: ['HASH'], failure: 0 });
    expect(model.transactions).toHaveLength(1);
  });

  it('a reconciled approval ends its own follow; the Supply after it is never started without the owner', async () => {
    await authorized();
    expect(store.record?.review.approvalRequired).toBe(true);
    wallet.awaiting = true; mineOnObserve();
    await act(() => store.execute());
    expect(f.calls.observe).toBe(3);
    expect(store.record).toMatchObject({ verdict: 'PENDING', attempts: [{ step: 'APPROVAL', state: 'CONFIRMED', reconciled: true }] });
    expect(sends()).toBe(1);
    expect(f.calls).toMatchObject({ begin: 1, handoff: 1, report: ['HASH'] });
    // The owner's next explicit Execute is the Supply's own wallet request, followed the same way.
    await act(() => store.execute());
    expect(store.record).toMatchObject({ verdict: 'RECONCILED', attempts: [{ step: 'APPROVAL', reconciled: true }, { step: 'SUPPLY', state: 'CONFIRMED', reconciled: true }] });
    expect(sends()).toBe(2);
    expect(f.calls.begin).toBe(2);
  });

  it('stops on a divergent verdict (reverted Supply) and never resends', async () => {
    model.state.allowance = 10_000_000n;
    await authorized();
    model.state.revert = true;
    await act(() => store.execute());
    expect(store.record).toMatchObject({ verdict: 'DIVERGENT', attempts: [{ step: 'SUPPLY', state: 'REVERTED' }] });
    expect(f.calls.observe).toBe(1);
    expect(sends()).toBe(1);
    expect(f.calls.begin).toBe(1);
  });

  it('a failed follow keeps the honest pending request, says it is unknown (never "nothing sent"), and the manual check still works', async () => {
    model.state.allowance = 10_000_000n;
    await authorized();
    wallet.awaiting = true;
    f.nextObserve = [{ ok: false, code: 'SUPPLY_SERVICE_UNAVAILABLE' }];
    await act(() => store.execute());
    expect(f.calls.observe).toBe(1);
    expect(store.error).toBe('SUPPLY_SUBMISSION_UNKNOWN_OBSERVE_EXISTING');
    expect(store.record?.attempts[0]).toMatchObject({ step: 'SUPPLY', state: 'PENDING', reconciled: false });
    expect(store.record?.attempts[0]?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The existing manual check stays available; it is only unnecessary in the normal case.
    model.state.block += 2;
    await act(() => store.observe());
    expect(store.record?.verdict).toBe('RECONCILED');
    expect(store.error).toBeNull();
    expect(sends()).toBe(1);
    expect(f.calls.begin).toBe(1);
  });

  it('a classified observation code keeps its own meaning', async () => {
    model.state.allowance = 10_000_000n;
    await authorized();
    wallet.awaiting = true;
    f.nextObserve = [{ ok: false, code: 'SUPPLY_RPC_RATE_LIMITED' }];
    await act(() => store.execute());
    expect(store.error).toBe('SUPPLY_RPC_RATE_LIMITED');
    expect(store.record?.attempts[0]?.state).toBe('PENDING');
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: a reload with a submitted lending request resumes the follow', () => {
  it('reports the saved hash once, then follows read-only until reconciled; nothing is begun, handed off or sent', async () => {
    const { id, hash } = await sentBeforeReload();
    mineOnObserve();
    read(); await until(() => store.record?.verdict === 'RECONCILED');
    expect(store.record).toMatchObject({ id, verdict: 'RECONCILED', attempts: [{ step: 'SUPPLY', state: 'CONFIRMED', transactionHash: hash, reconciled: true }] });
    expect(store.recovered).toBe(true);
    expect(f.calls.report).toEqual(['HASH']);
    expect(f.calls.observe).toBe(3);
    expect(f.sleeps).toEqual([2_000, 2_000]);
    expect(f.calls).toMatchObject({ begin: 0, handoff: 0, failure: 0 });
    expect(requests).toEqual([]);
    expect(model.transactions).toHaveLength(1);
  });

  it('a recovered request without a hash stays for the explicit observation (the e2e lost-response contract), not an automatic follow', async () => {
    const service = f.service as SupplyService, w = f.workflow as SemanticWorkflow;
    model.state.allowance = 10_000_000n;
    const simulated = await service.simulate(w, SUPPLY_OWNER), record = await service.review(simulated.id, simulated.review.commitment, w);
    const begun = await service.begin(record.id, SUPPLY_OWNER, w); await service.handoff(record.id, begun.step);
    await service.report(record.id, begun.step, { kind: 'UNKNOWN' });
    values.set(POINTER, JSON.stringify({ id: record.id }));
    read(); await settle();
    expect(store.record).toMatchObject({ id: record.id, attempts: [{ state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null }] });
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
    // The owner starts a new, separate simulation while the earlier request is still being followed (it never blocks a new simulation).
    await act(() => store.simulate());
    const newer = store.record!;
    expect(newer.id).not.toBe(id);
    const seen = f.calls.observe;
    await settle(40);
    expect(store.record?.id).toBe(newer.id);
    expect(f.calls.observe).toBeLessThanOrEqual(seen + 1);
    expect(sends()).toBe(0);
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the follow stops on every final verdict', () => {
  const hash = '0x' + 'a'.repeat(64);
  const record = (attempts: Record<string, unknown>[], patch: { verdict?: string; notSubmitted?: boolean } = {}) =>
    ({ verdict: 'PENDING', ...patch, attempts: attempts.map(a => ({ step: 'SUPPLY', state: 'PENDING', reconciled: false, transactionHash: hash, ...a })) }) as unknown as SupplyRecord;
  it('keeps following a submitted request without a final outcome', () => {
    for (const state of ['PENDING', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN']) expect(supplyFollowSettled(record([{ state }]), 'SUPPLY')).toBe(false);
    expect(supplyFollowable(record([{}]))).toBe(true);
    // After a reconciled approval, the Supply's own hash is followed (the server observes the first unreconciled attempt).
    expect(supplyFollowable(record([{ step: 'APPROVAL', state: 'CONFIRMED', reconciled: true }, {}]))).toBe(true);
    expect(supplyFollowable(record([{ state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null }]))).toBe(false);
  });
  it('stops on reconciled, failed, reverted, divergent, cancelled and not-submitted outcomes', () => {
    expect(supplyFollowSettled(record([{ state: 'CONFIRMED', reconciled: true }], { verdict: 'RECONCILED' }), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([{ step: 'APPROVAL', state: 'CONFIRMED', reconciled: true }]), 'APPROVAL')).toBe(true);
    expect(supplyFollowSettled(record([{ state: 'REVERTED' }], { verdict: 'DIVERGENT' }), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([{ state: 'RECONCILIATION_REQUIRED' }], { verdict: 'DIVERGENT' }), 'SUPPLY')).toBe(true);
    // A divergence recorded while the attempt still read PENDING (a replaced transaction) is final too; so is an inconclusive verdict.
    expect(supplyFollowSettled(record([{}], { verdict: 'DIVERGENT' }), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([{}], { verdict: 'INCONCLUSIVE' }), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([{ state: 'CANCELLED', transactionHash: null }]), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([{ state: 'NOT_FOUND', transactionHash: null }]), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([{ state: 'SUBMISSION_RESULT_UNKNOWN', transactionHash: null }], { notSubmitted: true }), 'SUPPLY')).toBe(true);
    expect(supplyFollowSettled(record([]))).toBe(true);
    expect(supplyFollowable(record([{ state: 'REVERTED' }], { verdict: 'DIVERGENT' }))).toBe(false);
  });
});
