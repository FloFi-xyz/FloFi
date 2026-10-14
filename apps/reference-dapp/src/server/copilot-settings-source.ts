// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: where FloFi's web chat reads the Copilot's runtime settings, without making the Copilot depend on the database being at
 * exactly this build's schema version.
 *
 * Normally the settings are read through the platform-state pool (`platformStateHost`), which opens only on exactly the migrations this build
 * ships. During a rolling deployment the database is briefly one migration behind or ahead of a serving build — a new Vercel build live
 * before the Railway pre-deploy migrated, or the previous build after it did — and platform state refuses every cold instance
 * (`SCHEMA_NOT_MIGRATED`, `MIGRATION_HISTORY_MISMATCH`). The settings table needs only the migration that created it, so this source then
 * checks exactly that, on its own one-connection pool:
 *
 *   - the applied history matches this build's shipped identities up to `admin_control_plane` → the active version is read as usual (and
 *     validated by the resolver as always);
 *   - the applied history is a matching prefix that stops before it → the table never existed, so no administrator ever chose settings:
 *     there is no version, and the environment bootstrap applies (the Copilot as it was before the console existed);
 *   - any other history, or an unreachable database → the read fails and the Copilot fails closed, as before.
 *
 * It never writes, never migrates and never opens the rest of platform state on a schema this build does not know. A future migration that
 * changes `admin_settings_versions` must keep this read meaningful for the previous build (append-only, latest version active, a document the
 * previous build either validates or refuses).
 */
import type { Database, MigrationIdentity, Queryable } from '@defi-workflow-engine/cloud-runtime';
import type { CopilotSettingsReader } from './copilot-runtime.ts';
import { platformStateHost, type PlatformStateHost } from './platform-state-host.ts';
import { serverlessPostgresConfig } from './postgres-config.ts';
import { readActiveSettings } from './runtime-settings-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
const SCHEMA_WINDOW = new Set(['SCHEMA_NOT_MIGRATED', 'MIGRATION_HISTORY_MISMATCH']);
export const SETTINGS_MIGRATION = 'admin_control_plane';

/**
 * Whether the migration that created `admin_settings_versions` is applied. The applied history up to it must be exactly this build's shipped
 * prefix (a shorter matching prefix means it is not applied yet); anything else throws `MIGRATION_HISTORY_MISMATCH`.
 */
export async function settingsTableApplied(db: Queryable, shipped: readonly MigrationIdentity[]): Promise<boolean> {
  const prefix = shipped.slice(0, shipped.findIndex(m => m.name === SETTINGS_MIGRATION) + 1);
  if (!prefix.length) throw new Error('MIGRATION_HISTORY_MISMATCH');
  const { rows } = await db.query<{ version: number; name: string; sha256: string }>(
    'SELECT version, name, sha256 FROM schema_migrations WHERE version <= $1 ORDER BY version', [prefix.at(-1)!.version]);
  for (const [i, row] of rows.entries()) {
    const expected = prefix[i];
    if (!expected || row.version !== expected.version || row.name !== expected.name || row.sha256 !== expected.sha256) throw new Error('MIGRATION_HISTORY_MISMATCH');
  }
  return rows.length === prefix.length;
}

const POOLS = Symbol.for('flofi.copilot-settings-window');
/** One small pool per process and configuration, opened only when platform state refused the schema. */
async function windowSource(env: Env): Promise<{ readonly db: Database; readonly tenantId: string; readonly shipped: readonly MigrationIdentity[] }> {
  const config = serverlessPostgresConfig(env), runtime = await import('@defi-workflow-engine/cloud-runtime');
  const holder = globalThis as unknown as Record<symbol, Map<string, Database> | undefined>;
  const pools = holder[POOLS] ??= new Map(), key = JSON.stringify([config.databaseUrl, config.tenantId]);
  let db = pools.get(key);
  if (!db) pools.set(key, db = runtime.createDatabase({ connectionString: config.databaseUrl, maxConnections: 1, applicationName: 'flofi-copilot-settings' }));
  return { db, tenantId: config.tenantId, shipped: runtime.SHIPPED_MIGRATIONS };
}

/** The web chat's settings reader: the platform-state pool when it opens, else the schema-window check above. */
export function webCopilotSettingsReader(env: Env, open: (env: Env) => Promise<PlatformStateHost> = platformStateHost): CopilotSettingsReader {
  return async () => {
    let host: PlatformStateHost;
    try { host = await open(env); }
    catch (error) {
      if (!(error instanceof Error) || !SCHEMA_WINDOW.has(error.message)) throw error;
      const source = await windowSource(env);
      return await settingsTableApplied(source.db, source.shipped) ? readActiveSettings(source.db, source.tenantId, 'copilot') : null;
    }
    return readActiveSettings(host.db, host.tenantId, 'copilot');
  };
}
