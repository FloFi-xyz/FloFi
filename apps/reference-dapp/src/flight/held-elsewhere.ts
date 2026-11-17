// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (moved here unchanged by the Authentication UX & Login Regression Fix): whether a signed-in account is the
 * person's OTHER FloFi account — one of its strongly verified addresses (an email-code identity, or a Google sign-in on Google's own mail
 * domain) is a Flight list address that ANOTHER account holds (`entryHolder`: claimed, or boarded with a pass). One rule for /board's
 * "You boarded with another sign-in." state and for where such an account lands after signing in, so they never disagree. Hints only: never
 * access, never a claim, never about anyone but the signed-in account. Read only.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import { normalizeEmail } from './campaign';
import { entryHolder } from './entry-holder';

type Identity = { readonly kind: string; readonly label: string | null };

/** The addresses verified strongly enough for this hint (the list's own address rule, `normalizeEmail`). */
export function strongEmailsOf(identities: readonly Identity[]): string[] {
  return [...new Set(identities.flatMap(identity => {
    const email = normalizeEmail(identity.label);
    return email && (identity.kind === 'email' || (identity.kind === 'google' && /@(?:gmail|googlemail)\.com$/.test(email))) ? [email] : [];
  }))];
}

/** Whether one of these strongly verified addresses is held by an account other than `accountId` (at most four addresses are read). */
export async function heldElsewhere(q: Queryable, tenantId: string, accountId: string, strongEmails: readonly string[]): Promise<boolean> {
  for (const email of strongEmails.slice(0, 4)) {
    const holder = await entryHolder(q, tenantId, email);
    if (holder?.accountId && holder.accountId !== accountId) return true;
  }
  return false;
}
