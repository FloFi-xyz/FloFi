// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIGHTHOUSE_PROGRAM, appendMockedWalletGuards, applyMockedPhantomLighthouseGuards, createMockedSolanaJupiter, createMockedSolanaWallet, fromBase64, parseTransaction,
  type MockedJupiterOptions } from '@defi-workflow-engine/reference-compiler';
import { createSolanaSwapNode } from '../domain/jupiter-authoring';
import { createJupiterService } from './jupiter-service';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

const workflow = (amount = '10', from: 'USDC' | 'SOL' = 'USDC', to: 'SOL' | 'USDC' = 'SOL'): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, resourceEdges: [],
  nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from, to, amount, slippage: '50' })] });
async function setup(options: MockedJupiterOptions = {}, service: { provenance?: 'PUBLIC_MAINNET' | 'MOCKED'; executionEnabled?: boolean; dir?: string } = {}) {
  const env = createMockedSolanaJupiter(options), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, { USDC: 100_000_000n });
  const dir = service.dir ?? await mkdtemp(join(tmpdir(), 'gryloo-jupiter-'));
  let clock = Date.parse('2026-10-01T12:00:00.000Z');
  const make = () => createJupiterService({ rpc: env.rpc, http: env.http, journalDir: dir, provenance: service.provenance ?? 'MOCKED', executionEnabled: service.executionEnabled ?? true, now: () => clock });
  return { env, wallet, dir, service: make(), make, tick: (ms: number) => { clock += ms; } };
}
async function reviewed(s: Awaited<ReturnType<typeof setup>>, wf = workflow()) {
  const simulated = await s.service.simulate(wf, s.wallet.owner);
  return s.service.review(simulated.id, simulated.review.commitment, wf);
}
describe('Jupiter service lifecycle (MOCKED loopback, no public submission)', () => {
  it('simulates read-only, binds Review, persists before signing, broadcasts once and reconciles with MOCKED evidence', async () => {
    const s = await setup();
    const simulated = await s.service.simulate(workflow(), s.wallet.owner);
    expect(simulated).toMatchObject({ authorization: null, attempt: null, evidenceClass: 'MOCKED' });
    expect(s.env.state.sent).toEqual([]);
    await expect(s.service.begin(simulated.id, s.wallet.owner, workflow())).rejects.toThrow('JUPITER_REVIEW_REQUIRED');
    const record = await s.service.review(simulated.id, simulated.review.commitment, workflow());
    const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    expect((await s.service.load(record.id)).attempt?.state).toBe('PREPARED');
    expect(s.env.state.sent).toEqual([]);
    const submitted = await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(submitted.attempt).toMatchObject({ state: 'PENDING' });
    expect(s.env.state.sent).toHaveLength(1);
    const observed = await s.service.observe(record.id);
    expect(observed).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED', reconciled: true } });
    expect(observed.evidence?.bundle.environment).toBe('MOCKED');
    expect(observed.journal.entries.filter(e => e.level === 'attempt').map(e => e.toState)).toEqual(['PREPARED', 'SUBMITTING', 'PENDING', 'CONFIRMED']);
  });
  it('keeps public runs PUBLIC_READ_ONLY and refuses mainnet execution unless the owner enabled it', async () => {
    const s = await setup({}, { provenance: 'PUBLIC_MAINNET', executionEnabled: false });
    const record = await reviewed(s);
    expect(record.evidenceClass).toBe('PUBLIC_READ_ONLY');
    await expect(s.service.begin(record.id, s.wallet.owner, workflow())).rejects.toThrow('JUPITER_MAINNET_EXECUTION_NOT_ENABLED');
    expect((await s.service.load(record.id)).attempt).toBeNull();
  });
  it('invalidates authorization for stale quotes, a wrong owner and semantic changes before any attempt', async () => {
    const s = await setup();
    const record = await reviewed(s);
    await expect(s.service.begin(record.id, createMockedSolanaWallet().owner, workflow())).rejects.toThrow('JUPITER_WRONG_OWNER');
    await expect(s.service.begin(record.id, s.wallet.owner, workflow('11'))).rejects.toThrow('JUPITER_SEMANTIC_REVISION_CHANGED');
    s.tick(61_000);
    await expect(s.service.begin(record.id, s.wallet.owner, workflow())).rejects.toThrow('JUPITER_QUOTE_STALE');
    expect((await s.service.load(record.id)).attempt).toBeNull();
    const invalidated = await s.service.invalidate(record.id);
    expect(invalidated.authorization).toBeNull();
  });
  it('records wallet rejection as not submitted; a fresh run proceeds (nothing stays locked)', async () => {
    const s = await setup();
    const record = await reviewed(s);
    await s.service.begin(record.id, s.wallet.owner, workflow());
    const rejected = await s.service.walletFailure(record.id, { stage: 'SIGN', code: 'JUPITER_WALLET_REJECTED', error: { code: 4001 } });
    expect(rejected).toMatchObject({ notSubmitted: true, authorization: null, attempt: { state: 'CANCELLED', signature: null } });
    expect(s.env.state.sent).toEqual([]);
    const next = await reviewed(s);
    await expect(s.service.begin(next.id, s.wallet.owner, workflow())).resolves.toBeTruthy();
  });
  it('never broadcasts a transaction the wallet modified after Review', async () => {
    const s = await setup();
    const record = await reviewed(s);
    await s.service.begin(record.id, s.wallet.owner, workflow());
    const other = (await reviewed(await setup())).review.unsignedTransaction;
    const result = await s.service.submit(record.id, s.wallet.sign(other));
    expect(result).toMatchObject({ error: 'JUPITER_TRANSACTION_CHANGED', notSubmitted: true, attempt: { state: 'CANCELLED' } });
    expect(s.env.state.sent).toEqual([]);
  });
  it('never starts a second attempt of the same run, and never tracks one transaction in two runs', async () => {
    const s = await setup();
    const first = await reviewed(s), same = await reviewed(s);
    expect(same.review.messageHash).toBe(first.review.messageHash); // same quote, same blockhash: one Solana transaction
    const begin = await s.service.begin(first.id, s.wallet.owner, workflow());
    await expect(s.service.begin(first.id, s.wallet.owner, workflow())).rejects.toThrow('JUPITER_EXISTING_ATTEMPT_OBSERVE_ONLY');
    await expect(s.service.begin(same.id, s.wallet.owner, workflow())).rejects.toThrow('JUPITER_DUPLICATE_TRANSACTION_SIMULATE_AGAIN');
    // A double click or a retry of the SAME attempt after a timeout: broadcast once, then observe only.
    const signed = s.wallet.sign(begin.unsignedTransaction);
    expect((await s.service.submit(first.id, signed)).attempt?.state).toBe('PENDING');
    await expect(s.service.submit(first.id, signed)).rejects.toThrow('JUPITER_WALLET_HANDOFF_NOT_AUTHORIZED');
    expect(s.env.state.sent).toHaveLength(1);
  });
  it('executes independent swaps of the same wallet while earlier ones are pending, each with its own Review, signature and reconciliation', async () => {
    const s = await setup();
    const a = await reviewed(s), beginA = await s.service.begin(a.id, s.wallet.owner, workflow());
    expect((await s.service.submit(a.id, s.wallet.sign(beginA.unsignedTransaction))).attempt?.state).toBe('PENDING');
    // Swap B (another pair and amount) is reviewed and executed while A is still pending; an unfinished simulation C is simply left alone.
    s.env.advance(1);
    const unfinished = await s.service.simulate(workflow('3'), s.wallet.owner);
    const wfB = workflow('0.1', 'SOL', 'USDC'), b = await reviewed(s, wfB), beginB = await s.service.begin(b.id, s.wallet.owner, wfB);
    expect((await s.service.submit(b.id, s.wallet.sign(beginB.unsignedTransaction))).attempt?.state).toBe('PENDING');
    const [observedA, observedB] = [await s.service.observe(a.id), await s.service.observe(b.id)];
    expect(observedA).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    expect(observedB).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    expect(observedA.attempt?.signature).not.toBe(observedB.attempt?.signature);
    expect(await s.service.load(unfinished.id)).toMatchObject({ attempt: null, verdict: 'PENDING' });
    expect(s.env.state.sent).toHaveLength(2);
  });
  it('runs the same swap twice as two separately authorized operations: two distinct transactions, both reconciled', async () => {
    const s = await setup();
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const record = await reviewed(s), begin = await s.service.begin(record.id, s.wallet.owner, workflow());
      runs.push(await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction)));
      s.env.advance(1); // the next Simulate is quoted on a newer blockhash, as on mainnet-beta
    }
    expect(runs.map(r => r.attempt?.state)).toEqual(['PENDING', 'PENDING']);
    expect(new Set(runs.map(r => r.attempt?.signature)).size).toBe(2);
    expect(new Set(runs.map(r => r.review.messageHash)).size).toBe(2);
    for (const run of runs) expect((await s.service.observe(run.id)).observations.at(-1)).toMatchObject({ verdict: 'RECONCILED', inputSpent: '10000000' });
    expect(s.env.state.sent).toHaveLength(2);
  });
  it('recovers an uncertain submission by observing the persisted signature, never resubmitting', async () => {
    const s = await setup({ send: 'RPC_ERROR_AFTER_LANDING' });
    const record = await reviewed(s);
    const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    const uncertain = await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(uncertain).toMatchObject({ error: 'JUPITER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', attempt: { state: 'SUBMISSION_RESULT_UNKNOWN' } });
    expect(uncertain.attempt?.signature).toBeTruthy();
    const restarted = s.make();
    expect((await restarted.observe(record.id)).verdict).toBe('RECONCILED');
    expect(s.env.state.sent).toHaveLength(1);
  });
  it('proves a dropped transaction expired before allowing a new attempt', async () => {
    const s = await setup({ send: 'RPC_ERROR_DROPPED' });
    const record = await reviewed(s);
    const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect((await s.service.observe(record.id))).toMatchObject({ error: 'JUPITER_TRANSACTION_NOT_OBSERVED', verdict: 'PENDING' });
    // The uncertain swap keeps being observed by its own signature; it blocks neither its own message nor any other swap.
    const same = await reviewed(s);
    await expect(s.service.begin(same.id, s.wallet.owner, workflow())).rejects.toThrow('JUPITER_DUPLICATE_TRANSACTION_SIMULATE_AGAIN');
    s.env.advance(1);
    const independent = await reviewed(s);
    expect((await s.service.begin(independent.id, s.wallet.owner, workflow())).record.attempt?.state).toBe('PREPARED');
    s.env.advance(200);
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'NOT_EXECUTED', attempt: { state: 'NOT_FOUND' }, error: 'JUPITER_TRANSACTION_EXPIRED_NOT_EXECUTED' });
    const fresh = await reviewed(s);
    await expect(s.service.begin(fresh.id, s.wallet.owner, workflow())).resolves.toBeTruthy();
  });
  it('marks a pending broadcast that never landed as EXPIRED after validity', async () => {
    const s = await setup({ send: 'DROPPED' });
    const record = await reviewed(s);
    const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    expect((await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction))).attempt?.state).toBe('PENDING');
    s.env.advance(200);
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'NOT_EXECUTED', attempt: { state: 'EXPIRED' } });
  });
  it('cancels a prepared attempt found on restart because no signature was ever returned', async () => {
    const s = await setup();
    const record = await reviewed(s);
    await s.service.begin(record.id, s.wallet.owner, workflow());
    expect(await s.make().observe(record.id)).toMatchObject({ notSubmitted: true, error: 'JUPITER_WALLET_NOT_SUBMITTED', attempt: { state: 'CANCELLED' } });
  });
  it('records an on-chain failure as REVERTED / DIVERGENT', async () => {
    const options: MockedJupiterOptions = {};
    const s = await setup(options);
    const record = await reviewed(s);
    const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    options.failSwap = true;
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'JUPITER_SWAP_FAILED', attempt: { state: 'REVERTED' }, evidence: null });
  });
  it('accepts Phantom Lighthouse protections: verified, recorded, broadcast once and reconciled with honest evidence (HOTFIX-PHANTOM-LIGHTHOUSE-001)', async () => {
    const s = await setup(), wf = workflow('0.1', 'SOL', 'USDC');
    const record = await reviewed(s, wf), begin = await s.service.begin(record.id, s.wallet.owner, wf);
    // Like Phantom: the output account must end with at least its balance before the swap (100 USDC) plus the minimum output.
    const guarded = applyMockedPhantomLighthouseGuards(begin.unsignedTransaction, { lamportsAtLeast: 1n, tokenAccount: record.review.inspection.ownerOutputAccount,
      tokenAmountAtLeast: 100_000_000n + BigInt(record.review.quote.otherAmountThreshold) }, record.review.lookupTables);
    const submitted = await s.service.submit(record.id, s.wallet.sign(guarded));
    expect(submitted).toMatchObject({ error: null, attempt: { state: 'PENDING', walletGuard: { format: 'flofi.solana-wallet-guard.v1', reviewedMessageHash: record.review.messageHash,
      instructions: [{ kind: 'AssertAccountInfoMulti', target: s.wallet.owner }, { kind: 'AssertTokenAccountMulti', target: record.review.inspection.ownerOutputAccount }] } } });
    // The broadcast bytes are exactly what the owner signed, Lighthouse instructions included.
    expect(s.env.state.sent).toEqual([submitted.attempt!.transaction]);
    const observed = await s.service.observe(record.id);
    expect(observed).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED' } });
    const evidence = observed.evidence!.publicExecution as Record<string, unknown>;
    expect(evidence).toMatchObject({ messageHash: record.review.messageHash, signedMessageHash: submitted.attempt!.walletGuard!.signedMessageHash, programs: expect.arrayContaining([LIGHTHOUSE_PROGRAM]) });
    expect(observed.evidence!.bundle.reconciliation.limitations[0]).toMatch(/plus 2 Lighthouse assertion instruction\(s\) the owner's wallet appended/);
    // Restart: the stored guard is re-verified on every load.
    expect((await s.make().load(record.id)).attempt?.walletGuard?.signedMessageHash).toBe(submitted.attempt!.walletGuard!.signedMessageHash);
  });
  it('a Phantom assertion that fails on chain fails the whole swap atomically (REVERTED, no evidence, nothing locked)', async () => {
    const s = await setup(), wf = workflow('0.1', 'SOL', 'USDC');
    const record = await reviewed(s, wf), begin = await s.service.begin(record.id, s.wallet.owner, wf);
    const guarded = applyMockedPhantomLighthouseGuards(begin.unsignedTransaction, { lamportsAtLeast: 1n, tokenAccount: record.review.inspection.ownerOutputAccount,
      tokenAmountAtLeast: 100_000_000n + BigInt(record.review.quote.outAmount) * 2n }, record.review.lookupTables);
    expect((await s.service.submit(record.id, s.wallet.sign(guarded))).attempt?.state).toBe('PENDING');
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'JUPITER_SWAP_FAILED', attempt: { state: 'REVERTED' }, evidence: null });
    s.env.advance(1);
    const next = await reviewed(s, wf);
    expect((await s.service.begin(next.id, s.wallet.owner, wf)).record.attempt?.state).toBe('PREPARED');
  });
  it('still refuses wallet additions it cannot verify, and keeps the diagnostic', async () => {
    const s = await setup(), record = await reviewed(s), begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    const refused = await s.service.submit(record.id, s.wallet.sign(appendMockedWalletGuards(begin.unsignedTransaction, 2, record.review.lookupTables)));
    expect(refused).toMatchObject({ error: 'JUPITER_TRANSACTION_CHANGED', notSubmitted: true, attempt: { state: 'CANCELLED', signature: null },
      walletDiagnostic: { change: { reviewedInstructionsPreserved: true, addedPrograms: [LIGHTHOUSE_PROGRAM] } } });
    expect(refused.attempt?.walletGuard).toBeUndefined();
    expect(s.env.state.sent).toEqual([]);
  });
  it('rejects a journal whose recorded wallet guard no longer matches the signed bytes', async () => {
    const s = await setup(), wf = workflow('0.1', 'SOL', 'USDC');
    const record = await reviewed(s, wf), begin = await s.service.begin(record.id, s.wallet.owner, wf);
    const guarded = applyMockedPhantomLighthouseGuards(begin.unsignedTransaction, { lamportsAtLeast: 1n }, record.review.lookupTables);
    const submitted = await s.service.submit(record.id, s.wallet.sign(guarded));
    expect(parseTransaction(fromBase64(submitted.attempt!.transaction!, 2048)).signatures).toHaveLength(1);
    const file = join(s.dir, record.id + '.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('lamports >= 1', 'lamports >= 0'));
    await expect(s.service.load(record.id)).rejects.toThrow('JUPITER_STORE_CORRUPT');
  });
  it('rejects a tampered durable journal', async () => {
    const s = await setup();
    const record = await reviewed(s);
    const file = join(s.dir, record.id + '.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')).replace(record.review.amount, '1'));
    await expect(s.service.load(record.id)).rejects.toThrow();
  });
});
