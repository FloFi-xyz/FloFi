// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { betaAccessMode, createBetaAccessStore } from './beta-access';
import { FLIGHT_DEFAULT_CALENDAR } from './campaign';

describe('closed-beta deployment switch', () => {
  it('keeps rollout opt-in and refuses every malformed configured value', () => {
    expect(betaAccessMode({})).toBe('open');
    expect(betaAccessMode({ FLOFI_BETA_ACCESS: 'open' })).toBe('open');
    expect(betaAccessMode({ FLOFI_BETA_ACCESS: 'beta' })).toBe('beta');
    for (const value of ['', 'true', 'false', 'Beta', ' beta ', 'closed']) expect(betaAccessMode({ FLOFI_BETA_ACCESS: value })).toBe('closed');
  });
});

describe('closed-beta fail-closed boundaries', () => {
  const unavailable = () => {
    const query = vi.fn().mockRejectedValue(new Error('offline'));
    return { query, db: { query, transaction: async <T,>(work: (q: Database) => Promise<T>) => work({ query } as unknown as Database), close: vi.fn() } as Database };
  };
  const accountId = 'acct_' + 'a'.repeat(32), sessionId = 'b'.repeat(32), now = FLIGHT_DEFAULT_CALENDAR.boardingOpensAt;
  it('fails closed when storage is unavailable without exposing the database error', async () => {
    const { db } = unavailable(), store = createBetaAccessStore({ db, tenantId: 'default' });
    expect(await store.grant(accountId, now)).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE' });
    expect(await store.require({ accountId, sessionId, now })).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE' });
    expect(await store.requireAccount(accountId, now)).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE' });
    expect(await store.requireWallet({ namespace: 'eip155', address: '0x' + '1'.repeat(40) }, now)).toEqual({ ok: false, code: 'BETA_ACCESS_UNAVAILABLE' });
  });
  it('refuses early boarding before any query or reservation', async () => {
    const { db, query } = unavailable(), store = createBetaAccessStore({ db, tenantId: 'default' });
    expect(await store.grant(accountId, now - 1)).toEqual({ ok: false, code: 'BETA_NOT_OPEN' });
    expect(query).not.toHaveBeenCalled();
  });
  it('cannot turn a malformed calendar or identity into access', async () => {
    const { db, query } = unavailable();
    expect(await createBetaAccessStore({ db, tenantId: 'default' }, { ...FLIGHT_DEFAULT_CALENDAR, boardingOpensAt: NaN }).grant(accountId, now))
      .toEqual({ ok: false, code: 'BETA_CONFIGURATION_INVALID' });
    expect(await createBetaAccessStore({ db, tenantId: 'default' }).require({ accountId: 'operator', sessionId, now }))
      .toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });
});
