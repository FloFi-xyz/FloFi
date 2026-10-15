// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: a Vercel Preview build migrates (`FLOFI_MIGRATE_ON_BUILD=preview`, `deploy/vercel/build.sh`) only a database that holds
 * Preview state alone. Production migrations run only in the Railway API's pre-deploy, in the owner's reviewed rollout order
 * (docs/deploy/SCHEMA-COMPATIBILITY.md §4, docs/deploy/ADMIN.md §7). A Preview build — any pushed branch, e.g. an unmerged PR that ships
 * a new migration such as 0012 — whose `DATABASE_URL` is Production's by mistake must fail instead of migrating it.
 *
 * Every Preview deployment writes under its own `pv-<branch>-<hash>` tenant (`deploymentTenant`). Production (Vercel and the Railway API
 * and worker), local servers and operator CLIs write under `TENANT_ID` (default `default`, the tenant migration 0001 seeds in every
 * database). So a tenant other than the seeded `default` outside the Preview namespace, or any tenant-scoped row outside it, means a
 * non-Preview deployment uses this database: `PREVIEW_DATABASE_NOT_DEDICATED`. A new, empty database passes. The check only reads, before
 * the runner takes its lock; a refusal changes nothing and fails the Preview build.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';

const PREVIEW = `tenant_id NOT LIKE 'pv-%'`;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export async function assertDedicatedPreviewDatabase(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ table_name: string }>(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name`);
  for (const { table_name: table } of rows) {
    if (!IDENTIFIER.test(table)) throw new Error('PREVIEW_DATABASE_NOT_DEDICATED');
    const foreign = table === 'tenants' ? `${PREVIEW} AND tenant_id <> 'default'` : PREVIEW;
    if ((await db.query(`SELECT 1 FROM public."${table}" WHERE ${foreign} LIMIT 1`)).rowCount) throw new Error('PREVIEW_DATABASE_NOT_DEDICATED');
  }
}
