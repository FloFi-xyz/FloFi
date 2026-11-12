# P0 — Real workflow execution and the approved FloFi App UX (plan)

Owner request (2026-11-12): make the reported Arbitrum One workflow (Swap 0.001 WETH → USDC on Uniswap V3, then Bridge 2 USDC Arbitrum One
→ Base) truthfully executable where live liquidity, provider minimums, wallet capabilities and Flight access allow it (Track A), and implement
the approved "FloFi App · UX" design (Track B). Base: `origin/main` `009975aa3c0d94ccf33f2d2e3599615f4b6aeb98` (PR #175, the release Vercel
production and Railway `flofi-api`/`flofi-worker` serve, verified read-only on 2026-11-12). Branch: `claude/peaceful-galileo-7r9j2j` (the branch
this session is bound to). No transaction is signed or sent by this build; local doubles and fixtures are test evidence only.

## Track A — diagnosis (read-only production evidence)

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Did Flight binding cause the refusal? | **Yes, most likely.** The Railway API refused a `POST /v1/flows/*` call with `BETA_WALLET_NOT_LINKED` at 04:18:22.526Z — the same second the owner's Bridge (04:18:22.44) and Swap (04:18:25.70) Canvas estimates were served — and earlier at 04:09:09.671Z during the first attempt. No swap `simulate` reached a flow handler afterwards. The two events are time-correlated, not proven to be one session (the refusal log carries no account or flow name). | Railway `flofi-api` deploy logs (trace `bead6039…`, `6534776c…`); Vercel `/api/build-estimate` logs |
| 2 | Did the frontend pass the right owner? | The API checks the *owner argument* of each flow call against the account's Flight-bound wallets; the web BFF checks only the session's login wallet and wallet cookies (`withFlightAccess()` without a principal), so a connected wallet that is not linked/boarded for the account reaches the API and is refused late. | `backend/app.ts` `betaFlowOwnerRefusal`, `src/server/flight-access.ts`, `src/app/editor-workflow-execution-action.ts` |
| 3 | Can MetaMask / Privy / stale state mismatch identities? | Yes: a wallet *connected* in the browser but not *saved* to the FloFi account (board 13 shows exactly "Connected · not saved"), a wallet linked after boarding (Flight binds wallets at Board; "Board now" again binds newly proven wallets), or an address linked to two FloFi accounts (fail-closed rule) are all refused with this code. The policy is correct; the defect is that the refusal is invisible. | `src/flight/beta-access.ts`, `docs/deploy/FLIGHT-GATE-002-ROLLOUT.md` |
| 4–5 | Swap runtime ↔ Editor runtime; quote → simulation | The Uniswap quote (`arbitrum-swap` preview, `QUOTE_AVAILABLE`) is the read-only Canvas estimate. The Editor's sequence path ("Confirm each step · Step 1 of 2: Swap") simulates step 1 through the same `arbitrum-swap` flow; that call was refused at the Flight gate before any simulation. `simulationError` had no mapping for `BETA_*`, so the owner saw the generic "Simulation failed". | `src/domain/simulation-presentation.ts` |
| 6 | Why quote-only bridge routes? | The Editor's Bridge card is the **certified Router** node (BUILD-ROUTER-001/BUILD-BASE-001, routing AUTO = LI.FI then Across). Its Canvas estimate is read through universal discovery restricted to `lifi,across`, which labels every LI.FI/Across answer `LIVE_QUOTE` (no universal verifier) and never sets the declared `executableBy: 'CERTIFIED_ROUTER'`. The card therefore always said "Estimate only: FloFi cannot execute this route yet", even though the certified Router flow builds, verifies (code pins, calldata decode), simulates, submits through the owner's wallet and reconciles exactly these Across routes. Relay is not asked because a Router node never executes through the universal router. | API logs `asked_providers: lifi,across`, `first_executable_ms: null`; `src/server/bridge-build-estimate.ts`; `src/server/universal-router/discovery.ts` |
| 7 | Is 2 USDC executable? | Across answered live for 2 USDC Arbitrum → Base (expected ≈ 1.996276 USDC), so no provider minimum blocked it at that time. Whether the certified Router may *execute* depends on the deployment's Router owner-execution gate on API/worker, which this build could not read (variable listing was refused); the Router flow's own `info` reports it at runtime, and the card now follows it. | discovery logs, `src/app/router-action.ts` `routerInfo` |
| 8 | Swap output → Bridge input dependency | Already typed: the sequence binds the Bridge to the Swap's *reconciled* delivery of the exact asset (chain, address, decimals) and spends `min(authored cap, delivered − already allocated)`; a zero/insufficient bound stops the step before authorization. | `src/domain/workflow-sequence.ts` (`boundAmount`, `fundingAllocations`, `boundProjection`) |
| 9 | Deployment flags | API runs Flight in `beta` (BETA_* refusals). A staged, unapplied Railway patch adds `FLOFI_BETA_ACCESS` to API and worker; it was inspected and **not applied**. Web readiness: commit `009975a`, user-funded and Editor runs enabled, `eth_simulateV1` supported on every user-funded chain. | Railway staged changes, `/api/flofi/readiness?probe=networks` |
| 10 | #175 regression blocking continuation? | None identified in this path; the failure happened before step 1 simulated. | — |

