// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: a multi-step workflow over MCP (ChatGPT / Claude), on a disposable loopback PostgreSQL. compose_strategy plans it SEQUENTIAL;
 * request_user_approval returns ONE approval (authority NONE, no secret in the model-visible text) with the authorizations each mode needs;
 * get_approval_status reports the run from durable state — every step's state, and transactions/evidence only while the owner shares status.
 * The owner's flow runs come from the isolated flow-runtime test double. Nothing here signs, submits or authorizes anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { applyApproval, claimApproval, type WalletRef } from '../../platform/index.ts';
import { approvalSurface } from '../../server/approval-surface.ts';
import { createPgWorkflowRunStore } from '../../workflow-runs/pg-store.ts';
import { advanceRun } from '../../workflow-runs/runner.ts';
import { ownerFlowRuntime } from '../../workflow-runs/workflow-run.test-harness.ts';
import { session } from '../gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from '../oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from '../oauth/pg-store.ts';
import { stateOf } from '../oauth/state.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const OWNER: WalletRef = { namespace: 'eip155', address: '0x' + '1'.repeat(40) };
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' };
const SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' };

async function consumer() {
  const env = { FLOFI_MCP: 'enabled', FLOFI_WORKFLOW_RUNS: 'enabled', ...oauthEnv() };
  const flows = ownerFlowRuntime(['crosschain-router-testnet', 'base-sepolia-swap'], { enabled: true, delegation: null }, () => new Date());
  const tokens = await signIn(oauthClient({ env, store: createPgOAuthStore(t.db, 'default') }), { scope: 'flofi.strategy flofi.approval' });
  const client = session({ env, token: tokens.access_token, state: stateOf({ db: t.db, tenantId: 'default' }), runtime: flows.runtime });
  const host = { db: t.db, tenantId: 'default' }, surface = () => approvalSurface(env, () => undefined, { host, runtime: flows.runtime });
  return { env, flows, client, surface };
}

describe('BUILD-CHAT-E2E-001 multi-step workflows over MCP (PostgreSQL)', () => {
  it('plans, hands off ONE approval with authorization counts, and reports each step from the run', async () => {
    const { client, flows, surface } = await consumer();
    const composed = (await client.callTool('compose_strategy', { strategy: { version: 2, steps: [BRIDGE, SWAP] } })).output as Record<string, unknown>;
    expect(composed).toMatchObject({ ok: true, stepCount: 2, executionPlan: { kind: 'SEQUENTIAL', reason: null, mode: 'STEP_BY_STEP' },
      workflowSteps: [{ index: 0, flow: 'crosschain-router-testnet' }, { index: 1, flow: 'base-sepolia-swap' }] });
    const requested = await client.callTool('request_user_approval', { strategy: composed.strategy, workflowHash: composed.workflowHash });
    expect(requested.isError).toBe(false);
    const out = requested.output as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, executionPlan: 'SEQUENTIAL', authority: 'NONE', walletNamespaces: ['eip155'],
      authorizationPlan: { stepCount: 2, confirmEachStep: { available: true, walletConfirmationsAtLeast: 2 },
        delegatedSingleAuthorization: { available: false, reason: 'DELEGATION_NOT_ENABLED' }, recommended: 'CONFIRM_EACH_STEP' } });
    // The model sees a non-secret pointer; the secret link travels only in the UI-only metadata.
    expect(requested.text).not.toContain('flofi_hs_');
    const secret = decodeURIComponent(new URL(String((requested.meta['flofi/approval'] as { approvalUrl: string }).approvalUrl)).hash.slice(1));
    const approvalId = String(out.approvalId);
    expect((await client.callTool('get_approval_status', { approvalId })).output).toMatchObject({ ok: true, status: 'PENDING', workflowRun: null,
      note: 'Waiting for the owner to open the approval and prove their wallets.' });

    // The owner opens FloFi, proves the wallet, shares status and signs the first step there.
    const claimed = await claimApproval(await surface(), secret, [OWNER], true);
    await applyApproval(await surface(), secret, [OWNER], claimed.workflow);
    flows.ownerExecutes('crosschain-router-testnet', OWNER.address, claimed.workflow, 'RECONCILED');
    const store = createPgWorkflowRunStore(t.db, 'default'), run = (await store.byHandoff(approvalId))!;
    await advanceRun({ store, runtime: flows.runtime, delegation: null, policyFor: () => null, now: () => new Date(), log: () => undefined }, run.runId);
    const status = (await client.callTool('get_approval_status', { approvalId })).output as Record<string, unknown>;
    expect(status).toMatchObject({ ok: true, status: 'APPLIED', authority: 'NONE', workflowRun: { state: 'RUNNING', mode: 'CONFIRM_EACH_STEP', currentStep: 1,
      nextAction: 'OWNER_SIGNS_STEP', stepsVisible: true,
      steps: [{ index: 0, action: 'bridge', state: 'RECONCILED', outcome: { kind: 'OWNER_RUN', evidence: { environment: 'MOCKED', outcome: 'RECONCILED' },
        submissions: [{ chain: 'eip155:84532', explorerUrl: null }] } }, { index: 1, action: 'swap', state: 'PENDING', outcome: null }] } });
    // It never reveals the claiming wallet.
    expect(JSON.stringify(status)).not.toContain(OWNER.address);
  });

  it('a bound workflow is SEQUENTIAL for confirm-each-step (received amounts); delegated stays unavailable without a signer', async () => {
    const { client } = await consumer();
    const bound = { version: 2, steps: [SWAP, { ...SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' }], bindings: [{ step: 1, amountFrom: 0 }] };
    const composed = (await client.callTool('compose_strategy', { strategy: bound })).output as Record<string, unknown>;
    expect(composed).toMatchObject({ ok: true, executionPlan: { kind: 'SEQUENTIAL', reason: null, bindings: [{ step: 1, amountFrom: 0 }] } });
    expect((await client.callTool('request_user_approval', { strategy: composed.strategy, workflowHash: composed.workflowHash })).output)
      .toMatchObject({ ok: true, executionPlan: 'SEQUENTIAL',
        authorizationPlan: { confirmEachStep: { available: true }, delegatedSingleAuthorization: { available: false, reason: 'DELEGATION_NOT_ENABLED' },
          bindings: [{ step: 1, amountFrom: 0, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT', delegated: 'RECONCILED_RECEIVED_AMOUNT' }],
          recommended: 'CONFIRM_EACH_STEP' },
        gates: { supportedByCode: { modes: { confirmEachStep: null, delegated: 'DELEGATION_NOT_ENABLED' } } } });
    expect((await client.callTool('get_capabilities', {})).output).toMatchObject({ stepLists: { sequences: expect.stringContaining('ONE passkey authorization') } });
  });
});
