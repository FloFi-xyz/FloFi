// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet';
import { walletSignIn, walletSignInChallenge, walletSignOut } from './wallet-session-action';
import { currentWalletSession } from '../server/session-principal';
import { WALLET_SESSION_COOKIE } from '../server/wallet-session';
import { embeddedWalletCookie } from '../server/embedded-approval';

const state = vi.hoisted(() => ({ values: new Map<string, string>(), writes: [] as { name: string; options: Record<string, unknown> }[], host: 'flofi.xyz' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: state.host }),
  cookies: async () => ({ get: (name: string) => state.values.has(name) ? { value: state.values.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.writes.push({ name, options }); if (options.maxAge === 0) state.values.delete(name); else state.values.set(name, value);
    }, delete: (name: string) => state.values.delete(name) }),
}));
beforeEach(() => { state.values.clear(); state.writes = []; state.host = 'flofi.xyz'; vi.stubEnv('FLOFI_SESSION_SECRET', randomBytes(32).toString('hex')); });
afterEach(() => vi.unstubAllEnvs());

describe('wallet proof inside MCP Apps', () => {
  it('still requires a genuine wallet signature; seals only an isolated HttpOnly session and consumes the challenge', async () => {
    const owner = createTestWallet(), challenge = await walletSignInChallenge(owner.address, 8453, true);
    expect(challenge.ok).toBe(true); if (!challenge.ok) return;
    expect(state.writes[0]).toMatchObject({ name: 'embedded_flofi_wallet_challenge', options: {
      httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: '/mcp/approve',
    } });
    const result = await walletSignIn(owner.address, 8453, owner.signMessage(challenge.value.message), true);
    expect(result).toMatchObject({ ok: true, value: { account: owner.address } });
    expect(result).not.toHaveProperty('token');
    expect(state.values.has('embedded_flofi_wallet_challenge')).toBe(false);
    expect(state.values.has(WALLET_SESSION_COOKIE)).toBe(false);
    expect(await currentWalletSession()).toMatchObject({ account: owner.address });
    expect(await walletSignIn(owner.address, 8453, owner.signMessage(challenge.value.message), true)).toMatchObject({ ok: false });
    await walletSignOut(); expect(await currentWalletSession()).toBeNull();
  });
  it('refuses an invented session, another wallet signature and another origin', async () => {
    state.values.set(embeddedWalletCookie(WALLET_SESSION_COOKIE), 'fabricated');
    expect(await currentWalletSession()).toBeNull();
    const owner = createTestWallet(), other = createTestWallet(), challenge = await walletSignInChallenge(owner.address, 8453, true);
    if (!challenge.ok) throw Error(challenge.code);
    expect(await walletSignIn(owner.address, 8453, other.signMessage(challenge.value.message), true)).toEqual({ ok: false, code: 'WALLET_SIGNATURE_INVALID' });
    const next = await walletSignInChallenge(owner.address, 8453, true); if (!next.ok) throw Error(next.code);
    state.host = 'lookalike.test';
    expect(await walletSignIn(owner.address, 8453, owner.signMessage(next.value.message), true)).toEqual({ ok: false, code: 'WALLET_SIGN_IN_ORIGIN_MISMATCH' });
  });
});
