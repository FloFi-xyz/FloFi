// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Closed-beta product authorization, independent of Admin and financial authority. Plain Node: the same decisions run in the web BFF,
 * Railway API and durable workers. A Privy/OAuth email, a browser address, or an Admin role never creates a grant here.
 *
 * Only the explicit boarding operation calls `grant`, after its caller verifies the account. Returning requests use `require` with the
 * server-verified account session. `requireAccount` and `requireWallet` are internal primitives for an already authenticated external
 * ingress or a durable, owner-authorized worker; they are not authentication and must never receive an unproved browser identity.
 */
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { FLIGHT_DEFAULT_CALENDAR, type FlightCalendar } from './campaign.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type BetaAccessMode = 'open' | 'beta' | 'closed';
/** Unset keeps the current rollout open. Once configured, a typo is closed, never an implicit opt-out. Read at request time. */
export function betaAccessMode(env: Env = process.env): BetaAccessMode {
  const value = env.FLOFI_BETA_ACCESS;
  return value === undefined || value === 'open' ? 'open' : value === 'beta' ? 'beta' : 'closed';
}

export type BetaPrincipal = { readonly namespace: 'eip155' | 'solana'; readonly address: string };
export type BetaAccessCode = 'BETA_ACCESS_DENIED' | 'BETA_ACCESS_REVOKED' | 'BETA_NOT_OPEN' | 'BETA_WALLET_REQUIRED'
  | 'BETA_WALLET_NOT_LINKED' | 'BETA_SESSION_REQUIRED' | 'BETA_ACCESS_UNAVAILABLE' | 'BETA_CONFIGURATION_INVALID';
export type BetaAccessDecision = { readonly ok: true; readonly accountId: string } | { readonly ok: false; readonly code: BetaAccessCode };
type Source = { source: 'LIST' | 'INVITE' | 'PASS'; source_ref: string };
type GrantRow = Source & { revoked_at: Date | null };
const ACCOUNT = /^acct_[0-9a-f]{32}$/, SESSION = /^[0-9a-f]{32}$/;
const denied = (code: BetaAccessCode): BetaAccessDecision => ({ ok: false, code });
const at = (ms: number) => new Date(ms).toISOString();
const LOCK_CLASS = 734_003_225;

function principalOf(value: BetaPrincipal | undefined): BetaPrincipal | null {
  if (!value || typeof value.address !== 'string') return null;
  if (value.namespace === 'eip155' && /^0x[0-9a-fA-F]{40}$/.test(value.address)) return { namespace: value.namespace, address: value.address.toLowerCase() };
  return value.namespace === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.address) ? value : null;
}

