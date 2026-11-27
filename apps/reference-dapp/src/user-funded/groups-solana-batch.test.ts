// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): the user-funded life of an atomic Solana Batch Payment group — prepared as ONE
 * owner-signed v0 transaction of every leg (never Kora, never split), authorized only with the owner's signature of exactly the reviewed message
 * (or it plus verified Lighthouse assertions), sent once and resent only with the same bytes, reconciled as a whole (every leg exactly, or none),
 * and, when its unsigned preparation expired, prepared again only once the chain proves the earlier request did not land (C.4, H1 + H3).
 *
 * MOCKED loopback cluster only (the compiler's MOCKED Solana transfer chain and mocked wallets): FloFi's logic, never a public execution.
 */
import { describe, expect, it } from 'vitest';
import { applyMockedPhantomLighthouseGuards, createMockedSolanaTransferChain, createMockedSolanaWallet, decodeSolanaBatchPaymentMessage, fromBase64, parseMessageV0,
  parseTransaction, serializeMessageV0, serializeTransaction, setComputeUnitPrice, toBase64, MOCKED_RENT, SOLANA_MAINNET_TOKENS, SOLANA_MAINNET_TRANSFER,
  type MockedTransferOptions } from '@defi-workflow-engine/reference-compiler';
import { requirementOf, type WorkflowRequirement } from '../delegation/steps.ts';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import type { KoraGas } from '../gas-abstraction/kora/runtime.ts';
import { advanceSolanaSubmission, authorizeGroup, earlierSolanaBatchRequestOutcome, hasEarlierSolanaBatchRequest, isSolanaBatchPrepared, prepareGroup, reconcileSolanaGroup,
  sameSolanaBatchAnswer, settleExpiredSolanaBatch, solanaBatchAuthorizationRefusal, solanaBatchView, solanaSubmission, type NativeFeeShortfall, type Prepared, type SolanaGroupTx,
  type UserFundedDeps } from './groups.ts';

const SOLANA = SOLANA_MAINNET_TRANSFER.chain, USDC = SOLANA_MAINNET_TOKENS.USDC.mint, WSOL = 'So11111111111111111111111111111111111111112';
const NOW = new Date('2026-11-27T12:00:00.000Z');
type BatchPrepared = Prepared & { owner: string; atomic: true; transactions: SolanaGroupTx[]; fee: { payer: string; unit: string; maxCost: string; estimated: boolean };
  lastValidBlockHeight: number; preparedAt: string };

function compose(input: unknown): { composition: WorkflowComposition; requirement: WorkflowRequirement } {
  const c = composeWorkflow(input);
  if (!c.ok) throw new Error(c.code);
  const r = requirementOf(c);
  if (!r.ok) throw new Error(r.code);
  return { composition: c, requirement: r.value };
}
/** An owner with 10 SOL and USDC on the MOCKED mainnet cluster, three fresh recipients, and the group of a batch to them. */
function setup(options: MockedTransferOptions & { readonly lamports?: bigint; readonly kora?: KoraGas } = {}) {
  const chain = createMockedSolanaTransferChain(options), owner = createMockedSolanaWallet();
  chain.fundWallet(owner.owner, options.lamports ?? 10_000_000_000n);
  chain.createMint(USDC, { decimals: 6 });
  const source = chain.fundToken(owner.owner, USDC, 1_000_000_000n);
  const recipients = Array.from({ length: 3 }, () => createMockedSolanaWallet().owner);
  const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, solana: chain.rpc, now: () => NOW, ...options.kora ? { kora: options.kora } : {} };
  const batch = (asset: 'SOL' | 'USDC', amounts: readonly string[] = asset === 'SOL' ? ['0.01', '0.02', '0.03'] : ['1', '2', '3']) =>
    ({ action: 'batch_payment', network: 'solana', asset, recipients: recipients.map((recipient, i) => ({ recipient, amount: amounts[i]! })) });
  const group = (stepFrom = 0, stepTo = 2) => ({ runId: 'wfr_' + 'k'.repeat(26), groupIndex: 0, strategy: 'SOLANA_SIGN_ALL' as const, chain: SOLANA, feePayer: owner.owner,
    stepFrom, stepTo });
  async function prepare(input: unknown, g = group()) {
    const { composition, requirement } = compose(input);
    return prepareGroup(deps, composition, requirement, g);
  }
  async function prepared(input: unknown, g = group()) {
    const p = await prepare(input, g);
    if (!p.ok) throw new Error(p.code);
    return { prepared: p.value.prepared as BatchPrepared, validUntil: p.value.validUntil };
  }
  return { chain, owner, source, recipients, deps, batch, group, prepare, prepared };
}
const txOf = (p: BatchPrepared) => p.transactions[0]!;
const decodedOf = (p: BatchPrepared) => {
  const b = txOf(p).batch!;
  return decodeSolanaBatchPaymentMessage(fromBase64(txOf(p).message), { owner: txOf(p).owner, profile: SOLANA_MAINNET_TRANSFER, token: b.token, computeUnitPrice: b.computeUnitPrice });
};
/** The stored transaction as plain, writable JSON (what a tampered database row would hold). */
type RawTx = { legs: { amount: string; recipient: string }[]; messageHash: string; sinceSlot?: number;
  batch: { manifestHash: string; total: string; computeUnitLimit: number; token: { sourceAccount: string }; asset: { mint: string | null } } };
