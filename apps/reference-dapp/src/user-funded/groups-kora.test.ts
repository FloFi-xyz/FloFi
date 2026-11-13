// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ADR-0010 §4: a SOLANA_SIGN_ALL group whose network fees Pimlico's Kora fee payer fronts and the owner repays in USDC — prepare (group policy and
 * token sum), authorize (slot-1 signatures), submit (each transaction's id recorded as Kora answers), reconcile (GasPaidFact.paidInToken).
 * MOCKED transfer cluster and the loopback Kora JSON-RPC double only; nothing here is mainnet evidence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMockedSolanaTransferChain, createMockedSolanaWallet, fromBase64, parseMessageV0, parseTransaction, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/reference-compiler';
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { advanceSolanaSubmission, authorizeGroup, koraGroupProgress, koraGroupSubmission, prepareGroup, reconcileSolanaGroup, solanaSubmission, type Prepared,
  type UserFundedDeps } from './groups.ts';
import { koraGasFromEnv } from '../gas-abstraction/kora/runtime.ts';
import { startKoraDouble, type KoraDouble } from '../test-utils/kora-double.ts';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', T = SOLANA_MAINNET_TOKENS;
const doubles: KoraDouble[] = [];
afterEach(async () => { while (doubles.length) await doubles.pop()!.close(); });
function compose(input: unknown) {
  const c = composeWorkflow(input);
  if (!c.ok) throw new Error(c.code);
  const r = requirementOf(c);
  if (!r.ok) throw new Error(r.code);
  return { composition: c, requirement: r.value };
}
async function setup(owner: { lamports?: bigint; usdc: bigint }) {
  const chain = createMockedSolanaTransferChain(), wallet = createMockedSolanaWallet();
  chain.createMint(T.USDC.mint, { decimals: 6 }); chain.createMint(T.USDT.mint, { decimals: 6 });
  const double = await startKoraDouble({ rpc: chain.rpc, tokens: [{ mint: T.USDC.mint, decimals: 6 }, { mint: T.USDT.mint, decimals: 6 }] });
  doubles.push(double);
  chain.fundWallet(double.signer, 5_000_000_000n); chain.fundToken(double.payment, T.USDC.mint, 0n); chain.fundToken(double.payment, T.USDT.mint, 0n);
  if (owner.lamports !== undefined) chain.fundWallet(wallet.owner, owner.lamports);
  chain.fundToken(wallet.owner, T.USDC.mint, owner.usdc);
  const kora = koraGasFromEnv({ FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: double.url, FLOFI_KORA_SIGNER: double.signer, FLOFI_KORA_PAYMENT_ADDRESS: double.payment });
  const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, solana: chain.rpc, now: () => new Date('2026-11-13T12:00:00Z'), kora };
  const a = createMockedSolanaWallet().owner, b = createMockedSolanaWallet().owner;
  const send = (recipient: string, amount: string) => ({ action: 'transfer', network: 'solana', asset: 'USDC', amount, recipient });
  const { composition, requirement } = compose({ version: 2, steps: [send(a, '5'), send(b, '7')] });
  const g = { runId: 'wfr_' + 'k'.repeat(26), groupIndex: 0, strategy: 'SOLANA_SIGN_ALL' as const, chain: SOLANA, feePayer: wallet.owner, stepFrom: 0, stepTo: 1 };
  return { chain, wallet, double, deps, composition, requirement, g, recipients: [a, b] };
}
type Tx = { stepIndex: number; message: string; unsignedTransaction: string; lastValidBlockHeight: number; gas?: { amount: string; feePayer: string } };
type Setup = Awaited<ReturnType<typeof setup>>;
async function authorizedGroup(s: Setup) {
  const prepared = await prepareGroup(s.deps, s.composition, s.requirement, s.g);
  if (!prepared.ok) throw new Error(prepared.code);
  const p = prepared.value.prepared as Prepared & { transactions: Tx[] };
  const authorized = authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: p.transactions.map(t => s.wallet.sign(t.unsignedTransaction)) }, s.wallet.owner, s.deps.now());
  if (!authorized.ok) throw new Error(authorized.code);
  return { p, authorized: authorized.value };
}
const signCalls = (s: Setup) => s.double.state.calls.filter(c => c.method === 'signAndSendTransaction').length;
/** Passes of the group (as the run's worker makes them) until it is DONE, EXPIRED or FAILED. */
async function drive(s: Setup, p: Prepared, authorized: Readonly<Record<string, unknown>>, current: () => Readonly<Record<string, unknown>>,
  save: (next: Readonly<Record<string, unknown>>) => void) {
  const states: Awaited<ReturnType<typeof advanceSolanaSubmission>>[] = [];
  for (let pass = 0; pass < 16; pass++) {
    const step = await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, current(), async next => { save(next); return true; });
    states.push(step);
    if (['DONE', 'EXPIRED', 'FAILED'].includes(step.state)) break;
  }
  return states;
}

