// SPDX-License-Identifier: AGPL-3.0-only
/** HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001: the chat's account scope comes only from the server-verified account session. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ session: null as { accountId: string } | null, host: {} as object | null, fail: false }));
vi.mock('../accounts/account-host.ts', () => ({ accountHost: async () => { if (h.fail) throw new Error('db down'); return h.host; },
  currentAccountSession: async (host: object | null) => host ? h.session : null }));
vi.mock('./platform-state-host.ts', () => ({ platformStateHost: async () => ({ tenantId: 'default' }) }));
import { conversationScopeKey, conversationScopeOf, currentConversationScope } from './conversation-scope';
const env = { DATABASE_URL: 'postgres://127.0.0.1/fixture', FLOFI_SESSION_SECRET: 's'.repeat(40) };
beforeEach(() => { h.session = null; h.host = {}; h.fail = false; });

describe('conversation scope of this request', () => {
  it('is the tenant and verified account digest, and null without an account session, accounts or database', async () => {
    expect(await currentConversationScope({})).toBeNull();
    expect(await currentConversationScope(env)).toBeNull();
    h.session = { accountId: 'acct_0123456789abcdef0123456789abcdef' };
    expect(await currentConversationScope(env)).toBe(conversationScopeOf(conversationScopeKey(env), 'default', 'acct_0123456789abcdef0123456789abcdef'));
    // Keyed: another deployment secret gives another scope for the same account; an invalid secret keeps the chat in memory only.
    expect(await currentConversationScope({ ...env, FLOFI_SESSION_SECRET: 't'.repeat(40) })).not.toBe(await currentConversationScope(env));
    expect(await currentConversationScope({ ...env, FLOFI_SESSION_SECRET: 'short' })).toBeNull();
    h.host = null; expect(await currentConversationScope(env)).toBeNull();
    h.host = {}; h.fail = true; expect(await currentConversationScope(env)).toBeNull();
  });
});
