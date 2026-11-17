# BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001

Two production incidents reported on 2026-11-17 after BUILD-P1 (PR #206), and the liquidity position lifecycle audit requested with them.
Base: `origin/main` 944fe57 (includes PRs #205–#208). No production record, configuration, gate, fee policy or signing authority was
changed; no transaction was sent or signed; no migration or environment variable was added.

## EXEC-01 — Uniswap liquidity execution interrupted between approvals (P1)

### Incident (Neon journal, read-only, as reported)

Base mainnet (8453), Uniswap V3, 1 USDC + 0.001 WETH, run `balp-ae7ef0ce82cb5c1ae1a36c171f075013`:
execution created 18:07:28; APPROVE_TOKEN0 (WETH) prepared 18:07:50, confirmed and reconciled; Review expired 18:08:27.979 (60 s TTL);
APPROVE_TOKEN1 (USDC) **prepared 18:08:29.740, after the expiry**; cancelled 18:08:32.029 with `UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED`;
final status SIMULATED; no hash for APPROVE_TOKEN1; no MINT.

### Root causes

1. **Server: the prepare checked expiry only on entry** (`server/uniswap-liquidity-service.ts` `begin`). After the entry check it performs
   seconds of public reads (code, identities, pool, balances, allowances, nonces), an `eth_simulateV1` of the remaining calls and the fee
   checks (`eth_estimateGas`, L1 fee), then reserves the owner's nonce and persists PREPARED. A `begin` that started just before 18:08:27.979
   persisted the USDC request at 18:08:29.740. The hand-off also checked expiry only on entry and refused with the generic
   `UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED`; no margin existed between "prepared" and "handed off".
2. **Product UI: an expired Review could not be continued on the same run.**
   - `state/review-authorization.ts` made a uniswap-pool Review authorizable only with **zero attempts**.
   - "Simulate again" (`components/app-shell.tsx`) always **started a new run**.
   - `state/execution-start.ts` refused "Continue" for a step that had **any** earlier attempt, even a never-sent one.
   - `domain/financial-run-status.ts` showed the cancelled-before-wallet attempt as **"Cancelled"**, which reads as if the owner cancelled.
   - After a refresh, `domain/execution-lifecycle.ts` listed only the refreshed Review's calls, so the **confirmed WETH approval disappeared**
     from the run's history.
3. **Reload:** a recovered, still-pending Uniswap run was not put back on the Canvas (0 steps, "Simulate again" disabled), so after a
   reload the owner could not continue it. Lending and Solana compositions already restore their run's workflow.

The server already supported the safe continuation (`refresh` keeps attempts, re-reads allowances; a confirmed approval is not asked
again); the defect was the prepare race plus the missing product path to it.

### Reproduction (before the fix, on `origin/main`)

- `src/server/base-liquidity.test.ts` "EXEC-01 Review expiry between sequential wallet requests (MOCKED Base WETH/USDC)": the WETH approval
  confirms; `begin` for USDC starts 12 s before expiry with a 15 s gas estimate → **resolved with a PREPARED attempt after expiry**
  (`promise resolved … instead of rejecting`); a `begin` 5 s before expiry → prepared; the hand-off after expiry → generic
  `UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED`. All three tests fail on `origin/main` and pass with the fix.
- Browser, `/app` reload with a started run: Canvas empty, "Execution in progress", "Simulate again" disabled (fixed by the restore).

### Fix

Server (`server/uniswap-liquidity-service.ts`):
- `UNISWAP_REVIEW_HANDOFF_MARGIN_MS = 10_000`: `begin` refuses `UNISWAP_REVIEW_EXPIRED` on entry and **again after its reads, before
  reserving the nonce or persisting**; it records the error and clears the expired authorization (as the router does). `review()` refuses
  to authorize inside the margin. This never extends a Review.
- `handoff` refuses at entry **and after its fresh reads**; a provably unsent PREPARED attempt is concluded `CANCELLED /
  UNISWAP_REVIEW_EXPIRED` server-side (precedent: `ROUTER_REVIEW_EXPIRED`), the attempt's nonce can be prepared again.
- A run at its 16-attempt limit is refused before the nonce is reserved (`UNISWAP_ATTEMPT_LIMIT_SIMULATE_AGAIN`).

Client:
- `domain/uniswap-liquidity-continuation.ts`: `uniswapRunResumable` (every attempt is a confirmed, reconciled approval or a CANCELLED
  attempt with no hash), `uniswapRefreshInPlace`, `uniswapReviewAuthorizable` (a Review under which a request was declined or refused is
  refreshed first), `currentUniswapAttempts` (the bridges' `supersededUnsent` rule).
- `state/uniswap-liquidity-store.tsx`: after a pre-wallet refusal (`UNISWAP_REVIEW_EXPIRED`, `*_CHANGED_REVIEW_REQUIRED`) Execute refreshes
  the **same run** in place (read-only) and exposes `requoted`, the contract the bridges use, so the Review, the chat and the Canvas present
  the updated Review with why; authorizing in the last seconds does the same. Nothing is authorized, prepared or sent by itself.
- "Simulate again" of a started run refreshes it in place (a run that already attempted its mint starts a new simulation, as before; the
  duplicate-position guard is unchanged); the refreshed Review is authorizable; "Continue" ignores superseded never-sent attempts.
- Wording (EN/PT, `i18n/pt-liquidity-execution.ts`): a `*_REVIEW_EXPIRED` attempt is "not submitted" with "Your Review expired before
  FloFi asked your wallet…", never "Cancelled" or "declined". A legacy `HANDOFF_NOT_AUTHORIZED` attempt is called an expiry only when the
  record proves it (prepared at or after its own Review's expiry — the incident's case); otherwise it stays "not submitted".
- The lifecycle keeps confirmed steps that the refreshed Review no longer lists; a recovered pending run restores its exact workflow on the
  untouched Canvas (`RESTORE_LIQUIDITY_CANVAS`, same guard as lending: untouched initial Canvas, validated draft, one liquidity node, no
  authority).

### The production run

The record `balp-ae7ef0ce…` is untouched. With this build it reads: WETH approval confirmed; USDC approval **not submitted — Review expired**
(its record proves it); "Partially completed". The owner can continue it: "Simulate again" refreshes that run (the WETH allowance on chain
covers it, so only the USDC approval and the mint remain), the owner authorizes the updated Review, then confirms each request in their
wallet. FloFi does none of this by itself.

## UX-01 — Dashboard Current execution card (P2)

**Root cause** (`app/approved-ux-pages.css`): `.ux-row` wrapped only below a 700 px **viewport** and `.ux-row-actions` was `flex:none`, so
the status, "View current run" and ··· kept their full width while the name column (`flex:1; min-width:0`) took what was left — down to a
one-character column with `overflow-wrap:anywhere`. A narrow card (the split "Needs you | Current execution" layout, a side rail, browser
zoom) triggers it at desktop widths. Reproduced at 1440 px (screenshot: the title one character per line).

**Fix:** the row wraps by its own width: the name keeps at least `min(10rem, 100% − 54px)` before the actions move to their own line
(right-aligned as on one line); a status tag inside row actions may wrap at the narrowest widths. Shared by every `.ux-row` (Your workflows,
wallets, credentials, agents); no redesign.

**Regression:** `e2e/dashboard-productization.spec.ts` "the Current execution card keeps its name and network readable…" — widths 320, 375,
768, 1024, 1280, 1440 × zoom 80/90/100/125 % (zoom as the CSS viewport it leaves): no horizontal scroll, name column ≥ min(150 px, row − 60),
name and network ≤ 3 lines, status/button/menu inside the card and never over the text. Fails on `origin/main`, passes with the fix.

## Audit: the same defect in other sequential services

Read-only audit of every begin/hand-off/submit pair. Fixed where reproduced; the rest is recorded as follow-ups:

| Service | Finding | Action |
|---|---|---|
| Uniswap liquidity | prepare/hand-off race; no in-run continuation | **Fixed** (above) |
| Aave supply/repay/borrow/withdraw (`supply-service.ts`) | `begin` checked expiry before the fee preflight and lease logic; a request prepared under a Review that then expired was refused at hand-off and **left the owner's nonce leased** → new simulations failed `SUPPLY_NONCE_ALREADY_RESERVED` (reproduced) | **Fixed**: margin check before any reservation (and after the EIP-7702 proof reads); `review()` applies the margin. Test in `supply-service.test.ts` |
| Supply hand-off | reads, then an exact-expiry check; a refusal there still leaves the lease (dead end) | **Follow-up** (lease semantics in the lending core: release a lease held by a provably unsent attempt, or a narrow `recoverReview` path) |
| Lending composition (Base Sepolia) | UI `safeNext` refuses a step cancelled before the wallet | Follow-up (testnet only) |
| Router, universal (EVM/Solana), Robinhood transfer, Jupiter (Kora), Solana transfer, Orca submit | expiry checked before the last reads in begin/hand-off/submit (seconds of freshness); bridges re-quote in place, single requests carry only the reviewed bytes | Follow-up (not funds at risk; no path sends anything but the reviewed bytes) |
| Public swap, CoW | margin / pre-post check already present | Not affected |

## Liquidity position lifecycle audit

**Orca (Solana).** Confirmed: mainnet already implements OPEN, DECREASE_PARTIAL and EXIT in one service (`orca-liquidity-service.ts`,
`solana-mainnet-liquidity-action.ts`, cloud flow `orca-liquidity-mainnet`), with a server-side position registry (positions FloFi
recorded), on-chain inspection, simulation, Review and reconciliation (EXIT closes the position NFT and refunds rent; fees are collected;
pools emitting rewards are refused; there is no collect-only operation). The public product cannot reach decrease/exit: the operation picker
is the engineering panel only (404 on hosted deployments), and the chat path is tied to Devnet (`copilot-ai.tsx` reads Devnet positions;
`copilot-conversation.ts` builds a Devnet input and refuses other networks; public copy says it is not available on mainnets). Routing chat
decrease/exit to mainnet needs ~9 production files (the public Simulate must pass the staged operation — today it would simulate an OPEN —
network-scoped owner/positions, Review wording for EXIT) and has no mainnet DECREASE/EXIT test at any level. **Not included** here: medium-
high risk on real funds; scheduled with the lifecycle build.

**Uniswap V3 (EVM).** Confirmed: the public executor supports APPROVE_TOKEN0, APPROVE_TOKEN1 and MINT only; decrease/collect/burn exist in
the BUILD-006 engine bound to the local fork (chain 31337, loopback, Base pins, single owner). There is no public position discovery. BUILD-006
logic is not portable as is (decrease minimums reuse mint minimums; the exact collect bound breaks once fees accrue; anvil-only RPCs; 180 s
deadline). Gaps: compiler encoders/decoders and topics, discovery (`tokenOfOwnerByIndex`), a new executor and Review format, reconciliation
from receipt events, run namespaces and validator, routes ×4 networks, store/UI, chat and MCP, MOCKED harness and fork rehearsals. **Size
L/XL → separate BUILD-LIQUIDITY-LIFECYCLE**, phased: (a) read-only discovery and inspect; (b) collect only; (c) decrease; (d) exit and burn
(never with remaining liquidity or tokens owed; owner as recipient; NFT ownership, Position Manager identity, minimums and deadline bound at
Review and re-checked before each request).

Nothing in this build claims these capabilities as available.

## Specialist review

Nine read-only specialists (liquidity, security, wallet-execution, workflow, lending, bridge, frontend-ux, chat, infrastructure-ci; at most
three at once) reviewed the branch. No P0/P1 defect in the financial core; applied:
- begin clears an expired Review's authorization; a run at its 16-attempt limit is refused before the nonce is reserved;
- expiry wording only for `*_REVIEW_EXPIRED` (and legacy records that prove it); neutral copy that never claims confirmed steps;
  the Dashboard chip says "The Review expired before the wallet request", never "Wallet confirmation was declined";
- the store's `review()` refreshes in place when the server refuses a last-seconds authorization; `started` counts only current attempts;
  "Simulate again" never refreshes a run that attempted its mint (the duplicate-position guard is unchanged);
- chat (medium, both fixed with regressions): the store no longer shows the interim cancelled record while it refreshes in place (it ended
  the chat's follow-up before the updated Review arrived), and `uniswap-pool` offers "Refresh & review" after a pre-send refusal on the
  Canvas and in the Execute workspace (the incident's run after a reload no longer shows a disabled "Execution needs attention");
- lending: the margin also in supply `review()` and after the EIP-7702 proof reads;
- frontend: "Needs you" actions wrap like every row action; the responsive test uses the CSS's real 10rem (140 px) and checks that no row
  button or tag spills, on the Dashboard and in Your workflows.

## Integration with PR #209 (BUILD-FLOFI-CI-ARCHITECTURE-002)

`origin/main` d153f22 was merged into this branch (no rebase or force-push). The new CI architecture is kept as merged: eight browser
shards placed by the balancer (`uniswap-continuation` is placed automatically, with no manual shard or invented timing), the split
`default-product-1..2` / `execution-continuity-1..3` profiles, the supersede guard, DEC-0058 and the CI runbook. The only overlap was the
profile count in `scripts/test_ci_gcp_orchestration.py`: 58 on `main` + `uniswap-continuation` = 59.

## Tests

- Unit: `server/base-liquidity.test.ts` (incident reproduction, hand-off at entry and after reads, same-run continuation through mint with
  per-transaction Review commitments, reload/restart, wording and projections, attempt limit, Canvas restore), `state/uniswap-liquidity-store.test.tsx`
  (the real store's Execute against the real service: expiry before the prepare and during the wallet-session checks, last-seconds
  authorization, other refusals never refresh), `server/supply-service.test.ts` (lending reproduction, margin in `review()`).
- Browser: `e2e/uniswap-liquidity-continuation.spec.ts` (profile `uniswap-continuation`, MOCKED loopback harness and harness clock) and the
  UX-01 regression in `dashboard-productization.spec.ts` (profile `default-product`).
- The harness clock is read only when `GRYLOO_UNISWAP_LIQUIDITY_HARNESS=MOCKED_LOOPBACK_ONLY` (MOCKED provenance, loopback RPC).

## Limitations (honest)

- **Chat-only browser certification is not possible on MOCKED evidence.** The product Review must refuse to authorize a MOCKED result
  (`release-financial-provenance.spec.ts`), and a non-MOCKED loopback would need the deployed contracts' bytecode to pass the code pins. The
  browser test therefore makes the owner's authorizations and wallet requests through the very service the browser's server actions run;
  the browser covers authoring in the chat, the simulation, reload recovery, "Simulate again" on the same run and the history. The chat's
  reaction to the store's `requoted` is the bridges' existing, tested path; the store's Execute/authorize continuation is unit-tested
  against the real service. Live mainnet execution is not demonstrated.
- The Base Sepolia liquidity read list lacks `eth_estimateGas`, so the testnet harness cannot `begin` from the browser (pre-existing; the old
  `uniswap-liquidity.spec.ts` is stale and in no CI profile). Base, Arbitrum, Ethereum and Robinhood mainnet lists include it.
- Follow-ups listed in the audit table (supply hand-off lease, router/universal/transfer/Solana freshness re-checks, lending-composition
  `safeNext`).
