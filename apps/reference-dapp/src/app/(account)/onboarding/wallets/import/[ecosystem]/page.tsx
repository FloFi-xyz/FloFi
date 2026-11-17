// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: `/onboarding/wallets/import/evm` and `/onboarding/wallets/import/solana`, the dedicated private-key import
 * screen. It is an account page (strict nonce Content Security Policy, no workflow, Copilot or wallet-execution code mounted); the key
 * goes from its field to Privy's isolated wallet frame and never to FloFi's server.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { isOtherAccountOfBoardedPerson } from '../../../../../../flight/other-account';
import { accountState } from '../../../../../account-action';
import { ImportWallet } from '../../../../../../components/account/import-wallet';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi · Import a wallet', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function ImportWalletPage({ params }: { params: Promise<{ ecosystem: string }> }) {
  const { ecosystem } = await params;
  if (ecosystem !== 'evm' && ecosystem !== 'solana') notFound();
  const state = await accountState();
  if (!state.account) redirect(`/login?returnTo=${encodeURIComponent(`/onboarding/wallets/import/${ecosystem}`)}`);
  // Authentication UX & Login Regression Fix (P0): the person's OTHER account (no beta access of its own; its verified address is held by the
  // boarded account) never creates or imports a wallet: that would make it impossible to close, and keep its sign-in out of the boarded account.
  if (await isOtherAccountOfBoardedPerson(state.account.accountId, state.account.identities)) redirect('/board');
  return <ImportWallet state={state} ecosystem={ecosystem}/>;
}
