// SPDX-License-Identifier: AGPL-3.0-only
import { SIMULATION_AVAILABILITY_CHECKING, simulationError } from './simulation-presentation';
/** Explain the same canonical prerequisites that disable simulation; this never relaxes them. */
export function simulationUnavailableReason(facts: {
  incomplete: boolean; unsupported: boolean; walletRequired: boolean; providerUnavailable: boolean; staleQuote: boolean; error?: string | null;
  /** The runtime's availability has not answered yet: unknown, never "unavailable" (the control stays closed meanwhile). */ availabilityChecking?: boolean;
}): string | null {
  if (facts.incomplete) return 'Complete the amount, assets, networks and recipient on the Canvas before simulating.';
  if (facts.unsupported) return 'This workflow has no supported simulation route on the selected public mainnets.';
  if (facts.walletRequired) return 'Connect the wallet required for this workflow before simulating.';
  if (facts.error) return simulationError(facts.error);
  if (facts.availabilityChecking) return SIMULATION_AVAILABILITY_CHECKING;
  if (facts.providerUnavailable) return 'The simulation provider is temporarily unavailable. Try checking again shortly.';
  if (facts.staleQuote) return 'The previous quote expired. Simulate again to check a fresh quote before Review.';
  return null;
}
