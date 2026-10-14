// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: versioned runtime settings in PostgreSQL (`admin_settings_versions`, migration 0012). Append-only and gapless per key:
 * the latest version is the active one, a rollback appends a version restoring an older document, and a NULL document means "use the
 * deployment's environment bootstrap". Reads are one indexed primary-key lookup with no process cache, so every instance applies a change
 * on its next request. Writers name the version they expect to replace; a concurrent writer loses with ADMIN_SETTINGS_VERSION_CONFLICT.
 */
import { isUniqueViolation, type Queryable } from '@defi-workflow-engine/cloud-runtime';

export type SettingKey = 'copilot';
export type SettingsVersion = { readonly version: number; readonly document: unknown; readonly restoredFrom: number | null; readonly createdBy: string;
  readonly reason: string | null; readonly createdAt: string };
type Row = { version: number; document: unknown; restored_from: number | null; created_by: string; reason: string | null; created_at: Date };
const view = (row: Row): SettingsVersion => ({ version: row.version, document: row.document, restoredFrom: row.restored_from, createdBy: row.created_by,
  reason: row.reason, createdAt: row.created_at.toISOString() });
const COLUMNS = 'version, document, restored_from, created_by, reason, created_at';
const REASON = /^[^\p{Cc}]{1,200}$/u;

export async function readActiveSettings(db: Queryable, tenantId: string, key: SettingKey): Promise<SettingsVersion | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM admin_settings_versions WHERE tenant_id = $1 AND setting_key = $2 ORDER BY version DESC LIMIT 1`,
    [tenantId, key]);
  return rows[0] ? view(rows[0]) : null;
}
export async function readSettingsVersion(db: Queryable, tenantId: string, key: SettingKey, version: number): Promise<SettingsVersion | null> {
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM admin_settings_versions WHERE tenant_id = $1 AND setting_key = $2 AND version = $3`, [tenantId, key, version]);
  return rows[0] ? view(rows[0]) : null;
}
export async function settingsHistory(db: Queryable, tenantId: string, key: SettingKey, limit = 25): Promise<SettingsVersion[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM admin_settings_versions WHERE tenant_id = $1 AND setting_key = $2 ORDER BY version DESC LIMIT $3`,
    [tenantId, key, Math.min(Math.max(1, limit), 100)]);
  return rows.map(view);
}
/** Appends version `expectedVersion + 1`; fails with ADMIN_SETTINGS_VERSION_CONFLICT if another writer got there first. */
export async function appendSettingsVersion(db: Queryable, tenantId: string, input: { readonly key: SettingKey; readonly expectedVersion: number;
  readonly document: unknown; readonly restoredFrom: number | null; readonly createdBy: string; readonly reason: string | null }): Promise<SettingsVersion> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('ADMIN_SETTINGS_VERSION_CONFLICT');
  if (input.reason !== null && !REASON.test(input.reason)) throw new Error('ADMIN_SETTINGS_REASON_INVALID');
  try {
    const { rows } = await db.query<Row>(`INSERT INTO admin_settings_versions (tenant_id, setting_key, version, document, restored_from, created_by, reason)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING ${COLUMNS}`, [tenantId, input.key, input.expectedVersion + 1,
      input.document === null ? null : JSON.stringify(input.document), input.restoredFrom, input.createdBy, input.reason]);
    return view(rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error) || (error instanceof Error && error.message.includes('ADMIN_SETTINGS_VERSION_CONFLICT')))
      throw new Error('ADMIN_SETTINGS_VERSION_CONFLICT', { cause: error });
    throw error;
  }
}
