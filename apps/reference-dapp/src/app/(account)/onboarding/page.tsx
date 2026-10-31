// SPDX-License-Identifier: AGPL-3.0-only
/** `/onboarding`: adding wallets is the whole onboarding now (BUILD-FLOFI-PRIVY-UX-001), so this address leads straight there. */
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export default function OnboardingPage() { redirect('/onboarding/wallets'); }
