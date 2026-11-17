// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Authentication UX & Login Regression Fix (P0): a closed-beta account that is the person's OTHER FloFi account — it has no beta access of its
 * own, and one of its strongly verified addresses is held by another account (`heldElsewhere`) — is sent to /board, where "You boarded with
 * another sign-in." brings it back to the boarded account, instead of wallet onboarding or the product (which only hands it on to /board).
 *
 * Why it matters: wallet onboarding offered such an account "Create wallet". A wallet created there makes it hold something of its own, so it
 * can never be closed as an empty duplicate, and its sign-in method (typically Google) can then never be added to the boarded account. This
 * decides a destination only: it grants, links, closes and deletes nothing, and any failure answers "no" (the previous destination is kept).
 */
import { betaAccessMode } from './beta-access';
import { heldElsewhere, strongEmailsOf } from './held-elsewhere';
import { platformStateHost } from '../server/platform-state-host';

type Env = Readonly<Record<string, string | undefined>>;
type Identity = { readonly kind: string; readonly label: string | null };

export async function isOtherAccountOfBoardedPerson(accountId: string, identities: readonly Identity[], env: Env = process.env): Promise<boolean> {
  if (betaAccessMode(env) !== 'beta') return false;
  const emails = strongEmailsOf(identities);
  if (!emails.length) return false;
  try {
    const { db, tenantId } = await platformStateHost(env);
    // Any beta grant of its own (even a revoked one) means this is not an empty other account: the usual destinations apply.
    const granted = (await db.query('SELECT 1 FROM flight_beta_grants WHERE tenant_id = $1 AND account_id = $2 LIMIT 1', [tenantId, accountId])).rows.length > 0;
    return !granted && await heldElsewhere(db, tenantId, accountId, emails);
  } catch { return false; }
}

/** Where a sign-in that would land in wallet onboarding or the product goes instead, for such an account; any other destination is kept. */
export function otherAccountDestination(next: string): string {
  return /^\/(?:onboarding|app)(?:[/?]|$)/.test(next) ? '/board' : next;
}
