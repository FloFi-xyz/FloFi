// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): MOCKED engine certification of the atomic Solana Batch Payment. Every value comes
 * from the deterministic in-memory cluster (`createMockedSolanaTransferChain`) and mocked wallets; nothing reaches a public network, nothing is
 * evidence of public execution.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSolanaBatchPaymentNode, SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS, type SemanticWorkflow, type SolanaBatchPaymentFields } from '@defi-workflow-engine/workflow-contracts';

/**
 * The contracts' reader as is, unless a test replaces its answer for one call (to reach the compiler's own defence-in-depth checks behind it, which a
 * valid declaration never reaches). Every other test reads declarations through the real reader.
 */
const reader = vi.hoisted(() => ({ fields: null as null | SolanaBatchPaymentFields }));
vi.mock('@defi-workflow-engine/workflow-contracts', async importOriginal => {
  const real = await importOriginal<typeof import('@defi-workflow-engine/workflow-contracts')>();
  return { ...real, readSolanaBatchPaymentNode: (node: Parameters<typeof real.readSolanaBatchPaymentNode>[0]) => reader.fields ?? real.readSolanaBatchPaymentNode(node) };
});
import { SOLANA_MAINNET_TOKENS, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { compileMessageV0, decompileMessageV0, findProgramAddress, fromBase64, parseMessageV0, parseTransaction, serializeMessageV0, serializeTransaction, sha256Hex, toBase64,
  type SolanaInstruction } from '../src/solana.js';
import { createMockedSolanaWallet, appendMockedWalletGuards } from '../src/jupiter-mock.js';
import { applyMockedPhantomLighthouseGuards, mockedPhantomGuardInstructions } from '../src/lighthouse-mock.js';
import { createMockedSolanaTransferChain, MOCKED_RENT } from '../src/solana-transfer-mock.js';
import { setComputeUnitPrice, solanaSwapHash, type SolanaRpc } from '../src/solana-swap.js';
import { simulateSolanaTransfer, solanaTransferInstructions } from '../src/solana-transfer.js';
import { createSolanaTransferNode } from '@defi-workflow-engine/workflow-contracts';
import { assertSolanaBatchPaymentReview, decodeSolanaBatchPaymentMessage, readSolanaBatchPaymentFacts, simulateSolanaBatchPayment, solanaBatchPaymentInstructions,
  solanaBatchPaymentIntent, solanaBatchPaymentManifestHash, solanaBatchPaymentStaticBounds, verifySignedSolanaBatchPayment, type SolanaBatchPaymentReview } from '../src/solana-batch-payment.js';

const P = SOLANA_MAINNET_TRANSFER.programs, CHAIN = SOLANA_MAINNET_TRANSFER.chain, USDC = SOLANA_MAINNET_TOKENS.USDC, USDT = SOLANA_MAINNET_TOKENS.USDT;
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const SPL_USDC = { kind: 'SPL_TOKEN' as const, mint: USDC.mint, decimals: 6, program: 'spl-token' as const };
type Line = { recipient: string; amount: string };
const workflow = (payments: readonly Line[], asset: SolanaBatchPaymentFields['asset'] = { kind: 'NATIVE' }, chain = CHAIN): SemanticWorkflow =>
  ({ schemaVersion: '1.0.0', workflowId: 'workflow-batch', revision: 1, resourceEdges: [], nodes: [createSolanaBatchPaymentNode('node-002', { chain, asset, payments })] });
function setup(recipients: number, options: Parameters<typeof createMockedSolanaTransferChain>[0] = {}) {
  const chain = createMockedSolanaTransferChain(options), owner = createMockedSolanaWallet();
  const wallets = Array.from({ length: recipients }, () => createMockedSolanaWallet().owner);
  chain.fundWallet(owner.owner, 100_000_000_000n);
  chain.createMint(USDC.mint, { decimals: 6 }); chain.createMint(USDT.mint, { decimals: 6 });
  return { chain, owner, wallets };
}
const instructionsOf = (base64: string, tables = {}) => decompileMessageV0(parseMessageV0(parseTransaction(fromBase64(base64, 2048)).message), tables);
const messageOf = (review: { message: string }) => fromBase64(review.message);
const norm = (ixs: readonly SolanaInstruction[]) => ixs.map(ix => ({ programId: ix.programId, data: Buffer.from(ix.data).toString('hex'),
  accounts: ix.accounts.map(a => [a.pubkey, a.isSigner, a.isWritable]) }));
const lines = (wallets: readonly string[], amount = (i: number) => String(1_000_000_000 + i)) => wallets.map((recipient, i) => ({ recipient, amount: amount(i) }));
const rejection = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as Error & { cause?: Record<string, unknown> }; } throw new Error('expected a refusal'); };
const syncRejection = (run: () => unknown) => { try { run(); } catch (error) { return error as Error & { cause?: Record<string, unknown> }; } throw new Error('expected a refusal'); };
/** The review with `change` applied and its commitment recomputed over the changed content (what a forger able to hash could produce). */
function recommit(review: SolanaBatchPaymentReview, change: Partial<SolanaBatchPaymentReview>): SolanaBatchPaymentReview {
  const content: Partial<SolanaBatchPaymentReview> = { ...review, ...change };
  delete content.commitment;
  return { ...content, commitment: solanaSwapHash(content) } as SolanaBatchPaymentReview;
}
/** A review whose message was replaced and whose every derived field and commitment were recomputed: only the closed decoder can tell. */
function forge(review: SolanaBatchPaymentReview, message: Uint8Array): SolanaBatchPaymentReview {
  const messageHash = sha256Hex(message);
  const plan = { ...review.plan, segments: review.plan.segments.map(s => ({ ...s, steps: s.steps.map(step => ({ ...step, payloadHash: messageHash })) })) };
  return recommit(review, { message: toBase64(message), messageHash, unsignedTransaction: toBase64(serializeTransaction(null, message)), plan });
}
const recompile = (review: SolanaBatchPaymentReview, change: (ixs: SolanaInstruction[]) => SolanaInstruction[]) =>
  serializeMessageV0(compileMessageV0(review.owner, change(decompileMessageV0(parseMessageV0(messageOf(review)), {})), review.blockhash, {}));

