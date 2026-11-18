# Execution and reconciliation (FloFi engineering skill)

## Authority
- One economic attempt per authorized action. The Privy path: `floFiSigningGate` matches the exact bytes to the
  reviewed attempt and claims its single signature on the server; Privy then shows its own confirmation
  (`showWalletUIs: true`); FloFi re-checks the signed bytes before it broadcasts them once.
- A cancel in Privy spends that attempt (fail-closed); the person simulates again. Never re-sign silently, never
  retry a rejected or unknown signature, never create a new attempt behind the person's back.
- Bind the account, provider, chain, workflow revision, exact reviewed payload and fee payer through handoff.
  Recheck live EIP-7702 delegate code. An ERC-20 relay receipt can prove transfer without consuming the owner's
  transaction nonce. The journal must preserve that distinction.
- `CONFIRM_EACH_STEP` is the baseline workflow plan. `USER_FUNDED` depends on the registered flow and actual
  wallet capability. The retired executor-funded delegation has legacy read/revoke behavior. Automation
  `CONFIRM_EACH_TIME` triggers create an occurrence for approval.

## Gas
- Read `gas-abstraction/config.ts` and `gas-abstraction/mechanism.ts` for conditional paths. Native gas takes
  priority when covered or unknown. Confirmed shortages can select Circle owner-paid USDC on Ethereum, Base
  and Arbitrum, Pimlico Kora owner-paid USDC/USDT on Solana mainnet, or eligible 0x gasless ERC-20 swaps on
  Robinhood. Deployment and action/wallet gates apply. Operator sponsorship is separately controlled.
- Bind eligible currency, fee payer, fee ceilings and signature interactions to Review. First-use Circle
  for an eligible plain FloFi Wallet needs explicit EIP-7702 upgrade consent and an additional signature.
  Recheck native fees, including applicable chain data fees. A payer or payload change requires a fresh Review.

## Status
- Canonical lifecycle (`domain/canonical-execution-status.ts`): AUTHORIZATION_PENDING → SUBMITTED → HASH_KNOWN →
  CONFIRMED_ONCHAIN → (SETTLEMENT_PENDING for cross-chain) → RECONCILED; REJECTED, REVERTED, FAILED, INCONCLUSIVE.
  Only a reconciled outcome is "completed".
- Pages follow a submitted transaction with the shared observation schedule (2 s, then backing off for a few
  minutes) and resume from the durable record after a refresh; observation is read-only.
- Use flow-specific evidence for nonce conflicts and lost wallet responses. Destination delivery and canonical
  settlement can arrive separately. Keep the reconciled prefix across reload and between wallet requests.

## Measurement
- Journey timings are content-free (`domain/journey-metrics.ts`): the person's time in the wallet is reported
  separately from system latency. Percentiles need a genuine sample; label evidence LOCAL, MOCKED, PREVIEW or
  PRODUCTION truthfully.
- Journey telemetry is off unless the deployment owner opts in (`NEXT_PUBLIC_FLOFI_JOURNEY_TELEMETRY=on` and
  `FLOFI_JOURNEY_TELEMETRY=on`); its privacy policy is `docs/privacy/JOURNEY-TELEMETRY.md`. Never turn it on in a change.
