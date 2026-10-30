# ADR-0007 — Copilot intelligence engine: grounded tools, goal planning, typed state

Date: 2026-10-30. Status: proposed under the owner's BUILD-FLOFI-INTELLIGENCE-001 request (PR review pending).

## Context

The Copilot was a constrained interpreter: one structured OpenAI Responses request per turn, no tools, a static capability
prompt, and FloFi-written answers selected by a question topic. The deterministic conversation engine
(`domain/copilot-conversation.ts`) already grounded every value in the user's words and authored only through the exact grammar.
The audit reproduced these limitations on `6685de4`:

| Reproduced on `6685de4` | Root cause |
| --- | --- |
| "keep the same source" asked "which source network?" again | a restated value was treated as a change that had to be grounded in the latest words |
| "swap 1 usd to eth on base" was refused as an unknown token | no notion of a currency; the catalog lookup failed closed with `ASSET_UNKNOWN` |
| "1,000 USDC" was proposed as whichever reading the model chose | `amountReadings` accepted both readings, and also read `0.001` as `1` (leading-zero grouping) |
| "slippage 50 bps" on a pending catalog swap was refused ("bps is not in the official catalog") | the explicit-asset heuristic read the unit after a number as an input token |
| "what can I do on Arbitrum?" returned one wall of text for every network | the CAPABILITIES answer was not network-scoped |
| a test-network request in the public product was answered by offering mainnets | the network clarification listed mainnets instead of saying the named network is a test network |
| outcomes ("I have USDC on Base and want SOL on Solana") had no path | no goal vocabulary, planner or multi-step authoring command |
| the model could not consult FloFi's registries, catalogs, routes or the user's workflow | no tool contracts |

## Decision

Keep the deterministic engine as the only author of financial values and add, around it:

1. **Typed operational state** (`domain/intelligence/operational-state.ts`), derived — never stored separately — from the open
   request (validated, carried, corrected, missing fields; per-field verification), the canonical workflow revision, the pending
   proposal, the proposals shown and the public wallet/network context. A per-request ledger counts each question so a settled field
   is never asked again unnoticed. Its sanitized **context card** (step kinds, networks, FloFi's own summaries; no address, node id or
   chain id) travels with each request and is fingerprinted (`contextKey`).
2. **A bounded, server-side tool loop** inside `interpretCopilotV2` (`server/copilot-service.ts`) over FloFi's read-only tools
   (`platform/copilot-tools.ts`). The final output is still exactly one strict intent.
3. **A Capability API** (`domain/intelligence/capability-api.ts`): one typed profile per network generated from the network registry,
   the canonical examples, the strategy schema and the execution capability registry.
4. **Goal-to-workflow planning** (`domain/intelligence/goal-planner.ts`): a new `GOAL` intent; FloFi plans registry-backed steps,
   authors each one through the exact grammar and proposes several as one `ADD_SEQUENCE` command (one review, one undo).
5. **Grounded explanations**: QUESTION and GOAL may carry a model `answer`, shown — labelled as an AI explanation, apart from FloFi's
   own answer — only when every number in it is a fact (`domain/intelligence/grounding.ts`), checked on the server against tool outputs
   and again in the engine.
6. **Shared surfaces**: FloFi chat and Channel Core run the same engine and tool contracts; MCP hosts get the same planner as
   `plan_strategy`.

## Tool contracts

Every tool is a strict Responses API function (`additionalProperties: false`, every property required, nullable where optional). The
service re-validates every call: allowlisted name, exact argument keys, closed vocabularies, bounded safe strings, ≤ 4 KiB arguments,
≤ 8 KiB output. Outputs carry no wallet address, recipient or contract address; failures are closed codes.

