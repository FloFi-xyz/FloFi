// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (P0): what the boarding-recovery email may say about the account that holds an address's boarding pass,
 * read at send time. Only for the address's own inbox (the email goes to the list address itself): the sign-in method kinds of that one account,
 * each masked, and its seat. The account is `entryHolder`'s; without one the email says nothing specific. Never a credential.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import { foundingSeat, passengerSeat } from './campaign.ts';
import { maskAddress } from './email/outbox.ts';
import type { RecoveryInput, RecoveryMethod } from './email/templates.ts';
import { entryHolder } from './entry-holder.ts';

const KIND: Readonly<Record<string, RecoveryMethod['kind']>> = { EIP155: 'wallet', SOLANA: 'solana', GOOGLE: 'google', APPLE: 'apple', EMAIL: 'email' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function hintOf(kind: RecoveryMethod['kind'], subject: string, label: string | null): string | null {
  if (kind === 'wallet') return /^0x[0-9a-f]{40}$/.test(subject) ? `${subject.slice(0, 6)}…${subject.slice(-4)}` : null;
  if (kind === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(subject) ? `${subject.slice(0, 4)}…${subject.slice(-4)}` : null;
  const address = kind === 'email' ? subject : label;
  return address && EMAIL.test(address) ? maskAddress(address.toLowerCase()) : null;
}

export async function boardingRecoveryHint(db: Queryable, tenantId: string, email: string): Promise<RecoveryInput> {
  const accountId = (await entryHolder(db, tenantId, email))?.accountId ?? null;
  if (!accountId) return { seat: null, methods: [] };
  const [pass, identities] = await Promise.all([
    db.query<{ founding_seat: number | null; boarding_no: number }>('SELECT founding_seat, boarding_no FROM flight_passes WHERE tenant_id = $1 AND account_id = $2', [tenantId, accountId]),
    db.query<{ kind: string; subject: string; label: string | null }>(`SELECT kind, subject, label FROM flofi_account_identities WHERE tenant_id = $1 AND account_id = $2
      AND kind <> 'PRIVY' ORDER BY created_at, kind LIMIT 8`, [tenantId, accountId])]);
  const seat = pass.rows[0] ? pass.rows[0].founding_seat ? { founding: true, label: foundingSeat(pass.rows[0].founding_seat) }
    : { founding: false, label: passengerSeat(pass.rows[0].boarding_no) } : null;
  // Wallets first: the method most people boarded with.
  const methods = identities.rows.flatMap(row => { const kind = KIND[row.kind]; return kind ? [{ kind, hint: hintOf(kind, row.subject, row.label) }] : []; })
    .sort((a, b) => Number(b.kind === 'wallet' || b.kind === 'solana') - Number(a.kind === 'wallet' || a.kind === 'solana'));
  return { seat, methods };
}
