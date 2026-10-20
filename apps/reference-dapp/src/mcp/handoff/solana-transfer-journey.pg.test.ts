// SPDX-License-Identifier: AGPL-3.0-only
/** Cloud certification candidate. Disposable PostgreSQL and in-memory Solana only; never public funds or broadcasts. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER, type SolanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaTransferChain, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createEmbeddedRuntime } from '../../server/flow-runtime.ts';
import type { SolanaTransferBegin, SolanaTransferRecord } from '../../server/solana-transfer-service.ts';
import { session } from '../gateway.test-harness.ts';
import { deriveKey } from '../oauth/config.ts';
import { credentialDigest } from '../oauth/crypto.ts';
import { oauthClient, oauthEnv, OAUTH_SECRET, ORIGIN, signIn } from '../oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from '../oauth/pg-store.ts';
import { stateOf } from '../oauth/state.ts';
import { embeddedMcpRuntime } from '../runtime.ts';
import { readHandoffPolicy } from '../execution.ts';
import { CLAIM_SECONDS, verifyHandoff } from './service.ts';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const key = deriveKey(OAUTH_SECRET, 'handoff');
function ok<T>(result: { ok: boolean; value?: unknown; code?: string }): T { if (!result.ok) throw Error(result.code); return result.value as T; }

describe('Solana chat-first transfer handoff on disposable durable cloud state', () => {
  for (const profile of [SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER] as SolanaTransferProfile[])
    it(`${profile.network}: MCP proposal, wallet claim, signed transfer, restart recovery and shared verified receipt`, async () => {
      const flow = profile.realFunds ? 'solana-transfer' : 'solana-devnet-transfer';
      const chain = createMockedSolanaTransferChain({ profile, send: 'RPC_ERROR_AFTER_LANDING' }), wallet = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
      chain.fundWallet(wallet.owner, 3_000_000_000n);
      const env = { FLOFI_RUNTIME: 'embedded', DATABASE_URL: t.url, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/build-solana-transfer-ux-001',
        FLOFI_MCP: 'enabled', GRYLOO_SOLANA_TRANSFER_HARNESS: 'MOCKED_LOOPBACK_ONLY', FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana', ...oauthEnv() };
      // Each request uses a fresh instance, exercising durable state rather than browser/process memory.
      const within = async <T,>(work: (runtime: Awaited<ReturnType<typeof createEmbeddedRuntime>>) => Promise<T>) => {
        const runtime = await createEmbeddedRuntime(env, { rpc: { [flow]: chain.rpc }, busyRetries: 3 });
        try { return await work(runtime); } finally { await runtime.close(); }
      };
      const tokens = await within(runtime => signIn(oauthClient({ env, store: createPgOAuthStore(runtime.db, runtime.tenantId) }), { scope: 'flofi.strategy flofi.approval flofi.runs' }));
      const tool = (name: string, args: unknown) => within(runtime => session({ env, token: tokens.access_token, runtime: embeddedMcpRuntime(runtime),
        state: stateOf({ db: runtime.db, tenantId: runtime.tenantId }) }).callTool(name, args));
      const owner = <T,>(method: string, ...args: unknown[]) => within(async runtime => ok<T>(await runtime.backend.callFlow(flow, method, args, undefined, wallet.owner)));
      const strategy = { action: 'transfer', network: profile.realFunds ? 'solana' : 'solana-devnet', asset: 'SOL', amount: '0.01', recipient };
      const composed = (await tool('compose_strategy', { strategy })).output as { strategy: unknown; workflowHash: string; workflow: SemanticWorkflow };
      const requested = await tool('request_user_approval', { strategy: composed.strategy, workflowHash: composed.workflowHash });
      const approval = { ...requested.output, ...requested.meta['flofi/approval'] as Record<string, unknown> } as { ok: boolean; authority: string; approvalId: string; approvalUrl: string };
      expect(approval.ok).toBe(true); expect(approval.authority).toContain('NONE'); expect(chain.state.sent).toHaveLength(0);
      const digest = credentialDigest(key, decodeURIComponent(new URL(approval.approvalUrl).hash.slice(1)));
      const principal = { namespace: 'solana' as const, address: wallet.owner };
      await within(async runtime => {
        const state = stateOf({ db: runtime.db, tenantId: runtime.tenantId });
        const handoff = (await state.handoffs.bySecret(digest, new Date()))!;
        const verified = await verifyHandoff(handoff, embeddedMcpRuntime(runtime), readHandoffPolicy(env));
        expect(verified.ok).toBe(true);
        await state.handoffs.claim(digest, principal, new Date(), CLAIM_SECONDS, () => ({ ok: true, share: true }));
        expect((await state.handoffs.apply(digest, principal, new Date())).ok).toBe(true);
      });
      const simulated = await owner<SolanaTransferRecord>('simulate', composed.workflow, wallet.owner);
      expect((await tool('get_approval_status', { approvalId: approval.approvalId })).output).toMatchObject({
        runs: [{ executionId: simulated.id, status: 'SIMULATED', reconciled: false, terminal: false, receiptUrl: null }],
      });
      expect(chain.state.sent).toHaveLength(0);
      await owner('review', simulated.id, simulated.review.commitment, composed.workflow);
      const begun = await owner<SolanaTransferBegin>('begin', simulated.id, wallet.owner, composed.workflow);
      const submitted = await owner<SolanaTransferRecord>('submit', simulated.id, wallet.sign(begun.unsignedTransaction));
      expect(submitted.attempt?.state).toBe('SUBMISSION_RESULT_UNKNOWN');
      const before = (await tool('get_approval_status', { approvalId: approval.approvalId })).output as { runs: { receiptUrl: string | null }[] };
      expect(before.runs.every(run => run.receiptUrl === null)).toBe(true);
      const final = await owner<SolanaTransferRecord>('observe', simulated.id); expect(final.verdict).toBe('RECONCILED');
      const after = (await tool('get_approval_status', { approvalId: approval.approvalId })).output;
      expect(after).toMatchObject({ status: 'APPLIED', runsVisible: true, runs: [{ executionId: final.id, reconciled: true, evidenceEnvironment: 'MOCKED', receiptUrl: `${ORIGIN}/app/dashboard/runs/${final.id}` }] });
      expect(JSON.stringify(after)).not.toMatch(/flofi_hs_|unsignedTransaction|"signature"|"transaction"/);
      expect(chain.state.sent).toHaveLength(1);
    });
});
