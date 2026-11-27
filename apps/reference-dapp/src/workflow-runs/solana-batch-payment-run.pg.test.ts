// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): an atomic Solana Batch Payment end to end on PostgreSQL, through the REAL approval
 * service (request -> claim at /approve), run store (migration 0023's group trigger), runner, worker and user-funded engine, on the compiler's MOCKED
 * mainnet transfer cluster and the harness's in-memory owner wallet:
 *   - ONE owner-signed transaction pays every recipient exactly (SOL and USDC, with and without new token accounts); FloFi sends it once and
 *     reconciles every leg from the finalized transaction; confirm-each-step and FloFi Wallet are refused, never split;
 *   - an unsigned preparation past its validity is prepared again only once the chain proves it cannot land and did not land (C.4), with the same
 *     manifest; a copy the owner's wallet broadcast outside FloFi stops the run; signed too late, failed on chain, lost or dropped sends, and a
 *     second, different answer never pay twice and never send other bytes;
 *   - once per requester kind: a channel conversation and an MCP account, both through /approve.
 *
 * MOCKED loopback doubles only: FloFi's logic, never a public execution, never evidence of one.
 */
import { describe, expect, it } from 'vitest';
import { applyMockedPhantomLighthouseGuards, createMockedSolanaTransferChain, createMockedSolanaWallet, fromBase64, parseTransaction, toBase64, MOCKED_RENT,
  SOLANA_MAINNET_TOKENS, type MockedTransferOptions } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { composeWorkflowBound } from '../engine/strategy-engine';
import { oauthClient, oauthEnv, signIn } from '../mcp/oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from '../mcp/oauth/pg-store.ts';
import { approvalLinkScheme, assembleApprovalSurface, claimApproval, requestApproval, type ApprovalRequester } from '../platform/index.ts';
import { workflowRunCancel, workflowRunContinue, workflowRunResume, workflowRunStart, workflowRunStatus, workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare,
  workflowRunUserFundedStart } from '../platform/approve.ts';
import { ownedRun } from '../platform/workflow-run-approvals.ts';
import type { SolanaGroupTx } from '../user-funded/groups.ts';
import { runView } from './service.ts';
import { workflowRunHarness } from './workflow-run.test-harness.ts';
import { randomBytes } from 'node:crypto';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', USDC = SOLANA_MAINNET_TOKENS.USDC.mint, WSOL = 'So11111111111111111111111111111111111111112';
const PHANTOM = { solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } };
const FLOFI = { solana: { wallet: 'FLOFI_WALLET', signMultiple: false, nonceAccounts: 0 } };
type Prepared = { transactions: SolanaGroupTx[] };
const refusal = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (e) { return e instanceof Error ? e.message : 'UNEXPECTED'; } };
/** The note every viewer with shared status reads for a run stopped while a request handed to the owner's wallet may have executed (`runView`). */
const MAY_HAVE_EXECUTED = 'A batch was handed to the owner\'s wallet and FloFi never recorded an answer for it: it may have executed before its on-chain '
  + 'deadline; check the wallet\'s activity.';
const NEVER_NOTHING_SENT = /before any step completed|nothing was sent|before anything was sent/i;

/**
 * A run of a 3-recipient batch, claimed at /approve by the owner's proven wallets. `requester` MCP_ACCOUNT: requested by an MCP account (an OAuth grant of
 * the harness's tenant) instead of the harness's channel conversation.
 */
