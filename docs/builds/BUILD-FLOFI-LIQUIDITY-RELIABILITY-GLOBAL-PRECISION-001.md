# BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001

Baseline: `main` `c07abcc` (merge of PR #226). One pull request, three workstreams in separate commits, plus review fixes.
Evidence level: deterministic unit tests and MOCKED loopback browser profiles. **No real transaction was signed or sent; no production data,
migration, environment variable or infrastructure was changed. Automated certification is not mainnet financial validation.**

## A — Liquidity execution reliability (P0)

### Incident
Base, 2026-11-20 13:45–13:48 UTC, run `balp-3e4b2c940cf5ad63a881e19042f50b63` (a Uniswap V3 liquidity removal): repeated refusals
`UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED`; the run later reconciled (`RECONCILED`, evidence archived). The production run record was not read for
this build; the diagnosis is from the code and a deterministic reproduction.

### Root cause
The Uniswap V3 liquidity runtime (`server/uniswap-liquidity-service.ts`; position operations reuse its `feeEnvelope` / `assertRequestFees`):
- `feeEnvelope` stored the GasPriceOracle's **instantaneous** `getL1FeeUpperBound` as the reviewed L1 bound, with **no headroom**;
- `assertRequestFees` (begin and hand-off) refused when the current L1 estimate exceeded that bound by a single wei;
- every refresh froze a new instantaneous bound, so the next L1 block refused again: a manual retry loop.

The bridges had exactly this defect and were fixed on 2026-11-13 (BUILD-FLOFI-MAINNET-EXEC-002, `workflow-contracts/src/network-fee.ts`:
`l1FeeReviewBound` 2× headroom, one authorized "Network fee, at most X"). The Uniswap runtime was never migrated.

### Fix (commits `ef88886` + review fixes)
- **Review**: each call's L1 bound is `l1FeeReviewBound(estimate)` (2×, the same headroom as `maxFeePerGas = 2 × base fee + priority`); it is
  part of `fees.totalUpperBoundWei`, the "Network fee, at most" the owner sees and authorizes, and is bound by the Review commitment. The owner's
  balance must cover all of it.
- **Begin / hand-off**: wallet-controlled fields (gas limit, max fee, priority fee, nonce, to, data, value, chain) stay exactly the reviewed ones.
  The request stands while `gas limit × signed max fee + current L1 ≤ X` — i.e. the current L1 is within its reviewed bound. This is deliberately
  stricter than the routers' current-price check (security review): "at most X" holds even if the gas price rises to the signed cap before
  inclusion. Beyond X: nothing is prepared, the authorization is cleared and the **same run** is refreshed in place (`UNISWAP_REFRESH_IN_PLACE`);
  the owner authorizes the new figure explicitly. Never a silent increase.
- **Hand-off refusal**: the PREPARED attempt is provably unsent (the wallet is called only after SUBMITTING is durable), so it is concluded
  CANCELLED with its reason at once: its nonce and the position claim are free, and the refreshed Review reuses the same nonce.
- **Unanswered reads**: a GasPriceOracle read the network did not answer is retried, never reported as a fee change that clears authority.
- **Reconciliation**: wallet-controlled field violations stay DIVERGENT. The L1 part is charged at inclusion and no transaction can cap it: a
  confirmed transaction whose charged total ended above X is the reviewed one; the overrun is recorded on the attempt
  (`UNISWAP_NETWORK_FEE_ABOVE_AUTHORIZED:<charged>:<authorized>`, shown in the run's evidence) and the run reconciles — as the routers do — instead
  of freezing a correct approval, deposit or withdrawal.
- Unchanged: nonce reservation and checks, wallet/owner, recipient, balances, deadline, slippage minimums, simulation materiality, signing,
  discovery by nonce, observation-only after an unknown outcome, reconciliation of effects.

### Tests (`server/uniswap-l1-fee-reliability.test.ts`, MOCKED Base chain; harness `setL1Fee`)
- the incident: L1 ×1.5 then ×2 after Review → prepared, handed off, sent once, reconciled (fails on `c07abcc` with exactly the incident code);
- beyond X → refused before anything is prepared, authorization cleared, same run refreshed, explicit re-authorization, one send;
- L1 just above its bound while today's gas price would leave room → refused (the strict ceiling);
- hand-off refusal → concluded at once, refreshed, same nonce, no duplicate;
- unknown wallet outcome → no refresh, re-authorization, prepare or hand-off; observation only; reconciled once mined;
- charged total exactly X → reconciled, no note; X + 1 wei → reconciled with the recorded overrun;
- GasPriceOracle outage → retried, authorization kept;
- mint path: L1 moves between approvals and mint; hand-off refusal → same nonce for the same step;
- a 100% removal keeps the NFT with zero liquidity; closing burns it.

## B — Liquidity Review UX (P1)

`SimulationStep.summary` (`domain/simulation-presentation.ts`) is the short Review of a Uniswap V3 or Orca position operation, rendered by
`liquidityPositionResultRows` in Simulate and Execute:

| Row | Simulate | Execute |
|---|---|---|
| Operation (plain words) | ✓ | ✓ |
| Pool: protocol · network · pair · fee tier | ✓ | ✓ |
| Position (compact id · share) | ✓ | ✓ |
| You receive (estimated) — principal + owed tokens/fees, ≈ | ✓ | ✓ |
| Minimum you receive — only the chain-enforced principal minimum (a collection: "You receive, at least") | ✓ | ✓ |
| Account rent refunded (Orca exit) | ✓ | ✓ |
| Position NFT: stays / burned / closed | ✓ | ✓ |
| Slippage · Recipient (Your wallet · 0x1234…abcd) · Wallet requests | — | ✓ |
| Network fee, at most · Token permission (existing rows) | fee | ✓ |

Raw liquidity, range, ticks, prices, exact amounts, deadline, contract and how each figure is built stay exact under Technical details (the
Simulation Summary renders every step detail and warning). Visible warnings: an irreversible close, an out-of-range position, real funds; the
operation is no longer repeated as an amber banner. Footer and single primary action unchanged (PR #226 behaviour).

Evidence (`BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001/`, panels rendered from real MOCKED runs of the services with the built CSS;
system fonts): 50 % Uniswap withdrawal, Execute — 22 rows + 6 amber notes → 11 rows + 1; height 1,571 → 738 px at 460 px wide, 1,778 → 882 px at
360 px. Simulate 989 → 507 px. Orca exit Execute 1,164 → 791 px.

## C — Global token precision policy

### Audit
Most existing "exact" formatters feed values back (editor seeds, workflow fields, re-parsed Review strings, sequence bindings, model grounding),
so they stay exact: `jupiter-authoring formatTokenAmount`, `formatHumanAmount`, `formatLendingAmount`, `lendingHuman`, `formatEth`,
`formatAssetAmount`, `simulationAmount`. The rule is applied at the rendering edge and in display-only formatters.

### Implementation
- `domain/token-amount-display.ts`: `displayTokenAmount` / `formatDisplayTokenAmount` — six significant digits (not decimals), BigInt exact
  arithmetic for any decimals and magnitude, trailing zeros removed, no scientific notation, a non-zero amount never 0, unavailable never 0,
  rounding by purpose (estimate nearest + "≈", minimum down, maximum up), EN/PT separators, compact unit from 1,000,000 (1.23457M · 1,23457 mi).
  `shortTokenDecimal` (composed domain strings) never zero-fills integer digits. `displayAmountExpression` handles "a + b" fields and ≥/≤ bounds.
- `components/token-amount-text.tsx`: the short value; when not exact, a button (`aria-expanded`) that reveals the exact value with Copy — tap,
  click or keyboard, never hover only.
- Display formatters delegated: `shortDecimal` (Review block, chat cards), `significantAmount` (Canvas card estimates), `feeAmountText`,
  `nativeAmount`/`nativeBalance`, `compactLendingAmount`, copilot position amounts, portfolio balances (`exactTokenAmount` alongside),
  receipt `readableAmount`.
- Rendering edges: Simulate/Execute rows, Simulation Summary, portfolio, DeFi positions, receipts, run progress, chat step messages.
- Borrow/Repay/Withdraw panels used JavaScript `Number` on 18-decimal amounts (lost digits): now BigInt; the authorized amount and "exactly"
  sentences show every digit, budgets round up, health factors round down.

### Not changed (by design)
User-typed amounts and messages; inputs; token approvals/permission values ("Exactly N", "up to N") and authorization limits (exact by consent);
the FloFi Wallet signing summary; Technical details' exact figures; owner-authored automation/DCA amounts; model-written chat text. Quotes,
calldata, base units, slippage, approvals, fees, persisted values and API contracts are untouched.

### Deviation
The brief's example "1234.567891 → ≈ 1234.57": the same six digits are shown with the locale's thousands separator, "≈ 1,234.57" (PT
"≈ 1.234,57"), as every other amount in the product and per "respeitar separadores de PT e EN". Composer card estimates stay ungrouped as before.

## Acceptance (technical status; product acceptance is separate)

| Criterion | Status |
|---|---|
| L1 fee changes no longer cause avoidable refusals within authorized limits | IMPLEMENTED · TECHNICALLY TESTED (MOCKED) — not validated on mainnet |
| Removal preserves its state across failures and resumptions | IMPLEMENTED · TECHNICALLY TESTED (MOCKED) |
| Pool Reviews short, readable and financially safe | IMPLEMENTED · VISUALLY REVIEWED (component renders) |
| Token amounts at ≤ 6 significant digits on the main surfaces | IMPLEMENTED (surfaces listed above) · PARTIAL for model-written chat text and owner-authored values (by design) |
| Exact values accessible and untouched in the engine | IMPLEMENTED · TECHNICALLY TESTED |
| No transaction rounded, duplicated or silently modified | TECHNICALLY TESTED (no financial path consumes display strings) |
| Product acceptance | PENDING — FloFi product team |

## Specialist reviews (dispositions)
- **Security** (no P0/P1): strict ceiling at the signed cap — fixed; `shortTokenDecimal` zero-filled large integers — fixed; lending panels
  rounded health factor/authorized amount — fixed; stale docstrings — fixed. `bridgeReviewChanges` compares shortened strings: pre-existing,
  unchanged semantics, follow-up.
- **Wallet execution** (no P0–P2): unanswered oracle read cleared authority — fixed; hand-off refusal kept the nonce until observed — fixed;
  test gaps (boundary X/X+1, unknown outcome, mint-path refusal, oracle outage) — added. Review requires the 2× L1 in balance — kept,
  deliberate ("must be able to pay the X you authorize"), same as the routers. Legacy cross-Review bound fallback and relayer-paid fee reporting —
  pre-existing, follow-ups.
- **Liquidity** (no P0–P2): minimum included non-enforced owed tokens — fixed (enforced floor only); Orca/Uniswap row meanings — aligned; fee
  overrun froze correct runs — now recorded and reconciled; technical warnings remain in Technical details.
- **Workflow** (one P2): after a hand-off refusal the browser kept a stale PREPARED record (the server had concluded it, so the wallet-failure
  report was refused) — both stores now read the current record; a simulation revert at hand-off maps to the in-place refresh code; concluded
  hand-off refusals read "not submitted". Follow-ups: overrun not surfaced as an attention line in evidence; the oracle "no bound" path covers
  any answered error (fails closed).
- **Frontend UX** (two P2): "Your wallet" only when the recipient is the owner; dashboard position facts and the on-chain amount title now give
  exact access. P3: one "≈" per field, compact exact values open the disclosure, no zero-filled digits beyond trillions, Canvas estimates in PT
  separators, stable accessible name, 24 px tap height, owner-configured amounts exact. Not changed: the fee-shortfall blocker numbers have
  directional rounding but no disclosure (the exact figures are in its Technical details); closing is stated in the operation, the NFT row and
  one warning (kept: it is irreversible).
- **Infrastructure/CI** (one medium): the new regression suites are registered and required in coverage.json; panel test pins the fee maximum
  and minimum rounding; a portfolio case exercises rounding and the disclosure. No screenshot baseline shows an affected amount.

## Validation (local)
- `pnpm test`: 9,752 passed, 2 environment-gated skips; typecheck, lint, governance-lite and `agent_guard.py check` pass.
- Browser profiles (MOCKED loopback): see the pull request for the local list; CircleCI on the exact head is the certification.

## Limitations
- MOCKED evidence only; the incident's real-world resolution needs a read-only observation of the next Base removal in production.
- A 2× L1 jump between Review and inclusion still exceeds X (L1 is uncapped); it is recorded honestly, never hidden.
- `bridgeReviewChanges` (re-quote diff) still compares six-significant-digit strings (pre-existing).
