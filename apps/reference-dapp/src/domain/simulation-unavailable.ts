// SPDX-License-Identifier: AGPL-3.0-only
import { simulationError } from './simulation-presentation';
/** Explain the same canonical prerequisites that disable simulation; this never relaxes them. */
export function simulationUnavailableReason(facts: {
  incomplete: boolean; unsupported: boolean; walletRequired: boolean; providerUnavailable: boolean; staleQuote: boolean; error?: string | null;
}): string | null {
  if (facts.incomplete) return 'Complete the amount, assets, networks and recipient in Build before simulating.';
  if (facts.unsupported) return 'This workflow has no supported simulation route on the selected public mainnets.';
  if (facts.walletRequired) return 'Connect the wallet required for this workflow before simulating.';
  if (facts.error) return simulationError(facts.error);
  if (facts.providerUnavailable) return 'The simulation provider is temporarily unavailable. Try checking again shortly.';
  if (facts.staleQuote) return 'The previous quote expired. Simulate again to check a fresh quote before Review.';
  return null;
}
