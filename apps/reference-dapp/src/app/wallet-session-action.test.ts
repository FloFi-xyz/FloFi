// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet';
import { solanaSignIn, solanaSignInChallenge, solanaSignOut, walletSignIn, walletSignInChallenge, walletSignOut } from './wallet-session-action';
import { currentSolanaSession, currentWalletSession } from '../server/session-principal';
import { SOLANA_SESSION_COOKIE, WALLET_SESSION_COOKIE } from '../server/wallet-session';
import { embeddedWalletCookie } from '../server/embedded-approval';
import { sessionCookieName } from '../server/session-cookie';
import { generateKeyPairSync, sign } from 'node:crypto';
import { base58Encode } from '@defi-workflow-engine/reference-compiler';

const state = vi.hoisted(() => ({ values: new Map<string, string>(), writes: [] as { name: string; options: Record<string, unknown> }[], host: 'flofi.xyz', path: '/mcp/approve' as string | null }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: state.host, ...state.path === null ? {} : { 'x-flofi-pathname': state.path } }),
  cookies: async () => ({ get: (name: string) => state.values.has(name) ? { value: state.values.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.writes.push({ name, options }); if (options.maxAge === 0) state.values.delete(name); else state.values.set(name, value);
    }, delete: (name: string) => state.values.delete(name) }),
}));
beforeEach(() => { state.values.clear(); state.writes = []; state.host = 'flofi.xyz'; state.path = '/mcp/approve'; vi.stubEnv('FLOFI_SESSION_SECRET', randomBytes(32).toString('hex')); });
afterEach(() => vi.unstubAllEnvs());

describe('wallet proof inside MCP Apps', () => {
  it('still requires a genuine wallet signature; seals only an isolated HttpOnly session and consumes the challenge', async () => {
    const owner = createTestWallet(), challenge = await walletSignInChallenge(owner.address, 8453, true);
    expect(challenge.ok).toBe(true); if (!challenge.ok) return;
    expect(state.writes[0]).toMatchObject({ name: '__Host-embedded_flofi_wallet_challenge', options: {
      httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: '/',
    } });
    const result = await walletSignIn(owner.address, 8453, owner.signMessage(challenge.value.message), true);
    expect(result).toMatchObject({ ok: true, value: { account: owner.address } });
    expect(result).not.toHaveProperty('token');
    expect(state.values.has('__Host-embedded_flofi_wallet_challenge')).toBe(false);
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
  it('reads embedded authority only on the proxy-verified MCP path and refuses creating it elsewhere', async () => {
    const owner = createTestWallet(), challenge = await walletSignInChallenge(owner.address, 8453, true);
    if (!challenge.ok) throw Error(challenge.code);
    expect(await walletSignIn(owner.address, 8453, owner.signMessage(challenge.value.message), true)).toMatchObject({ ok: true });
    expect(await currentWalletSession()).toMatchObject({ account: owner.address });
    for (const path of ['/app', '/app/credentials', '/mcp/approve/extra', null]) {
      state.path = path;
      expect(await currentWalletSession()).toBeNull();
      expect(await walletSignInChallenge(owner.address, 8453, true)).toEqual({ ok: false, code: 'WALLET_SESSION_CONTEXT_INVALID' });
    }
  });
  it('uses host-prefixed HTTPS proofs without accepting a legacy cookie as a fallback, and preserves HTTP loopback', async () => {
    const owner = createTestWallet();
    state.path = '/app';
    const challenge = await walletSignInChallenge(owner.address, 8453);
    if (!challenge.ok) throw Error(challenge.code);
    expect(state.writes[0]).toMatchObject({ name: '__Host-flofi_wallet_challenge', options: { secure: true, path: '/' } });
    expect(await walletSignIn(owner.address, 8453, owner.signMessage(challenge.value.message))).toMatchObject({ ok: true });
    const current = sessionCookieName(WALLET_SESSION_COOKIE, true), token = state.values.get(current)!;
    state.values.set(WALLET_SESSION_COOKIE, token); state.values.delete(current);
    expect(await currentWalletSession()).toBeNull();
    state.values.set(current, token); state.values.set(WALLET_SESSION_COOKIE, 'attacker-cookie');
    expect(await currentWalletSession()).toMatchObject({ account: owner.address });
    await walletSignOut(); expect(state.values.has(current)).toBe(false); expect(state.values.has(WALLET_SESSION_COOKIE)).toBe(false);
    state.host = '127.0.0.1:3148';
    const local = await walletSignInChallenge(owner.address, 8453); if (!local.ok) throw Error(local.code);
    expect(await walletSignIn(owner.address, 8453, owner.signMessage(local.value.message))).toMatchObject({ ok: true });
    expect(state.values.has(WALLET_SESSION_COOKIE)).toBe(true);
    expect(await currentWalletSession()).toMatchObject({ account: owner.address });
  });
  it('keeps Solana proofs host-prefixed and isolates an embedded session from first-party pages', async () => {
    const key = generateKeyPairSync('ed25519'), der = key.publicKey.export({ type: 'spki', format: 'der' });
    const address = base58Encode(new Uint8Array(der.subarray(-32)));
    const challenge = await solanaSignInChallenge(address, true); if (!challenge.ok) throw Error(challenge.code);
    // verifySolanaSignIn accepts only standard base64 (not base58) Ed25519 signatures, matching the browser SIWS path.
    const signature = sign(null, Buffer.from(challenge.value.message), key.privateKey).toString('base64');
    expect(await solanaSignIn(address, signature, true)).toMatchObject({ ok: true, value: { account: address } });
    expect(await currentSolanaSession()).toMatchObject({ account: address });
    state.path = '/app'; expect(await currentSolanaSession()).toBeNull();
    const primary = await solanaSignInChallenge(address); if (!primary.ok) throw Error(primary.code);
    const primarySignature = sign(null, Buffer.from(primary.value.message), key.privateKey).toString('base64');
    expect(await solanaSignIn(address, primarySignature)).toMatchObject({ ok: true });
    const current = sessionCookieName(SOLANA_SESSION_COOKIE, true), token = state.values.get(current)!;
    state.values.set(SOLANA_SESSION_COOKIE, token); state.values.delete(current);
    expect(await currentSolanaSession()).toBeNull();
    state.values.set(current, token);
    await solanaSignOut();
    expect(state.values.has(current)).toBe(false); expect(state.values.has(SOLANA_SESSION_COOKIE)).toBe(false);
    state.path = '/mcp/approve'; expect(await currentSolanaSession()).toBeNull();
  });
});
