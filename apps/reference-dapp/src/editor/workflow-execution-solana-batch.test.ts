// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02, surfaces 9.2 item 10): the Editor's whole-workflow Review of a lone Solana Batch Payment card
 * for the owner's Solana wallet — read-only: its ONE atomic transaction is prepared exactly as the run will prepare it (a simulation; nothing is stored,
 * signed or sent), counted as one wallet confirmation, one signature and one transaction for every leg, valid about 50 s (its blockhash budget), with
 * its network fee and token-account deposits, now and at most. An underfunded owner gets the shortfall in lamports. The in-place Solana path is only
 * for Solana Batch Payments on Solana mainnet, only with a Solana owner, and FloFi Wallet is refused for it (Phantom or Solflare sign it).
 *
 * MOCKED loopback cluster only (the compiler's MOCKED Solana transfer chain): FloFi's logic, never a public execution.
 */
import { describe, expect, it } from 'vitest';
import { createMockedSolanaTransferChain, createMockedSolanaWallet, MOCKED_RENT, SOLANA_MAINNET_TOKENS, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/reference-compiler';
import type { UserFundedDeps } from '../user-funded/groups.ts';
import { reviewEditorExecution, solanaBatchOnly } from './workflow-execution.ts';
import { canvasWorkflowOfStrategy } from './workflow-strategy.ts';

const SOLANA = SOLANA_MAINNET_TRANSFER.chain, USDC = SOLANA_MAINNET_TOKENS.USDC.mint, NOW = new Date('2026-11-27T12:00:00.000Z');
const PHANTOM = { solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } } as const;
const FLOFI = { solana: { wallet: 'FLOFI_WALLET', signMultiple: false, nonceAccounts: 0 } } as const;
const EVM_OWNER = '0x' + '1a'.repeat(20);
const FACTS = { enabled: true, code: null, chains: [SOLANA], bundlerChains: [], solanaNonceAccounts: false } as const;

function setup(lamports = 10_000_000_000n) {
  const chain = createMockedSolanaTransferChain({}), owner = createMockedSolanaWallet().owner;
  chain.createMint(USDC, { decimals: 6 });
  chain.fundWallet(owner, lamports);
  chain.fundToken(owner, USDC, 100_000_000n);
  const recipients = Array.from({ length: 3 }, () => createMockedSolanaWallet().owner);
  const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, solana: chain.rpc, now: () => NOW };
  const batch = (asset: 'SOL' | 'USDC') => ({ action: 'batch_payment', network: 'solana', asset,
    recipients: recipients.map((recipient, i) => ({ recipient, amount: asset === 'SOL' ? `0.0${i + 1}` : String(i + 1) })) });
  const canvas = (strategy: unknown) => { const c = canvasWorkflowOfStrategy(strategy); if (!c.ok) throw new Error(c.code); return c.workflow; };
  const review = (workflow: unknown, who: string = owner, profile: unknown = PHANTOM) =>
    reviewEditorExecution({ workflow, owner: who, profile: profile as never, facts: FACTS, deps, now: NOW });
  return { chain, owner, recipients, deps, batch, canvas, review };
}

