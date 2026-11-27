// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): pure reconciliation of the atomic Solana Batch Payment against the MOCKED cluster's
 * finalized transaction metadata. Landed through the mock's `sendTransaction`; nothing reaches a public network and nothing here is public evidence.
 */
import { describe, expect, it } from 'vitest';
import { createSolanaBatchPaymentNode, createSolanaTransferNode, type SemanticWorkflow, type SolanaBatchPaymentFields } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_MAINNET_TOKENS, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { applyMockedPhantomLighthouseGuards, createMockedSolanaTransferChain, createMockedSolanaWallet, mockedPhantomGuardInstructions, MOCKED_RENT, parseMessageV0,
  serializeMessageV0, serializeTransaction, simulateSolanaBatchPayment, simulateSolanaTransfer, toBase64, fromBase64, verifySignedSolanaBatchPayment,
  type SolanaBatchPaymentReview } from '@defi-workflow-engine/reference-compiler';
import { reconcileSolanaBatchTransaction, solanaBatchExpected } from '../src/solana-batch-payment.js';

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
