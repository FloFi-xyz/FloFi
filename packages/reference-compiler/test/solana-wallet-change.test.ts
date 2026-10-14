// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createExactInputSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { ORCA_WHIRLPOOLS_DEVNET as profile, SOLANA_DEVNET_TOKENS as T } from '@defi-workflow-engine/action-registry';
import { compileMessageV0, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, serializeMessageV0, serializeTransaction, toBase64 } from '../src/solana.js';
import { simulateOrcaDevnetSwap, verifySignedOrcaDevnetTransaction } from '../src/orca-whirlpool.js';
import { createMockedSolanaDevnetOrca } from '../src/orca-mock.js';
import { appendMockedWalletGuards, applyMockedPhantomPriorityFee, createMockedSolanaWallet } from '../src/jupiter-mock.js';
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
  it('Phantom’s exact Compute Budget insertion: refused on an unpriced message, absent on FloFi’s priced message', async () => {
    const { wallet, review } = await reviewed();
    const reviewedIxs = decompileMessageV0(parseMessageV0(fromBase64(review.message, 2048)), {});
    // FloFi's reviewed message sets its own price right after the limit.
    expect(reviewedIxs.slice(0, 2).map(ix => [ix.programId, ix.data[0]])).toEqual([['ComputeBudget111111111111111111111111111111', 2], ['ComputeBudget111111111111111111111111111111', 3]]);
    // The wallet behaviour captured from Phantom leaves that message unchanged, so the exact reviewed bytes are signed and accepted.
    expect(applyMockedPhantomPriorityFee(review.unsignedTransaction)).toBe(review.unsignedTransaction);
    expect(verifySignedOrcaDevnetTransaction(review, wallet.sign(applyMockedPhantomPriorityFee(review.unsignedTransaction))).signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    // The same message without a price (as before the fix): Phantom inserts SetComputeUnitPrice(375,000) as instruction 0, exactly as captured.
    const parsed = parseMessageV0(fromBase64(review.message, 2048)), owner = parsed.staticKeys[0]!;
    const unpriced = serializeMessageV0(compileMessageV0(owner, reviewedIxs.filter(ix => !(ix.programId === 'ComputeBudget111111111111111111111111111111' && ix.data[0] === 3)), parsed.blockhash, {}));
    const captured = describeSolanaWalletChange(toBase64(unpriced), wallet.sign(applyMockedPhantomPriorityFee(toBase64(serializeTransaction(null, unpriced)))));
    expect(captured).toMatchObject({ parseable: true, signatures: 1, feePayerChanged: false, blockhashChanged: false, signersChanged: false, reviewedInstructionsPreserved: true,
      reviewedInstructions: 7, returnedInstructions: 8, added: [{ index: 0, programId: 'ComputeBudget111111111111111111111111111111', accounts: 0, dataBytes: 9 }], missing: [], addedAccounts: [],
      computeBudget: { reviewed: { unitLimit: review.computeUnitLimit, unitPrice: null }, returned: { unitLimit: review.computeUnitLimit, unitPrice: '375000' } } });
  });
  it('refuses every other wallet change to the priced message: price, limit, removal, a second price, a replaced transaction, unreadable bytes', async () => {
    const { wallet, review } = await reviewed();
    const parsed = parseMessageV0(fromBase64(review.message, 2048)), owner = parsed.staticKeys[0]!, ixs = decompileMessageV0(parsed, {});
    const resign = (instructions: typeof ixs) => wallet.sign(toBase64(serializeTransaction(null, serializeMessageV0(compileMessageV0(owner, instructions, parsed.blockhash, {})))));
    const budget = (op: number, value: bigint, bytes: number) => ({ programId: 'ComputeBudget111111111111111111111111111111', accounts: [],
      data: Uint8Array.from([op, ...Array.from({ length: bytes }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn))]) });
    const variants = {
      raisedPrice: [ixs[0]!, budget(3, 375_000n, 8), ...ixs.slice(2)],
      changedLimit: [budget(2, 1_400_000n, 4), ...ixs.slice(1)],
      removedPrice: [ixs[0]!, ...ixs.slice(2)],
      secondPrice: [budget(3, 375_000n, 8), ...ixs],
    };
    for (const [name, instructions] of Object.entries(variants)) {
      const signed = resign(instructions);
      expect(() => verifySignedOrcaDevnetTransaction(review, signed), name).toThrow('DEVNET_SWAP_TRANSACTION_CHANGED');
      const change = describeSolanaWalletChange(review.message, signed);
      expect(change.sameMessage, name).toBe(false);
      if (name !== 'secondPrice') expect(change.reviewedInstructionsPreserved, name).toBe(false);
    }
    expect(describeSolanaWalletChange(review.message, resign(variants.raisedPrice)).computeBudget.returned).toEqual({ unitLimit: review.computeUnitLimit, unitPrice: '375000' });
    // A different transaction (another amount): reviewed instructions are missing, so it is not "appended only".
    const env = createMockedSolanaDevnetOrca(); env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
    const other = await simulateOrcaDevnetSwap({ ...workflow, nodes: [createExactInputSwapNode('node-002', { chain, input: asset('SOL'), output: asset('devUSDC'), amount: '90000000',
      slippageBps: 50, protocols: ['orca-whirlpools'], maximumAmount: T.SOL.maximumAmount })] }, wallet.owner, env.rpc);
    const replaced = describeSolanaWalletChange(review.message, wallet.sign(other.unsignedTransaction));
    expect(replaced.reviewedInstructionsPreserved).toBe(false);
    expect(walletAppendedInstructions(replaced)).toBe(false);
    expect(describeSolanaWalletChange(review.message, 'not base64!')).toMatchObject({ parseable: false, signatures: null, returnedMessageHash: null });
    expect(describeSolanaWalletChange(review.message, toBase64(Uint8Array.of(1, 2, 3)))).toMatchObject({ parseable: false });
  });
});
