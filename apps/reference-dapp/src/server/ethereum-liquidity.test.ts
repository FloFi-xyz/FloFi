// SPDX-License-Identifier: AGPL-3.0-only
/** Shared engine lifecycle on a synthetic chain. MOCKED, never public execution evidence. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogAsset, catalogPoolOn, parseEthereumTokenList } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createUniswapLiquidityChain, UNI_MOCK_CODE_PINS, UNI_OWNER } from '../../e2e/uniswap-liquidity-harness';
import { editorReducer, initialEditor } from '../domain/editor';
import { registerNetworkCatalog, resetNetworkCatalogs } from '../domain/asset-catalogs';
import { assertSafeOutput, projectSimulation } from '../mcp/simulation';
import { createUniswapLiquidityService } from './uniswap-liquidity-service';

const catalog = parseEthereumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/ethereum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-17T00:00:00Z');
const dirs: string[] = [];
afterEach(async () => { resetNetworkCatalogs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(fee = 500, executionEnabled = true) {
  registerNetworkCatalog(catalog);
  const a = catalogAsset(catalog, { symbol: 'USDC' })!, b = catalogAsset(catalog, { symbol: 'WETH' })!;
  const profile = catalogPoolOn(1, { symbol: a.symbol, address: a.address!, decimals: a.decimals }, { symbol: b.symbol, address: b.address!, decimals: b.decimals }, fee);
  const chain = createUniswapLiquidityChain({ profile, tick: 200_000, usdc: 10n ** 15n, weth: 10n ** 27n });
  const path = await mkdtemp(join(tmpdir(), 'flofi-ethereum-lp-')); dirs.push(path);
  const restart = () => createUniswapLiquidityService({ storage: createFileExecutionStorage(path, 'UNISWAP_LIQUIDITY_BUSY'),
    rpc: async () => { throw Error('NO_FALLBACK'); }, rpcs: { 'eip155:1': chain.rpc }, now: chain.clock, provenance: 'MOCKED', executionEnabled,
    mockedCodePins: UNI_MOCK_CODE_PINS, catalog: { chain: 'eip155:1', catalogFor: async () => catalog, codePins: chain.catalogPins } });
  const result = editorReducer(initialEditor(), { type: 'ADD_CRYPTO_ACTION', source: 'CANVAS', baseRevision: 0,
    input: { selection: { action: 'pool', network: 'Ethereum', from: 'USDC', to: 'WETH' }, amount: '10', secondAmount: '0.005', slippage: '100', fee } }, createBaseSepoliaReviewContext());
  if (result.error) throw Error(result.error);
  const workflow = structuredClone(result.workflow) as SemanticWorkflow;
  return { chain, workflow, restart, service: restart(), profile };
}
describe('Ethereum catalog liquidity on the existing engine', () => {
  it.each([100, 500, 3000, 10000])('mints and reconciles tier %i after durable restart with MOCKED evidence and L1 fees', async fee => {
    const s = await setup(fee);
    let run = await s.service.simulate(s.workflow, UNI_OWNER);
    expect(run.id).toMatch(/^etlp-/);
    const preview = projectSimulation('ethereum-liquidity', run);
    expect(preview).toMatchObject({ kind: 'CONCENTRATED_LIQUIDITY', provenance: 'MOCKED', facts: { chainId: 1 } });
    assertSafeOutput(preview);
    expect(run.review).toMatchObject({ chainId: 1, token0: { address: s.profile.token0.address }, pool: { fee }, fees: { l1FeeUpperBoundWei: '0' } });
    await s.service.review(run.id, run.review.commitment, s.workflow);
    for (let index = 0; index < 3; index++) {
      const begun = await s.service.begin(run.id, UNI_OWNER, s.workflow);
      expect(begun.transaction).toMatchObject({ chainId: '0x1', value: '0x0', from: UNI_OWNER });
      await s.service.handoff(run.id);
      await s.service.report(run.id, { kind: 'HASH', hash: s.chain.wallet.send(begun.transaction) });
      run = await s.restart().observe(run.id);
    }
    expect(run.verdict).toBe('RECONCILED');
    expect(run.evidence?.bundle.environment).toBe('MOCKED');
  });
  it('requires operator execution opt-in before reserving a nonce or requesting any wallet transaction', async () => {
    const s = await setup(500, false), run = await s.service.simulate(s.workflow, UNI_OWNER);
    await s.service.review(run.id, run.review.commitment, s.workflow);
    await expect(s.service.begin(run.id, UNI_OWNER, s.workflow)).rejects.toThrow('UNISWAP_EXECUTION_NOT_ENABLED');
    expect(s.chain.counters.sends).toBe(0);
  });
  it('rejects a wrong owner and a modified workflow after Review', async () => {
    const s = await setup(), run = await s.service.simulate(s.workflow, UNI_OWNER);
    await s.service.review(run.id, run.review.commitment, s.workflow);
    await expect(s.service.begin(run.id, '0x3333333333333333333333333333333333333333', s.workflow)).rejects.toThrow();
    await expect(s.service.begin(run.id, UNI_OWNER, { ...s.workflow, revision: s.workflow.revision + 1 })).rejects.toThrow();
    expect(s.chain.counters.sends).toBe(0);
  });
});
