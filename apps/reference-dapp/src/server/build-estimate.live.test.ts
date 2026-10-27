// SPDX-License-Identifier: AGPL-3.0-only
/** Opt-in PUBLIC READS, isolated from fixtures and from deployed configuration. No wallet, key, durable run, signature or submission. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger, type Database } from '@defi-workflow-engine/cloud-runtime';
import { UNIVERSAL_QUOTE_SUBJECTS, hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { createBackend } from '../../backend/app';
import { CATALOG_NETWORKS } from './catalog-networks';
import { registerNetworkCatalog } from '../domain/asset-catalogs';
import { composeStrategy } from '../engine/strategy-engine';
import { readBuildEstimate } from './build-estimate';
import type { FlowName } from '../../backend/flows';

const enabled = process.env.FLOFI_SWAP_QUOTE_LIVE === 'READ_ONLY';
const rows: unknown[] = [];
const env = { NODE_ENV: 'production', GRYLOO_BASE_MAINNET: 'live', GRYLOO_ARBITRUM_MAINNET: 'live', GRYLOO_ETHEREUM_MAINNET: 'live',
  GRYLOO_ROBINHOOD_MAINNET: 'live', GRYLOO_JUPITER: 'live' };
const backend = createBackend({ env, db: { query: async () => { throw Error('READ_ONLY_DATABASE_DENIED'); }, close: async () => undefined } as unknown as Database,
  logger: createLogger({ service: 'read-only-swap-matrix', sink: () => undefined }), tenantId: 'read-only', holderId: 'quote', evidenceStore: null });
const cases = [
  ...Object.values(CATALOG_NETWORKS).flatMap(n => [[n.id, n.id === 'robinhood' ? 'USDG' : 'USDC', 'WETH'], [n.id, 'WETH', n.id === 'robinhood' ? 'USDG' : 'USDC']]),
  ['solana', 'SOL', 'USDC'], ['solana', 'USDC', 'SOL'], ['solana', 'SOL', 'USDT'], ['solana', 'USDT', 'SOL'], ['solana', 'USDC', 'USDT'], ['solana', 'USDT', 'USDC'],
];
describe.skipIf(!enabled)('public read-only Swap observation (not financial certification)', () => {
  afterAll(() => {
    const output = process.env.FLOFI_SWAP_QUOTE_REPORT;
    if (!output) return;
    const sourceFingerprint = Object.fromEntries(['build-estimate.ts', 'flow-runtime.ts', '../../backend/preview.ts'].map(path => [path,
      createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]));
    writeFileSync(output, JSON.stringify({ format: 'flofi.swap-quote-observation.v1', generatedAt: new Date().toISOString(), sourceFingerprint,
      method: 'Isolated backend.previewFlow with live public catalog/RPC/provider transports, projected by readBuildEstimate; USD disabled; no production configuration changed.',
      limits: ['PUBLIC_READ_ONLY, not fixtures.', 'No funded simulation, wallet signature, transaction or financial certification.',
        'API-key-only providers may be unavailable to this public probe; absence is reported, never replaced by a fixture.'], rows }, null, 2) + '\n');
  });
  it.each(cases)('records %s %s → %s without claiming execution', async (network, inputAsset, outputAsset) => {
    const start = Date.now();
    let row: Record<string, unknown> = { network, inputAsset, outputAsset, amount: '1', slippageBps: 100, evidence: 'PUBLIC_READ_ONLY',
      simulation: 'NOT_RUN', review: 'NOT_AUTHORIZED', execution: 'NOT_RUN', certification: 'NOT_CERTIFIED' };
    try {
      if (network !== 'solana') {
        const n = CATALOG_NETWORKS[network as keyof typeof CATALOG_NETWORKS];
        registerNetworkCatalog(await n.catalogFor('live')(n.chain));
      }
      const composed = composeStrategy({ action: 'swap', network, inputAsset, outputAsset, amount: '1' });
      if (!composed.ok) throw Error(composed.code);
      const workflow = composed.workflow, node = workflow.nodes[0]!;
      const observations: Record<string, unknown>[] = [];
      const result = await readBuildEstimate({ workflow, nodeId: node.nodeId, owner: UNIVERSAL_QUOTE_SUBJECTS.SOLANA },
        { VERCEL: '1', NODE_ENV: 'production' }, { prices: null, preview: async (flow: FlowName, args, options) => {
          const value = await backend.previewFlow(flow, args, options?.purpose);
          if (value.ok) {
            const record = value.value as Record<string, unknown>, quote = (record.quote ?? record) as Record<string, unknown>;
            observations.push(Object.fromEntries(['workflowHash', 'inputToken', 'outputToken', 'inputDecimals', 'outputDecimals', 'input', 'output', 'amountIn',
              'expectedOut', 'minimumOut', 'pool', 'fee', 'feeTiers', 'blockNumber', 'blockHash', 'provenance', 'catalog'].filter(key => key in quote).map(key => [key, quote[key]])));
          }
          return value;
        } });
      row = { ...row, workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))),
        assets: node.inputs, result, observations };
      expect(typeof result.ok).toBe('boolean');
      if (result.ok) { expect(Number(result.estimate.expected)).toBeGreaterThan(0); expect(result.estimate.slippageBps).toBe(100); }
      else expect(result.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    } catch (cause) {
      const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'PUBLIC_READ_UNAVAILABLE';
      row = { ...row, result: { ok: false, code } };
    } finally { rows.push({ ...row, elapsedMs: Date.now() - start }); }
  }, 120_000);
});
