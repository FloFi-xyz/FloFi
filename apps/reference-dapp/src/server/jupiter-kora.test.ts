// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ADR-0010 §4 (BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003): the Jupiter swap flow with Pimlico's Kora fee payer, end to end on the MOCKED loopback
 * cluster and the loopback Kora JSON-RPC double. No provider, RPC or mainnet is contacted; nothing here is mainnet evidence.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockedSolanaJupiter, createMockedSolanaWallet, fromBase64, parseTransaction, base58Encode, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaSwapNode } from '../domain/jupiter-authoring';
import { createJupiterService } from './jupiter-service';
import { createKoraGas, koraGasFromEnv } from '../gas-abstraction/kora/runtime';
import { createKoraClient } from '../gas-abstraction/kora/client';
import { readKoraGasConfig } from '../gas-abstraction/config';
import { amountsFromOwnerRecord } from '../workflow-runs/received-amounts';
import { startKoraDouble, type KoraDouble } from '../test-utils/kora-double';

const T = SOLANA_MAINNET_TOKENS, RENT = 2_039_280n;
const workflow = (amount: string, from: 'USDC' | 'USDT' | 'SOL', to: 'SOL' | 'USDC' | 'USDT'): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-kora', revision: 1,
  resourceEdges: [], nodes: [createSolanaSwapNode('node-002', { network: 'Solana', from, to, amount, slippage: '50' })] });
const doubles: KoraDouble[] = [];
afterEach(async () => { while (doubles.length) await doubles.pop()!.close(); });