describe('KAN-20 Solana batch intent', () => {
  it('resolves one isolated mainnet batch into one exact transfer intent per leg, recipients verbatim', () => {
    const { owner, wallets } = setup(3);
    const intent = solanaBatchPaymentIntent(workflow(lines(wallets)), owner.owner);
    expect(intent).toMatchObject({ nodeId: 'node-002', owner: owner.owner, token: null, total: '3000000003' });
    expect(intent.legs.map(l => [l.index, l.recipient, l.amount, l.intent.nodeId, l.intent.recipient])).toEqual(wallets.map((w, i) => [i, w, String(1_000_000_000 + i), `node-002#${i}`, w]));
    expect(solanaBatchPaymentIntent(workflow(lines(wallets), SPL_USDC), owner.owner).token).toEqual({ mint: USDC.mint, decimals: 6, program: 'spl-token' });
  });

  it('refuses the sender, an off-curve key, a reserved address, a malformed owner, Devnet, Token-2022 and arbitrary mints, with the recipient index', () => {
    const { owner, wallets } = setup(3);
    const sender = syncRejection(() => solanaBatchPaymentIntent(workflow([...lines(wallets.slice(0, 2)), { recipient: owner.owner, amount: '1' }]), owner.owner));
    expect(sender.message).toBe('SOLANA_BATCH_PAYMENT_RECIPIENT_IS_SENDER');
    expect(sender.cause).toEqual({ recipient: 2 });
    const pda = findProgramAddress([new TextEncoder().encode('vault')], P.system);
    const offCurve = syncRejection(() => solanaBatchPaymentIntent(workflow([{ recipient: wallets[0]!, amount: '1' }, { recipient: pda, amount: '1' }]), owner.owner));
    expect([offCurve.message, offCurve.cause]).toEqual(['SOLANA_BATCH_PAYMENT_RECIPIENT_OFF_CURVE', { recipient: 1 }]);
    // Every reserved address is refused by the contracts' closed declaration before the compiler's own (defense-in-depth) reserved check.
    for (const reserved of SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS) {
      const node = { ...createSolanaBatchPaymentNode('node-002', { chain: CHAIN, asset: { kind: 'NATIVE' }, payments: lines(wallets.slice(0, 2)) }) };
      const tampered: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
        nodes: [{ ...node, inputs: node.inputs.map(p => p.name === 'payment-01-recipient' ? { ...p, value: { chainId: CHAIN, address: reserved } } as typeof p : p) }] };
      const error = syncRejection(() => solanaBatchPaymentIntent(tampered, owner.owner));
      expect(error.message, reserved).toBe('SOLANA_BATCH_PAYMENT_DECLARATION_INVALID');
      expect((error.cause as unknown as Error).message, reserved).toBe('BATCH_PAYMENT_RECIPIENT_INVALID');
    }
    expect(() => solanaBatchPaymentIntent(workflow(lines(wallets)), 'not-a-key')).toThrow('SOLANA_BATCH_PAYMENT_OWNER_REQUIRED');
    expect(() => solanaBatchPaymentIntent(workflow(lines(wallets), { kind: 'NATIVE' }, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'), owner.owner))
      .toThrow('SOLANA_BATCH_PAYMENT_NETWORK_UNSUPPORTED');
    expect(() => solanaBatchPaymentIntent(workflow(lines(wallets), { ...SPL_USDC, program: 'token-2022' }), owner.owner)).toThrow('SOLANA_BATCH_PAYMENT_ASSET_UNSUPPORTED');
    expect(() => solanaBatchPaymentIntent(workflow(lines(wallets), { ...SPL_USDC, decimals: 9 }), owner.owner)).toThrow('SOLANA_BATCH_PAYMENT_ASSET_UNSUPPORTED');
    const arbitrary = createMockedSolanaWallet().owner;
    for (const program of ['spl-token', 'token-2022'] as const)
      expect(() => solanaBatchPaymentIntent(workflow(lines(wallets), { kind: 'SPL_TOKEN', mint: arbitrary, decimals: 6, program }), owner.owner)).toThrow('SOLANA_BATCH_PAYMENT_ASSET_UNSUPPORTED');
    const isolated = workflow(lines(wallets));
    expect(() => solanaBatchPaymentIntent({ ...isolated, nodes: [...isolated.nodes, { ...isolated.nodes[0]!, nodeId: 'node-003' }] }, owner.owner)).toThrow('SOLANA_BATCH_PAYMENT_ISOLATED_ONLY');
    expect(() => solanaBatchPaymentIntent({ ...isolated, nodes: [createSolanaTransferNode('node-002', { chain: CHAIN, amount: '1', recipient: wallets[0]!, token: null })] }, owner.owner))
      .toThrow('SOLANA_BATCH_PAYMENT_ISOLATED_ONLY');
  });
});

describe('KAN-20 byte-size table (design 3.5), measured with the repository codec on the mocked cluster', () => {
  // [N, accounts, instructions, v0 message, legacy message, v0 tx, legacy tx, v0 tx + Phantom guard, spare to 1,232 with the guard]
  const SOL = [[2, 5, 4, 253, 251, 318, 316, 380, 852], [3, 6, 5, 302, 300, 367, 365, 429, 803], [4, 7, 6, 351, 349, 416, 414, 478, 754], [5, 8, 7, 400, 398, 465, 463, 527, 705],
    [6, 9, 8, 449, 447, 514, 512, 576, 656], [7, 10, 9, 498, 496, 563, 561, 625, 607], [8, 11, 10, 547, 545, 612, 610, 674, 558]];
  const SPL = [[2, 11, 6, 465, 463, 530, 528, 623, 609], [3, 13, 8, 556, 554, 621, 619, 714, 518], [4, 15, 10, 647, 645, 712, 710, 805, 427], [5, 17, 12, 738, 736, 803, 801, 896, 336],
    [6, 19, 14, 829, 827, 894, 892, 987, 245], [7, 21, 16, 920, 918, 985, 983, 1078, 154], [8, 23, 18, 1011, 1009, 1076, 1074, 1169, 63]];
  const measure = (review: SolanaBatchPaymentReview, guarded: string) => {
    const message = messageOf(review);
    // The legacy wire form of the same message: no 0x80 version prefix and no (empty) lookup-table list.
    expect([message[0], message.at(-1)]).toEqual([0x80, 0]);
    const legacy = message.length - 2, guard = fromBase64(guarded, 2048).length;
    return [review.payments.length, review.accountCount, review.instructionCount, message.length, legacy, review.transactionBytes, 1 + 64 + legacy, guard, 1232 - guard];
  };
  it('native SOL, N = 2..8: 49N + 155 message bytes, 49N + 220 transaction bytes, +62 with Phantom\'s guard', async () => {
    for (const row of SOL) {
      const { chain, owner, wallets } = setup(row[0]!);
      const review = await simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, chain.rpc, NOW);
      expect(measure(review, applyMockedPhantomLighthouseGuards(review.unsignedTransaction, { lamportsAtLeast: 1n })), `SOL N=${row[0]}`).toEqual(row);
      expect(review.transactionBytes).toBe(fromBase64(review.unsignedTransaction, 2048).length);
      expect(review.instructionTraceBound).toBe(2 + row[0]! + 8);
    }
  });
  it('SPL, N = 2..8: 91N + 283 message bytes and 91N + 348 transaction bytes for ANY number of ATA creations, +93 with Phantom\'s guard', async () => {
    for (const row of SPL) for (const existing of [0, row[0]!, 1]) {
      const { chain, owner, wallets } = setup(row[0]!);
      chain.fundToken(owner.owner, USDC.mint, 1_000_000_000_000n);
      wallets.slice(0, existing).forEach(w => chain.fundToken(w, USDC.mint, 5n));
      const review = await simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000'), SPL_USDC), owner.owner, chain.rpc, NOW);
      expect(review.payments.filter(p => p.createDestination)).toHaveLength(row[0]! - existing);
      const guarded = applyMockedPhantomLighthouseGuards(review.unsignedTransaction, { lamportsAtLeast: 1n, tokenAccount: review.token!.sourceAccount, tokenAmountAtLeast: 0n });
      expect(measure(review, guarded), `SPL N=${row[0]} existing=${existing}`).toEqual(row);
      expect(review.instructionTraceBound).toBe(2 + 6 * row[0]! + 8);
    }
  });
});

describe('KAN-20 SOL batch', () => {
  it('pays every recipient exactly in one message whose legs are each a reviewed single transfer, and binds fee, limit and reserve', async () => {
    const { chain, owner, wallets } = setup(3);
    wallets.forEach(w => chain.fundWallet(w, 5_000_000n));
    const review = await simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, chain.rpc, NOW);
    // Mock cost model: base 300, compute budget 150 each, System transfer 150. Probe (no price): 300 + 150 + 3 x 150 = 900.
    expect(review.computeUnitLimit).toBe(Math.ceil(900 * 6 / 5) + 5_000);
    expect(review.unitsConsumed).toBe(1_050);
    expect(review.computeUnitCap).toBe(600_000);
    expect(BigInt(review.estimatedFeeLamports)).toBe(5000n + (BigInt(review.computeUnitLimit) * 200_000n + 999_999n) / 1_000_000n);
    expect(review).toMatchObject({ format: 'flofi.solana-batch-payment-review.v1', atomic: true, cluster: 'mainnet-beta', network: 'Solana', total: '3000000003',
      asset: { symbol: 'SOL', mint: null, decimals: 9, program: 'native', verified: true }, token: null, accountCreationLamports: '0', maximumAccountCreationLamports: '0',
      computeUnitPrice: '200000', expiresAt: new Date(NOW + 50_000).toISOString() });
    expect(review.requiredLamports).toBe((3_000_000_003n + BigInt(review.estimatedFeeLamports) + MOCKED_RENT.system).toString());
    expect(review.maximumNetworkCostLamports).toBe(review.estimatedFeeLamports);
    expect(review.payments.map(p => [p.recipient, p.amount, p.before, p.after])).toEqual(wallets.map((w, i) => [w, String(1_000_000_000 + i), '5000000', String(5_000_000 + 1_000_000_000 + i)]));
    const ixs = instructionsOf(review.unsignedTransaction);
    expect(ixs.map(ix => ix.programId)).toEqual([P.computeBudget, P.computeBudget, P.system, P.system, P.system]);
    const intent = solanaBatchPaymentIntent(review.workflow, owner.owner);
    expect(norm(ixs.slice(2))).toEqual(norm(intent.legs.flatMap(leg => solanaTransferInstructions(leg.intent, null))));
    // The same bytes as the reviewed single transfer of that payment.
    const single = await simulateSolanaTransfer({ ...review.workflow, nodes: [createSolanaTransferNode('node-002', { chain: CHAIN, amount: '1000000001', recipient: wallets[1]!, token: null })] },
      owner.owner, chain.rpc, NOW);
    expect(norm(instructionsOf(single.unsignedTransaction).slice(2))).toEqual(norm(ixs.slice(3, 4)));
    expect(review.manifestHash).toBe(solanaBatchPaymentManifestHash({ chain: CHAIN, owner: owner.owner, asset: { kind: 'NATIVE', mint: null, decimals: 9, program: 'native' },
      payments: lines(wallets) }));
    expect(review.policy.allowlists.recipients).toEqual(wallets.map(address => ({ chainId: CHAIN, address })));
    expect(review.policy.allowlists.functions).toEqual([{ chainId: CHAIN, contract: P.system, functionId: 'system-transfer' }]);
    expect(review.manifest.spendLimits).toEqual([{ asset: { chainId: CHAIN, nativeId: 'SOL', decimals: 9 }, maximumAmount: '3000000003', maximumPerStepAmount: '1000000002',
      maximumCumulativeAmount: '3000000003' }]);
    expect(review.plan.segments).toHaveLength(1);
    expect(review.plan.segments[0]!.steps).toEqual([expect.objectContaining({ stepId: 'solbp-batch', nodeId: 'node-002', executionKind: 'DIRECT_TRANSACTION', payloadHash: review.messageHash })]);
    expect(() => assertSolanaBatchPaymentReview(review, review.workflow, owner.owner, chain.state.blockHeight, NOW + 1000)).not.toThrow();
    // Signed and landed: every recipient receives exactly its amount, the owner pays the total plus the fee.
    const before = chain.lamports(owner.owner), signed = verifySignedSolanaBatchPayment(review, owner.sign(review.unsignedTransaction));
    expect(signed.walletGuard).toBeUndefined();
    await chain.rpc('sendTransaction', [signed.transaction, { encoding: 'base64' }]);
    wallets.forEach((w, i) => expect(chain.lamports(w)).toBe(5_000_000n + 1_000_000_000n + BigInt(i)));
    expect(before - chain.lamports(owner.owner)).toBe(3_000_000_003n + BigInt(review.estimatedFeeLamports));
  });

  it('refuses a new recipient below the rent-exempt minimum, naming it, and keeps the owner rent-exempt', async () => {
    const { chain, owner, wallets } = setup(3);
    chain.fundWallet(wallets[0]!, 5_000_000n);
    const low = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets, i => i === 2 ? String(MOCKED_RENT.system - 1n) : '1')), owner.owner, chain.rpc, NOW));
    // Recipient 0 exists (any amount); recipient 1 is new and below rent too, and is named first.
    expect([low.message, low.cause]).toEqual(['SOLANA_BATCH_PAYMENT_AMOUNT_BELOW_RENT_EXEMPT', { recipient: 1, minimum: String(MOCKED_RENT.system) }]);
    await expect(simulateSolanaBatchPayment(workflow(lines(wallets, i => i === 0 ? '1' : String(MOCKED_RENT.system))), owner.owner, chain.rpc, NOW)).resolves.toBeTruthy();
  });

  it('refuses an owner who cannot keep its reserve with the exact shortfall, and one far below it with a sufficient top-up', async () => {
    const { chain, owner, wallets } = setup(2);
    wallets.forEach(w => chain.fundWallet(w, 5_000_000n));
    const fees = await simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000000')), owner.owner, chain.rpc, NOW);
    const fee = BigInt(fees.estimatedFeeLamports), required = 2_000_000_000n + fee + MOCKED_RENT.system;
    chain.fundWallet(owner.owner, required - 1n);
    const exact = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000000')), owner.owner, chain.rpc, NOW));
    expect(exact.message).toBe('SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL');
    expect(exact.cause).toEqual({ unit: 'lamports', balance: (required - 1n).toString(), fee: fee.toString(), deposits: '0', maxFee: fee.toString(), nativeSpend: '2000000000',
      reserve: String(MOCKED_RENT.system), required: required.toString(), shortfall: '1', exact: true });
    chain.fundWallet(owner.owner, required);
    await expect(simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000000')), owner.owner, chain.rpc, NOW)).resolves.toMatchObject({ requiredLamports: required.toString() });
    chain.fundWallet(owner.owner, 1_000_000_000n);
    const far = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000000')), owner.owner, chain.rpc, NOW));
    expect(far.message).toBe('SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL');
    // Before any simulation: the fee is the ceiling at the compute cap (400,000 units x 200,000 micro-lamports), so adding `shortfall` always suffices.
    expect(far.cause).toMatchObject({ exact: false, fee: String(5000 + 80_000), nativeSpend: '2000000000', balance: '1000000000' });
    expect(BigInt(far.cause!.shortfall as string)).toBeGreaterThan(required - 1_000_000_000n);
  });

  it('refuses the wrong cluster and an owner that is not an ordinary wallet', async () => {
    const wrong = setup(2, { genesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' });
    await expect(simulateSolanaBatchPayment(workflow(lines(wrong.wallets)), wrong.owner.owner, wrong.chain.rpc, NOW)).rejects.toThrow('SOLANA_BATCH_PAYMENT_WRONG_CLUSTER');
    const { chain, wallets } = setup(2), absent = createMockedSolanaWallet().owner;
    await expect(simulateSolanaBatchPayment(workflow(lines(wallets)), absent, chain.rpc, NOW)).rejects.toThrow('SOLANA_BATCH_PAYMENT_OWNER_NOT_WALLET');
    const data = createMockedSolanaWallet().owner;
    chain.systemAccountWithData(data, 8, 10_000_000_000n);
    await expect(simulateSolanaBatchPayment(workflow(lines(wallets)), data, chain.rpc, NOW)).rejects.toThrow('SOLANA_BATCH_PAYMENT_OWNER_NOT_WALLET');
  });
});

describe('KAN-20 USDC batch', () => {
  it('creates only the missing ATAs, reserves the worst-case deposit for every recipient and pays each exactly', async () => {
    const { chain, owner, wallets } = setup(4);
    const source = chain.fundToken(owner.owner, USDC.mint, 50_000_000n);
    chain.fundToken(wallets[1]!, USDC.mint, 7n); chain.fundToken(wallets[3]!, USDC.mint, 0n);
    const review = await simulateSolanaBatchPayment(workflow(lines(wallets, i => String((i + 1) * 1_000_000)), SPL_USDC), owner.owner, chain.rpc, NOW);
    expect(review.token).toMatchObject({ program: 'spl-token', programId: P.token, mint: USDC.mint, decimals: 6, symbol: 'USDC', sourceAccount: source, sourceAmount: '50000000' });
    expect(review.asset).toEqual({ symbol: 'USDC', mint: USDC.mint, decimals: 6, program: 'spl-token', verified: true });
    expect(review.payments.map(p => [p.createDestination, p.accountCreationLamports, p.maximumAccountCreationLamports, p.before, p.after])).toEqual([
      [true, String(MOCKED_RENT.token), String(MOCKED_RENT.token), '0', '1000000'], [false, '0', String(MOCKED_RENT.token), '7', '2000007'],
      [true, String(MOCKED_RENT.token), String(MOCKED_RENT.token), '0', '3000000'], [false, '0', String(MOCKED_RENT.token), '0', '4000000']]);
    expect(review.payments.map(p => p.destinationAccount)).toEqual(wallets.map(w => chain.ata(w, USDC.mint)));
    expect(review.accountCreationLamports).toBe(String(2n * MOCKED_RENT.token));
    expect(review.maximumAccountCreationLamports).toBe(String(4n * MOCKED_RENT.token));
    const fee = BigInt(review.estimatedFeeLamports);
    expect(review.maximumNetworkCostLamports).toBe((fee + 4n * MOCKED_RENT.token).toString());
    expect(review.requiredLamports).toBe((fee + 4n * MOCKED_RENT.token + MOCKED_RENT.system).toString());
    // Probe: 300 + 150 + 4 x (22,000 + 6,200) = 113,250 consumed (mock cost model).
    expect(review.computeUnitLimit).toBe(Math.ceil(113_250 * 6 / 5) + 5_000);
    expect(review.policy.allowlists.functions).toEqual([{ chainId: CHAIN, contract: P.associatedToken, functionId: 'create-idempotent' },
      { chainId: CHAIN, contract: P.token, functionId: 'transfer-checked' }]);
    expect(review.simulation.contracts.map(c => c.address)).toEqual([P.token, P.associatedToken]);
    const ixs = instructionsOf(review.unsignedTransaction);
    expect(ixs.map(ix => ix.programId)).toEqual([P.computeBudget, P.computeBudget, ...wallets.flatMap(() => [P.associatedToken, P.token])]);
    // Parity: each leg is the single transfer's CreateIdempotent + TransferChecked for that recipient, byte for byte.
    const single = await simulateSolanaTransfer({ ...review.workflow, nodes: [createSolanaTransferNode('node-002', { chain: CHAIN, amount: '2000000', recipient: wallets[1]!,
      token: { mint: USDC.mint, decimals: 6, program: 'spl-token' } })] }, owner.owner, chain.rpc, NOW);
    expect(norm(instructionsOf(single.unsignedTransaction).slice(2))).toEqual(norm(ixs.slice(4, 6)));
    // The exported builder compiles to exactly the reviewed bytes from fresh facts.
    const intent = solanaBatchPaymentIntent(review.workflow, owner.owner), facts = await readSolanaBatchPaymentFacts(chain.rpc, intent);
    expect(serializeMessageV0(compileMessageV0(owner.owner, solanaBatchPaymentInstructions(intent, facts, review.computeUnitLimit), review.blockhash, {}))).toEqual(messageOf(review));
    // Landed: the source pays the total, every ATA receives its amount, the owner pays the fee and only the created deposits.
    const before = chain.lamports(owner.owner);
    await chain.rpc('sendTransaction', [verifySignedSolanaBatchPayment(review, owner.sign(review.unsignedTransaction)).transaction, { encoding: 'base64' }]);
    expect(chain.tokenAccount(source)!.amount).toBe(40_000_000n);
    expect(wallets.map(w => chain.tokenAccount(chain.ata(w, USDC.mint))!.amount)).toEqual([1_000_000n, 2_000_007n, 3_000_000n, 4_000_000n]);
    expect(before - chain.lamports(owner.owner)).toBe(fee + 2n * MOCKED_RENT.token);
  });

  it('needs ONE source that covers the whole total: a sufficient non-ATA account is chosen alone, several are never combined', async () => {
    const { chain, owner, wallets } = setup(2);
    chain.fundToken(owner.owner, USDC.mint, 3_000_000n);
    const total = workflow(lines(wallets, () => '2000000'), SPL_USDC);
    // Each payment alone fits the canonical ATA (3 USDC); the total (4 USDC) does not.
    const short = await rejection(simulateSolanaBatchPayment(total, owner.owner, chain.rpc, NOW));
    expect(short.message).toBe('SOLANA_BATCH_PAYMENT_INSUFFICIENT_TOKEN_BALANCE');
    const second = createMockedSolanaWallet().owner;
    chain.fundToken(owner.owner, USDC.mint, 3_000_000n, { at: second });
    await expect(simulateSolanaBatchPayment(total, owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_BATCH_PAYMENT_INSUFFICIENT_TOKEN_BALANCE');
    const funded = createMockedSolanaWallet().owner;
    chain.fundToken(owner.owner, USDC.mint, 9_000_000n, { at: funded });
    const review = await simulateSolanaBatchPayment(total, owner.owner, chain.rpc, NOW);
    expect(review.token!.sourceAccount).toBe(funded);
    expect(instructionsOf(review.unsignedTransaction).filter(ix => ix.programId === P.token).map(ix => ix.accounts[0]!.pubkey)).toEqual([funded, funded]);
  });

  it('refuses recipients that are not wallets and destination ATAs that are not the recipient\'s, naming the recipient', async () => {
    const cases: [string, (c: ReturnType<typeof setup>) => void, string][] = [
      ['token account', c => { c.chain.fundToken(c.wallets[0]!, USDC.mint, 1n, { at: c.wallets[1]! }); }, 'RECIPIENT_IS_TOKEN_ACCOUNT'],
      ['program', c => c.chain.markProgram(c.wallets[1]!), 'RECIPIENT_NOT_WALLET'],
      ['data account', c => c.chain.systemAccountWithData(c.wallets[1]!, 10, 5_000_000n), 'RECIPIENT_NOT_WALLET'],
      ['reassigned ATA', c => { c.chain.fundToken(c.wallets[1]!, USDC.mint, 0n, { tokenOwner: createMockedSolanaWallet().owner }); }, 'DESTINATION_OWNER_MISMATCH'],
      ['frozen ATA', c => { c.chain.fundToken(c.wallets[1]!, USDC.mint, 0n, { state: 2 }); }, 'TOKEN_ACCOUNT_FROZEN'],
      ['prefunded ATA address', c => c.chain.fundWallet(c.chain.ata(c.wallets[1]!, USDC.mint), 1_000_000n), 'TOKEN_ACCOUNT_MISMATCH']];
    for (const [label, arrange, code] of cases) {
      const c = setup(3);
      c.chain.fundToken(c.owner.owner, USDC.mint, 50_000_000n);
      arrange(c);
      const error = await rejection(simulateSolanaBatchPayment(workflow(lines(c.wallets, () => '1000000'), SPL_USDC), c.owner.owner, c.chain.rpc, NOW));
      expect(error.message, label).toBe(`SOLANA_BATCH_PAYMENT_${code}`);
      expect(error.cause?.recipient, label).toBe(1);
    }
  });

  it('refuses an owner without SOL for the worst-case deposits with the actionable shortfall', async () => {
    const { chain, owner, wallets } = setup(3);
    chain.fundToken(owner.owner, USDC.mint, 50_000_000n);
    wallets.forEach(w => chain.fundToken(w, USDC.mint, 0n));
    chain.fundWallet(owner.owner, 2_000_000n);
    const error = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000'), SPL_USDC), owner.owner, chain.rpc, NOW));
    expect(error.message).toBe('SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL');
    // Even with every ATA existing, each may be recreated: the worst case (3 deposits) is reserved.
    expect(error.cause).toMatchObject({ unit: 'lamports', balance: '2000000', deposits: String(3n * MOCKED_RENT.token), nativeSpend: '0', reserve: String(MOCKED_RENT.system), exact: false });
  });
});

describe('KAN-20 compute: measured, never capped silently', () => {
  const recorded = (rpc: SolanaRpc, sink: Uint8Array[], change?: (value: Record<string, unknown>, call: number) => void): SolanaRpc => async (method, params) => {
    const result = await rpc(method, params);
    if (method !== 'simulateTransaction') return result;
    sink.push(parseTransaction(fromBase64(params[0], 2048)).message);
    const value = { ...(result as { value: Record<string, unknown> }).value };
    change?.(value, sink.length);
    return { ...(result as object), value };
  };
  it('probes at the cap without a priority fee, then reviews ceil(1.2 x consumed) + 5,000 with the reviewed price', async () => {
    const { chain, owner, wallets } = setup(8);
    chain.fundToken(owner.owner, USDC.mint, 50_000_000n);
    const sink: Uint8Array[] = [];
    const review = await simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000'), SPL_USDC), owner.owner, recorded(chain.rpc, sink), NOW);
    const probe = decompileMessageV0(parseMessageV0(sink[0]!), {}), final = decompileMessageV0(parseMessageV0(sink[1]!), {});
    expect(probe.filter(ix => ix.programId === P.computeBudget).map(ix => Buffer.from(ix.data).toString('hex'))).toEqual(['02' + Buffer.from(Uint32Array.of(1_400_000).buffer).toString('hex')]);
    expect(final.filter(ix => ix.programId === P.computeBudget)).toHaveLength(2);
    // Design 3.6 mock numbers: 8 SPL recipients consume 226,050 in the probe; the reviewed limit is 276,260.
    expect([review.computeUnitCap, review.computeUnitLimit]).toEqual([1_400_000, 276_260]);
    expect(sink[1]).toEqual(messageOf(review));
  });
  it('refuses when the measured need exceeds the ceiling, when the probe exhausts its budget, and when the exact bytes use more than reviewed', async () => {
    const { chain, owner, wallets } = setup(2);
    const inflated = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, recorded(chain.rpc, [], value => { value.unitsConsumed = 400_000; }), NOW));
    expect([inflated.message, inflated.cause]).toEqual(['SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED', { needed: 485_000, cap: 400_000 }]);
    const exhausted = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, recorded(chain.rpc, [], value => {
      value.err = { InstructionError: [2, 'ComputationalBudgetExceeded'] }; }), NOW));
    expect([exhausted.message, exhausted.cause]).toEqual(['SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED', { limit: 400_000, cap: 400_000 }]);
    const logged = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, recorded(chain.rpc, [], value => {
      value.err = { InstructionError: [2, { Custom: 1 }] }; value.logs = ['Program 11111111111111111111111111111111 failed: exceeded CUs meter at BPF instruction']; }), NOW));
    expect(logged.message).toBe('SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED');
    const failed = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, recorded(chain.rpc, [], value => { value.err = { InstructionError: [2, { Custom: 1 }] }; }), NOW));
    expect(failed.message).toBe('SOLANA_BATCH_PAYMENT_SIMULATION_FAILED');
    const grew = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, recorded(chain.rpc, [], (value, call) => { if (call === 2) value.unitsConsumed = 6_000; }), NOW));
    expect(grew.message).toBe('SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED');
  });
  it('keeps the offline mock unchanged by default and enforces the reviewed limit only when asked', async () => {
    for (const enforceComputeLimit of [false, true]) {
      const { chain, owner, wallets } = setup(3, { enforceComputeLimit });
      const review = await simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner, chain.rpc, NOW);
      // Eight extra Lighthouse owner assertions (2,000 mock units each) do not fit the reviewed SOL limit (~6,000 units).
      const guard = mockedPhantomGuardInstructions(owner.owner, { lamportsAtLeast: 1n })[0]!;
      const parsed = parseMessageV0(messageOf(review));
      const guarded = serializeMessageV0({ ...parsed, header: [1, 0, parsed.header[2] + 1], staticKeys: [...parsed.staticKeys, guard.programId],
        instructions: [...parsed.instructions, ...Array.from({ length: 8 }, () => ({ programIdIndex: parsed.staticKeys.length, accounts: [0], data: guard.data }))] });
      const signed = verifySignedSolanaBatchPayment(review, owner.sign(toBase64(serializeTransaction(null, guarded))));
      expect(signed.walletGuard?.instructions).toHaveLength(8);
      const signature = await chain.rpc('sendTransaction', [signed.transaction, { encoding: 'base64' }]) as string;
      const landed = chain.state.transactions.get(signature)!;
      // Instructions 0..4 are the reviewed batch (1,050 units); the third assertion (index 7) crosses the reviewed limit.
      expect(landed.err, String(enforceComputeLimit)).toEqual(enforceComputeLimit ? { InstructionError: [7, 'ComputationalBudgetExceeded'] } : null);
      // A failed transaction moves nothing but the fee.
      if (enforceComputeLimit) wallets.forEach(w => expect(chain.lamports(w)).toBe(0n));
    }
  });
});

