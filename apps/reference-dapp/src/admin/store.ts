// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: administrators, their server-side sessions and the append-only audit trail (migration 0012). Every query is scoped to
 * one tenant. Grants are created and revoked only through the operator CLI; the console can read its own principal and end sessions.
 */
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { typedId } from '../platform/ids.ts';

export type AdminRole = 'VIEWER' | 'OPERATOR';
export type AdminPermission = 'read' | 'write';
export type AdminPrincipal = { readonly principalId: string; readonly account: string; readonly role: AdminRole; readonly state: 'ACTIVE' | 'REVOKED';
  readonly label: string | null; readonly createdAt: string; readonly revokedAt: string | null };
export type AdminSessionRow = { readonly sessionId: string; readonly principal: AdminPrincipal; readonly expiresAt: Date };
export type AuditActor = string; // adm_… | 'cli' | 'anonymous'
export type AuditInput = { readonly actor: AuditActor; readonly kind: string; readonly outcome: 'OK' | 'REFUSED' | 'FAILED'; readonly code?: string | null;
  readonly target?: string | null; readonly detail?: Readonly<Record<string, string | number | boolean | null>> | null };
export type AuditEvent = AuditInput & { readonly eventId: string; readonly at: string };

export const permits = (role: AdminRole, permission: AdminPermission): boolean => permission === 'read' || role === 'OPERATOR';
const ACCOUNT = /^0x[0-9a-f]{40}$/, LABEL = /^[^\p{Cc}]{1,80}$/u;
type PrincipalRow = { principal_id: string; account: string; role: AdminRole; state: 'ACTIVE' | 'REVOKED'; label: string | null; created_at: Date; revoked_at: Date | null };
const principal = (row: PrincipalRow): AdminPrincipal => ({ principalId: row.principal_id, account: row.account, role: row.role, state: row.state, label: row.label,
  createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null });
const PRINCIPAL_COLUMNS = 'principal_id, account, role, state, label, created_at, revoked_at';

