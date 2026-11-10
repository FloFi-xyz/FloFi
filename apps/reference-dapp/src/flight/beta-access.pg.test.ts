// SPDX-License-Identifier: AGPL-3.0-only
/** Real disposable loopback PostgreSQL; fixture accounts/wallets only. No provider, signature, mainnet or email is contacted. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createBetaAccessStore, type BetaAccessStore, type BetaPrincipal } from './beta-access';
import { FLIGHT_DEFAULT_CALENDAR } from './campaign';

const CAL = FLIGHT_DEFAULT_CALENDAR, OPEN = CAL.boardingOpensAt, hex = (n: number) => randomBytes(n).toString('hex');
let t: TestDatabase, gate: BetaAccessStore;
beforeAll(async () => { t = await createTestDatabase(); gate = createBetaAccessStore({ db: t.db, tenantId: 'default' }, CAL); });
afterAll(async () => { await t?.drop(); });
const iso = (ms: number) => new Date(ms).toISOString();

async function account(wallet = true, method: 'EMAIL' | 'EIP155' | 'GOOGLE' | 'APPLE' = 'EIP155', tenantId = 'default') {
  const accountId = `acct_${hex(16)}`, sessionId = hex(16), address = `0x${hex(20)}`;
  await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ($1, $2)', [tenantId, accountId]);
  await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id, account_id, session_id, method, authenticated_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, accountId, sessionId, method, iso(OPEN - 60_000), iso(OPEN + 86_400_000)]);
  if (wallet) await addWallet(accountId, address, tenantId);
  return { accountId, sessionId, principal: { namespace: 'eip155', address } as BetaPrincipal, now: OPEN };
}
async function addWallet(accountId: string, address: string, tenantId = 'default') {
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, export, label)
    VALUES ($1, $2, 'EVM', $3, 'EXTERNAL', 'fixture', 'Fixture wallet', 'NONE', 'Fixture wallet')`, [tenantId, accountId, address]);
}
async function listed(accountId: string, options: { batch?: number; flight?: 'FIRST' | 'NEXT'; claim?: boolean; tenantId?: string } = {}) {
  const entryId = `fle_${hex(16)}`, email = `${hex(6)}@example.test`, tenantId = options.tenantId ?? 'default';
  await t.db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, language, flight, notice, joined_at, batch_no)
    VALUES ($1, $2, $3, 'EN', $4, '2026-11-09', $5, $6)`, [tenantId, entryId, email, options.flight ?? 'FIRST', iso(CAL.listClosesAt - 60_000), options.batch ?? null]);
  if (options.claim !== false) await t.db.query('INSERT INTO flight_access_claims (tenant_id, entry_id, account_id) VALUES ($1, $2, $3)', [tenantId, entryId, accountId]);
  return { entryId, email };
}

describe('persisted closed-beta account and wallet authority', () => {
  it('refuses anonymous and authenticated-but-unlisted accounts, including Google and Apple', async () => {
    expect(await gate.require({ accountId: '', sessionId: '', now: OPEN })).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    for (const method of ['EMAIL', 'GOOGLE', 'APPLE'] as const) {
      const person = await account(true, method);
      expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
      expect(await gate.require(person)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    }
  });

  it('does not turn a verified Privy email matching the list into an unproved claim', async () => {
    const person = await account(), entry = await listed(person.accountId, { claim: false });
    await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, account_id, kind, subject, label)
      VALUES ('default', $1, 'EMAIL', $2, $2)`, [person.accountId, entry.email]);
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    expect((await t.db.query('SELECT 1 FROM flight_beta_grants WHERE account_id = $1', [person.accountId])).rowCount).toBe(0);
  });

  it('refuses a closed FIRST group, admits it at its opening, and rechecks later postponement', async () => {
    const person = await account(), batch = 711, later = OPEN + 60_000;
    await t.db.query(`INSERT INTO flight_batches (tenant_id, batch_no, opens_at) VALUES ('default', $1, $2)`, [batch, iso(later)]);
    await listed(person.accountId, { batch });
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    expect(await gate.grant(person.accountId, later)).toEqual({ ok: true, accountId: person.accountId });
    expect(await gate.require({ ...person, now: later })).toEqual({ ok: true, accountId: person.accountId });
    await t.db.query(`UPDATE flight_batches SET opens_at = $2 WHERE tenant_id = 'default' AND batch_no = $1`, [batch, iso(later + 60_000)]);
    expect(await gate.require({ ...person, now: later })).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });

  it('opens at exactly 09:00 BRT and never writes a grant early or grants NEXT entries', async () => {
    const person = await account(); await listed(person.accountId);
    expect(await gate.grant(person.accountId, OPEN - 1)).toEqual({ ok: false, code: 'BETA_NOT_OPEN' });
    expect((await t.db.query('SELECT 1 FROM flight_beta_grants WHERE account_id = $1', [person.accountId])).rowCount).toBe(0);
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: true, accountId: person.accountId });
    const next = await account(); await listed(next.accountId, { flight: 'NEXT' });
    expect(await gate.grant(next.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });

  it('persists the first proof and permits a later wallet login without another email', async () => {
    const first = await account(true, 'EMAIL'), entry = await listed(first.accountId);
    expect(await gate.grant(first.accountId, OPEN)).toEqual({ ok: true, accountId: first.accountId });
    const sessionId = hex(16);
    await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id, account_id, session_id, method, authenticated_at, expires_at)
      VALUES ('default', $1, $2, 'EIP155', $3, $4)`, [first.accountId, sessionId, iso(OPEN + 60_000), iso(OPEN + 3600_000)]);
    // The claim is persistent; identity email data is not consulted on return.
    await t.db.query(`UPDATE flight_list_entries SET email = $2 WHERE tenant_id = 'default' AND entry_id = $1`, [entry.entryId, `${hex(6)}@example.test`]);
    expect(await gate.require({ ...first, sessionId, now: OPEN + 60_000 })).toEqual({ ok: true, accountId: first.accountId });
  });

  it('requires the selected wallet to be beta-bound and still owned by the same account', async () => {
    const person = await account(); await listed(person.accountId); await gate.grant(person.accountId, OPEN);
    const other = await account(), newWallet = `0x${hex(20)}`;
    expect(await gate.require({ ...person, sessionId: other.sessionId })).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(await gate.require({ ...person, principal: other.principal })).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    await addWallet(person.accountId, newWallet);
    expect(await gate.require({ ...person, principal: { namespace: 'eip155', address: newWallet } })).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    // Only an explicit Board operation can extend beta bindings to a newly proved account wallet.
    await gate.grant(person.accountId, OPEN + 1);
    expect(await gate.require({ ...person, principal: { namespace: 'eip155', address: newWallet } })).toEqual({ ok: true, accountId: person.accountId });
    await t.db.query(`DELETE FROM flofi_account_wallets WHERE tenant_id = 'default' AND address = $1`, [person.principal.address]);
    expect(await gate.require(person)).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    expect(await gate.requireWallet(person.principal, OPEN)).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
  });

  it('refuses walletless accounts and does not transfer a prior binding to a different account', async () => {
    const empty = await account(false); await listed(empty.accountId);
    expect(await gate.grant(empty.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_WALLET_REQUIRED' });
    const original = await account(); await listed(original.accountId); await gate.grant(original.accountId, OPEN);
    await t.db.query(`DELETE FROM flofi_account_wallets WHERE tenant_id = 'default' AND account_id = $1`, [original.accountId]);
    await addWallet(empty.accountId, original.principal.address);
    expect(await gate.grant(empty.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_WALLET_REQUIRED' });
    expect(await gate.requireWallet(original.principal, OPEN)).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
  });

  it('revokes sessions immediately, rejects expiry, and cannot revive a revoked beta grant by boarding again', async () => {
    const person = await account(); await listed(person.accountId); await gate.grant(person.accountId, OPEN);
    expect(await gate.require(person)).toEqual({ ok: true, accountId: person.accountId });
    await t.db.query(`UPDATE flofi_account_sessions SET revoked_at = $2 WHERE tenant_id = 'default' AND session_id = $1`, [person.sessionId, iso(OPEN)]);
    expect(await gate.require(person)).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(await gate.require({ ...person, now: OPEN + 86_400_000 })).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(await gate.revoke(person.accountId, OPEN)).toBe(true);
    expect(await gate.revoke(person.accountId, OPEN)).toBe(false);
    expect(await gate.requireAccount(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_REVOKED' });
    expect(await gate.requireWallet(person.principal, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_REVOKED' });
    expect(await gate.grant(person.accountId, OPEN + 1)).toEqual({ ok: false, code: 'BETA_ACCESS_REVOKED' });
  });

  it('preserves account and wallet isolation across tenants', async () => {
    const person = await account(); await listed(person.accountId); await gate.grant(person.accountId, OPEN);
    const tenantId = `gate-${hex(4)}`;
    await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', [tenantId]);
    const other = createBetaAccessStore({ db: t.db, tenantId }, CAL);
    expect(await other.require(person)).toEqual({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(await other.requireWallet(person.principal, OPEN)).toEqual({ ok: false, code: 'BETA_WALLET_NOT_LINKED' });
    expect(await other.grant(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });

  it('accepts a redeemed invitation after opening, without granting an unredeemed code', async () => {
    const person = await account(), code = 'FLF-2345-6789';
    await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer) VALUES ('default', $1, 'CREATOR')`, [code]);
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
    await t.db.query(`UPDATE flight_invites SET redeemed_by = $2, redeemed_at = $3 WHERE tenant_id = 'default' AND code = $1`, [code, person.accountId, iso(OPEN)]);
    expect(await gate.grant(person.accountId, OPEN - 1)).toEqual({ ok: false, code: 'BETA_NOT_OPEN' });
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: true, accountId: person.accountId });
    expect(await gate.require(person)).toEqual({ ok: true, accountId: person.accountId });
    await t.db.query(`UPDATE flight_invites SET revoked_at = $2 WHERE tenant_id = 'default' AND code = $1`, [code, iso(OPEN)]);
    expect(await gate.require(person)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });

  it('keeps a legitimately redeemed invitation persistent after the code expires', async () => {
    const person = await account(), code = 'FLF-ABCD-EFGH';
    await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, redeemed_by, redeemed_at, expires_at)
      VALUES ('default', $1, 'CREATOR', $2, $3, $4)`, [code, person.accountId, iso(OPEN), iso(OPEN + 60_000)]);
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: true, accountId: person.accountId });
    expect(await gate.require({ ...person, now: OPEN + 60_000 })).toEqual({ ok: true, accountId: person.accountId });
    // A redemption that was already expired is never promoted to a product grant, even if an old writer inserted it.
    const expired = await account();
    await t.db.query(`INSERT INTO flight_invites (tenant_id, code, issuer, redeemed_by, redeemed_at, expires_at)
      VALUES ('default', 'FLF-JKLM-NPQR', 'CREATOR', $1, $2, $2)`, [expired.accountId, iso(OPEN)]);
    expect(await gate.grant(expired.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });

  it('accepts a legitimate historical pass after opening, and never ties access to public card visibility', async () => {
    const person = await account();
    await t.db.query(`INSERT INTO flight_passes (tenant_id, account_id, pass_id, origin, boarding_no, route, run_id, departed_at, removed_at)
      VALUES ('default', $1, $2, 'LIST', 999001, '{}'::jsonb, 'fixture-simulation', $3, $3)`, [person.accountId, `flp_${hex(16)}`, iso(OPEN)]);
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: true, accountId: person.accountId });
    expect(await gate.require(person)).toEqual({ ok: true, accountId: person.accountId });
  });

  it('does not promote a card dated before the official opening to product authority', async () => {
    const person = await account();
    await t.db.query(`INSERT INTO flight_passes (tenant_id, account_id, pass_id, origin, boarding_no, route, run_id, departed_at)
      VALUES ('default', $1, $2, 'CREATOR', 999002, '{}'::jsonb, 'fixture-simulation', $3)`, [person.accountId, `flp_${hex(16)}`, iso(OPEN - 1)]);
    expect(await gate.grant(person.accountId, OPEN)).toEqual({ ok: false, code: 'BETA_ACCESS_DENIED' });
  });

  it('serializes repeated boarding without duplicate grants or wallet bindings', async () => {
    const person = await account(); await listed(person.accountId);
    const results = await Promise.all(Array.from({ length: 12 }, () => gate.grant(person.accountId, OPEN)));
    expect(results.every(result => result.ok)).toBe(true);
    expect((await t.db.query('SELECT 1 FROM flight_beta_grants WHERE account_id = $1', [person.accountId])).rowCount).toBe(1);
    expect((await t.db.query('SELECT 1 FROM flight_beta_wallets WHERE account_id = $1', [person.accountId])).rowCount).toBe(1);
  });
});