async function setup(owner: { lamports: bigint; USDC?: bigint; USDT?: bigint }, options: { signTimeoutMs?: number; pins?: { signer?: string; payment?: string } } = {}) {
  const env = createMockedSolanaJupiter(), wallet = createMockedSolanaWallet();
  const double = await startKoraDouble({ rpc: env.rpc, tokens: [{ mint: T.USDC.mint, decimals: 6 }, { mint: T.USDT.mint, decimals: 6 }] });
  doubles.push(double);
  const balances: Partial<Record<'USDC' | 'USDT', bigint>> = {};
  if (owner.USDC !== undefined) balances.USDC = owner.USDC;
  if (owner.USDT !== undefined) balances.USDT = owner.USDT;
  env.fund(wallet.owner, owner.lamports, balances); env.fund(double.signer, 5_000_000_000n); env.fund(double.payment, 0n, { USDC: 0n, USDT: 0n });
  const configEnv = { FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: double.url, FLOFI_KORA_SIGNER: options.pins?.signer ?? double.signer,
    FLOFI_KORA_PAYMENT_ADDRESS: options.pins?.payment ?? double.payment };
  const config = readKoraGasConfig(configEnv);
  if (!config.enabled) throw new Error('test configuration');
  const kora = options.signTimeoutMs ? createKoraGas(config, createKoraClient(config.rpcUrl, { signTimeoutMs: options.signTimeoutMs })) : koraGasFromEnv(configEnv);
  const dir = await mkdtemp(join(tmpdir(), 'flofi-jupiter-kora-'));
  let clock = Date.parse('2026-11-13T12:00:00.000Z');
  const make = () => createJupiterService({ rpc: env.rpc, http: env.http, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now: () => clock, kora });
  return { env, wallet, double, service: make(), make, tick: (ms: number) => { clock += ms; } };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function signed(s: Setup, wf: SemanticWorkflow) {
  const simulated = await s.service.simulate(wf, s.wallet.owner);
  const reviewed = await s.service.review(simulated.id, simulated.review.commitment, wf);
  const begin = await s.service.begin(reviewed.id, s.wallet.owner, wf);
  return { id: reviewed.id, review: reviewed.review, ownerSigned: s.wallet.sign(begin.unsignedTransaction) };
}

describe('Jupiter swap with Pimlico Kora (MOCKED loopback, ADR-0010 §4)', () => {
  it('keeps native gas, unchanged, for an owner whose SOL covers the fee: Kora is never contacted', async () => {
    const s = await setup({ lamports: 3_000_000_000n, USDC: 100_000_000n });
    const { id, review, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    expect(review.gas).toBeUndefined();
    expect(parseTransaction(fromBase64(review.unsignedTransaction, 2048)).signatures).toHaveLength(1);
    await s.service.submit(id, ownerSigned);
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'RECONCILED' });
    expect(s.double.state.calls).toEqual([]);
  });
  it('swaps USDC→SOL for an owner with no SOL: Kora signs the verified owner-signed bytes, FloFi broadcasts them and reconciles the token fee', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const wf = workflow('10', 'USDC', 'SOL');
    const { id, review, ownerSigned } = await signed(s, wf);
    expect(review.gas).toMatchObject({ mechanism: 'PIMLICO_KORA_SPL_FEE', feePayer: s.double.signer, paymentAddress: s.double.payment, token: { symbol: 'USDC' } });
    expect(BigInt(review.gas!.amount)).toBeGreaterThan(0n);
    // Durable before Kora: the owner's signature (slot 1) and the owner-signed bytes; the transaction id does not exist yet.
    const submitted = await s.service.submit(id, ownerSigned);
    const ownerSignature = base58Encode(parseTransaction(fromBase64(ownerSigned, 2048)).signatures[1]!);
    expect(submitted.attempt).toMatchObject({ state: 'PENDING', transaction: ownerSigned, kora: { ownerSignature } });
    expect(submitted.attempt!.signature).not.toBe(ownerSignature);
    expect(s.double.state.signed).toEqual([ownerSigned]);
    expect(s.double.state.unpaid).toBe(0);
    // FloFi broadcast the same fully signed bytes Kora returned (Kora also sent them in the background).
    expect(s.env.state.sent.at(-1)).toBe(submitted.attempt!.kora!.signedTransaction);
    const observed = await s.service.observe(id);
    expect(observed).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    const observation = observed.observations.at(-1)!;
    expect(observation.tokenFee).toMatchObject({ feePayer: s.double.signer, payee: s.double.payment, amount: review.gas!.amount, token: { symbol: 'USDC' } });
    // The wrapped-SOL rent Kora advanced and the owner got back on close is not swap output; the owner paid no SOL.
    expect(observation.outputReceived).toBe(review.quote.outAmount);
    expect(s.env.state.lamports.get(s.wallet.owner)).toBe(BigInt(review.quote.outAmount) + RENT);
    expect(observed.evidence?.bundle.reconciliation.fees).toContainEqual({ asset: { chainId: review.chain, address: T.USDC.mint, decimals: 6 }, amount: review.gas!.amount });
    // Reconciliation after reload: a new service instance reads the same durable record; workflow continuity takes the reconciled output.
    const reloaded = await s.make().load(id);
    expect(reloaded).toMatchObject({ verdict: 'RECONCILED' });
    expect(amountsFromOwnerRecord(reloaded)).toEqual({ spent: [{ asset: expect.stringContaining(T.USDC.mint), amount: '10000000' }],
      received: [{ asset: expect.stringContaining(T.SOL.mint), amount: review.quote.outAmount }] });
  });
  it('swaps USDC→USDT paying the fee in USDT, and USDT→SOL for an owner holding only USDT', async () => {
    const both = await setup({ lamports: 0n, USDC: 10_000_000n, USDT: 2_000_000n });
    const first = await signed(both, workflow('10', 'USDC', 'USDT'));
    expect(first.review.gas?.token.symbol).toBe('USDT');
    await both.service.submit(first.id, first.ownerSigned);
    await expect(both.service.observe(first.id)).resolves.toMatchObject({ verdict: 'RECONCILED' });
    const onlyUsdt = await setup({ lamports: 0n, USDT: 50_000_000n });
    const second = await signed(onlyUsdt, workflow('10', 'USDT', 'SOL'));
    expect(second.review.gas?.token.symbol).toBe('USDT');
    await onlyUsdt.service.submit(second.id, second.ownerSigned);
    await expect(onlyUsdt.service.observe(second.id)).resolves.toMatchObject({ verdict: 'RECONCILED' });
  });
  it('refuses an owner without enough SOL and without enough USDC/USDT for the fee before anything is signed', async () => {
    const s = await setup({ lamports: 0n, USDC: 10_000_000n });
    await expect(s.service.simulate(workflow('10', 'USDC', 'SOL'), s.wallet.owner)).rejects.toThrow('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT');
    expect(s.double.state.signed).toEqual([]);
  });
  it('refuses a Kora endpoint whose signer is not the pinned one', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n }, { pins: { signer: createMockedSolanaWallet().owner } });
    await expect(s.service.simulate(workflow('10', 'USDC', 'SOL'), s.wallet.owner)).rejects.toThrow('KORA_SIGNER_MISMATCH');
  });
  it('sends nothing when Kora answers "Insufficient token payment": the run is not executed and a new Review re-quotes', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const wf = workflow('10', 'USDC', 'SOL');
    const first = await signed(s, wf);
    s.double.state.priceDriftBps = 500n; // SOL rose 5% between the quote and Kora's own check at signing
    const refused = await s.service.submit(first.id, first.ownerSigned);
    expect(refused).toMatchObject({ verdict: 'NOT_EXECUTED', authorization: null, error: 'KORA_PAYMENT_INSUFFICIENT', attempt: { state: 'NOT_FOUND', signature: null } });
    expect(s.env.state.sent).toEqual([]);
    const second = await signed(s, wf);
    expect(BigInt(second.review.gas!.amount)).toBeGreaterThan(BigInt(first.review.gas!.amount));
    await expect(s.service.submit(second.id, second.ownerSigned)).resolves.toMatchObject({ attempt: { state: 'PENDING' } });
    expect(s.double.state.unpaid).toBe(0);
  });
  it('never retries without payment: Kora -32603 (provider unavailable) proves nothing, so the run is observed and not executed only once expired', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const { id, review, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    s.double.state.signMode = 'UNAVAILABLE';
    // K1: -32603 does not prove Kora skipped signing: the outcome is unknown until the blockhash provably expired without the transaction.
    await expect(s.service.submit(id, ownerSigned)).resolves.toMatchObject({ verdict: 'PENDING', submissionError: 'KORA_PROVIDER_UNAVAILABLE',
      attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null } });
    expect(s.double.state.signed).toHaveLength(1);
    s.env.advance(review.lastValidBlockHeight - s.env.state.blockHeight + 1);
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'NOT_EXECUTED', error: 'JUPITER_TRANSACTION_EXPIRED_NOT_EXECUTED' });
    expect(s.env.state.sent).toEqual([]);
  });
  // K1: an answer that does not prove Kora skipped signing is never taken as a refusal; the transaction is recovered from the chain.
  it('a gateway 504 after Kora signed and broadcast: the run is observed and reconciles (never "not executed")', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const { id, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    s.double.state.gatewayErrorsAfterSign = 1;
    await expect(s.service.submit(id, ownerSigned)).resolves.toMatchObject({ verdict: 'PENDING', submissionError: 'KORA_PROVIDER_UNAVAILABLE',
      attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null } });
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    expect(s.double.state.signed).toHaveLength(1);
  });
  it('a lost answer whose identical retry Kora refuses (already processed): the refusal of a second call is not taken as "never signed"', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const { id, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    s.double.state.loseAnswers = 1; s.double.state.refuseRepeat = true;
    await expect(s.service.submit(id, ownerSigned)).resolves.toMatchObject({ verdict: 'PENDING', submissionError: 'KORA_TRANSACTION_REFUSED',
      attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null } });
    expect(s.double.state.signed).toEqual([ownerSigned, ownerSigned]);
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
  });
  it('retries a lost Kora answer once with the identical bytes, and recovers a twice-lost answer from the chain by the owner\'s signature', async () => {
    const once = await setup({ lamports: 0n, USDC: 100_000_000n });
    const a = await signed(once, workflow('10', 'USDC', 'SOL'));
    once.double.state.loseAnswers = 1;
    await expect(once.service.submit(a.id, a.ownerSigned)).resolves.toMatchObject({ attempt: { state: 'PENDING' } });
    expect(once.double.state.signed).toEqual([a.ownerSigned, a.ownerSigned]);
    const twice = await setup({ lamports: 0n, USDC: 100_000_000n });
    const b = await signed(twice, workflow('10', 'USDC', 'SOL'));
    twice.double.state.loseAnswers = 2;
    const unknown = await twice.service.submit(b.id, b.ownerSigned);
    expect(unknown).toMatchObject({ error: 'JUPITER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null } });
    // Kora broadcast it in the background: the owner's history holds it; FloFi finds it read-only and reconciles (no third Kora call).
    const recovered = await twice.service.observe(b.id);
    expect(recovered).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    expect(recovered.attempt!.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(twice.double.state.signed).toHaveLength(2);
  });
  it('refuses an answer signed by another key, then finds the real transaction by the owner\'s signature', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const { id, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    s.double.state.signMode = 'WRONG_SIGNER';
    const unknown = await s.service.submit(id, ownerSigned);
    expect(unknown).toMatchObject({ attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null } });
    expect(unknown.submissionError).toMatch(/^KORA_(SIGNER_MISMATCH|ANSWER_INVALID)$/);
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'RECONCILED' });
  });
  it('a timed-out Kora call that never signed expires provably, never re-created', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n }, { signTimeoutMs: 150 });
    const { id, review, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    s.double.state.signMode = 'HANG_UNSIGNED';
    const unknown = await s.service.submit(id, ownerSigned);
    expect(unknown).toMatchObject({ attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null }, submissionError: 'KORA_UNREACHABLE' });
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'PENDING', error: 'JUPITER_TRANSACTION_NOT_OBSERVED' });
    s.env.advance(review.lastValidBlockHeight - s.env.state.blockHeight + 1);
    await expect(s.service.observe(id)).resolves.toMatchObject({ verdict: 'NOT_EXECUTED', attempt: { state: 'NOT_FOUND' }, error: 'JUPITER_TRANSACTION_EXPIRED_NOT_EXECUTED' });
    expect(s.env.state.sent).toEqual([]);
  });
  it('refuses an expired blockhash before Kora is called, and a Review the policy would no longer pick (SOL arrived)', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const wf = workflow('10', 'USDC', 'SOL');
    const { id, ownerSigned, review } = await signed(s, wf);
    s.env.advance(review.lastValidBlockHeight - s.env.state.blockHeight);
    await expect(s.service.submit(id, ownerSigned)).resolves.toMatchObject({ notSubmitted: true, error: 'JUPITER_QUOTE_STALE' });
    expect(s.double.state.signed).toEqual([]);
    const again = await setup({ lamports: 0n, USDC: 100_000_000n });
    const simulated = await again.service.simulate(wf, again.wallet.owner);
    const reviewed = await again.service.review(simulated.id, simulated.review.commitment, wf);
    again.env.fund(again.wallet.owner, 3_000_000_000n, { USDC: 100_000_000n });
    await expect(again.service.begin(reviewed.id, again.wallet.owner, wf)).rejects.toThrow('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
  });
  it('never hands a Kora transaction whose payment was removed to Kora', async () => {
    const s = await setup({ lamports: 0n, USDC: 100_000_000n });
    const { review, ownerSigned } = await signed(s, workflow('10', 'USDC', 'SOL'));
    const kora = koraGasFromEnv({ FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: s.double.url, FLOFI_KORA_SIGNER: s.double.signer, FLOFI_KORA_PAYMENT_ADDRESS: s.double.payment })!;
    // The same Review with a smaller fee than the bytes carry: K1 on the exact bytes refuses before any network call.
    await expect(kora.relay({ review: { ...review, gas: { ...review.gas!, amount: '1' } }, ownerSigned, prefix: 'JUPITER' })).rejects.toThrow('KORA_PAYMENT_CHANGED');
    expect(s.double.state.signed).toEqual([]);
  });
});
