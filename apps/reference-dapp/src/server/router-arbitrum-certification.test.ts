// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ARB-001 Phase 3: both existing Router directions, MOCKED owner wallet and durable restart only. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CROSSCHAIN_ROUTER_BASE_ARBITRUM, CROSSCHAIN_ROUTER_ARBITRUM_BASE, type RouterProfile } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createRouterNode, type RouterBridgeInput } from '../domain/router-authoring';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createRouterHarness, type RouterHarnessOptions } from '../../e2e/router-harness';
import { createRouterService, routerNeedsObservation, type RouterRecord } from './router-service';
import { createRouteProviders, type RouteProvider } from './router-providers';
import { routerNetworkMode } from './router-runtime';
import { flowMode, FLOWS } from '../../backend/flows';

const pairs = [CROSSCHAIN_ROUTER_BASE_ARBITRUM, CROSSCHAIN_ROUTER_ARBITRUM_BASE];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workflow(p: RouterProfile, routing: RouterBridgeInput['routing'] = 'AUTO', amount = '10'): SemanticWorkflow {
  return { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, resourceEdges: [], nodes: [createRouterNode('bridge', {
    source: p.source.chainId === 8453 ? 'Base' : 'Arbitrum', destination: p.destination.chainId === 8453 ? 'Base' : 'Arbitrum',
    token: 'USDC', amount, recipient: '', slippage: '50', routing })] };
}
function setup(p: RouterProfile, options: RouterHarnessOptions = {}) {
  const h = createRouterHarness({ profile: p, ...options }), dir = mkdtempSync(join(tmpdir(), 'flofi-arb-bridge-')); dirs.push(dir);
  const storage = createFileExecutionStorage(dir, 'ROUTER_BUSY');
  let source = h.baseRpc, destination = h.arbitrumRpc, providers = h.providers;
  const create = (enabled = true) => createRouterService({ storage, sourceRpc: (...a) => source(...a), destinationRpc: (...a) => destination(...a), providers,
    provenance: 'MOCKED', executionEnabled: enabled, now: h.clock, profile: p, mockedCodePins: h.codePins });
  const s = create();
  const send = async (id: string, w: SemanticWorkflow) => {
    const begun = await s.begin(id, h.owner, w); await s.handoff(id);
    const hash = h.wallet.send(begun.transaction); await s.report(id, { kind: 'HASH', hash }); return { begun, hash };
  };
  const deposit = async (routing: RouterBridgeInput['routing'] = 'AUTO') => {
    const w = workflow(p, routing), run = await s.simulate(w, h.owner); await s.review(run.id, run.review.commitment, w);
    await send(run.id, w); await s.observe(run.id); const result = await send(run.id, w); await s.observe(run.id);
    return { w, id: run.id, ...result };
  };
  const until = async (id: string, phase: RouterRecord['phase'], service = create()) => {
    let r = await service.load(id);
    for (let i = 0; i < 30 && r.phase !== phase; i++) { h.advance(5); r = await service.observe(id); }
    return r;
  };
  return { h, s, create, send, deposit, until,
    source: (next: typeof source) => { source = next; }, destination: (next: typeof destination) => { destination = next; },
    providers: (next: typeof providers) => { providers = next; } };
}

