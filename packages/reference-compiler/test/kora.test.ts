// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createExactInputSwapNode, createSolanaTransferNode, type SemanticWorkflow, type SolanaTransferToken } from '@defi-workflow-engine/workflow-contracts';
import { JUPITER_SOLANA_MAINNET as profile, SOLANA_DEVNET_TRANSFER, SOLANA_MAINNET_TRANSFER, SOLANA_MAINNET_TOKENS as T, type SolanaTokenSymbol } from '@defi-workflow-engine/action-registry';
import { base58Encode, compileMessageV0, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, serializeMessageV0, serializeSignedTransaction, toBase64,
  u64Bytes } from '../src/solana.js';
import { assertJupiterReview, simulateJupiterSwap, simulateKoraJupiterSwap, verifySignedJupiterTransaction } from '../src/jupiter.js';
import { createMockedSolanaJupiter, createMockedSolanaWallet } from '../src/jupiter-mock.js';
import { createMockedSolanaTransferChain } from '../src/solana-transfer-mock.js';
import { assertSolanaTransferReview, simulateKoraSolanaTransfer, simulateSolanaTransfer, verifySignedSolanaTransfer } from '../src/solana-transfer.js';
import { assertKoraMessage, assertKoraQuote, isSolanaNativeFeeShortfall, koraAta, KORA_MAX_COMPUTE_UNIT_PRICE, KORA_TOKEN_PROGRAM, unsignedTransactionBytes, verifyKoraAnswer,
  verifyKoraOwnerSigned, type KoraPort, type KoraQuote } from '../src/kora.js';

/**
 * ADR-0010 §4 (BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003): Kora-paid Solana messages on the MOCKED deterministic clusters. The Kora port here is an
 * in-process fake with fixed quotes; the JSON-RPC double and the service lifecycle are exercised in the app's tests. Nothing reaches a network.
 */
const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const kora = createMockedSolanaWallet(), payee = createMockedSolanaWallet().owner;
const tokens = [{ symbol: 'USDC', mint: T.USDC.mint, decimals: 6 }, { symbol: 'USDT', mint: T.USDT.mint, decimals: 6 }];
function port(overrides: Partial<KoraQuote> = {}, quotes: { mint: string }[] = []): KoraPort {
  return { feePayer: kora.owner, paymentAddress: payee, tokens: async () => tokens,
    estimate: async (transaction, mint) => {
      quotes.push({ mint });
      // The quote must be taken on the final shape: Kora's empty slot, the owner's slot, the payment as the last instruction.
      const { signatures, message } = parseTransaction(fromBase64(transaction, 2048));
      expect(signatures).toHaveLength(2);
      expect(parseMessageV0(message).staticKeys[0]).toBe(kora.owner);
      return { feeInLamports: '2049280', feeInToken: '241000', signerPubkey: kora.owner, paymentAddress: payee, ...overrides };
    } };
}
function swapWorkflow(from: SolanaTokenSymbol, to: SolanaTokenSymbol, amount: string): SemanticWorkflow {
  const asset = (s: SolanaTokenSymbol) => ({ chainId: profile.chain, address: T[s].mint, decimals: T[s].decimals });
  return { schemaVersion: '1.0.0', workflowId: 'workflow-kora', revision: 1, resourceEdges: [],
    nodes: [createExactInputSwapNode('node-002', { chain: profile.chain, input: asset(from), output: asset(to), amount, slippageBps: 50, protocols: ['jupiter'], maximumAmount: T[from].maximumAmount })] };
}
function swapSetup(ownerLamports: bigint, balances: Partial<Record<'USDC' | 'USDT', bigint>>, payment: Partial<Record<'USDC' | 'USDT', bigint>> = { USDC: 0n, USDT: 0n }) {
  const env = createMockedSolanaJupiter(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, ownerLamports, balances); env.fund(kora.owner, 5_000_000_000n); env.fund(payee, 0n, payment);
  return { env, wallet };
}