## Track A — corrections

1. **Flight refusals are named, never "Simulation failed"**: every `BETA_*` code maps to what happened, that nothing was simulated or sent, and the
   next action (save/link the wallet in Credentials, Board again to bind it, sign in again, wait for boarding, contact support). Shared by the
   Editor simulation, the whole-workflow Review, execution panels and the assistant.
2. **Identity consistency**: owner-specific Server Actions (whole-workflow Review, Router simulation) re-check Flight access for the *same* owner
   wallet the API will check, so the refusal is early and identical on both tiers. No grant, binding or session is created from an address.
3. **Truthful bridge executability**: a certified-Router Bridge card is labelled executable (simulation and Review still required) only when its
   discovery answer is an Across route the certified Router executes (Across direct, or LI.FI whose only tool is Across) *and* the pair's Router
   flow reports owner execution on this deployment; otherwise the quote-only note stays. No unverified contract path is added.
4. **Blocker explanations**: `USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE` exposes the server's own numbers (balance, maximum fee + native spend,
   shortfall) as a read-only projection; "explain / why? / não entendi / me explique melhor" while a blocker is active answers that blocker with
   the same facts, including Flight and bridge-route blockers.

## Track B — approved UX (boards 03–15, handoff board 16)

| Workstream | Boards | Owner (files) |
|---|---|---|
| Tokens, top bar, stepper, drawer, Settings, Chat entry, footer status, Simulate + Review, Blocked, Confirm in wallet, chat network list, assistant blockers, PT-BR overrides | 03, 03b, 05, 06, 07, 08, 16 §4–8 | main session (`globals.css`, `approved-ux.css`, `top-bar.tsx`, `navigation-drawer.tsx`, `header-settings.tsx`, `editor-stepper.tsx`, `build-entry.tsx`, `app-shell.tsx`, `summary-bar.tsx`, simulate/review/execute components, copilot logic, `pt-approved-ux.ts`) |
| Editor Create screen (canvas header, rail, contextual toolbar, cards, zoom, assistant surface) | 04 (+ draft card of 05) | helper "editor" (`workflow-canvas.tsx`, `workflow-name.tsx`, `canvas-navigator.tsx`, `composer-card.tsx`, `canvas-card-inputs.tsx`, `copilot-panel.tsx`, `editor-overview-panel.tsx`, `approved-ux-editor.css`, `pt-approved-ux-editor.ts`) |
| Six secondary pages | 09–15 | helper "pages" (`dashboard/*`, `saved-workflows.tsx`, `automations-workspace.tsx`, `secondary-product-workspace.tsx`, `delegation-credentials.tsx`, `approved-ux-pages.css`, `pt-approved-ux-pages.ts`) |

Guardrails kept: one primary lifecycle action (`projectCanvasAction`), no ✓ in the stepper, Review binding, authorization, execution groups,
server refusals, recovery and the `/approve` Disconnect exception are unchanged; `DEFAULT_LANGUAGE` is unchanged; colors map to CSS variables.

## Verification and release

Focused suites per change, `pnpm check`, PostgreSQL suites, relevant browser profiles, governance-lite, `agent_guard.py check/impact/review`,
read-only specialist reviews (≤ 3 at once), then the PR, CircleCI certification, Vercel Preview, merge and the production deploy verification
the owner authorized. Real-mainnet execution stays **unverified** until owner-signed receipts and FloFi reconciliation exist.