async function setup(options: { readonly asset?: 'SOL' | 'USDC'; readonly chain?: MockedTransferOptions; readonly requester?: 'MCP_ACCOUNT' | 'CHANNEL_CONVERSATION';
  /** The workflow around the batch (default: the batch alone). */ readonly workflow?: (batch: unknown) => unknown; readonly flows?: readonly string[] } = {}) {
  const t = await createTestDatabase();
  const chain = createMockedSolanaTransferChain(options.chain ?? {});
  chain.createMint(USDC, { decimals: 6 });
  const blocked = new Set<string>();
  /**
   * `simulated`: changes what the cluster's simulation answers (an RPC or simulator that measures more than any batch may use). `before`: runs before
   * each RPC call is answered (plays a concurrent request in the middle of a chain read). `history`: answers the owner's history instead of the cluster.
   */
  const tamper: { simulated?: (value: Record<string, unknown>) => void; before?: (method: string) => Promise<void>; history?: () => unknown } = {};
  const solana = async (method: string, params: readonly unknown[]) => {
    await tamper.before?.(method);
    if (blocked.has(method)) throw new Error('SOLANA_RPC_UNAVAILABLE');
    if (method === 'getSignaturesForAddress' && tamper.history) return tamper.history();
    const result = await chain.rpc(method, params);
    if (method !== 'simulateTransaction' || !tamper.simulated) return result;
    const value = { ...(result as { value: Record<string, unknown> }).value };
    tamper.simulated(value);
    return { ...(result as object), value };
  };
  const h = await workflowRunHarness(t.db, { flows: (options.flows ?? ['solana-transfer']) as never, policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana,base' },
    userFundedChains: [SOLANA], solana, sequencesUserFunded: true });
  const owner = h.d.solOwner.address, wallets = [h.evm, h.sol];
  chain.fundWallet(owner, 10_000_000_000n);
  const source = chain.fundToken(owner, USDC, 100_000_000n);
  const recipients = Array.from({ length: 3 }, () => createMockedSolanaWallet().owner);
  const asset = options.asset ?? 'SOL';
  const batch = { action: 'batch_payment', network: 'solana', asset, recipients: recipients.map((recipient, i) => ({ recipient, amount: asset === 'SOL' ? `0.0${i + 1}` : String(i + 1) })) };
  let surface = h.surface, approval: { approvalId: string; secret: string };
  if (options.requester === 'MCP_ACCOUNT') {
    // An MCP account of this tenant (its OAuth grant), requesting through its own approval-link scheme; the owner still claims at /approve.
    await signIn(oauthClient({ env: oauthEnv(), store: createPgOAuthStore(t.db, h.d.tenantId) }), { scope: 'flofi.strategy flofi.approval' });
    const grant = (await t.db.query<{ grant_id: string; account_id: string; client_id: string; client_name: string }>(
      'SELECT grant_id, account_id, client_id, client_name FROM mcp_oauth_grants WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [h.d.tenantId])).rows[0]!;
    const scheme = approvalLinkScheme('flofi_hs_', randomBytes(32), ['MCP_ACCOUNT']);
    surface = assembleApprovalSurface([{ scheme, profiles: { MCP_ACCOUNT: { policy: h.policy } } }], h.handoffs, h.flows.runtime, h.runs);
    const requester: ApprovalRequester = { kind: 'MCP_ACCOUNT', ref: grant.account_id, grantId: grant.grant_id, clientId: grant.client_id, displayName: grant.client_name };
    const composed = composeWorkflowBound(options.workflow ? options.workflow(batch) : batch, undefined);
    if (!composed.ok) throw new Error(composed.code);
    const result = await requestApproval({ ...h.deps(), scheme }, requester, composed.strategy, composed.workflowHash);
    if (!result.ok) throw new Error(result.code);
    approval = { approvalId: result.value.approvalId, secret: decodeURIComponent(new URL(result.value.approvalUrl).hash.slice(1)) };
  } else approval = await h.request(options.workflow ? options.workflow(batch) : batch);
  const claimed = await claimApproval(surface, approval.secret, wallets, true, h.d.now());
  const run = async () => ownedRun(h.runs, approval.approvalId, wallets);
  const prepare = async () => (await workflowRunUserFundedPrepare(surface, approval.approvalId, wallets, 0)).prepared as unknown as Prepared;
  /** The owner's wallet signs the message (Wallet Standard `solana:signTransaction`, one transaction). */
  const sign = async (tx: SolanaGroupTx, guarded = false) => h.d.solOwner.signTransaction(guarded
    ? toBase64(parseTransaction(fromBase64(applyMockedPhantomLighthouseGuards(tx.unsignedTransaction, { lamportsAtLeast: 1n }), 2048)).message) : tx.message);
  const authorize = async (transactions: readonly string[]) => workflowRunUserFundedAuthorize(surface, approval.approvalId, wallets, 0, { kind: 'SOLANA_SIGN_ALL', transactions });
  const drain = async (passes = 12) => {
    const id = (await run()).runId;
    for (let pass = 0; pass < passes && ['RUNNING', 'ATTENTION'].includes((await h.store.byId(id))!.state); pass++) await h.drain(id);
  };
  return { t, chain, h, owner, wallets, source, recipients, surface, approval, claimed, run, prepare, sign, authorize, drain, blocked, tamper };
}

describe('KAN-20 Solana Batch Payment run (PostgreSQL, MOCKED Solana mainnet)', () => {
  it('channel conversation, SOL: ONE owner-signed transaction pays every recipient exactly; every leg reconciles; FloFi sends it once', async () => {
    const s = await setup();
    try {
      // Handed off as one workflow whose run is three legs; only the atomic user-funded mode is offered, as ONE sign-all group of exactly the legs.
      expect(s.claimed.view.workflowRun!.plan).toMatchObject({ stepCount: 3, confirmEachStep: { available: false, reason: 'BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION' },
        userFunded: { available: true, groups: [{ strategy: 'SOLANA_SIGN_ALL', stepFrom: 0, stepTo: 2 }] } });
      const started = await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      expect(started.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', mode: 'USER_FUNDED', groups: [{ strategy: 'SOLANA_SIGN_ALL', steps: [0, 2] }] });
      const prepared = await s.prepare();
      expect(prepared.transactions).toHaveLength(1);
      const tx = prepared.transactions[0]!;
      expect(tx).toMatchObject({ kind: 'BATCH_PAYMENT', owner: s.owner, legs: s.recipients.map((recipient, i) => ({ stepIndex: i, recipient, amount: String((i + 1) * 10_000_000) })) });
      // The owner's view carries the batch facts; a requester's never does.
      const run = await s.run();
      const ownerView = await runView(s.h.runs, run, { outcomes: true, owner: true });
      expect(ownerView.groups[0]!.solanaBatch).toEqual({ atomic: true, asset: { symbol: 'SOL', decimals: 9 }, total: '60000000', estimatedFeeLamports: tx.estimatedFeeLamports,
        accountCreationLamports: '0', maximumAccountCreationLamports: '0', maximumNetworkCostLamports: tx.maximumNetworkCostLamports, requiredLamports: tx.batch!.requiredLamports,
        transactionBytes: tx.batch!.transactionBytes });
      expect((await runView(s.h.runs, run, { outcomes: true })).groups[0]).not.toHaveProperty('solanaBatch');
      await s.authorize([await s.sign(tx)]);
      await s.drain();
      expect(await s.run()).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED' });
      const steps = await s.h.store.steps(run.runId);
      expect(steps.map(x => x.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED']);
      expect(steps.map(x => x.outcome?.spent)).toEqual([1, 2, 3].map(i => [{ asset: `${SOLANA}/token:${WSOL}`, amount: String(i * 10_000_000) }]));
      expect(s.recipients.map(r => s.chain.lamports(r))).toEqual([10_000_000n, 20_000_000n, 30_000_000n]);
      expect(s.chain.state.sent).toHaveLength(1);
      expect((await s.h.store.groups(run.runId))[0]).toMatchObject({ state: 'RECONCILED', outcome: { gasPaid: { payer: s.owner, unit: 'lamports' } } });
    } finally { await s.t.drop(); }
  });

  it('MCP account, USDC: deposits only for the recipients without a token account; every leg reconciles; FloFi sends it once', async () => {
    const s = await setup({ asset: 'USDC', requester: 'MCP_ACCOUNT' });
    try {
      s.chain.fundToken(s.recipients[0]!, USDC, 0n);
      expect(await s.h.store.byHandoff(s.approval.approvalId)).toMatchObject({ requester: { kind: 'MCP_ACCOUNT' } });
      await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      const tx = (await s.prepare()).transactions[0]!;
      expect(tx.legs!.map(l => [l.createDestination, l.accountCreationLamports])).toEqual([[false, '0'], [true, String(MOCKED_RENT.token)], [true, String(MOCKED_RENT.token)]]);
      const before = s.chain.lamports(s.owner);
      await s.authorize([await s.sign(tx)]);
      await s.drain();
      expect(await s.run()).toMatchObject({ state: 'COMPLETED' });
      expect(s.recipients.map(r => s.chain.tokenAccount(s.chain.ata(r, USDC))!.amount)).toEqual([1_000_000n, 2_000_000n, 3_000_000n]);
      expect(s.chain.tokenAccount(s.source)!.amount).toBe(94_000_000n);
      expect(before - s.chain.lamports(s.owner)).toBe(BigInt(tx.estimatedFeeLamports) + 2n * MOCKED_RENT.token);
      const steps = await s.h.store.steps((await s.run()).runId);
      expect(steps.map(x => x.outcome?.spent.length)).toEqual([1, 2, 2]);
      expect(s.chain.state.sent).toHaveLength(1);
    } finally { await s.t.drop(); }
  });

  it('never runs payment by payment: confirm-each-step is refused, and FloFi Wallet cannot start it (nothing stored, nothing sent)', async () => {
    const s = await setup();
    try {
      expect(await refusal(workflowRunStart(s.surface, s.approval.approvalId, s.wallets))).toBe('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
      expect(await refusal(workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, FLOFI))).toBe('BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE');
      const run = await s.run();
      expect(run).toMatchObject({ state: 'PENDING', mode: null });
      expect(await s.h.store.groups(run.runId)).toEqual([]);
      expect(s.chain.state.sent).toEqual([]);
    } finally { await s.t.drop(); }
  });

  it('C.4: past its validity it is prepared again only once its blockhash provably expired and no copy landed; P1\'s signature is never P2\'s', async () => {
    const s = await setup();
    try {
      await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      const p1 = (await s.prepare()).transactions[0]!;
      const signedP1 = await s.sign(p1);
      // The preparation's 50 s pass; its blockhash can still land: nothing is prepared again, the group stays PREPARED with P1, and a late answer is refused.
      s.h.d.advance(55_000);
      expect(await refusal(s.prepare())).toBe('SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE');
      expect(await refusal(s.authorize([signedP1]))).toBe('USER_FUNDED_PREPARED_EXPIRED');
      await s.drain(2);
      const runId = (await s.run()).runId;
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'PREPARED', prepared: { transactions: [{ messageHash: p1.messageHash }] } });
      expect((await s.run()).state).toBe('RUNNING');
      // Expiry before signing re-prepares only after the blockhash provably expired: a new blockhash, the same manifest.
      s.chain.advance(151);
      const p2 = (await s.prepare()).transactions[0]!;
      expect(p2.batch!.manifestHash).toBe(p1.batch!.manifestHash);
      expect(p2.legs!.map(l => [l.recipient, l.amount])).toEqual(p1.legs!.map(l => [l.recipient, l.amount]));
      expect([p2.messageHash !== p1.messageHash, p2.lastValidBlockHeight > p1.lastValidBlockHeight]).toEqual([true, true]);
      // T12: P1's signed bytes are no answer for P2: refused, the group stays PREPARED with P2, nothing sent.
      expect(await refusal(s.authorize([signedP1]))).toBe('SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED');
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'PREPARED', prepared: { transactions: [{ messageHash: p2.messageHash }] } });
      expect(s.chain.state.sent).toEqual([]);
      await s.authorize([await s.sign(p2)]);
      await s.drain();
      expect(await s.run()).toMatchObject({ state: 'COMPLETED' });
      expect(s.recipients.map(r => s.chain.lamports(r))).toEqual([10_000_000n, 20_000_000n, 30_000_000n]);
      expect(s.chain.state.sent).toHaveLength(1);
      expect(s.h.lines.some(l => l.includes('workflow_run.solana_batch_earlier_request') && l.includes('ABSENT'))).toBe(true);
    } finally { await s.t.drop(); }
  });

  it('C.4: a copy the owner\'s wallet broadcast outside FloFi landed: the group is BLOCKED, the run HALTS and is never resumed; every recipient paid once', async () => {
    // Found by the owner asking again (the service), or by the background pass first.
    for (const via of ['prepare', 'pass'] as const) {
      const s = await setup();
      try {
        await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
        const p1 = (await s.prepare()).transactions[0]!;
        const landed = await s.chain.rpc('sendTransaction', [await s.sign(p1), { encoding: 'base64' }]) as string;
        s.h.d.advance(55_000);
        s.chain.advance(151);
        if (via === 'prepare') expect(await refusal(s.prepare())).toBe('BATCH_PAYMENT_EARLIER_REQUEST_LANDED');
        await s.drain(3);
        const run = await s.run();
        expect(run).toMatchObject({ state: 'HALTED', code: 'BATCH_PAYMENT_EARLIER_REQUEST_LANDED' });
        // The landed copy's signature is kept with the block (migration 0023's outcome column; never a reconciliation), and never logged.
        expect((await s.h.store.groups(run.runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'BATCH_PAYMENT_EARLIER_REQUEST_LANDED',
          outcome: { earlierRequest: { settlement: 'LANDED', signature: landed } } });
        expect(s.h.lines.some(l => l.includes(landed)), via).toBe(false);
        expect((await s.h.store.steps(run.runId)).map(x => [x.state, x.code])).toEqual([0, 1, 2].map(() => ['BLOCKED', 'BATCH_PAYMENT_EARLIER_REQUEST_LANDED']));
        // Every viewer is told the batch may have executed, never that the run stopped before any step completed.
        const stopped = `Stopped. ${MAY_HAVE_EXECUTED} FloFi submits nothing more of it; the owner decides what happens next.`;
        const view = (await workflowRunStatus(s.surface, s.approval.approvalId, s.wallets)).view.workflowRun!.run;
        expect(view).toMatchObject({ halted: 'STOPPED', resumable: false, note: stopped });
        const requester = await runView(s.h.runs, run, { outcomes: true });
        expect(requester.note).toBe(stopped);
        expect(requester.note).not.toMatch(NEVER_NOTHING_SENT);
        expect(await refusal(workflowRunResume(s.surface, s.approval.approvalId, s.wallets))).toBe('BATCH_PAYMENT_EARLIER_REQUEST_LANDED');
        expect(await refusal(s.prepare())).toMatch(/^WORKFLOW_RUN_HALTED$/);
        expect(s.chain.state.sent).toHaveLength(1);
        expect(s.recipients.map(r => s.chain.lamports(r)), via).toEqual([10_000_000n, 20_000_000n, 30_000_000n]);
        // End (the only action left) rewrites the group's and legs' codes, but the kept signature still tells every viewer it may have executed.
        await workflowRunCancel(s.surface, s.approval.approvalId, s.wallets);
        const ended = await s.run();
        expect(ended.state).toBe('CANCELLED');
        expect((await s.h.store.groups(run.runId))[0]).toMatchObject({ state: 'SKIPPED', outcome: { earlierRequest: { settlement: 'LANDED', signature: landed } } });
        const endedView = await runView(s.h.runs, ended, { outcomes: true });
        expect(endedView.note).toBe(`Ended. ${MAY_HAVE_EXECUTED}`);
        // Channels read the group's flag (the codes now say OWNER_CANCELLED): its legs never read "not run".
        expect(endedView.groups?.[0]?.mayHaveExecuted).toBe(true);
        expect(s.chain.state.sent).toHaveLength(1);
      } finally { await s.t.drop(); }
    }
  });

  it('C.4: a window no history scan can cover is UNPROVABLE: BLOCKED with that settlement kept, HALTED, never resumed, and never "nothing sent"', async () => {
    for (const via of ['prepare', 'pass'] as const) {
      const s = await setup();
      try {
        await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
        const p1 = (await s.prepare()).transactions[0]!;
        s.h.d.advance(55_000);
        s.chain.advance(151);
        // Every history page full, every entry inside the Review's window: the scan never reaches the Review's slot (the blockhash provably expired).
        let page = 0;
        s.tamper.history = () => {
          page++;
          return Array.from({ length: 1000 }, (_, i) => ({ signature: '5' + String(page * 1000 + i).padStart(87, '1').replace(/0/g, 'z'), slot: p1.sinceSlot! + 100 }));
        };
        if (via === 'prepare') expect(await refusal(s.prepare())).toBe('BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE');
        await s.drain(3);
        const run = await s.run();
        expect(run).toMatchObject({ state: 'HALTED', code: 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE' });
        expect((await s.h.store.groups(run.runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE',
          outcome: { earlierRequest: { settlement: 'UNPROVABLE' } } });
        expect((await s.h.store.steps(run.runId)).map(x => [x.state, x.code])).toEqual([0, 1, 2].map(() => ['BLOCKED', 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE']));
        const stopped = `Stopped. ${MAY_HAVE_EXECUTED} FloFi submits nothing more of it; the owner decides what happens next.`;
        expect((await workflowRunStatus(s.surface, s.approval.approvalId, s.wallets)).view.workflowRun!.run).toMatchObject({ halted: 'STOPPED', resumable: false,
          note: stopped });
        const requester = await runView(s.h.runs, run, { outcomes: true });
        expect(requester.note, via).toBe(stopped);
        expect(requester.note).not.toMatch(NEVER_NOTHING_SENT);
        expect(await refusal(workflowRunResume(s.surface, s.approval.approvalId, s.wallets))).toBe('BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE');
        expect(s.chain.state.sent).toEqual([]);
      } finally { await s.t.drop(); }
    }
  });

  it('C.4: a stale request never expires a preparation made again while its own chain proof ran: P2 stays PREPARED and is the one sent, once', async () => {
    // The stale reader is the owner's prepare request (the service), or the background pass.
    for (const via of ['prepare', 'pass'] as const) {
      const s = await setup();
      try {
        await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
        const p1 = (await s.prepare()).transactions[0]!;
        const runId = (await s.run()).runId;
        s.h.d.advance(55_000);
        s.chain.advance(151);
        // While the stale reader scans the owner's history for P1, the owner asks again: P1 is proven absent and P2 prepared (a new row version).
        let p2: SolanaGroupTx | null = null;
        s.tamper.before = async method => {
          if (method !== 'getSignaturesForAddress') return;
          delete s.tamper.before;
          p2 = (await s.prepare()).transactions[0]!;
        };
        if (via === 'prepare') expect(await refusal(s.prepare())).toBe('WORKFLOW_RUN_CHANGED');
        else await s.h.drain(runId);
        const next = p2 as SolanaGroupTx | null;
        expect(next, via).not.toBeNull();
        expect(next!.messageHash).not.toBe(p1.messageHash);
        expect(next!.batch!.manifestHash).toBe(p1.batch!.manifestHash);
        expect((await s.h.store.groups(runId))[0], via).toMatchObject({ state: 'PREPARED', code: null, prepared: { transactions: [{ messageHash: next!.messageHash }] } });
        expect(await s.run()).toMatchObject({ state: 'RUNNING' });
        // The owner's answer for P2 is taken and sent once; every recipient is paid exactly once.
        await s.authorize([await s.sign(next!)]);
        await s.drain();
        expect(await s.run(), via).toMatchObject({ state: 'COMPLETED' });
        expect(s.recipients.map(r => s.chain.lamports(r)), via).toEqual([10_000_000n, 20_000_000n, 30_000_000n]);
        expect(s.chain.state.sent).toHaveLength(1);
      } finally { await s.t.drop(); }
    }
  });

  it('C.4 (f, h): an unreadable history decides nothing; once proven absent, a permanent refusal of the new preparation still blocks it, never split', async () => {
    const s = await setup();
    try {
      await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      const p1 = (await s.prepare()).transactions[0]!;
      const runId = (await s.run()).runId;
      s.h.d.advance(55_000);
      s.chain.advance(151);
      // (f) The blockhash provably expired, but the owner's history cannot be read: nothing is decided, nothing changes (the pass retries).
      s.blocked.add('getSignaturesForAddress');
      expect(await refusal(s.prepare())).toBe('BATCH_PAYMENT_EARLIER_REQUEST_UNPROVEN');
      await s.drain(1);
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'PREPARED', prepared: { transactions: [{ messageHash: p1.messageHash }] } });
      expect(await s.run()).toMatchObject({ state: 'RUNNING' });
      s.blocked.delete('getSignaturesForAddress');
      // (h) Proven absent, the group is planned again with no artifact; the new preparation measures more compute than one transaction may use, a
      // permanent refusal: the group is BLOCKED, the run HALTS, and Resume never continues it payment by payment.
      s.tamper.simulated = value => { value.unitsConsumed = 10_000_000; };
      expect(await refusal(s.prepare())).toBe('SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED');
      expect((await s.h.store.groups(runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED', prepared: null });
      expect((await s.h.store.steps(runId)).map(x => x.state)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
      expect(await s.run()).toMatchObject({ state: 'HALTED' });
      expect(await refusal(workflowRunResume(s.surface, s.approval.approvalId, s.wallets))).toBe('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
      expect(s.h.lines.filter(l => l.includes('workflow_run.solana_batch_earlier_request')).map(l => /UNKNOWN|ABSENT/.exec(l)?.[0])).toEqual(expect.arrayContaining(['UNKNOWN', 'ABSENT']));
      expect(s.chain.state.sent).toEqual([]);
    } finally { await s.t.drop(); }
  });

  it('T15: signed too late for the send budget: BLOCKED, never sent, every leg BLOCKED; Resume refused', async () => {
    const s = await setup();
    try {
      await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      const tx = (await s.prepare()).transactions[0]!;
      // Inside its validity, but its blockhash leaves fewer than the 25 blocks one transaction needs before it is sent.
      s.chain.advance(130);
      await s.authorize([await s.sign(tx)]);
      await s.drain(2);
      const run = await s.run();
      expect(run).toMatchObject({ state: 'FAILED', code: 'SOLANA_GROUP_SIGNED_TOO_LATE' });
      expect((await s.h.store.groups(run.runId))[0]).toMatchObject({ state: 'BLOCKED', code: 'SOLANA_GROUP_SIGNED_TOO_LATE', submission: null });
      expect((await s.h.store.steps(run.runId)).map(x => x.state)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
      expect(await refusal(workflowRunResume(s.surface, s.approval.approvalId, s.wallets))).toBe('WORKFLOW_RUN_FAILED');
      expect(s.chain.state.sent).toEqual([]);
    } finally { await s.t.drop(); }
  });

  it('a batch that fails on chain (a token account reassigned after Review) FAILS every leg, the fee only, and is never resent', async () => {
    const s = await setup({ asset: 'USDC' });
    try {
      await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      const tx = (await s.prepare()).transactions[0]!;
      s.chain.fundToken(s.recipients[1]!, USDC, 0n, { tokenOwner: createMockedSolanaWallet().owner });
      await s.authorize([await s.sign(tx)]);
      await s.drain();
      const run = await s.run();
      expect(run).toMatchObject({ state: 'FAILED', code: 'SOLANA_TRANSACTION_FAILED' });
      expect((await s.h.store.steps(run.runId)).map(x => [x.state, x.code])).toEqual([0, 1, 2].map(() => ['FAILED', 'SOLANA_TRANSACTION_FAILED']));
      expect((await s.h.store.groups(run.runId))[0]).toMatchObject({ state: 'FAILED', outcome: { steps: [], gasPaid: { payer: s.owner } } });
      await s.drain(3);
      expect(s.chain.state.sent).toHaveLength(1);
      expect(s.chain.tokenAccount(s.chain.ata(s.recipients[0]!, USDC))).toBeNull();
    } finally { await s.t.drop(); }
  });

  it('T13: an RPC error after landing is reconciled once (same bytes only); a dropped send expires provably and FAILS, nothing paid', async () => {
    const lost = await setup({ chain: { send: 'RPC_ERROR_AFTER_LANDING' } });
    try {
      await workflowRunUserFundedStart(lost.surface, lost.approval.approvalId, lost.wallets, PHANTOM);
      const tx = (await lost.prepare()).transactions[0]!;
      await lost.authorize([await lost.sign(tx)]);
      await lost.drain();
      expect(await lost.run()).toMatchObject({ state: 'COMPLETED' });
      expect(new Set(lost.chain.state.sent).size).toBe(1);
      expect(lost.chain.state.transactions.size).toBe(1);
      expect(lost.recipients.map(r => lost.chain.lamports(r))).toEqual([10_000_000n, 20_000_000n, 30_000_000n]);
    } finally { await lost.t.drop(); }
    const dropped = await setup({ chain: { send: 'DROPPED' } });
    try {
      await workflowRunUserFundedStart(dropped.surface, dropped.approval.approvalId, dropped.wallets, PHANTOM);
      const tx = (await dropped.prepare()).transactions[0]!;
      await dropped.authorize([await dropped.sign(tx)]);
      await dropped.drain(3);
      expect(await dropped.run()).toMatchObject({ state: 'RUNNING' });
      dropped.chain.advance(151);
      await dropped.drain();
      const run = await dropped.run();
      expect(run).toMatchObject({ state: 'FAILED', code: 'SOLANA_BLOCKHASH_EXPIRED' });
      expect((await dropped.h.store.steps(run.runId)).map(x => x.state)).toEqual(['FAILED', 'FAILED', 'FAILED']);
      expect(new Set(dropped.chain.state.sent).size).toBe(1);
      expect(dropped.chain.state.transactions.size).toBe(0);
      expect(dropped.recipients.map(r => dropped.chain.lamports(r))).toEqual([0n, 0n, 0n]);
    } finally { await dropped.t.drop(); }
  });

  it('T13: a second, different answer (another prompt\'s wallet guard) is refused SOLANA_BATCH_PAYMENT_ANSWER_MISMATCH; the recorded one is sent once', async () => {
    const s = await setup({ chain: { send: 'DROPPED' } });
    try {
      await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, PHANTOM);
      const tx = (await s.prepare()).transactions[0]!;
      const first = await s.sign(tx);
      await s.authorize([first]);
      const recorded = (await s.h.store.groups((await s.run()).runId))[0]!.authorization;
      expect(await refusal(s.authorize([await s.sign(tx, true)]))).toBe('SOLANA_BATCH_PAYMENT_ANSWER_MISMATCH');
      // The same answer again (its first response lost) changes nothing.
      expect(await refusal(s.authorize([first]))).toBe('NO_REFUSAL');
      expect((await s.h.store.groups((await s.run()).runId))[0]!.authorization).toEqual(recorded);
      expect(s.h.lines.some(l => l.includes('workflow_run.solana_answer_mismatch'))).toBe(true);
      expect(new Set(s.chain.state.sent)).toEqual(new Set([(recorded!.transactions as { transaction: string }[])[0]!.transaction]));
    } finally { await s.t.drop(); }
  });

  it('Universal bridge -> batch: the legs spend exactly their amounts from the reconciled delivery; a delivery below the total pays nothing, never split', async () => {
    for (const delivered of ['10000000', '5000000']) {
      const bridge = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '10', routing: 'best' };
      const s = await setup({ asset: 'USDC', flows: ['crosschain-universal', 'solana-transfer'],
        workflow: batch => ({ version: 2, steps: [bridge, batch], bindings: [{ step: 1, amountFrom: 0 }] }) });
      try {
        const started = await workflowRunUserFundedStart(s.surface, s.approval.approvalId, s.wallets, { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true }, ...PHANTOM });
        expect(started.view.workflowRun!.run.groups.map(g => [g.strategy, g.steps, g.signing, g.awaitsDelivery])).toEqual([['EVM_OWNER_STEP', [0, 0], 'WHEN_DUE', null],
          ['SOLANA_SIGN_ALL', [1, 3], 'WHEN_DUE', 0]]);
        // The bridge runs through its own owner-signed flow (MOCKED) and reconciles its Solana USDC delivery to the owner's wallet.
        const loaded = await workflowRunContinue(s.surface, s.approval.approvalId, s.wallets);
        const runId = (await s.run()).runId;
        const flowRun = s.h.flows.ownerExecutes('crosschain-universal', s.h.evm.address, loaded.workflow, 'RECONCILED');
        expect(await s.h.store.settleOwnerStep(runId, 0, 'RECONCILED', { kind: 'OWNER_RUN', executionId: flowRun.runId, flow: 'crosschain-universal', status: 'RECONCILED',
          transactions: [], evidence: null, spent: [], received: [{ asset: `${SOLANA}/token:${USDC}`, amount: delivered }], observedAt: s.h.d.now().toISOString() }, null)).toBe('RECORDED');
        await s.h.drain(runId);
        expect(await s.run()).toMatchObject({ state: 'RUNNING', currentStep: 1 });
        if (delivered === '5000000') {
          // 5 USDC delivered, 6 owed: nothing is prepared or sent; the group is blocked and the run halts; Resume never continues it payment by payment.
          expect(await refusal(workflowRunUserFundedPrepare(s.surface, s.approval.approvalId, s.wallets, 1))).toBe('WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT');
          expect((await s.h.store.groups(runId))[1]).toMatchObject({ state: 'BLOCKED', code: 'WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT', prepared: null });
          expect(await s.run()).toMatchObject({ state: 'HALTED' });
          expect(await refusal(workflowRunResume(s.surface, s.approval.approvalId, s.wallets))).toBe('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
          expect(s.chain.state.sent).toEqual([]);
          continue;
        }
        const prepareBatch = async () => ((await workflowRunUserFundedPrepare(s.surface, s.approval.approvalId, s.wallets, 1)).prepared as unknown as Prepared).transactions[0]!;
        const p1 = await prepareBatch();
        expect(p1.legs!.map(l => [l.stepIndex, l.amount])).toEqual([[1, '1000000'], [2, '2000000'], [3, '3000000']]);
        // C.1, bound: past its validity and once its blockhash provably expired (nothing landed), it is prepared again from the same reconciled delivery
        // with the same manifest and the same per-leg amounts; only the blockhash changes.
        s.h.d.advance(55_000);
        s.chain.advance(151);
        const tx = await prepareBatch();
        expect(tx.batch!.manifestHash).toBe(p1.batch!.manifestHash);
        expect(tx.legs!.map(l => [l.stepIndex, l.recipient, l.amount])).toEqual(p1.legs!.map(l => [l.stepIndex, l.recipient, l.amount]));
        expect([tx.messageHash !== p1.messageHash, tx.lastValidBlockHeight > p1.lastValidBlockHeight]).toEqual([true, true]);
        await workflowRunUserFundedAuthorize(s.surface, s.approval.approvalId, s.wallets, 1, { kind: 'SOLANA_SIGN_ALL', transactions: [await s.sign(tx)] });
        await s.drain();
        expect(await s.run()).toMatchObject({ state: 'COMPLETED' });
        const steps = await s.h.store.steps(runId);
        expect(steps.slice(1).map(x => [x.state, x.bound?.used])).toEqual([['RECONCILED', '1000000'], ['RECONCILED', '2000000'], ['RECONCILED', '3000000']]);
        expect(s.recipients.map(r => s.chain.tokenAccount(s.chain.ata(r, USDC))!.amount)).toEqual([1_000_000n, 2_000_000n, 3_000_000n]);
        expect(s.chain.state.sent).toHaveLength(1);
      } finally { await s.t.drop(); }
    }
  });
});
