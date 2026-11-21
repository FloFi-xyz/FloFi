// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Database, Queryable } from './db.js';
import { CERTIFIED_FORWARD_MIGRATIONS, SHIPPED_MIGRATIONS } from './migrations.js';

export type HistoryKind = 'EXECUTION_RUN' | 'WORKFLOW_RUN' | 'SAVED_WORKFLOW';
export type HistoryDeleteRefusal = 'AUTHORIZATION' | 'EXECUTION_ACTIVITY' | 'DEPENDENCY';
export type HistoryDisposition = { ok: true; disposition: 'DELETED' | 'ARCHIVED' | 'VISIBLE'; counts?: Record<string, number> }
  | { ok: false; code: 'RUN_DELETE_REFUSED'; reason?: HistoryDeleteRefusal }
  | { ok: false; code: 'RUN_NOT_FOUND' | 'HISTORY_INVALID' | 'HISTORY_READ_ONLY' };
const idValid = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
const ownerValid = (owner: string) => /^0x[0-9a-f]{40}$/.test(owner) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner);

/** Serialize creation and deletion of the same owner-scoped saved-workflow identity. */
export async function lockSavedWorkflowHistory(tx: Queryable, tenantId: string, owner: string, id: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('saved-workflow', $1::text, $2::text, $3::text)::text,0))",
    [tenantId, owner, id]);
}

export async function savedWorkflowDeleted(db: Queryable, tenantId: string, owner: string, id: string, legacySchema = false): Promise<boolean> {
  // The schema-0008 upgrade verifier uses the original save contract before history is provisioned.
  if (legacySchema && !(await db.query<{ installed: boolean }>("SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 16) AS installed")).rows[0]?.installed) return false;
  const result = await db.query(`SELECT 1 FROM owner_history_events
    WHERE tenant_id=$1 AND owner_account=$2 AND kind='SAVED_WORKFLOW' AND record_id=$3 AND action='DELETED'
      AND NOT EXISTS (SELECT 1 FROM saved_workflows WHERE tenant_id=$1 AND owner_account=$2 AND workflow_id=$3) LIMIT 1`, [tenantId, owner, id]);
  return result.rowCount > 0;
}

/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): migration 0033 (`workflow_run_purge`) lets an owner delete a single-card
 * attempt that provably never reached a chain (`purge_unsubmitted_workflow_run`, which alone decides). It is certified for the v28 build and
 * applied by an operator command (docs/deploy/RELEASE-WORKFLOW-RUN-PURGE-0033.md). Only when the ledger holds exactly that identity — version,
 * name and SHA-256, certified or (once shipped) shipped — is the procedure called; otherwise a workflow run keeps today's refusal.
 */
const WORKFLOW_RUN_PURGE_MIGRATION = { version: 33, name: 'workflow_run_purge' } as const;
async function workflowRunPurgeInstalled(db: Queryable): Promise<boolean> {
  const { version, name } = WORKFLOW_RUN_PURGE_MIGRATION;
  const identity = SHIPPED_MIGRATIONS.find(m => m.version === version) ?? CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.version === version);
  if (!identity || identity.name !== name) return false;
  const row = (await db.query<{ version: number; name: string; sha256: string }>('SELECT version, name, sha256 FROM schema_migrations WHERE version = $1', [version])).rows[0];
  return Boolean(row && Number(row.version) === identity.version && row.name === identity.name && row.sha256 === identity.sha256);
}

const REFUSAL_LOG_LIMIT = 512 * 1024;
const authorizationRecorded = (value: unknown) => value !== undefined && value !== null && value !== false && value !== '';

