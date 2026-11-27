// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): pure reconciliation of the atomic Solana Batch Payment against the MOCKED cluster's
 * finalized transaction metadata. Landed through the mock's `sendTransaction`; nothing reaches a public network and nothing here is public evidence.
 */
import { describe, expect, it } from 'vitest';
import { createSolanaBatchPaymentNode, createSolanaTransferNode, type SemanticWorkflow, type SolanaBatchPaymentFields } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_MAINNET_TOKENS, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { applyMockedPhantomLighthouseGuards, base58Encode, createMockedSolanaTransferChain, createMockedSolanaWallet, mockedPhantomGuardInstructions, MOCKED_RENT, parseMessageV0,
  serializeMessageV0, serializeTransaction, simulateSolanaBatchPayment, simulateSolanaTransfer, toBase64, fromBase64, verifySignedSolanaBatchPayment,
  type SolanaBatchPaymentReview } from '@defi-workflow-engine/reference-compiler';
import { findLandedSolanaBatchPreparation, reconcileSolanaBatchTransaction, solanaBatchExpected } from '../src/solana-batch-payment.js';
import { KORA_RECOVERY_FETCHES, KORA_RECOVERY_PAGE, KORA_RECOVERY_PAGES } from '../src/kora.js';

const CHAIN = SOLANA_MAINNET_TRANSFER.chain, USDC = SOLANA_MAINNET_TOKENS.USDC, NOW = Date.parse('2026-11-27T12:00:00.000Z');
const SPL_USDC = { kind: 'SPL_TOKEN' as const, mint: USDC.mint, decimals: 6, program: 'spl-token' as const };
const workflow = (payments: { recipient: string; amount: string }[], asset: SolanaBatchPaymentFields['asset'] = { kind: 'NATIVE' }): SemanticWorkflow =>
  ({ schemaVersion: '1.0.0', workflowId: 'workflow-batch', revision: 1, resourceEdges: [], nodes: [createSolanaBatchPaymentNode('node-002', { chain: CHAIN, asset, payments })] });
type Meta = { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances: Record<string, unknown>[]; postTokenBalances: Record<string, unknown>[];
  loadedAddresses: { writable: string[]; readonly: string[] } };
type Landed = { transaction: [string, string]; version: number; meta: Meta };

async function landed(asset: SolanaBatchPaymentFields['asset'], options: { existing?: number; guard?: boolean; enforceComputeLimit?: boolean;
  beforeSend?: (chain: ReturnType<typeof createMockedSolanaTransferChain>, wallets: string[]) => void; sign?: (review: SolanaBatchPaymentReview, sign: (b: string) => string) => string } = {}) {
  const chain = createMockedSolanaTransferChain({ enforceComputeLimit: options.enforceComputeLimit }), owner = createMockedSolanaWallet();
  const wallets = Array.from({ length: 3 }, () => createMockedSolanaWallet().owner);
  chain.fundWallet(owner.owner, 10_000_000_000n); chain.createMint(USDC.mint, { decimals: 6 });
  const source = chain.fundToken(owner.owner, USDC.mint, 10_000_000_000n);
  wallets.slice(0, options.existing ?? 0).forEach(w => asset.kind === 'NATIVE' ? chain.fundWallet(w, 5_000_000n) : chain.fundToken(w, USDC.mint, 11n));
  const review = await simulateSolanaBatchPayment(workflow(wallets.map((recipient, i) => ({ recipient, amount: String((i + 1) * 1_000_000_000) })), asset), owner.owner, chain.rpc, NOW);
  const unsigned = options.guard ? applyMockedPhantomLighthouseGuards(review.unsignedTransaction, { lamportsAtLeast: 1n, ...review.token ? { tokenAccount: source, tokenAmountAtLeast: 0n } : {} })
    : review.unsignedTransaction;
  const signed = options.sign ? options.sign(review, b => owner.sign(b)) : verifySignedSolanaBatchPayment(review, owner.sign(unsigned)).transaction;
  options.beforeSend?.(chain, wallets);
  const signature = await chain.rpc('sendTransaction', [signed, { encoding: 'base64' }]) as string;
  const tx = await chain.rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as Landed;
  return { chain, owner, wallets, source, review, signature, tx, expected: solanaBatchExpected(review, 2) };
}
const clone = (tx: Landed): Landed => JSON.parse(JSON.stringify(tx)) as Landed;
const keysOf = (tx: Landed) => parseMessageV0(fromBase64(tx.transaction[0], 2048).slice(65)).staticKeys;

