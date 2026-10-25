// SPDX-License-Identifier: AGPL-3.0-only
/** Real OAuth/PKCE, MCP and durable approvals on disposable PostgreSQL; runtime discovery is a double, no wallet or public chain. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { deploymentTenant } from '../server/deployment.ts';
import { publicApprovalUrl } from '../platform/navigation.ts';
import { memoryLogger, session } from './gateway.test-harness.ts';
import { CHATGPT, CHATGPT_REDIRECT, oauthClient, oauthEnv, signIn } from './oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from './oauth/pg-store.ts';
import { readOAuthConfig } from './oauth/config.ts';
import { credentialDigest } from './oauth/crypto.ts';
import { stateOf } from './oauth/state.ts';
import type { McpRuntime } from './runtime.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const strategy = { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '1' };
const never = async (): Promise<never> => { throw new Error('NO_FINANCIAL_EXECUTION_IN_TEST'); };
const runtime: McpRuntime = { kind: 'embedded', mode: async flow => flow === 'jupiter-swap' ? 'harness' : 'off',
  info: async () => ({ executionEnabled: true }), preview: never, run: never, journal: never, evidence: never };

describe('BUILD-MCP-LINK-INTEGRITY-P0 tool provenance and capability secrecy', () => {
  it.each([
    { origin: 'https://flofi.xyz', VERCEL_ENV: 'production' },
    { origin: 'https://flofi-git-security-owner.vercel.app', VERCEL_ENV: 'preview' },
  ])('OAuth → capabilities → compose → review → real approval at $origin', async ({ origin, VERCEL_ENV }) => {
    const env = { FLOFI_MCP: 'enabled', ...oauthEnv({ FLOFI_PUBLIC_ORIGIN: origin, VERCEL: '1', VERCEL_ENV,
      VERCEL_GIT_COMMIT_REF: 'security/mcp-link-integrity-p0', FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana' }) };
    const config = readOAuthConfig(env);
    if (!config.enabled) throw new Error(config.code);
    const tenant = deploymentTenant(env);
    await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenant]);
    const browser = oauthClient({ env, store: createPgOAuthStore(t.db, tenant) });
    const tokens = await signIn(browser, { clientId: CHATGPT, redirectUri: CHATGPT_REDIRECT });
    const logger = memoryLogger(), state = stateOf({ db: t.db, tenantId: tenant });
    const client = session({ env, token: tokens.access_token, runtime, state, logger });
    const init = (await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ChatGPT-test', version: '1' } })).result as { instructions: string };
    expect(init.instructions).toContain('https://flofi.xyz/api/mcp');
    expect(init.instructions).toContain('Never invent an official website, approval link, financial quote, approval ID or transaction status');
    expect(init.instructions).toContain('If a real tool call is unavailable or fails, disclose that and provide no approval CTA');
    if (VERCEL_ENV === 'preview') expect(init.instructions).toContain(`non-production FloFi environment at ${origin}`);
    const capabilities = await client.callTool('get_capabilities', { network: 'solana', action: 'swap' });
    expect(capabilities.isError).toBe(false);
    expect(capabilities.output.navigation).toEqual({ websiteUrl: origin, mcpEndpoint: `${origin}/api/mcp`, productionWebsiteUrl: 'https://flofi.xyz' });
    const composed = (await client.callTool('compose_strategy', { strategy })).output;
    const bound = { strategy: composed.strategy, workflowHash: composed.workflowHash };
    expect((await client.callTool('review_strategy', bound)).isError).toBe(false);
    expect(JSON.stringify(composed)).not.toContain('/approve#');
    const wire = (await client.request('tools/call', { name: 'request_user_approval', arguments: bound })).result as CallToolResult;
    const result = { isError: wire.isError === true, output: wire.structuredContent as Record<string, unknown>, meta: wire._meta!, text: JSON.stringify(wire.content) };
    expect(result.isError).toBe(false);
    const id = result.output.approvalId as string;
    expect(result.output).toMatchObject({ ok: true, status: 'PENDING', fundsClass: 'REAL_FUNDS', authority: 'NONE', approvalUrl: publicApprovalUrl(origin, id) });
    const principal = await state.oauth.authenticate(credentialDigest(config.keys.token, tokens.access_token), new Date());
    expect((await state.handoffs.forAccount(id, principal!.accountId, new Date()))?.status).toBe('PENDING');
    const privateLinks = result.meta['flofi/approval'] as { approvalUrl: string; walletLinks?: unknown };
    expect(privateLinks.approvalUrl.startsWith(origin + '/approve#')).toBe(true);
    expect(new URL(privateLinks.approvalUrl).hash).toMatch(/^#flofi_hs_[A-Za-z0-9_-]{43}$/);
    // Model-visible content, summaries, progress and logs must never contain any UI capability, token or account cookie.
    const raw = (await client.request('tools/call', { name: 'get_approval_status', arguments: { approvalId: id } })).result;
    const modelVisible = JSON.stringify({ output: result.output, text: result.text, status: raw, logs: logger.lines });
    for (const secret of [privateLinks.approvalUrl.split('#')[1]!, tokens.access_token, tokens.refresh_token, tokens.code, ...browser.jar.values()])
      expect(modelVisible).not.toContain(secret);
    expect(modelVisible).not.toMatch(/flofi_(?:hs|at|rt|code|csrf)_/);
    const opened = await client.callTool('open_approval_session', { approvalId: id });
    expect(opened.output.approvalUrl).toBe(publicApprovalUrl(origin, id));
    expect(opened.meta['flofi/approval']).toMatchObject({ approvalUrl: expect.stringContaining('/approve#flofi_hs_'), walletLinks: {
      metamask: expect.stringContaining('https://metamask.app.link/dapp/'), phantom: expect.stringContaining('https://phantom.com/ul/browse/') } });
    const fabricated = await client.callTool('get_approval_status', { approvalId: 'apr_' + 'z'.repeat(26) });
    expect(fabricated.output).toEqual({ ok: false, code: 'APPROVAL_NOT_FOUND' });
    const failed = await client.callTool('request_user_approval', { ...bound, workflowHash: '0x' + '0'.repeat(64) });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toMatch(/approvalUrl|walletLinks|\/approve#/);
  });
});
