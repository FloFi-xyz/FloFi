// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createExactInputSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_WHIRLPOOLS_DEVNET as profile, SOLANA_DEVNET_TOKENS as T } from '@defi-workflow-engine/action-registry';
import { compileMessageV0, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, serializeMessageV0, serializeTransaction, toBase64 } from '../src/solana.js';
import { simulateOrcaDevnetSwap, verifySignedOrcaDevnetTransaction } from '../src/orca-whirlpool.js';
import { createMockedSolanaDevnetOrca } from '../src/orca-mock.js';
import { appendMockedWalletGuards, createMockedSolanaWallet } from '../src/jupiter-mock.js';
import { describeSolanaWalletChange, LIGHTHOUSE_PROGRAM, walletAppendedInstructions } from '../src/solana-wallet-change.js';

// P0 (Phantom on Solana Devnet): a wallet that appends Lighthouse guard instructions before signing returns a different message.
// The exact-byte check refuses it; this diagnostic says what changed without keeping or forwarding the signed bytes.
const chain = profile.chain;
const asset = (symbol: keyof typeof T) => ({ chainId: chain, address: T[symbol].mint, decimals: T[symbol].decimals });
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'wallet-change', revision: 1, resourceEdges: [], nodes: [createExactInputSwapNode('node-002', { chain,
  input: asset('SOL'), output: asset('devUSDC'), amount: '100000000', slippageBps: 50, protocols: ['orca-whirlpools'], maximumAmount: T.SOL.maximumAmount })] };
async function reviewed() {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  return { wallet, review: await simulateOrcaDevnetSwap(workflow, wallet.owner, env.rpc) };
}

describe('wallet-changed Solana transactions (MOCKED Devnet loopback)', () => {
  it('reports guard instructions a wallet appended, while the exact-byte check still refuses the signed transaction', async () => {
    const { wallet, review } = await reviewed();
    const signed = wallet.sign(appendMockedWalletGuards(review.unsignedTransaction, 4));
    expect(() => verifySignedOrcaDevnetTransaction(review, signed)).toThrow('DEVNET_SWAP_TRANSACTION_CHANGED');
    const change = describeSolanaWalletChange(review.message, signed);
    expect(change).toMatchObject({ format: 'flofi.solana-wallet-change.v1', parseable: true, signatures: 1, sameMessage: false, feePayerChanged: false, blockhashChanged: false,
      signersChanged: false, unknownLookupTables: false, reviewedInstructionsPreserved: true, missing: [], addedPrograms: [LIGHTHOUSE_PROGRAM] });
    expect(change.added).toHaveLength(4);
    expect(change.added.every(ix => ix.programId === LIGHTHOUSE_PROGRAM && ix.index >= change.reviewedInstructions)).toBe(true);
    expect(change.addedAccounts).toEqual([{ address: LIGHTHOUSE_PROGRAM, writable: false, signer: false }]);
    expect(change.computeBudget.returned).toEqual(change.computeBudget.reviewed);
    expect(change.reviewedMessageHash).toBe(review.messageHash);
    expect(walletAppendedInstructions(change)).toBe(true);
    // Nothing that could be broadcast is kept: no signature, transaction or message bytes.
    const signature = toBase64(parseTransaction(fromBase64(signed, 2048)).signatures[0]!);
    for (const kept of [signature, signed, review.message]) expect(JSON.stringify(change)).not.toContain(kept);
  });
  it('separates a replaced transaction, priority-fee edits and unreadable bytes from appended guards', async () => {
    const { wallet, review } = await reviewed();
    expect(describeSolanaWalletChange(review.message, wallet.sign(review.unsignedTransaction))).toMatchObject({ sameMessage: true, added: [], missing: [], reviewedInstructionsPreserved: true });
    // A wallet that sets its own compute-unit price: an added ComputeBudget instruction, visible as a fee change.
    const parsed = parseMessageV0(fromBase64(review.message, 2048)), owner = parsed.staticKeys[0]!;
    const price = { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: Uint8Array.of(3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0) };
    const priced = serializeMessageV0(compileMessageV0(owner, [price, ...decompileMessageV0(parsed, {})], parsed.blockhash, {}));
    const fee = describeSolanaWalletChange(review.message, wallet.sign(toBase64(serializeTransaction(null, priced))));
    expect(fee).toMatchObject({ reviewedInstructionsPreserved: true, addedPrograms: ['ComputeBudget111111111111111111111111111111'] });
    expect(fee.computeBudget).toEqual({ reviewed: { unitLimit: review.computeUnitLimit, unitPrice: null }, returned: { unitLimit: review.computeUnitLimit, unitPrice: '1000000' } });
    // A different transaction (another amount): reviewed instructions are missing, so it is not "appended only".
    const env = createMockedSolanaDevnetOrca(); env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
    const other = await simulateOrcaDevnetSwap({ ...workflow, nodes: [createExactInputSwapNode('node-002', { chain, input: asset('SOL'), output: asset('devUSDC'), amount: '90000000',
      slippageBps: 50, protocols: ['orca-whirlpools'], maximumAmount: T.SOL.maximumAmount })] }, wallet.owner, env.rpc);
    const replaced = describeSolanaWalletChange(review.message, wallet.sign(other.unsignedTransaction));
    expect(replaced.reviewedInstructionsPreserved).toBe(false);
    expect(replaced.missing.length).toBeGreaterThan(0);
    expect(walletAppendedInstructions(replaced)).toBe(false);
    expect(describeSolanaWalletChange(review.message, 'not base64!')).toMatchObject({ parseable: false, signatures: null, returnedMessageHash: null });
    expect(describeSolanaWalletChange(review.message, toBase64(Uint8Array.of(1, 2, 3)))).toMatchObject({ parseable: false });
  });
});
