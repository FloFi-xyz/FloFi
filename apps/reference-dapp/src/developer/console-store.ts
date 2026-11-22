// SPDX-License-Identifier: AGPL-3.0-only
import { CERTIFIED_FORWARD_MIGRATIONS, type Database, type Queryable } from '@defi-workflow-engine/cloud-runtime';
import { typedId } from '../platform/ids.ts';
import { KEY_ID, PROJECT_ID, projectNameValid } from './admin.ts';
import { DEVELOPER_SCOPES, type DeveloperConfig, type DeveloperEnvironment, type DeveloperScope } from './config.ts';
import { apiKeyDigest, newApiKey } from './keys.ts';
import { createPgDeveloperStore } from './pg-store.ts';

const migration = CERTIFIED_FORWARD_MIGRATIONS.flatMap(item => item.migrations).find(item => item.name === 'developer_project_ownership');
const PROJECT_LIMIT = 20;
const ACTIVE_KEY_LIMIT = 10;
const canonicalId = /^acct_[0-9a-f]{32}$/;
export const PROJECT_USAGE_METRICS = ['api.request', 'strategy.create', 'simulation.run', 'approval.create', 'execution.reconciled', 'webhook.delivery'] as const;
type UsageMetric = typeof PROJECT_USAGE_METRICS[number];

export async function developerOwnershipInstalled(db: Queryable): Promise<boolean> {
  if (!migration) return false;
  return (await db.query('SELECT 1 FROM schema_migrations WHERE version=$1 AND name=$2 AND sha256=$3',
    [migration.version, migration.name, migration.sha256])).rowCount === 1;
}

type ProjectRow = { project_id: string; display_name: string; status: 'ACTIVE' | 'DISABLED'; description: string;
  plan: 'free' | 'pro' | 'enterprise' };
const projectOf = (row: ProjectRow) => ({ id: row.project_id, name: row.display_name, description: row.description, status: row.status, plan: row.plan });
const validatedScopes = (scopes: readonly string[]): DeveloperScope[] => {
  const unique = [...new Set(scopes)];
  if (unique.length === 0 || unique.some(scope => !(DEVELOPER_SCOPES as readonly string[]).includes(scope))) throw new Error('SCOPES_INVALID');
  return unique as DeveloperScope[];
};

