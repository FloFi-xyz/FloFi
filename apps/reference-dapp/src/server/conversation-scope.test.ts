// SPDX-License-Identifier: AGPL-3.0-only
/** HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001: the chat's account scope comes only from the server-verified account session. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ session: null as { accountId: string } | null, host: {} as object | null, fail: false }));
vi.mock('../accounts/account-host.ts', () => ({ accountHost: async () => { if (h.fail) throw new Error('db down'); return h.host; },
  currentAccountSession: async (host: object | null) => host ? h.session : null }));
vi.mock('./platform-state-host.ts', () => ({ platformStateHost: async () => ({ tenantId: 'default' }) }));
import { conversationScopeKey, conversationScopeOf, currentAccountBootstrap, currentConversationScope } from './conversation-scope';
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
  it('BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the same verified read gives the Settings menu its account presence; unknown on failure, never assumed', async () => {
    expect((await currentAccountBootstrap({})).accountPresence).toEqual({ accounts: false, signedIn: false });
    h.host = null; expect((await currentAccountBootstrap(env)).accountPresence).toEqual({ accounts: false, signedIn: false });
    h.host = {}; expect(await currentAccountBootstrap(env)).toEqual({ conversationScope: null, accountPresence: { accounts: true, signedIn: false } });
    h.session = { accountId: 'acct_0123456789abcdef0123456789abcdef' };
    expect(await currentAccountBootstrap(env)).toEqual({ conversationScope: conversationScopeOf(conversationScopeKey(env), 'default', 'acct_0123456789abcdef0123456789abcdef'),
      accountPresence: { accounts: true, signedIn: true } });
    // A chat-scope key that cannot be derived keeps the chat in memory only, without hiding the verified session.
    expect(await currentAccountBootstrap({ ...env, FLOFI_SESSION_SECRET: 'short' })).toEqual({ conversationScope: null, accountPresence: { accounts: true, signedIn: true } });
    h.fail = true; expect(await currentAccountBootstrap(env)).toEqual({ conversationScope: null, accountPresence: null });
  });
});
