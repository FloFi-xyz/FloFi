// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from './db.js';

export type HistoryKind = 'EXECUTION_RUN' | 'WORKFLOW_RUN' | 'SAVED_WORKFLOW';
export type HistoryDisposition = { ok: true; disposition: 'DELETED' | 'ARCHIVED' | 'VISIBLE'; counts?: Record<string, number> }
  | { ok: false; code: 'RUN_NOT_FOUND' | 'RUN_DELETE_REFUSED' | 'HISTORY_INVALID' };
const idValid = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
const ownerValid = (owner: string) => /^0x[0-9a-f]{40}$/.test(owner) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner);

/** All operations accept only the authenticated server principal. Caller-supplied IDs never grant ownership. */
export function createOwnerHistory(db: Database, tenantId: string) {
  return {
    async disposition(owner: string, kind: HistoryKind, id: string): Promise<HistoryDisposition> {
      if (!ownerValid(owner) || !idValid(id) || !['EXECUTION_RUN', 'WORKFLOW_RUN', 'SAVED_WORKFLOW'].includes(kind)) return { ok: false, code: 'HISTORY_INVALID' };
      if (kind === 'EXECUTION_RUN' && (await db.query('SELECT 1 FROM execution_purge_audit WHERE tenant_id=$1 AND owner_account=$2 AND run_id=$3', [tenantId, owner, id])).rowCount)
        return { ok: true, disposition: 'DELETED' };
      const archived = await db.query('SELECT 1 FROM owner_history_visibility WHERE tenant_id=$1 AND owner_account=$2 AND kind=$3 AND record_id=$4', [tenantId, owner, kind, id]);
      return { ok: true, disposition: archived.rowCount ? 'ARCHIVED' : 'VISIBLE' };
    },
    async change(owner: string, kind: HistoryKind, id: string, action: 'DELETE' | 'ARCHIVE'): Promise<HistoryDisposition> {
      if (!ownerValid(owner) || !idValid(id) || !['EXECUTION_RUN', 'WORKFLOW_RUN', 'SAVED_WORKFLOW'].includes(kind) || !['DELETE', 'ARCHIVE'].includes(action))
        return { ok: false, code: 'HISTORY_INVALID' };
      return db.transaction(async tx => {
        let result: HistoryDisposition;
        if (kind === 'EXECUTION_RUN' && action === 'DELETE') {
          result = (await tx.query<{ result: HistoryDisposition }>('SELECT purge_unstarted_execution($1,$2,$3) AS result', [tenantId, owner, id])).rows[0]!.result;
        } else {
          const table = kind === 'WORKFLOW_RUN' ? 'workflow_runs' : kind === 'EXECUTION_RUN' ? 'execution_runs' : 'saved_workflows';
          const column = kind === 'SAVED_WORKFLOW' ? 'workflow_id' : 'run_id';
          // Table/column come exclusively from the closed server enum above, never from SQL input.
          const row = (await tx.query<{ workflow_hash?: string }>(`SELECT ${kind === 'SAVED_WORKFLOW' ? 'workflow_hash' : column} FROM ${table} WHERE tenant_id=$1 AND owner_account=$2 AND ${column}=$3 FOR UPDATE`, [tenantId, owner, id])).rows[0];
          if (!row) {
            if (kind === 'SAVED_WORKFLOW' && action === 'DELETE' && (await tx.query("SELECT 1 FROM owner_history_events WHERE tenant_id=$1 AND owner_account=$2 AND kind=$3 AND record_id=$4 AND action='DELETED'", [tenantId, owner, kind, id])).rowCount)
              return { ok: true, disposition: 'DELETED' };
            // The library also lists executed workflows without a saved draft. Their
            // durable financial records remain intact when the owner archives the entry.
            if (kind !== 'SAVED_WORKFLOW' || !(await tx.query('SELECT 1 FROM execution_runs WHERE tenant_id=$1 AND owner_account=$2 AND workflow_id=$3 LIMIT 1', [tenantId, owner, id])).rowCount)
              return { ok: false, code: 'RUN_NOT_FOUND' };
            if (action === 'DELETE') return { ok: false, code: 'RUN_DELETE_REFUSED' };
          }
          if (action === 'DELETE') {
            // Composition histories retain their separate append-only lifecycle. They may be archived, never guessed safe from a conventional run's state.
            if (kind === 'WORKFLOW_RUN') return { ok: false, code: 'RUN_DELETE_REFUSED' };
            const linked = await tx.query(`SELECT 1 WHERE
              EXISTS (SELECT 1 FROM execution_runs WHERE tenant_id=$1 AND owner_account=$2 AND workflow_id=$3)
              OR EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id=$1 AND owner_account=$2 AND source_workflow_id=$3)
              OR EXISTS (SELECT 1 FROM workflow_runs WHERE tenant_id=$1 AND owner_account=$2 AND workflow_hash=$4)
              OR EXISTS (SELECT 1 FROM mcp_handoffs WHERE tenant_id=$1 AND workflow_hash=$4 AND status IN ('PENDING','CLAIMED','APPLIED'))
              OR EXISTS (SELECT 1 FROM api_idempotency WHERE tenant_id=$1 AND scope='workflows/save' AND state='IN_PROGRESS' AND claimed_until>clock_timestamp())`,
            [tenantId, owner, id, row?.workflow_hash]);
            if (linked.rowCount) return { ok: false, code: 'RUN_DELETE_REFUSED' };
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
    },
  };
}
