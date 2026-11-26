// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the MCP panel's native wallet signing through the real `/api/mcp` gateway (OAuth grant, app-only tools) on a
 * disposable PostgreSQL, with the MOCKED in-memory Solana flow and a test wallet speaking the Phantom deeplink protocol. The wallet request reaches only
 * the panel (`_meta`), never model context; the Review comes back through get_execution_progress before anything is signed; only the panel's
 * confirmation produces the signing request; one broadcast; the reconciled run is the approval's receipt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLANA_DEVNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaTransferChain, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createEmbeddedRuntime } from '../server/flow-runtime.ts';
import { nativeSigningService } from '../server/native-signing/runtime.ts';
import { callbackParts, deeplinkTestWallet } from '../server/native-signing/deeplink/test-wallet.test-harness.ts';
import { session } from './gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from './oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from './oauth/pg-store.ts';
import { stateOf } from './oauth/state.ts';
import { embeddedMcpRuntime } from './runtime.ts';
import type { McpNativeSigning } from './tools.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: MCP panel native wallet signing', () => {
  it('start → wallet proof → Review in get_execution_progress → panel confirmation → exact signature → one broadcast → receipt', async () => {
    const chain = createMockedSolanaTransferChain({ profile: SOLANA_DEVNET_TRANSFER, send: 'OK' }), key = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
    chain.fundWallet(key.owner, 3_000_000_000n);
    const env = { FLOFI_RUNTIME: 'embedded', DATABASE_URL: t.url, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/native-channel-signing', FLOFI_MCP: 'enabled',
      GRYLOO_SOLANA_TRANSFER_HARNESS: 'MOCKED_LOOPBACK_ONLY', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_SESSION_SECRET: 's'.repeat(40), ...oauthEnv() };
    const runtime = await createEmbeddedRuntime(env, { rpc: { 'solana-devnet-transfer': chain.rpc }, busyRetries: 3 });
    try {
      const service = await nativeSigningService(env, { host: { db: runtime.db, tenantId: runtime.tenantId }, runtime: embeddedMcpRuntime(runtime),
        flow: async (flow, method, args, context) => runtime.backend.callFlow(flow, method, args, undefined, context.principal) as never, notify: async () => undefined });
      const native: McpNativeSigning = { start: input => service.start(input), confirm: input => service.confirm(input),
        reopen: (handoffId, sessionId, requester) => service.reopen(handoffId, sessionId, requester),
        latest: (handoffId, requester) => service.view(handoffId, requester) as never };
      const tokens = await signIn(oauthClient({ env, store: createPgOAuthStore(runtime.db, runtime.tenantId) }), { scope: 'flofi.strategy flofi.approval flofi.runs' });
      const client = session({ env, token: tokens.access_token, runtime: embeddedMcpRuntime(runtime), state: stateOf({ db: runtime.db, tenantId: runtime.tenantId }), native });
      const composed = (await client.callTool('compose_strategy', { strategy: { action: 'transfer', network: 'solana-devnet', asset: 'SOL', amount: '0.01', recipient } })).output as
        { strategy: unknown; workflowHash: string };
      const requested = (await client.callTool('request_user_approval', { strategy: composed.strategy, workflowHash: composed.workflowHash })).output as { approvalId: string };
      expect(requested).toMatchObject({ nativeSigning: { wallets: ['phantom', 'solflare'] } });
      const approvalId = requested.approvalId;

      const started = await client.callTool('start_wallet_session', { approvalId, wallet: 'phantom', language: 'PT' });
      expect(started.isError).toBe(false);
      // The wallet request (with its session's callback tags) reaches only the panel, never the model's context.
      expect(started.output).not.toHaveProperty('walletUrl');
      expect(started.text).not.toMatch(/phantom\.com\/ul|native-signing\//);
      const connectUrl = (started.meta['flofi/wallet'] as { walletUrl: string }).walletUrl;
      expect(connectUrl).toMatch(/^https:\/\/phantom\.com\/ul\/v1\/connect\?/);

      const wallet = deeplinkTestWallet('phantom', key);
      const deliver = (url: string) => { const p = callbackParts(url); return service.callback(p.handoffId, p.sessionId, p.tag, p.params); };
      const proof = await deliver(wallet.approve(connectUrl)) as { url: string };
      await deliver(wallet.approve(proof.url));
      expect(chain.state.sent).toHaveLength(0);

      const read = await client.callTool('get_execution_progress', { approvalId });
      const progress = read.output as { status: string; walletSigning: { state: string } };
      expect(progress).toMatchObject({ status: 'APPLIED', walletSigning: { wallet: 'phantom', state: 'REVIEW_READY' } });
      // The Review, the claiming wallet and the single-use reference reach only the panel (`_meta`), never the model's context.
      const panel = (read.meta['flofi/wallet'] as { session: { sessionId: string; reviewRef: string; review: { executionId: string; lines: { PT: string[] } } } }).session;
      expect(panel.review.lines.PT).toEqual(expect.arrayContaining(['Revisão: transferência na Solana Devnet', 'Você envia: 0,01 SOL', `Para: ${recipient}`]));
      expect(JSON.stringify(progress)).not.toMatch(/commitment|reviewRef|nsg_|dappSecret|walletSession|"signature"|lines/);
      expect(read.text).not.toContain(key.owner); expect(read.text).not.toContain(recipient);
      // Without the Review's reference (a model that sees the tool on a host ignoring app-only visibility), nothing is confirmed.
      expect((await client.callTool('confirm_wallet_review', { approvalId, sessionId: panel.sessionId, reviewRef: 'A'.repeat(22) })).isError).toBe(true);

      // Another account's grant never confirms it.
      const otherTokens = await signIn(oauthClient({ env, store: createPgOAuthStore(runtime.db, runtime.tenantId) }), { scope: 'flofi.strategy flofi.approval' });
      const other = session({ env, token: otherTokens.access_token, runtime: embeddedMcpRuntime(runtime), state: stateOf({ db: runtime.db, tenantId: runtime.tenantId }), native });
      expect((await other.callTool('confirm_wallet_review', { approvalId, sessionId: panel.sessionId, reviewRef: panel.reviewRef })).isError).toBe(true);

      const confirmed = await client.callTool('confirm_wallet_review', { approvalId, sessionId: panel.sessionId, reviewRef: panel.reviewRef });
      expect(confirmed.output).not.toHaveProperty('walletUrl');
      const signUrl = (confirmed.meta['flofi/wallet'] as { walletUrl: string }).walletUrl;
      expect(wallet.read(signUrl).method).toBe('signTransaction');
      expect(chain.state.sent).toHaveLength(0);
      // The panel can open the same wallet request again (a dismissed prompt); it changes nothing.
      const again = await client.callTool('reopen_wallet_request', { approvalId, sessionId: panel.sessionId });
      expect((again.meta['flofi/wallet'] as { walletUrl: string }).walletUrl).toBe(signUrl);
      await deliver(wallet.approve(signUrl));
      expect(chain.state.sent).toHaveLength(1);

      const runId = panel.review.executionId;
      await runtime.backend.callFlow('solana-devnet-transfer', 'observe', [runId], undefined, key.owner);
      const after = (await client.callTool('get_execution_progress', { approvalId })).output;
      expect(after).toMatchObject({ walletSigning: { state: 'SUBMITTED' }, runs: [{ executionId: runId, reconciled: true }] });
      // One approval is sent at most once: starting again is refused.
      expect((await client.callTool('start_wallet_session', { approvalId, wallet: 'solflare' })).output).toMatchObject({ code: 'NATIVE_SIGNING_ALREADY_SENT' });
      expect(chain.state.sent).toHaveLength(1);
    } finally { await runtime.close(); }
  });
});
