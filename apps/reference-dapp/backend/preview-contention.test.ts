// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 catalog reliability — the 2026-11-07 incident shape, reproduced deterministically: one flow's previews share one paced read queue (as every
 * live flow does), four superseded quotes are started by edits the user already moved past, then the live quote. Before this build the API never
 * heard that those callers had gone, so the live quote waited behind all of them (production: 39–48 s against 3–4 s alone). Now a caller that
 * leaves abandons its preview and its queued reads are dropped. Loopback MOCKED chain only; nothing is signed or sent.
 */
import { describe, expect, it } from 'vitest';
import { createLogger, type Database } from '@defi-workflow-engine/cloud-runtime';
import { createMockedSolanaJupiter, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaSwapNode } from '../src/domain/jupiter-authoring.ts';
import { pacedReadRpc } from '../src/server/public-testnet-rpc.ts';
import { createBackend } from './app.ts';

const quiet = createLogger({ service: 'test', sink: () => undefined });
const db = { query: async () => { throw new Error('DB_TOUCHED'); }, close: async () => undefined } as unknown as Database;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setup() {
  const harness = createMockedSolanaJupiter(), owner = createMockedSolanaWallet().owner;
  harness.fund(owner, 3_000_000_000n, { USDC: 1_000_000_000n });
  let reads = 0;
  // A node answering each read in 20 ms behind a one-at-a-time queue, 10 ms between starts (the public profile's shape, scaled down).
  const rpc = pacedReadRpc(async (method, params) => { reads++; await sleep(20); return harness.rpc(method, params); }, { minIntervalMs: 10 });
  const backend = createBackend({ db, env: { GRYLOO_JUPITER_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, logger: quiet, tenantId: 'default', holderId: 'test',
    evidenceStore: null, http: harness.http, rpc: { 'jupiter-swap': rpc } });
  const workflow = (amount: string): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-contention', revision: 1, resourceEdges: [],
    nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from: 'USDC', to: 'SOL', amount, slippage: '100' })] });
  const preview = (amount: string, signal?: AbortSignal) => backend.previewFlow('jupiter-swap', [workflow(amount), owner], 'SIMULATION', signal ? { signal } : {});
  return { preview, reads: () => reads };
}
async function liveQuoteAfterSupersededEdits(cancelSuperseded: boolean) {
  const s = setup();
  expect(await s.preview('8')).toMatchObject({ ok: true }); // warm-up (module and JIT), not measured
  const warm = s.reads(), alone = performance.now();
  expect(await s.preview('9')).toMatchObject({ ok: true });
  const aloneMs = performance.now() - alone, readsAlone = s.reads() - warm;
  const superseded = ['1', '2', '3', '4'].map(amount => { const c = new AbortController(); return { c, done: s.preview(amount, c.signal) }; });
  await sleep(5);
  // The user typed on: each earlier estimate is cancelled in the browser. Before this build that cancellation never reached the API.
  if (cancelSuperseded) for (const { c } of superseded) c.abort();
  const started = performance.now();
  expect(await s.preview('5')).toMatchObject({ ok: true });
  const liveMs = performance.now() - started;
  await Promise.all(superseded.map(x => x.done));
  return { aloneMs, liveMs, readsAlone, readsAfterAlone: s.reads() - warm - readsAlone };
}

describe('P0 catalog reliability: a live quote does not wait for quotes nobody is waiting for', () => {
  it('measures the live quote behind four superseded ones, without and with cancellation reaching the API', async () => {
    const before = await liveQuoteAfterSupersededEdits(false);
    const after = await liveQuoteAfterSupersededEdits(true);
    console.info(JSON.stringify({ benchmark: 'preview-contention', before, after }));
    // Deterministic: without cancellation the node served every read of the four superseded quotes plus the live one; with it, only the live
    // quote's reads and at most the few superseded reads already started before the cancellation.
    expect(before.readsAfterAlone).toBe(5 * before.readsAlone);
    expect(after.readsAfterAlone).toBeLessThan(2 * after.readsAlone);
    // Timing (loose, CI-load tolerant): the live quote is faster once the superseded quotes stop holding the queue.
    expect(after.liveMs).toBeLessThan(before.liveMs);
  }, 60_000);
});
