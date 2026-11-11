// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution (MCP review): what `get_approval_status` tells a host model about a stopped workflow. Resume is offered only while the
 * run view's `resumable` is true; a partial completion never implies nothing later was submitted (a later step may have been sent and failed);
 * a batch handed to the owner's wallet whose outcome is unknown is never reported as not run.
 */
import { describe, expect, it } from 'vitest';
import type { HandoffStore } from '../platform/index.ts';
import { credentialDigest, newCredential } from './oauth/crypto';
import { readOAuthConfig, type OAuthConfig } from './oauth/config';
import { oauthEnv } from './oauth/oauth-test-harness';
import type { McpState } from './oauth/state';
import { session } from './gateway.test-harness';

describe('get_approval_status description', () => {
  it('describes `workflowRun.resumable`, the halted classifications honestly, and an unknown wallet batch outcome', async () => {
    const env = { FLOFI_MCP: 'enabled', ...oauthEnv() };
    const config = readOAuthConfig(env) as OAuthConfig, token = newCredential('access');
    const state = { oauth: { authenticate: async (digest: Buffer) => digest.equals(credentialDigest(config.keys.token, token)) ? { accountId: 'mcpacct_' + 'a'.repeat(26),
      grantId: 'grt_' + 'a'.repeat(26), clientId: 'https://claude.ai/client', clientName: 'Claude', scopes: ['flofi.strategy', 'flofi.runs', 'flofi.approval'],
      resource: config.resource, familyId: 'fam_' + 'a'.repeat(26), expiresAt: new Date(Date.now() + 3_600_000) } : null, allow: async () => true },
    handoffs: {} as HandoffStore, links: { active: async () => [] }, workflowRuns: {} } as unknown as McpState;
    const listed = await session({ env, token, state }).request('tools/list');
    const tool = ((listed.result as { tools: { name: string; description: string }[] }).tools).find(t => t.name === 'get_approval_status')!;
    expect(tool.description).toContain('Resume is possible only while `workflowRun.resumable` is true');
    expect(tool.description).toContain('PARTIAL: they stay done; a later step may have been sent and failed');
    expect(tool.description).toContain('WALLET_BATCH_OUTCOME_UNKNOWN');
    // Never an unconditional resume offer, never "nothing later was submitted".
    expect(tool.description).not.toMatch(/\(resume or end\)|nothing later|nothing more was sent/i);
  });
});
