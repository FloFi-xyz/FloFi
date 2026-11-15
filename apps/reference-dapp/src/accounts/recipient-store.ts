// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: an account's Saved Recipients on PostgreSQL (`flofi_account_recipients`, migration 0028).
 *
 * Every statement is scoped by the deployment tenant AND the verified account id: another account's recipient id is indistinguishable from
 * one that does not exist (RECIPIENT_NOT_FOUND). Only public data is stored — a name and a public address — and every write runs the shared
 * contract's validators (`savedRecipientLabel`, `savedRecipientAddress`, `recipientLabelKey`). A saved recipient grants nothing: it is not a
 * key, a delegation, an allowlist entry or proof of ownership, and no execution path reads it.
 *
 * There is no address edit: changing an address is an explicit delete and create, so a recipient is never silently re-pointed. Saving an
 * address the account already saved returns the existing record (`created: false`, the caller's RECIPIENT_EXISTS) and changes nothing.
 *
 * Release A for 0028 (docs/deploy/RELEASE-SAVED-RECIPIENTS-0028.md): this build is certified for 0028 but does not ship it. The store is
 * available only when `schema_migrations` holds exactly the certified 0028 identity; otherwise every method fails with RECIPIENTS_UNAVAILABLE.
 * It never creates or alters a table at runtime.
 */
import { CERTIFIED_FORWARD_MIGRATIONS, isUniqueViolation, SHIPPED_MIGRATIONS, type Database, type MigrationIdentity } from '@defi-workflow-engine/cloud-runtime';
import { readSavedRecipient, recipientLabelKey, savedRecipientAddress, savedRecipientLabel, SAVED_RECIPIENT_ECOSYSTEMS, SAVED_RECIPIENT_ID,
  SAVED_RECIPIENT_LIMITS, type SavedRecipient, type SavedRecipientEcosystem } from '../domain/saved-recipients.ts';
import { typedId } from '../platform/ids.ts';
import { ACCOUNT_ID } from './account-model.ts';

/** Closed codes this store fails with (as `Error.message`). RECIPIENT_EXISTS is a result (`created: false`), never thrown. */
export type RecipientStoreCode = 'RECIPIENTS_UNAVAILABLE' | 'RECIPIENT_LABEL_INVALID' | 'RECIPIENT_ADDRESS_INVALID' | 'RECIPIENT_LABEL_TAKEN'
  | 'RECIPIENT_LIMIT' | 'RECIPIENT_NOT_FOUND' | 'ACCOUNT_NOT_FOUND';
export type NewRecipient = { readonly label: unknown; readonly address: unknown; readonly ecosystem: unknown };
export type RecipientCreated = { readonly recipient: SavedRecipient; readonly created: boolean };

/** The one migration identity that makes saved recipients available: 0028 as certified (and, from Release B, as shipped). */
export const SAVED_RECIPIENTS_MIGRATION: MigrationIdentity | null = [...SHIPPED_MIGRATIONS, ...CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations)]
  .find(m => m.version === 28 && m.name === 'saved_recipients') ?? null;
/** How long one database's availability answer is reused (per process). Release B becomes visible within this window. */
export const RECIPIENTS_AVAILABILITY_TTL_MS = 30_000;
const availability = new WeakMap<Database, { readonly at: number; readonly value: Promise<boolean> }>();

/**
 * Invisible formatting characters (zero-width, bidirectional embeddings, overrides and isolates, BOM) and C1 controls: a name shown beside a
 * destination address must not be able to reorder or hide text, so such names are refused (the shared label rule already refuses C0 controls).
 */