/** A deep copy with one stored field changed (a tampered artifact). */
const tampered = (p: BatchPrepared, change: (tx: RawTx) => void): BatchPrepared => {
  const copy = JSON.parse(JSON.stringify(p)) as BatchPrepared;
  change(copy.transactions[0] as unknown as RawTx);
  return copy;
};

describe('KAN-20 prepare: ONE atomic transaction of every leg, exactly the batch manifest', () => {
  it('a SOL batch: one BATCH_PAYMENT transaction with its legs and batch facts, the owner as fee payer, honoured 50 s', async () => {
    const s = setup();
    const { prepared, validUntil } = await s.prepared(s.batch('SOL'));
    expect(isSolanaBatchPrepared(prepared)).toBe(true);
    expect(prepared).toMatchObject({ kind: 'SOLANA_SIGN_ALL', owner: s.owner.owner, atomic: true });
    expect(prepared.transactions).toHaveLength(1);
    const tx = txOf(prepared);
    expect(tx).toMatchObject({ stepIndex: 0, kind: 'BATCH_PAYMENT', owner: s.owner.owner, lookupTables: {}, minimumOut: null,
      spend: { asset: `${SOLANA}/token:${WSOL}`, amount: '60000000' }, sinceSlot: expect.any(Number) });
    expect(tx.legs!.map(l => [l.stepIndex, l.recipient, l.amount, l.spend.amount, l.destinationAccount, l.createDestination])).toEqual([
      [0, s.recipients[0], '10000000', '10000000', null, false], [1, s.recipients[1], '20000000', '20000000', null, false], [2, s.recipients[2], '30000000', '30000000', null, false]]);
    expect(tx.batch).toMatchObject({ format: 'flofi.solana-batch-group.v1', chain: SOLANA, batchStep: 0, atomic: true, total: '60000000', token: null,
      asset: { symbol: 'SOL', mint: null, decimals: 9, program: 'native', verified: true }, accountCreationLamports: '0', maximumAccountCreationLamports: '0',
      manifestHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), reviewCommitment: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    // Signed within the blockhash lifetime minus the one-transaction send budget (25 blocks): 50 s, the batch Review's own validity.
    expect(validUntil.getTime() - NOW.getTime()).toBe(50_000);
    // S1: the owner is the fee payer (static key 0) and the only signer; the reviewed fee ceiling is the network fee (no deposits for SOL).
    const message = parseMessageV0(fromBase64(tx.message));
    expect([message.staticKeys[0], message.header[0]]).toEqual([s.owner.owner, 1]);
    expect(prepared.fee).toEqual({ payer: s.owner.owner, unit: 'lamports', maxCost: tx.maximumNetworkCostLamports, estimated: true });
    expect(tx.maximumNetworkCostLamports).toBe(tx.estimatedFeeLamports);
    // The decoded message is exactly the legs.
    expect(decodedOf(prepared).payments).toEqual(tx.legs!.map(l => ({ recipient: l.recipient, amount: l.amount, destinationAccount: null })));
    // The owner's view (surfaces read it): one atomic transaction and its numbers.
    expect(solanaBatchView(prepared)).toEqual({ atomic: true, asset: { symbol: 'SOL', decimals: 9 }, total: '60000000', estimatedFeeLamports: tx.estimatedFeeLamports,
      accountCreationLamports: '0', maximumAccountCreationLamports: '0', maximumNetworkCostLamports: tx.maximumNetworkCostLamports,
      requiredLamports: tx.batch!.requiredLamports, transactionBytes: tx.batch!.transactionBytes });
    // FloFi sent nothing.
    expect(s.chain.state.sent).toEqual([]);
  });

  it('a USDC batch with existing and missing token accounts: deposits only for the missing ones, the worst case for every leg, SOL to cover them', async () => {
    const s = setup();
    s.chain.fundToken(s.recipients[0]!, USDC, 5n);
    const { prepared } = await s.prepared(s.batch('USDC'));
    const tx = txOf(prepared), rent = MOCKED_RENT.token.toString();
    expect(tx.legs!.map(l => [l.amount, l.spend.asset, l.createDestination, l.accountCreationLamports, l.maximumAccountCreationLamports])).toEqual([
      ['1000000', `${SOLANA}/token:${USDC}`, false, '0', rent], ['2000000', `${SOLANA}/token:${USDC}`, true, rent, rent], ['3000000', `${SOLANA}/token:${USDC}`, true, rent, rent]]);
    expect(tx.legs!.map(l => l.destinationAccount)).toEqual(s.recipients.map(r => s.chain.ata(r, USDC)));
    expect(tx.batch).toMatchObject({ total: '6000000', accountCreationLamports: (2n * MOCKED_RENT.token).toString(), maximumAccountCreationLamports: (3n * MOCKED_RENT.token).toString(),
      token: { programId: SOLANA_MAINNET_TRANSFER.programs.token, mint: USDC, decimals: 6, sourceAccount: s.source }, asset: { symbol: 'USDC', mint: USDC, program: 'spl-token' } });
    expect(BigInt(tx.maximumNetworkCostLamports!)).toBe(BigInt(tx.estimatedFeeLamports) + 3n * MOCKED_RENT.token);
    // The owner's SOL must cover the fee, every worst-case deposit and its own rent-exempt reserve.
    expect(BigInt(tx.batch!.requiredLamports)).toBe(BigInt(tx.maximumNetworkCostLamports!) + MOCKED_RENT.system);
    expect(solanaBatchView(prepared)).toMatchObject({ asset: { symbol: 'USDC', decimals: 6 }, accountCreationLamports: (2n * MOCKED_RENT.token).toString() });
  });

  it('Kora configured and the owner short of SOL: SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL with the lamport shortfall as evidence; Kora is never asked', async () => {
    const touched: string[] = [];
    const kora = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); throw new Error('KORA_TOUCHED'); } }) as KoraGas;
    const s = setup({ lamports: 1_000_000n, kora });
    for (const asset of ['SOL', 'USDC'] as const) {
      const r = await s.prepare(s.batch(asset));
      expect(r, asset).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL', stepIndex: 0 });
      const e = (r as { evidence: NativeFeeShortfall }).evidence;
      expect(e).toMatchObject({ kind: 'NATIVE_FEE_SHORTFALL', chainId: SOLANA, owner: s.owner.owner, unit: 'lamports', balance: '1000000',
        nativeSpend: asset === 'SOL' ? '60000000' : '0', reserve: MOCKED_RENT.system.toString(), deposits: asset === 'SOL' ? '0' : expect.stringMatching(/^[1-9][0-9]*$/) });
      // The shared shape: maxFee = fee + deposits, required = SOL sent + maxFee + reserve, shortfall = required - balance.
      expect(BigInt(e.required)).toBe(BigInt(e.nativeSpend) + BigInt(e.maxFee) + BigInt(e.reserve!));
      expect(BigInt(e.shortfall)).toBe(BigInt(e.required) - BigInt(e.balance));
      expect(BigInt(e.maxFee)).toBeGreaterThan(BigInt(e.deposits!));
    }
    expect(touched).toEqual([]);
    expect(s.chain.state.sent).toEqual([]);
  });

  it('every composed leg must be exactly its manifest line (SOLANA_BATCH_PAYMENT_LEG_MISMATCH), at its step', async () => {
    const s = setup();
    const { composition, requirement } = compose(s.batch('SOL'));
    const leg = (input: unknown) => { const c = composeWorkflow(input); if (!c.ok) throw new Error(c.code); return c.steps[0]!; };
    const swap = (index: number, step: WorkflowComposition['steps'][number]) => ({ ...composition, steps: composition.steps.map((c, i) => i === index ? step : c) });
    const cases: [string, WorkflowComposition, number][] = [
      ['another amount', swap(1, leg({ action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.021', recipient: s.recipients[1] })), 1],
      ['another recipient', swap(2, leg({ action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.03', recipient: createMockedSolanaWallet().owner })), 2],
      ['another asset', swap(0, leg({ action: 'transfer', network: 'solana', asset: 'USDC', amount: '0.01', recipient: s.recipients[0] })), 0],
      ['legs out of order', { ...composition, steps: [composition.steps[1]!, composition.steps[0]!, composition.steps[2]!] }, 0]];
    for (const [label, tamperedComposition, step] of cases)
      expect(await prepareGroup(s.deps, tamperedComposition, requirement, s.group()), label).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_LEG_MISMATCH', stepIndex: step });
    expect(s.chain.state.sent).toEqual([]);
  });

  it('a bound leg spends exactly its amount from a producer before the batch (SOLANA_BATCH_PAYMENT_BINDING_NOT_EXACT otherwise)', async () => {
    const s = setup();
    const { composition, requirement } = compose({ version: 2, steps: [{ action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '5' }, s.batch('SOL')],
      bindings: [{ step: 1, amountFrom: 0 }] });
    expect(composition.bindings.map(b => [b.step, b.amountFrom, b.exact])).toEqual([[1, 0, true], [2, 0, true], [3, 0, true]]);
    const g = s.group(1, 3);
    // The legs FloFi composed are exactly the manifest's amounts (their caps): the batch is prepared.
    const bound = await prepareGroup(s.deps, composition, requirement, g);
    if (!bound.ok) throw new Error(bound.code);
    expect(txOf(bound.value.prepared as BatchPrepared)).toMatchObject({ stepIndex: 1, kind: 'BATCH_PAYMENT' });
    expect(txOf(bound.value.prepared as BatchPrepared).legs!.map(l => [l.stepIndex, l.amount])).toEqual([[1, '10000000'], [2, '20000000'], [3, '30000000']]);
    const notExact = { ...composition, bindings: composition.bindings.map(b => b.step === 2 ? Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'exact')) : b) };
    expect(await prepareGroup(s.deps, notExact as unknown as WorkflowComposition, requirement, g)).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_BINDING_NOT_EXACT', stepIndex: 2 });
    const inside = { ...composition, bindings: composition.bindings.map(b => b.step === 3 ? { ...b, amountFrom: 1 } : b) };
    expect(await prepareGroup(s.deps, inside, requirement, g)).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_BINDING_NOT_EXACT', stepIndex: 3 });
  });

  it('a group that is not exactly the batch is never prepared (part of it, or it with another step): SOLANA_BATCH_PAYMENT_GROUP_INVALID', async () => {
    const s = setup();
    expect(await s.prepare(s.batch('SOL'), s.group(0, 1))).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_GROUP_INVALID' });
    const other = { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.04', recipient: createMockedSolanaWallet().owner };
    expect(await s.prepare({ version: 2, steps: [other, s.batch('SOL')] }, s.group(0, 3))).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_GROUP_INVALID' });
    // The same transfer on its own (its own group) is prepared as before.
    expect(await s.prepare({ version: 2, steps: [other, s.batch('SOL')] }, s.group(0, 0))).toMatchObject({ ok: true, value: { prepared: { transactions: [{ kind: 'TRANSFER' }] } } });
  });

  it('a deterministic refusal of the compiler names the recipient\'s step (a recipient that is the owner)', async () => {
    const s = setup();
    const self = { action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: [{ recipient: s.recipients[0], amount: '0.01' }, { recipient: s.owner.owner, amount: '0.02' }] };
    expect(await s.prepare(self, s.group(0, 1))).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_RECIPIENT_IS_SENDER', stepIndex: 1 });
  });
});

describe('KAN-20 authorize: only the owner\'s signature of exactly the reviewed message (C.2)', () => {
  it('exact bytes, or Phantom\'s verified Lighthouse guard (kept as evidence); a foreign signer, extra or changed instructions and a wrong count are refused', async () => {
    const s = setup();
    const { prepared } = await s.prepared(s.batch('USDC'));
    const tx = txOf(prepared);
    const exact = authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [s.owner.sign(tx.unsignedTransaction)] }, s.owner.owner, NOW);
    expect(exact).toMatchObject({ ok: true, value: { kind: 'SOLANA_SIGN_ALL', transactions: [{ signature: expect.any(String), transaction: expect.any(String) }] } });
    expect((exact as unknown as { value: { transactions: Record<string, unknown>[] } }).value.transactions[0]).not.toHaveProperty('walletGuard');
    const guarded = applyMockedPhantomLighthouseGuards(tx.unsignedTransaction, { lamportsAtLeast: 1n, tokenAccount: s.source, tokenAmountAtLeast: 0n });
    expect(authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [s.owner.sign(guarded)] }, s.owner.owner, NOW))
      .toMatchObject({ ok: true, value: { transactions: [{ walletGuard: { reviewedMessageHash: tx.messageHash } }] } });
    const stranger = createMockedSolanaWallet();
    expect(authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [stranger.sign(tx.unsignedTransaction)] }, s.owner.owner, NOW))
      .toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_SIGNATURE_INVALID', stepIndex: 0 });
    // Another instruction appended, or a priority fee changed: the signed message is no longer the reviewed one.
    const parsed = parseMessageV0(fromBase64(tx.message));
    const extra = serializeMessageV0({ ...parsed, instructions: [...parsed.instructions, { ...parsed.instructions[2]! }] });
    const price = setComputeUnitPrice('1')[0]!;
    const repriced = serializeMessageV0({ ...parsed, instructions: parsed.instructions.map((ix, i) => i === 1 ? { ...ix, data: price.data } : ix) });
    for (const [label, message] of [['extra instruction', extra], ['priority fee', repriced]] as const)
      expect(authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [s.owner.sign(toBase64(serializeTransaction(null, message)))] }, s.owner.owner, NOW), label)
        .toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED' });
    for (const transactions of [[], [s.owner.sign(tx.unsignedTransaction), s.owner.sign(tx.unsignedTransaction)]])
      expect(authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions }, s.owner.owner, NOW)).toMatchObject({ ok: false, code: 'SOLANA_SIGNED_COUNT_MISMATCH' });
    // Signed by the owner, but answered for another owner's run: refused.
    expect(authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [s.owner.sign(tx.unsignedTransaction)] }, stranger.owner, NOW))
      .toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED' });
  });

  it('a tampered stored artifact is never authorized, even with the owner\'s signature of its message: SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED', async () => {
    const s = setup();
    const { prepared } = await s.prepared(s.batch('USDC'));
    const signed = s.owner.sign(txOf(prepared).unsignedTransaction);
    const cases: [string, BatchPrepared][] = [
      ['a leg amount', tampered(prepared, tx => { tx.legs[1]!.amount = '2000001'; })],
      ['a leg recipient', tampered(prepared, tx => { tx.legs[2]!.recipient = createMockedSolanaWallet().owner; })],
      ['legs reordered', tampered(prepared, tx => { tx.legs.reverse(); })],
      ['a leg dropped', tampered(prepared, tx => { tx.legs.pop(); })],
      ['the manifest hash', tampered(prepared, tx => { tx.batch.manifestHash = '0x' + '0'.repeat(64); })],
      ['the total', tampered(prepared, tx => { tx.batch.total = '6000001'; })],
      ['the compute limit', tampered(prepared, tx => { tx.batch.computeUnitLimit += 1; })],
      ['the source account', tampered(prepared, tx => { tx.batch.token.sourceAccount = createMockedSolanaWallet().owner; })],
      ['the message hash', tampered(prepared, tx => { tx.messageHash = '0x' + '1'.repeat(64); })],
      ['the asset', tampered(prepared, tx => { tx.batch.asset.mint = null; })]];
    for (const [label, p] of cases)
      expect(authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: [signed] }, s.owner.owner, NOW), label).toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED' });
    // Untampered: accepted.
    expect(authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [signed] }, s.owner.owner, NOW)).toMatchObject({ ok: true });
  });

  it('before it is sent, the stored artifact and the recorded signed bytes are verified again (pure); a second, different answer is told apart', async () => {
    const s = setup();
    const { prepared } = await s.prepared(s.batch('SOL'));
    const tx = txOf(prepared), answer = { kind: 'SOLANA_SIGN_ALL' as const, transactions: [s.owner.sign(tx.unsignedTransaction)] };
    const authorized = authorizeGroup(prepared, answer, s.owner.owner, NOW);
    if (!authorized.ok) throw new Error(authorized.code);
    expect(solanaBatchAuthorizationRefusal(prepared, authorized.value)).toBeNull();
    expect(solanaBatchAuthorizationRefusal(tampered(prepared, t => { t.legs[0]!.amount = '10000001'; }), authorized.value)).toBe('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    const recorded = authorized.value.transactions as { signature: string; transaction: string }[];
    const guarded = s.owner.sign(applyMockedPhantomLighthouseGuards(tx.unsignedTransaction, { lamportsAtLeast: 1n }));
    expect(solanaBatchAuthorizationRefusal(prepared, { ...authorized.value, transactions: [{ ...recorded[0]!, transaction: guarded }] })).toBe('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    expect(solanaBatchAuthorizationRefusal(prepared, { ...authorized.value, transactions: [] })).toBe('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    // A non-batch group is not this check's (unchanged path).
    expect(solanaBatchAuthorizationRefusal({ kind: 'SOLANA_SIGN_ALL', transactions: [{ kind: 'TRANSFER' }] }, authorized.value)).toBeNull();
    // The same answer again is the recorded one; a second prompt's guarded bytes sign another message.
    expect(sameSolanaBatchAnswer(prepared, authorized.value, answer, s.owner.owner)).toEqual({ ok: true, value: true });
    expect(sameSolanaBatchAnswer(prepared, authorized.value, { kind: 'SOLANA_SIGN_ALL', transactions: [guarded] }, s.owner.owner)).toEqual({ ok: true, value: false });
    expect(sameSolanaBatchAnswer(prepared, authorized.value, { kind: 'SOLANA_SIGN_ALL', transactions: [createMockedSolanaWallet().sign(tx.unsignedTransaction)] }, s.owner.owner))
      .toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_SIGNATURE_INVALID' });
  });
});

