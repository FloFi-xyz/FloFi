# BUILD-CROSSCHAIN-UNIVERSAL-001 — Report: Universal Cross-chain Router

Date: 2026-10-25. Branch `claude/build-crosschain-universal-001`. PR #121. Plan:
[BUILD-CROSSCHAIN-UNIVERSAL-001-PLAN.md](BUILD-CROSSCHAIN-UNIVERSAL-001-PLAN.md). One build, one PR. No merge, deploy or
real-money transaction by the agent.

## Evidence classes (do not conflate)

| Class | Meaning |
| --- | --- |
| **Code implemented** | Product code, unit/service/PG/browser MOCKED tests on this branch |
| **CI certified** | CircleCI jobs green on the delivery commit (including `ci/circleci: governance`) |
| **Live provider verified** | Read-only public quotes / RPC pin checks (not execution) |
| **Real-money Mainnet tested by the owner** | Owner-signed public execution — **not claimed here** |
| **Not yet supported** | Explicit gaps below |

**Status: IMPLEMENTATION COMPLETE — READY FOR OWNER REVIEW.** MOCKED evidence only unless a row below says otherwise. **No transaction was signed or sent by the agent on a public network.**

## What was built

Additive universal Cross-chain Router (`flofi.router.universal`) across Solana, Base, Arbitrum One, Ethereum and Robinhood
Chain. The certified per-pair Router (`flofi.router`) is unchanged.

| Layer | Change |
| --- | --- |
| Contracts | Five mainnets, assets, `flofi.universal-route.v1`, closed node construction |
| Relay codec | Order hash, deposit encodings, Lighthouse-compatible signed-byte verification |
| Discovery | Relay / LI.FI / Mayan / Across; candidates classified `EXECUTABLE` · `LIVE_QUOTE` · … |
| Service | Simulate → Review → Accept → begin → owner wallet → observe → reconcile → evidence |
| Fees | Approved **0.1% per completed workflow** disclosed; durable obligation on RECONCILED; waived FAILED/REFUNDED/DIVERGENT; **collection not settled on-chain** |
| Composition | Confirm-each-step resolves `min(cap, reconciled received)`; Swap → Bridge → Swap E2E PG test |
| Surfaces | Chat, Copilot, Canvas, MCP / Telegram / WhatsApp parity, engineering panel |
| Browser | Guarded profile `universal-bridge` on loopback harness `127.0.0.1:8566` |

## Authorization and wallet security

- FloFi never signs. Source wallet signs every reviewed request; Solana: FloFi verifies signed bytes (exact message or verified Phantom Lighthouse guards) then broadcasts once.
- Canvas **Authorize in wallet** stays disabled for `MOCKED` provenance. Engineering Accept → Execute drives the diagnostic lifecycle.
- Per-attempt identity only (orderId / message / signature); no owner-wide lease. Duplicate clicks are observation-only.

## Fees (approved 0.1% per completed workflow)

### Implemented (code)

- Review / panel / simulation / Copilot disclose **0.1% of completed workflow input** (not “None”).
- On `RECONCILED`, the run records a durable `feeObligation` (`status: OBLIGATED`, `collection: NOT_SETTLED`, `feeAmount = floor(input × 10 / 10_000)`).
- On `FAILED` / `REFUNDED` / `DIVERGENT`, obligation is `WAIVED` (`feeAmount: 0`).
- One obligation per terminal workflow; provider/network fees remain separate; Relay still called **without** `appFees`; Jupiter still refuses a platform fee.
- Admin fee section states obligation-recorded / collection-not-settled.

### Owner decision required (collection / settlement)

Precise commercial rate and timing are established. **How funds move to FloFi is not.** Options for owner approval (do not implement until chosen):

1. **Relay `appFees`** on executable Relay routes (on-chain, in the deposit) — needs treasury recipient, chain coverage, and accepting Relay as fee rail.
2. **Separate owner transfer** after RECONCILED (invoice-style) — off the bridge path; needs billing UX and reconciliation.
3. **Deferred ledger + off-chain invoice** — obligation already recorded; settle later via ops.

Until one is approved, FloFi **must not** silently collect or invent an alternate charge.

## Workflow composition (Swap → Bridge → Swap)

