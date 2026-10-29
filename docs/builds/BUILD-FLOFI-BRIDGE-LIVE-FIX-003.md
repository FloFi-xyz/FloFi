# BUILD-FLOFI-BRIDGE-LIVE-FIX-003 — Bridge execution, native ETH, financial Review and chat UX

Branch `claude/build-flofi-bridge-live-fix-003` from `origin/main` 84ed0d0 (PR #135 merged). One draft PR. Nothing was merged, deployed,
promoted or configured in production; no transaction was signed or sent; no production data was changed.

Evidence levels used below (never mixed):
**A** deterministic local tests · **B** fork-based tests (local Anvil fork; nothing reaches a public network) ·
**C** real mainnet read-only verification · **D** real owner-wallet execution — **not performed by this build**.

## 1. Original Bridge failure — root cause

Production (flofi.xyz on 84ed0d0, flofi-api on 9e71c100), owner journey "Bridge 0.5 USDC from Arbitrum One to Base" (Router flow
`crosschain-router-arbitrum-to-base`, Across). Read-only Railway runtime logs of run `xroute-26e5abba77fe08b01f14531d65fa9d2a`
(`BUILD-FLOFI-BRIDGE-LIVE-FIX-003-EVIDENCE/bridge-root-cause.json`):

| UTC | action | result |
| --- | --- | --- |
| 17:30:43 | simulate | ok (9.2 s) |
| 17:31:03 | review | ok — the confirmed Review was accepted |
| 17:31:11 | begin | typed refusal after 7 s (re-quote) |
| 17:31:11 | status | the client re-read the run |
| 17:36:33 | simulate | a new run; no review/begin followed |

No `handoff`, `walletFailure` or `report`: no wallet request was opened and nothing was sent. In `router.execute()` the only path from
`begin` straight to `status` is a `ROUTE_CHANGED | STATE_CHANGED | REVIEW_EXPIRED` refusal.

**Cause 1 — revalidation by noise.** `begin` re-quotes the same provider and compared with `compareRoutes(…, 'REQUOTE')`, which refused
*any* fee increase and *any* lower minimum. Across output equals its minimum and re-prices constantly: six read-only quotes of the same
0.5 USDC route 8 s apart moved 495928 → 495931 / fee 4101 → 4102 (base units). A confirmed Review therefore failed revalidation about half
the time. The executed bytes are the *reviewed* bytes (spend and guaranteed receipt fixed in calldata); the fresh quote is only evidence the
provider still offers the route.

**Cause 2 — the failure was unreadable.** `simulationError()` had no class for `ROUTE_CHANGED` / `…STATE_CHANGED_REVIEW_REQUIRED` /
`REQUOTE`, so the chat appended the generic "FloFi could not complete this simulation…" to "The wallet request could not start".

**Cause 3 — recovery was poisoned.** `begin` deauthorized the run (`requote: true`, `error: ROUTE_CHANGED`). Its Review was blocked by its own
simulation, but the Canvas still projected a *disabled* "Authorize in wallet", and the chat's "Review workflow" re-presented that dead Review
on every request instead of simulating again (matching the logs: no new review/begin).

**Also found:** `authorize()` could end silently (Review accepted, execution not ready → no reason), and the chat said "Opening the reviewed
wallet request" before anything was known to proceed.

## 2. Corrective implementation

- `workflow-contracts/router.ts`: `providerFeeDrift` + `materialRouteChanges`. Drift of fee/minimum within **1% of the reviewed route fee**
  (≥ 1 base unit) is set aside **only when it is the sole change**; every other change (provider, protocol, steps, recipient, approval,
  target, function, value, contracts, message, larger drift) still invalidates. The tolerated drift is recorded on the attempt
  (`ROUTER_PROVIDER_FEE_DRIFT_TOLERATED:<fee>:<minimum>:<tolerance>`). **Owner review:** this is an intentional, narrow relaxation of a
  revalidation probe; the owner's spend and guaranteed receipt are unchanged (reviewed calldata), the residual risk is a slower fill/refund.
- Precise refusal messages (`simulationError`), a simulation-blocked Review offers "Simulate again" (never a dead approval), a requoted run is
  refreshed in place (`refreshBridgeAfterApproval`), `authorize()` returns `{ started, issue }` and keeps `startIssue`.
- Chat: says "Preparing your reviewed wallet request…" only once a request actually began; a refused start says why; a quote/state change at
  the boundary is re-quoted at once and the fresh Review lists each change ("Expected receipt 0.495897 USDC → …") and asks
  "Do you confirm the updated workflow?" then "Would you like to execute this workflow now?". "Review workflow", "Simulate again",
  "Refresh quote", "Try another route" (EN/PT-BR) work from chat. Earlier runs stay on record; an unknown submission is observed, never resent.

## 3. Fee accounting proof

Every fee line now has an explicit treatment: `ADDITIONAL` (estimate paid on top), `CEILING` (maximum, never also an estimate),
`INCLUDED` (already deducted from the quoted output), `COMPONENT` (part of an included total), `OBLIGATION` (FloFi fee as recorded).
`payableCosts()` sums **only ADDITIONAL** lines, exactly, per asset; ceilings are shown apart as "up to"; nothing is converted.

Regression with the production quote (A): fees → `Maximum network fee 0.00000808176 ETH (CEILING)`, `Destination delivery fee 0.004053 USDC
(COMPONENT)`, `Bridge relayer fee 0.00005 USDC (COMPONENT)`, `Route fee total 0.004103 USDC (INCLUDED)` → additional `[]`, ceilings
`[0.00000808176 ETH]`; the old `0.008206 USDC` cannot be produced. Chat Review: Sending / Expected receipt / Minimum receipt / Provider /
Max slippage / route fee "Already included in the quoted output" / "Maximum, separate from the output" / FloFi fee / Quote expiry /
**Total additional payable costs**; components sit in an expandable "Fee breakdown".

## 4. FloFi fee treatment (verified, unchanged policy)

0.1% per completed workflow, **not collected on-chain anywhere**. Universal Router runs record it as an obligation at reconciliation
(waived on failure/refund) — shown with its amount as the obligation it is. Router and swap runs record none — shown as
"Not charged" with that exact reason. No fee was added, changed or collected.

## 5. Native ETH — architecture and implemented routes

- Canonical identity: a catalog swap side may be native ETH = IR `{ chainId, nativeId: 'ETH', decimals: 18 }` (no address). WETH stays the
  ERC-20. ETH ⇄ that network's WETH9 is a WETH9 conversion (`protocols: ['weth9']`, exactly 1:1, no slippage constraint, minimum = amount),
  adapter `weth9.wrap`. Existing ERC-20 nodes are byte-identical (hash-compatible).
- Calldata (`reference-compiler`): native in = `multicall(deadline, [exactInputSingle(WETH9 → token, recipient = owner)])` with
  `value = amountIn`; native out = `multicall(deadline, [exactInputSingle(token → WETH9, recipient = router), unwrapWETH9(minimum, owner)])`;
  wrap `deposit()` with value; unwrap `withdraw(amount)`. Decoders accept only the canonical encoding.
- Service: no approval for native in; balance ≥ amount + network fee; exact `value` bound in Review and checked again in the browser
  (`swapWalletRequestMatches`) and on the receipt; reconciliation from the receipt in the network's WETH log dialect; native output is the
  router's unwrap (never an ERC-20 Transfer); gas is never read as missing output.
- Implemented: Base, Arbitrum One, Ethereum, **Robinhood Chain** (native currency ETH; its SwapRouter02 supports the same path —
  verified read-only). Directions: ETH → token, token → ETH, ETH → WETH, WETH → ETH. Solana SOL unchanged.
- Authoring: chat ("swap 0.001 ETH to USDC on Base", "wrap 0.01 ETH to WETH on Base", "unwrap … on …"; missing network/amount is asked),
  Copilot, Canvas picker, MCP `compose_strategy` (native `nativeId`, wrap `weth9`). Test networks still refuse native ETH (no path there).
- Sequences: funding by exact identity — a native-ETH delivery funds only a native-ETH input (Swap ETH→USDC → Bridge USDC;
  Bridge USDC → Swap USDC→ETH; Wrap → Swap WETH).

## 6. Verified router and WETH contracts (C)

`scripts/verify-native-eth.mjs` → `BUILD-FLOFI-BRIDGE-LIVE-FIX-003-EVIDENCE/native-eth-read-only-verification.json` (2026-10-29, eth_call with
state overrides on a synthetic codeless account; nothing signed or sent):

| network | SwapRouter02 | WETH9 | router `WETH9()`/`factory()` | multicall(deadline) / exactInputSingle / unwrapWETH9 | native in | native out | wrap | unwrap | WETH logs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Base | 0x2626…e481 | 0x4200…0006 | ✓ / ✓ | ✓ / ✓ / ✓ | ✓ 0.001 ETH → 2.327086 USDC | ✓ 5 USDC → 0.002148 ETH | ✓ | ✓ | Deposit/Withdrawal |
| Arbitrum One | 0x68b3…fc45 | 0x82af…bab1 | ✓ / ✓ | ✓ / ✓ / ✓ | ✓ → 2.327080 USDC | ✓ → 0.002148 ETH | ✓ | ✓ | Transfer mint/burn |
| Ethereum | 0x68b3…fc45 | 0xc02a…6cc2 | ✓ / ✓ | ✓ / ✓ / ✓ | ✓ → 2.327265 USDC | ✓ → 0.002148 ETH | ✓ | ✓ | Deposit/Withdrawal |
| Robinhood Chain | 0xcaf6…5cb2 | 0x0bd7…ad73 | ✓ / ✓ | ✓ / ✓ / ✓ | ✓ → 2.326626 USDG | ✓ → 0.002149 ETH | ✓ | ✓ | Transfer mint/burn |

## 7. Wallet authorization and reconciliation proofs

- The chat is never a signature: "Do you confirm this workflow?" → "Would you like to execute this workflow now?" → the existing
  `authorize()` (Review acceptance) → the runtime's own wallet request, which the owner signs in the wallet. A start that does not begin says
  why (`startIssue`); a quote/state change at the boundary needs a fresh Review and both confirmations again.
- Wallet requests are derived from the reviewed calls: approval only if the reviewed state needs one (re-checked at execution); a bridge's
  destination settlement is marked provider-side (`LifecycleOperation.wallet = false`) and described as such, never as a signature.
- Native ETH: the reviewed transaction binds `to`, calldata and the exact `value`; the browser re-checks them (`swapWalletRequestMatches`)
  before the wallet; `verifyOwnerSubmission` requires the receipt's transaction to carry exactly that value (direct only); reconciliation is
  from the receipt (WETH9 Deposit/Withdrawal or aeWETH mint/burn, router unwrap for native output), balances only bound it, gas apart.
- Unknown submissions are observed, never resent (`…SUBMISSION_UNKNOWN…` → "Your wallet may already have sent this request…").

## 8. Chat-first lifecycle evidence (A)

`flofi-conversation.test.ts`: the production regression (begin refusal → precise reason → automatic fresh quote → Review lists every
change → two fresh confirmations → second authorization only then); a refused start never says "Preparing…"; an accepted Review that cannot
start names the projected reason; "Refresh quote" re-simulates an approvable Review; "try another route" never switches providers.
`canvas-lifecycle.test.ts`: a requoted run offers "Simulate again", never a disabled approval. `execution-controls.test.ts`:
`authorize()` → `{ started, issue }`. Browser: `conversational-workflow.spec.ts`, `chat-sequence.spec.ts` (loopback execution harness) with the
compact Review and the honest start wording.

## 9–10. FloFi Assistant — header, avatars, EN/PT-BR

Header = official symbol (`/brand/flofi-symbol-{light,dark}.svg`, theme-switched like `FloFiLogo`) + "FloFi Assistant"; welcome
"Hi FloFier! …" / "Olá, FloFier! …" (exact approved copy; replay and command-only servers add one honest sentence); FloFi symbol beside every
assistant message, a person icon beside every owner message; role names kept for screen readers. `e2e/chat-assistant.spec.ts` checks header,
welcome, avatars, no horizontal overflow and header containment at 1920/1440/1280/1024/390/375 px (EN) and 1440/390 px (PT-BR), and saves
a panel screenshot per width (copies in `BUILD-FLOFI-BRIDGE-LIVE-FIX-003-EVIDENCE/flofi-assistant-<width>-<lang>.png`: 1920/1440/1280/1024/390/375 EN, 1440/390 PT-BR).

## 11. Tests executed and results

Browser (A, loopback/MOCKED only): all **48** guarded product profiles (`node scripts/guarded-release-browser.mjs profile <name>`, CI's
settings, local PostgreSQL 18.6 pinned image). First full run: 46 passed; `copilot` and `default-product` failed only on intended changes —
the FIX-002 native-ETH refusal expectation (now a native-ETH swap) and seven screenshot goldens that include the chat panel. After updating that
spec and regenerating the goldens (changed pixels confined to the assistant panel column x ≥ 1081 at 1440 px, plus ≤ 35 antialiasing pixels
elsewhere): `copilot` passed, `default-product` 114 passed. `execution-continuity` (incl. the new `chat-assistant.spec.ts`, 15 tests;
`conversational-workflow`, `chat-sequence`) passed. The visual review also caught a defect fixed here: each avatar rendered both the light and
the dark symbol (a specificity clash with the theme rule); the spec now asserts the dark artwork is hidden in the light theme.

| gate | result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm build` | pass |
| `pnpm schemas:check` | 11 schema exports verified |
| `pnpm test` (unit, packages + app) | 5,513 passed, 2 skipped (pre-existing) |
| PostgreSQL (router/universal cloud, cloud execution, journey, owner history, MCP gateway, flow runtime, approval surface) | 29/29 |
| `governance_lite.py` + its unittest suite | pass, 19 tests |
| `test_ci_*.py` | 64 tests OK |
| fork (B, opt-in) `native-eth.fork.test.ts` | 3/3 (E, F, G/H) |

Required-case map: 1 bridge regression (router-service drift test, presentation fee test); 2–5 fee classification / no double count /
ceiling vs estimate / FloFi status (`simulation-presentation.test.ts`, `payableCosts`); 6–13 Review → wallet request, expiry, network/account
mismatch, rejection, pre-submission failure, fresh simulation, unknown never resent (`flofi-conversation`, `execution-controls`,
`router-service`, `canvas-lifecycle` suites, existing recovery suites); 14–22 ETH ≠ WETH, native authoring/simulation, `msg.value`, no
approval for native, ERC-20 approval, wrap/unwrap, gas vs output, Base/Arbitrum/Ethereum (+ Robinhood) (`catalog-swap`, `native-eth`
compiler, `base-swap`, `arbitrum-runtime`, `ethereum-runtime`, `robinhood-swap`, `workflow-sequence`, `public-testnet-swap`, MCP
`mainnet-only` suites, fork test); 23–24 sequences (`workflow-sequence.test.ts`); 25–26 summaries / wallet request descriptions
(`conversation-lifecycle`, `execution-lifecycle`); 27–30 UI (`copilot-panel.test.tsx`, `chat-assistant.spec.ts`).

## 12. CircleCI status

_CIRCLECI_STATUS_

## 13. Real-provider read-only evidence (C)

- Bridge: production Railway logs of the failing run; six live Across quotes 8 s apart (drift 1–3 base units, output = minimum) —
  `bridge-root-cause.json`. The Across `suggested-fees` endpoint without FloFi's integrator key answers `AMOUNT_TOO_LOW` for 0.5 USDC; the
  `swap/approval` endpoint FloFi uses quotes it.
- Production capability: `crosschain-router-arbitrum-to-base` is live with its execution switch on (`get_capabilities`), so the failure was
  not a disabled route.
- Native ETH: `native-eth-read-only-verification.json` (four networks, router/WETH identities, selectors, native in/out, wrap, unwrap);
  WETH log dialects from real logs (`bridge-root-cause.json` → `wethEventDialects`).
- **D (real owner-wallet execution) was not performed.** Nothing was signed or sent on any public network.

## 14. Remaining limitations

- **Owner decision — fee-drift tolerance.** Router `begin` now tolerates relayer re-pricing within 1% of the reviewed route fee (sole
  change). The owner's spend and minimum receipt are unchanged (reviewed bytes); a slower fill or refund is the residual risk. Without it a
  live Across Review fails revalidation about half the time. It can be removed by reverting the `materialRouteChanges` call.
- Browser-level Router/catalog **confirmation** cannot run on loopback: MOCKED harness provenance is (deliberately) never shown as a live
  simulation, so Case A/B confirmation-to-wallet in a browser is covered by unit/integration tests, the fork test and production logs, not by
  a browser journey. No native-ETH browser execution journey exists for the same reason (chat authoring is browser-tested).
- Native ETH is **not demonstrated on mainnet** (no owner-wallet execution); capability rows keep no evidence ceiling.
- The Base swap path (non owner-bound Review) has no network-fee ceiling in its Review, so its chat Review names "Network cost" as not
  provided until the wallet request is prepared (Arbitrum/Ethereum show the owner-bound ceiling).
- Uniswap liquidity on catalog networks still maps a written "ETH" to WETH with a disclosure note (positions hold WETH); swaps never do.
- Sequence position across reloads and the Swap → Bridge browser harness remain as reported in BUILD-FLOFI-CHAT-E2E-FIX-002.

## 15. Production deployment requirements

No migration, schema, environment variable, fee or configuration change. To take effect in production the owner would need to:
- redeploy **flofi-api** (Railway) — the Router `begin` revalidation (`router-service.ts`), the native-ETH swap service and the cloud flows
  run there (the web forwards to it in production);
- deploy the web (Vercel) build of this branch for the chat, Review, Canvas and MCP changes.
Owner-execution gates for native ETH reuse the existing per-network swap gates (`GRYLOO_*_OWNER_EXECUTION`); nothing new is enabled.
