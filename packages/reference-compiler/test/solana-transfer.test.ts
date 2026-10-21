// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createSolanaTransferNode, type SemanticWorkflow, type SolanaTransferToken } from '@defi-workflow-engine/workflow-contracts';
import { SOLANA_DEVNET_TRANSFER, SOLANA_MAINNET_TRANSFER, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { decompileMessageV0, findProgramAddress, fromBase64, parseMessageV0, parseTransaction, toBase64, serializeTransaction } from '../src/solana.js';
import { createMockedSolanaWallet } from '../src/jupiter-mock.js';
import { createMockedSolanaTransferChain, MOCKED_RENT } from '../src/solana-transfer-mock.js';
import { assertSolanaTransferReview, simulateSolanaTransfer, solanaTransferIntent, verifySignedSolanaTransfer } from '../src/solana-transfer.js';

/** MOCKED engine certification: every value comes from the deterministic in-memory cluster; nothing reaches a public network. */
const P = SOLANA_MAINNET_TRANSFER.programs, USDC = SOLANA_MAINNET_TOKENS.USDC, USDT = SOLANA_MAINNET_TOKENS.USDT;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const usdc: SolanaTransferToken = { mint: USDC.mint, decimals: 6, program: 'spl-token' };
function workflow(recipient: string, amount: string, token: SolanaTransferToken | null = null, chain = SOLANA_MAINNET_TRANSFER.chain): SemanticWorkflow {
  return { schemaVersion: '1.0.0', workflowId: 'workflow-transfer', revision: 1, resourceEdges: [], nodes: [createSolanaTransferNode('node-002', { chain, amount, recipient, token })] };
}
function setup(options: Parameters<typeof createMockedSolanaTransferChain>[0] = {}) {
  const chain = createMockedSolanaTransferChain(options), owner = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
  chain.fundWallet(owner.owner, 2_000_000_000n);
  chain.createMint(USDC.mint, { decimals: 6 }); chain.createMint(USDT.mint, { decimals: 6 });
  return { chain, owner, recipient };
}
const instructionsOf = (unsigned: string) => decompileMessageV0(parseMessageV0(parseTransaction(fromBase64(unsigned, 2048)).message), {});

describe('Solana transfer intent', () => {
  it('requires an explicit recipient that is a wallet key and never the sender', () => {
    const { owner, recipient } = setup();
    expect(solanaTransferIntent(workflow(recipient, '1000'), owner.owner)).toMatchObject({ owner: owner.owner, recipient, amount: '1000' });
    expect(() => solanaTransferIntent(workflow(owner.owner, '1000'), owner.owner)).toThrow('SOLANA_TRANSFER_RECIPIENT_IS_SENDER');
    const pda = findProgramAddress([new TextEncoder().encode('vault')], P.system);
    expect(() => solanaTransferIntent(workflow(pda, '1000'), owner.owner)).toThrow('SOLANA_TRANSFER_RECIPIENT_OFF_CURVE');
    expect(() => solanaTransferIntent(workflow('z'.repeat(44), '1000'), owner.owner)).toThrow('SOLANA_TRANSFER_RECIPIENT_INVALID');
    expect(() => createSolanaTransferNode('n', { chain: SOLANA_MAINNET_TRANSFER.chain, amount: '1', recipient: '0xabc', token: null })).toThrow('SOLANA_TRANSFER_FIELDS_INVALID');
  });
  it('binds a verified token by mint, decimals and program and refuses wrapped SOL', () => {
    const { owner, recipient } = setup();
    expect(() => solanaTransferIntent(workflow(recipient, '1', { ...usdc, decimals: 9 }), owner.owner)).toThrow('SOLANA_TRANSFER_MINT_DECIMALS_MISMATCH');
    expect(() => solanaTransferIntent(workflow(recipient, '1', { ...usdc, program: 'token-2022' }), owner.owner)).toThrow('SOLANA_TRANSFER_MINT_DECIMALS_MISMATCH');
    expect(() => solanaTransferIntent(workflow(recipient, '1', { mint: 'So11111111111111111111111111111111111111112', decimals: 9, program: 'spl-token' }), owner.owner))
      .toThrow('SOLANA_TRANSFER_WRAPPED_SOL_UNSUPPORTED');
  });
});

describe('native SOL transfer', () => {
  it('simulates the exact System transfer to another wallet and binds fees, reserve and the message', async () => {
    const { chain, owner, recipient } = setup(); chain.fundWallet(recipient, 5_000_000n);
    const review = await simulateSolanaTransfer(workflow(recipient, '100000000'), owner.owner, chain.rpc, NOW);
    expect(review).toMatchObject({ format: 'gryloo.solana-transfer-review.v1', owner: owner.owner, recipient, amount: '100000000', cluster: 'mainnet-beta',
      asset: { symbol: 'SOL', mint: null, decimals: 9, program: 'native' }, token: null, accountCreationLamports: '0', computeUnitPrice: '200000' });
    const ixs = instructionsOf(review.unsignedTransaction);
    expect(ixs.map(ix => ix.programId)).toEqual([P.computeBudget, P.computeBudget, P.system]);
    expect(Buffer.from(ixs[2]!.data).toString('hex')).toBe('02000000' + '00e1f50500000000');
    expect(BigInt(review.estimatedFeeLamports)).toBe(5000n + (BigInt(review.computeUnitLimit) * 200_000n + 999_999n) / 1_000_000n);
    expect(review.policy.allowlists.recipients).toEqual([{ chainId: SOLANA_MAINNET_TRANSFER.chain, address: recipient }]);
    expect(review.manifest.spendLimits[0]).toMatchObject({ asset: { nativeId: 'SOL', decimals: 9 }, maximumAmount: '100000000' });
    expect(review.plan.segments[0]!.steps[0]!.payloadHash).toBe(review.messageHash);
    expect(() => assertSolanaTransferReview(review, review.workflow, owner.owner, chain.state.blockHeight, NOW + 1000)).not.toThrow();
    const signed = owner.sign(review.unsignedTransaction);
    expect(verifySignedSolanaTransfer(review, signed).transaction).toBe(signed);
  });
  it('creates a new recipient account only with a rent-exempt amount', async () => {
    const { chain, owner, recipient } = setup();
    await expect(simulateSolanaTransfer(workflow(recipient, String(MOCKED_RENT.system - 1n)), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_AMOUNT_BELOW_RENT_EXEMPT');
    await expect(simulateSolanaTransfer(workflow(recipient, String(MOCKED_RENT.system)), owner.owner, chain.rpc, NOW)).resolves.toMatchObject({ state: { recipientExists: false } });
  });
  it('keeps the owner rent-exempt after the amount and the fee', async () => {
    const { chain, owner, recipient } = setup(); chain.fundWallet(recipient, 5_000_000n);
    await expect(simulateSolanaTransfer(workflow(recipient, String(2_000_000_000n - MOCKED_RENT.system)), owner.owner, chain.rpc, NOW)).rejects.toThrow(/SOLANA_TRANSFER_(INSUFFICIENT_SOL|SIMULATION_FAILED)/);
    await expect(simulateSolanaTransfer(workflow(recipient, String(2_000_000_000n - MOCKED_RENT.system - 20_000n)), owner.owner, chain.rpc, NOW)).resolves.toBeTruthy();
  });
  it('tolerates a simulator that does not debit the fee, never any other difference', async () => {
    const { chain, owner, recipient } = setup({ simulateWithoutFee: true }); chain.fundWallet(recipient, 5_000_000n);
    await expect(simulateSolanaTransfer(workflow(recipient, '1000000'), owner.owner, chain.rpc, NOW)).resolves.toBeTruthy();
  });
  it('refuses recipients that are not wallets', async () => {
    const { chain, owner, recipient } = setup();
    const tokenAccount = chain.fundToken(recipient, USDC.mint, 1n);
    // The token account key is a PDA (off curve), so it is refused before any chain read; a program-owned data account is refused at Simulate.
    await expect(simulateSolanaTransfer(workflow(tokenAccount, '1000000'), owner.owner, chain.rpc, NOW)).rejects.toThrow(/SOLANA_TRANSFER_RECIPIENT_(OFF_CURVE|IS_TOKEN_ACCOUNT)/);
    const nonce = createMockedSolanaWallet().owner; chain.systemAccountWithData(nonce, 80, 1_447_680n);
    await expect(simulateSolanaTransfer(workflow(nonce, '1000000'), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_RECIPIENT_NOT_WALLET');
    const program = createMockedSolanaWallet().owner; chain.markProgram(program);
    await expect(simulateSolanaTransfer(workflow(program, '1000000'), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_RECIPIENT_NOT_WALLET');
  });
  it('fails closed on the wrong cluster', async () => {
    const { chain, owner, recipient } = setup({ genesisHash: SOLANA_DEVNET_TRANSFER.genesisHash });
    await expect(simulateSolanaTransfer(workflow(recipient, '1000000'), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_WRONG_CLUSTER');
  });
});

describe('SPL token transfer', () => {
  it('atomically checks an existing recipient ATA before transferring USDC with TransferChecked', async () => {
    const { chain, owner, recipient } = setup();
    chain.fundToken(owner.owner, USDC.mint, 50_000_000n); const destination = chain.fundToken(recipient, USDC.mint, 7n);
    const review = await simulateSolanaTransfer(workflow(recipient, '12500000', usdc), owner.owner, chain.rpc, NOW);
    expect(review.token).toMatchObject({ program: 'spl-token', programId: P.token, mint: USDC.mint, decimals: 6, symbol: 'USDC', verified: true,
      destinationAccount: destination, destinationAmount: '7', createDestination: false, extensions: [] });
    const ixs = instructionsOf(review.unsignedTransaction);
    expect(ixs.map(ix => ix.programId)).toEqual([P.computeBudget, P.computeBudget, P.associatedToken, P.token]);
    expect(ixs[3]!.data[0]).toBe(12); expect(ixs[3]!.data[9]).toBe(6);
    expect(ixs[3]!.accounts.map(a => a.pubkey)).toEqual([chain.ata(owner.owner, USDC.mint), USDC.mint, destination, owner.owner]);
    expect(review.maximumAccountCreationLamports).toBe(String(MOCKED_RENT.token));
    expect(BigInt(review.maximumNetworkCostLamports)).toBe(BigInt(review.estimatedFeeLamports) + MOCKED_RENT.token);
    expect(review).toMatchObject({ accountCreationLamports: '0', simulationResult: { sourceAmountAfter: '37500000', destinationAmountAfter: '12500007' } });
  });
  it('creates the recipient Associated Token Account idempotently and bounds its deposit (USDT)', async () => {
    const { chain, owner, recipient } = setup();
    chain.fundToken(owner.owner, USDT.mint, 9_000_000n);
    const review = await simulateSolanaTransfer(workflow(recipient, '9000000', { mint: USDT.mint, decimals: 6, program: 'spl-token' }), owner.owner, chain.rpc, NOW);
    expect(review.token).toMatchObject({ createDestination: true, destinationAmount: null, symbol: 'USDT' });
    expect(review.accountCreationLamports).toBe(String(MOCKED_RENT.token));
    expect(BigInt(review.maximumNetworkCostLamports)).toBe(BigInt(review.estimatedFeeLamports) + MOCKED_RENT.token);
    expect(instructionsOf(review.unsignedTransaction).map(ix => ix.programId)).toEqual([P.computeBudget, P.computeBudget, P.associatedToken, P.token]);
  });
  it('refuses insufficient tokens, a missing source account and SOL that cannot cover fee, deposit and reserve', async () => {
    const { chain, owner, recipient } = setup();
    await expect(simulateSolanaTransfer(workflow(recipient, '1', usdc), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_INSUFFICIENT_TOKEN_BALANCE');
    chain.fundToken(owner.owner, USDC.mint, 5n);
    await expect(simulateSolanaTransfer(workflow(recipient, '6', usdc), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_INSUFFICIENT_TOKEN_BALANCE');
    chain.fundWallet(owner.owner, MOCKED_RENT.system + 10_000n);
    await expect(simulateSolanaTransfer(workflow(recipient, '5', usdc), owner.owner, chain.rpc, NOW)).rejects.toThrow(/SOLANA_TRANSFER_(INSUFFICIENT_SOL|SIMULATION_FAILED)/);
  });
  it('verifies the mint on chain: program, decimals and initialization', async () => {
    const { chain, owner, recipient } = setup();
    const other = createMockedSolanaWallet().owner; chain.createMint(other, { decimals: 9 }); chain.fundToken(owner.owner, other, 100n);
    await expect(simulateSolanaTransfer(workflow(recipient, '1', { mint: other, decimals: 6, program: 'spl-token' }), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_MINT_DECIMALS_MISMATCH');
    await expect(simulateSolanaTransfer(workflow(recipient, '1', { mint: other, decimals: 9, program: 'token-2022' }), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_TOKEN_PROGRAM_MISMATCH');
    const absent = createMockedSolanaWallet().owner;
    await expect(simulateSolanaTransfer(workflow(recipient, '1', { mint: absent, decimals: 6, program: 'spl-token' }), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_MINT_NOT_FOUND');
    await expect(simulateSolanaTransfer(workflow(recipient, '1', { mint: other, decimals: 9, program: 'spl-token' }), owner.owner, chain.rpc, NOW))
      .resolves.toMatchObject({ asset: { symbol: 'SPL token', verified: false } });
  });
  it('refuses a recipient token account whose owner was reassigned or that is frozen', async () => {
    const { chain, owner, recipient } = setup(); chain.fundToken(owner.owner, USDC.mint, 10n);
    chain.fundToken(recipient, USDC.mint, 0n, { tokenOwner: createMockedSolanaWallet().owner });
    await expect(simulateSolanaTransfer(workflow(recipient, '1', usdc), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_DESTINATION_OWNER_MISMATCH');
    chain.fundToken(recipient, USDC.mint, 0n, { state: 2 });
    await expect(simulateSolanaTransfer(workflow(recipient, '1', usdc), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_TOKEN_ACCOUNT_FROZEN');
  });
});

describe('Token-2022', () => {
  const ext = (type: number, value: number[] | Uint8Array = []) => ({ type, value: Uint8Array.from(value) });
  const zeroFee = () => ext(1, new Array(108).fill(0));
  function t22(extensions: { type: number; value: Uint8Array }[]) {
    const env = setup(), mint = createMockedSolanaWallet().owner;
    env.chain.createMint(mint, { decimals: 6, program: 'token-2022', extensions }); env.chain.fundToken(env.owner.owner, mint, 1_000_000n);
    return { ...env, mint, token: { mint, decimals: 6, program: 'token-2022' as const } };
  }
  it('accepts metadata pointers, metadata and a transfer fee configured to zero, creating an ImmutableOwner ATA', async () => {
    const { chain, owner, recipient, token } = t22([ext(18, new Array(64).fill(0)), ext(19, [1, 2, 3]), zeroFee()]);
    const review = await simulateSolanaTransfer(workflow(recipient, '250000', token), owner.owner, chain.rpc, NOW);
    expect(review.token).toMatchObject({ program: 'token-2022', programId: P.token2022, extensions: [18, 19, 1], createDestination: true });
    expect(review.accountCreationLamports).toBe(String(MOCKED_RENT.token2022));
  });
  it.each([
    ['a permanent delegate', [ext(12, new Array(32).fill(1))]],
    ['confidential transfers', [ext(4, new Array(65).fill(0))]],
    ['a non-transferable mint', [ext(9)]],
    ['a non-zero transfer fee', [ext(1, [...new Array(88).fill(0), 50, 0, ...new Array(18).fill(0)])]],
    ['a mutable zero transfer fee', [ext(1, [1, ...new Array(107).fill(0)])]],
    ['a transfer hook program', [ext(14, [...new Array(32).fill(0), ...new Array(32).fill(7)])]],
    ['a mutable disabled transfer hook', [ext(14, [...new Array(32).fill(7), ...new Array(32).fill(0)])]],
    ['a frozen default account state', [ext(6, [2])]],
    ['an unknown extension', [ext(99, [1])]],
  ])('refuses %s before any wallet request', async (_name, extensions) => {
    const { chain, owner, recipient, token } = t22(extensions);
    await expect(simulateSolanaTransfer(workflow(recipient, '1', token), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_TOKEN_EXTENSION_UNSUPPORTED');
  });
  it('refuses a recipient account that requires incoming memos', async () => {
    const { chain, owner, recipient, token, mint } = t22([]);
    chain.fundToken(recipient, mint, 0n, { extensions: [ext(7), ext(8, [1])] });
    await expect(simulateSolanaTransfer(workflow(recipient, '1', token), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_RECIPIENT_MEMO_EXTENSION_UNSUPPORTED');
  });
  it.each([ext(2, [0]), ext(7, [0]), ext(8), ext(11, [2]), ext(15, [1])])('refuses malformed or active token-account extension %s', async extension => {
    const { chain, owner, recipient, token, mint } = t22([]);
    chain.fundToken(recipient, mint, 0n, { extensions: [extension] });
    await expect(simulateSolanaTransfer(workflow(recipient, '1', token), owner.owner, chain.rpc, NOW)).rejects.toThrow('SOLANA_TRANSFER_TOKEN_EXTENSION_UNSUPPORTED');
  });
});

describe('Review and wallet integrity', () => {
  it('prices the exact compiled message through the cluster and refuses unavailable fee data', async () => {
    const { chain, owner, recipient } = setup({ simulateWithoutFee: true }); chain.fundWallet(recipient, 1_000_000n);
    const seen: unknown[] = [];
    const rpc: typeof chain.rpc = async (method, params) => { if (method === 'getFeeForMessage') { seen.push(params[0]); return { value: 12_345, context: { slot: chain.state.slot } }; } return chain.rpc(method, params); };
    const review = await simulateSolanaTransfer(workflow(recipient, '1000000'), owner.owner, rpc, NOW);
    expect(seen).toEqual([review.message]); expect(review.estimatedFeeLamports).toBe('12345');
    await expect(simulateSolanaTransfer(workflow(recipient, '1000000'), owner.owner,
      async (method, params) => method === 'getFeeForMessage' ? { value: null } : chain.rpc(method, params), NOW)).rejects.toThrow('SOLANA_TRANSFER_FEE_UNAVAILABLE');
  });
  it('resolves a funded sender account when the ATA cannot cover the transfer, and binds its actual address', async () => {
    const { chain, owner, recipient } = setup();
    chain.fundToken(owner.owner, USDC.mint, 1n);
    const source = createMockedSolanaWallet().owner;
    chain.fundToken(owner.owner, USDC.mint, 5_000_000n, { at: source });
    const review = await simulateSolanaTransfer(workflow(recipient, '2000000', usdc), owner.owner, chain.rpc, NOW);
    expect(review.token).toMatchObject({ sourceAccount: source, sourceAmount: '5000000' });
    expect(instructionsOf(review.unsignedTransaction).at(-1)?.accounts[0]?.pubkey).toBe(source);
  });
  it('refuses the wrong wallet, an expired blockhash or clock, a changed workflow and changed bytes', async () => {
    const { chain, owner, recipient } = setup(); chain.fundWallet(recipient, 5_000_000n);
    const review = await simulateSolanaTransfer(workflow(recipient, '1000000'), owner.owner, chain.rpc, NOW);
    expect(() => assertSolanaTransferReview(review, review.workflow, recipient, chain.state.blockHeight, NOW)).toThrow('SOLANA_TRANSFER_WRONG_OWNER');
    expect(() => assertSolanaTransferReview(review, review.workflow, owner.owner, review.lastValidBlockHeight - 20, NOW)).toThrow('SOLANA_TRANSFER_REVIEW_EXPIRED');
    expect(() => assertSolanaTransferReview(review, review.workflow, owner.owner, chain.state.blockHeight, NOW + 61_000)).toThrow('SOLANA_TRANSFER_REVIEW_EXPIRED');
    expect(() => assertSolanaTransferReview(review, workflow(recipient, '1000001'), owner.owner, chain.state.blockHeight, NOW)).toThrow('SOLANA_TRANSFER_SEMANTIC_REVISION_CHANGED');
    expect(() => assertSolanaTransferReview({ ...review, amount: '2' }, review.workflow, owner.owner, chain.state.blockHeight, NOW)).toThrow('SOLANA_TRANSFER_AUTHORIZATION_INVALID');
    // A wallet that rewrites the reviewed message (e.g. adds its own priority fee) or signs as someone else is refused before broadcast.
    const other = createMockedSolanaWallet();
    expect(() => verifySignedSolanaTransfer(review, other.sign(review.unsignedTransaction))).toThrow('SOLANA_TRANSFER_SIGNATURE_INVALID');
    const message = parseTransaction(fromBase64(review.unsignedTransaction, 2048)).message; message[message.length - 1] ^= 1;
    expect(() => verifySignedSolanaTransfer(review, owner.sign(toBase64(serializeTransaction(null, message))))).toThrow('SOLANA_TRANSFER_TRANSACTION_CHANGED');
  });
  it('uses the Devnet profile on Devnet, with its own priority fee and explorer', async () => {
    const chain = createMockedSolanaTransferChain({ profile: SOLANA_DEVNET_TRANSFER }), owner = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
    chain.fundWallet(owner.owner, 2_000_000_000n); chain.fundWallet(recipient, 1_000_000n);
    const review = await simulateSolanaTransfer(workflow(recipient, '5000000', null, SOLANA_DEVNET_TRANSFER.chain), owner.owner, chain.rpc, NOW);
    expect(review).toMatchObject({ cluster: 'devnet', network: 'Solana Devnet', computeUnitPrice: '100000' });
    expect(SOLANA_DEVNET_TRANSFER.explorerTx('sig')).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
  });
});