/** Explain known reasons after a refusal. Only the database purge procedure decides whether disposal is safe. */
async function explainExecutionRefusal(db: Database, tenantId: string, owner: string, id: string): Promise<HistoryDeleteRefusal | undefined> {
  const { rows: [run] } = await db.query<{ activity: boolean; dependency: boolean; namespace: string; log_name: string;
    log_version: string; content_sha256: string; byte_length: string }>(`
    SELECT r.namespace,r.log_name,r.log_version,l.content_sha256,l.byte_length,
      (r.has_evidence OR r.needs_observation OR EXISTS (SELECT 1 FROM execution_attempts a WHERE (a.tenant_id,a.run_id)=(r.tenant_id,r.run_id))
        OR EXISTS (SELECT 1 FROM evidence_objects e WHERE (e.tenant_id,e.run_id)=(r.tenant_id,r.run_id))) AS activity,
      (r.recovery_of IS NOT NULL OR EXISTS (SELECT 1 FROM execution_runs child WHERE child.tenant_id=r.tenant_id AND child.recovery_of=r.run_id)
        OR EXISTS (SELECT 1 FROM work_items w WHERE (w.tenant_id,w.run_id)=(r.tenant_id,r.run_id) AND w.state IN ('READY','LEASED'))
        OR EXISTS (SELECT 1 FROM mcp_handoffs h WHERE h.tenant_id=r.tenant_id AND r.run_id=ANY(h.run_ids))
        OR EXISTS (SELECT 1 FROM automation_rules a WHERE (a.tenant_id,a.owner_account,a.source_workflow_id)=(r.tenant_id,r.owner_account,r.workflow_id))) AS dependency
    FROM execution_runs r JOIN execution_logs l ON (l.tenant_id,l.namespace,l.name)=(r.tenant_id,r.namespace,r.log_name) AND l.version=r.log_version
    WHERE r.tenant_id=$1 AND r.owner_account=$2 AND r.run_id=$3`, [tenantId, owner, id]);
  if (!run) return;
  if (run.activity) return 'EXECUTION_ACTIVITY';
  if (run.dependency) return 'DEPENDENCY';
  if (Number(run.byte_length) > REFUSAL_LOG_LIMIT || Number(run.log_version) > 64) return;

  const { rows } = await db.query<{ bytes: Buffer }>(`
    SELECT s.bytes FROM execution_log_segments s JOIN execution_logs l USING (tenant_id,namespace,name)
    WHERE (s.tenant_id,s.namespace,s.name)=($1,$2,$3) AND l.version=$4 AND octet_length(s.bytes)<=$5
    ORDER BY s.seq LIMIT 64`, [tenantId, run.namespace, run.log_name, run.log_version, REFUSAL_LOG_LIMIT]);
  const bytes = Buffer.concat(rows.map(row => row.bytes));
  if (rows.length !== Number(run.log_version) || bytes.length !== Number(run.byte_length)
    || createHash('sha256').update(bytes).digest('hex') !== run.content_sha256) return;
  for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
    const snapshot = JSON.parse(line) as { phase?: string; authorization?: unknown; reviewedManifestHash?: unknown } | null;
    if (snapshot && (snapshot.phase === 'AUTHORIZED' || authorizationRecorded(snapshot.authorization) || authorizationRecorded(snapshot.reviewedManifestHash))) {
      return 'AUTHORIZATION';
    }
  }
}