describe('Kora gas policy primitives', () => {
  it('classifies only a native build refused for lack of SOL as a fee shortfall', () => {
    for (const code of ['JUPITER_INSUFFICIENT_SOL', 'JUPITER_SIMULATION_FAILED', 'SOLANA_TRANSFER_INSUFFICIENT_SOL', 'SOLANA_TRANSFER_OWNER_NOT_WALLET', 'SOLANA_TRANSFER_SIMULATION_FAILED'])
      expect(isSolanaNativeFeeShortfall(new Error(code))).toBe(true);
    for (const code of ['JUPITER_INSUFFICIENT_USDC', 'SOLANA_TRANSFER_INSUFFICIENT_TOKEN_BALANCE', 'JUPITER_QUOTE_STALE', 'KORA_NATIVE_COVERS']) expect(isSolanaNativeFeeShortfall(new Error(code))).toBe(false);
  });
  it('refuses a quote naming another signer or payment address, a zero fee (a sponsorship) and more than 0.1 SOL', () => {
    const good: KoraQuote = { feeInLamports: '12000', feeInToken: '1400', signerPubkey: kora.owner, paymentAddress: payee };
    expect(assertKoraQuote(good, { feePayer: kora.owner, paymentAddress: payee })).toEqual({ feeInLamports: 12_000n, feeInToken: 1_400n });
    expect(() => assertKoraQuote({ ...good, signerPubkey: payee }, { feePayer: kora.owner, paymentAddress: payee })).toThrow('KORA_SIGNER_MISMATCH');
    expect(() => assertKoraQuote({ ...good, paymentAddress: kora.owner }, { feePayer: kora.owner, paymentAddress: payee })).toThrow('KORA_SIGNER_MISMATCH');
    expect(() => assertKoraQuote({ ...good, feeInToken: '0' }, { feePayer: kora.owner, paymentAddress: payee })).toThrow('KORA_FEE_QUOTE_INVALID');
    expect(() => assertKoraQuote({ ...good, feeInLamports: '100000001' }, { feePayer: kora.owner, paymentAddress: payee })).toThrow('KORA_FEE_ABOVE_CAP');
    expect(() => assertKoraQuote({ ...good, feeInToken: '-1' }, { feePayer: kora.owner, paymentAddress: payee })).toThrow('KORA_FEE_QUOTE_INVALID');
  });
});

