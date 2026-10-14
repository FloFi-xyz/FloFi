// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the console's durable state is the deployment's existing PostgreSQL platform state (`platformStateHost`: the same
 * database and tenant as the Railway API and worker in production, the embedded runtime's pool elsewhere). No new database secret and
 * no Railway change. Missing or stale storage fails closed with a closed code.
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { platformStateHost } from '../server/platform-state-host.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type AdminHost = { readonly db: Database; readonly tenantId: string };

export async function adminHost(env: Env): Promise<AdminHost | { readonly code: string }> {
  try { return await platformStateHost(env); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'DATABASE_URL_REQUIRED') return { code: 'ADMIN_STORE_NOT_CONFIGURED' };
    if (message === 'SCHEMA_NOT_MIGRATED' || message === 'MIGRATION_HISTORY_MISMATCH') return { code: 'ADMIN_SCHEMA_NOT_CURRENT' };
    return { code: 'ADMIN_STORE_UNAVAILABLE' };
  }
}
