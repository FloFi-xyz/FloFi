// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ADR-0010 §4 (BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003): the Solana transfer flow with Pimlico's Kora fee payer, end to end on the MOCKED loopback
 * transfer cluster and the loopback Kora JSON-RPC double. Nothing reaches a provider or mainnet; nothing here is mainnet evidence.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileMessageV0, createMockedSolanaTransferChain, createMockedSolanaWallet, fromBase64, parseTransaction, serializeMessageV0, serializeTransaction, toBase64,
  SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER, SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/reference-compiler';
import { createSolanaTransferNode, type SemanticWorkflow, type SolanaTransferToken } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaTransferService } from './solana-transfer-service';
import { koraGasFromEnv } from '../gas-abstraction/kora/runtime';
import { startKoraDouble, type KoraDouble } from '../test-utils/kora-double';

const T = SOLANA_MAINNET_TOKENS, usdc: SolanaTransferToken = { mint: T.USDC.mint, decimals: 6, program: 'spl-token' };
const workflow = (recipient: string, amount: string, token: SolanaTransferToken | null = usdc, chain = SOLANA_MAINNET_TRANSFER.chain): SemanticWorkflow =>
  ({ schemaVersion: '1.0.0', workflowId: 'workflow-transfer-kora', revision: 1, resourceEdges: [], nodes: [createSolanaTransferNode('node-002', { chain, amount, recipient, token })] });
const doubles: KoraDouble[] = [];
afterEach(async () => { while (doubles.length) await doubles.pop()!.close(); });

async function setup(input: { ownerLamports?: bigint; recipientAccount: boolean; usdc?: bigint }) {
  const chain = createMockedSolanaTransferChain(), owner = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
  chain.createMint(T.USDC.mint, { decimals: 6 }); chain.createMint(T.USDT.mint, { decimals: 6 });
  const double = await startKoraDouble({ rpc: chain.rpc, tokens: [{ mint: T.USDC.mint, decimals: 6 }, { mint: T.USDT.mint, decimals: 6 }] });
  doubles.push(double);
  chain.fundWallet(double.signer, 5_000_000_000n); chain.fundToken(double.payment, T.USDC.mint, 0n); chain.fundToken(double.payment, T.USDT.mint, 0n);
  if (input.ownerLamports !== undefined) chain.fundWallet(owner.owner, input.ownerLamports);
  chain.fundToken(owner.owner, T.USDC.mint, input.usdc ?? 50_000_000n);
  if (input.recipientAccount) chain.fundToken(recipient, T.USDC.mint, 7n);
  const kora = koraGasFromEnv({ FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: double.url, FLOFI_KORA_SIGNER: double.signer, FLOFI_KORA_PAYMENT_ADDRESS: double.payment });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-transfer-kora-'));
  const now = () => Date.parse('2026-11-13T12:00:00.000Z');
  const service = createSolanaTransferService({ profile: SOLANA_MAINNET_TRANSFER, rpc: chain.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now, kora });
  return { chain, owner, recipient, double, service, kora };
}
async function run(s: Awaited<ReturnType<typeof setup>>, wf: SemanticWorkflow) {
  const simulated = await s.service.simulate(wf, s.owner.owner);
  const reviewed = await s.service.review(simulated.id, simulated.review.commitment, wf);
  const begin = await s.service.begin(reviewed.id, s.owner.owner, wf);
  const submitted = await s.service.submit(reviewed.id, s.owner.sign(begin.unsignedTransaction));
  return { review: reviewed.review, submitted, observed: await s.service.observe(reviewed.id) };
}

