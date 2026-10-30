# BUILD-FLOFI-INTELLIGENCE-001 — Dynamic conversational engine

Branch `claude/build-flofi-intelligence-001`, worktree `~/projects/flofi-intelligence-001`, base `origin/main` = `6685de4`
(BUILD-FLOFI-AGENTS-001), verified by a fresh fetch before any change; the tree was clean. Architecture decision:
[ADR-0007](../adr/ADR-0007-copilot-intelligence-engine.md). Nothing was merged, deployed or promoted; no hosted variable, database,
wallet or real-money transaction was touched.

## What was reproduced first

A probe against the real engine on `6685de4` (scripted model answers, committed catalogs) showed that casing, PT decimals (`0,0001`) and
"make it 2" already worked. The defects, each now fixed and covered: "keep the same source" re-asked a settled network; `usd` was refused
instead of clarified; `1,000` was proposed as the model's reading and `0.001` also read as `1`; "slippage 50 bps" on a pending catalog swap
was read as a token named `bps`; capability answers were one unscoped wall of text; a public test-network request was answered by
offering mainnets; outcomes had no planning path; the model could not consult FloFi's registries, routes or the user's workflow.

## Delivered

**A. Conversational state.** `domain/intelligence/operational-state.ts` derives the typed operational state (validated / carried /
corrected / missing fields with per-asset verification, revision, pending proposal, public wallet context) and the sanitized context card
sent with each request. A per-request ledger counts each question; a restated settled value stays carried; edits record corrections.
Ambiguous groupings are clarified; units are never tokens; currencies are never tokens.

**B. Tool orchestration.** `interpretCopilotV2` runs a bounded Responses API tool loop (3 rounds, 8 calls, 24 KiB, 45 s) over nine
strict read-only tools in `platform/copilot-tools.ts` (capabilities, asset resolution, live route discovery and quote, workflow and
wallet context, strategy validation, goal planning, failure explanation). Names and arguments are validated by the service; outputs are
bounded and address-free. Model explanations are grounded server-side in tool outputs and again in the engine.

**C. Capability API.** `domain/intelligence/capability-api.ts` generates one profile per network from the existing registries (identity,
actions, catalog availability, certified routes, universal router membership, required parameters from the strategy schema, code-level
simulate/review/execute support, limitations). Public scope lists mainnets only; deployment enablement stays a Review-time fact.

**D. Goal-to-workflow planning.** A `GOAL` intent and `domain/intelligence/goal-planner.ts`: same-network swaps, certified or universal
bridges (which convert inside the route), and supply after a bridge or swap, funded by the earlier step and capped by the user's own
amount (or a cap the user states). Several steps become one `ADD_SEQUENCE` command, verified against the existing sequence runtime and its
funding before it is proposed. Liquidity after a conversion is refused with alternatives (liquidity is not a sequence step).

**E. Shared surfaces.** FloFi chat and Channel Core run the same engine and tool contracts (Channel Core without live route discovery,
preserving its no-flow-runtime boundary); Channel Core turns an `ADD_SEQUENCE` into its existing step list with typed bindings; MCP adds
`plan_strategy` over the same planner. The same goal produces the same bound workflow hash on all three.

**F. Analytics.** Interpretation records add tool calls, categories, failures, rounds, grounding outcome, surface and context-card
presence; new `flofi.copilot.turn` records count clarifications, repeated questions, corrections, turns per request, proposal steps and
inferred-versus-validated mismatches. Content-free; no cost is inferred.

## Certification added

| Suite (required in `coverage.json`) | Cases | Covers |
| --- | --- | --- |
| `app.domain.intelligence.conversation-regression` | 25 | mandatory cases 1–13 and goal acceptance through the real engine, grammar, editor and catalogs |
| `app.domain.intelligence` | 17 | Capability API vs registries, planner matrix (incl. bindings composed by the engine), asset resolution, grounding, card, turn metrics |
| `app.platform.copilot-tools` | 10 | allowlist, strict arguments, outputs, case 15 provider failures (unavailable, rate limited, timeout, no route, catalog unavailable) |
| `app.server.copilot-orchestration` | 9 | tool loop bounds, closed codes, grounding drop/keep, context-key echo, break-glass, telemetry content |
| `app.platform.intelligence-parity` | 4 | case 14: chat = Telegram engine = real MCP gateway (`plan_strategy`, `compose_strategy`, `review_strategy`) |

Owner-run live probes for the tool loop were added to `copilot-live.live.test.ts` (never CI; needs a real key).

## Validation

Toolchain: Node 24.21.0, pnpm 11.22.0, pinned PostgreSQL 18.6 (`postgres@sha256:3725f4e2…`, disposable container on loopback
`127.0.0.1:29451`, trust auth), Anvil 1.8.3, headless shell 1243. Dependencies installed from the frozen lockfile with lifecycle scripts
off. No remote database, provider or model was contacted; route discovery in tests is a deterministic port.

