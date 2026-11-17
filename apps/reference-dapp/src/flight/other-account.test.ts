// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Authentication UX & Login Regression Fix (P0): the person's OTHER account (closed beta, no beta access of its own, a strongly verified address
 * held by another account) lands on /board's recovery instead of wallet onboarding. The database is stubbed here; the browser suite runs the
 * whole path on PostgreSQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = { grant: false, holder: null as string | null };
vi.mock('../server/platform-state-host', () => ({ platformStateHost: async () => ({ tenantId: 'default', db: { query: async (sql: string) => ({
  rows: sql.includes('flight_beta_grants') ? (rows.grant ? [{ '?column?': 1 }] : [])
    : sql.includes('flight_list_entries') ? (rows.holder ? [{ entry_id: 'fle_1', language: 'EN', opens_at: null, boarded_at: new Date(), account_id: rows.holder }] : [])
    : [] }) } }) }));
import { isOtherAccountOfBoardedPerson, otherAccountDestination } from './other-account';
import { strongEmailsOf } from './held-elsewhere';

const beta = { FLOFI_BETA_ACCESS: 'beta' };
const google = [{ kind: 'google', label: 'Person@Gmail.com' }];
beforeEach(() => { rows.grant = false; rows.holder = 'acct_boarded'; });

describe('the person’s other account', () => {
  it('counts only email-code addresses and Google sign-ins on Google’s own mail domain as strongly verified', () => {
    expect(strongEmailsOf([{ kind: 'google', label: 'a@gmail.com' }, { kind: 'google', label: 'b@company.com' }, { kind: 'email', label: 'c@company.com' },
      { kind: 'apple', label: 'd@icloud.com' }, { kind: 'eip155', label: null }])).toEqual(['a@gmail.com', 'c@company.com']);
  });
  it('is the one with no beta access whose verified address another account holds, in closed beta only', async () => {
    expect(await isOtherAccountOfBoardedPerson('acct_other', google, beta)).toBe(true);
    // The boarded account itself, an account with beta access of its own (even revoked), an address nobody holds: not this case.
    expect(await isOtherAccountOfBoardedPerson('acct_boarded', google, beta)).toBe(false);
    rows.grant = true;
    expect(await isOtherAccountOfBoardedPerson('acct_other', google, beta)).toBe(false);
    rows.grant = false; rows.holder = null;
    expect(await isOtherAccountOfBoardedPerson('acct_other', google, beta)).toBe(false);
    rows.holder = 'acct_boarded';
    // A weak address (Google on another domain), and deployments that are not in closed beta, keep the usual destinations.
    expect(await isOtherAccountOfBoardedPerson('acct_other', [{ kind: 'google', label: 'p@company.com' }], beta)).toBe(false);
    expect(await isOtherAccountOfBoardedPerson('acct_other', google, { FLOFI_BETA_ACCESS: 'open' })).toBe(false);
    expect(await isOtherAccountOfBoardedPerson('acct_other', google, {})).toBe(false);
  });
  it('replaces only wallet onboarding and the product with /board; any other destination is kept', () => {
    for (const next of ['/onboarding/wallets', '/onboarding', '/app', '/app/credentials', '/app?x=1']) expect(otherAccountDestination(next), next).toBe('/board');
    for (const next of ['/board', '/board?board=1', '/account/sign-in-methods', '/apply', '/onboardingx']) expect(otherAccountDestination(next), next).toBe(next);
  });
});
