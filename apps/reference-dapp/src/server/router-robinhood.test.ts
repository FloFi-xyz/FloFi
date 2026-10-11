// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain in and out on the canonical Cross-chain Router — Base/Arbitrum USDC → Robinhood USDG and USDG → USDC —
 * on the same MOCKED in-process chains as BUILD-ROUTER-001 (parameterized by profile). No network, no key, no send path but the
 * scripted owner wallet: MOCKED evidence only, never a public execution.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD, CROSSCHAIN_ROUTER_BASE_ARBITRUM as MAINNET, CROSSCHAIN_ROUTER_BASE_ROBINHOOD, CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM,
  CROSSCHAIN_ROUTER_ROBINHOOD_BASE, type RouterProfile } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../domain/editor';
import type { RouterBridgeInput } from '../domain/router-authoring';
import { createRouterHarness, type RouterHarness, type RouterHarnessOptions } from '../../e2e/router-harness';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { createRouterService, validateRouterLog, type RouterRecord, type RouterService } from './router-service';
import { robinhoodRouterRuntime, routerNetworkMode, routerNetworkProfile, type RobinhoodRouterNetwork } from './router-runtime';

type Route = { network: RobinhoodRouterNetwork; profile: RouterProfile; input: Pick<RouterBridgeInput, 'source' | 'destination' | 'token'>; out: string };
const ROUTES: readonly Route[] = [
  { network: 'base-to-robinhood', profile: CROSSCHAIN_ROUTER_BASE_ROBINHOOD, input: { source: 'Base', destination: 'Robinhood Chain', token: 'USDC' }, out: 'USDG' },
  { network: 'robinhood-to-base', profile: CROSSCHAIN_ROUTER_ROBINHOOD_BASE, input: { source: 'Robinhood Chain', destination: 'Base', token: 'USDG' }, out: 'USDC' },
  { network: 'arbitrum-to-robinhood', profile: CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD, input: { source: 'Arbitrum', destination: 'Robinhood Chain', token: 'USDC' }, out: 'USDG' },
  { network: 'robinhood-to-arbitrum', profile: CROSSCHAIN_ROUTER_ROBINHOOD_ARBITRUM, input: { source: 'Robinhood Chain', destination: 'Arbitrum', token: 'USDG' }, out: 'USDC' },
];
function workflow(route: Route, patch: Partial<RouterBridgeInput> = {}): SemanticWorkflow {
  const input: RouterBridgeInput = { ...route.input, amount: '2', recipient: '', slippage: '50', routing: 'AUTO', ...patch };
  const result = editorReducer(initialEditor(), { type: 'ADD_ROUTER_BRIDGE', input, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
async function setup(route: Route, options: RouterHarnessOptions = {}) {
  const owner = options.owner ?? createTestWallet().address;
  const h = createRouterHarness({ profile: route.profile, ...options, owner });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-router-robinhood-'));
  const service = createRouterService({ storage: createFileExecutionStorage(dir, 'ROUTER_BUSY'), sourceRpc: h.baseRpc, destinationRpc: h.arbitrumRpc, providers: h.providers,
    provenance: 'MOCKED', executionEnabled: true, now: h.clock, mockedCodePins: h.codePins, profile: route.profile });
  return { h, dir, service, owner: h.owner };
}
async function execute(s: RouterService, h: RouterHarness, owner: string, id: string, w: SemanticWorkflow) {
  const begun = await s.begin(id, owner, w);
  await s.handoff(id);
  const hash = h.wallet.send(begun.transaction);
  await s.report(id, { kind: 'HASH', hash });
  return { begun, hash };
}
async function until(s: RouterService, h: RouterHarness, id: string, phase: RouterRecord['phase'], rounds = 20): Promise<RouterRecord> {
  let run = await s.load(id);
  for (let i = 0; i < rounds && run.phase !== phase; i++) { h.advance(5); run = await s.observe(id); }
  return run;
}

describe('BUILD-RH-002 Robinhood Chain routes on the canonical Router (MOCKED)', () => {
  it.each(ROUTES)('$network: Review names both assets and the conversion fee; approval → deposit → fill → RECONCILED with MOCKED evidence', async route => {
    const { h, service, owner } = await setup(route), w = workflow(route), SRC = route.profile.source, DST = route.profile.destination;
    const run = await service.simulate(w, owner);
    expect(run.review.intent).toMatchObject({ sourceChain: SRC.chain, destinationChain: DST.chain, inputToken: SRC.token, outputToken: DST.token, amount: '2000000' });
    // LI.FI folds Across's USDC ⇄ USDG conversion into the output without a fee line: refused (fail closed); AUTO falls back to Across direct.
    expect(run.review.selection.considered.map(c => [c.provider, c.outcome, c.code ?? null])).toEqual([['lifi', 'REFUSED', 'LIFI_FEES_INCONSISTENT'], ['across', 'SELECTED', null]]);
    const r = run.review.route;
    expect(r).toMatchObject({ routingProvider: 'across', inputToken: { symbol: route.input.token, address: SRC.token }, outputToken: { symbol: route.out, address: DST.token } });
    const conversion = r.fees.find(f => f.label === `Across ${route.input.token} → ${route.out} conversion fee`);
    expect(conversion).toMatchObject({ kind: 'BRIDGE_OTHER', token: SRC.token, amount: '1000' });
    expect(r.fees.reduce((sum, f) => sum + BigInt(f.amount), 0n)).toBe(BigInt(r.feeTotal));
    expect(BigInt(r.minimumOutput)).toBe(2_000_000n - BigInt(r.feeTotal));
    expect(run.review.approvals[0]).toMatchObject({ token: SRC.token, spender: SRC.spokePool, amount: '2000000', required: true });
    expect(run.review.simulation).toMatchObject({ chainId: SRC.chainId, deposit: { destinationChainId: DST.chainId, depositor: owner, recipient: owner } });
    // Only Base (OP Stack) has an L1 data fee; Robinhood and Arbitrum (Nitro) sources carry none.
    expect(SRC.l1DataFee).toBe(route.network === 'base-to-robinhood');
    if (!SRC.l1DataFee) expect(run.review.fees.l1FeeUpperBoundWei).toBe('0');
    await service.review(run.id, run.review.commitment, w);
    const approval = await execute(service, h, owner, run.id, w);
    expect(approval.begun.transaction).toMatchObject({ chainId: SRC.chainHex, from: owner, to: SRC.token, value: '0x0' });
    await service.observe(run.id);
    const deposit = await execute(service, h, owner, run.id, w);
    expect(deposit.begun.transaction).toMatchObject({ chainId: SRC.chainHex, from: owner, to: SRC.spokePool, value: '0x0' });
    const done = await until(service, h, run.id, 'RECONCILED');
    expect(done).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED' });
    expect(done.evidence).toMatchObject({ evidenceClass: 'MOCKED', bundle: { environment: 'MOCKED', outcome: 'RECONCILED' } });
    expect(done.evidence!.transactions.map(t => [t.chain, t.step])).toEqual([[SRC.chain, 'APPROVAL'], [SRC.chain, 'DEPOSIT'], [DST.chain, 'FILL']]);
    expect(done.evidence!.transactions.every(t => t.explorer.startsWith((t.chain === SRC.chain ? SRC.explorer : DST.explorer) + 'tx/'))).toBe(true);
    expect(h.counters.sends).toBe(2);
  });
  it('a route change after Review (fees moved) clears the authorization; nothing is sent', async () => {
    const route = ROUTES[0]!, { h, service, owner } = await setup(route), w = workflow(route, { routing: 'ACROSS' });
    const run = await service.simulate(w, owner);
    await service.review(run.id, run.review.commitment, w);
    h.controls.feeBump = 500n;
    await expect(service.begin(run.id, owner, w)).rejects.toThrow('ROUTE_CHANGED');
    expect(await service.load(run.id)).toMatchObject({ phase: 'PREPARED', authorization: null, requote: true });
    expect(h.counters.sends).toBe(0);
  });
  it('an insufficient source balance names the route token and stops before any wallet request', async () => {
    const route = ROUTES[1]!, { h, service, owner } = await setup(route, { usdc: 1_000_000n }), w = workflow(route);
    await expect(service.simulate(w, owner)).rejects.toThrow('ROUTER_INSUFFICIENT_TOKEN');
    expect(h.counters.sends).toBe(0);
  });
  it('each route is its own deployment: workflows and logs of another route never cross', async () => {
    const route = ROUTES[0]!, { service, owner, dir } = await setup(route);
    await expect(service.simulate(workflow(ROUTES[2]!), owner)).rejects.toThrow('ROUTER_NETWORK_MISMATCH');
    const run = await service.simulate(workflow(route), owner);
    const bytes = await readFile(join(dir, run.id + '.jsonl'));
    expect(() => validateRouterLog(bytes, route.profile)).not.toThrow();
    for (const other of [MAINNET, ROUTES[1]!.profile, ROUTES[2]!.profile]) expect(() => validateRouterLog(bytes, other)).toThrow('ROUTER_STORE_CORRUPT');
  });
  it('runtime: the Robinhood real-funds gates, chain-bound public endpoints, owner execution only with the explicit approval', () => {
    for (const route of ROUTES) {
      expect(routerNetworkProfile(route.network)).toBe(route.profile);
      expect([routerNetworkMode(route.network, {}), routerNetworkMode(route.network, { GRYLOO_ROUTER: 'live' }),
        routerNetworkMode(route.network, { GRYLOO_ROBINHOOD_MAINNET: 'live' }), routerNetworkMode(route.network, { GRYLOO_ROBINHOOD_MAINNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' })])
        .toEqual(['off', 'off', 'live', 'harness']);
      const live = robinhoodRouterRuntime(route.network, 'live', { GRYLOO_ROBINHOOD_MAINNET: 'live' });
      expect(live).toMatchObject({ provenance: 'PUBLIC_MAINNET', executionEnabled: false, profile: route.profile });
      expect(live.mockedCodePins).toBeUndefined();
      expect(robinhoodRouterRuntime(route.network, 'live', { GRYLOO_ROBINHOOD_MAINNET: 'live', GRYLOO_ROBINHOOD_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' }).executionEnabled).toBe(true);
      expect(robinhoodRouterRuntime(route.network, 'harness', {})).toMatchObject({ provenance: 'MOCKED', profile: route.profile });
    }
    expect(() => robinhoodRouterRuntime('robinhood-to-base', 'live', { GRYLOO_ROBINHOOD_RPC_URL: 'http://insecure.example' })).toThrow();
  });
});