describe('KAN-20 submission and reconciliation: one transaction, sent once, every leg or none', () => {
  async function authorized(s: ReturnType<typeof setup>, asset: 'SOL' | 'USDC') {
    const { prepared } = await s.prepared(s.batch(asset));
    const a = authorizeGroup(prepared, { kind: 'SOLANA_SIGN_ALL', transactions: [s.owner.sign(txOf(prepared).unsignedTransaction)] }, s.owner.owner, NOW);
    if (!a.ok) throw new Error(a.code);
    return { prepared, authorization: a.value, submission: solanaSubmission(a.value, NOW) };
  }

  it('reconciles per leg: each recipient exactly its amount; a created token account\'s deposit is the owner\'s SOL beside its payment', async () => {
    for (const asset of ['SOL', 'USDC'] as const) {
      const s = setup();
      if (asset === 'USDC') s.chain.fundToken(s.recipients[0]!, USDC, 5n);
      const { prepared, authorization, submission } = await authorized(s, asset);
      expect(submission).toEqual({ kind: 'SOLANA_SIGN_ALL', hashes: [(authorization.transactions as { signature: string }[])[0]!.signature], submittedAt: NOW.toISOString() });
      expect(await reconcileSolanaGroup(s.deps, prepared, submission, SOLANA, s.owner.owner)).toEqual({ status: 'PENDING' });
      expect(await advanceSolanaSubmission(s.deps, prepared, authorization, s.owner.owner)).toMatchObject({ state: 'SENT', index: 0 });
      expect(await advanceSolanaSubmission(s.deps, prepared, authorization, s.owner.owner)).toMatchObject({ state: 'DONE' });
      const r = await reconcileSolanaGroup(s.deps, prepared, submission, SOLANA, s.owner.owner);
      const asKey = `${SOLANA}/token:${asset === 'SOL' ? WSOL : USDC}`, deposit = { asset: `${SOLANA}/token:${WSOL}`, amount: MOCKED_RENT.token.toString() };
      expect(r, asset).toMatchObject({ status: 'RECONCILED', transactions: [(submission.hashes as string[])[0]], gasPaid: { payer: s.owner.owner, unit: 'lamports', source: 'SOLANA_META',
        amount: txOf(prepared).estimatedFeeLamports } });
      expect((r as unknown as { steps: unknown[] }).steps).toEqual(asset === 'SOL'
        ? [0, 1, 2].map(i => ({ stepIndex: i, received: [], spent: [{ asset: asKey, amount: String((i + 1) * 10_000_000) }] }))
        : [{ stepIndex: 0, received: [], spent: [{ asset: asKey, amount: '1000000' }] }, { stepIndex: 1, received: [], spent: [{ asset: asKey, amount: '2000000' }, deposit] },
          { stepIndex: 2, received: [], spent: [{ asset: asKey, amount: '3000000' }, deposit] }]);
      expect(s.chain.state.sent).toHaveLength(1);
    }
  });

  it('a batch that failed on chain (an ATA reassigned after Review) settles no leg: FAILED, the fee only, never resent', async () => {
    const s = setup();
    const { prepared, authorization, submission } = await authorized(s, 'USDC');
    s.chain.fundToken(s.recipients[1]!, USDC, 0n, { tokenOwner: createMockedSolanaWallet().owner });
    expect(await advanceSolanaSubmission(s.deps, prepared, authorization, s.owner.owner)).toMatchObject({ state: 'SENT' });
    expect(await advanceSolanaSubmission(s.deps, prepared, authorization, s.owner.owner)).toMatchObject({ state: 'FAILED', code: 'SOLANA_TRANSACTION_FAILED' });
    expect(await reconcileSolanaGroup(s.deps, prepared, submission, SOLANA, s.owner.owner)).toMatchObject({ status: 'FAILED', code: 'SOLANA_TRANSACTION_FAILED', steps: [],
      gasPaid: { payer: s.owner.owner, unit: 'lamports' } });
    expect(s.chain.tokenAccount(s.chain.ata(s.recipients[0]!, USDC))).toBeNull();
    expect(s.chain.state.sent).toHaveLength(1);
  });

  it('a landed transaction whose balances do not match is UNMATCHED (funds may have moved), never FAILED; malformed RPC data is not a chain fact', async () => {
    const s = setup();
    const { prepared, authorization, submission } = await authorized(s, 'SOL');
    await advanceSolanaSubmission(s.deps, prepared, authorization, s.owner.owner);
    const tampering = (change: (tx: { meta: { postBalances: number[] } }) => unknown): UserFundedDeps => ({ ...s.deps, solana: async (method, params) => {
      const value = await s.chain.rpc(method, params);
      if (method !== 'getTransaction' || !value) return value;
      const copy = JSON.parse(JSON.stringify(value)) as { meta: { postBalances: number[] } };
      return change(copy) ?? copy;
    } });
    const keys = parseMessageV0(fromBase64(txOf(prepared).message)).staticKeys;
    const short = tampering(tx => {
      const at = keys.indexOf(s.recipients[1]!), post = tx.meta.postBalances;
      post[at] = post[at]! - 1; post[0] = post[0]! + 1;
    });
    expect(await reconcileSolanaGroup(short, prepared, submission, SOLANA, s.owner.owner)).toEqual({ status: 'UNMATCHED', code: 'SOLANA_BATCH_PAYMENT_RECIPIENT_DELTA_MISMATCH',
      gasPaid: null, transactions: submission.hashes });
    await expect(reconcileSolanaGroup(tampering(() => ({ meta: null, transaction: 'x' })), prepared, submission, SOLANA, s.owner.owner)).rejects.toThrow('SOLANA_RPC_INVALID');
    expect((await reconcileSolanaGroup(s.deps, prepared, submission, SOLANA, s.owner.owner)).status).toBe('RECONCILED');
  });

  it('T13: an unknown send outcome is resent only with the same bytes (one landed signature); a dropped one expires provably, nothing paid', async () => {
    const lost = setup({ send: 'RPC_ERROR_AFTER_LANDING' });
    const a = await authorized(lost, 'SOL');
    await expect(advanceSolanaSubmission(lost.deps, a.prepared, a.authorization, lost.owner.owner)).rejects.toThrow('Request timed out');
    expect(await advanceSolanaSubmission(lost.deps, a.prepared, a.authorization, lost.owner.owner)).toMatchObject({ state: 'DONE' });
    expect(lost.chain.state.sent).toEqual([(a.authorization.transactions as { transaction: string }[])[0]!.transaction]);
    expect(lost.chain.state.transactions.size).toBe(1);
    const dropped = setup({ send: 'DROPPED' });
    const d = await authorized(dropped, 'SOL');
    expect(await advanceSolanaSubmission(dropped.deps, d.prepared, d.authorization, dropped.owner.owner)).toMatchObject({ state: 'SENT' });
    expect(await advanceSolanaSubmission(dropped.deps, d.prepared, d.authorization, dropped.owner.owner)).toMatchObject({ state: 'SENT' });
    expect(new Set(dropped.chain.state.sent)).toEqual(new Set([(d.authorization.transactions as { transaction: string }[])[0]!.transaction]));
    dropped.chain.advance(151);
    expect(await advanceSolanaSubmission(dropped.deps, d.prepared, d.authorization, dropped.owner.owner)).toEqual({ state: 'EXPIRED', index: 0, code: 'SOLANA_BLOCKHASH_EXPIRED' });
    expect(dropped.chain.state.sent).toHaveLength(2);
    expect(dropped.recipients.map(r => dropped.chain.lamports(r))).toEqual([0n, 0n, 0n]);
  });
});