describe('Solana transfer with Pimlico Kora (MOCKED loopback, ADR-0010 §4)', () => {
  it('sends USDC for an owner with no SOL account, to a recipient with and without a token account (Kora advances the rent)', async () => {
    for (const recipientAccount of [true, false]) {
      const s = await setup({ recipientAccount });
      const { review, submitted, observed } = await run(s, workflow(s.recipient, '12000000'));
      expect(review.gas).toMatchObject({ token: { symbol: 'USDC' }, feePayer: s.double.signer });
      expect(review.token?.createDestination).toBe(!recipientAccount);
      expect(parseTransaction(fromBase64(review.unsignedTransaction, 2048)).signatures).toHaveLength(2);
      expect(submitted.attempt).toMatchObject({ state: 'PENDING' });
      expect(observed).toMatchObject({ verdict: 'RECONCILED' });
      const o = observed.observations.at(-1)!;
      expect(o).toMatchObject({ amountSent: '12000000', amountReceived: '12000000', accountCreationLamports: '0',
        tokenFee: { amount: review.gas!.amount, payee: s.double.payment } });
      expect(s.chain.lamports(s.owner.owner)).toBe(0n);
      expect(s.chain.tokenAccount(s.double.paymentAccount(T.USDC.mint))?.amount).toBe(BigInt(review.gas!.amount));
      expect(s.double.state.unpaid).toBe(0);
    }
  });
  it('keeps the native transfer for an owner with SOL (Kora never contacted)', async () => {
    const s = await setup({ ownerLamports: 2_000_000_000n, recipientAccount: true });
    const { review, observed } = await run(s, workflow(s.recipient, '1000000'));
    expect(review.gas).toBeUndefined();
    expect(observed.verdict).toBe('RECONCILED');
    expect(s.double.state.calls).toEqual([]);
  });
  it('transfers a Token-2022 token paying the fee in USDC', async () => {
    const s = await setup({ recipientAccount: false });
    const mint = createMockedSolanaWallet().owner;
    s.chain.createMint(mint, { decimals: 6, program: 'token-2022' }); s.chain.fundToken(s.owner.owner, mint, 1_000_000n);
    const { review, observed } = await run(s, workflow(s.recipient, '250000', { mint, decimals: 6, program: 'token-2022' }));
    expect(review.gas?.token.symbol).toBe('USDC');
    expect(observed).toMatchObject({ verdict: 'RECONCILED' });
  });
  it('refuses a SOL transfer and Devnet in Kora mode, and an owner without the fee', async () => {
    const s = await setup({ recipientAccount: true, usdc: 12_000_000n });
    await expect(s.service.simulate(workflow(s.recipient, '12000000'), s.owner.owner)).rejects.toThrow('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT');
    await expect(s.service.simulate(workflow(s.recipient, '1000000', null), s.owner.owner)).rejects.toThrow('KORA_OPERATION_UNSUPPORTED');
    const devnet = createSolanaTransferService({ profile: SOLANA_DEVNET_TRANSFER, rpc: createMockedSolanaTransferChain({ profile: SOLANA_DEVNET_TRANSFER }).rpc,
      journalDir: await mkdtemp(join(tmpdir(), 'flofi-transfer-kora-devnet-')), provenance: 'MOCKED', executionEnabled: true, kora: s.kora });
    await expect(devnet.simulate(workflow(s.recipient, '1000', null, SOLANA_DEVNET_TRANSFER.chain), s.owner.owner)).rejects.toThrow('SOLANA_TRANSFER_OWNER_NOT_WALLET');
    expect(s.double.state.signed).toEqual([]);
  });
  // K1: an HTTP-level failure after Kora signed proves nothing; the transfer is observed and recovered, never recorded as not executed.
  it('a gateway 504 after Kora signed and broadcast: the transfer is observed and reconciles', async () => {
    const s = await setup({ recipientAccount: true });
    const wf = workflow(s.recipient, '12000000');
    const simulated = await s.service.simulate(wf, s.owner.owner);
    await s.service.review(simulated.id, simulated.review.commitment, wf);
    const begin = await s.service.begin(simulated.id, s.owner.owner, wf);
    s.double.state.gatewayErrorsAfterSign = 1;
    await expect(s.service.submit(simulated.id, s.owner.sign(begin.unsignedTransaction))).resolves.toMatchObject({ verdict: 'PENDING',
      submissionError: 'KORA_PROVIDER_UNAVAILABLE', attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: null } });
    await expect(s.service.observe(simulated.id)).resolves.toMatchObject({ verdict: 'RECONCILED' });
    expect(s.chain.tokenAccount(s.chain.ata(s.recipient, T.USDC.mint))?.amount).toBe(7n + 12_000_000n);
  });
  // K4: a lost answer is always decided — whatever the owner's later activity — between the Review's slot and the blockhash's expiry.
  it('recovers a lost answer, and proves an unsigned one absent, even after many later transactions name the owner', async () => {
    const spam = async (s: Awaited<ReturnType<typeof setup>>, n: number) => {
      const sender = createMockedSolanaWallet();
      s.chain.fundWallet(sender.owner, 10_000_000_000n);
      for (let i = 0; i < n; i++) {
        const latest = await s.chain.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]) as { value: { blockhash: string } };
        const data = new Uint8Array(12); new DataView(data.buffer).setUint32(0, 2, true); new DataView(data.buffer).setBigUint64(4, 1_000_000n + BigInt(i), true);
        const message = serializeMessageV0(compileMessageV0(sender.owner, [{ programId: '11111111111111111111111111111111', accounts: [
          { pubkey: sender.owner, isSigner: true, isWritable: true }, { pubkey: s.owner.owner, isSigner: false, isWritable: true }], data }], latest.value.blockhash, {}));
        await s.chain.rpc('sendTransaction', [sender.sign(toBase64(serializeTransaction(null, message))), { encoding: 'base64' }]);
      }
    };
    // Kora signed and sent it, both answers lost; then 60 transactions naming the owner landed before the blockhash expired.
    const found = await setup({ recipientAccount: true });
    const wf = workflow(found.recipient, '12000000');
    const a = await found.service.simulate(wf, found.owner.owner);
    await found.service.review(a.id, a.review.commitment, wf);
    const beginA = await found.service.begin(a.id, found.owner.owner, wf);
    found.double.state.loseAnswers = 2;
    await expect(found.service.submit(a.id, found.owner.sign(beginA.unsignedTransaction))).resolves.toMatchObject({ attempt: { state: 'SUBMISSION_RESULT_UNKNOWN' } });
    await spam(found, 60);
    await expect(found.service.observe(a.id)).resolves.toMatchObject({ verdict: 'RECONCILED' });
    // Kora never signed (its call timed out); 60 transactions naming the owner landed after the blockhash expired: absence is still proven.
    const absent = await setup({ recipientAccount: true });
    const b = await absent.service.simulate(wf, absent.owner.owner);
    await absent.service.review(b.id, b.review.commitment, wf);
    const beginB = await absent.service.begin(b.id, absent.owner.owner, wf);
    absent.double.state.signMode = 'UNAVAILABLE';
    await absent.service.submit(b.id, absent.owner.sign(beginB.unsignedTransaction));
    absent.chain.advance(b.review.lastValidBlockHeight - absent.chain.state.blockHeight + 1);
    await spam(absent, 60);
    await expect(absent.service.observe(b.id)).resolves.toMatchObject({ verdict: 'NOT_EXECUTED', error: 'SOLANA_TRANSFER_TRANSACTION_EXPIRED_NOT_EXECUTED' });
  });
});
