// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): Disconnect marks the page as leaving BEFORE the server ends the session, so the product gate's re-render
 * (no session any more) does not hand the page off to /board in the middle of Privy logout; Disconnect still ends on sign-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../app/account-action', () => ({ accountSignOut: vi.fn(async () => {
  const { pageExitInProgress } = await import('./page-exit');
  h.order.push(`signOut (page leaving: ${String(pageExitInProgress())})`);
  return { next: '/login' };
}) }));
vi.mock('../wallet/wallet-registry', () => ({ walletPreference: () => ({ evm: null, solana: null }), updateWalletPreference: () => undefined }));
vi.mock('../wallet/sign-in-wallet', () => ({ forgetAccountWalletReconnect: () => undefined }));
vi.mock('../wallet/evm-discovery', () => ({ isFloFiWalletKey: () => false }));
import { pageExitInProgress } from './page-exit';
import { disconnectToLogin } from './disconnect';

afterEach(() => { vi.unstubAllGlobals(); });
describe('Disconnect and the Flight hand-off', () => {
  it('marks the page as leaving before the session ends, then replaces it with sign-in', async () => {
    const replace = vi.fn(), logout = vi.fn(async () => { h.order.push('Privy logout'); });
    vi.stubGlobal('window', { location: { replace } });
    expect(pageExitInProgress()).toBe(false);
    await disconnectToLogin({ logout });
    expect(h.order).toEqual(['signOut (page leaving: true)', 'Privy logout']);
    expect(replace).toHaveBeenCalledWith('/login');
    expect(pageExitInProgress()).toBe(true);
  });
  it('HOTFIX-P1: removes this tab\'s kept FloFi conversations, writes none while signing out, and removes any left just before leaving', async () => {
    // A fresh page: Disconnect runs once per document, and the first case above already left this one.
    vi.resetModules();
    const { disconnectToLogin } = await import('./disconnect');
    const { CONVERSATION_STORAGE_PREFIX, writeConversation } = await import('../domain/conversation-persistence');
    const kept = new Map<string, string>(), A = 'A'.repeat(32), replace = vi.fn();
    const sessionStorage = { get length() { return kept.size; }, key: (index: number) => [...kept.keys()][index] ?? null, getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } };
    vi.stubGlobal('window', { location: { replace }, sessionStorage });
    const record = (workflowId: string) => JSON.stringify({ format: 'flofi.conversation.v1', scope: A, workflowId, savedAt: Date.now(), messages: [{ id: 1, role: 'you', text: 'hi' }] });
    kept.set(`${CONVERSATION_STORAGE_PREFIX}${A}:workflow-1`, record('workflow-1')); kept.set('flofi:editor-workflow:v1', 'canvas');
    let duringSignOut = 0;
    await disconnectToLogin({ logout: async () => {
      // A retired question or a late answer re-renders the chat while the page signs out: it is not kept again.
      writeConversation(sessionStorage, A, 'workflow-2', [{ id: 0, role: 'system', text: 'Hi' }, { id: 1, role: 'you', text: 'hi' }], Date.now());
      duringSignOut = [...kept.keys()].filter(key => key.startsWith(CONVERSATION_STORAGE_PREFIX)).length;
      kept.set(`${CONVERSATION_STORAGE_PREFIX}${A}:workflow-3`, record('workflow-3'));
    } });
    expect(duringSignOut).toBe(0);
    expect([...kept.keys()]).toEqual(['flofi:editor-workflow:v1']);
    expect(replace).toHaveBeenCalledWith('/login');
  });
});
