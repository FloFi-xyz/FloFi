// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the cloud contract of position-management runs on the catalog-mainnet liquidity flows. A position run keeps the
 * shared method names (so Flight recovery, beta owner binding and the worker apply unchanged); only `simulate` takes the position request, and only on
 * a catalog mainnet. The projection and the worker's observation rule read the run's own kind. MOCKED chain; nothing is sent but by the scripted wallet.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { catalogPoolOn, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from '../src/domain/editor.ts';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../src/domain/asset-catalogs.ts';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../e2e/uniswap-liquidity-harness.ts';
import { baseAsset, baseCatalog } from '../src/server/base-mainnet.test-harness.ts';
import { createUniswapLiquidityService } from '../src/server/uniswap-liquidity-service.ts';
import { FLOWS } from './flows.ts';

const catalog = baseCatalog();
const USDC = baseAsset(catalog, 'USDC'), CBBTC = baseAsset(catalog, 'cbBTC');
const token = (asset: CanonicalAsset) => asset as { symbol: string; address: string; decimals: number };
const PROFILE = catalogPoolOn('eip155:8453', token(USDC), token(CBBTC), 500);
const TICK = PROFILE.token0.address === USDC.address ? -69_082 : 69_082;
const LOWER = Math.floor((TICK - 2_000) / 10) * 10, UPPER = Math.ceil((TICK + 2_000) / 10) * 10;
const REQUEST = { operation: 'EXIT', tokenId: '9001', partBps: null, close: false };
function positionWorkflow(): SemanticWorkflow {
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0, input: { selection: { action: 'pool', network: 'Base',
    from: 'USDC', to: 'cbBTC' }, amount: '100', secondAmount: '0.001', slippage: '100', fee: 500, rangeUnit: 'TICK', lower: String(LOWER), upper: String(UPPER) } },
  createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  return structuredClone(result.workflow) as unknown as SemanticWorkflow;
}
beforeAll(() => registerNetworkCatalog(catalog));
afterAll(() => resetNetworkCatalogs());

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 position runs on the liquidity cloud flows', () => {
  it('accepts a position request on a catalog mainnet simulate only, strictly validated; testnets and other methods are unchanged', () => {
    const w = positionWorkflow(), base = FLOWS['base-liquidity'].methods, testnet = FLOWS['uniswap-liquidity'].methods;
    expect(base.simulate!.validate([w, UNI_OWNER])).toBe(true);
    expect(base.simulate!.validate([w, UNI_OWNER, REQUEST])).toBe(true);
    for (const bad of [{ ...REQUEST, close: 'yes' }, { ...REQUEST, operation: 'BURN' }, { ...REQUEST, partBps: 5_000 }, { ...REQUEST, recipient: UNI_OWNER }, 'EXIT'])
      expect(base.simulate!.validate([w, UNI_OWNER, bad]), JSON.stringify(bad)).toBe(false);
    expect(testnet.simulate!.validate([w, UNI_OWNER, REQUEST])).toBe(false);
    for (const flow of ['arbitrum-liquidity', 'ethereum-liquidity', 'robinhood-liquidity'] as const) expect(FLOWS[flow].methods.simulate!.validate([w, UNI_OWNER, REQUEST])).toBe(true);
    // No new method names: Flight recovery and the beta owner binding are keyed by these names.
    expect(Object.keys(base).sort()).toEqual(['begin', 'handoff', 'info', 'invalidate', 'observe', 'price', 'refresh', 'report', 'review', 'simulate', 'status', 'walletFailure']);
  });

  it('projects a position run by its own kind (status, owner, operation step) and asks the worker to observe it after the wallet hand-off', async () => {
    const chain = createUniswapLiquidityChain({ profile: PROFILE, tick: TICK, usdc: 1_000_000_000n, weth: 1_000_000_000n });
    const dir = await mkdtemp(join(tmpdir(), 'flofi-pm-flow-')), storage = createFileExecutionStorage(dir, 'UNISWAP_LIQUIDITY_BUSY');
    const service = createUniswapLiquidityService({ storage, rpc: async () => { throw new Error('UNUSED'); }, rpcs: { 'eip155:8453': chain.rpc }, provenance: 'MOCKED',
      now: chain.clock, mockedCodePins: UNI_MOCK_CODE_PINS, catalog: { chain: 'eip155:8453', catalogFor: async () => catalog, codePins: chain.catalogPins } });
    const w = positionWorkflow(), tokenId = chain.seedPosition({ tickLower: LOWER, tickUpper: UPPER, liquidity: 2_000_000_000n });
    const run = await service.positionSimulate(w, UNI_OWNER, { ...REQUEST, tokenId });
    const flow = FLOWS['base-liquidity'];
    const project = async () => flow.projector(`${run.id}.jsonl`, (await storage.log.read(`${run.id}.jsonl`))!)!;
    expect((await project()).run).toMatchObject({ runId: run.id, flow: 'base-liquidity', status: 'SIMULATED', provenance: 'MOCKED', ownerAccount: UNI_OWNER,
      needsObservation: false, attempts: [] });
    await service.positionReview(run.id, run.review.commitment, w);
    expect((await project()).run.status).toBe('AUTHORIZED');
    const begun = await service.positionBegin(run.id, UNI_OWNER, w);
    await service.positionHandoff(run.id);
    const submitting = await project();
    expect(submitting.run).toMatchObject({ status: 'SUBMITTING', needsObservation: true, attempts: [{ step: 'EXIT', state: 'SUBMITTING' }] });
    expect(submitting.work.map(item => item.kind)).toEqual(['reconcile']);
    await service.positionReport(run.id, { kind: 'HASH', hash: chain.wallet.send(begun.transaction) });
    // The worker's entry points read either run kind of the namespace.
    expect(flow.needsObservation(await service.loadAny(run.id))).toBe(true);
    const settled = await service.observeAny(run.id);
    expect(flow.needsObservation(settled)).toBe(false);
    const done = await project();
    expect(done.run).toMatchObject({ status: 'RECONCILED', hasEvidence: true, attempts: [{ step: 'EXIT', state: 'CONFIRMED', reconciled: true }] });
    expect(done.work.map(item => item.kind)).toEqual(['evidence.archive']);
    expect(flow.evidence(settled)).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
  });
});
