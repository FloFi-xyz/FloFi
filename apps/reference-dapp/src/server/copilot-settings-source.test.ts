// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the web chat's Copilot settings source during a rolling deployment. The settings table needs only the migration that
 * created it: a history that stops before it means no administrator ever chose settings; a different history fails closed. Platform state
 * itself is used whenever it opens. (End to end against PostgreSQL and the real migration runner: `admin/rollout.pg.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import type { MigrationIdentity, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { settingsTableApplied, SETTINGS_MIGRATION, webCopilotSettingsReader } from './copilot-settings-source.ts';

const id = (version: number, name: string): MigrationIdentity => ({ version, name, sha256: String(version % 10).repeat(64) });
const shipped = [id(1, 'execution_core'), id(2, 'swap_attempt_states'), id(3, SETTINGS_MIGRATION), id(4, 'future_change')];
const ledger = (rows: readonly MigrationIdentity[]): Queryable => ({
  query: async <R,>(_text: string, values?: readonly unknown[]) => {
    const limit = Number(values?.[0]);
    const selected = rows.filter(row => row.version <= limit);
    return { rows: selected as unknown as R[], rowCount: selected.length };
  },
}) as Queryable;

describe('BUILD-ADMIN-001 Copilot settings source (rolling deployments)', () => {
  it('knows whether the settings table exists from the exact applied history up to the migration that created it', async () => {
    expect(await settingsTableApplied(ledger(shipped.slice(0, 3)), shipped)).toBe(true);
    expect(await settingsTableApplied(ledger(shipped), shipped)).toBe(true); // later migrations are irrelevant to this table
    expect(await settingsTableApplied(ledger([...shipped, id(5, 'unknown_to_this_build')]), shipped)).toBe(true);
    expect(await settingsTableApplied(ledger(shipped.slice(0, 2)), shipped)).toBe(false); // not applied yet: no settings can exist
    expect(await settingsTableApplied(ledger([]), shipped)).toBe(false);
    await expect(settingsTableApplied(ledger([shipped[0]!, { ...shipped[1]!, sha256: 'f'.repeat(64) }, shipped[2]!]), shipped)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(settingsTableApplied(ledger([shipped[0]!, shipped[2]!]), shipped)).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
    await expect(settingsTableApplied(ledger(shipped), shipped.slice(0, 2))).rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  });
  it('reads through platform state whenever it opens, and never hides any other platform-state failure', async () => {
    const queried: string[] = [];
    const db = { query: async (text: string) => { queried.push(text); return { rows: [{ version: 3, document: null, restored_from: null, created_by: 'cli', reason: null,
      created_at: new Date('2026-10-14T00:00:00Z') }], rowCount: 1 }; } };
    const host = { db, tenantId: 'default' } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof webCopilotSettingsReader>[1]>>>;
    expect(await webCopilotSettingsReader({}, async () => host)()).toMatchObject({ version: 3, document: null });
    expect(queried.join()).toContain('admin_settings_versions');
    for (const code of ['DATABASE_URL_REQUIRED', 'ECONNREFUSED', 'TENANT_INVALID'])
      await expect(webCopilotSettingsReader({}, async () => { throw new Error(code); })()).rejects.toThrow(code);
  });
});
