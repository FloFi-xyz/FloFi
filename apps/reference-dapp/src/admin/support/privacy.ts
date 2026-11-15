// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P1): technical privacy controls for Support & Recovery (migration 0027).
 *
 *   Support text   recovery reasons and notes live in `admin_support_texts`, created in the SAME transaction as their audit event. The
 *                  append-only audit skeleton keeps only `textRef` and a digest (HMAC-SHA-256 of the body under the row's own random salt), so
 *                  deleting the text row — retention or an approved erasure — removes body and salt together and leaves the skeleton intact and
 *                  its digest unlinkable. A body is never copied to the audit JSON, a log line or an error.
 *   Lookup keys    SUPPORT_SEARCH fingerprints use a random key per calendar quarter, stored only wrapped (AES-256-GCM) under a key derived from
 *                  the admin secret (`FLOFI_ADMIN_SESSION_SECRET`): the database alone cannot compute a fingerprint. Destroying a past quarter's
 *                  key makes that quarter's fingerprints unlinkable without touching an audit row and without rotating the admin secret.
 *   Retention      periods are configuration (proposals until counsel approves them). Nothing is deleted unless an operator activated the policy
 *                  through the CLI with an approval reference (`privacy_retention_activations`); legal holds block deletion in the database.
 *
 * The retention periods here are PROPOSED values from BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 §9. They are not legal determinations.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import { typedId } from '../../platform/ids.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const PROPOSED_TEXT_RETENTION_DAYS = 365, PROPOSED_LOOKUP_RETENTION_DAYS = 365;
const days = (raw: string | undefined, fallback: number) => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 30 || n > 3650) throw new Error('SUPPORT_RETENTION_CONFIGURATION_INVALID');
  return n;
};
/** The configured periods. Optional variables; their defaults are the §9 proposals. Configuration alone never deletes anything. */
export function supportPrivacyConfig(env: Env): { readonly textRetentionDays: number; readonly lookupRetentionDays: number } {
  return { textRetentionDays: days(env.FLOFI_SUPPORT_TEXT_RETENTION_DAYS, PROPOSED_TEXT_RETENTION_DAYS),
    lookupRetentionDays: days(env.FLOFI_SUPPORT_LOOKUP_RETENTION_DAYS, PROPOSED_LOOKUP_RETENTION_DAYS) };
}

// --- Support text ---------------------------------------------------------------------------------------------------------------------
export type TextPurpose = 'RECOVERY_REASON' | 'SUPPORT_NOTE';
export const TEXT_REF = /^stx_[a-z2-7]{26}$/;
const digestOf = (salt: Buffer, body: string) => createHmac('sha256', salt).update(body, 'utf8').digest('hex').slice(0, 32);
/**
 * Stores one operator text and returns what the audit skeleton keeps. Call it inside the transaction that writes the audit event: either both
 * commit or neither does.
 */
export async function writeSupportText(tx: Queryable, tenantId: string, input: { readonly purpose: TextPurpose; readonly body: string; readonly runId: string | null;
  readonly incidentId: string | null; readonly actor: string; readonly now: Date; readonly retentionDays: number }): Promise<{ textRef: string; textDigest: string }> {
  const textRef = typedId('stx'), salt = randomBytes(32);
  await tx.query(`INSERT INTO admin_support_texts (tenant_id, text_id, purpose, body, salt, run_id, incident_id, created_by, created_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9::timestamptz + make_interval(days => $10))`,
  [tenantId, textRef, input.purpose, input.body, salt, input.runId, input.incidentId, input.actor, input.now, input.retentionDays]);
  return { textRef, textDigest: digestOf(salt, input.body) };
}
export type TextState = 'AVAILABLE' | 'REMOVED' | 'LEGACY';
/** The bodies of some texts (bounded), keyed by reference. A missing reference was removed (retention or erasure) — never an error. */
export async function readSupportTexts(db: Queryable, tenantId: string, refs: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(refs.filter(ref => TEXT_REF.test(ref)))].slice(0, 1000);
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ text_id: string; body: string }>(`SELECT text_id, body FROM admin_support_texts WHERE tenant_id = $1 AND text_id = ANY($2::text[])`,
    [tenantId, ids]);
  return new Map(rows.map(row => [row.text_id, row.body]));
}
/** The text an audit detail refers to: the separate store first, the legacy inline copy (written before this build) otherwise. */
export function resolveText(detail: Readonly<Record<string, unknown>>, refKey: string, legacyKey: string, texts: ReadonlyMap<string, string>): { text: string | null; state: TextState } {
  const ref = detail[refKey];
  if (typeof ref === 'string' && TEXT_REF.test(ref)) { const body = texts.get(ref); return body === undefined ? { text: null, state: 'REMOVED' } : { text: body, state: 'AVAILABLE' }; }
  const legacy = detail[legacyKey];
  return typeof legacy === 'string' ? { text: legacy, state: 'LEGACY' } : { text: null, state: 'REMOVED' };
}
/** Verifies a text against the digest its audit skeleton recorded (integrity of the separate store). */
export async function verifySupportText(db: Queryable, tenantId: string, ref: string, digest: string): Promise<'MATCH' | 'MISMATCH' | 'REMOVED'> {
  const { rows } = await db.query<{ body: string; salt: Buffer }>(`SELECT body, salt FROM admin_support_texts WHERE tenant_id = $1 AND text_id = $2`, [tenantId, ref]);
  return !rows[0] ? 'REMOVED' : digestOf(rows[0].salt, rows[0].body) === digest ? 'MATCH' : 'MISMATCH';
}