describe('Jupiter swap with the Kora fee payer (MOCKED)', () => {
  it('keeps the native message whenever the owner holds the SOL (Kora is refused: KORA_NATIVE_COVERS)', async () => {
    const { env, wallet } = swapSetup(3_000_000_000n, { USDC: 100_000_000n });
    const native = await simulateJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, env.http, env.rpc, NOW);
    expect(native.gas).toBeUndefined();
    expect(parseTransaction(fromBase64(native.unsignedTransaction, 2048)).signatures).toHaveLength(1);
    await expect(simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, env.http, env.rpc, port(), NOW)).rejects.toThrow('KORA_NATIVE_COVERS');
  });
  it('builds USDC→SOL for an owner with no SOL: Kora pays the fee and the temporary wrapped-SOL rent, the owner repays in USDC as the last instruction', async () => {
    const { env, wallet } = swapSetup(0n, { USDC: 100_000_000n }), quotes: { mint: string }[] = [];
    await expect(simulateJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, env.http, env.rpc, NOW)).rejects.toSatisfy(isSolanaNativeFeeShortfall);
    const review = await simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, env.http, env.rpc, port({}, quotes), NOW);
    expect(env.state.queries.at(-1)?.maxAccounts).toBe('40');
    expect(quotes).toEqual([{ mint: T.USDC.mint }]);
    expect(review.gas).toMatchObject({ mechanism: 'PIMLICO_KORA_SPL_FEE', feePayer: kora.owner, paymentAddress: payee, token: { symbol: 'USDC', decimals: 6 },
      amount: '241000', quotedFeeLamports: '2049280', feeAccount: koraAta(wallet.owner, T.USDC.mint), paymentAccount: koraAta(payee, T.USDC.mint) });
    const message = parseMessageV0(fromBase64(review.message));
    expect(message.staticKeys.slice(0, 2)).toEqual([kora.owner, wallet.owner]);
    expect(message.header[0]).toBe(2);
    const ixs = decompileMessageV0(message, review.lookupTables);
    // The wrapped-SOL account's rent is Kora's (charged in the fee); the payment is the last instruction.
    expect(ixs.filter(ix => ix.programId === profile.programs.associatedToken).map(ix => ix.accounts[0]!.pubkey)).toEqual([kora.owner]);
    expect(ixs.at(-1)).toMatchObject({ programId: profile.programs.token, accounts: [{ pubkey: koraAta(wallet.owner, T.USDC.mint) }, { pubkey: T.USDC.mint },
      { pubkey: koraAta(payee, T.USDC.mint) }, { pubkey: wallet.owner, isSigner: true }] });
    expect(Buffer.from(ixs.at(-1)!.data).toString('hex')).toBe('0c' + '68ad030000000000' + '06');
    expect(parseTransaction(fromBase64(review.unsignedTransaction, 2048)).signatures).toHaveLength(2);
    expect(review.estimatedFeeLamports).toBe(String(10_000 + Math.ceil(review.computeUnitLimit * 1000 / 1_000_000)));
    // The owner pays no SOL and receives exactly the swap output; the fee budget is the token amount, the SOL gas budget zero.
    expect(review.simulationResult).toMatchObject({ inputSpent: '10000000', accountCreationLamports: '0' });
    expect(review.manifest.gasBudgets[0]?.maximumAmount).toBe('0');
    expect(review.manifest.feeBudgets).toEqual([{ asset: { chainId: profile.chain, address: T.USDC.mint, decimals: 6 }, maximumAmount: '241000' }]);
    expect(() => assertJupiterReview(review, review.workflow, wallet.owner, env.state.blockHeight, NOW)).not.toThrow();
    expect(() => assertJupiterReview({ ...review, gas: { ...review.gas!, amount: '1' } }, review.workflow, wallet.owner, env.state.blockHeight, NOW)).toThrow('JUPITER_AUTHORIZATION_INVALID');
  });
  it('builds USDC→USDT and pays the fee in USDT when the swap spends all the USDC', async () => {
    const { env, wallet } = swapSetup(0n, { USDC: 10_000_000n, USDT: 5_000_000n }), quotes: { mint: string }[] = [];
    const review = await simulateKoraJupiterSwap(swapWorkflow('USDC', 'USDT', '10000000'), wallet.owner, env.http, env.rpc, port({}, quotes), NOW);
    expect(quotes).toEqual([{ mint: T.USDT.mint }]);
    expect(review.gas?.token.symbol).toBe('USDT');
    // The fee account is the output account: the reported output adds the fee back (the owner received it all, then paid the fee).
    expect(review.simulationResult.outputReceived).toBe(review.quote.outAmount);
  });
  it('pays in USDT for an owner holding only USDT, and refuses an owner without enough of either token', async () => {
    const onlyUsdt = swapSetup(0n, { USDT: 20_000_000n });
    await expect(simulateKoraJupiterSwap(swapWorkflow('USDT', 'SOL', '10000000'), onlyUsdt.wallet.owner, onlyUsdt.env.http, onlyUsdt.env.rpc, port(), NOW))
      .resolves.toMatchObject({ gas: { token: { symbol: 'USDT' }, amount: '241000' } });
    const short = swapSetup(0n, { USDC: 10_100_000n });
    await expect(simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), short.wallet.owner, short.env.http, short.env.rpc, port(), NOW)).rejects.toThrow('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT');
  });
  it('refuses when Kora\'s payment account does not exist, and refuses quotes against the pins', async () => {
    const missing = swapSetup(0n, { USDC: 100_000_000n }, {});
    await expect(simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), missing.wallet.owner, missing.env.http, missing.env.rpc, port(), NOW)).rejects.toThrow('KORA_PAYMENT_ACCOUNT_MISSING');
    const s = swapSetup(0n, { USDC: 100_000_000n });
    await expect(simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), s.wallet.owner, s.env.http, s.env.rpc, port({ signerPubkey: payee }), NOW)).rejects.toThrow('KORA_SIGNER_MISMATCH');
    await expect(simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), s.wallet.owner, s.env.http, s.env.rpc, port({ feeInToken: '0' }), NOW)).rejects.toThrow('KORA_FEE_QUOTE_INVALID');
  });
  it('caps the priority fee in Kora mode (a failed transaction\'s SOL fee is charged to the operator)', async () => {
    const { env, wallet } = swapSetup(0n, { USDC: 100_000_000n });
    const expensive = createMockedSolanaJupiter({ tamperBuild: b => { b.computeBudgetInstructions = [{ programId: profile.programs.computeBudget, accounts: [],
      data: toBase64(Uint8Array.from([3, 0x80, 0xf0, 0xfa, 0x02, 0, 0, 0, 0])) }]; } });
    const review = await simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, expensive.http, env.rpc, port(), NOW);
    expect(review.computeUnitPrice).toBe(KORA_MAX_COMPUTE_UNIT_PRICE.toString());
  });
  it('verifies the owner\'s slot-1 signature with Kora\'s slot left empty, and Kora\'s answer against the exact owner-signed bytes', async () => {
    const { env, wallet } = swapSetup(0n, { USDC: 100_000_000n });
    const review = await simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, env.http, env.rpc, port(), NOW);
    const signed = wallet.sign(review.unsignedTransaction);
    const verified = verifySignedJupiterTransaction(review, signed);
    const parsed = parseTransaction(fromBase64(signed, 2048));
    expect(parsed.signatures[0]!.every(b => b === 0)).toBe(true);
    expect(verified.transaction).toBe(signed);
    // The owner's identity is its own signature (slot 1); the transaction id does not exist yet.
    expect(verified.signature).not.toBe('1111111111111111111111111111111111111111111111111111111111111111');
    expect(() => verifySignedJupiterTransaction(review, kora.sign(signed))).toThrow('KORA_FEE_PAYER_SLOT_FILLED');
    const stranger = parseTransaction(fromBase64(createMockedSolanaWallet().sign(review.unsignedTransaction), 2048)).signatures[0]!;
    expect(() => verifySignedJupiterTransaction(review, toBase64(serializeSignedTransaction([null, stranger], parsed.message)))).toThrow('JUPITER_SIGNATURE_INVALID');
    expect(() => verifySignedJupiterTransaction(review, toBase64(serializeSignedTransaction([parsed.signatures[1]!], parsed.message)))).toThrow('JUPITER_TRANSACTION_CHANGED');
    // Kora's answer: the same message, the owner's signature intact, slot 0 signed by the pinned signer.
    const completed = kora.sign(signed), id = parseTransaction(fromBase64(completed, 2048)).signatures[0]!;
    const answer = verifyKoraAnswer(signed, { signature: base58Encode(id), signedTransaction: completed, signerPubkey: kora.owner }, kora.owner);
    expect(answer.transaction).toBe(completed);
    expect(() => verifyKoraAnswer(signed, { signature: answer.signature, signedTransaction: completed, signerPubkey: payee }, kora.owner)).toThrow('KORA_SIGNER_MISMATCH');
    const forged = createMockedSolanaWallet().sign(signed);
    expect(() => verifyKoraAnswer(signed, { signature: answer.signature, signedTransaction: forged, signerPubkey: kora.owner }, kora.owner)).toThrow(/KORA_(SIGNER_MISMATCH|ANSWER_INVALID)/);
    const other = await simulateKoraJupiterSwap(swapWorkflow('USDC', 'SOL', '10000000'), wallet.owner, env.http, env.rpc, port({ feeInToken: '241001' }), NOW);
    expect(() => verifyKoraAnswer(signed, { signature: answer.signature, signedTransaction: kora.sign(wallet.sign(other.unsignedTransaction)), signerPubkey: kora.owner }, kora.owner))
      .toThrow('KORA_ANSWER_INVALID');
  });
});