export function createDeveloperConsoleStore(db: Database, tenantId: string, accountId: string) {
  if (!canonicalId.test(accountId)) throw new Error('ACCOUNT_SESSION_REQUIRED');
  const scope = [tenantId, accountId] as const;

  async function project(id: string, q: Queryable = db, lock = false) {
    if (!PROJECT_ID.test(id)) return null;
    const result = await q.query<ProjectRow>(`SELECT p.project_id, p.display_name, p.status, p.plan, o.description
      FROM developer_project_owners o JOIN developer_projects p USING (tenant_id, project_id)
      WHERE o.tenant_id=$1 AND o.account_id=$2 AND o.project_id=$3 ${lock ? 'FOR UPDATE OF p' : ''}`, [...scope, id]);
    return result.rows[0] ? projectOf(result.rows[0]) : null;
  }

  async function owned(tx: Queryable, id: string, active: boolean) {
    // Account deletion locks the account before cascading to its project links.
    if (!(await tx.query('SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2 FOR KEY SHARE', scope)).rowCount)
      throw new Error('ACCOUNT_SESSION_REQUIRED');
    const row = await project(id, tx, true);
    if (!row) throw new Error('PROJECT_NOT_FOUND');
    if (active && row.status !== 'ACTIVE') throw new Error('PROJECT_NOT_ACTIVE');
    return row;
  }

  async function audit(tx: Queryable, at: Date, kind: string, projectId: string, keyId?: string) {
    await tx.query(`INSERT INTO admin_audit_events (tenant_id, at, actor, kind, outcome, target, detail)
      VALUES ($1,$2,'anonymous',$3,'OK',$4,$5)`, [tenantId, at, kind, projectId,
      JSON.stringify({ actorClass: 'project_owner', ...(keyId ? { keyId } : {}) })]);
  }

  function projectValues(name: string, description: string) {
    if (!projectNameValid(name)) throw new Error('PROJECT_NAME_INVALID');
    if (description.length > 500 || /[\p{Cc}\p{Cf}]/u.test(description)) throw new Error('PROJECT_DESCRIPTION_INVALID');
    return [name, description] as const;
  }

  return {
    readProject: (id: string) => project(id),
    async list() {
      return (await db.query<ProjectRow>(`SELECT p.project_id,p.display_name,p.status,p.plan,o.description FROM developer_project_owners o
        JOIN developer_projects p USING (tenant_id, project_id) WHERE o.tenant_id=$1 AND o.account_id=$2
        ORDER BY p.status,p.created_at DESC,p.project_id LIMIT 100`, scope)).rows.map(projectOf);
    },
    async details(id: string) {
      const item = await project(id);
      if (!item) return null;
      const store = createPgDeveloperStore(db, tenantId);
      const [keys, deliveries, endpoints, awaiting] = await Promise.all([
        store.listKeys(id),
        store.listDeliveries(id, 10),
        db.query<{ endpoint_id: string; environment: DeveloperEnvironment }>(`
          SELECT e.endpoint_id,e.environment FROM developer_webhook_endpoints e
          JOIN developer_project_owners o USING (tenant_id,project_id)
          WHERE o.tenant_id=$1 AND o.account_id=$2 AND o.project_id=$3 AND e.status='ACTIVE'
          ORDER BY e.created_at DESC LIMIT 10`, [...scope, id]),
        db.query<{ environment: DeveloperEnvironment; status: 'PENDING' | 'CLAIMED'; total: string }>(`
          SELECT a.environment,h.status,count(*)::text AS total FROM developer_approvals a
          JOIN developer_project_owners o USING (tenant_id,project_id)
          JOIN mcp_handoffs h USING (tenant_id,handoff_id)
          WHERE o.tenant_id=$1 AND o.account_id=$2 AND o.project_id=$3
            AND ((h.status='PENDING' AND h.expires_at>now()) OR (h.status='CLAIMED' AND h.claim_expires_at>now()))
          GROUP BY a.environment,h.status ORDER BY a.environment,h.status`, [...scope, id]),
      ]);
      return { ...item, keys, deliveries, endpoints: endpoints.rows, awaiting: awaiting.rows };
    },
    async activity(id: string, now: Date) {
      if (!PROJECT_ID.test(id)) return [];
      const { rows } = await db.query<{ environment: DeveloperEnvironment; metric: UsageMetric; total: string }>(`
        SELECT u.environment,u.metric,sum(u.count)::text AS total
        FROM developer_usage u JOIN developer_project_owners o USING (tenant_id,project_id)
        WHERE o.tenant_id=$1 AND o.account_id=$2 AND o.project_id=$3
          AND u.day BETWEEN $4::date - 29 AND $4::date AND u.metric=ANY($5::text[])
        GROUP BY u.environment,u.metric ORDER BY u.environment,u.metric`,
      [...scope, id, now.toISOString().slice(0, 10), PROJECT_USAGE_METRICS]);
      return rows;
    },
    async create(name: string, description: string, now: Date) {
      const values = projectValues(name, description);
      return db.transaction(async tx => {
        // Also serializes account retirement against creation of a dependent project.
        if (!(await tx.query('SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE', scope)).rowCount)
          throw new Error('ACCOUNT_SESSION_REQUIRED');
        const { rows: [count] } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM developer_project_owners o
          JOIN developer_projects p USING (tenant_id,project_id) WHERE o.tenant_id=$1 AND o.account_id=$2 AND p.status='ACTIVE'`, scope);
        if ((count?.n ?? 0) >= PROJECT_LIMIT) throw new Error('PROJECT_LIMIT');
        const id = typedId('prj');
        await tx.query('INSERT INTO developer_projects (tenant_id,project_id,display_name,created_at) VALUES ($1,$2,$3,$4)', [tenantId, id, values[0], now]);
        await tx.query('INSERT INTO developer_project_owners (tenant_id,project_id,account_id,description) VALUES ($1,$2,$3,$4)', [tenantId, id, accountId, values[1]]);
        await audit(tx, now, 'DEVELOPER_PROJECT_CREATED', id);
        return id;
      });
    },
    async edit(id: string, name: string, description: string, now: Date) {
      const values = projectValues(name, description);
      await db.transaction(async tx => {
        await owned(tx, id, true);
        await tx.query('UPDATE developer_projects SET display_name=$3 WHERE tenant_id=$1 AND project_id=$2', [tenantId, id, values[0]]);
        await tx.query('UPDATE developer_project_owners SET description=$4 WHERE tenant_id=$1 AND account_id=$2 AND project_id=$3', [...scope, id, values[1]]);
        await audit(tx, now, 'DEVELOPER_PROJECT_UPDATED', id);
      });
    },
    async disable(id: string, now: Date) {
      return db.transaction(async tx => {
        if ((await owned(tx, id, false)).status === 'DISABLED') return;
        await tx.query("UPDATE developer_projects SET status='DISABLED', disabled_at=$3 WHERE tenant_id=$1 AND project_id=$2", [tenantId, id, now]);
        await audit(tx, now, 'DEVELOPER_PROJECT_DISABLED', id);
      });
    },
    async issue(id: string, environment: DeveloperEnvironment, scopes: readonly string[], config: DeveloperConfig, now: Date, rotate?: string) {
      if (config.tenantId !== tenantId || environment !== 'sandbox') throw new Error('LIVE_MODE_DISABLED');
      if (rotate !== undefined && !KEY_ID.test(rotate)) throw new Error('KEY_NOT_FOUND');
      const selected = rotate ? null : validatedScopes(scopes);
      const { key, hint } = newApiKey(environment);
      return db.transaction(async tx => {
        await owned(tx, id, true);
        const args = [tenantId, id, environment] as const;
        const previous = rotate ? (await tx.query<{ scopes: DeveloperScope[] }>(`UPDATE developer_api_keys SET status='REVOKED', revoked_at=$5
          WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND key_id=$4 AND status='ACTIVE' RETURNING scopes`, [...args, rotate, now])).rows[0] : null;
        if (rotate && !previous) throw new Error('KEY_NOT_FOUND');
        const { rows: [count] } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM developer_api_keys
          WHERE tenant_id=$1 AND project_id=$2 AND environment=$3 AND status='ACTIVE'`, args);
        if ((count?.n ?? 0) >= ACTIVE_KEY_LIMIT) throw new Error('KEY_LIMIT');
        const keyId = typedId('key');
        await tx.query(`INSERT INTO developer_api_keys (tenant_id,project_id,environment,key_id,key_digest,hint,scopes,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [...args, keyId, apiKeyDigest(config, key), hint, previous?.scopes ?? selected, now]);
        await audit(tx, now, rotate ? 'DEVELOPER_KEY_ROTATED' : 'DEVELOPER_KEY_ISSUED', id, keyId);
        return { key, keyId };
      });
    },
    async revoke(id: string, keyId: string, now: Date) {
      if (!KEY_ID.test(keyId)) throw new Error('KEY_NOT_FOUND');
      await db.transaction(async tx => {
        await owned(tx, id, true);
        const revoked = await tx.query(`UPDATE developer_api_keys SET status='REVOKED', revoked_at=$4
          WHERE tenant_id=$1 AND project_id=$2 AND key_id=$3 AND status='ACTIVE'`, [tenantId, id, keyId, now]);
        if (!revoked.rowCount) throw new Error('KEY_NOT_FOUND');
        await audit(tx, now, 'DEVELOPER_KEY_REVOKED', id, keyId);
      });
    },
  };
}
