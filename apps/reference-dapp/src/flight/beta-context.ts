// SPDX-License-Identifier: AGPL-3.0-only
/** Internal BFF → API contract. Never populate these values from a browser body or header. */
import { AsyncLocalStorage } from 'node:async_hooks';
export type BetaRequestIdentity = { readonly accountId: string; readonly sessionId: string };
const identities = new AsyncLocalStorage<BetaRequestIdentity | null>();
export const currentBetaIdentity = () => identities.getStore() ?? null;
export const withBetaIdentity = <T>(identity: BetaRequestIdentity | null, work: () => Promise<T>): Promise<T> => identities.run(identity, work);
export const BETA_ACCOUNT_HEADER = 'x-flofi-beta-account';
export const BETA_SESSION_HEADER = 'x-flofi-beta-session';
export const betaIdentityHeaders = (identity: BetaRequestIdentity | null | undefined): Record<string, string> => identity
  ? { [BETA_ACCOUNT_HEADER]: identity.accountId, [BETA_SESSION_HEADER]: identity.sessionId } : {};
export function betaIdentityFrom(headers: Readonly<Record<string, string | undefined>>): BetaRequestIdentity | null {
  const accountId = headers[BETA_ACCOUNT_HEADER], sessionId = headers[BETA_SESSION_HEADER];
  return accountId && sessionId && accountId.length <= 200 && sessionId.length <= 200 ? { accountId, sessionId } : null;
}
