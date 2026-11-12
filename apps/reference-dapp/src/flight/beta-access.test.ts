// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { betaAccessMode, betaEarlyAccessAccounts, createBetaAccessStore } from './beta-access';
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

describe('temporary team allowlist configuration', () => {
  const accountId = 'acct_' + 'a'.repeat(32), second = 'acct_' + 'b'.repeat(32);
  const env = { FLOFI_BETA_ACCESS: 'beta', FLOFI_BETA_EARLY_ACCESS_TENANT: 'default' };
  it('accepts only exact stable account IDs in an explicitly matching tenant', () => {
    expect(betaEarlyAccessAccounts({ ...env, FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: `${accountId},${second}` }, 'default')).toEqual([accountId, second]);
    expect(betaEarlyAccessAccounts({ ...env, FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: accountId }, 'other')).toEqual([]);
  });
  it('disables the whole exception on absent, empty, duplicate, oversized or malformed configuration', () => {
    for (const value of [undefined, '', ' ', accountId + ',', ',' + accountId, `${accountId},${accountId}`, `${accountId},bad`, ` ${accountId}`,
      `${accountId}\n`, accountId.toUpperCase(), 'founder@example.test', '0x' + 'a'.repeat(40), Array.from({ length: 101 }, (_, i) => 'acct_' + i.toString(16).padStart(32, '0')).join(',')]) {
      expect(betaEarlyAccessAccounts({ ...env, FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: value }, 'default')).toEqual([]);
    }
    for (const tenant of [undefined, '', 'Default', ' default', 'default\n']) {
      expect(betaEarlyAccessAccounts({ ...env, FLOFI_BETA_EARLY_ACCESS_TENANT: tenant, FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: accountId }, 'default')).toEqual([]);
    }
    for (const mode of [undefined, 'open', 'closed', 'Beta']) {
      expect(betaEarlyAccessAccounts({ ...env, FLOFI_BETA_ACCESS: mode, FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: accountId }, 'default')).toEqual([]);
    }
  });
});

it('rechecks the fixed cutoff after database I/O and falls back to normal grants', async () => {
  const accountId = 'acct_' + 'c'.repeat(32), clock = vi.spyOn(Date, 'now').mockReturnValue(FLIGHT_DEFAULT_CALENDAR.boardingOpensAt - 1);
  let count = 0;
  const query = vi.fn(async () => {
    count++;
    if (count === 2) clock.mockReturnValue(FLIGHT_DEFAULT_CALENDAR.boardingOpensAt);
    return { rows: [], rowCount: count <= 2 ? 1 : 0 };
  });
  const db = { query, transaction: async <T,>(work: (q: Database) => Promise<T>) => work({ query } as unknown as Database) } as unknown as Database;
  try {
    const gate = createBetaAccessStore({ db, tenantId: 'default' }, FLIGHT_DEFAULT_CALENDAR, {
      FLOFI_BETA_ACCESS: 'beta', FLOFI_BETA_EARLY_ACCESS_TENANT: 'default', FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: accountId,
    });
    expect(await gate.requireAccount(accountId, FLIGHT_DEFAULT_CALENDAR.boardingOpensAt)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    expect(query).toHaveBeenCalledTimes(3);
  } finally { clock.mockRestore(); }
});
