// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: `/onboarding/wallets/import/evm` and `/onboarding/wallets/import/solana`, the dedicated private-key import
 * screen. It is an account page (strict nonce Content Security Policy, no workflow, Copilot or wallet-execution code mounted); the key
 * goes from its field to Privy's isolated wallet frame and never to FloFi's server.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { accountState } from '../../../../../account-action';
import { ImportWallet } from '../../../../../../components/account/import-wallet';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi · Import a wallet', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function ImportWalletPage({ params }: { params: Promise<{ ecosystem: string }> }) {
  const { ecosystem } = await params;
  if (ecosystem !== 'evm' && ecosystem !== 'solana') notFound();
  const state = await accountState();
  if (!state.account) redirect(`/login?returnTo=${encodeURIComponent(`/onboarding/wallets/import/${ecosystem}`)}`);
  return <ImportWallet state={state} ecosystem={ecosystem}/>;
}