/** All operations accept only the authenticated server principal. Caller-supplied IDs never grant ownership. */
export function createOwnerHistory(db: Database, tenantId: string) {
  return {
    async disposition(owner: string, kind: HistoryKind, id: string): Promise<HistoryDisposition> {
      if (!ownerValid(owner) || !idValid(id) || !['EXECUTION_RUN', 'WORKFLOW_RUN', 'SAVED_WORKFLOW'].includes(kind)) return { ok: false, code: 'HISTORY_INVALID' };
      if (kind === 'EXECUTION_RUN' && (await db.query('SELECT 1 FROM execution_purge_audit WHERE tenant_id=$1 AND owner_account=$2 AND run_id=$3', [tenantId, owner, id])).rowCount)
        return { ok: true, disposition: 'DELETED' };
      if (kind === 'SAVED_WORKFLOW' && await savedWorkflowDeleted(db, tenantId, owner, id)) return { ok: true, disposition: 'DELETED' };
      // A deleted single-card attempt: its 0033 tombstone (the table exists only with that migration; any read failure answers "not deleted").
      if (kind === 'WORKFLOW_RUN' && await workflowRunPurgeInstalled(db).catch(() => false)
        && (await db.query('SELECT 1 FROM workflow_run_purge_audit WHERE tenant_id=$1 AND owner_account=$2 AND run_id=$3', [tenantId, owner, id])).rowCount)
        return { ok: true, disposition: 'DELETED' };
      const archived = await db.query('SELECT 1 FROM owner_history_visibility WHERE tenant_id=$1 AND owner_account=$2 AND kind=$3 AND record_id=$4', [tenantId, owner, kind, id]);
      return { ok: true, disposition: archived.rowCount ? 'ARCHIVED' : 'VISIBLE' };
    },
    async change(owner: string, kind: HistoryKind, id: string, action: 'DELETE' | 'ARCHIVE'): Promise<HistoryDisposition> {
      if (!ownerValid(owner) || !idValid(id) || !['EXECUTION_RUN', 'WORKFLOW_RUN', 'SAVED_WORKFLOW'].includes(kind) || !['DELETE', 'ARCHIVE'].includes(action))
        return { ok: false, code: 'HISTORY_INVALID' };
      const disposition = await db.transaction(async (tx): Promise<HistoryDisposition> => {
        let result: HistoryDisposition;
        // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: READ COMMITTED, so a delete that waited for a concurrent one sees its committed tombstone.
        if (kind === 'WORKFLOW_RUN' && action === 'DELETE') await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        if (kind === 'EXECUTION_RUN' && action === 'DELETE') {
          result = (await tx.query<{ result: HistoryDisposition }>('SELECT purge_unstarted_execution($1,$2,$3) AS result', [tenantId, owner, id])).rows[0]!.result;
        } else if (kind === 'WORKFLOW_RUN' && action === 'DELETE' && await workflowRunPurgeInstalled(tx)) {
          // The database procedure alone decides (both deletable shapes, the closed event allowlist, every dependency), under the run's lock.
          result = (await tx.query<{ result: HistoryDisposition }>('SELECT purge_unsubmitted_workflow_run($1,$2,$3) AS result', [tenantId, owner, id])).rows[0]!.result;
          // An idempotent repeat (the tombstone already answered) records no second DELETED event.
          if (result.ok && (await tx.query(`SELECT 1 FROM owner_history_events WHERE tenant_id=$1 AND owner_account=$2 AND kind='WORKFLOW_RUN' AND record_id=$3
            AND action='DELETED' LIMIT 1`, [tenantId, owner, id])).rowCount) return result;
        } else {
          if (kind === 'SAVED_WORKFLOW' && action === 'DELETE') await lockSavedWorkflowHistory(tx, tenantId, owner, id);
          const table = kind === 'WORKFLOW_RUN' ? 'workflow_runs' : kind === 'EXECUTION_RUN' ? 'execution_runs' : 'saved_workflows';
          const column = kind === 'SAVED_WORKFLOW' ? 'workflow_id' : 'run_id';
          // Table/column come exclusively from the closed server enum above, never from SQL input.
          const row = (await tx.query<{ workflow_hash?: string }>(`SELECT ${kind === 'SAVED_WORKFLOW' ? 'workflow_hash' : column} FROM ${table} WHERE tenant_id=$1 AND owner_account=$2 AND ${column}=$3 FOR UPDATE`, [tenantId, owner, id])).rows[0];
          if (!row) {
            if (kind === 'SAVED_WORKFLOW' && action === 'DELETE' && await savedWorkflowDeleted(tx, tenantId, owner, id))
              return { ok: true, disposition: 'DELETED' };
            // The library also lists executed workflows without a saved draft. Their
            // durable financial records remain intact when the owner archives the entry.
            if (kind !== 'SAVED_WORKFLOW' || !(await tx.query('SELECT 1 FROM execution_runs WHERE tenant_id=$1 AND owner_account=$2 AND workflow_id=$3 LIMIT 1', [tenantId, owner, id])).rowCount)
              return { ok: false, code: 'RUN_NOT_FOUND' };
            if (action === 'DELETE') return { ok: false, code: 'RUN_DELETE_REFUSED', reason: 'EXECUTION_ACTIVITY' };
          }
          if (action === 'DELETE') {
            // Composition histories retain their separate append-only lifecycle. They may be archived, never guessed safe from a conventional run's state.
            // Without the certified 0033 procedure (above) no workflow run is ever deleted.
            if (kind === 'WORKFLOW_RUN') return { ok: false, code: 'RUN_DELETE_REFUSED' };
            const linked = await tx.query(`SELECT 1 WHERE
              EXISTS (SELECT 1 FROM execution_runs WHERE tenant_id=$1 AND owner_account=$2 AND workflow_id=$3)
              OR EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id=$1 AND owner_account=$2 AND source_workflow_id=$3)
              OR EXISTS (SELECT 1 FROM workflow_runs WHERE tenant_id=$1 AND owner_account=$2 AND workflow_hash=$4)`,
            [tenantId, owner, id, row?.workflow_hash]);
            if (linked.rowCount) return { ok: false, code: 'RUN_DELETE_REFUSED', reason: 'DEPENDENCY' };
            // Tenant-wide guards can hold another owner's work. Keep those refusals generic.
            if ((await tx.query(`SELECT 1 WHERE
              EXISTS (SELECT 1 FROM mcp_handoffs WHERE tenant_id=$1 AND workflow_hash=$2 AND status IN ('PENDING','CLAIMED','APPLIED'))
              OR EXISTS (SELECT 1 FROM api_idempotency WHERE tenant_id=$1 AND scope='workflows/save' AND state='IN_PROGRESS' AND claimed_until>clock_timestamp())`,
              [tenantId, row?.workflow_hash])).rowCount) return { ok: false, code: 'RUN_DELETE_REFUSED' };
            const removed = await tx.query(`DELETE FROM saved_workflows WHERE tenant_id=$1 AND owner_account=$2 AND workflow_id=$3 RETURNING 1`, [tenantId, owner, id]);
            await tx.query("DELETE FROM owner_history_visibility WHERE tenant_id=$1 AND owner_account=$2 AND kind='SAVED_WORKFLOW' AND record_id=$3", [tenantId, owner, id]);
            result = { ok: true, disposition: 'DELETED', counts: { saved_workflows: removed.rowCount } };
          } else {
            await tx.query(`INSERT INTO owner_history_visibility(tenant_id,owner_account,kind,record_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenantId, owner, kind, id]);
            result = { ok: true, disposition: 'ARCHIVED' };
          }
        }
        if (result.ok) await tx.query(`INSERT INTO owner_history_events(tenant_id,owner_account,kind,record_id,action) VALUES($1,$2,$3,$4,$5)`, [tenantId, owner, kind, id, result.disposition]);
        return result;
      });
      if (!disposition.ok && disposition.code === 'RUN_DELETE_REFUSED' && kind === 'EXECUTION_RUN') {
        const reason = await explainExecutionRefusal(db, tenantId, owner, id).catch(() => undefined);
        if (reason) return { ...disposition, reason };
      }
      return disposition;
    },
  };
}