describe('KAN-20 C.4: an expired, unsigned preparation is prepared again only once the chain proves it did not land (H1 + H3)', () => {
  it('LIVE while its blockhash may still land; ABSENT once provably expired with no copy; LANDED when an owner-signed copy landed out of band', async () => {
    const s = setup();
    const { prepared } = await s.prepared(s.batch('SOL'));
    expect(await settleExpiredSolanaBatch(s.deps, prepared)).toEqual({ outcome: 'LIVE' });
    s.chain.advance(150);
    expect(await settleExpiredSolanaBatch(s.deps, prepared)).toEqual({ outcome: 'LIVE' });
    s.chain.advance(1);
    expect(await settleExpiredSolanaBatch(s.deps, prepared)).toEqual({ outcome: 'ABSENT' });
    // The owner's wallet signed P1 and broadcast it outside FloFi before its blockhash expired: preparing again would pay every recipient twice. The
    // landed copy's signature is returned (the blocked group keeps it as evidence of the funds that moved).
    const t = setup();
    const p1 = (await t.prepared(t.batch('SOL'))).prepared;
    const landed = await t.chain.rpc('sendTransaction', [t.owner.sign(txOf(p1).unsignedTransaction), { encoding: 'base64' }]) as string;
    t.chain.advance(151);
    expect(await settleExpiredSolanaBatch(t.deps, p1)).toEqual({ outcome: 'LANDED', signature: landed });
    expect(landed).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    // A copy that landed and failed (atomic: no recipient paid) is absent for this purpose.
    const f = setup();
    const p2 = (await f.prepared(f.batch('USDC'))).prepared;
    f.chain.fundToken(f.recipients[0]!, USDC, 0n, { tokenOwner: createMockedSolanaWallet().owner });
    await f.chain.rpc('sendTransaction', [f.owner.sign(txOf(p2).unsignedTransaction), { encoding: 'base64' }]);
    f.chain.advance(151);
    expect(await settleExpiredSolanaBatch(f.deps, p2)).toEqual({ outcome: 'ABSENT' });
  });

  it('UNKNOWN without an RPC or a readable height or history; UNPROVABLE without the Review slot or with more history than a scan reads', async () => {
    const s = setup();
    const { prepared } = await s.prepared(s.batch('SOL'));
    s.chain.advance(151);
    const failing = (method: string): UserFundedDeps['solana'] => async (m, params) => { if (m === method) throw new Error('SOLANA_RPC_UNAVAILABLE'); return s.chain.rpc(m, params); };
    expect(await settleExpiredSolanaBatch({ solana: null }, prepared)).toEqual({ outcome: 'UNKNOWN' });
    expect(await settleExpiredSolanaBatch({ solana: failing('getBlockHeight') }, prepared)).toEqual({ outcome: 'UNKNOWN' });
    expect(await settleExpiredSolanaBatch({ solana: failing('getSignaturesForAddress') }, prepared)).toEqual({ outcome: 'UNKNOWN' });
    expect(await settleExpiredSolanaBatch(s.deps, tampered(prepared, tx => { delete tx.sinceSlot; }))).toEqual({ outcome: 'UNPROVABLE' });
    // Every history page full, every entry inside the window: the scan never reaches the Review's slot (the blockhash provably expired).
    let pages = 0;
    const busy: UserFundedDeps['solana'] = async (m, params) => {
      if (m !== 'getSignaturesForAddress') return s.chain.rpc(m, params);
      pages++;
      return Array.from({ length: 1000 }, (_, i) => ({ signature: '5' + String(pages * 1000 + i).padStart(87, '1').replace(/0/g, 'z'), slot: txOf(prepared).sinceSlot! + 100 }));
    };
    expect(await settleExpiredSolanaBatch({ solana: busy }, prepared)).toEqual({ outcome: 'UNPROVABLE' });
    // Never asked of another kind of group.
    expect(await settleExpiredSolanaBatch(s.deps, { kind: 'SOLANA_SIGN_ALL', transactions: [{ kind: 'TRANSFER', lastValidBlockHeight: 1 }] })).toEqual({ outcome: 'UNPROVABLE' });
  });

  it('a group stopped by an earlier request keeps its settlement (and the landed copy\'s signature) in its outcome; nothing else reads as one', () => {
    const signature = '5' + '1'.repeat(87);
    expect(earlierSolanaBatchRequestOutcome({ outcome: 'LANDED', signature })).toEqual({ earlierRequest: { settlement: 'LANDED', signature } });
    expect(earlierSolanaBatchRequestOutcome({ outcome: 'UNPROVABLE' })).toEqual({ earlierRequest: { settlement: 'UNPROVABLE' } });
    expect([earlierSolanaBatchRequestOutcome({ outcome: 'LANDED', signature }), earlierSolanaBatchRequestOutcome({ outcome: 'UNPROVABLE' })].map(hasEarlierSolanaBatchRequest))
      .toEqual([true, true]);
    // A reconciled outcome, no outcome, or anything malformed never reads as an earlier request that may have paid.
    expect([null, { gasPaid: { amount: '5000' } }, { earlierRequest: null }, { earlierRequest: { settlement: 'ABSENT' } }, { earlierRequest: 'LANDED' }]
      .map(o => hasEarlierSolanaBatchRequest(o as Record<string, unknown> | null))).toEqual([false, false, false, false, false]);
  });

  it('T11: a refreshed preparation re-derives the same manifest (hash, legs, order, asset, owner); only the blockhash and chain facts change', async () => {
    const s = setup();
    const p1 = (await s.prepared(s.batch('USDC'))).prepared;
    s.chain.advance(151);
    expect(await settleExpiredSolanaBatch(s.deps, p1)).toEqual({ outcome: 'ABSENT' });
    // Between the two preparations a recipient's token account appears, and the owner's USDC moves to another account of the owner.
    s.chain.fundToken(s.recipients[2]!, USDC, 0n);
    s.chain.fundToken(s.owner.owner, USDC, 0n);
    const other = s.chain.fundToken(s.owner.owner, USDC, 9_000_000n, { at: createMockedSolanaWallet().owner });
    const p2 = (await s.prepared(s.batch('USDC'))).prepared;
    const [a, b] = [txOf(p1), txOf(p2)];
    expect(b.batch!.manifestHash).toBe(a.batch!.manifestHash);
    expect(b.legs!.map(l => [l.stepIndex, l.recipient, l.amount, l.spend])).toEqual(a.legs!.map(l => [l.stepIndex, l.recipient, l.amount, l.spend]));
    expect([b.owner, b.batch!.asset, b.batch!.total]).toEqual([a.owner, a.batch!.asset, a.batch!.total]);
    expect(decodedOf(p2).payments.map(p => [p.recipient, p.amount])).toEqual(decodedOf(p1).payments.map(p => [p.recipient, p.amount]));
    expect(b.messageHash).not.toBe(a.messageHash);
    expect(b.lastValidBlockHeight).toBeGreaterThan(a.lastValidBlockHeight);
    expect(parseMessageV0(fromBase64(b.message)).blockhash).not.toBe(parseMessageV0(fromBase64(a.message)).blockhash);
    // P2's Review shows P2's own facts: the account that pays now, and the deposits it charges now (the worst case is unchanged).
    expect([a.batch!.token!.sourceAccount, b.batch!.token!.sourceAccount]).toEqual([s.source, other]);
    expect([a.legs![2]!.createDestination, b.legs![2]!.createDestination]).toEqual([true, false]);
    expect(BigInt(a.batch!.accountCreationLamports) - BigInt(b.batch!.accountCreationLamports)).toBe(MOCKED_RENT.token);
    expect(b.batch!.maximumAccountCreationLamports).toBe(a.batch!.maximumAccountCreationLamports);
    // T12: P1's signed bytes are never an answer for P2.
    expect(authorizeGroup(p2, { kind: 'SOLANA_SIGN_ALL', transactions: [s.owner.sign(a.unsignedTransaction)] }, s.owner.owner, NOW))
      .toMatchObject({ ok: false, code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED' });
    expect(parseTransaction(fromBase64(s.owner.sign(b.unsignedTransaction), 2048)).signatures).toHaveLength(1);
    expect(s.chain.state.sent).toEqual([]);
  });
});
