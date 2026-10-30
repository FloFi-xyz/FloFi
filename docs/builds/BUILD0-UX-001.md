# BUILD0-UX-001 — Build 0 intent entry and execution experience cleanup

Branch `claude/festive-darwin-du0oft` from `origin/main` c7abc58 (PR #139 merged). One PR for owner review. Nothing was merged, deployed,
promoted or configured in production; no transaction was signed or sent; no production data was changed.

Evidence level: **A** only (deterministic local tests and loopback/MOCKED browser harnesses on Linux). No fork, mainnet read or owner-wallet
execution was performed by this build.

## 1. Flow

Build 0 → Build 1 (the existing builder: Canvas, chat, editing) → Simulate → Execute.

- **Build 0** (`components/build-entry.tsx`, `build-entry.module.css`) follows the approved reference `TELA_ALVO_CRIA.png`: official mascot
  (`/brand/flofi-droplet-wave*.svg`, byte-identical to the package), Outfit, the headline gradient, CSS-only dotted field and glows, the
  composer with **Create strategy**, five suggestion chips, **Build manually** and the review/authorization notice. Light values from the
  token package, graphite dark theme from the dark package; PT/EN (`i18n/pt-build-entry.ts`); responsive at desktop, ≤800 and ≤590 px.
- **One interpreter, one store.** A Build 0 request is sent through the existing FloFi conversation (`useFlofiConversation`: exact grammar,
  then the configured Copilot, then `commitChatCommand` or the existing Canvas proposal). The hook only exposes its existing `send` as an
  awaitable `submit`. `domain/build-entry.ts` reads the outcome from the stored workflow and FloFi's own reply:
  workflow changed → Build 1; proposal pending → Build 1, where the existing review stays mandatory; question or Copilot reply → Build 1,
  where the conversation continues; nothing changed → FloFi's reason shown in Build 0 with the text preserved.
- **Landing.** Only the public chat-first `/app` opens on Build 0. `/approve`, MCP, channels, `/__engineering`, the Dashboard and the
  secondary workspaces keep their landing. A restored or reopened workflow, a run recovered from this browser, a live execution, a pending
  proposal or an unfinished Canvas card moves the visit to Build 1 once the persisted-run read settles.
- **No network selector.** The reference's Network dropdown and the package's older mocked logic were not reintroduced; the header keeps
  the existing wallet connection and required-network switch. `visual-context/` and `app-shell-intent-only.patch` were references only.

## 2. Chat and Execute cleanup

- The automatic execution report card ("Execution needs attention": steps, operations, networks, hashes) is no longer rendered in the chat.
  FloFi's existing short phase messages remain (wallet request, uncertainty with *Check status*, the result and the next action).
- In the chat-first Execute workspace the **Result details** and **View technical details** disclosures were removed from the composition.
  A compact status panel keeps the status, step progress, request errors, recovery and attention notes, blockers, authorization attention,
  *What happens next*, *Connect execution wallet*, *Create new workflow*, *Return to Build / Back to Simulate* and *View in Dashboard*.
  The timeline keeps each transaction's copy and explorer controls; run IDs, provider references and evidence stay in the Dashboard.
- Execution, recovery, reconciliation and persistence logic, financial backend, providers, fees, RPCs and contracts are unchanged.

## 3. Validation (Linux, Node 24.21.0, pnpm 11.22.0, Chromium headless shell 1243, Anvil 1.8.3, disposable loopback PostgreSQL 16)

| Check | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | pass — 16/16 typecheck, 9/9 build, 11 schema exports, 5812 tests passed, 2 skipped (pre-existing) |
| Governance-lite and CI plan self-tests | pass |
| Guarded browser critical tier (6 profiles) | pass (copilot-learning after the reload fix) |
| Guarded browser extended shard 2 (23 profiles: execution-continuity, MCP, channels, /approve, automations, delegated execution, Admin, owner history…) | pass |
| Guarded browser extended shard 1 (19 profiles) | 18 pass; `default-product` 112 passed, 9 failed with the sandbox's browser wrapper — see §4 |
| New `build-entry.spec.ts` | 7/7 pass |
| CircleCI `governance`, `certification-checks` (unit + result verification, PostgreSQL 18.6, fork) on `c6dacee` | pass |
| CircleCI `certification-browser-2` on `c6dacee` | pass |
| CircleCI `certification-browser-1` on `c6dacee` | critical tier pass; `default-product` failed only the four `/app` baselines below (`build009`, `mock-artifact-chain`, `base-observation` pass) |

## 4. Limitations for owner review

- **Screenshot baselines.** Five `/app` baselines change with this build: `visual-shell` build/simulate/execute and `swap-authoring`
  chat-committed/review-blocked (new `0 Build` tab; the Execute status panel replaces the collapsed *Execution details*). They were
  regenerated with a renderer shown to match CI's: the same Chrome for Testing 153.0.8010.12 headless shell without the sandbox's launcher
  wrapper (which adds `--font-render-hinting=none --disable-lcd-text`) and with stock Ubuntu fontconfig (the sandbox image forces unhinted
  grayscale text). Evidence: with that renderer the untouched `base-observation` and `mock-artifact-chain` baselines pass at
  `maxDiffPixels: 0`; old → new baseline diffs measured with Playwright's comparator equal CI's reported diffs exactly (2017, 1949,
  3660 with 900 → 927 px, 1992); `review-blocked`, never compared in CI because that test stops at its first screenshot, differs by the
  same 1992 header pixels as `chat-committed`. Outside the header only anti-aliasing-level pixels changed (max 54/255 per channel). The new
  baselines pass twice in a row locally; CI is the certifying run.
- **`build009.spec.ts` (2 tests)** request a live LI.FI quote from the server (`li.quest`), unreachable in this sandbox (`ENOTFOUND`); they
  pass in CI.
- One PostgreSQL forward-compatibility case expects PostgreSQL 18's named NOT NULL constraints and fails on the sandbox's PostgreSQL 16; it
  passes in CI on 18.6. No `packages/` file changed in this build.
- Build 0 chips fill illustrative mainnet examples. Exact commands (e.g. *Swap 50 USDC to SOL on Solana*) author directly; natural-language
  ones (liquidity, collateral, multi-step) need the configured Copilot, otherwise FloFi's reason is shown and the text kept. *Supply* needs a
  connected wallet for the beneficiary.
- The `0 Build` / `1 Build` labels follow the requested naming; Build 1 keeps its existing accessible name "Build".

Screenshots: `BUILD0-UX-001-EVIDENCE/` (desktop light/dark/PT, mobile light/dark, Build 1 chat after execution, Execute status panel).
