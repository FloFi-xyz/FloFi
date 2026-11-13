// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ADR-0010 §4 (BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003): the Solana transfer flow with Pimlico's Kora fee payer, end to end on the MOCKED loopback
 * transfer cluster and the loopback Kora JSON-RPC double. Nothing reaches a provider or mainnet; nothing here is mainnet evidence.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockedSolanaTransferChain, createMockedSolanaWallet, fromBase64, parseTransaction, SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER,
  SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/reference-compiler';
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
});
