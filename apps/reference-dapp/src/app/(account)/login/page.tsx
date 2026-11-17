// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `/login` (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001). A verified FloFi session continues to the app (or to adding
 * wallets); everyone else signs in with Privy. Disconnect lands here (`accountSignOut`).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { accountState, signInMethodsState } from '../../account-action';
import { safeReturnPath } from '../../../accounts/account-session';
import { needsWalletOnboarding } from '../../../accounts/account-model';
import { SignInScreen } from '../../../components/account/sign-in';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi · Sign in', robots: { index: false, follow: false }, referrer: 'no-referrer' };
type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams, state = await accountState();
  const returnTo = safeReturnPath(one(params.returnTo) ?? '/app');
  const error = one(params.error), code = error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error) ? error : null;
  // BUILD-FLOFI-IDENTITY-RECOVERY-UX-001: a step-up (`reauth=1`) or the second half of a duplicate-account move (`move=1`, with this browser's own
  // sealed move intent) asks for a sign-in even with a valid session.
  // The move mode comes from the URL: a Google return to `/login?move=1` is a cross-site navigation that never carries the SameSite=Strict intent
  // cookie, while the sign-in itself (a same-site server action) does, and the server checks the intent there (`privySignIn`).
  const reauth = one(params.reauth) === '1' && state.account !== null;
  const moveAsked = one(params.move) === '1';
  const move = moveAsked ? (await signInMethodsState().catch(() => null))?.move ?? null : null;
  // A returning, still-valid session goes straight on, unless the page shows an error.
  if (state.account && !code && !reauth && !moveAsked) redirect(needsWalletOnboarding(state.account) ? '/onboarding/wallets' : returnTo);
  return <SignInScreen state={state} initialError={code} returnTo={returnTo} mode={reauth ? 'reauth' : moveAsked ? 'move' : null} moving={move?.methods ?? []}/>;
}