// --- Period-scoped lookup keys ---------------------------------------------------------------------------------------------------------
/** The calendar quarter (UTC) a lookup at `at` belongs to, e.g. `2026-Q4`. */
export const lookupPeriod = (at: Date) => `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
/** The first instant after a quarter (its end). */
export function periodEnd(period: string): Date {
  const match = /^([0-9]{4})-Q([1-4])$/.exec(period);
  if (!match) throw new Error('SUPPORT_LOOKUP_PERIOD_INVALID');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) * 3, 1));
}
/** The wrapping key, derived from the admin secret with its own label (separate from session sealing, CSRF and the v1 lookup subkey). */
export function lookupKek(adminKey: Buffer): { readonly key: Buffer; readonly id: string } {
  const key = Buffer.from(hkdfSync('sha256', adminKey, 'flofi', 'flofi/admin-lookup-kek/v1', 32));
  return { key, id: createHash('sha256').update(key).digest('hex').slice(0, 16) };
}
const wrap = (kek: Buffer, raw: Buffer, aad: string) => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
};
const unwrap = (kek: Buffer, wrapped: Buffer, aad: string) => {
  if (wrapped.length !== 60) throw new Error('SUPPORT_LOOKUP_KEY_UNAVAILABLE');
  const decipher = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(wrapped.subarray(44));
  return Buffer.concat([decipher.update(wrapped.subarray(12, 44)), decipher.final()]);
};
export type LookupFingerprint = { readonly fingerprint: string; readonly period: string; readonly kid: string; readonly fpv: 2 };
export type Fingerprinter = (value: string) => Promise<LookupFingerprint>;
const lookupHmac = (key: Buffer, value: string) => createHmac('sha256', key).update(`support-search.${value}`).digest('hex').slice(0, 16);

/** The quarter's key (created on first use, concurrency-safe), unwrapped. Throws when it was destroyed or cannot be unwrapped. */
async function periodKey(db: Queryable, tenantId: string, kek: { key: Buffer; id: string }, period: string, create: boolean): Promise<Buffer | null> {
  const aad = `${tenantId}|${period}|${kek.id}`;
  if (create) await db.query(`INSERT INTO admin_lookup_keys (tenant_id, period, wrapped_key, kek_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [tenantId, period, wrap(kek.key, randomBytes(32), aad), kek.id]);
  const { rows } = await db.query<{ wrapped_key: Buffer | null }>(`SELECT wrapped_key FROM admin_lookup_keys WHERE tenant_id = $1 AND period = $2 AND kek_id = $3`,
    [tenantId, period, kek.id]);
  if (!rows[0]) return null;
  if (!rows[0].wrapped_key) throw new Error('SUPPORT_LOOKUP_KEY_DESTROYED');
  try { return unwrap(kek.key, rows[0].wrapped_key, aad); } catch { throw new Error('SUPPORT_LOOKUP_KEY_UNAVAILABLE'); }
}
/** A fingerprinter for new lookups: the current quarter's key. Never stores or returns the value itself. */
export function periodFingerprinter(db: Queryable, tenantId: string, adminKey: Buffer, now: () => Date): Fingerprinter {
  const kek = lookupKek(adminKey);
  return async value => {
    const period = lookupPeriod(now()), key = await periodKey(db, tenantId, kek, period, true);
    if (!key) throw new Error('SUPPORT_LOOKUP_KEY_UNAVAILABLE');
    return { fingerprint: lookupHmac(key, value), period, kid: kek.id, fpv: 2 };
  };
}
/** The v1 subkey (before this build): kept only so access requests can still find lookups audited under it. */
export const legacySearchKey = (adminKey: Buffer) => Buffer.from(hkdfSync('sha256', adminKey, 'flofi', 'flofi/admin-support-search/v1', 32));

/**
 * Every fingerprint a value could have in the retained audit trail: one per quarter whose key still exists (and can be unwrapped), plus the
 * legacy v1 one. Read-only: never creates a key. Used by the access-request procedure.
 */
export async function candidateFingerprints(db: Queryable, tenantId: string, adminKey: Buffer, value: string): Promise<{ v1: string; v2: Map<string, string>;
  unavailablePeriods: string[] }> {
  const kek = lookupKek(adminKey);
  const { rows } = await db.query<{ period: string; kek_id: string; wrapped_key: Buffer | null }>(`SELECT period, kek_id, wrapped_key FROM admin_lookup_keys WHERE tenant_id = $1
    ORDER BY period`, [tenantId]);
  const v2 = new Map<string, string>(), unavailablePeriods: string[] = [];
  for (const row of rows) {
    if (!row.wrapped_key || row.kek_id !== kek.id) { unavailablePeriods.push(`${row.period}:${row.kek_id}`); continue; }
    try { v2.set(`${row.period}:${row.kek_id}`, lookupHmac(unwrap(kek.key, row.wrapped_key, `${tenantId}|${row.period}|${row.kek_id}`), value)); }
    catch { unavailablePeriods.push(`${row.period}:${row.kek_id}`); }
  }
  return { v1: lookupHmac(legacySearchKey(adminKey), value), v2, unavailablePeriods };
}