describe('KAN-20 closed message decoder and Review guard', () => {
  async function reviewed(asset: SolanaBatchPaymentFields['asset'] = { kind: 'NATIVE' }, recipients = 3) {
    const c = setup(recipients);
    c.chain.fundToken(c.owner.owner, USDC.mint, 50_000_000n);
    const review = await simulateSolanaBatchPayment(workflow(lines(c.wallets, i => String(1_000_000 * (i + 1))), asset), c.owner.owner, c.chain.rpc, NOW);
    return { ...c, review };
  }
  const expectation = (review: SolanaBatchPaymentReview, computeUnitPrice = review.computeUnitPrice) => ({ owner: review.owner, profile: SOLANA_MAINNET_TRANSFER,
    token: review.token ? { programId: review.token.programId, mint: review.token.mint, decimals: review.token.decimals, sourceAccount: review.token.sourceAccount } : null, computeUnitPrice });
  it('reads back exactly the reviewed manifest and limit', async () => {
    for (const asset of [{ kind: 'NATIVE' as const }, SPL_USDC]) {
      const { review } = await reviewed(asset);
      expect(decodeSolanaBatchPaymentMessage(messageOf(review), expectation(review))).toEqual({ computeUnitLimit: review.computeUnitLimit,
        payments: review.payments.map(p => ({ recipient: p.recipient, amount: p.amount, destinationAccount: p.destinationAccount })) });
    }
  });
  it('refuses structural changes: price, extra or missing instructions, a foreign program or account, one leg, an unreferenced key, lookups', async () => {
    for (const asset of [{ kind: 'NATIVE' as const }, SPL_USDC]) {
      const { review, wallets } = await reviewed(asset);
      const width = review.token ? 2 : 1, x = createMockedSolanaWallet().owner;
      const extra: SolanaInstruction = { programId: P.system, accounts: [{ pubkey: review.owner, isSigner: true, isWritable: true }, { pubkey: x, isSigner: false, isWritable: true }],
        data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
      const changes: [string, Uint8Array][] = [
        ['changed price', recompile(review, ixs => [ixs[0]!, ...setComputeUnitPrice('300000'), ...ixs.slice(2)])],
        ['no price', recompile(review, ixs => [ixs[0]!, ...ixs.slice(2)])],
        // SOL: an appended System transfer is a well-formed extra payment (refused against the manifest below); SPL: an odd, foreign instruction.
        ...review.token ? [['extra instruction', recompile(review, ixs => [...ixs, extra])] as [string, Uint8Array]] : [],
        ['one leg', recompile(review, ixs => ixs.slice(0, 2 + width))],
        ['memo program', recompile(review, ixs => [...ixs, { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', accounts: [], data: Uint8Array.of(1) }])],
        ['duplicate recipient', recompile(review, ixs => [...ixs.slice(0, 2 + width), ...ixs.slice(2, 2 + width)])],
        ['leg on another account', recompile(review, ixs => ixs.map((ix, i) => i === 2 + width - 1 ? { ...ix, accounts: ix.accounts.map((a, j) => j === 0 ? { ...a, pubkey: x } : a) } : ix))]];
      const parsed = parseMessageV0(messageOf(review));
      changes.push(['unreferenced key', serializeMessageV0({ ...parsed, header: [1, 0, parsed.header[2] + 1], staticKeys: [...parsed.staticKeys, x] })]);
      changes.push(['lookup table', serializeMessageV0({ ...parsed, lookups: [{ table: x, writable: [], readonly: [0] }] })]);
      changes.push(['second signer', serializeMessageV0(compileMessageV0(review.owner, [...decompileMessageV0(parsed, {}).slice(0, 2),
        { ...extra, accounts: [{ pubkey: wallets[0]!, isSigner: true, isWritable: true }, { pubkey: x, isSigner: false, isWritable: true }] }, ...decompileMessageV0(parsed, {}).slice(2)],
        review.blockhash, {}))]);
      for (const [label, message] of changes)
        expect(() => decodeSolanaBatchPaymentMessage(message, expectation(review)), `${asset.kind} ${label}`).toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
      expect(() => decodeSolanaBatchPaymentMessage(messageOf(review), expectation(review, '0')), asset.kind).toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
      expect(() => decodeSolanaBatchPaymentMessage(messageOf(review), { ...expectation(review), owner: x })).toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
    }
    const { review } = await reviewed(SPL_USDC);
    // SPL: a TransferChecked with other decimals, another mint, another source or an ATA that is not the recipient's.
    for (const [label, change] of [['decimals', (ix: SolanaInstruction) => ix.programId === P.token ? { ...ix, data: Uint8Array.from([...ix.data.slice(0, 9), 9]) } : ix],
      ['ata', (ix: SolanaInstruction) => ix.programId === P.associatedToken ? { ...ix, accounts: ix.accounts.map((a, j) => j === 2 ? { ...a, pubkey: review.owner } : a) } : ix]] as const)
      expect(() => decodeSolanaBatchPaymentMessage(recompile(review, ixs => ixs.map(change)), expectation(review)), label).toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
    expect(() => decodeSolanaBatchPaymentMessage(messageOf(review), { ...expectation(review), token: { ...expectation(review).token!, sourceAccount: createMockedSolanaWallet().owner } }))
      .toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
    expect(() => decodeSolanaBatchPaymentMessage(messageOf(review), { ...expectation(review), token: { ...expectation(review).token!, mint: USDT.mint } }))
      .toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
  });
  it('a forged Review (every hash recomputed) whose message drops, reorders, re-amounts or redirects a payment is refused', async () => {
    for (const asset of [{ kind: 'NATIVE' as const }, SPL_USDC]) {
      const { review, chain, owner } = await reviewed(asset);
      const width = review.token ? 2 : 1, legs = (ixs: SolanaInstruction[]) => Array.from({ length: (ixs.length - 2) / width }, (_, i) => ixs.slice(2 + i * width, 2 + (i + 1) * width));
      const other = createMockedSolanaWallet().owner;
      const amountAt = (ix: SolanaInstruction, value: bigint) => {
        const data = Uint8Array.from(ix.data), at = ix.programId === P.system ? 4 : 1;
        new DataView(data.buffer).setBigUint64(at, value, true);
        return { ...ix, data };
      };
      // The first payment redirected to another wallet: SOL rewrites the transfer's recipient; SPL rewrites the CreateIdempotent wallet and ATA and the
      // TransferChecked destination consistently (the new recipient's own ATA), so the message is a well-formed batch of another manifest.
      const otherAta = chain.ata(other, USDC.mint), swap = (ix: SolanaInstruction, slots: Record<number, string>) =>
        ({ ...ix, accounts: ix.accounts.map((a, j) => slots[j] ? { ...a, pubkey: slots[j]! } : a) });
      const redirect = (ixs: SolanaInstruction[]) => ixs.map((ix, i) => review.token
        ? i === 2 ? swap(ix, { 1: otherAta, 2: other }) : i === 3 ? swap(ix, { 2: otherAta }) : ix
        : i === 2 ? swap(ix, { 1: other }) : ix);
      const changes: [string, Uint8Array][] = [
        ['dropped', recompile(review, ixs => [...ixs.slice(0, 2), ...legs(ixs).slice(0, 2).flat()])],
        ['reordered', recompile(review, ixs => [...ixs.slice(0, 2), ...legs(ixs).reverse().flat()])],
        ['re-amounted', recompile(review, ixs => ixs.map(ix => ix.programId === P.system || ix.programId === P.token ? amountAt(ix, 999n) : ix))],
        ['redirected', recompile(review, redirect)],
        ['re-limited', recompile(review, ixs => [{ ...ixs[0]!, data: Uint8Array.from([2, ...new Uint8Array(Uint32Array.of(review.computeUnitLimit + 1).buffer)]) }, ...ixs.slice(1)])],
        ...review.token ? [] : [['appended payment', recompile(review, ixs => [...ixs, { programId: P.system, accounts: [{ pubkey: owner.owner, isSigner: true, isWritable: true },
          { pubkey: other, isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }])] as [string, Uint8Array]]];
      for (const [label, message] of changes) {
        // The message alone is a well-formed batch: only the comparison with the reviewed manifest refuses it.
        expect(() => decodeSolanaBatchPaymentMessage(message, expectation(review)), `${asset.kind} ${label} decodes`).not.toThrow();
        const forged = forge(review, message);
        expect(() => assertSolanaBatchPaymentReview(forged, forged.workflow, owner.owner, chain.state.blockHeight, NOW + 1000), `${asset.kind} ${label}`)
          .toThrow('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
      }
      expect(() => assertSolanaBatchPaymentReview(review, review.workflow, owner.owner, chain.state.blockHeight, NOW + 1000)).not.toThrow();
    }
  });
  it('expires, refuses another owner, a changed workflow and any tampered field', async () => {
    const { review, chain, owner, wallets } = await reviewed();
    const ok = (r: SolanaBatchPaymentReview, w = r.workflow, who = owner.owner, height = chain.state.blockHeight, now = NOW + 1000) => assertSolanaBatchPaymentReview(r, w, who, height, now);
    expect(() => ok(review)).not.toThrow();
    expect(() => ok(review, undefined, undefined, undefined, NOW + 50_000)).toThrow('SOLANA_BATCH_PAYMENT_REVIEW_EXPIRED');
    expect(() => ok(review, undefined, undefined, undefined, NOW - 1)).toThrow('SOLANA_BATCH_PAYMENT_REVIEW_EXPIRED');
    expect(() => ok(review, undefined, undefined, review.lastValidBlockHeight - 20)).toThrow('SOLANA_BATCH_PAYMENT_REVIEW_EXPIRED');
    expect(() => ok(review, undefined, createMockedSolanaWallet().owner)).toThrow('SOLANA_BATCH_PAYMENT_WRONG_OWNER');
    expect(() => ok({ ...review, total: '1' })).toThrow('SOLANA_BATCH_PAYMENT_AUTHORIZATION_INVALID');
    expect(() => ok({ ...review, payments: review.payments.slice(0, 2) })).toThrow('SOLANA_BATCH_PAYMENT_AUTHORIZATION_INVALID');
    expect(() => ok(review, workflow(lines(wallets, i => String(1_000_000 * (i + 1) + (i === 2 ? 1 : 0)))))).toThrow('SOLANA_BATCH_PAYMENT_SEMANTIC_REVISION_CHANGED');
    // A recomputed commitment over a changed manifest view is refused against the workflow.
    expect(() => ok(recommit(review, { payments: [review.payments[1]!, review.payments[0]!, review.payments[2]!] }))).toThrow('SOLANA_BATCH_PAYMENT_SEMANTIC_REVISION_CHANGED');
    expect(() => ok(recommit(review, { manifestHash: '0x' + '0'.repeat(64) }))).toThrow('SOLANA_BATCH_PAYMENT_SEMANTIC_REVISION_CHANGED');
    expect(() => ok(recommit(review, { computeUnitPrice: '0' }))).toThrow('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    expect(() => ok(recommit(review, { format: 'gryloo.solana-transfer-review.v1' as never }))).toThrow('SOLANA_BATCH_PAYMENT_AUTHORIZATION_INVALID');
  });
});

describe('KAN-20 signed transaction verification', () => {
  it('accepts the exact bytes or them plus Phantom\'s verified Lighthouse guard; refuses any other change, a foreign signer and oversize bytes', async () => {
    const { chain, owner, wallets } = setup(8);
    const source = chain.fundToken(owner.owner, USDC.mint, 50_000_000n);
    const review = await simulateSolanaBatchPayment(workflow(lines(wallets, () => '1000000'), SPL_USDC), owner.owner, chain.rpc, NOW);
    expect(verifySignedSolanaBatchPayment(review, owner.sign(review.unsignedTransaction)).walletGuard).toBeUndefined();
    const guarded = applyMockedPhantomLighthouseGuards(review.unsignedTransaction, { lamportsAtLeast: 1n, tokenAccount: source, tokenAmountAtLeast: 0n });
    const signed = verifySignedSolanaBatchPayment(review, owner.sign(guarded));
    expect(fromBase64(signed.transaction, 2048).length).toBe(1169);
    expect(signed.walletGuard).toMatchObject({ format: 'flofi.solana-wallet-guard.v1', reviewedMessageHash: review.messageHash });
    expect(signed.walletGuard!.instructions.map(i => [i.kind, i.target])).toEqual([['AssertAccountInfoMulti', owner.owner], ['AssertTokenAccountMulti', source]]);
    // The guarded transaction lands and pays every recipient.
    await chain.rpc('sendTransaction', [signed.transaction, { encoding: 'base64' }]);
    expect(wallets.map(w => chain.tokenAccount(chain.ata(w, USDC.mint))?.amount)).toEqual(wallets.map(() => 1_000_000n));
    const priced = toBase64(serializeTransaction(null, recompile(review, ixs => [ixs[0]!, ...setComputeUnitPrice('400000'), ...ixs.slice(2)])));
    expect(() => verifySignedSolanaBatchPayment(review, owner.sign(priced))).toThrow('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    expect(() => verifySignedSolanaBatchPayment(review, owner.sign(appendMockedWalletGuards(review.unsignedTransaction, 1)))).toThrow('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    const x = createMockedSolanaWallet().owner;
    const extra = toBase64(serializeTransaction(null, recompile(review, ixs => [...ixs.slice(0, 2),
      { programId: P.system, accounts: [{ pubkey: owner.owner, isSigner: true, isWritable: true }, { pubkey: x, isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }])));
    expect(() => verifySignedSolanaBatchPayment(review, owner.sign(extra))).toThrow('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
    expect(() => verifySignedSolanaBatchPayment(review, createMockedSolanaWallet().sign(review.unsignedTransaction))).toThrow('SOLANA_BATCH_PAYMENT_SIGNATURE_INVALID');
    const oversize = toBase64(Uint8Array.from([...fromBase64(owner.sign(review.unsignedTransaction), 2048), ...new Uint8Array(200)]));
    expect(() => verifySignedSolanaBatchPayment(review, oversize)).toThrow('SOLANA_BATCH_PAYMENT_SIGNED_TRANSACTION_TOO_LARGE');
    for (const garbage of ['', 'not base64', toBase64(Uint8Array.of(0)), 42])
      expect(() => verifySignedSolanaBatchPayment(review, garbage), String(garbage)).toThrow('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
  });
});

describe('KAN-20 static bounds refuse before any simulation', () => {
  it('refuses oversize bytes, too many account locks and a too-long instruction trace', () => {
    const owner = createMockedSolanaWallet().owner, keys = Array.from({ length: 40 }, () => createMockedSolanaWallet().owner);
    const legs = (n: number) => Array.from({ length: n }, (_, index) => ({ index }) as never);
    const recipients = (n: number) => Array.from({ length: n }, () => ({}) as never);
    const big = serializeMessageV0({ header: [1, 0, 33], staticKeys: [owner, ...keys.slice(0, 33)], blockhash: keys[39]!, instructions: [], lookups: [] });
    const error = syncRejection(() => solanaBatchPaymentStaticBounds({ legs: legs(2), token: null }, { recipients: recipients(2) }, big));
    expect([error.message, error.cause]).toEqual(['SOLANA_BATCH_PAYMENT_TRANSACTION_TOO_LARGE', { bytes: 65 + big.length, limit: 1136 }]);
    const locks = serializeMessageV0({ header: [1, 0, 0], staticKeys: [owner], blockhash: keys[0]!, instructions: [],
      lookups: [{ table: keys[1]!, writable: Array.from({ length: 64 }, (_, i) => i), readonly: [] }] });
    expect(() => solanaBatchPaymentStaticBounds({ legs: legs(2), token: null }, { recipients: recipients(2) }, locks)).toThrow('SOLANA_BATCH_PAYMENT_TOO_MANY_ACCOUNTS');
    const small = serializeMessageV0({ header: [1, 0, 0], staticKeys: [owner], blockhash: keys[0]!, instructions: [], lookups: [] });
    const spl = { mint: USDC.mint, decimals: 6, program: 'spl-token' as const };
    expect(solanaBatchPaymentStaticBounds({ legs: legs(9), token: spl }, { recipients: recipients(9) }, small).instructionTraceBound).toBe(64);
    expect(() => solanaBatchPaymentStaticBounds({ legs: legs(10), token: spl }, { recipients: recipients(10) }, small)).toThrow('SOLANA_BATCH_PAYMENT_INSTRUCTION_TRACE_TOO_LONG');
    expect(() => solanaBatchPaymentStaticBounds({ legs: legs(2), token: null }, { recipients: recipients(3) }, small)).toThrow('SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH');
  });
});

describe('KAN-20 refusals the simulation itself raises (rent, fee, exact deltas) and the exact SPL worst-case boundary', () => {
  /** The mocked cluster's RPC with one method's answer changed (an RPC or simulator that disagrees with the reviewed facts). */
  const wrapped = (rpc: SolanaRpc, method: string, change: (value: unknown, params: readonly unknown[], call: number) => unknown): SolanaRpc => {
    let calls = 0;
    return async (m, params) => { const value = await rpc(m, params); return m === method ? change(value, params, ++calls) : value; };
  };
  /** A simulation whose watched account `index` is changed: its lamports by `lamports`, a token account's amount by `amount`. */
  const simulated = (rpc: SolanaRpc, index: number, delta: { lamports?: bigint; amount?: bigint }) => wrapped(rpc, 'simulateTransaction', value => {
    const v = JSON.parse(JSON.stringify(value)) as { value: { accounts: { lamports: number; data: [string, string] }[] } };
    const account = v.value.accounts[index]!;
    if (delta.lamports) account.lamports = Number(BigInt(account.lamports) + delta.lamports);
    if (delta.amount) {
      const data = fromBase64(account.data[0], 4096), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      view.setBigUint64(64, view.getBigUint64(64, true) + delta.amount, true);
      account.data = [toBase64(data), 'base64'];
    }
    return v;
  });

  it('ACCOUNT_RENT_MISMATCH: a created token account whose deposit is not the rent of its size, or a rent the RPC cannot give, names the recipient', async () => {
    const { chain, owner, wallets } = setup(3);
    chain.fundToken(owner.owner, USDC.mint, 50_000_000n);
    chain.fundToken(wallets[0]!, USDC.mint, 0n);
    const batch = workflow(lines(wallets, () => '1000000'), SPL_USDC);
    // The first 165-byte rent answer prices the pre-simulation bound; the second is the simulated account's own size, asked once per size.
    const off = await rejection(simulateSolanaBatchPayment(batch, owner.owner, wrapped(chain.rpc, 'getMinimumBalanceForRentExemption',
      (v, params, call) => Number(params[0]) === 165 && call > 2 ? Number(v) + 1 : v), NOW));
    expect([off.message, off.cause]).toEqual(['SOLANA_BATCH_PAYMENT_ACCOUNT_RENT_MISMATCH', { recipient: 1 }]);
    const none = await rejection(simulateSolanaBatchPayment(batch, owner.owner, wrapped(chain.rpc, 'getMinimumBalanceForRentExemption',
      (v, params, call) => Number(params[0]) === 165 && call > 2 ? 0 : v), NOW));
    expect([none.message, none.cause]).toEqual(['SOLANA_BATCH_PAYMENT_ACCOUNT_RENT_MISMATCH', { recipient: 0 }]);
    await expect(simulateSolanaBatchPayment(batch, owner.owner, chain.rpc, NOW)).resolves.toMatchObject({ accountCreationLamports: String(2n * MOCKED_RENT.token) });
  });

  it('FEE_UNAVAILABLE: the cluster cannot price the exact message (an unusable blockhash), so nothing is reviewed', async () => {
    const { chain, owner, wallets } = setup(2);
    for (const value of [null, 0, -1, 1.5]) {
      const error = await rejection(simulateSolanaBatchPayment(workflow(lines(wallets)), owner.owner,
        wrapped(chain.rpc, 'getFeeForMessage', v => ({ ...(v as Record<string, unknown>), value })), NOW));
      expect(error.message, String(value)).toBe('SOLANA_BATCH_PAYMENT_FEE_UNAVAILABLE');
    }
  });

  it('SIMULATED_TRANSFER_MISMATCH: any simulated delta other than exactly reviewed (a recipient, the owner, the source, a destination, a recipient wallet)', async () => {
    const sol = setup(3);
    sol.wallets.forEach(w => sol.chain.fundWallet(w, 5_000_000n));
    const solBatch = workflow(lines(sol.wallets));
    // Watched: [owner, recipient 0..N-1] for SOL; then [source, destination 0..N-1] for SPL.
    const recipient = await rejection(simulateSolanaBatchPayment(solBatch, sol.owner.owner, simulated(sol.chain.rpc, 2, { lamports: -1n }), NOW));
    expect([recipient.message, recipient.cause]).toEqual(['SOLANA_BATCH_PAYMENT_SIMULATED_TRANSFER_MISMATCH', { recipient: 1 }]);
    const ownerDebit = await rejection(simulateSolanaBatchPayment(solBatch, sol.owner.owner, simulated(sol.chain.rpc, 0, { lamports: -1n }), NOW));
    expect(ownerDebit.message).toBe('SOLANA_BATCH_PAYMENT_SIMULATED_TRANSFER_MISMATCH');
    expect(ownerDebit.cause).toMatchObject({ account: 'OWNER' });
    const spl = setup(3);
    spl.chain.fundToken(spl.owner.owner, USDC.mint, 50_000_000n);
    spl.wallets.forEach(w => spl.chain.fundWallet(w, 5_000_000n));
    const splBatch = workflow(lines(spl.wallets, () => '1000000'), SPL_USDC), n = 3;
    const cases: [string, number, { lamports?: bigint; amount?: bigint }, Record<string, unknown>][] = [
      ['the source paid one unit less', 1 + n, { amount: 1n }, { account: 'SOURCE' }],
      ['a destination received one unit less', 2 + n + 2, { amount: -1n }, { recipient: 2 }],
      ['a recipient wallet\'s SOL moved', 1 + 1, { lamports: 1n }, { recipient: 1, account: 'WALLET' }],
      ['the owner paid more SOL than the created deposits and the fee', 0, { lamports: -1n }, { account: 'OWNER' }]];
    for (const [label, index, delta, cause] of cases) {
      const error = await rejection(simulateSolanaBatchPayment(splBatch, spl.owner.owner, simulated(spl.chain.rpc, index, delta), NOW));
      expect(error.message, label).toBe('SOLANA_BATCH_PAYMENT_SIMULATED_TRANSFER_MISMATCH');
      expect(error.cause, label).toMatchObject(cause);
    }
    await expect(simulateSolanaBatchPayment(splBatch, spl.owner.owner, spl.chain.rpc, NOW)).resolves.toBeTruthy();
  });

  it('DUPLICATE_RECIPIENT: refused by the declaration first, and by the compiler\'s own check behind it (with the recipient index)', async () => {
    const { owner, wallets } = setup(3);
    const duplicate = [...lines(wallets.slice(0, 2)), { recipient: wallets[0]!, amount: '5' }];
    // A declaration can never carry it: the contracts refuse the node (exact string comparison, never merged).
    expect(() => createSolanaBatchPaymentNode('node-002', { chain: CHAIN, asset: { kind: 'NATIVE' }, payments: duplicate })).toThrow('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    // Defence in depth: should the reader ever let it through, the compiler refuses it on the canonical keys.
    reader.fields = { chain: CHAIN, asset: { kind: 'NATIVE' }, payments: duplicate };
    try {
      const error = syncRejection(() => solanaBatchPaymentIntent(workflow(lines(wallets)), owner.owner));
      expect([error.message, error.cause]).toEqual(['SOLANA_BATCH_PAYMENT_DUPLICATE_RECIPIENT', { recipient: 2 }]);
    } finally { reader.fields = null; }
    expect(solanaBatchPaymentIntent(workflow(lines(wallets)), owner.owner).legs).toHaveLength(3);
  });

  it('SPL exact worst-case boundary: the owner\'s SOL must cover the fee, a deposit for EVERY recipient (even existing ATAs) and its reserve, to the lamport', async () => {
    const { chain, owner, wallets } = setup(3);
    chain.fundToken(owner.owner, USDC.mint, 50_000_000n);
    // Two ATAs exist, one is missing: only one deposit is charged now, yet each may be recreated before execution.
    chain.fundToken(wallets[0]!, USDC.mint, 0n); chain.fundToken(wallets[2]!, USDC.mint, 0n);
    const batch = workflow(lines(wallets, () => '1000000'), SPL_USDC);
    const priced = await simulateSolanaBatchPayment(batch, owner.owner, chain.rpc, NOW);
    expect(priced.accountCreationLamports).toBe(String(MOCKED_RENT.token));
    const fee = BigInt(priced.estimatedFeeLamports), deposits = 3n * MOCKED_RENT.token, required = fee + deposits + MOCKED_RENT.system;
    expect(priced.requiredLamports).toBe(required.toString());
    chain.fundWallet(owner.owner, required - 1n);
    const short = await rejection(simulateSolanaBatchPayment(batch, owner.owner, chain.rpc, NOW));
    expect(short.message).toBe('SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL');
    expect(short.cause).toEqual({ unit: 'lamports', balance: (required - 1n).toString(), fee: fee.toString(), deposits: deposits.toString(), maxFee: (fee + deposits).toString(),
      nativeSpend: '0', reserve: String(MOCKED_RENT.system), required: required.toString(), shortfall: '1', exact: true });
    chain.fundWallet(owner.owner, required);
    const exact = await simulateSolanaBatchPayment(batch, owner.owner, chain.rpc, NOW);
    expect(exact).toMatchObject({ requiredLamports: required.toString(), maximumAccountCreationLamports: deposits.toString(), accountCreationLamports: String(MOCKED_RENT.token) });
    // Exactly enough is enough: it lands, and the owner keeps at least its reserve plus the deposits it did not need.
    await chain.rpc('sendTransaction', [verifySignedSolanaBatchPayment(exact, owner.sign(exact.unsignedTransaction)).transaction, { encoding: 'base64' }]);
    expect(chain.lamports(owner.owner)).toBe(required - fee - MOCKED_RENT.token);
    expect(chain.lamports(owner.owner)).toBeGreaterThanOrEqual(MOCKED_RENT.system);
  });
});
