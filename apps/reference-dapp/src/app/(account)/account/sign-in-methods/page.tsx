// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `/account/sign-in-methods` (BUILD-FLOFI-IDENTITY-RECOVERY-UX-001): the signed-in account's sign-in methods, linking another one, and the explicit
 * move of a sign-in out of an empty duplicate account. An account page (outside the Flight product gate, like onboarding): any signed-in
 * account manages its own ways in. Without a session it goes to sign-in, unless this browser is in the middle of a move.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { signInMethodsState } from '../../../account-action';
import { SignInMethodsScreen } from '../../../../components/account/sign-in-methods';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi · Sign-in methods', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function SignInMethodsPage() {
  const state = await signInMethodsState();
  if (!state.signedIn && !state.move) redirect('/login?returnTo=%2Faccount%2Fsign-in-methods');
  return <SignInMethodsScreen initial={state}/>;
}