describe('KAN-20 Solana batch reconciliation', () => {
  it('reconciles a SOL batch per leg: each recipient exactly its amount, the owner the total plus the fee', async () => {
    const { review, signature, tx, expected } = await landed({ kind: 'NATIVE' }, { existing: 1 });
    const observed = reconcileSolanaBatchTransaction(expected, signature, tx);
    expect(observed).toEqual({ verdict: 'RECONCILED', code: null, fee: BigInt(review.estimatedFeeLamports), walletGuard: null, legs: [
      { stepIndex: 2, amount: '1000000000', received: '1000000000', accountCreationLamports: '0' },
      { stepIndex: 3, amount: '2000000000', received: '2000000000', accountCreationLamports: '0' },
      { stepIndex: 4, amount: '3000000000', received: '3000000000', accountCreationLamports: '0' }] });
  });

  it('reconciles a USDC batch with created ATAs: deposits only where created, each within its reviewed maximum', async () => {
    const { review, signature, tx, expected } = await landed(SPL_USDC, { existing: 1 });
    const observed = reconcileSolanaBatchTransaction(expected, signature, tx);
    expect(observed.verdict).toBe('RECONCILED');
    expect(observed.legs).toEqual([{ stepIndex: 2, amount: '1000000000', received: '1000000000', accountCreationLamports: '0' },
      { stepIndex: 3, amount: '2000000000', received: '2000000000', accountCreationLamports: String(MOCKED_RENT.token) },
      { stepIndex: 4, amount: '3000000000', received: '3000000000', accountCreationLamports: String(MOCKED_RENT.token) }]);
    expect(observed.fee).toBe(BigInt(review.estimatedFeeLamports));
  });

  it('reconciles the transaction Phantom signed with its verified Lighthouse guard, and records the guard', async () => {
    for (const asset of [{ kind: 'NATIVE' as const }, SPL_USDC]) {
      const { signature, tx, expected, review } = await landed(asset, { guard: true });
      const observed = reconcileSolanaBatchTransaction(expected, signature, tx);
      expect(observed.verdict, asset.kind).toBe('RECONCILED');
      expect(observed.walletGuard).toMatchObject({ reviewedMessageHash: review.messageHash, instructions: expect.any(Array) });
      expect(observed.walletGuard!.instructions).toHaveLength(review.token ? 2 : 1);
    }
  });

  it('a transaction that failed on chain (an ATA reassigned after Review) settles no leg: FAILED with the fee only', async () => {
    const other = createMockedSolanaWallet().owner;
    const { chain, owner, signature, tx, expected, wallets } = await landed(SPL_USDC, { beforeSend: (c, w) => { c.fundToken(w[1]!, USDC.mint, 0n, { tokenOwner: other }); } });
    expect(tx.meta.err).toEqual({ InstructionError: [4, 'InvalidOwner'] });
    expect(reconcileSolanaBatchTransaction(expected, signature, tx)).toEqual({ verdict: 'FAILED', code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_FAILED', fee: BigInt(tx.meta.fee),
      walletGuard: null, legs: [] });
    // Atomic: nothing moved but the fee (no recipient ATA received anything, none was created).
    expect(chain.tokenAccount(chain.ata(wallets[0]!, USDC.mint))).toBeNull();
    expect(chain.lamports(owner.owner)).toBe(10_000_000_000n - BigInt(tx.meta.fee));
  });

  it('a wallet guard that exhausts the reviewed compute limit fails the whole batch atomically', async () => {
    const { signature, tx, expected } = await landed({ kind: 'NATIVE' }, { enforceComputeLimit: true, existing: 3, sign: (review, sign) => {
      const parsed = parseMessageV0(fromBase64(review.message)), guard = mockedPhantomGuardInstructions(review.owner, { lamportsAtLeast: 1n })[0]!;
      const guarded = serializeMessageV0({ ...parsed, header: [1, 0, parsed.header[2] + 1], staticKeys: [...parsed.staticKeys, guard.programId],
        instructions: [...parsed.instructions, ...Array.from({ length: 8 }, () => ({ programIdIndex: parsed.staticKeys.length, accounts: [0], data: guard.data }))] });
      return verifySignedSolanaBatchPayment(review, sign(toBase64(serializeTransaction(null, guarded)))).transaction; } });
    expect(JSON.stringify(tx.meta.err)).toContain('ComputationalBudgetExceeded');
    expect(reconcileSolanaBatchTransaction(expected, signature, tx)).toMatchObject({ verdict: 'FAILED', legs: [] });
  });

  it('is DIVERGENT for tampered metadata: a recipient short by one, an extra owner token movement, a deposit above its maximum, lookups, fee, owner delta', async () => {
    const spl = await landed(SPL_USDC, { existing: 1 }), keys = keysOf(spl.tx);
    const destination = keys.indexOf(spl.expected.payments[2]!.destinationAccount!), mintIndex = keys.indexOf(USDC.mint);
    const cases: [string, Landed, string][] = [];
    const short = clone(spl.tx);
    const entry = short.meta.postTokenBalances.find(b => b.accountIndex === destination) as { uiTokenAmount: { amount: string } };
    entry.uiTokenAmount.amount = String(BigInt(entry.uiTokenAmount.amount) - 1n);
    cases.push(['recipient short by one', short, 'RECIPIENT_DELTA_MISMATCH']);
    const moved = clone(spl.tx);
    moved.meta.preTokenBalances.push({ accountIndex: mintIndex, mint: USDC.mint, owner: spl.owner.owner, programId: SOLANA_MAINNET_TRANSFER.programs.token, uiTokenAmount: { amount: '5', decimals: 6 } });
    moved.meta.postTokenBalances.push({ accountIndex: mintIndex, mint: USDC.mint, owner: spl.owner.owner, programId: SOLANA_MAINNET_TRANSFER.programs.token, uiTokenAmount: { amount: '4', decimals: 6 } });
    cases.push(['extra owner token movement', moved, 'UNRELATED_ASSET_MOVEMENT']);
    const deposit = clone(spl.tx);
    deposit.meta.postBalances[destination] = deposit.meta.postBalances[destination]! + 1;
    deposit.meta.postBalances[0] = deposit.meta.postBalances[0]! - 1;
    cases.push(['deposit above its maximum', deposit, 'ACCOUNT_DEPOSIT_MISMATCH']);
    const lookups = clone(spl.tx);
    lookups.meta.loadedAddresses.writable.push(createMockedSolanaWallet().owner);
    cases.push(['loaded addresses', lookups, 'LOOKUP_MISMATCH']);
    const fee = clone(spl.tx);
    fee.meta.fee += 1; fee.meta.postBalances[0] = fee.meta.postBalances[0]! - 1;
    cases.push(['fee above the estimate', fee, 'FEE_MISMATCH']);
    const recipientSol = clone(spl.tx), wallet = keys.indexOf(spl.wallets[0]!);
    recipientSol.meta.postBalances[wallet] = recipientSol.meta.postBalances[wallet]! + 1;
    cases.push(['recipient SOL moved', recipientSol, 'UNRELATED_ASSET_MOVEMENT']);
    const ownerSol = clone(spl.tx);
    ownerSol.meta.postBalances[0] = ownerSol.meta.postBalances[0]! - 1;
    cases.push(['owner SOL beyond fee and deposits', ownerSol, 'UNRELATED_ASSET_MOVEMENT']);
    const sol = await landed({ kind: 'NATIVE' }, { existing: 3 }), solKeys = keysOf(sol.tx);
    const owner = clone(sol.tx);
    owner.meta.postBalances[0] = owner.meta.postBalances[0]! - 1;
    owner.meta.postBalances[solKeys.indexOf(sol.wallets[0]!)] = owner.meta.postBalances[solKeys.indexOf(sol.wallets[0]!)]! + 1;
    const solShort = clone(sol.tx);
    solShort.meta.postBalances[solKeys.indexOf(sol.wallets[1]!)] = solShort.meta.postBalances[solKeys.indexOf(sol.wallets[1]!)]! - 1;
    for (const [label, tx, code] of cases)
      expect(reconcileSolanaBatchTransaction(spl.expected, spl.signature, tx), label).toMatchObject({ verdict: 'DIVERGENT', code: `SOLANA_BATCH_PAYMENT_${code}`, legs: [] });
    expect(reconcileSolanaBatchTransaction(sol.expected, sol.signature, owner)).toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_RECIPIENT_DELTA_MISMATCH' });
    expect(reconcileSolanaBatchTransaction(sol.expected, sol.signature, solShort)).toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_RECIPIENT_DELTA_MISMATCH' });
    const solOwner = clone(sol.tx);
    solOwner.meta.postBalances[0] = solOwner.meta.postBalances[0]! - 1;
    expect(reconcileSolanaBatchTransaction(sol.expected, sol.signature, solOwner)).toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_OWNER_DELTA_MISMATCH' });
    // Untampered, both reconcile.
    expect(reconcileSolanaBatchTransaction(spl.expected, spl.signature, spl.tx).verdict).toBe('RECONCILED');
    expect(reconcileSolanaBatchTransaction(sol.expected, sol.signature, sol.tx).verdict).toBe('RECONCILED');
  });

  it('is DIVERGENT for another transaction: a different signature, other bytes, another owner; malformed RPC data is not a chain fact', async () => {
    const sol = await landed({ kind: 'NATIVE' }, { existing: 3 });
    expect(reconcileSolanaBatchTransaction(sol.expected, sol.signature.slice(0, -1) + (sol.signature.endsWith('1') ? '2' : '1'), sol.tx))
      .toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_MISMATCH' });
    // A reviewed single transfer from the same owner on the same cluster is not this batch.
    const single = await simulateSolanaTransfer({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
      nodes: [createSolanaTransferNode('node-002', { chain: CHAIN, amount: '1000000000', recipient: sol.wallets[0]!, token: null })] }, sol.owner.owner, sol.chain.rpc, NOW);
    const otherSignature = await sol.chain.rpc('sendTransaction', [sol.owner.sign(single.unsignedTransaction), { encoding: 'base64' }]) as string;
    const other = await sol.chain.rpc('getTransaction', [otherSignature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as Landed;
    expect(reconcileSolanaBatchTransaction(sol.expected, otherSignature, other)).toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_MISMATCH' });
    expect(reconcileSolanaBatchTransaction({ ...sol.expected, owner: createMockedSolanaWallet().owner }, sol.signature, sol.tx))
      .toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_MISMATCH' });
    expect(reconcileSolanaBatchTransaction(sol.expected, sol.signature, { ...sol.tx, version: 'legacy' })).toMatchObject({ verdict: 'DIVERGENT', code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_MISMATCH' });
    for (const malformed of [null, 'x', { ...sol.tx, meta: null }, { ...sol.tx, transaction: [sol.tx.transaction[0], 'json'] }, { ...sol.tx, meta: { ...sol.tx.meta, fee: 2 ** 60 } },
      { ...sol.tx, meta: { ...sol.tx.meta, preBalances: [1] } }])
      expect(() => reconcileSolanaBatchTransaction(sol.expected, sol.signature, malformed)).toThrow('SOLANA_RPC_INVALID');
    expect(() => reconcileSolanaBatchTransaction({ ...sol.expected, chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }, sol.signature, sol.tx)).toThrow('SOLANA_BATCH_PAYMENT_NETWORK_UNSUPPORTED');
  });
});

/** An earlier preparation of a batch group: simulated and signed by the owner's wallet, never handed to FloFi (`send` lands it out of band). */
async function earlier(asset: SolanaBatchPaymentFields['asset'] = { kind: 'NATIVE' }, options: { guard?: boolean } = {}) {
  const chain = createMockedSolanaTransferChain(), owner = createMockedSolanaWallet();
  const wallets = Array.from({ length: 2 }, () => createMockedSolanaWallet().owner);
  chain.fundWallet(owner.owner, 10_000_000_000n); chain.createMint(USDC.mint, { decimals: 6 });
  const source = chain.fundToken(owner.owner, USDC.mint, 10_000_000_000n);
  wallets.forEach(w => chain.fundWallet(w, 5_000_000n));
  const review = await simulateSolanaBatchPayment(workflow(wallets.map((recipient, i) => ({ recipient, amount: String((i + 1) * 1_000_000) })), asset), owner.owner, chain.rpc, NOW);
  const unsigned = options.guard ? applyMockedPhantomLighthouseGuards(review.unsignedTransaction, { lamportsAtLeast: 1n, ...review.token ? { tokenAccount: source, tokenAmountAtLeast: 0n } : {} })
    : review.unsignedTransaction;
  const signed = owner.sign(unsigned);
  const query = { owner: owner.owner, message: review.message, sinceSlot: review.state.slot, lastValidBlockHeight: review.lastValidBlockHeight };
  return { chain, owner, wallets, review, signed, query, send: () => chain.rpc('sendTransaction', [signed, { encoding: 'base64' }]) as Promise<string> };
}

describe('KAN-20 C.4 (H3): did an earlier preparation of a batch group land? (read-only scan of the owner\'s history, MOCKED cluster)', () => {
  it('FOUND: the owner-signed reviewed message landed out of band (exact bytes, or with Phantom\'s verified Lighthouse guard); FloFi sent nothing', async () => {
    for (const guard of [false, true]) {
      const e = await earlier({ kind: 'NATIVE' }, { guard });
      const signature = await e.send();
      e.chain.advance(151);
      expect(await findLandedSolanaBatchPreparation(e.chain.rpc, e.query), `guard ${guard}`).toEqual({ state: 'FOUND', signature, failed: false });
      expect(e.chain.state.sent).toEqual([e.signed]);
    }
  });

  it('FOUND and failed: an atomic batch that landed with an error (an ATA reassigned after Review) paid no recipient', async () => {
    const e = await earlier(SPL_USDC);
    e.chain.fundToken(e.wallets[1]!, USDC.mint, 0n, { tokenOwner: createMockedSolanaWallet().owner });
    const signature = await e.send();
    e.chain.advance(151);
    expect(await findLandedSolanaBatchPreparation(e.chain.rpc, e.query)).toEqual({ state: 'FOUND', signature, failed: true });
  });

  it('a copy that succeeded is reported over an earlier copy of the same message that failed (two signed variants, one blockhash)', async () => {
    const e = await earlier({ kind: 'NATIVE' }, { guard: true });
    const signature = await e.send();
    e.chain.advance(151);
    // The exact-bytes variant the same wallet signed for the same message, listed as landed earlier with an error.
    const exact = e.owner.sign(e.review.unsignedTransaction), exactSignature = verifySignedSolanaBatchPayment(e.review, exact).signature;
    const landedSlot = e.chain.state.transactions.get(signature)!.slot;
    const history = (failedFirst: boolean, succeeded: boolean) => async (m: string, params: readonly unknown[]) => {
      if (m === 'getSignaturesForAddress') return [...succeeded ? [{ signature, slot: landedSlot }] : [], ...failedFirst ? [{ signature: exactSignature, slot: landedSlot - 1 }] : []];
      if (m === 'getTransaction' && params[0] === exactSignature) return { transaction: [exact, 'base64'], meta: { err: { InstructionError: [2, 'Custom'] } } };
      return e.chain.rpc(m, params);
    };
    expect(await findLandedSolanaBatchPreparation(history(true, true), e.query)).toEqual({ state: 'FOUND', signature, failed: false });
    expect(await findLandedSolanaBatchPreparation(history(true, false), e.query)).toEqual({ state: 'FOUND', signature: exactSignature, failed: true });
  });

  it('ABSENT: nothing in the window is that message (the owner\'s other activity, history older than the Review, another preparation)', async () => {
    const e = await earlier();
    // Nothing landed at all.
    e.chain.advance(151);
    expect(await findLandedSolanaBatchPreparation(e.chain.rpc, e.query)).toEqual({ state: 'ABSENT' });
    // The owner's own single transfer in the window is not the batch.
    const single = await simulateSolanaTransfer({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
      nodes: [createSolanaTransferNode('node-002', { chain: CHAIN, amount: '1000000', recipient: e.wallets[0]!, token: null })] }, e.owner.owner, e.chain.rpc, NOW);
    await e.chain.rpc('sendTransaction', [e.owner.sign(single.unsignedTransaction), { encoding: 'base64' }]);
    expect(await findLandedSolanaBatchPreparation(e.chain.rpc, e.query)).toEqual({ state: 'ABSENT' });
    // A copy that landed before the window (the query's Review slot is later) is outside what this preparation could be.
    const f = await earlier();
    await f.send();
    f.chain.advance(151);
    expect(await findLandedSolanaBatchPreparation(f.chain.rpc, { ...f.query, sinceSlot: f.chain.state.slot })).toEqual({ state: 'ABSENT' });
    // Another preparation's message (a re-preparation with a new blockhash) is never this one.
    const g = await earlier();
    await g.send();
    g.chain.advance(151);
    const other = await simulateSolanaBatchPayment(g.review.workflow, g.owner.owner, g.chain.rpc, NOW);
    expect(other.message).not.toBe(g.review.message);
    expect(await findLandedSolanaBatchPreparation(g.chain.rpc, { ...g.query, message: other.message })).toEqual({ state: 'ABSENT' });
  });

  it('UNKNOWN: the history cannot be read, an entry is malformed or out of order, a listed transaction cannot be returned', async () => {
    const e = await earlier();
    const signature = await e.send();
    e.chain.advance(151);
    const failing = (method: string, answer?: (params: readonly unknown[]) => unknown) => async (m: string, params: readonly unknown[]) => {
      if (m !== method) return e.chain.rpc(m, params);
      if (!answer) throw new Error('SOLANA_RPC_UNAVAILABLE');
      return answer(params);
    };
    expect(await findLandedSolanaBatchPreparation(failing('getSignaturesForAddress'), e.query)).toEqual({ state: 'UNKNOWN' });
    expect(await findLandedSolanaBatchPreparation(failing('getSignaturesForAddress', () => [{ signature: 'x', slot: 1 }]), e.query)).toEqual({ state: 'UNKNOWN' });
    expect(await findLandedSolanaBatchPreparation(failing('getSignaturesForAddress', () => ({ value: [] })), e.query)).toEqual({ state: 'UNKNOWN' });
    expect(await findLandedSolanaBatchPreparation(failing('getSignaturesForAddress', () => [{ signature, slot: e.query.sinceSlot + 1 }, { signature, slot: e.query.sinceSlot + 2 }]),
      e.query)).toEqual({ state: 'UNKNOWN' });
    expect(await findLandedSolanaBatchPreparation(failing('getTransaction'), e.query)).toEqual({ state: 'UNKNOWN' });
    expect(await findLandedSolanaBatchPreparation(failing('getTransaction', () => null), e.query)).toEqual({ state: 'UNKNOWN' });
    expect(await findLandedSolanaBatchPreparation(failing('getTransaction', () => ({ transaction: [e.signed, 'base64'] })), e.query)).toEqual({ state: 'UNKNOWN' });
    // FloFi's own frozen artifact without a usable window decides nothing either.
    expect(await findLandedSolanaBatchPreparation(e.chain.rpc, { ...e.query, sinceSlot: -1 })).toEqual({ state: 'UNKNOWN' });
    // Untouched, the same chain answers.
    expect(await findLandedSolanaBatchPreparation(e.chain.rpc, e.query)).toEqual({ state: 'FOUND', signature, failed: false });
  });

  it('INCOMPLETE: more history in the window than a scan reads, once the blockhash provably expired; UNKNOWN while it may still be valid', async () => {
    const e = await earlier();
    e.chain.advance(151);
    const fake = (i: number) => base58Encode(new Uint8Array(64).fill(1 + (i % 250)).map((b, j) => j < 4 ? (i >> (8 * j)) & 0xff : b));
    let pages = 0;
    const busy = async (m: string, params: readonly unknown[]) => {
      if (m !== 'getSignaturesForAddress') return e.chain.rpc(m, params);
      pages++;
      // Every page full, every entry inside the window: the scan never reaches the Review's slot.
      return Array.from({ length: KORA_RECOVERY_PAGE }, (_, i) => ({ signature: fake(pages * KORA_RECOVERY_PAGE + i), slot: e.query.sinceSlot + 10_000 - pages }));
    };
    expect(await findLandedSolanaBatchPreparation(busy, e.query)).toEqual({ state: 'INCOMPLETE' });
    expect(pages).toBe(KORA_RECOVERY_PAGES);
    pages = 0;
    expect(await findLandedSolanaBatchPreparation(busy, { ...e.query, lastValidBlockHeight: e.chain.state.blockHeight })).toEqual({ state: 'UNKNOWN' });
  });

  it('more entries than one chunk: absent once the next chunk starts past the blockhash\'s expiry, else the next chunk is read; the oldest entry is the one sought', async () => {
    const e = await earlier();
    const signature = await e.send();
    const landedSlot = e.chain.state.slot;
    e.chain.advance(151);
    const extra = KORA_RECOVERY_FETCHES + 10;
    const fakes = Array.from({ length: extra }, (_, i) => ({ signature: base58Encode(new Uint8Array(64).fill(7).map((b, j) => j === 0 ? i : b)), slot: landedSlot + 1 + i }));
    const other = e.owner.sign((await simulateSolanaTransfer({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
      nodes: [createSolanaTransferNode('node-002', { chain: CHAIN, amount: '1000000', recipient: e.wallets[0]!, token: null })] }, e.owner.owner, e.chain.rpc, NOW)).unsignedTransaction);
    const calls: string[] = [];
    const scripted = (height: number | Error, real = true) => async (m: string, params: readonly unknown[]) => {
      calls.push(m);
      if (m === 'getSignaturesForAddress') return [...fakes].reverse().concat(real ? [{ signature, slot: landedSlot }] : []);
      if (m === 'getBlock') { if (height instanceof Error) throw height; return { blockHeight: height }; }
      if (m === 'getTransaction' && fakes.some(f => f.signature === params[0])) return { transaction: [other, 'base64'], meta: { err: null } };
      return e.chain.rpc(m, params);
    };
    // The earlier request is the oldest entry: found in the first chunk, no block read.
    calls.length = 0;
    expect(await findLandedSolanaBatchPreparation(scripted(0), e.query)).toEqual({ state: 'FOUND', signature, failed: false });
    expect(calls).not.toContain('getBlock');
    // Not landed: the second chunk starts past the expiry (ABSENT without reading it), or inside it (read to its end: ABSENT); unreadable: UNKNOWN.
    calls.length = 0;
    expect(await findLandedSolanaBatchPreparation(scripted(e.query.lastValidBlockHeight + 1, false), e.query)).toEqual({ state: 'ABSENT' });
    expect(calls.filter(m => m === 'getTransaction')).toHaveLength(KORA_RECOVERY_FETCHES);
    calls.length = 0;
    expect(await findLandedSolanaBatchPreparation(scripted(e.query.lastValidBlockHeight, false), e.query)).toEqual({ state: 'ABSENT' });
    expect(calls.filter(m => m === 'getTransaction')).toHaveLength(extra);
    expect(await findLandedSolanaBatchPreparation(scripted(new Error('SOLANA_RPC_UNAVAILABLE'), false), e.query)).toEqual({ state: 'UNKNOWN' });
  });
});
