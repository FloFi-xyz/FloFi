// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: proof that a person reads a beta-list address, and its binding to the FloFi account they sign in with
 * (migration 0024). This is CAMPAIGN access only: it never signs anyone in, never creates an account, never adds an identity or a wallet to an
 * account and never authorizes anything financial. FloFi's own login (Privy) stays the only way into an account.
 *
 * - Email 3 (and a requested access email) carries a link token and a six-digit code derived from that email (access.ts); this store keeps
 *   their digests. Opening the link consumes nothing: the "Continue" page posts the token, and only then is it consumed (single use).
 * - A consumed link or code binds the list entry to the signed-in account (`flight_access_claims`: one account per entry, one entry per
 *   account), or, before sign-in, to an HttpOnly browser session (24 hours) that binds only when the person presses "Board now" signed in.
 * - An entry already bound to another account is never rebound (no takeover by a forwarded link); the token is then left unused.
 * - Limits: code tries per client and per address, link requests per address and per client, link uses per client (keyed digests only).
 */
import { randomBytes } from 'node:crypto';
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { ACCESS_LIMITS, ACCESS_LINK_MS, ACCESS_SESSION_MS, CODE_MAX_ATTEMPTS, codeFor, codeHash, LINK_TOKEN, linkTokenFor, NO_CLIENT_SUBJECT, REQUESTED_CODE_MS, sameHex,
  sha256Hex, subjectDigest, tokenIdFor } from './access.ts';
import { enqueueEmail, maskAddress } from './email/outbox.ts';

const at = (ms: number) => new Date(ms).toISOString();
const HOUR_MS = 3_600_000;
export type ConsumeResult =
  | { readonly status: 'CLAIMED' }
  | { readonly status: 'SESSION'; readonly session: string }
  | { readonly status: 'INVALID' | 'EXPIRED' | 'USED' | 'BOARDED' | 'CLAIMED_ELSEWHERE' | 'ACCOUNT_HAS_OTHER_ENTRY' | 'RATE_LIMITED' };
const ATTEMPT_LOCK_CLASS = 734_003_223; // Advisory lock class (int4): one count-and-record at a time per limit subject.
type AttemptKind = 'CODE_CLIENT' | 'CODE_ADDRESS' | 'REQUEST_CLIENT' | 'REQUEST_ADDRESS' | 'CONSUME_CLIENT';