export async function recordAudit(db: Queryable, tenantId: string, event: AuditInput): Promise<void> {
  await db.query(`INSERT INTO admin_audit_events (tenant_id, actor, kind, outcome, code, target, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [tenantId, event.actor, event.kind, event.outcome, event.code ?? null, event.target ?? null, event.detail ? JSON.stringify(event.detail) : null]);
}

export function createAdminStore(db: Database, tenantId: string) {
  return {
    async activePrincipalByAccount(account: string): Promise<AdminPrincipal | null> {
      if (!ACCOUNT.test(account)) return null;
      const { rows } = await db.query<PrincipalRow>(`SELECT ${PRINCIPAL_COLUMNS} FROM admin_principals
        WHERE tenant_id = $1 AND namespace = 'eip155' AND account = $2 AND state = 'ACTIVE'`, [tenantId, account]);
      return rows[0] ? principal(rows[0]) : null;
    },
    async listPrincipals(): Promise<AdminPrincipal[]> {
      const { rows } = await db.query<PrincipalRow>(`SELECT ${PRINCIPAL_COLUMNS} FROM admin_principals WHERE tenant_id = $1 ORDER BY created_at, principal_id`, [tenantId]);
      return rows.map(principal);
    },
    /** Operator CLI only. One ACTIVE grant per wallet; a role change is a revocation plus a new grant. */
    async grant(input: { readonly account: string; readonly role: AdminRole; readonly label: string | null }): Promise<AdminPrincipal> {
      if (!ACCOUNT.test(input.account)) throw new Error('WALLET_ADDRESS_INVALID');
      if (input.role !== 'VIEWER' && input.role !== 'OPERATOR') throw new Error('ADMIN_ROLE_INVALID');
      if (input.label !== null && !LABEL.test(input.label)) throw new Error('ADMIN_LABEL_INVALID');
      return db.transaction(async tx => {
        const existing = await tx.query(`SELECT 1 FROM admin_principals WHERE tenant_id = $1 AND namespace = 'eip155' AND account = $2 AND state = 'ACTIVE'`,
          [tenantId, input.account]);
        if (existing.rows.length) throw new Error('ADMIN_PRINCIPAL_EXISTS');
        const { rows } = await tx.query<PrincipalRow>(`INSERT INTO admin_principals (tenant_id, principal_id, namespace, account, role, state, label, granted_by)
          VALUES ($1, $2, 'eip155', $3, $4, 'ACTIVE', $5, 'cli') RETURNING ${PRINCIPAL_COLUMNS}`, [tenantId, typedId('adm'), input.account, input.role, input.label]);
        const granted = principal(rows[0]!);
        await recordAudit(tx, tenantId, { actor: 'cli', kind: 'ADMIN_PRINCIPAL_GRANTED', outcome: 'OK', target: granted.principalId, detail: { role: granted.role } });
        return granted;
      });
    },
    /** Operator CLI only. Ends every open session of the principal in the same transaction. */
    async revoke(principalId: string): Promise<AdminPrincipal> {
      return db.transaction(async tx => {
        const { rows } = await tx.query<PrincipalRow>(`UPDATE admin_principals SET state = 'REVOKED', revoked_at = now()
          WHERE tenant_id = $1 AND principal_id = $2 AND state = 'ACTIVE' RETURNING ${PRINCIPAL_COLUMNS}`, [tenantId, principalId]);
        if (!rows[0]) throw new Error('ADMIN_PRINCIPAL_NOT_ACTIVE');
        const ended = await tx.query(`UPDATE admin_sessions SET ended_at = now(), end_reason = 'PRINCIPAL_REVOKED'
          WHERE tenant_id = $1 AND principal_id = $2 AND ended_at IS NULL`, [tenantId, principalId]);
        await recordAudit(tx, tenantId, { actor: 'cli', kind: 'ADMIN_PRINCIPAL_REVOKED', outcome: 'OK', target: principalId, detail: { sessionsEnded: ended.rowCount } });
        return principal(rows[0]);
      });
    },
    async createSession(input: { readonly sessionId: string; readonly principalId: string; readonly createdAt: Date; readonly expiresAt: Date }): Promise<void> {
      await db.query(`INSERT INTO admin_sessions (tenant_id, session_id, principal_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, input.sessionId, input.principalId, input.createdAt, input.expiresAt]);
    },
    /** The live session and its ACTIVE principal, or null (unknown, ended, expired, or the grant was revoked). */
    async readSession(sessionId: string, principalId: string, now: Date): Promise<AdminSessionRow | null> {
      const { rows } = await db.query<PrincipalRow & { session_id: string; expires_at: Date }>(`SELECT s.session_id, s.expires_at, p.principal_id, p.account,
          p.role, p.state, p.label, p.created_at, p.revoked_at
        FROM admin_sessions s JOIN admin_principals p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
        WHERE s.tenant_id = $1 AND s.session_id = $2 AND s.principal_id = $3 AND s.ended_at IS NULL AND s.expires_at > $4 AND p.state = 'ACTIVE'`,
      [tenantId, sessionId, principalId, now]);
      const row = rows[0];
      return row ? { sessionId: row.session_id, principal: principal(row), expiresAt: row.expires_at } : null;
    },
    async endSession(sessionId: string, reason: 'SIGNED_OUT' | 'REVOKED'): Promise<boolean> {
      const { rowCount } = await db.query(`UPDATE admin_sessions SET ended_at = now(), end_reason = $3 WHERE tenant_id = $1 AND session_id = $2 AND ended_at IS NULL`,
        [tenantId, sessionId, reason]);
      return rowCount === 1;
    },
    /** Operator CLI: end every open admin session of the tenant (keeps the grants). */
    async endAllSessions(): Promise<number> {
      const { rowCount } = await db.query(`UPDATE admin_sessions SET ended_at = now(), end_reason = 'REVOKED' WHERE tenant_id = $1 AND ended_at IS NULL`, [tenantId]);
      await recordAudit(db, tenantId, { actor: 'cli', kind: 'ADMIN_SESSIONS_REVOKED', outcome: 'OK', detail: { sessionsEnded: rowCount } });
      return rowCount;
    },
    audit: (event: AuditInput) => recordAudit(db, tenantId, event),
    async recentAudit(limit: number): Promise<AuditEvent[]> {
      const n = Number.isSafeInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
      const { rows } = await db.query<{ event_id: string; at: Date; actor: string; kind: string; outcome: AuditInput['outcome']; code: string | null; target: string | null;
        detail: NonNullable<AuditInput['detail']> | null }>(`SELECT event_id::text, at, actor, kind, outcome, code, target, detail FROM admin_audit_events WHERE tenant_id = $1
        ORDER BY at DESC, event_id DESC LIMIT $2`, [tenantId, n]);
      return rows.map(row => ({ eventId: row.event_id, at: row.at.toISOString(), actor: row.actor, kind: row.kind, outcome: row.outcome, code: row.code, target: row.target,
        detail: row.detail ?? null }));
    },
    async countAudit(kind: string, since: Date): Promise<number> {
      const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM admin_audit_events WHERE tenant_id = $1 AND kind = $2 AND at >= $3`, [tenantId, kind, since]);
      return Number(rows[0]?.n ?? 0);
    },
  };
}
export type AdminStore = ReturnType<typeof createAdminStore>;
