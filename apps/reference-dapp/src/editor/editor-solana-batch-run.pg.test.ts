// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02, surfaces 9.2 item 11): the Editor's in-place run of a lone Solana Batch Payment card, end to
 * end on PostgreSQL, through the same steps and order as the Editor's Authorize (`app/editor-workflow-execution-action.ts`, whose request scope — cookies,
 * the account session, the browser's proven wallets — is not available here): the read-only Review for the owner's Solana wallet → the binding the
 * browser sends → the proven wallet it claims with (only the reviewed Solana wallet, exactly) → the Editor requester's real approval service (one
 * PENDING SEQUENTIAL handoff) → the claim checked against the account's own saved Solana wallet → user-funded start with Phantom's profile → the run
 * matches the binding → its ONE batch group prepared from fresh chain facts (exactly the reviewed legs) → the owner's wallet signs that ONE transaction
 * → FloFi sends it once and reconciles every leg. Without the reviewed Solana wallet's sign-in nothing is created.
 *
 * MOCKED loopback doubles only (the compiler's MOCKED Solana mainnet cluster and the harness's in-memory owner wallet): never a public execution.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMockedSolanaTransferChain, createMockedSolanaWallet, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createAccountStore } from '../accounts/account-store.ts';
import { assembleApprovalSurface, claimApproval, fixedWindow, type HandoffPolicy } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedStart } from '../platform/approve.ts';
import type { SolanaGroupTx } from '../user-funded/groups.ts';
import { workflowRunHarness } from '../workflow-runs/workflow-run.test-harness.ts';
import { editorApprovalScheme, editorClaimPolicy, startEditorRun, type EditorRunConfig } from './approval.ts';
import { bindingOf, reviewedWallets, runMatchesBinding } from './authorize-binding.ts';
import { reviewEditorExecution } from './workflow-execution.ts';
import { canvasWorkflowOfStrategy } from './workflow-strategy.ts';

const SOLANA = SOLANA_MAINNET_TRANSFER.chain;
const PHANTOM = { solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } } as const;
const CLOSED: HandoffPolicy = { ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' };
const refusal = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (e) { return e instanceof Error ? e.message : 'UNEXPECTED'; } };
/** A valid, on-curve case variant of a Solana address (letter case changed where it yields another valid key), or null. */
function caseVariant(address: string): string | null {
  for (let i = 0; i < address.length; i++) {
    const c = address[i]!, swapped = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
    if (swapped === c || !/[1-9A-HJ-NP-Za-km-z]/.test(swapped)) continue;
    return address.slice(0, i) + swapped + address.slice(i + 1);
  }
  return null;
}