describe('KAN-20: the Editor Review of a lone Solana Batch Payment card (read-only, MOCKED Solana mainnet)', () => {
  it('SOL: ONE wallet confirmation, one signature, one transaction for three legs; the batch facts; valid about 50 s; nothing sent', async () => {
    const s = setup();
    const workflow = s.canvas(s.batch('SOL'));
    const r = await s.review(workflow);
    if (!r.ok) throw new Error(r.code);
    const review = r.value;
    // The owner is kept exactly as given (base58: letter case matters), never lower-cased.
    expect(review.owner).toBe(s.owner);
    expect(review).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', stepCount: 3, refusal: null,
      counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 0, networkSwitches: 0 } });
    expect(review.groups).toHaveLength(1);
    const g = review.groups[0]!;
    expect(g).toMatchObject({ index: 0, chain: SOLANA, network: 'Solana', strategy: 'SOLANA_SIGN_ALL', steps: [0, 2], signing: 'UPFRONT', calls: null, fee: null });
    expect(g.solanaBatch).toMatchObject({ atomic: true, asset: { symbol: 'SOL', decimals: 9 }, total: '60000000', accountCreationLamports: '0',
      maximumAccountCreationLamports: '0' });
    expect(BigInt(g.solanaBatch!.estimatedFeeLamports)).toBeGreaterThan(0n);
    expect(g.solanaBatch!.maximumNetworkCostLamports).toBe(g.solanaBatch!.estimatedFeeLamports);
    expect(g.solanaBatch!.transactionBytes).toBeLessThanOrEqual(1232);
    // Valid for its blockhash budget (SOLANA_BATCH_PAYMENT.reviewTtlSeconds, 50 s), never the EVM batch's 10 minutes.
    expect(Date.parse(review.validUntil!) - NOW.getTime()).toBe(50_000);
    // Every leg is its own step, paying exactly the authored recipient (verbatim) the exact amount.
    expect(review.steps.map(step => [step.index, step.action, step.network, step.recipient, step.spend?.units, step.spend?.symbol])).toEqual(
      s.recipients.map((recipient, i) => [i, 'transfer', 'Solana', recipient, String((i + 1) * 10_000_000), 'SOL']));
    // Read-only: nothing was sent and no recipient was paid.
    expect(s.chain.state.sent).toHaveLength(0);
    expect(s.recipients.map(recipient => s.chain.lamports(recipient))).toEqual([0n, 0n, 0n]);
  });

  it('USDC with recipients that have no token account yet: the deposits it charges now and at most, inside the network cost', async () => {
    const s = setup();
    s.chain.fundToken(s.recipients[0]!, USDC, 0n);
    const r = await s.review(s.canvas(s.batch('USDC')));
    if (!r.ok) throw new Error(r.code);
    const batch = r.value.groups[0]!.solanaBatch!;
    expect(batch).toMatchObject({ asset: { symbol: 'USDC', decimals: 6 }, total: '6000000', accountCreationLamports: String(2n * MOCKED_RENT.token) });
    // The worst case counts a deposit for every leg (an existing account may be closed before it runs); the network cost includes it.
    expect(BigInt(batch.maximumAccountCreationLamports)).toBe(3n * MOCKED_RENT.token);
    expect(BigInt(batch.maximumNetworkCostLamports)).toBe(BigInt(batch.estimatedFeeLamports) + 3n * MOCKED_RENT.token);
    expect(s.chain.state.sent).toHaveLength(0);
  });

  it('an owner whose SOL cannot cover it: the Review refuses with the shortfall in lamports (the existing native-fee evidence), nothing offered', async () => {
    const s = setup(1_000_000n);
    const r = await s.review(s.canvas(s.batch('SOL')));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.refusal).toMatchObject({ code: 'SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL',
      evidence: { kind: 'NATIVE_FEE_SHORTFALL', chainId: SOLANA, owner: s.owner, unit: 'lamports', balance: '1000000', nativeSpend: '60000000' } });
    const evidence = r.value.refusal!.evidence!;
    expect(BigInt(evidence.shortfall)).toBe(BigInt(evidence.required) - 1_000_000n);
    expect(BigInt(evidence.required)).toBe(BigInt(evidence.nativeSpend) + BigInt(evidence.maxFee) + BigInt(evidence.reserve!));
    expect(r.value.validUntil).toBeNull();
    expect(r.value.groups[0]).not.toHaveProperty('solanaBatch');
    expect(s.chain.state.sent).toHaveLength(0);
  });

  it('only Solana Batch Payments run in place with a Solana owner; never for an EVM owner; FloFi Wallet is refused for it in its own words', async () => {
    const s = setup();
    const batch = s.canvas(s.batch('SOL'));
    // An EVM owner never reviews a Solana Batch Payment (its one transaction is the Solana wallet's).
    expect(await s.review(batch, EVM_OWNER)).toEqual({ ok: false, code: 'SOLANA_WALLET_REQUIRED' });
    // A Solana owner never reviews an EVM workflow, nor a Solana workflow that is not made of Batch Payments.
    const evm = s.canvas({ action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: '0x' + '4'.repeat(40), amount: '1' },
      { recipient: '0x' + '5'.repeat(40), amount: '2' }] });
    expect(await s.review(evm, s.owner)).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_SOLANA_BATCH_ONLY' });
    // A Batch Payment followed by a separate Solana transfer: not every step is a leg of the batch.
    const batchThenSend = s.canvas({ version: 2, steps: [s.batch('SOL'), { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.04', recipient: createMockedSolanaWallet().owner }] });
    expect(await s.review(batchThenSend, s.owner)).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_SOLANA_BATCH_ONLY' });
    // A malformed or case-insensitive-looking owner is neither form: refused before anything is read.
    expect(await s.review(batch, s.owner.replace(/[1-9A-HJ-NP-Za-km-z]$/, '0'))).toEqual({ ok: false, code: 'EVM_WALLET_REQUIRED' });
    // FloFi Wallet has no signing binding for the batch's one transaction: refused as such, never split into prompts.
    expect(await s.review(batch, s.owner, FLOFI)).toEqual({ ok: false, code: 'FLOFI_WALLET_SOLANA_BATCH_PAYMENT_UNSUPPORTED' });
    expect(s.chain.state.sent).toHaveLength(0);
  });

  it('solanaBatchOnly: every step a leg of a Solana Batch Payment on Solana mainnet', () => {
    const legs = [0, 1, 2].map(index => ({ index, chain: SOLANA }));
    expect(solanaBatchOnly({ batches: [{ network: 'solana', from: 0, to: 2 }] }, legs)).toBe(true);
    expect(solanaBatchOnly({ batches: [{ network: 'solana', from: 1, to: 2 }] }, legs)).toBe(false);
    expect(solanaBatchOnly({ batches: [{ network: 'base', from: 0, to: 2 }] }, legs)).toBe(false);
    expect(solanaBatchOnly({}, legs)).toBe(false);
    expect(solanaBatchOnly({ batches: [{ network: 'solana', from: 0, to: 2 }] }, [...legs.slice(0, 2), { index: 2, chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }])).toBe(false);
    expect(solanaBatchOnly({ batches: [{ network: 'solana', from: 0, to: 2 }] }, [])).toBe(false);
  });
});
