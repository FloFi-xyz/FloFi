# BUILD-FLOFI-BETA-REGRESSION-FIX-001 — Beta Mainnet regression and execution continuity

**Date:** 2026-11-18
**Branch:** `cursor/build-beta-regression-fix-001`
**Base:** `origin/main` at `32b79986` (PR #213 Live Canvas / execution lifecycle)
**Scope:** restore nine previously certified Beta Mainnet behaviours (FIX-01…FIX-09). No new financial capability, fee model, wallet ownership, access control, environment variable, dependency upgrade or production mutation. No real transaction was signed, submitted or broadcast from this session.

Evidence levels: **CODE** = reproduced against current main before the fix and covered by deterministic tests after it; **MOCKED** = controlled fixtures / bounded timeouts in unit and store tests; **BROWSER** = guarded loopback profiles when run; **PRODUCTION** = owner-reported journeys (screenshots / narrative only — not financial certification).

## A. Confirmed root causes (vs hypotheses)

| ID | Confirmed root cause | Historical path affected |
| --- | --- | --- |
| FIX-01 | Amount shortcuts only attached when `amountFill` was true on the deterministic path; the AI / clarify path and late catalog token resolution dropped shortcut metadata even when the assistant asked for an amount. | PR #208 (`571f841` UX-02) |
| FIX-02 | Learning / network clarification copy still explained Mainnet and “real funds” on routine turns after the product became Mainnet-only. | PR #118 |
| FIX-03 | Explicit network aliases were not always kept across short follow-ups (`1`, `50%`, `Max`); learned preference / clarify timing could re-ask Arbitrum after the user already named it. | PR #135, #150, #188 |
| FIX-04 | “Ethereum” in coin position was not treated as native ETH (`ETHEREUM_AS_COIN`); catalog / alias timing also collided with ARB-like tokens and produced “token not found” for a valid asset. | PR #135, #136, #150, #188 |
| FIX-05 | Canvas / catalog search did not rank native ETH aliases (`Ethereum`, `Ether`, `ETH`) and WETH / Wrapped Ether consistently with chat grounding. | PR #125, #136 |
| FIX-06 | Bridge cards fell back to raw contract addresses when source/destination asset display metadata was incomplete after swap→bridge binding; picker overflow came from nested scroll + insufficient panel `revealOffsetX`. | PR #125, #190, #213 |
| FIX-07 | After a reconciled swap, chat stayed on auto-SIWE / simulate instead of advancing with `manualSimulation` / `stepReadyNext`; dependent amount binding and UI lifecycle did not hand the remaining bridge step cleanly. | PR #186, #190, #213 |
| FIX-08 | Workflow header network chips were deduped by display string, so “Arbitrum” and “Arbitrum One” both appeared for the same chain id. | PR #118, #213 |
| FIX-09 | Universal router simulation lacked a hard client bound; unavailable / refused routes could leave “Simulando o fluxo…” indefinitely; Flight telemetry could race a fail-open with a late success. | PR #186, #213 |

## B. Corrections

### FIX-01 — Conversational amount shortcuts (P1) · CODE

Restore UX-02 chips under the amount question for both deterministic and clarify paths, after catalog token load, applying to the correct asset / wallet / network / operation and respecting gas reserves and dependent reconciled outputs. Manual entry through chat remains unrestricted except by real financial / provider constraints. EN + PT-BR.

### FIX-02 — Redundant Mainnet conversational warnings (P2) · CODE

Routine network clarification no longer repeats “real funds / Mainnet” explanations. Beta banner, Review risk disclosures, wallet signing boundaries, unsupported-test-network refusals and internal Mainnet enforcement are unchanged.

### FIX-03 / FIX-04 — Explicit networks + ETH / WETH grounding (P1) · CODE

Coin-position Ethereum / ETH / Ether → native ETH; WETH / Wrapped Ether → WETH; network vs asset disambiguated by context. Explicit supported network aliases resolve once, survive short answers, and are not overridden by learned preferences. No silent ETH↔WETH substitution; no invented addresses.

### FIX-05 / FIX-06 / FIX-08 — Catalog, bridge card, network chips (P1) · CODE

Shared registry aliases for Canvas search; bridge cards prefer symbol + icon + network badge via `abbreviatedAssetReference` (addresses remain in technical detail); picker positioning / nested scroll fixed; overview chips dedupe by canonical chain identity.

### FIX-07 / FIX-09 — Execution continuity and bounded simulation (P0) · CODE + MOCKED

After a reconciled step, conversation advances to the remaining step (`manualSimulation` / `stepReadyNext`) without re-submitting the completed swap. Universal router simulate is bounded; stale responses cannot overwrite newer workflow state; unavailable routes, timeouts and provider refusals surface as defined outcomes with recovery that preserves completed evidence. Flight fail-open is raced against success. Pre-authorization note when a later funded bridge can only be quoted after delivery (universal **and** certified Router bridges).

## C. Specialist reviews

Delegated read-only reviews (impact-selected + mission-required): `flofi-chat`, `flofi-frontend-ux`, `flofi-workflow`, `flofi-bridge`, `flofi-wallet-execution`, `flofi-security`.

| Specialist | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| flofi-chat | High | F1–F3 grounding / mention asymmetry on ETH coin-position and network carry | Fixed in `c15a1cc9` |
| flofi-chat | Low | F4 documentation / corpus wording | Accepted / covered by eval corpus updates |
| flofi-bridge | Medium | Dependent-bridge honesty note only detected universal bridges | Fixed: also `routerDetails(node)` |
| flofi-frontend-ux | Low | Truncated token symbol needs `title` | Fixed: `TokenChip` `title={symbol}` |
| flofi-workflow | Low | Continuity / binding observations | No financial invariant break; documented |
| flofi-wallet-execution | Low / info | Late SIWE / session timing | Informational; bounded SIWE remains |
| flofi-security | Low | No authorization / custody regression found | No change required |

## D. Regression coverage added or restored

- `domain/arbitrum-authoring.test.ts` — PT/EN “USDC por ethereum na arbitrum”, shortcuts, no redundant network ask, native ETH vs WETH.
- `packages/action-registry/test/base-network.test.ts` — native / wrapped search aliases.
- `domain/editor-overview.test.ts` — chain-id network chip dedupe.
- `components/canvas-panel-reveal.test.ts` — picker reveal offset / overflow.
- `domain/execution-ux-reliability.test.ts` — continuity after reconcile; simulation presentation.
- `state/flofi-conversation.test.ts` — manual simulation / step-ready after first step.
- Copilot eval / learning / catalog parity corpora updated for FIX-02 copy and ETH grounding.

Guarded browser profiles and CircleCI remain the certification authority; local `pnpm check` is structural evidence only.

## E. Validation

| Gate | Result |
| --- | --- |
| `python3 scripts/agent_guard.py check` | PASS |
| `python3 scripts/governance_lite.py` + unittest | PASS |
| Focused Vitest (authoring, conversation, overview, reveal, execution UX, registry) | PASS (127) |
| `pnpm check` on Node **v24.21.0** / pnpm 11.22.0 | **PASS** — 719 files / 9344 tests (2 skipped); schema export verified |
| PostgreSQL / guarded browser | Deferred to CircleCI profiles on the PR |
| CircleCI / Vercel Preview | After PR open — not claimed green here |

Note: Cursor’s default Node on PATH can be 24.22.1 and fails the schema pin; local certification used `$HOME/.nvm/versions/node/v24.21.0/bin` first.

CircleCI `governance` on `ff786285` failed solely on `git diff --check` trailing whitespace in this file (lines 3–5). Specialist-review ledger / Cursor Task compatibility was not the failing gate: `agent_guard.py review` is advisory/local (Claude Code hooks); CircleCI governance runs unittest + `governance_lite.py` + whitespace checks only.

Specialist reviews ran via Cursor Task (flofi-chat, frontend-ux, workflow, bridge, wallet-execution, security). Claude Code hook ledger (`agent_guard.py review`) does not observe Cursor Task runs; findings and resolutions are recorded in §C above.

## F. Safeguards preserved

Mainnet-only public product; no mock data in production paths; no alternate execution engine; Review + wallet signing unchanged; no fee / commercial / access / env changes; reconciled steps are never auto-repeated; no invented token addresses; no silent ETH↔WETH replacement.

## G. Remaining limitations / owner acceptance

- Downstream bridge route for an exact **delivered** amount cannot be guaranteed before the prior step reconciles; the UI discloses this when a funded bridge follows.
- Extremely small WETH outputs may be refused by providers (honest minimum / unavailable-route messaging) — not bypassed.
- Full Mainnet swap→bridge with the owner's wallet is **not** certified by this build; owner-authorized production acceptance remains required for GO on live funds.
- Read-only live quotes (when available) are not financial execution evidence.

## H. Delivery

One consolidated PR with focused commits per FIX group. Do not merge or deploy from this task. Recommendation in the PR body / final report after CI.

CircleCI `certification-browser-1` on `b10029a5` failed deterministically: `base-mainnet-authoring.spec.ts` still expected the pre-FIX-02 `Real funds on Base` proposal note. Updated to the wallet-signing boundary copy. `certification-browser-3` `swap-read-acceptance` was an intermittent flake (diagnostic rerun passed); the new push re-certifies the full suite.
CircleCI `certification-browser-3` on `302052bd` failed deterministically in `amount-shortcuts.spec.ts`: FIX-01's `ensureNetworkCatalog` pulled the catalog server action (and `pg`) into the acceptance Vite IIFE. Stubbed `asset-catalog-action` in the harness the same way as `portfolio-action`.
