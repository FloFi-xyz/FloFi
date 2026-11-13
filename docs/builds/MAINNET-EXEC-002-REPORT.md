# BUILD-FLOFI-MAINNET-EXEC-002 — Mainnet execution, cross-chain wallets, compact UX and gas abstraction

Branch `claude/laughing-mccarthy-gdvf0m`, base `origin/main` @ `bef4419` (includes PR #188). Evidence levels are stated per item: **unit**
(deterministic doubles), **browser** (Playwright on loopback harnesses), **production read-only** (data read from production, nothing
written or signed). No transaction was signed or sent and no real funds moved during this build.

## 1. Bridge refusal of 13/11/2026 (2 USDC Base → Arbitrum, wallet 0x4b21…b3ce)

### Diagnosis (production read-only)

The Router run log of the refused attempt showed two independent false refusals between Review and the owner's confirmation (15–54 s):

| Refusal | Root cause |
| --- | --- |
| `ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED` | The reviewed OP Stack L1 data-fee bound (`GasPriceOracle.getL1FeeUpperBound`) was authorized with **no headroom**; the L1 fee moved ×2.24 in 54 s, so any later call's L1 fee exceeded it although the call's **total** network fee stayed far below the authorized maximum (`gasLimit × maxFeePerGas + L1 bound`). |
| `ROUTE_CHANGED` (fees) | The provider-fee drift tolerance was a fixed 72 base units: Across re-priced its LP fee by > 1 % within the minute, a normal market move. Separately, fee lines with a `null` recipient (no transfer target) were compared as if they were recipients, a false "route changed". |
| Chat continuity | The conversation's in-place re-quote recognised `QUOTE_MOVED` but not `FEES_CHANGED`, so the chat asked to start over instead of refreshing the review. |

### Fix (unit + browser)

- `packages/workflow-contracts/src/network-fee.ts`: the reviewed L1 bound gets ×2 headroom; a call is accepted when its **total** network fee
  (`gasLimit × gasPrice + l1Fee`) is within the authorized maximum; reconciliation checks the charged total the same way. Nothing above the
  authorized maximum is ever sent.
- `router.ts` `classifyRouteRevalidation`: `UNCHANGED` / `MARKET_DRIFT_TOLERATED` (provider fee within min(max(1, 10 % of the fee), the owner's
  slippage share of the input), same route, recipients, assets and minimum) / `OUTSIDE_AUTHORIZED_BOUNDS` / `MATERIAL_CHANGE`. Tolerated
  drift executes the **reviewed** transaction (no substitution) and is noted `ROUTER_PROVIDER_FEE_DRIFT_TOLERATED`; only non-null recipients
  are compared.
- Beyond the bounds: the stores re-quote **in place**, re-simulate, show only the changed material values (`bridge-requote-changes.tsx`) and
  ask for a fresh confirmation (`*_REQUOTED_REVIEW_REQUIRED`) — never a silent substitution, never a rebuild of the workflow.

## 2. Swap → Bridge continuity and WETH vs native ETH (Relay)

- Dependent steps keep spending the reconciled amount; a refresh/reconnect resumes from the run log (no re-execution).
- Relay orders that are **paid in native ETH** for a WETH source now get a verifiable path: the owner's own `WETH.withdraw(amount)` on the
  pinned WETH (WETH9 `Withdrawal` or aeWETH burn dialect, effects asserted), then FloFi's exact `depositNative(owner, orderId)`. The review
  states the unwrap; the asset identity (WETH) is never silently changed; the source step `SOURCE_UNWRAP` is validated in the contract.

## 3. EVM ↔ Solana bridge and destination wallet

- "Escolha redes compatíveis" after a swap on Arbitrum → Solana: the card validity, the Router→Universal diversion and the command guards now
  accept the universal pair; universal drafts are kept.
- New **Destination wallet** field: resolved automatically (active session wallet of the destination ecosystem → FloFi/Privy-linked →
  Credentials → Wallets; several candidates: choose; none: manual), editable, validated per network (`DESTINATION_WRONG_ECOSYSTEM`,
  `DESTINATION_INVALID`). A `0x` address is never used on Solana nor a base58 one on an EVM chain. No private key is ever asked.

## 4. Compact chat review and Editor header

- Review card: per step only *Sends / Receives ≈ / Minimum / Network fee / Destination*, material warnings kept visible; exact figures,
  costs, FloFi fee, expiry, totals, routes and technical warnings under a closed **Technical details** (PT: *Detalhes técnicos*). Minimums
  are never rounded up nor maximum fees down.
- "Meu fluxo" is never truncated; a **New workflow** button beside the rename pencil reuses `startNewWorkflow()` (wallet, credentials,
  preferences, saved workflows and on-chain history kept; sent operations stay reachable).

## 5. Gas abstraction ([ADR-0009](../adr/ADR-0009-network-fee-sponsorship.md), [runbook](../deploy/GAS-SPONSORSHIP.md))

- **EVM**: ERC-7677 paymaster proxy used through EIP-5792 `paymasterService` for owner wallet batches, single-use grants bound to the exact
  reviewed calls, pinned EntryPoint v0.7 and paymaster, per-operation cap and daily budget in PostgreSQL, reconciliation from the EntryPoint's
  `UserOperationEvent` recording **who paid**. Automatic: offered when configured and the wallet supports it, owner-paid otherwise.
- **Solana**: sponsored fee-payer co-signer with a strict message policy (module + tests; **not wired into a flow** in this build).
- **Production stays owner-paid until the operator configures a provider** — see the runbook for the provider account, paymaster address,
  deposits/credit, environment variables and verification. No credential, contract or balance was invented.

## 6. Validation matrix

See the PR description for the exact gate results (typecheck, lint, build, schema drift, unit, PostgreSQL, browser profiles, governance,
engineering review); browser evidence is listed there only for profiles that actually ran. Combinations covered by deterministic tests:

| Path | Evidence |
| --- | --- |
| Base → Arbitrum USDC (Across) with L1 ×2.24 and LP fee +1 %: executes reviewed tx | unit (router harness) |
| Same, LP fee beyond slippage / recipient or route change: in-place re-quote + re-confirmation | unit |
| Arbitrum WETH → Solana (Relay, paid in native): unwrap → depositNative, reconciled | unit (universal harness, recorded fixture) |
| Arbitrum swap → Solana bridge on the Canvas: applies; destination auto-filled (Solana wallet), editable, validated | unit (domain/state) |
| Compact review EN/PT, Technical details closed | unit |
| Sponsored wallet batch: offered / required / fallback / reconciled as paid by paymaster / refusals | unit (sponsorship + sponsored-batch + browser wallet double) |

## 7. Not proven (honest limits)

- No real-funds execution: every result above is loopback/MOCKED or production **read-only**. The fixes for the 13/11 refusal are proven
  against the recorded figures, not by a new mainnet transfer.
- Sponsored gas depends on each wallet's EIP-5792 `paymasterService` support and the operator's provider policy; untested live.
- Solana fee sponsorship is not connected to a flow.