describe('Solana sign-all group with Pimlico Kora (MOCKED loopback)', () => {
  it('builds every transaction with Kora for an owner with no SOL, records each id as Kora answers, and reconciles the token fee', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const prepared = await prepareGroup(s.deps, s.composition, s.requirement, s.g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { transactions: Tx[]; fee: { unit: string; maxCost: string; token: { symbol: string } } };
    expect(p.transactions.every(t => t.gas?.feePayer === s.double.signer)).toBe(true);
    for (const t of p.transactions) expect(parseMessageV0(fromBase64(t.message)).staticKeys.slice(0, 2)).toEqual([s.double.signer, s.wallet.owner]);
    const total = p.transactions.reduce((sum, t) => sum + BigInt(t.gas!.amount), 0n);
    expect(p.fee).toMatchObject({ unit: 'token', maxCost: total.toString(), token: { symbol: 'USDC' } });
    const answers = p.transactions.map(t => s.wallet.sign(t.unsignedTransaction));
    for (const signed of answers) expect(parseTransaction(fromBase64(signed, 2048)).signatures[0]!.every(byte => byte === 0)).toBe(true);
    const authorized = authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: answers }, s.wallet.owner, s.deps.now());
    if (!authorized.ok) throw new Error(authorized.code);
    let submission = solanaSubmission(authorized.value, s.deps.now());
    expect(submission).toMatchObject({ hashes: [null, null], relayed: [null, null], relayAttempts: [0, 0] });
    const persist = async (next: Readonly<Record<string, unknown>>) => { submission = next; return true; };
    const states: string[] = [];
    for (let pass = 0; pass < 12; pass++) {
      const step = await advanceSolanaSubmission(s.deps, p, authorized.value, s.wallet.owner, undefined, submission, persist);
      states.push(step.state);
      if (step.state === 'DONE') break;
    }
    expect(states.at(-1)).toBe('DONE');
    expect(s.double.state.signed).toHaveLength(2);
    expect(s.double.state.unpaid).toBe(0);
    expect((submission.hashes as (string | null)[]).every(Boolean)).toBe(true);
    const reconciled = await reconcileSolanaGroup(s.deps, p, submission, SOLANA, s.wallet.owner);
    expect(reconciled).toMatchObject({ status: 'RECONCILED', gasPaid: { payer: s.double.signer, unit: 'lamports', source: 'SOLANA_META',
      paidInToken: { mechanism: 'PIMLICO_KORA_SPL_FEE', token: T.USDC.mint, symbol: 'USDC', decimals: 6, amount: total.toString(), payee: s.double.payment } } });
    // Each step's own facts exclude the fee leg: exactly the transferred amounts.
    if (reconciled.status !== 'RECONCILED') throw new Error('not reconciled');
    expect(reconciled.steps.map(step => step.spent)).toEqual([[{ asset: `${SOLANA}/token:${T.USDC.mint}`, amount: '5000000' }],
      [{ asset: `${SOLANA}/token:${T.USDC.mint}`, amount: '7000000' }]]);
    expect(s.chain.lamports(s.wallet.owner)).toBe(0n);
  });
  it('refuses a group whose quoted fees plus its own USDC spends exceed the owner\'s USDC, before anything is signed', async () => {
    const s = await setup({ usdc: 12_100_000n });
    await expect(prepareGroup(s.deps, s.composition, s.requirement, s.g)).resolves.toMatchObject({ ok: false, code: 'KORA_FEE_TOKEN_BALANCE_INSUFFICIENT' });
    expect(s.double.state.signed).toEqual([]);
  });
  it('keeps the native group, unchanged, for an owner whose SOL covers it', async () => {
    const s = await setup({ lamports: 2_000_000_000n, usdc: 50_000_000n });
    const prepared = await prepareGroup(s.deps, s.composition, s.requirement, s.g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { transactions: Tx[]; fee: { unit: string } };
    expect(p.fee.unit).toBe('lamports');
    expect(p.transactions.some(t => t.gas)).toBe(false);
    expect(s.double.state.calls).toEqual([]);
  });
  it('stops at a transaction Kora refuses before signing on its first call (nothing of it can exist) and never sends a later one', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    s.double.state.priceDriftBps = 500n; // Kora's own check at signing: "Insufficient token payment" (-32000), before it signs
    const step = await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, async next => { submission = next; return true; });
    expect(step).toEqual({ state: 'EXPIRED', index: 0, code: 'KORA_PAYMENT_INSUFFICIENT' });
    expect(submission).toMatchObject({ hashes: [null, null], relayAttempts: [1, 0] });
    expect(s.chain.state.sent).toEqual([]);
  });
  // K1: an answer that does not prove Kora skipped signing never ends the transaction; it is observed and recovered by the owner's signature.
  it('Kora -32603 (it may have signed) is not a refusal: the transaction is observed, never EXPIRED while its blockhash is valid', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    s.double.state.signMode = 'UNAVAILABLE';
    const persist = async (next: Readonly<Record<string, unknown>>) => { submission = next; return true; };
    expect(await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist))
      .toEqual({ state: 'WAITING', index: 0, code: 'KORA_PROVIDER_UNAVAILABLE' });
    for (let pass = 0; pass < 4; pass++) await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist);
    expect(signCalls(s)).toBeLessThanOrEqual(2);
    expect(submission).toMatchObject({ hashes: [null, null] });
    s.chain.advance(p.transactions[0]!.lastValidBlockHeight - s.chain.state.blockHeight + 1);
    expect(await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist))
      .toEqual({ state: 'EXPIRED', index: 0, code: 'SOLANA_BLOCKHASH_EXPIRED' });
    expect(s.chain.state.sent).toEqual([]);
  });
  it('a gateway 504 after Kora signed and broadcast: the transaction is recovered from the chain and the group completes (one Kora call each)', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    s.double.state.gatewayErrorsAfterSign = 1;
    const states = await drive(s, p, authorized, () => submission, next => { submission = next; });
    expect(states[0]).toMatchObject({ state: 'WAITING', index: 0, code: 'KORA_PROVIDER_UNAVAILABLE' });
    expect(states.at(-1)!.state).toBe('DONE');
    expect(signCalls(s)).toBe(2);
    expect((submission.hashes as (string | null)[]).every(Boolean)).toBe(true);
    await expect(reconcileSolanaGroup(s.deps, p, submission, SOLANA, s.wallet.owner)).resolves.toMatchObject({ status: 'RECONCILED' });
  });
  it('a lost answer whose identical retry Kora refuses (already processed) is never taken as "never signed"', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    s.double.state.loseAnswers = 1; s.double.state.refuseRepeat = true;
    const states = await drive(s, p, authorized, () => submission, next => { submission = next; });
    expect(states.map(x => x.state)).not.toContain('EXPIRED');
    expect(states.at(-1)!.state).toBe('DONE');
    await expect(reconcileSolanaGroup(s.deps, p, submission, SOLANA, s.wallet.owner)).resolves.toMatchObject({ status: 'RECONCILED' });
  });
  it('counts actual Kora calls durably: at most two per transaction, the second only once the first is provably absent', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    // Kora signs but never broadcasts and every answer is lost: only the chain can decide.
    s.double.state.broadcast = false; s.double.state.loseAnswers = 100;
    const persist = async (next: Readonly<Record<string, unknown>>) => { submission = next; return true; };
    // The owner's history cannot be read: an unknown outcome is never followed by another call.
    const blind: UserFundedDeps = { ...s.deps, solana: async (method, params) => { if (method === 'getSignaturesForAddress') throw new Error('SOLANA_RPC_UNAVAILABLE');
      return s.chain.rpc(method, params); } };
    expect(await advanceSolanaSubmission(blind, p, authorized, s.wallet.owner, undefined, submission, persist)).toMatchObject({ state: 'WAITING', index: 0 });
    expect(signCalls(s)).toBe(1);
    for (let pass = 0; pass < 3; pass++)
      expect(await advanceSolanaSubmission(blind, p, authorized, s.wallet.owner, undefined, submission, persist)).toEqual({ state: 'WAITING', index: 0, code: 'KORA_ANSWER_LOST_OBSERVING' });
    expect(signCalls(s)).toBe(1);
    // Readable and provably absent: one more call with the identical bytes, then never again.
    for (let pass = 0; pass < 4; pass++) await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist);
    expect(signCalls(s)).toBe(2);
    expect(submission).toMatchObject({ relayAttempts: [2, 0] });
    expect(new Set(s.double.state.signed)).toEqual(new Set([(authorized.transactions as { transaction: string }[])[0]!.transaction]));
    s.chain.advance(p.transactions[0]!.lastValidBlockHeight - s.chain.state.blockHeight + 1);
    expect(await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist)).toEqual({ state: 'EXPIRED', index: 0, code: 'SOLANA_BLOCKHASH_EXPIRED' });
  });
  it('a refusal of the second call (the first was signed, its answer lost) is not definitive: observed until the blockhash provably expires', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    s.double.state.broadcast = false; s.double.state.loseAnswers = 1; s.double.state.refuseRepeat = true;
    const persist = async (next: Readonly<Record<string, unknown>>) => { submission = next; return true; };
    expect(await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist)).toMatchObject({ state: 'WAITING', index: 0 });
    expect(await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist))
      .toEqual({ state: 'WAITING', index: 0, code: 'KORA_TRANSACTION_REFUSED' });
    expect(signCalls(s)).toBe(2);
    expect(await advanceSolanaSubmission(s.deps, p, authorized, s.wallet.owner, undefined, submission, persist))
      .toEqual({ state: 'WAITING', index: 0, code: 'KORA_ANSWER_LOST_OBSERVING' });
    expect(signCalls(s)).toBe(2);
  });
  // K3: a transient RPC failure in the middle of a group decides nothing (the pass waits); it never throws the group into UNCERTAIN.
  it('waits on a transient RPC failure (height, send or status) instead of failing the pass', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { p, authorized } = await authorizedGroup(s);
    let submission = solanaSubmission(authorized, s.deps.now());
    const failing = new Set<string>();
    const flaky: UserFundedDeps = { ...s.deps, solana: async (method, params) => { if (failing.has(method)) throw new Error('SOLANA_RPC_RATE_LIMITED'); return s.chain.rpc(method, params); } };
    const persist = async (next: Readonly<Record<string, unknown>>) => { submission = next; return true; };
    failing.add('getBlockHeight');
    await expect(advanceSolanaSubmission(flaky, p, authorized, s.wallet.owner, undefined, submission, persist)).resolves.toMatchObject({ state: 'WAITING',
      code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE' });
    failing.clear(); failing.add('sendTransaction');
    await expect(advanceSolanaSubmission(flaky, p, authorized, s.wallet.owner, undefined, submission, persist)).resolves.toMatchObject({ state: 'WAITING',
      code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE' });
    expect(submission).toMatchObject({ relayAttempts: [1, 0] });
    expect((submission.hashes as (string | null)[])[0]).toBeTruthy();
    failing.clear(); failing.add('getSignatureStatuses');
    await expect(advanceSolanaSubmission(flaky, p, authorized, s.wallet.owner, undefined, submission, persist)).resolves.toMatchObject({ state: 'WAITING',
      code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE' });
    failing.clear();
    const states = await drive(s, p, authorized, () => submission, next => { submission = next; });
    expect(states.at(-1)!.state).toBe('DONE');
    expect(signCalls(s)).toBe(2);
  });
  it('records only a monotonic step of a Kora group\'s progress, and refuses a malformed one', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const { authorized } = await authorizedGroup(s);
    const submission = solanaSubmission(authorized, s.deps.now());
    const id = '5'.repeat(88), bytes = (authorized.transactions as { transaction: string }[])[0]!.transaction;
    const one = { ...submission, relayAttempts: [1, 0] }, answered = { ...one, hashes: [id, null], relayed: [bytes, null] };
    expect(koraGroupProgress(submission, one)).toEqual({ kora: { hashes: [null, null], relayed: [null, null], relayAttempts: [1, 0] } });
    expect(koraGroupProgress(one, answered)).toMatchObject({ kora: { hashes: [id, null] } });
    expect(koraGroupProgress(one, submission)).toBeNull();
    expect(koraGroupProgress(answered, { ...answered, hashes: ['6'.repeat(88), null] })).toBeNull();
    expect(koraGroupProgress(one, { ...one, relayAttempts: [3, 0] })).toBeNull();
    expect(koraGroupSubmission(submission, { kora: { hashes: [id, null], relayed: [bytes, null], relayAttempts: [1, 0] } }))
      .toMatchObject({ hashes: [id, null], ownerSignatures: submission.ownerSignatures });
    expect(() => koraGroupSubmission(submission, { kora: { hashes: [id], relayed: [bytes], relayAttempts: [1] } })).toThrow('SOLANA_GROUP_SUBMISSION_INVALID');
    expect(koraGroupSubmission(submission, null)).toBe(submission);
  });
  it('records the Kora call before making it: without a durable record nothing is sent to Kora', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const prepared = await prepareGroup(s.deps, s.composition, s.requirement, s.g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { transactions: Tx[] };
    const authorized = authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: p.transactions.map(t => s.wallet.sign(t.unsignedTransaction)) }, s.wallet.owner, s.deps.now());
    if (!authorized.ok) throw new Error(authorized.code);
    const submission = solanaSubmission(authorized.value, s.deps.now());
    await expect(advanceSolanaSubmission(s.deps, p, authorized.value, s.wallet.owner, undefined, submission, async () => false))
      .resolves.toMatchObject({ state: 'WAITING', code: 'KORA_RELAY_NOT_RECORDED' });
    expect(s.double.state.signed).toEqual([]);
  });
});
