// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `/login` (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001). A verified FloFi session continues to the app (or to adding
 * wallets); everyone else signs in with Privy. Disconnect lands here (`accountSignOut`).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { accountState } from '../../account-action';
import { safeReturnPath } from '../../../accounts/account-session';
import { SignInScreen } from '../../../components/account/sign-in';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi · Sign in', robots: { index: false, follow: false }, referrer: 'no-referrer' };
type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams, state = await accountState();
  const returnTo = safeReturnPath(one(params.returnTo) ?? '/app');
  const error = one(params.error), code = error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error) ? error : null;
  // A returning, still-valid session goes straight on, unless the page shows an error.
  if (state.account && !code) redirect(state.account.onboarding === 'pending' ? '/onboarding/wallets' : returnTo);
  return <SignInScreen state={state} initialError={code} returnTo={returnTo}/>;
}