async function setup() {
  const t = await createTestDatabase();
  const chain = createMockedSolanaTransferChain({});
  const h = await workflowRunHarness(t.db, { flows: ['solana-transfer'] as never, policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana' },
    userFundedChains: [SOLANA], solana: chain.rpc, sequencesUserFunded: true });
  if (!h.policy.ok) throw new Error('policy');
  const owner = h.d.solOwner.address;
  chain.fundWallet(owner, 10_000_000_000n);
  const accounts = createAccountStore(t.db, h.d.tenantId);
  const session = await accounts.signIn({ kind: 'email', subject: `editor-sol-${randomBytes(4).toString('hex')}@flofi.test`, label: null });
  // The FloFi account holds the owner's Phantom wallet (the precondition the Editor's claim rule checks, exactly as for EVM).
  await accounts.saveWallet(session.accountId, { ecosystem: 'solana', address: owner, origin: 'external', provider: 'app.phantom', providerName: 'Phantom',
    providerResource: null, label: 'Phantom' });
  const config: Extract<EditorRunConfig, { enabled: true }> = { enabled: true, origin: 'http://localhost:3999', key: randomBytes(32), policy: h.policy };
  const runs = { ...h.runs, policyFor: (kind: string) => kind === 'EDITOR_SESSION' ? config.policy : CLOSED };
  const surface = assembleApprovalSurface([{ scheme: editorApprovalScheme(config.key), profiles: { EDITOR_SESSION: { policy: config.policy,
    claimPolicy: editorClaimPolicy(accountId => accounts.walletAddresses(accountId)) } } }], h.handoffs, h.flows.runtime, runs);
  const start = (workflow: unknown) => startEditorRun({ config, origin: config.origin, handoffs: h.handoffs, allow: fixedWindow(t.db, h.d.tenantId).allow,
    runtime: h.flows.runtime, now: h.d.now() }, session.accountId, workflow);
  const recipients = Array.from({ length: 3 }, () => createMockedSolanaWallet().owner);
  const canvas = canvasWorkflowOfStrategy({ action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: recipients.map((recipient, i) => ({ recipient, amount: `0.0${i + 1}` })) });
  if (!canvas.ok) throw new Error(canvas.code);
  const handoffs = async () => Number((await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM mcp_handoffs')).rows[0]!.n);
  return { t, chain, h, owner, surface, start, recipients, workflow: canvas.workflow, handoffs };
}

describe('KAN-20 Editor → in-place Solana Batch Payment run (PostgreSQL, MOCKED Solana mainnet)', () => {
  it('Review → binding → claim with the reviewed Solana wallet only → ONE batch group prepared exactly as reviewed → signed once, sent once, every leg reconciled', async () => {
    const s = await setup();
    try {
      // ── Review (read-only) for the owner's Solana wallet ─────────────────────────────────────────────────────────────────────────────
      const reviewed = await reviewEditorExecution({ workflow: s.workflow, owner: s.owner, profile: PHANTOM, facts: s.h.runs.userFundedFacts!, deps: s.h.runs.userFunded!,
        now: s.h.d.now() });
      if (!reviewed.ok) throw new Error(reviewed.code);
      const review = reviewed.value;
      expect(review).toMatchObject({ owner: s.owner, mode: 'ONE_WALLET_CONFIRMATION', refusal: null, groups: [{ strategy: 'SOLANA_SIGN_ALL', steps: [0, 2],
        solanaBatch: { atomic: true, total: '60000000' } }], counts: { walletPrompts: 1, signatures: 1, transactions: 1 } });
      expect(await s.handoffs()).toBe(0);
      expect(s.chain.state.sent).toHaveLength(0);
      // ── The binding the browser sends, and the wallets the Authorize claims with ───────────────────────────────────────────────────
      const binding = bindingOf({ owner: review.owner, workflowHash: review.workflowHash, groups: review.groups.map(g => ({ strategy: g.strategy, steps: g.steps })),
        firstGroupGas: 'NATIVE_WALLET_GAS' });
      expect(binding).toMatchObject({ owner: s.owner, namespace: 'solana' });
      const selected = reviewedWallets([s.h.evm, s.h.sol], binding!);
      if (!selected.ok) throw new Error(selected.code);
      expect(selected.wallets).toEqual([s.h.sol]);
      // ── The Editor's handoff, claimed by the account's own Solana wallet (exactly), user-funded with Phantom ─────────────────────────
      const started = await s.start(s.workflow);
      if (!started.ok) throw new Error(started.code);
      expect(started.value).toMatchObject({ stepCount: 3, walletNamespaces: ['solana'], authority: 'NONE' });
      const secret = decodeURIComponent(new URL(started.value.approvalUrl).hash.slice(1));
      const variant = caseVariant(s.owner);
      expect(variant).not.toBeNull();
      expect(await refusal(claimApproval(s.surface, secret, [{ namespace: 'solana', address: variant! }], true, s.h.d.now()))).toBe('EDITOR_WALLET_NOT_IN_ACCOUNT');
      await claimApproval(s.surface, secret, selected.wallets, true, s.h.d.now());
      const proposal = await workflowRunUserFundedStart(s.surface, started.value.approvalId, selected.wallets, PHANTOM);
      const run = proposal.view.workflowRun!.run;
      expect(run).toMatchObject({ mode: 'USER_FUNDED', state: 'RUNNING', groups: [{ strategy: 'SOLANA_SIGN_ALL', steps: [0, 2], feePayer: s.owner }] });
      expect(runMatchesBinding(run, binding!)).toBe(true);
      // ── Its ONE group prepared from fresh facts, with the reviewed mechanism: exactly the reviewed legs ──────────────────────────────
      const prepared = await workflowRunUserFundedPrepare(s.surface, started.value.approvalId, selected.wallets, 0, undefined, undefined, 'NATIVE_WALLET_GAS');
      const txs = (prepared.prepared as unknown as { transactions: SolanaGroupTx[] }).transactions;
      expect(txs).toHaveLength(1);
      expect(txs[0]!.kind).toBe('BATCH_PAYMENT');
      expect(txs[0]!.legs!.map(leg => [leg.stepIndex, leg.recipient, leg.amount])).toEqual(review.steps.map(step => [step.index, step.recipient, step.spend!.units]));
      expect(prepared.feePayer).toBe(s.owner);
      expect(s.chain.state.sent).toHaveLength(0);
      // ── The owner's wallet signs that ONE transaction; FloFi sends it once and reconciles every leg ─────────────────────────────────
      await workflowRunUserFundedAuthorize(s.surface, started.value.approvalId, selected.wallets, 0, { kind: 'SOLANA_SIGN_ALL',
        transactions: [await s.h.d.solOwner.signTransaction(txs[0]!.message)] });
      const id = (await s.h.store.byHandoff(started.value.approvalId))!.runId;
      for (let pass = 0; pass < 12 && ['RUNNING', 'ATTENTION'].includes((await s.h.store.byId(id))!.state); pass++) await s.h.drain(id);
      expect(await s.h.store.byId(id)).toMatchObject({ state: 'COMPLETED', requester: { kind: 'EDITOR_SESSION' } });
      expect((await s.h.store.steps(id)).map(step => step.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED']);
      expect(s.recipients.map(recipient => s.chain.lamports(recipient))).toEqual([10_000_000n, 20_000_000n, 30_000_000n]);
      expect(s.chain.state.sent).toHaveLength(1);
    } finally { await s.t.drop(); }
  });

  it('without the reviewed Solana wallet\'s sign-in: SOLANA_WALLET_PROOF_REQUIRED before anything is created; an EVM proof or another Solana wallet never stands in', async () => {
    const s = await setup();
    try {
      const reviewed = await reviewEditorExecution({ workflow: s.workflow, owner: s.owner, profile: PHANTOM, facts: s.h.runs.userFundedFacts!, deps: s.h.runs.userFunded!,
        now: s.h.d.now() });
      if (!reviewed.ok) throw new Error(reviewed.code);
      const binding = bindingOf({ owner: reviewed.value.owner, workflowHash: reviewed.value.workflowHash, groups: reviewed.value.groups.map(g => ({ strategy: g.strategy, steps: g.steps })) })!;
      for (const proven of [[], [s.h.evm], [s.h.evm, { namespace: 'solana' as const, address: createMockedSolanaWallet().owner }]])
        expect(reviewedWallets(proven, binding), JSON.stringify(proven)).toEqual({ ok: false, code: 'SOLANA_WALLET_PROOF_REQUIRED' });
      // The Authorize refuses here, so no handoff and no run exist for it.
      expect(await s.handoffs()).toBe(0);
      expect((await s.t.db.query('SELECT count(*)::int AS n FROM workflow_runs')).rows).toEqual([{ n: 0 }]);
      expect(s.chain.state.sent).toHaveLength(0);
    } finally { await s.t.drop(); }
  });
});