describe('K1: no transaction without the verified payment', () => {
  const owner = createMockedSolanaWallet().owner, recipient = createMockedSolanaWallet().owner, blockhash = kora.owner;
  const terms = { mechanism: 'PIMLICO_KORA_SPL_FEE' as const, feePayer: kora.owner, paymentAddress: payee, paymentAccount: koraAta(payee, T.USDC.mint),
    feeAccount: koraAta(owner, T.USDC.mint), token: { symbol: 'USDC', mint: T.USDC.mint, decimals: 6 }, amount: '5000', quotedFeeLamports: '10000', quotedAt: new Date(NOW).toISOString() };
  const payment = (amount: bigint, from = terms.feeAccount) => ({ programId: KORA_TOKEN_PROGRAM,
    data: Uint8Array.from([12, ...u64Bytes(amount), 6]), accounts: [{ pubkey: from, isSigner: false, isWritable: true },
      { pubkey: T.USDC.mint, isSigner: false, isWritable: false }, { pubkey: terms.paymentAccount, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }] });
  const system = (from: string) => ({ programId: '11111111111111111111111111111111', data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    accounts: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: recipient, isSigner: false, isWritable: true }] });
  const message = (ixs: ReturnType<typeof payment>[]) => parseMessageV0(serializeMessageV0(compileMessageV0(kora.owner, ixs, blockhash, {})));
  it('accepts exactly one reviewed payment as the last instruction and nothing else naming the fee payer', () => {
    expect(() => assertKoraMessage(message([system(owner), payment(5000n)]), {}, owner, terms)).not.toThrow();
    expect(() => assertKoraMessage(message([system(owner)]), {}, owner, terms)).toThrow('KORA_PAYMENT_MISSING');
    expect(() => assertKoraMessage(message([system(owner), payment(5000n)]), {}, recipient, terms)).toThrow('KORA_SIGNERS_INVALID');
    expect(() => assertKoraMessage(message([system(owner), payment(4999n)]), {}, owner, terms)).toThrow('KORA_PAYMENT_CHANGED');
    expect(() => assertKoraMessage(message([payment(5000n), system(owner)]), {}, owner, terms)).toThrow('KORA_PAYMENT_NOT_LAST');
    expect(() => assertKoraMessage(message([system(owner), payment(5000n), payment(5000n)]), {}, owner, terms)).toThrow('KORA_PAYMENT_MISSING');
    // Kora's key as a transfer source (not an ATA rent payer) is refused.
    expect(() => assertKoraMessage(message([system(kora.owner), system(owner), payment(5000n)]), {}, owner, terms)).toThrow('KORA_FEE_PAYER_REFERENCED');
    expect(() => assertKoraMessage(message([system(owner), payment(5000n)]), {}, owner, { ...terms, amount: '0' })).toThrow('KORA_FEE_QUOTE_INVALID');
    expect(() => assertKoraMessage(message([system(owner), payment(5000n)]), {}, owner, { ...terms, feePayer: payee })).toThrow('KORA_FEE_PAYER_MISMATCH');
    expect(unsignedTransactionBytes(serializeMessageV0(compileMessageV0(kora.owner, [system(owner), payment(5000n)], blockhash, {})))[0]).toBe(2);
  });
  it('refuses owner-signed bytes whose payment was removed or changed, even with a valid owner signature', () => {
    const wallet = createMockedSolanaWallet(), t = { ...terms, feeAccount: koraAta(wallet.owner, T.USDC.mint) };
    const pay = (amount: bigint) => ({ ...payment(amount, t.feeAccount), accounts: payment(amount, t.feeAccount).accounts.map((a, i) => i === 3 ? { ...a, pubkey: wallet.owner } : a) });
    const reviewed = serializeMessageV0(compileMessageV0(kora.owner, [system(wallet.owner), pay(5000n)], blockhash, {}));
    const review = { message: toBase64(reviewed), owner: wallet.owner, gas: t };
    expect(verifyKoraOwnerSigned(review, wallet.sign(toBase64(unsignedTransactionBytes(reviewed))), 'X').signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    const changed = serializeMessageV0(compileMessageV0(kora.owner, [system(wallet.owner), pay(1n)], blockhash, {}));
    expect(() => verifyKoraOwnerSigned(review, wallet.sign(toBase64(unsignedTransactionBytes(changed))), 'X')).toThrow('X_TRANSACTION_CHANGED');
  });
});