describe.each(pairs)('$id certification through shared Router', p => {
  it.each(['LIFI', 'ACROSS'] as const)('completes %s after restart, correlates both distinct USDC assets and reconciles idempotently', async routing => {
    const f = setup(p), { id } = await f.deposit(routing), source = await f.create().load(id);
    expect(source.source).not.toBeNull(); expect(source.evidence).toBeNull();
    expect(source.review.route.inputToken.address).not.toBe(source.review.route.outputToken.address);
    expect(source.review.artifacts.manifest.gasBudgets[0]?.maximumAmount).toBe(source.review.fees.totalUpperBoundWei);
    const done = await f.until(id, 'RECONCILED');
    expect(done).toMatchObject({ verdict: 'RECONCILED', evidence: { evidenceClass: 'MOCKED' } });
    expect(done.evidence?.transactions.map(t => t.chain)).toEqual([p.source.chain, p.source.chain, p.destination.chain]);
    expect(done.evidence?.bundle.reconciliation.fees.map(f => f.asset.chainId)).toEqual([p.source.chain, p.source.chain]);
    expect(await f.create().observe(id)).toEqual(done); expect(f.h.counters.sends).toBe(2);
  });
  it('keeps delayed destination and provider outage pending and recovers by chain logs without resending', async () => {
    const f = setup(p, { autoFillSeconds: null }), { id, w } = await f.deposit();
    f.h.controls.hint = 'down'; f.h.advance(30);
    const pending = await f.create().observe(id);
    expect(pending.verdict).toBe('PENDING'); expect(pending.evidence).toBeNull(); expect(routerNeedsObservation(pending)).toBe(true);
    await expect(f.create().begin(id, f.h.owner, w)).rejects.toThrow('ROUTER_DEPOSIT_ALREADY_CONFIRMED');
    f.h.relayer.fill(); expect((await f.until(id, 'RECONCILED')).destination?.discoveredBy).toBe('LOG_SCAN');
    expect(f.h.counters.sends).toBe(2);
  });
  it('persists destination observation before an evidence-read interruption and resumes after restart', async () => {
    const f = setup(p), { id } = await f.deposit(); f.h.advance(60); f.h.advance(15);
    f.source(async (method, params) => {
      const call = params[0] as { to?: string; data?: string };
      if (method === 'eth_call' && call.to === p.source.token && call.data?.startsWith('0x70a08231')) throw Error('MOCK_EVIDENCE_READ_INTERRUPTED');
      return f.h.baseRpc(method, params);
    });
    await expect(f.create().observe(id)).rejects.toThrow('MOCK_EVIDENCE_READ_INTERRUPTED');
    expect(await f.create().load(id)).toMatchObject({ phase: 'DESTINATION_OBSERVED', verdict: 'PENDING', evidence: null });
    f.source(f.h.baseRpc);
    expect(await f.create().observe(id)).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', evidence: { evidenceClass: 'MOCKED' } });
    expect(f.h.counters.sends).toBe(2);
  });
  it('discovers a lost source hash after restart and never prepares another ambiguous deposit', async () => {
    const f = setup(p, { autoFillSeconds: null }), w = workflow(p), run = await f.s.simulate(w, f.h.owner);
    await f.s.review(run.id, run.review.commitment, w); await f.send(run.id, w); await f.s.observe(run.id);
    const begun = await f.s.begin(run.id, f.h.owner, w); await f.s.handoff(run.id);
    const hash = f.h.wallet.send(begun.transaction); await f.s.report(run.id, { kind: 'UNKNOWN' });
    await expect(f.create().begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTER_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    expect((await f.create().observe(run.id)).source?.transactionHash).toBe(hash); expect(f.h.counters.sends).toBe(2);
  });
  it.each(['wrongRecipient', 'belowMinimum', 'aboveMaximum', 'wrongAsset', 'duplicate'] as const)('freezes a %s fill as divergent with no evidence', async mode => {
    const f = setup(p, { autoFillSeconds: null }), { id } = await f.deposit(); f.h.relayer.fill(undefined, mode);
    expect(await f.until(id, 'RECONCILIATION_REQUIRED')).toMatchObject({ verdict: 'DIVERGENT', evidence: null });
    expect(f.h.counters.sends).toBe(2);
  });
  it('a fill carrying another origin chain remains pending and never proves delivery', async () => {
    const f = setup(p, { autoFillSeconds: null }), { id } = await f.deposit(); f.h.relayer.fill(undefined, 'wrongOrigin');
    expect(await f.until(id, 'RECONCILED')).toMatchObject({ verdict: 'PENDING', destination: null, evidence: null });
    expect(f.h.counters.sends).toBe(2);
  });
  it('preserves the source recovery cursor until blocks are safe', async () => {
    const f = setup(p, { delegatedOwner: true, autoFillSeconds: null, baseSafeLagBlocks: 80 }), w = workflow(p), run = await f.s.simulate(w, f.h.owner);
    await f.s.review(run.id, run.review.commitment, w);
    const approval = await f.s.begin(run.id, f.h.owner, w); await f.s.handoff(run.id);
    await f.s.report(run.id, { kind: 'HASH', hash: f.h.wallet.sendRelayed(approval.transaction) }); await f.s.observe(run.id);
    await f.s.begin(run.id, f.h.owner, w); await f.s.handoff(run.id); await f.s.report(run.id, { kind: 'UNKNOWN' }); f.h.advance(10);
    expect((await f.create().observe(run.id)).attempts.at(-1)?.depositScanFrom).toBeUndefined();
    expect(f.h.counters.sends).toBe(1);
  });
  it('keeps checking fill proofs while waiting for a refund after the deadline', async () => {
    const f = setup(p, { autoFillSeconds: null }), { id } = await f.deposit(); f.h.relayer.fill();
    f.h.controls.hint = 'down';
    f.destination(async (method, params) => method === 'eth_getLogs' ? [] : f.h.arbitrumRpc(method, params));
    f.h.advance(7300); expect((await f.until(id, 'RECOVERY_REQUIRED')).verdict).toBe('PENDING');
    f.destination(f.h.arbitrumRpc); f.h.controls.hint = 'normal';
    expect(await f.until(id, 'RECONCILED')).toMatchObject({ verdict: 'RECONCILED', evidence: { evidenceClass: 'MOCKED' } });
    expect(f.h.counters.sends).toBe(2);
  });
  it('bounds source gas, price and OP/Nitro fees at preparation and again at handoff', async () => {
    const f = setup(p), w = workflow(p), run = await f.s.simulate(w, f.h.owner), reads: string[] = [];
    await f.s.review(run.id, run.review.commitment, w);
    const begun = await f.s.begin(run.id, f.h.owner, w);
    f.source(async (method, params) => {
      reads.push(method + JSON.stringify(params));
      if (method === 'eth_estimateGas') return '0xffffff';
      return f.h.baseRpc(method, params);
    });
    await expect(f.s.handoff(run.id)).rejects.toThrow('ROUTER_GAS_CHANGED_REVIEW_REQUIRED');
    expect(await f.s.load(run.id)).toMatchObject({ authorization: null, requote: true, attempts: [{ state: 'CANCELLED' }] });
    expect(f.h.counters.sends).toBe(0);
    expect(begun.transaction.maxFeePerGas).toBe('0x' + BigInt(run.review.fees.maxFeePerGas).toString(16));
    if (p.source.chainId === 42161) { expect(run.review.fees.l1FeeUpperBoundWei).toBe('0'); expect(reads.join()).not.toContain('420000000000000000000000000000000000000f'); }
    else expect(BigInt(run.review.fees.l1FeeUpperBoundWei!)).toBeGreaterThan(0n);
  });
  it('refuses gas-price growth before any attempt, without silently increasing the reviewed ceiling', async () => {
    const f = setup(p), w = workflow(p), run = await f.s.simulate(w, f.h.owner); await f.s.review(run.id, run.review.commitment, w);
    f.source(async (method, params) => {
      if (method === 'eth_gasPrice') return '0xfffffff';
      const value = await f.h.baseRpc(method, params);
      if (method === 'eth_getBlockByNumber' && value && typeof value === 'object') return { ...value, baseFeePerGas: '0xfffffff' };
      return value;
    });
    await expect(f.s.begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTER_FEES_CHANGED_REVIEW_REQUIRED');
    expect((await f.s.load(run.id)).attempts).toHaveLength(0); expect(f.h.counters.sends).toBe(0);
  });
  it('gate off, wrong owner and wrong route never request a wallet transaction', async () => {
    const f = setup(p), w = workflow(p), run = await f.s.simulate(w, f.h.owner); await f.s.review(run.id, run.review.commitment, w);
    await expect(f.create(false).begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTER_EXECUTION_NOT_ENABLED');
    await expect(f.s.begin(run.id, '0x' + 'a'.repeat(40), w)).rejects.toThrow('ROUTER_WRONG_OWNER');
    await expect(f.s.simulate(workflow(pairs.find(other => other !== p)!), f.h.owner)).rejects.toThrow('ROUTER_NETWORK_MISMATCH');
    const network = p.source.chainId === 8453 ? 'mainnet' : 'arbitrum-to-base';
    expect(routerNetworkMode(network, {})).toBe('off');
    expect(flowMode(p.source.chainId === 8453 ? 'crosschain-router' : 'crosschain-router-arbitrum-to-base', {})).toBe('off');
    expect(f.h.counters.sends).toBe(0);
  });
  it.each(['source', 'destination'] as const)('refuses a mismatched %s RPC chain before Review', async side => {
    const f = setup(p);
    if (side === 'source') f.source(async (method, params) => method === 'eth_chainId' ? p.destination.chainHex : f.h.baseRpc(method, params));
    else f.destination(async (method, params) => method === 'eth_chainId' ? p.source.chainHex : f.h.arbitrumRpc(method, params));
    await expect(f.create().simulate(workflow(p), f.h.owner)).rejects.toThrow(side === 'source' ? 'ROUTER_WRONG_SOURCE_CHAIN' : 'ROUTER_WRONG_DESTINATION_CHAIN');
    expect(f.h.counters.sends).toBe(0);
  });
  it('allows discovery fallback only under AUTO and invalidates provider/amount changes after Review', async () => {
    const f = setup(p); f.h.controls.lifi = 'down';
    await expect(f.s.simulate(workflow(p, 'LIFI'), f.h.owner)).rejects.toThrow('ROUTER_NO_EXECUTABLE_ROUTE');
    const w = workflow(p), run = await f.s.simulate(w, f.h.owner); expect(run.review.selection.selected).toBe('across');
    await f.s.review(run.id, run.review.commitment, w);
    await expect(f.s.begin(run.id, f.h.owner, workflow(p, 'AUTO', '11'))).rejects.toThrow('ROUTER_SEMANTIC_REVISION_CHANGED');
    const across: RouteProvider = { ...f.h.providers.across, quote: async req => ({ ...await f.h.providers.across.quote(req), routingProvider: 'lifi' }) };
    f.providers({ ...f.h.providers, across });
    await expect(f.create().begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTE_CHANGED');
    expect((await f.create().load(run.id)).authorization).toBeNull(); expect(f.h.counters.sends).toBe(0);
  });
  it('a changed approval spender invalidates the Review and cannot reach the wallet', async () => {
    const f = setup(p), w = workflow(p, 'ACROSS'), run = await f.s.simulate(w, f.h.owner); await f.s.review(run.id, run.review.commitment, w);
    const across: RouteProvider = { ...f.h.providers.across, quote: async req => {
      const route = await f.h.providers.across.quote(req), spender = '0x' + 'a'.repeat(40);
      return { ...route, approval: { ...route.approval, spender }, deposit: { ...route.deposit, to: spender } };
    } };
    f.providers({ ...f.h.providers, across });
    await expect(f.create().begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTE_CHANGED');
    expect((await f.create().load(run.id)).authorization).toBeNull(); expect(f.h.counters.sends).toBe(0);
  });
  it('an expired Review requires a fresh quote and cannot prepare an approval', async () => {
    const f = setup(p), w = workflow(p), run = await f.s.simulate(w, f.h.owner); await f.s.review(run.id, run.review.commitment, w);
    f.h.advance(p.reviewTtlSeconds + 1);
    await expect(f.s.begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTER_REVIEW_EXPIRED');
    expect(await f.s.load(run.id)).toMatchObject({ authorization: null, requote: true, attempts: [] });
    expect(f.h.counters.sends).toBe(0);
  });
  it.each(['gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce'] as const)('a wallet transaction changing %s is divergent after restart', async field => {
    const f = setup(p), w = workflow(p), run = await f.s.simulate(w, f.h.owner); await f.s.review(run.id, run.review.commitment, w);
    await f.send(run.id, w);
    f.source(async (method, params) => {
      const value = await f.h.baseRpc(method, params);
      return method === 'eth_getTransactionByHash' && value && typeof value === 'object' ? { ...value, [field]: '0xfffffff' } : value;
    });
    const done = await f.create().observe(run.id);
    expect(done).toMatchObject({ verdict: 'DIVERGENT', authorization: null, evidence: null, error: 'ROUTER_TRANSACTION_FEE_BOUNDS_MISMATCH' });
    expect(await f.create().observe(run.id)).toEqual(done); expect(f.h.counters.sends).toBe(1);
  });
  it('provider packet chain, spender, expiry and hidden fee mismatches fail closed for the selected route', async () => {
    for (const change of ['chain', 'sourceAsset', 'destinationAsset', 'spender', 'expiry', 'fees'] as const) {
      const f = setup(p);
      const providers = createRouteProviders({ profile: p, lifiApi: 'http://127.0.0.1/lifi/v1', acrossApi: 'http://127.0.0.1/across/api', http: async url => {
        const packet = await f.h.http(url) as { swapTx: { chainId: number }; checks: { allowance: { spender: string } }; quoteExpiryTimestamp: number;
          inputToken: { address: string }; outputToken: { address: string }; steps: { bridge: { fees: { amount: string } } } };
        if (change === 'chain') packet.swapTx.chainId = p.destination.chainId;
        if (change === 'sourceAsset') packet.inputToken.address = p.destination.token;
        if (change === 'destinationAsset') packet.outputToken.address = p.source.token;
        if (change === 'spender') packet.checks.allowance.spender = '0x' + 'a'.repeat(40);
        if (change === 'expiry') packet.quoteExpiryTimestamp = 1;
        if (change === 'fees') packet.steps.bridge.fees.amount = '1';
        return packet;
      } });
      f.providers(providers);
      await expect(f.create().simulate(workflow(p, 'ACROSS'), f.h.owner)).rejects.toThrow('ROUTER_NO_EXECUTABLE_ROUTE');
    }
  });
});

it('binds each Base posting-fee allowance instead of spending the whole sequence allowance on one call', async () => {
  const p = CROSSCHAIN_ROUTER_BASE_ARBITRUM, f = setup(p), w = workflow(p), run = await f.s.simulate(w, f.h.owner);
  await f.s.review(run.id, run.review.commitment, w);
  const increased = BigInt(run.review.calls[0]!.l1FeeUpperBoundWei!) * 3n / 2n;
  expect(increased).toBeLessThan(BigInt(run.review.fees.l1FeeUpperBoundWei!));
  f.source(async (method, params) => {
    const call = params[0] as { to?: string };
    if (method === 'eth_call' && call.to === '0x420000000000000000000000000000000000000f') return '0x' + increased.toString(16).padStart(64, '0');
    return f.h.baseRpc(method, params);
  });
  await expect(f.s.begin(run.id, f.h.owner, w)).rejects.toThrow('ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED');
  expect(f.h.counters.sends).toBe(0);
});

it('fails closed when Nitro posting gas cannot be read, without consulting the OP Stack oracle', async () => {
  const p = CROSSCHAIN_ROUTER_ARBITRUM_BASE, f = setup(p), targets: string[] = [];
  f.source(async (method, params) => {
    const call = params[0] as { to?: string };
    if (method === 'eth_call') {
      targets.push(call.to!);
      if (call.to === '0x00000000000000000000000000000000000000c8') return '0x';
    }
    return f.h.baseRpc(method, params);
  });
  await expect(f.create().simulate(workflow(p), f.h.owner)).rejects.toThrow('ROUTER_NITRO_FEE_UNAVAILABLE');
  expect(targets).not.toContain('0x420000000000000000000000000000000000000f'); expect(f.h.counters.sends).toBe(0);
});

it('recovers a relayed Arbitrum deposit beyond 4000 quarter-second blocks via durable timestamp-bound scans', async () => {
  const f = setup(CROSSCHAIN_ROUTER_ARBITRUM_BASE, { delegatedOwner: true, autoFillSeconds: null, sourceBlockMs: 250 });
  const w = workflow(CROSSCHAIN_ROUTER_ARBITRUM_BASE, 'ACROSS'), run = await f.s.simulate(w, f.h.owner);
  await f.s.review(run.id, run.review.commitment, w);
  const approval = await f.s.begin(run.id, f.h.owner, w); await f.s.handoff(run.id);
  await f.s.report(run.id, { kind: 'HASH', hash: f.h.wallet.sendRelayed(approval.transaction) }); await f.s.observe(run.id);
  const begun = await f.s.begin(run.id, f.h.owner, w); await f.s.handoff(run.id); f.h.advance(1500);
  const hash = f.h.wallet.sendRelayed(begun.transaction); await f.s.report(run.id, { kind: 'UNKNOWN' }); f.h.advance(2200);
  let found = await f.create().observe(run.id);
  expect(found.verdict).toBe('PENDING');
  for (let i = 0; i < 5 && !found.source; i++) found = await f.create().observe(run.id);
  expect(found.source?.transactionHash).toBe(hash); expect(f.h.counters.sends).toBe(2);
  expect(FLOWS['crosschain-router-arbitrum-to-base'].needsObservation(found)).toBe(true);
});
