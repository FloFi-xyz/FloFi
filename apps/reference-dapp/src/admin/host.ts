// SPDX-License-Identifier: AGPL-3.0-only
import { SchemaCompatibilityError, type Database } from '@defi-workflow-engine/cloud-runtime';
import { isHostedDeployment } from '../server/deployment.ts';
import { platformStateHost, postgresPlatformStateHost } from '../server/platform-state-host.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type AdminHost = { readonly db: Database; readonly tenantId: string };

export async function adminHost(env: Env): Promise<AdminHost | { readonly code: string }> {
  const databaseUrl = env.DATABASE_ADMIN_URL;
  if (!databaseUrl && isHostedDeployment(env)) return { code: 'ADMIN_STORE_NOT_CONFIGURED' };
  try {
    return await (databaseUrl
      ? postgresPlatformStateHost({ ...env, DATABASE_URL: databaseUrl }, 'flofi-admin-web')
      : platformStateHost(env));
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'DATABASE_URL_REQUIRED') return { code: 'ADMIN_STORE_NOT_CONFIGURED' };
    if (error instanceof SchemaCompatibilityError && error.state === 'unavailable') return { code: 'ADMIN_STORE_UNAVAILABLE' };
    if (message === 'SCHEMA_NOT_MIGRATED' || message === 'MIGRATION_HISTORY_MISMATCH') return { code: 'ADMIN_SCHEMA_NOT_CURRENT' };
    return { code: 'ADMIN_STORE_UNAVAILABLE' };
  }
}
