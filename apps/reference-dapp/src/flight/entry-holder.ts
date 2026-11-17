// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0): the one rule for "which FloFi account holds this Flight list address", shared by the boarding-recovery
 * email (what it says and whether it is sent), its hint on /board and the sign-in duplicate check, so they never disagree. The holder is the
 * account that claimed the entry (an emailed link or code proved the address to it); without a claim, an entry that boarded belongs to the
 * single account holding a pass that verified this address at sign-in (email code, Google or Apple). Anything else: no holder. Read only.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';

export type EntryHolder = { readonly entryId: string; readonly language: 'EN' | 'PT'; readonly opensAt: number | null; readonly boarded: boolean;
  readonly claimed: boolean; readonly accountId: string | null };
export async function entryHolder(q: Queryable, tenantId: string, email: string): Promise<EntryHolder | null> {
  const entry = (await q.query<{ entry_id: string; language: 'EN' | 'PT'; opens_at: Date | null; boarded_at: Date | null; account_id: string | null }>(`SELECT e.entry_id,
    e.language, b.opens_at, e.boarded_at, c.account_id FROM flight_list_entries e LEFT JOIN flight_batches b ON b.tenant_id = e.tenant_id AND b.batch_no = e.batch_no
    LEFT JOIN flight_access_claims c ON c.tenant_id = e.tenant_id AND c.entry_id = e.entry_id
    WHERE e.tenant_id = $1 AND e.email = $2 AND e.flight = 'FIRST'`, [tenantId, email])).rows[0];
  if (!entry) return null;
  let accountId = entry.account_id;
  if (!accountId && entry.boarded_at) {
    const verified = (await q.query<{ account_id: string }>(`SELECT DISTINCT p.account_id FROM flight_passes p JOIN flofi_account_identities i
      ON i.tenant_id = p.tenant_id AND i.account_id = p.account_id WHERE p.tenant_id = $1
      AND ((i.kind = 'EMAIL' AND i.subject = $2) OR (i.kind IN ('GOOGLE', 'APPLE') AND lower(i.label) = $2)) LIMIT 2`, [tenantId, email])).rows;
    accountId = verified.length === 1 ? verified[0]!.account_id : null;
  }
  return { entryId: entry.entry_id, language: entry.language, opensAt: entry.opens_at?.getTime() ?? null, boarded: entry.boarded_at !== null,
    claimed: entry.account_id !== null, accountId };
}