const FORMATTING = /[\u0080-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/u;
const fail = (code: RecipientStoreCode): never => { throw new Error(code); };
const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
type Row = { recipient_id: string; label: string; address: string; ecosystem: string; created_at: Date; updated_at: Date };
const COLUMNS = 'recipient_id, label, address, ecosystem, created_at, updated_at';
const recipientOf = (row: Row): SavedRecipient | null => readSavedRecipient({ id: row.recipient_id, label: row.label, address: row.address,
  ecosystem: row.ecosystem, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

/** A writable name and its comparison key, or RECIPIENT_LABEL_INVALID. */
export function writableRecipientLabel(value: unknown): { readonly label: string; readonly key: string } {
  const label = typeof value === 'string' && value.length <= 256 ? savedRecipientLabel(value) : null;
  const key = label && !FORMATTING.test(label) ? recipientLabelKey(label) : '';
  return label && key ? { label, key } : fail('RECIPIENT_LABEL_INVALID');
}
/** The canonical address for the stated ecosystem, or RECIPIENT_ADDRESS_INVALID (malformed, or shaped for the other ecosystem). */
export function writableRecipientAddress(ecosystem: unknown, value: unknown): { readonly ecosystem: SavedRecipientEcosystem; readonly address: string } {
  if (!SAVED_RECIPIENT_ECOSYSTEMS.includes(ecosystem as SavedRecipientEcosystem) || typeof value !== 'string' || value.length > 128) return fail('RECIPIENT_ADDRESS_INVALID');
  const address = savedRecipientAddress(ecosystem as SavedRecipientEcosystem, value);
  return address ? { ecosystem: ecosystem as SavedRecipientEcosystem, address } : fail('RECIPIENT_ADDRESS_INVALID');
}
const accountOf = (accountId: string) => (typeof accountId === 'string' && ACCOUNT_ID.test(accountId) ? accountId : fail('ACCOUNT_NOT_FOUND'));

export function createRecipientStore(db: Database, tenantId: string) {
  async function check(): Promise<boolean> {
    const identity = SAVED_RECIPIENTS_MIGRATION;
    if (!identity) return false;
    try {
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations WHERE version=$1 AND name=$2 AND sha256=$3',
        [identity.version, identity.name, identity.sha256]);
      return rows[0]?.n === 1;
    } catch { return false; }
  }
  const ready = async () => { if (!await store.available()) fail('RECIPIENTS_UNAVAILABLE'); };
  const store = {
    /**
     * True only when this database holds 0028 with the exact certified name and SHA-256 (cached briefly per process). Before Release B applies
     * 0028, it is false and every other method fails with RECIPIENTS_UNAVAILABLE.
     */
    async available(now = Date.now()): Promise<boolean> {
      const cached = availability.get(db);
      if (cached && now - cached.at < RECIPIENTS_AVAILABILITY_TTL_MS) return cached.value;
      const value = check();
      availability.set(db, { at: now, value });
      return value;
    },
    /** This account's saved recipients, oldest first (strictly read: a row the shared reader refuses is left out, never repaired). */
    async list(accountId: string): Promise<SavedRecipient[]> {
      await ready();
      const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM flofi_account_recipients WHERE tenant_id=$1 AND account_id=$2
        ORDER BY created_at, recipient_id LIMIT $3`, [tenantId, accountOf(accountId), SAVED_RECIPIENT_LIMITS.maxPerAccount]);
      return rows.map(recipientOf).filter((recipient): recipient is SavedRecipient => recipient !== null);
    },
    /**
     * Saves a public address under a name. The same ecosystem and address already saved by this account returns that record unchanged
     * (`created: false`): never a duplicate, never an overwrite of its name. A name already used by this account (case, accents and punctuation
     * ignored) is RECIPIENT_LABEL_TAKEN; the per-account cap is RECIPIENT_LIMIT.
     */
    async create(accountId: string, input: NewRecipient, now = new Date()): Promise<RecipientCreated> {
      const account = accountOf(accountId), { label, key } = writableRecipientLabel(input?.label);
      const { ecosystem, address } = writableRecipientAddress(input?.ecosystem, input?.address);
      await ready();
      return db.transaction(async tx => {
        // One writer per account at a time (the cap and the existence checks below stay exact under concurrency). NO KEY UPDATE does not
        // block foreign-key checks, so this account's sign-ins and sessions never wait for it.
        const held = await tx.query('SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2 FOR NO KEY UPDATE', [tenantId, account]);
        if (!held.rowCount) fail('ACCOUNT_NOT_FOUND');
        const existing = (await tx.query<Row>(`SELECT ${COLUMNS} FROM flofi_account_recipients WHERE tenant_id=$1 AND account_id=$2 AND ecosystem=$3
          AND address=$4`, [tenantId, account, ecosystem, address])).rows[0];
        if (existing) return { recipient: recipientOf(existing) ?? fail('RECIPIENT_ADDRESS_INVALID'), created: false };
        const counts = (await tx.query<{ total: number; named: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE label_key=$3)::int AS named
          FROM flofi_account_recipients WHERE tenant_id=$1 AND account_id=$2`, [tenantId, account, key])).rows[0];
        if (counts && counts.named > 0) fail('RECIPIENT_LABEL_TAKEN');
        if (counts && counts.total >= SAVED_RECIPIENT_LIMITS.maxPerAccount) fail('RECIPIENT_LIMIT');
        const row = (await tx.query<Row>(`INSERT INTO flofi_account_recipients (tenant_id, account_id, recipient_id, ecosystem, address, label, label_key,
            created_at, updated_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$8 WHERE EXISTS (SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2)
          RETURNING ${COLUMNS}`, [tenantId, account, typedId('rcp'), ecosystem, address, label, key, now]).catch((error: unknown) => {
          if (isUniqueViolation(error)) fail((error as { constraint?: string }).constraint === 'flofi_account_recipients_label' ? 'RECIPIENT_LABEL_TAKEN' : 'RECIPIENT_ADDRESS_INVALID');
          throw error;
        })).rows[0];
        if (!row) fail('ACCOUNT_NOT_FOUND');
        return { recipient: recipientOf(row!) ?? fail('RECIPIENT_ADDRESS_INVALID'), created: true };
      });
    },
    /** Renames one of this account's recipients. Its address never changes here. */
    async rename(accountId: string, recipientId: string, label: unknown, now = new Date()): Promise<SavedRecipient> {
      const account = accountOf(accountId), next = writableRecipientLabel(label);
      if (typeof recipientId !== 'string' || !SAVED_RECIPIENT_ID.test(recipientId)) fail('RECIPIENT_NOT_FOUND');
      await ready();
      const row = (await db.query<Row>(`UPDATE flofi_account_recipients SET label=$4, label_key=$5, updated_at=greatest(created_at, $6::timestamptz)
          WHERE tenant_id=$1 AND account_id=$2 AND recipient_id=$3 RETURNING ${COLUMNS}`, [tenantId, account, recipientId, next.label, next.key, now])
        .catch((error: unknown) => { if (isUniqueViolation(error)) fail('RECIPIENT_LABEL_TAKEN'); throw error; })).rows[0];
      if (!row) fail('RECIPIENT_NOT_FOUND');
      return recipientOf(row!) ?? fail('RECIPIENT_NOT_FOUND');
    },
    /** Removes one of this account's recipients (only the saved name and address; nothing on-chain or in any wallet changes). */
    async remove(accountId: string, recipientId: string): Promise<void> {
      const account = accountOf(accountId);
      if (typeof recipientId !== 'string' || !SAVED_RECIPIENT_ID.test(recipientId)) fail('RECIPIENT_NOT_FOUND');
      await ready();
      const removed = await db.query('DELETE FROM flofi_account_recipients WHERE tenant_id=$1 AND account_id=$2 AND recipient_id=$3',
        [tenantId, account, recipientId]);
      if (!removed.rowCount) fail('RECIPIENT_NOT_FOUND');
    },
  };
  return store;
}
export type RecipientStore = ReturnType<typeof createRecipientStore>;
