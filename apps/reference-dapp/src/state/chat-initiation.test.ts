// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1): the browser presents the Chat's reference only while a call the Chat started runs, and
 * never delays or changes that call: without a fresh reference the call runs at once, unchanged (the server then records the Editor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../app/chat-initiation-action', () => ({ chatInitiationReference: vi.fn() }));
const { chatInitiationReference } = await import('../app/chat-initiation-action');
const REFERENCE = `ci1.${'p'.repeat(40)}.${'m'.repeat(43)}`;
let writes: string[] = [];

beforeEach(() => {
  writes = [];
  vi.stubGlobal('window', { location: { protocol: 'https:' } });
  vi.stubGlobal('document', { set cookie(value: string) { writes.push(value); }, get cookie() { return ''; } });
  vi.resetModules();
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(chatInitiationReference).mockReset(); });

describe('chat initiation in the browser', () => {
  it('presents the reference for exactly the duration of the Chat\'s call, and withdraws it after', async () => {
    vi.mocked(chatInitiationReference).mockResolvedValue({ reference: REFERENCE, expiresAt: Date.now() + 900_000 });
    const { chatInitiated, ensureChatInitiation } = await import('./chat-initiation.ts');
    await ensureChatInitiation();
    let release!: () => void, during: string[] = [];
    const call = chatInitiated(() => { during = [...writes]; return new Promise<string>(resolve => { release = () => resolve('simulated'); }); });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(/^flofi_chat_initiation=ci1\.p+\.m+; Path=\/app; Max-Age=(89\d|900); SameSite=Strict; Secure$/);
    expect(writes).toHaveLength(1); // still presented while the call runs
    release();
    expect(await call).toBe('simulated'); // the call's own result, unchanged
    expect(writes.at(-1)).toBe('flofi_chat_initiation=; Path=/app; Max-Age=0; SameSite=Strict; Secure');
    // A failing call withdraws it too, and its error is the call's own.
    await expect(chatInitiated(() => Promise.reject(new Error('SIMULATION_FAILED')))).rejects.toThrow('SIMULATION_FAILED');
    expect(writes.at(-1)).toContain('Max-Age=0');
    expect(chatInitiationReference).toHaveBeenCalledTimes(1); // a fresh reference is not fetched again
  });

  it('never waits: without a reference (none yet, no account session, a failed read) the call runs at once with nothing presented', async () => {
    vi.mocked(chatInitiationReference).mockResolvedValue(null);
    const { chatInitiated } = await import('./chat-initiation.ts');
    let started = false;
    const call = chatInitiated(() => { started = true; return 'simulated'; });
    expect(started).toBe(true); // synchronously, as without the wrapper
    expect(await call).toBe('simulated');
    expect(writes).toEqual([]);
    vi.mocked(chatInitiationReference).mockRejectedValue(new Error('offline'));
    const { chatInitiated: again } = await import('./chat-initiation.ts');
    expect(await again(() => 'simulated')).toBe('simulated');
    expect(writes).toEqual([]);
  });

  it('fetches its own reference when another account signs in, and stops when the Chat no longer wants one', async () => {
    vi.mocked(chatInitiationReference).mockResolvedValue({ reference: REFERENCE, expiresAt: Date.now() + 900_000 });
    const { chatInitiated, ensureChatInitiation, forgetChatInitiation } = await import('./chat-initiation.ts');
    await ensureChatInitiation(Date.now(), 'scope-a');
    await ensureChatInitiation(Date.now(), 'scope-a');
    expect(chatInitiationReference).toHaveBeenCalledTimes(1);
    await ensureChatInitiation(Date.now(), 'scope-b');
    expect(chatInitiationReference).toHaveBeenCalledTimes(2);
    forgetChatInitiation();
    writes = [];
    await chatInitiated(() => 'simulated');
    expect(writes).toEqual([]);
    expect(chatInitiationReference).toHaveBeenCalledTimes(2); // nothing fetched for a Chat that wants none
  });

  it('never presents a reference about to expire', async () => {
    vi.mocked(chatInitiationReference).mockResolvedValue({ reference: REFERENCE, expiresAt: Date.now() + 30_000 });
    const { chatInitiated, ensureChatInitiation } = await import('./chat-initiation.ts');
    await ensureChatInitiation();
    await chatInitiated(() => 'simulated');
    expect(writes).toEqual([]);
  });
});
