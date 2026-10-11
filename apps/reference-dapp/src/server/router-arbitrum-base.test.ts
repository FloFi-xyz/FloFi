// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: Base bridge IN from Arbitrum One on the canonical Cross-chain Router (Arbitrum USDC → Base USDC), the reverse of the
 * BUILD-ROUTER-001 Base → Arbitrum deployment and under the Router's own gates — on the same MOCKED in-process chains (parameterized by
 * profile). No network, no key, no send path but the scripted owner wallet: MOCKED evidence only.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { CROSSCHAIN_ROUTER_ARBITRUM_BASE as ROUTE, CROSSCHAIN_ROUTER_BASE_ARBITRUM, CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../domain/editor';
import { parseRouterChat, routerDetails, type RouterBridgeInput } from '../domain/router-authoring';
import { createRouterHarness, type RouterHarness } from '../../e2e/router-harness';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { createRouterService, validateRouterLog, type RouterRecord, type RouterService } from './router-service';
import { baseRouterRuntime, routerNetworkMode, routerNetworkProfile, routerNetworkRuntime } from './router-runtime';

function workflow(patch: Partial<RouterBridgeInput> = {}): SemanticWorkflow {
  const input: RouterBridgeInput = { source: 'Arbitrum', destination: 'Base', token: 'USDC', amount: '2', recipient: '', slippage: '50', routing: 'AUTO', ...patch };
  const result = editorReducer(initialEditor(), { type: 'ADD_ROUTER_BRIDGE', input, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
async function setup(options: { autoFillSeconds?: number | null } = {}) {
  const owner = createTestWallet().address;
  const h = createRouterHarness({ profile: ROUTE, owner, ...options });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-router-arbitrum-base-'));
  const service = createRouterService({ storage: createFileExecutionStorage(dir, 'ROUTER_BUSY'), sourceRpc: h.baseRpc, destinationRpc: h.arbitrumRpc, providers: h.providers,
    provenance: 'MOCKED', executionEnabled: true, now: h.clock, mockedCodePins: h.codePins, profile: ROUTE });
  return { h, dir, service, owner: h.owner };
}
async function execute(s: RouterService, h: RouterHarness, owner: string, id: string, w: SemanticWorkflow) {
  const begun = await s.begin(id, owner, w);
  await s.handoff(id);
  await s.report(id, { kind: 'HASH', hash: h.wallet.send(begun.transaction) });
  return begun;
}
async function until(s: RouterService, h: RouterHarness, id: string, phase: RouterRecord['phase'], rounds = 20): Promise<RouterRecord> {
  let run = await s.load(id);
  for (let i = 0; i < rounds && run.phase !== phase; i++) { h.advance(5); run = await s.observe(id); }
  return run;
}

describe('BUILD-BASE-001 Arbitrum One → Base on the canonical Router (MOCKED)', () => {
  it('authors the route from chat and Canvas into the same canonical node', () => {
    const chat = parseRouterChat('bridge 2 USDC from Arbitrum to Base via auto slippage 50 bps')!;
    expect(chat).toMatchObject({ source: 'Arbitrum', destination: 'Base', token: 'USDC' });
    const node = workflow().nodes.find(n => routerDetails(n))!;
    expect(routerDetails(node)).toMatchObject({ network: 'arbitrum-to-base', token: 'USDC', destinationToken: 'USDC', amount: '2' });
    expect(routerNetworkProfile('arbitrum-to-base')).toBe(ROUTE);
    expect([ROUTE.source.chainId, ROUTE.destination.chainId]).toEqual([42161, 8453]);
  });
  it('simulates on Arbitrum (no L1 data fee), approves, deposits, fills on Base and reconciles with MOCKED evidence', async () => {
    const { h, service, owner } = await setup(), w = workflow();
    const run = await service.simulate(w, owner);
    expect(run.review.intent).toMatchObject({ sourceChain: ROUTE.source.chain, destinationChain: ROUTE.destination.chain, inputToken: ROUTE.source.token,
      outputToken: ROUTE.destination.token, amount: '2000000' });
    expect(run.review.fees.l1FeeUpperBoundWei).toBe('0');
    expect(BigInt(run.review.route.minimumOutput)).toBe(2_000_000n - BigInt(run.review.route.feeTotal));
    await service.review(run.id, run.review.commitment, w);
    const approval = await execute(service, h, owner, run.id, w);
    expect(approval.transaction).toMatchObject({ chainId: ROUTE.source.chainHex, from: owner, to: ROUTE.source.token, value: '0x0' });
    await service.observe(run.id);
    const deposit = await execute(service, h, owner, run.id, w);
    expect(deposit.transaction).toMatchObject({ chainId: ROUTE.source.chainHex, from: owner, value: '0x0' });
    const done = await until(service, h, run.id, 'RECONCILED');
    expect(done).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', evidence: { evidenceClass: 'MOCKED', bundle: { environment: 'MOCKED' } } });
    expect(done.evidence!.transactions.map(t => [t.chain, t.step])).toEqual([[ROUTE.source.chain, 'APPROVAL'], [ROUTE.source.chain, 'DEPOSIT'], [ROUTE.destination.chain, 'FILL']]);
    expect(h.counters.sends).toBe(2);
  });
  it('an unfilled deposit is reconciled as a verified refund; nothing is resent', async () => {
    const { h, service, owner } = await setup({ autoFillSeconds: null }), w = workflow({ routing: 'ACROSS' });
    const run = await service.simulate(w, owner);
    await service.review(run.id, run.review.commitment, w);
    await execute(service, h, owner, run.id, w); await service.observe(run.id);
    await execute(service, h, owner, run.id, w);
    expect((await service.observe(run.id)).phase).toBe('SOURCE_CONFIRMED');
    h.advance(7_300);
    expect(await until(service, h, run.id, 'RECOVERY_REQUIRED')).toMatchObject({ error: 'ROUTER_FILL_DEADLINE_PASSED_REFUND_EXPECTED' });
    h.relayer.refund();
    expect(await service.observe(run.id)).toMatchObject({ phase: 'REFUNDED', verdict: 'REFUNDED', evidence: null });
    expect(h.counters.sends).toBe(2);
  });
  it('is its own deployment: another route never crosses, and its logs do not validate under another profile', async () => {
    const { service, owner, dir } = await setup();
    await expect(service.simulate(workflow({ destination: 'Robinhood Chain' }), owner)).rejects.toThrow('ROUTER_NETWORK_MISMATCH');
    const run = await service.simulate(workflow(), owner), bytes = await readFile(join(dir, run.id + '.jsonl'));
    expect(() => validateRouterLog(bytes, ROUTE)).not.toThrow();
    for (const other of [CROSSCHAIN_ROUTER_BASE_ARBITRUM, CROSSCHAIN_ROUTER_ARBITRUM_ROBINHOOD]) expect(() => validateRouterLog(bytes, other)).toThrow('ROUTER_STORE_CORRUPT');
  });
  it("runtime: the Router's own gates (never the Robinhood or Base ones), owner execution only with the Router approval", () => {
    expect([routerNetworkMode('arbitrum-to-base', {}), routerNetworkMode('arbitrum-to-base', { GRYLOO_ROUTER: 'live' }),
      routerNetworkMode('arbitrum-to-base', { GRYLOO_ROBINHOOD_MAINNET: 'live' }), routerNetworkMode('arbitrum-to-base', { GRYLOO_BASE_MAINNET: 'live' })]).toEqual(['off', 'live', 'off', 'off']);
    const live = baseRouterRuntime('arbitrum-to-base', 'live', { GRYLOO_ROUTER: 'live' });
    expect(live).toMatchObject({ provenance: 'PUBLIC_MAINNET', executionEnabled: false, profile: ROUTE });
    expect(baseRouterRuntime('arbitrum-to-base', 'live', { GRYLOO_ROUTER: 'live', GRYLOO_BASE_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' }).executionEnabled).toBe(false);
    expect(baseRouterRuntime('arbitrum-to-base', 'live', { GRYLOO_ROUTER: 'live', GRYLOO_ROUTER_OWNER_EXECUTION: 'MAINNET_OWNER_APPROVED' }).executionEnabled).toBe(true);
    expect(routerNetworkRuntime('arbitrum-to-base', 'harness', {})).toMatchObject({ provenance: 'MOCKED', executionEnabled: true, profile: ROUTE });
  });
});
