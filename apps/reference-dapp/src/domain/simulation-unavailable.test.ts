// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { simulationUnavailableReason } from './simulation-unavailable';
it('keeps missing fields, unsupported routes, wallet prerequisites, provider failures and stale quotes distinct', () => {
  const facts = { incomplete: false, unsupported: false, walletRequired: false, providerUnavailable: false, staleQuote: false };
  expect(simulationUnavailableReason(facts)).toBeNull();
  const reasons = Object.keys(facts).map(key => simulationUnavailableReason({ ...facts, [key]: true }));
  expect(reasons.every(Boolean)).toBe(true); expect(new Set(reasons).size).toBe(5);
});
