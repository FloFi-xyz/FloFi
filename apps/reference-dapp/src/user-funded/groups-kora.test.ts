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
import { advanceSolanaSubmission, authorizeGroup, prepareGroup, reconcileSolanaGroup, solanaSubmission, type Prepared, type UserFundedDeps } from './groups.ts';
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
type Tx = { stepIndex: number; message: string; unsignedTransaction: string; gas?: { amount: string; feePayer: string } };

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
  it('stops at a transaction Kora refuses (nothing of it can exist) and never sends a later one', async () => {
    const s = await setup({ usdc: 50_000_000n });
    const prepared = await prepareGroup(s.deps, s.composition, s.requirement, s.g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { transactions: Tx[] };
    const authorized = authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: p.transactions.map(t => s.wallet.sign(t.unsignedTransaction)) }, s.wallet.owner, s.deps.now());
    if (!authorized.ok) throw new Error(authorized.code);
    let submission = solanaSubmission(authorized.value, s.deps.now());
    s.double.state.signMode = 'UNAVAILABLE';
    const step = await advanceSolanaSubmission(s.deps, p, authorized.value, s.wallet.owner, undefined, submission, async next => { submission = next; return true; });
    expect(step).toEqual({ state: 'EXPIRED', index: 0, code: 'KORA_PROVIDER_UNAVAILABLE' });
    expect(submission).toMatchObject({ hashes: [null, null], relayAttempts: [1, 0] });
    expect(s.chain.state.sent).toEqual([]);
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