describe('Solana transfer with the Kora fee payer (MOCKED)', () => {
  const usdc: SolanaTransferToken = { mint: T.USDC.mint, decimals: 6, program: 'spl-token' };
  const workflow = (recipient: string, amount: string, token: SolanaTransferToken | null = usdc, chain = SOLANA_MAINNET_TRANSFER.chain): SemanticWorkflow =>
    ({ schemaVersion: '1.0.0', workflowId: 'workflow-transfer', revision: 1, resourceEdges: [], nodes: [createSolanaTransferNode('node-002', { chain, amount, recipient, token })] });
  function setup(recipientHasAccount: boolean) {
    const chain = createMockedSolanaTransferChain(), owner = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
    chain.createMint(T.USDC.mint, { decimals: 6 }); chain.createMint(T.USDT.mint, { decimals: 6 });
    chain.fundWallet(kora.owner, 5_000_000_000n); chain.fundToken(payee, T.USDC.mint, 0n); chain.fundToken(payee, T.USDT.mint, 0n);
    chain.fundToken(owner.owner, T.USDC.mint, 50_000_000n);
    if (recipientHasAccount) chain.fundToken(recipient, T.USDC.mint, 1n);
    return { chain, owner, recipient };
  }
  it('refuses OWNER_NOT_WALLET natively and builds the Kora transfer for an owner with no SOL account at all, with and without the recipient account', async () => {
    for (const exists of [true, false]) {
      const { chain, owner, recipient } = setup(exists);
      await expect(simulateSolanaTransfer(workflow(recipient, '12000000'), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_OWNER_NOT_WALLET');
      const review = await simulateKoraSolanaTransfer(workflow(recipient, '12000000'), owner.owner, chain.rpc, port(), NOW);
      expect(review).toMatchObject({ maximumNetworkCostLamports: '0', accountCreationLamports: '0', maximumAccountCreationLamports: '0',
        gas: { token: { symbol: 'USDC' }, amount: '241000', feeAccount: review.token!.sourceAccount } });
      // Same account: the source pays the amount and the fee; the recipient account's rent (when created) is Kora's.
      expect(BigInt(review.simulationResult.sourceAmountBefore!) - BigInt(review.simulationResult.sourceAmountAfter!)).toBe(12_241_000n);
      const ixs = decompileMessageV0(parseMessageV0(fromBase64(review.message)), {});
      expect(ixs.find(ix => ix.programId === SOLANA_MAINNET_TRANSFER.programs.associatedToken)?.accounts[0]?.pubkey).toBe(kora.owner);
      expect(() => assertSolanaTransferReview(review, review.workflow, owner.owner, chain.state.blockHeight, NOW)).not.toThrow();
      expect(verifySignedSolanaTransfer(review, owner.sign(review.unsignedTransaction)).transaction).toBeTruthy();
    }
  });
  it('keeps native when the owner has SOL, and refuses SOL transfers and Devnet in Kora mode', async () => {
    const { chain, owner, recipient } = setup(true);
    chain.fundWallet(owner.owner, 2_000_000_000n);
    await expect(simulateKoraSolanaTransfer(workflow(recipient, '12000000'), owner.owner, chain.rpc, port(), NOW)).rejects.toThrow('KORA_NATIVE_COVERS');
    await expect(simulateKoraSolanaTransfer(workflow(recipient, '1000', null), owner.owner, chain.rpc, port(), NOW)).rejects.toThrow('KORA_OPERATION_UNSUPPORTED');
    const devnet = createMockedSolanaTransferChain({ profile: SOLANA_DEVNET_TRANSFER });
    await expect(simulateKoraSolanaTransfer(workflow(recipient, '1000', null, SOLANA_DEVNET_TRANSFER.chain), owner.owner, devnet.rpc, port(), NOW)).rejects.toThrow('KORA_OPERATION_UNSUPPORTED');
  });
  it('transfers a Token-2022 token with the fee in USDC from a separate account', async () => {
    const { chain, owner, recipient } = setup(false);
    const mint = createMockedSolanaWallet().owner;
    chain.createMint(mint, { decimals: 6, program: 'token-2022' }); chain.fundToken(owner.owner, mint, 1_000_000n);
    const review = await simulateKoraSolanaTransfer(workflow(recipient, '400000', { mint, decimals: 6, program: 'token-2022' }), owner.owner, chain.rpc, port(), NOW);
    expect(review.token).toMatchObject({ program: 'token-2022', createDestination: true });
    expect(review.gas).toMatchObject({ token: { symbol: 'USDC' }, feeAccount: koraAta(owner.owner, T.USDC.mint) });
  });
  it('refuses an owner whose fee token cannot cover the transfer and the fee', async () => {
    const { chain, owner, recipient } = setup(true);
    await expect(simulateKoraSolanaTransfer(workflow(recipient, '50000000'), owner.owner, chain.rpc, port(), NOW)).rejects.toThrow('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT');
  });
});