| Check | Result |
| --- | --- |
| New suites (5) | 65 passed |
| Existing Copilot eval corpus (incl. all absolute safety invariants) | 234 passed after the two intended expectation updates (L08, X13) |
| Full typecheck (`pnpm typecheck`) and lint (`pnpm lint`) | PASS |
| Production build (`pnpm build`, Next.js 16.4.1) and schema drift (`pnpm schemas:check`, 11 exports) | PASS |
| Full unit/contract run (`pnpm test`, CI command with JSON report) | 5,777 passed, 2 skipped (the existing optional `composition-service`/`mode-b-service` skips), 0 failed — on commit `2ab205b` |
| Required unit suites (`agent_guard.py verify-results`) | PASS (31 required suites: the 26 existing plus the 5 new; every case passed) |
| Full PostgreSQL run (`pnpm test:postgres`) | 513 passed, 3 skipped (the existing certified-ahead compatibility skips), 0 failed |
| Required PostgreSQL suites (`verify-results --stage postgres`) | PASS (26 suites, every case passed) |
| Guarded browser profiles (production build, loopback harnesses): copilot 13, copilot-learning 1, base-mainnet-authoring 4, universal-bridge 11, copilot-solana 3, robinhood-mainnet-authoring 4, execution-continuity 34, chat-automations 8, channel-approve 3, mcp-in-chat 26 | 10 profiles, 107 passed, 0 failed |
| Ownership guard (`agent_guard.py check`) | PASS: 19 domains, 161 modules; new files mapped explicitly (no blind regeneration) |
| Python CI self-tests / governance self-tests / governance scanner / `git diff --check` | 108 passed / 19 passed / PASS / clean |

An earlier full unit run on an intermediate tree failed one case: rewording the model instructions had removed the pinned phrase
"never answer it yourself". The phrase was restored (the factual answer stays FloFi's; the optional explanation is a separate grounded
field); the guard test was not changed. The remaining browser profiles of the 49-profile matrix were not run locally; CircleCI runs the
complete matrix and remains authoritative.

## Product-completion continuation (unmerged on this branch)

### Continuation validation

Local evidence on the uncommitted product-completion tree (Node 24.21.0, pnpm 11.22.0, disposable PostgreSQL 18 on loopback `127.0.0.1:29451`):

| Check | Result |
| --- | --- |
| Focused intelligence / sequence / channel / metrics suites | 110+ passed (incl. swap→liquidity parity and confirm-run liquidity) |
| Full unit (`pnpm test`) | 5,804 passed, 2 skipped, 0 failed; `verify-results` PASS (33 required suites) |
| Full PostgreSQL (`pnpm test:postgres`) | 521 passed, 3 skipped, 0 failed |
| Live channel discovery probe (Base USDC → Solana SOL) | PASS — authentic Relay `EXECUTABLE` quote via `channel-copilot-toolkit` |
| Typecheck / lint / schemas:check / production build | PASS |
| Configured production-model acceptance (`pnpm test:copilot-live`) | Not run here — no `OPENAI_API_KEY` in this environment; owner-gated |

Owner-required gaps closed on top of `e6dbb69` without weakening custody, review or signing:

- **Liquidity sequences.** Goal plans may include `add_liquidity` funded by a prior swap/bridge when the user states deposits and
  range; sequence runtime binds both pool sides from reconciled deliveries (`uniswap-pool` / `solana-pool`).
- **Channel quotes.** Authenticated Channel Core entry points use `channel-copilot-toolkit.ts` for public-subject universal
  discovery (no flow runtime / wallet principal / transaction transport).
- **Admin AI Analytics.** Additive migration `0017_copilot_metrics` + `/admin/ai-analytics` for content-free daily counters.
- **Public MCP access.** On `PUBLIC_MAINNET`, OAuth account creation is open; invitation digests remain for engineering fixtures.
- **Amount editing bounds.** Newly authored mainnet amounts use token encoding limits; live quotes/simulation still decide
  availability. Older reviewed workflows keep their stored editable bounds.

## Remaining limitations

- Live model tool-calling, including reasoning-item continuation with `store: false`, is certified against a scripted transport only;
  run `FLOFI_COPILOT_LIVE_SMOKE=1 … pnpm test:copilot-live` with the configured model before relying on it.
- Percent-of-price liquidity ranges need a live pool mid before authoring (`GOAL_POOL_PRICE_REQUIRED`).
- No public execution, wallet ceremony or provider availability is evidenced by this build; CircleCI remains authoritative for the
  full browser matrix.

## Deployment readiness

Ready for owner review; not ready to promote without the owner's live-model acceptance run and explicit authorization to apply
migration `0017_copilot_metrics`. Operational switches: `FLOFI_COPILOT_TOOLS=off` (tools off, previous single request),
`FLOFI_COPILOT_TELEMETRY=off`. Do not merge, deploy or change hosted settings without separate owner authorization.
