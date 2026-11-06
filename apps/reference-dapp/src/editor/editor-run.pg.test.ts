// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: a multi-step workflow built on the Editor's Canvas starts the SAME workflow run a chat or channel
 * starts, end to end on PostgreSQL: the Editor requester (the signed-in account) → the real approval service (one PENDING handoff, SEQUENTIAL plan,
 * migration 0022's EDITOR_SESSION kind) → `/approve`'s claim by a wallet that account holds → the durable run (requester EDITOR_SESSION) → each step
 * loaded, executed by the owner and reconciled in order. The owner's flow runs are the isolated flow-runtime test double; evidence is MOCKED and
 * nothing reaches a public network.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createReviewContext } from '@defi-workflow-engine/reference-linter';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createAccountStore } from '../accounts/account-store.ts';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import { applyApproval, assembleApprovalSurface, claimApproval, fixedWindow, viewApproval, workflowRunContinue, type HandoffPolicy, type WalletRef } from '../platform/index.ts';
import { workflowRunHarness } from '../workflow-runs/workflow-run.test-harness.ts';
import { editorApprovalScheme, editorClaimPolicy, editorScope, startEditorRun, type EditorRunConfig } from './approval.ts';

const OWNER = '0x1111111111111111111111111111111111111111', WETH = 'eip155:84532/erc20:0x4200000000000000000000000000000000000006';
const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
/** A Canvas workflow, authored exactly as the Editor's chat authors it. */
function author(...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    const on = /Base Sepolia/.test(sentence) ? createBaseSepoliaReviewContext() : context;
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, on, OWNER), on);
    if (state.error) throw new Error(state.error);
  }
  return state.workflow;
}
const TWO_STEPS = ['swap 1 USDC to WETH on Base Sepolia slippage 50 bps', 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps'];
const refusal = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (e) { return e instanceof Error ? e.message : 'UNEXPECTED'; } };
const CLOSED: HandoffPolicy = { ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' };

async function editorHarness() {
  const t = await createTestDatabase();
  const h = await workflowRunHarness(t.db, { flows: ['base-sepolia-swap'], delegation: false });
  if (!h.policy.ok) throw new Error('policy');
  const accounts = createAccountStore(t.db, h.d.tenantId);
  const session = await accounts.signIn({ kind: 'email', subject: `editor-${randomBytes(4).toString('hex')}@flofi.test`, label: null });
  await accounts.saveWallet(session.accountId, { ecosystem: 'evm', address: h.evm.address, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
    providerResource: null, label: 'MetaMask' });
  const config: Extract<EditorRunConfig, { enabled: true }> = { enabled: true, origin: 'http://localhost:3999', key: randomBytes(32), policy: h.policy };
  // Each step of the run is re-gated with ITS requester kind's policy, as `workflowRunSurface` does (fail closed for any other kind).
  const runs = { ...h.runs, policyFor: (kind: string) => kind === 'EDITOR_SESSION' ? config.policy : CLOSED };
  const surface = assembleApprovalSurface([{ scheme: editorApprovalScheme(config.key), profiles: { EDITOR_SESSION: { policy: config.policy,
    claimPolicy: editorClaimPolicy(accountId => accounts.walletAddresses(accountId)) } } }], h.handoffs, h.flows.runtime, runs);
  const start = (workflow: unknown, accountId = session.accountId) => startEditorRun({ config, origin: config.origin, handoffs: h.handoffs,
    allow: fixedWindow(t.db, h.d.tenantId).allow, runtime: h.flows.runtime, now: h.d.now() }, accountId, workflow);
  return { t, h, accounts, session, surface, start };
}
const secretOf = (url: string) => decodeURIComponent(new URL(url).hash.slice(1));

describe('BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 Editor → shared workflow run (PostgreSQL)', () => {
  it('starts one SEQUENTIAL approval for the signed-in account, claimed only by its own wallet, and runs each step in order to completion', async () => {
    const { t, h, session, surface, start } = await editorHarness();
    try {
      const started = await start(author(...TWO_STEPS));
      if (!started.ok) throw new Error(started.code);
      expect(started.value).toMatchObject({ stepCount: 2, walletNamespaces: ['eip155'], authority: 'NONE' });
      expect(started.value.approvalUrl).toMatch(/^http:\/\/localhost:3999\/approve#flofi_edhs_[A-Za-z0-9_-]{43}$/);
      const approvalId = started.value.approvalId, secret = secretOf(started.value.approvalUrl);
      const [row] = (await t.db.query(`SELECT requester_kind, requester_ref, account_id, grant_id, client_id, client_name, status, plan->>'kind' AS plan FROM mcp_handoffs
        WHERE handoff_id = $1`, [approvalId])).rows;
      expect(row).toEqual({ requester_kind: 'EDITOR_SESSION', requester_ref: session.accountId, account_id: null, grant_id: null, client_id: 'flofi-editor',
        client_name: 'FloFi Editor', status: 'PENDING', plan: 'SEQUENTIAL' });
      // Only this account (as requester) finds it; the secret is never stored.
      expect((await h.handoffs.forRequester(approvalId, editorScope(session.accountId), h.d.now()))?.handoffId).toBe(approvalId);
      expect(await h.handoffs.forRequester(approvalId, editorScope('acct_' + 'f'.repeat(32)), h.d.now())).toBeNull();
      expect(JSON.stringify((await t.db.query('SELECT * FROM mcp_handoffs WHERE handoff_id = $1', [approvalId])).rows)).not.toContain(secret);
      // /approve shows the proposal from the FloFi Editor; seeing it grants nothing.
      expect(await viewApproval(surface, secret, [], h.d.now())).toMatchObject({ requesterKind: 'EDITOR_SESSION', clientName: 'FloFi Editor', executionPlan: 'SEQUENTIAL',
        status: 'PENDING', authority: 'NONE', authorized: false });
      // A proven wallet the account does not hold cannot claim it; nothing changes.
      const stranger: WalletRef = { namespace: 'eip155', address: '0x' + '9'.repeat(40) };
      expect(await refusal(claimApproval(surface, secret, [stranger], true, h.d.now()))).toBe('EDITOR_WALLET_NOT_IN_ACCOUNT');
      expect(await h.store.byHandoff(approvalId)).toBeNull();
      // The account's own wallet claims it: the run starts (confirm each step is this deployment's only mode) with the Editor as its requester.
      const claimed = await claimApproval(surface, secret, [h.evm], true, h.d.now());
      const run = (await h.store.byHandoff(approvalId))!;
      expect(run).toMatchObject({ requester: { kind: 'EDITOR_SESSION', ref: session.accountId }, owner: { namespace: 'eip155', address: h.evm.address }, stepCount: 2,
        mode: 'CONFIRM_EACH_STEP', state: 'RUNNING' });
      expect(claimed.view.workflowRun).toMatchObject({ step: { index: 0, count: 2 }, stepWallet: h.evm.address });
      const steps = await h.store.steps(run.runId);
      expect(semanticWorkflowHash(claimed.workflow!)).toBe(steps[0]!.workflowHash);
      // Step 1: applied, signed by the owner (test double), reconciled; only then step 2 is loaded, bound to what step 1 delivered.
      await applyApproval(surface, secret, [h.evm], claimed.workflow, h.d.now());
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, claimed.workflow, 'RECONCILED', { received: [{ asset: WETH, amount: '500000000000000' }] });
      await h.drain(run.runId);
      const second = await workflowRunContinue(surface, approvalId, [h.evm]);
      expect(second.view.workflowRun).toMatchObject({ step: { index: 1, count: 2 } });
      expect((await h.store.steps(run.runId))[1]).toMatchObject({ state: 'AWAITING_OWNER', strategy: { amount: '0.0005' }, bound: { used: '500000000000000' } });
      h.flows.ownerExecutes('base-sepolia-swap', h.evm.address, second.workflow, 'RECONCILED');
      await h.drain(run.runId);
      expect(await h.store.byHandoff(approvalId)).toMatchObject({ state: 'COMPLETED', requester: { kind: 'EDITOR_SESSION' } });
    } finally { await t.drop(); }
  });

  it('refuses without the account, for a one-step workflow and for a workflow it cannot reproduce exactly; a newer run of the same workflow supersedes the open one', async () => {
    const { t, h, session, start } = await editorHarness();
    try {
      const before = (await t.db.query('SELECT count(*)::int AS n FROM mcp_handoffs')).rows[0];
      expect(await start(author(...TWO_STEPS), 'not-an-account')).toEqual({ ok: false, code: 'ACCOUNT_SESSION_REQUIRED' });
      expect(await start(author(TWO_STEPS[0]!))).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' });
      const altered = JSON.parse(JSON.stringify(author(...TWO_STEPS))) as Workflow, node = altered.nodes.filter(n => !n.actionType.startsWith('mock-'))[0]!;
      (node.userConstraints.find(c => c.kind === 'MAXIMUM_INPUT') as unknown as { quantity: { amount: string } }).quantity.amount = '999000000';
      expect(await start(altered)).toMatchObject({ ok: false });
      expect((await t.db.query('SELECT count(*)::int AS n FROM mcp_handoffs')).rows[0]).toEqual(before);
      const first = await start(author(...TWO_STEPS)), again = await start(author(...TWO_STEPS));
      if (!first.ok || !again.ok) throw new Error('start');
      expect((await h.handoffs.forRequester(first.value.approvalId, editorScope(session.accountId), h.d.now()))?.status).toBe('SUPERSEDED');
      expect((await h.handoffs.forRequester(again.value.approvalId, editorScope(session.accountId), h.d.now()))?.status).toBe('PENDING');
    } finally { await t.drop(); }
  });
});
