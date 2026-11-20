// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { simulationUnavailableReason } from './simulation-unavailable';
it('keeps missing fields, unsupported routes, wallet prerequisites, provider failures and stale quotes distinct', () => {
  const facts = { incomplete: false, unsupported: false, walletRequired: false, providerUnavailable: false, staleQuote: false };
  expect(simulationUnavailableReason(facts)).toBeNull();
  const reasons = Object.keys(facts).map(key => simulationUnavailableReason({ ...facts, [key]: true }));
  expect(reasons.every(Boolean)).toBe(true); expect(new Set(reasons).size).toBe(5);
});
it('says a runtime whose availability has not answered is being checked, after the owner\'s own prerequisites and any refusal', () => {
  const facts = { incomplete: false, unsupported: false, walletRequired: false, providerUnavailable: true, staleQuote: false, availabilityChecking: true };
  expect(simulationUnavailableReason(facts)).toBe('Checking whether simulation is available on this network…');
  expect(simulationUnavailableReason({ ...facts, availabilityChecking: false })).toBe('The simulation provider is temporarily unavailable. Try checking again shortly.');
  expect(simulationUnavailableReason({ ...facts, incomplete: true })).toBe('Complete the amount, assets, networks and recipient on the Canvas before simulating.');
  expect(simulationUnavailableReason({ ...facts, error: 'SIMULATION_FAILED' })).not.toBe('Checking whether simulation is available on this network…');
});
