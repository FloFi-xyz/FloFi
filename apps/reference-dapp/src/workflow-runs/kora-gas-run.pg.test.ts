// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): a USER_FUNDED run on Solana whose owner holds USDC but no SOL, through the REAL approval
 * service, run store (with migration 0023's group trigger), runner and worker on a loopback PostgreSQL: the due sign-all group is prepared with
 * Pimlico's Kora fee payer, the owner's slot-1 signatures are verified, SOL that arrived since the Review is never switched to silently, and the run
 * records each Kora call before making it (at most two per transaction), relays, broadcasts and reconciles the USDC fee the owner paid.
 *
 * MOCKED loopback doubles only (the compiler's MOCKED Solana transfer cluster and the Kora JSON-RPC double): FloFi's logic, never a public execution.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMockedSolanaTransferChain, createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction, toBase64,
  SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import { koraGasFromEnv } from '../gas-abstraction/kora/runtime.ts';
import { startKoraDouble, type KoraDouble } from '../test-utils/kora-double.ts';
import { runView } from './service.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', T = SOLANA_MAINNET_TOKENS;
const PROFILE = { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true }, solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } };
const doubles: KoraDouble[] = [];
afterEach(async () => { while (doubles.length) await doubles.pop()!.close(); });

async function setup() {
  const t = await createTestDatabase();
  const chain = createMockedSolanaTransferChain();
  chain.createMint(T.USDC.mint, { decimals: 6 }); chain.createMint(T.USDT.mint, { decimals: 6 });
  const double = await startKoraDouble({ rpc: chain.rpc, tokens: [{ mint: T.USDC.mint, decimals: 6 }, { mint: T.USDT.mint, decimals: 6 }] });
  doubles.push(double);
  chain.fundWallet(double.signer, 5_000_000_000n); chain.fundToken(double.payment, T.USDC.mint, 0n); chain.fundToken(double.payment, T.USDT.mint, 0n);
  const kora = koraGasFromEnv({ FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: double.url, FLOFI_KORA_SIGNER: double.signer, FLOFI_KORA_PAYMENT_ADDRESS: double.payment });
  const h = await workflowRunHarness(t.db, { flows: ['solana-transfer'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana' }, userFundedChains: [SOLANA],
    solana: chain.rpc, kora });
  const owner = h.d.solOwner.address, wallets = [h.evm, h.sol];
  // The owner holds USDC and no SOL at all (its System account does not exist).
  chain.fundToken(owner, T.USDC.mint, 50_000_000n);
  const a = createMockedSolanaWallet().owner, b = createMockedSolanaWallet().owner;
  const send = (recipient: string, amount: string) => ({ action: 'transfer', network: 'solana', asset: 'USDC', amount, recipient });
  const approval = await h.request({ version: 2, steps: [send(a, '5'), send(b, '7')] });
  await claimApproval(h.surface, approval.secret, wallets, true, h.d.now());
  await workflowRunUserFundedStart(h.surface, approval.approvalId, wallets, PROFILE);
  const run = await ownedRun(h.runs, approval.approvalId, wallets);
  /** The owner's wallet behind Kora: its own signature in slot 1, Kora's slot 0 left empty. */
  const signSlot1 = async (message: string) => {
    const own = parseTransaction(fromBase64(await h.d.solOwner.signTransaction(message), 2048)).signatures[0]!;
    return toBase64(serializeSignedTransaction([new Uint8Array(64), own], fromBase64(message, 2048)));
  };
  return { t, chain, double, h, owner, wallets, approval, run, signSlot1, recipients: [a, b] };
}
type KoraTx = { message: string; gas?: { amount: string; feePayer: string } };

describe('ADR-0010 §4: a user-funded Solana run whose fees the owner pays in USDC through Pimlico Kora (PostgreSQL)', () => {
  it('prepares the sign-all group with Kora, records each Kora call before making it, relays, broadcasts and reconciles the USDC fee', async () => {
    const { t, chain, double, h, owner, wallets, approval, run, signSlot1, recipients } = await setup();
    try {
      const p = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const txs = (p.prepared as { transactions: KoraTx[] }).transactions;
      expect(p).toMatchObject({ strategy: 'SOLANA_SIGN_ALL', prepared: { kind: 'SOLANA_SIGN_ALL', fee: { unit: 'token', token: { symbol: 'USDC' } } } });
      expect(txs.every(x => x.gas?.feePayer === double.signer)).toBe(true);
      const total = txs.reduce((sum, x) => sum + BigInt(x.gas!.amount), 0n);
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'SOLANA_SIGN_ALL', transactions: await Promise.all(txs.map(x => signSlot1(x.message))) });
      for (let pass = 0; pass < 12 && (await h.store.byId(run.runId))!.state === 'RUNNING'; pass++) await h.drain(run.runId);
      const done = await ownedRun(h.runs, approval.approvalId, wallets);
      const group = (await h.store.groups(run.runId))[0]!;
      expect({ run: done.state, group: group.state, code: group.code }).toEqual({ run: 'COMPLETED', group: 'RECONCILED', code: null });
      // The submission was written once (the owners' signatures are the identities); Kora's answers were recorded beside it, never over it.
      expect(group.submission).toMatchObject({ kind: 'SOLANA_SIGN_ALL', hashes: [null, null] });
      expect(double.state.signed).toHaveLength(2);
      expect(double.state.unpaid).toBe(0);
      expect(chain.tokenAccount(chain.ata(recipients[1]!, T.USDC.mint))?.amount).toBe(7_000_000n);
      expect(chain.lamports(owner)).toBe(0n);
      const view = await runView(h.runs, done, { outcomes: true, owner: true });
      expect(view.groups[0]).toMatchObject({ state: 'RECONCILED', gasPaid: { payer: double.signer, paidInToken: { mechanism: 'PIMLICO_KORA_SPL_FEE', symbol: 'USDC',
        amount: total.toString() } } });
      expect(view.groups[0]!.submissions).toHaveLength(2);
      expect(view.steps.map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    } finally { await t.drop(); }
  });

  it('SOL that arrived since the Review: authorization never switches silently (GAS_MECHANISM_CHANGED_REVIEW_REQUIRED); the group is planned again', async () => {
    const { t, chain, double, h, owner, wallets, approval, run, signSlot1 } = await setup();
    try {
      const p = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      const txs = (p.prepared as { transactions: KoraTx[] }).transactions;
      chain.fundWallet(owner, 2_000_000_000n);
      await expect(workflowRunUserFundedAuthorize(h.surface, approval.approvalId, wallets, 0, { kind: 'SOLANA_SIGN_ALL',
        transactions: await Promise.all(txs.map(x => signSlot1(x.message))) })).rejects.toThrow('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
      expect((await h.store.groups(run.runId))[0]).toMatchObject({ state: 'PLANNED', strategy: 'SOLANA_SIGN_ALL', prepared: null, authorization: null });
      expect(double.state.calls.filter(c => c.method === 'signAndSendTransaction')).toEqual([]);
      // Prepared again: the owner now pays natively.
      const again = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, wallets, 0);
      expect(again).toMatchObject({ strategy: 'SOLANA_SIGN_ALL', prepared: { kind: 'SOLANA_SIGN_ALL', fee: { unit: 'lamports' } } });
    } finally { await t.drop(); }
  });
});