export function createAccessStore(host: { readonly db: Database; readonly tenantId: string }, secret: string) {
  const { db, tenantId } = host;

  /**
   * Count and record one attempt; true when the subject is still within `limit` per hour. Serialized per subject (concurrent requests cannot
   * all slip past the count), and a request without a client address counts under one shared subject: never exempt.
   */
  async function attempt(q: Queryable, kind: AttemptKind, value: string | null, limit: number, now: number): Promise<boolean> {
    const subject = subjectDigest(secret, kind, value ?? NO_CLIENT_SUBJECT);
    await q.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [ATTEMPT_LOCK_CLASS, `${kind}:${subject}`]);
    const recent = Number((await q.query<{ n: string }>(`SELECT count(*) AS n FROM flight_access_attempts WHERE tenant_id = $1 AND kind = $2 AND subject = $3
      AND attempted_at > $4::timestamptz - interval '1 hour'`, [tenantId, kind, subject, at(now)])).rows[0]!.n);
    if (recent >= limit) return false;
    await q.query('INSERT INTO flight_access_attempts (tenant_id, kind, subject, attempted_at) VALUES ($1, $2, $3, $4)', [tenantId, kind, subject, at(now)]);
    return true;
  }

  /**
   * The link and code one access email carries, recorded once (a re-render of the same email finds the same row: same token, same expiry).
   * `codeMs`: Email 3's code lives as long as its link; a code requested at /board, 15 minutes.
   */
  async function issueToken(input: { readonly emailId: string; readonly entryId: string; readonly codeMs: number; readonly now: number }, q: Queryable = db) {
    const tokenId = tokenIdFor(secret, input.emailId), link = linkTokenFor(secret, input.emailId), code = codeFor(secret, input.emailId);
    await q.query(`INSERT INTO flight_access_tokens (tenant_id, token_id, entry_id, purpose, link_hash, code_hash, created_at, link_expires_at, code_expires_at)
      VALUES ($1, $2, $3, 'BOARDING', $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, token_id) DO NOTHING`,
    [tenantId, tokenId, input.entryId, sha256Hex(link), codeHash(secret, tokenId, code), at(input.now), at(input.now + ACCESS_LINK_MS), at(input.now + input.codeMs)]);
    const row = (await q.query<{ link_expires_at: Date; code_expires_at: Date; created_at: Date }>(`SELECT created_at, link_expires_at, code_expires_at FROM flight_access_tokens
      WHERE tenant_id = $1 AND token_id = $2`, [tenantId, tokenId])).rows[0]!;
    return { link, code, linkHours: Math.round((row.link_expires_at.getTime() - row.created_at.getTime()) / HOUR_MS),
      codeMinutes: Math.round((row.code_expires_at.getTime() - row.created_at.getTime()) / 60_000) };
  }

  /** Bind `entryId` to the account (in the caller's transaction). */
  async function claim(q: Queryable, entryId: string, accountId: string, now: number): Promise<'CLAIMED' | 'CLAIMED_ELSEWHERE' | 'ACCOUNT_HAS_OTHER_ENTRY'> {
    const owner = (await q.query<{ account_id: string }>('SELECT account_id FROM flight_access_claims WHERE tenant_id = $1 AND entry_id = $2 FOR UPDATE', [tenantId, entryId])).rows[0];
    if (owner) return owner.account_id === accountId ? 'CLAIMED' : 'CLAIMED_ELSEWHERE';
    const other = (await q.query('SELECT 1 FROM flight_access_claims WHERE tenant_id = $1 AND account_id = $2', [tenantId, accountId])).rowCount;
    if (other) return 'ACCOUNT_HAS_OTHER_ENTRY';
    const inserted = await q.query(`INSERT INTO flight_access_claims (tenant_id, entry_id, account_id, claimed_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, entryId, accountId, at(now)]);
    return inserted.rowCount ? 'CLAIMED' : 'CLAIMED_ELSEWHERE';
  }

  /**
   * Consume a token for an entry: bind it to the account, or open a browser session before sign-in. An entry that already boarded is never
   * bound again (a used list entry cannot be handed to someone else's account); its token is left unused.
   */
  async function settle(q: Queryable, tokenId: string, entryId: string, accountId: string | null, now: number): Promise<ConsumeResult> {
    if ((await q.query('SELECT 1 FROM flight_list_entries WHERE tenant_id = $1 AND entry_id = $2 AND boarded_at IS NOT NULL', [tenantId, entryId])).rowCount)
      return { status: 'BOARDED' };
    if (accountId) {
      const bound = await claim(q, entryId, accountId, now);
      if (bound !== 'CLAIMED') return { status: bound };
      await q.query('UPDATE flight_access_tokens SET consumed_at = $3 WHERE tenant_id = $1 AND token_id = $2', [tenantId, tokenId, at(now)]);
      return { status: 'CLAIMED' };
    }
    const session = randomBytes(32).toString('base64url');
    await q.query('UPDATE flight_access_tokens SET consumed_at = $3 WHERE tenant_id = $1 AND token_id = $2', [tenantId, tokenId, at(now)]);
    await q.query(`INSERT INTO flight_access_sessions (tenant_id, session_hash, entry_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, sha256Hex(session), entryId, at(now), at(now + ACCESS_SESSION_MS)]);
    return { status: 'SESSION', session };
  }

  /** The person pressed "Continue" on the link's page. `client`: a network client for the rate limit (null when unknown). */
  async function consumeLink(input: { readonly token: string; readonly accountId: string | null; readonly client: string | null; readonly now: number }): Promise<ConsumeResult> {
    if (!LINK_TOKEN.test(input.token)) return { status: 'INVALID' };
    return db.transaction(async tx => {
      if (!await attempt(tx, 'CONSUME_CLIENT', input.client, ACCESS_LIMITS.consumePerClientHour, input.now)) return { status: 'RATE_LIMITED' } as const;
      const row = (await tx.query<{ token_id: string; entry_id: string; link_expires_at: Date; consumed_at: Date | null; revoked_at: Date | null }>(`SELECT token_id, entry_id,
        link_expires_at, consumed_at, revoked_at FROM flight_access_tokens WHERE tenant_id = $1 AND link_hash = $2 FOR UPDATE`, [tenantId, sha256Hex(input.token)])).rows[0];
      if (!row || row.revoked_at) return { status: 'INVALID' } as const;
      if (row.consumed_at) return { status: 'USED' } as const;
      if (row.link_expires_at.getTime() <= input.now) return { status: 'EXPIRED' } as const;
      return settle(tx, row.token_id, row.entry_id, input.accountId, input.now);
    });
  }

  /** The person typed their address and the six-digit code (another device). The same answer for an unknown address and a wrong code. */
  async function consumeCode(input: { readonly email: string; readonly code: string; readonly accountId: string | null; readonly client: string | null; readonly now: number }): Promise<ConsumeResult> {
    return db.transaction(async tx => {
      if (!await attempt(tx, 'CODE_CLIENT', input.client, ACCESS_LIMITS.codePerClientHour, input.now)) return { status: 'RATE_LIMITED' } as const;
      if (!await attempt(tx, 'CODE_ADDRESS', input.email, ACCESS_LIMITS.codePerAddressHour, input.now)) return { status: 'RATE_LIMITED' } as const;
      const tokens = (await tx.query<{ token_id: string; entry_id: string; code_hash: string }>(`SELECT t.token_id, t.entry_id, t.code_hash FROM flight_access_tokens t
        JOIN flight_list_entries e ON e.tenant_id = t.tenant_id AND e.entry_id = t.entry_id
        WHERE t.tenant_id = $1 AND e.email = $2 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.code_expires_at > $3 AND t.code_attempts < $4
        ORDER BY t.created_at DESC LIMIT 5 FOR UPDATE OF t`, [tenantId, input.email, at(input.now), CODE_MAX_ATTEMPTS])).rows;
      const match = tokens.find(token => sameHex(token.code_hash, codeHash(secret, token.token_id, input.code)));
      if (!match) {
        if (tokens.length) await tx.query(`UPDATE flight_access_tokens SET code_attempts = code_attempts + 1 WHERE tenant_id = $1 AND token_id = ANY($2::text[])`,
          [tenantId, tokens.map(token => token.token_id)]);
        return { status: 'INVALID' } as const;
      }
      return settle(tx, match.token_id, match.entry_id, input.accountId, input.now);
    });
  }

  /**
   * "Send me a link": always answered the same way (no address is confirmed or denied). An email goes out only when the address is on the
   * beta list, has not boarded, and its group is open (`groupOpen` decides with the deployment's calendar).
   */
  async function requestAccess(input: { readonly email: string; readonly language: 'EN' | 'PT'; readonly client: string | null; readonly now: number;
    readonly groupOpen: (entry: { readonly opensAt: number | null }) => boolean }): Promise<'OK' | 'RATE_LIMITED'> {
    return db.transaction(async tx => {
      if (!await attempt(tx, 'REQUEST_CLIENT', input.client, ACCESS_LIMITS.requestPerClientHour, input.now)) return 'RATE_LIMITED' as const;
      if (!await attempt(tx, 'REQUEST_ADDRESS', input.email, ACCESS_LIMITS.requestPerAddressHour, input.now)) return 'OK' as const; // Silent: no confirmation of the address.
      const entry = (await tx.query<{ entry_id: string; language: 'EN' | 'PT'; opens_at: Date | null }>(`SELECT e.entry_id, e.language, b.opens_at FROM flight_list_entries e
        LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
        WHERE e.tenant_id = $1 AND e.email = $2 AND e.flight = 'FIRST' AND e.boarded_at IS NULL`, [tenantId, input.email])).rows[0];
      if (!entry || !input.groupOpen({ opensAt: entry.opens_at?.getTime() ?? null })) return 'OK' as const;
      // A tenant-wide daily cap keeps requests from eating the email quota Email 3 needs (silent, like every other refusal here).
      const today = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM flight_emails WHERE tenant_id = $1 AND template = 'ACCESS_REQUESTED'
        AND created_at > $2::timestamptz - interval '1 day'`, [tenantId, at(input.now)])).rows[0]!.n);
      if (today >= ACCESS_LIMITS.requestedEmailsPerDay) return 'OK' as const;
      // At most one per entry per hour (the dedupe key): repeated requests collapse into the one already queued.
      await enqueueEmail(tx, tenantId, { template: 'ACCESS_REQUESTED', recipient: input.email, language: input.language, trigger: 'access_requested',
        dedupeKey: `access:${entry.entry_id}:${Math.floor(input.now / HOUR_MS)}`, notBefore: input.now, expiresAt: input.now + REQUESTED_CODE_MS, entryId: entry.entry_id });
      return 'OK' as const;
    });
  }

  /** A signed-in request carrying a pending browser session: bind its entry to the account. The session ends either way. */
  async function bindSession(input: { readonly session: string; readonly accountId: string; readonly now: number }):
    Promise<'CLAIMED' | 'NONE' | 'CLAIMED_ELSEWHERE' | 'ACCOUNT_HAS_OTHER_ENTRY'> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.session)) return 'NONE';
    return db.transaction(async tx => {
      const row = (await tx.query<{ entry_id: string }>(`DELETE FROM flight_access_sessions WHERE tenant_id = $1 AND session_hash = $2 AND expires_at > $3 RETURNING entry_id`,
        [tenantId, sha256Hex(input.session), at(input.now)])).rows[0];
      if (!row) return 'NONE';
      // An entry that boarded meanwhile is never bound to another account (as for a link or code).
      if ((await tx.query('SELECT 1 FROM flight_list_entries WHERE tenant_id = $1 AND entry_id = $2 AND boarded_at IS NOT NULL', [tenantId, row.entry_id])).rowCount) return 'NONE';
      return claim(tx, row.entry_id, input.accountId, input.now);
    });
  }

  /**
   * What the Continue page shows before the person confirms: the masked address the link proves (a***@gmail.com), so nobody links an
   * address they do not recognize. Nothing is consumed; a link that cannot be used answers like an invalid one.
   */
  async function peekLink(input: { readonly token: string; readonly client: string | null; readonly now: number }): Promise<{ readonly address: string } | 'INVALID' | 'RATE_LIMITED'> {
    if (!LINK_TOKEN.test(input.token)) return 'INVALID';
    return db.transaction(async tx => {
      if (!await attempt(tx, 'CONSUME_CLIENT', input.client, ACCESS_LIMITS.consumePerClientHour, input.now)) return 'RATE_LIMITED' as const;
      const row = (await tx.query<{ email: string }>(`SELECT e.email FROM flight_access_tokens t JOIN flight_list_entries e ON e.tenant_id = t.tenant_id
        AND e.entry_id = t.entry_id WHERE t.tenant_id = $1 AND t.link_hash = $2 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.link_expires_at > $3
        AND e.boarded_at IS NULL`, [tenantId, sha256Hex(input.token), at(input.now)])).rows[0];
      return row ? { address: maskAddress(row.email) } : 'INVALID' as const;
    });
  }

  /** Retention: attempts after one day; tokens seven days after they expired or were used; sessions when they expire. */
  async function prune(now: number) {
    return db.transaction(async tx => ({
      attempts: (await tx.query(`DELETE FROM flight_access_attempts WHERE tenant_id = $1 AND attempted_at < $2::timestamptz - interval '1 day'`, [tenantId, at(now)])).rowCount,
      tokens: (await tx.query(`DELETE FROM flight_access_tokens WHERE tenant_id = $1 AND greatest(link_expires_at, coalesce(consumed_at, link_expires_at)) < $2::timestamptz - interval '7 days'`,
        [tenantId, at(now)])).rowCount,
      sessions: (await tx.query('DELETE FROM flight_access_sessions WHERE tenant_id = $1 AND expires_at < $2', [tenantId, at(now)])).rowCount,
    }));
  }
  /** Operator: void every unused link and code of an address (a forwarded or leaked email). */
  async function revokeEntryTokens(entryId: string, now: number): Promise<number> {
    return (await db.query('UPDATE flight_access_tokens SET revoked_at = $3 WHERE tenant_id = $1 AND entry_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL',
      [tenantId, entryId, at(now)])).rowCount;
  }

  return { issueToken, peekLink, consumeLink, consumeCode, requestAccess, bindSession, prune, revokeEntryTokens };
}
export type AccessStore = ReturnType<typeof createAccessStore>;