export function createBetaAccessStore(host: { readonly db: Database; readonly tenantId: string }, calendar: FlightCalendar = FLIGHT_DEFAULT_CALENDAR) {
  const { db, tenantId } = host;
  const calendarCode = (now: number): BetaAccessCode | null => !Number.isSafeInteger(now) || !Number.isSafeInteger(calendar.boardingOpensAt)
    || !Number.isSafeInteger(calendar.listClosesAt) || calendar.listClosesAt > calendar.boardingOpensAt ? 'BETA_CONFIGURATION_INVALID'
    : now < calendar.boardingOpensAt ? 'BETA_NOT_OPEN' : null;

  /** Account claims only, never an email join. The group is re-read each time, so postponement takes effect for an existing grant. */
  async function sources(q: Queryable, accountId: string, now: number): Promise<Source[]> {
    return (await q.query<Source>(`SELECT 'LIST'::text AS source, e.entry_id AS source_ref FROM flight_access_claims c
      JOIN flight_list_entries e ON e.tenant_id = c.tenant_id AND e.entry_id = c.entry_id
      LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
      WHERE c.tenant_id = $1 AND c.account_id = $2 AND e.flight = 'FIRST'
        AND (e.batch_no IS NULL OR b.opens_at <= $3::timestamptz)
      UNION ALL SELECT 'INVITE'::text, code FROM flight_invites WHERE tenant_id = $1 AND redeemed_by = $2 AND redeemed_at IS NOT NULL
        AND revoked_at IS NULL AND (expires_at IS NULL OR redeemed_at < expires_at)
      UNION ALL SELECT 'PASS'::text, pass_id FROM flight_passes WHERE tenant_id = $1 AND account_id = $2 AND departed_at >= $4::timestamptz`,
    [tenantId, accountId, at(now), at(calendar.boardingOpensAt)])).rows;
  }

  async function requireAccountOn(q: Queryable, accountId: string, now: number, givenPrincipal?: BetaPrincipal): Promise<BetaAccessDecision> {
    const code = calendarCode(now);
    if (code) return denied(code);
    if (!ACCOUNT.test(accountId)) return denied('BETA_ACCESS_DENIED');
    const grant = (await q.query<GrantRow>('SELECT source, source_ref, revoked_at FROM flight_beta_grants WHERE tenant_id = $1 AND account_id = $2 FOR SHARE',
      [tenantId, accountId])).rows[0];
    if (!grant) return denied('BETA_ACCESS_DENIED');
    if (grant.revoked_at) return denied('BETA_ACCESS_REVOKED');
    if (!(await sources(q, accountId, now)).some(source => source.source === grant.source && source.source_ref === grant.source_ref))
      return denied('BETA_ACCESS_DENIED');
    const principal = principalOf(givenPrincipal);
    if (givenPrincipal && !principal) return denied('BETA_WALLET_NOT_LINKED');
    const wallets = await q.query(`SELECT 1 FROM flight_beta_wallets b JOIN flofi_account_wallets w
      ON w.tenant_id = b.tenant_id AND w.account_id = b.account_id AND w.address = b.address
        AND w.ecosystem = CASE b.namespace WHEN 'eip155' THEN 'EVM' ELSE 'SOLANA' END
      WHERE b.tenant_id = $1 AND b.account_id = $2 AND ($3::text IS NULL OR (b.namespace = $3 AND b.address = $4)) LIMIT 1`,
    [tenantId, accountId, principal?.namespace ?? null, principal?.address ?? null]);
    if (!wallets.rowCount) return denied(principal ? 'BETA_WALLET_NOT_LINKED' : 'BETA_WALLET_REQUIRED');
    return { ok: true, accountId };
  }

  /** Explicit Board operation only. It never revives a revoked grant and never authorizes signing or a financial operation. */
  async function grant(accountId: string, now: number): Promise<BetaAccessDecision> {
    const code = calendarCode(now);
    if (code) return denied(code);
    if (!ACCOUNT.test(accountId)) return denied('BETA_ACCESS_DENIED');
    try {
      return await db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [LOCK_CLASS, `${tenantId}:${accountId}`]);
        const existing = (await tx.query<GrantRow>('SELECT source, source_ref, revoked_at FROM flight_beta_grants WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE',
          [tenantId, accountId])).rows[0];
        if (existing?.revoked_at) return denied('BETA_ACCESS_REVOKED');
        const available = await sources(tx, accountId, now);
        // A later Board operation never changes the source of an existing grant or escapes a postponed group.
        const source = existing ? available.find(value => value.source === existing.source && value.source_ref === existing.source_ref) : available[0];
        if (!source) return denied('BETA_ACCESS_DENIED');
        const wallets = (await tx.query<{ namespace: 'eip155' | 'solana'; address: string }>(`SELECT
          CASE w.ecosystem WHEN 'EVM' THEN 'eip155' ELSE 'solana' END AS namespace, w.address FROM flofi_account_wallets w
          WHERE w.tenant_id = $1 AND w.account_id = $2 AND NOT EXISTS (SELECT 1 FROM flight_beta_wallets b
            WHERE b.tenant_id = w.tenant_id AND b.address = w.address AND b.namespace = CASE w.ecosystem WHEN 'EVM' THEN 'eip155' ELSE 'solana' END
              AND b.account_id <> w.account_id) FOR SHARE OF w`, [tenantId, accountId])).rows;
        if (!wallets.length) return denied('BETA_WALLET_REQUIRED');
        await tx.query(`INSERT INTO flight_beta_grants (tenant_id, account_id, source, source_ref, granted_at)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, account_id) DO NOTHING`, [tenantId, accountId, source.source, source.source_ref, at(now)]);
        for (const wallet of wallets) await tx.query(`INSERT INTO flight_beta_wallets (tenant_id, account_id, namespace, address, linked_at)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, namespace, address) DO NOTHING`, [tenantId, accountId, wallet.namespace, wallet.address, at(now)]);
        return requireAccountOn(tx, accountId, now);
      });
    } catch { return denied('BETA_ACCESS_UNAVAILABLE'); }
  }

  /** A request authenticated by the BFF: re-check its exact session record, including revocation, in this tenant. */
  async function requireAccess(input: { readonly accountId: string; readonly sessionId: string; readonly principal?: BetaPrincipal; readonly now: number }): Promise<BetaAccessDecision> {
    if (!ACCOUNT.test(input.accountId) || !SESSION.test(input.sessionId)) return denied('BETA_SESSION_REQUIRED');
    const code = calendarCode(input.now);
    if (code) return denied(code);
    try {
      return await db.transaction(async tx => {
        const session = await tx.query(`SELECT 1 FROM flofi_account_sessions WHERE tenant_id = $1 AND account_id = $2 AND session_id = $3
          AND revoked_at IS NULL AND expires_at > $4::timestamptz AND authenticated_at <= $4::timestamptz + interval '60 seconds' FOR SHARE`,
        [tenantId, input.accountId, input.sessionId, at(input.now)]);
        return session.rowCount ? requireAccountOn(tx, input.accountId, input.now, input.principal) : denied('BETA_SESSION_REQUIRED');
      });
    } catch { return denied('BETA_ACCESS_UNAVAILABLE'); }
  }

  /** Internal trusted ingress only; accountId has already been authenticated independently (for example an account-bound OAuth grant). */
  async function requireAccount(accountId: string, now: number, principal?: BetaPrincipal): Promise<BetaAccessDecision> {
    try { return await db.transaction(tx => requireAccountOn(tx, accountId, now, principal)); } catch { return denied('BETA_ACCESS_UNAVAILABLE'); }
  }

  /** Durable workers only: the operation's existing authorization proves the owner. This method adds beta policy, never wallet authority. */
  async function requireWallet(given: BetaPrincipal, now: number): Promise<BetaAccessDecision> {
    const principal = principalOf(given);
    if (!principal) return denied('BETA_WALLET_NOT_LINKED');
    try {
      return await db.transaction(async tx => {
        const row = (await tx.query<{ account_id: string }>(`SELECT account_id FROM flight_beta_wallets
          WHERE tenant_id = $1 AND namespace = $2 AND address = $3`, [tenantId, principal.namespace, principal.address])).rows[0];
        return row ? requireAccountOn(tx, row.account_id, now, principal) : denied('BETA_WALLET_NOT_LINKED');
      });
    } catch { return denied('BETA_ACCESS_UNAVAILABLE'); }
  }

  /** Operator tooling primitive only. The caller must establish operator authority and audit it; no public route is created here. */
  async function revoke(accountId: string, now: number): Promise<boolean> {
    if (!ACCOUNT.test(accountId) || !Number.isSafeInteger(now)) return false;
    return db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [LOCK_CLASS, `${tenantId}:${accountId}`]);
      return (await tx.query('UPDATE flight_beta_grants SET revoked_at = $3 WHERE tenant_id = $1 AND account_id = $2 AND revoked_at IS NULL',
        [tenantId, accountId, at(now)])).rowCount > 0;
    });
  }

  return { grant, require: requireAccess, requireAccount, requireWallet, revoke };
}
export type BetaAccessStore = ReturnType<typeof createBetaAccessStore>;