| Tool | Input | Output (success) | Closed failures |
| --- | --- | --- | --- |
| `get_capabilities` | `network \| null`, `action \| null` | scoped Capability API profiles: actions, asset source (catalog loaded or registry symbols), certified routes, required parameters, `supportedByCode` (simulate/review/execute, demonstrated evidence), `deployment: DECIDED_BY_RUNTIME_AT_REVIEW`, limitations | `NETWORK_UNKNOWN`, `TEST_NETWORK_NOT_AVAILABLE`, `NO_CAPABILITIES_ON_NETWORK` |
| `resolve_asset` | `network`, `reference` | `FOUND` (symbol, native, decimals, by), `AMBIGUOUS` (candidates), `FIAT` (currency, network stablecoins) | `ASSET_UNKNOWN`, `ASSET_CATALOG_UNAVAILABLE`, `ASSET_INVALID_REFERENCE`, network codes |
| `find_routes` | source/destination network, input/output asset, decimal amount | the platform's read-only universal discovery: provenance `FLOFI_UNIVERSAL_DISCOVERY`, `observedAt`, freshness, every candidate's status, executable flag, expected/guaranteed amount (formatted in the output token's decimals), duration, fees (label, amount, symbol, whether included in the amount); certified-route assets | `ROUTE_DISCOVERY_UNAVAILABLE`, `ROUTE_DISCOVERY_TIMEOUT`, provider codes (`*_RATE_LIMITED`, `UNIVERSAL_ROUTER_NOT_ENABLED`, …), `INPUT_ASSET_*`, `OUTPUT_ASSET_*`, `SAME_NETWORK`, `NO_UNIVERSAL_ROUTE_FOR_NETWORK`, `AMOUNT_INVALID` |
| `get_quote` | as `find_routes` | the recommended executable candidate with provenance and observation time | as above, plus the discovery status (`NO_ROUTE`, …) |
| `get_workflow_context` | — | revision, steps, pending proposal, open-request fields | `WORKFLOW_CONTEXT_UNAVAILABLE` |
| `get_wallet_context` | — | EVM/Solana connected flags, EVM network name | `WALLET_CONTEXT_UNAVAILABLE` |
| `validate_strategy` | strategy JSON text (MCP contract v1/v2) | platform validation: valid, workflow hash, funds class, step count, review counts, `authority: NONE` | `valid: false` with code and paths, `STRATEGY_JSON_INVALID` |
| `plan_goal` | goal fields | plan steps, reasons, alternatives, engine composition validity/hash; or `NEEDS`/`UNSUPPORTED`/`NOTHING_TO_DO`/`LIQUIDITY` | `AMOUNT_INVALID` |
| `explain_failure` | closed code | FloFi's own copy for that code | `CODE_INVALID` |

Loop bounds (`COPILOT_ORCHESTRATION_LIMITS`): 3 tool rounds, 8 calls per turn, 4 per round, 24 KiB of tool output, a 45 s turn
deadline, an 8 s timeout per discovery. Calls over budget are answered `TOOL_CALL_LIMIT`; when the budget is spent the next request
uses `tool_choice: none`, and a model that still calls tools fails closed. The whole loop holds one slot of the existing per-process
limiter. Usage tokens are summed across rounds. No cost is computed: there is no verifiable price source in the repository.

## Authority and safety

- Nothing a tool returns becomes a financial value. Amounts, caps, slippage and addresses still come only from the user's words
  (instruction 15 and the engine's grounding); goal values the user did not write are dropped and asked.
- The model never signs, simulates, reviews, authorizes or submits. `ADD_SEQUENCE` is an authoring command; each of its steps is an
  existing single-action command, and the sequence runtime still simulates, reviews and asks for a wallet signature per step.
- Capability discovery is not execution certification: profiles report code facts from the registry; deployment enablement is
  decided at Review. The public scope never lists, suggests or authors a test network; a named test network is refused as such.
- A currency is never converted into a token: `USD` and similar are clarified with the network's own stablecoins.
- Stale data: the server echoes the request's `contextKey`; the engine refuses an answer for another key, and its existing snapshot
  check refuses one computed before a workflow, proposal or wallet change.
- Telemetry is content-free: interpretation records add tool counts, categories, failures, rounds, grounding outcome, surface and
  context-card presence; turn records (`flofi.copilot.turn`) count clarifications, repeated questions, corrections, turns per request,
  proposal steps and inferred-versus-validated mismatches. `FLOFI_COPILOT_TELEMETRY=off` silences both.
- `FLOFI_COPILOT_TOOLS=off` is the operator break-glass: the turn is the single structured request it was before.

## Compatibility and migration

- No database migration, no environment variable change, no dependency change. Model selection and credentials are unchanged.
- V2 intents recorded before this build parse unchanged (`answer`/`recipient` are optional keys). Requests without a context card are
  accepted. Without tools and without a card the request body and the telemetry record are byte-identical to before.
- Behaviour changes, each covered by tests: an ambiguous grouping is clarified (`L08` now asks, then proposes); `0.001`/`0,005` are
  decimals only; a model explanation is grounded instead of failing the whole turn (`X13`); a public test-network request is refused
  as a test network; unit words after a number are never tokens; a restated settled value is carried.
- MCP adds `plan_strategy` (scope `flofi.strategy`). Existing tools and hashes are unchanged.
- Channel Core keeps its boundary: it reaches no flow runtime, so its route tools answer `ROUTE_DISCOVERY_UNAVAILABLE`; live route
  discovery is wired only in FloFi's web chat (`server/copilot-toolkit.ts`).

## Adding a network or protocol

Register and certify it where FloFi already looks; nothing is taught to the Copilot by hand:

1. Network identity in `domain/network-registry.ts` (key, chain, name, environment, Copilot id, mention pattern, catalog flag).
2. Assets in its validated official catalog loader (catalog networks) or the protocol profile registry.
3. A canonical example per supported action in `engine/strategy-examples.ts`, composed by the real reducer.
4. Its execution capability rows in `@defi-workflow-engine/action-registry` and a runtime flow; certify per the existing gates.
5. For cross-chain use, a certified Router pair or membership in `UNIVERSAL_NETWORKS`.

The Capability API, the model's "What Flofi supports" section, the scoped capability answer, the goal planner's options and
`get_capabilities` follow automatically; `capability-api` tests assert the profile set equals the registry's.

## Known limitations

- Live model tool-calling (including reasoning-item continuation with `store: false`) is verified against a scripted transport only;
  owner live acceptance with the configured model is required.
- Liquidity is not a sequence step, so "swap then add liquidity" is refused with alternatives rather than executed.
- Channel Core has no live route discovery (boundary-preserving); Telegram users get registry facts, not live quotes.
- A goal never chooses among assets or protocols on its own; it plans only what the registries certify for the stated outcome.
- Turn analytics are log records; no durable Admin dashboard was added (that needs a reviewed migration).