- `UNIVERSAL_ISOLATED_ONLY` remains correct for the universal **single-node** IR. Multi-step composition uses the workflow-run engine (each step composed alone).
- Confirm-each-step now resolves bindings from the producer step’s reconciled `received` (same `min(cap, received)` rule as delegated).
- PG E2E: confirm-mode bound swap; **Swap (Jupiter) → Bridge (universal) → Swap (Base)** with two bindings, MOCKED harness — proves received-amount chaining across real flows.
- Native-asset bindings remain unsupported where the IR has no contract/mint address (existing binding identity rule).

## Provider and network coverage

| Provider | Role |
| --- | --- |
| **Relay** | Only new **executable** provider (verified Depository deposits) |
| LI.FI | Discovery / live quote — not independently executable |
| Mayan | Discovery / live quote — no verified transaction builder |
| Across | Certified Router pairs remain on their own flows; other Across routes quote-only |

Read-only live matrix (20 directions × stable + native = **40 rows**), run 2026-10-25 against live public APIs/RPCs:

Artifact: [BUILD-CROSSCHAIN-UNIVERSAL-001-ROUTE-MATRIX.json](BUILD-CROSSCHAIN-UNIVERSAL-001-ROUTE-MATRIX.json).
Totals that run: `executable: 40`, `errors: 0`. Relay contract pins matched on Solana + all four EVM depositories.

| Executable how | Where |
| --- | --- |
| **Relay** (`executableBy` universal Depository) | All 40 rows in that snapshot |
| **Across** (`executableBy: CERTIFIED_ROUTER`) | USDC/USDG certified Router pairs only — **not** universal Relay calldata |
| **Mayan** | `LIVE_QUOTE` — `MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED` (never advertise as executable) |
| **LI.FI** | Mostly `TEMPORARILY_UNAVAILABLE` / rate-limited in that run; when quoted, discovery-only unless independently verifiable |

**Live provider verified only** — never Mainnet execution evidence.

## Browser profile evidence (MOCKED)

Command: `node scripts/guarded-release-browser.mjs profile universal-bridge` with
`GRYLOO_UNIVERSAL_E2E=MOCKED_LOOPBACK_ONLY`.

| Journey | Result |
| --- | --- |
| Solana USDC → Base: routes, Review, one Solana signature, one FloFi broadcast, Base delivery, MOCKED evidence | PASS |
| Phantom + verified Lighthouse guards still signs once; FloFi broadcasts once | PASS |
| Canvas Bridge card offers Solana and applies a universal bridge | PASS |
| Chat Base → Solana receive SOL via Relay | PASS |

Artifact: `apps/reference-dapp/test-results/guarded-profile-universal-bridge.json`.

## Scope honesty

| Status | Item |
| --- | --- |
| Code implemented | Universal router, fee obligation, confirm-mode bindings, SBS E2E, disclosure |
| CI certified | Required on delivery commit (governance 47 browser profiles, `pnpm check`, etc.) |
| Live provider verified | Matrix script + optional live run artifact |
| Real-money Mainnet by owner | **Not done** — checklist below |
| Not yet supported | On-chain fee collection; unverified LI.FI/Mayan/Across calldata execution; native binding identity |

## Owner-operated Mainnet acceptance checklist

Do **not** treat MOCKED or live quotes as this checklist.

1. Set `GRYLOO_UNIVERSAL_ROUTER=live` and `GRYLOO_UNIVERSAL_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` on a non-production review deployment.
2. Connect source (+ destination if cross-ecosystem) wallets; Simulate → Review a small Relay-executable route.
3. Confirm Review shows **0.1% FloFi fee obligation** and provider fees separately; Authorize in wallet; observe to RECONCILED.
4. Confirm evidence / run record has `feeObligation.status = OBLIGATED` and `collection = NOT_SETTLED` (no unexpected on-chain FloFi fee transfer).
5. Optionally repeat a path that refunds or fails; confirm obligation `WAIVED`.
6. Optional: approve a fee **collection** option from the list above in a follow-up change — not part of this PR’s silent behaviour.
7. Optional: run Swap → Bridge → Swap on mainnets with owner signatures; confirm step 2/3 amounts track reconciled received.

## Validation run for this report

- CircleCI `governance` root cause: browser profile count 46→47 after adding `universal-bridge` (scripts/test_ci_*.py)
- `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` — pass locally after fix
- Focused Vitest (fee, universal service, confirm-run SBS/bindings, authorization plan) — pass with `FLOFI_NETWORK_SCOPE=ENGINEERING_TESTNETS` where PG tests need it
- Guarded browser profile `universal-bridge` — prior 4/4 MOCKED pass (re-confirm on delivery commit)
- `pnpm check` / full CircleCI — required green on the pushed commit before owner merge
