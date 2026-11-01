# Execution and reconciliation (FloFi engineering skill)

## Authority
- One economic attempt per authorized action. The Privy path: `floFiSigningGate` matches the exact bytes to the
  reviewed attempt and claims its single signature on the server; Privy then shows its own confirmation
  (`showWalletUIs: true`); FloFi re-checks the signed bytes before it broadcasts them once.
- A cancel in Privy spends that attempt (fail-closed); the person simulates again. Never re-sign silently, never
  retry a rejected or unknown signature, never create a new attempt behind the person's back.

## Status
- Canonical lifecycle (`domain/canonical-execution-status.ts`): AUTHORIZATION_PENDING → SUBMITTED → HASH_KNOWN →
  CONFIRMED_ONCHAIN → (SETTLEMENT_PENDING for cross-chain) → RECONCILED; REJECTED, REVERTED, FAILED, INCONCLUSIVE.
  Only a reconciled outcome is "completed".
- Pages follow a submitted transaction with the shared observation schedule (2 s, then backing off for a few
  minutes) and resume from the durable record after a refresh; observation is read-only.

## Measurement
- Journey timings are content-free (`domain/journey-metrics.ts`): the person's time in the wallet is reported
  separately from system latency. Percentiles need a genuine sample; label evidence LOCAL, MOCKED, PREVIEW or
  PRODUCTION truthfully.
