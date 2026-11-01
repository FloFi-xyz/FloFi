# BUILD-FLOFI-EXECUTION-PERFORMANCE-001 — End-to-end transaction acceleration and multichain engineering skills

**Status:** ready for owner review. PR: [FloFi-xyz/FloFi#148](https://github.com/FloFi-xyz/FloFi/pull/148), stacked on #146. Nothing is merged, deployed or configured, and no production database, credential or
real-money transaction was touched.

## 1. Baseline

| Item | Value |
| --- | --- |
| Repository | `alrimarleskovar/FloFi` (GitHub also reports `FloFi-xyz/FloFi`) |
| Dependency | PR #146 BUILD-FLOFI-PRIVY-UX-001, **open, not merged** at implementation |
| PR #146 head used | `ea4099eab4aff5339281d0841e98b20c76ddad5f` (newer than the prompt's historical `9dc8d23e`) |
| This branch | `claude/build-flofi-execution-performance-001`, stacked on PR #146; PR #146 and its branch are unchanged |
| Toolchain | Node **24.21.0** (official binary, SHA-256 checked) for the gates, pnpm 11.22.0, Anvil 1.8.3 (publisher digest verified), PostgreSQL 16 loopback |

The session was assigned the branch `claude/wonderful-shannon-nacbbz`, which is PR #146's own head branch. The owner's
instruction was to leave PR #146 and its branch unchanged and use a separate stacked branch, so all work is on
`claude/build-flofi-execution-performance-001`. Every Privy contract from PR #146 is preserved:
- `floFiSigningGate` and the server-side reviewed-attempt claim;
- exact-byte verification;
- `showWalletUIs: true`;
- fail-closed cancel;
- account linking and session security.

Turnkey is not reintroduced.

Agent procedure: `agent_guard.py check` passed at baseline. `agent_guard.py impact --base origin/claude/wonderful-shannon-nacbbz`:
- selects all 19 domains, because `coverage.json` changed (a governance change);
- reports no unmapped file;
- selects 10 skills (§8).

## 2. Latency path traced (actual code, not reports)

Three read-only investigations traced Intent → quote → Review → Privy → signature → submission → confirmation →
reconciliation. They covered the web chat, MCP, channels, the BFF, the backend flows, PostgreSQL, the RPC transports,
Uniswap, Jupiter, the routers and Privy. The real bottlenecks found:

1. **Paced RPC.** Every live EVM read goes through `pacedReadRpc`: one queue per transport, one call at a time, at
   least 250 ms between starts.
   - This applies even with a keyed `GRYLOO_<NET>_RPC_URL`.
   - A Uniswap catalog quote made about 46 reads (4 fee tiers × 8 reads, plus protocol, token and head checks), so it
     took at least 11.5 s from pacing alone.
   - Owner-bound Review and `begin` repeat the quote and add more reads.
2. **Duplicated reads.** In one request:
   - `eth_getBalance(account, block)` was read twice in `bindSwapOwner` and up to three times in `begin`;
   - gas, gas price and the L1 fee were read one after another.
3. **Universal discovery** waited for every provider through `Promise.all`, each with a 20 s HTTP timeout. The chat tool
   gives up at 8 s, so one hanging provider (say LI.FI or Mayan) made `find_routes` and `get_quote` return
   `ROUTE_DISCOVERY_TIMEOUT`, even when Relay's executable route had arrived in under a second.
4. **Legacy router:** provider quotes ran sequentially, so the wait was the sum of the providers, each up to 15 s.
5. **Swap estimates:** the optional USD price observation (up to 2.5 s) started only after the quote.
6. **Jupiter Review:**
   - the cluster check ran before `/build`;
   - the lookup tables, balances and blockhash were read one after another.
7. **Privy handoff:**
   - **Server actions run one at a time per client.** Before the wallet prompt, a redundant `publicStatus` round trip
     queued ahead of the signing gate.
   - **The gate's database work:**
     - it read the full account (3 queries) where only the wallets are needed;
     - it read the pending nonce and the fees one after another.
   - **The chat confirmation skipped the Privy readiness check** that Canvas Authorize applies, so a Review could be
     accepted for a wallet the page could not yet show.
8. **Lifecycle:**
   - pages followed a submission for 60 s and then waited for a click;
   - a refresh after submission did not resume observation;
   - MCP status had no canonical lifecycle field.
9. **No latency instrumentation existed:**
   - discovery logged provider results without durations;
   - there was no percentile computation anywhere.

## 3. Changes and why

### Route accelerator (P0)

**Universal discovery window** (`server/universal-router/discovery.ts`, `http.ts`):
- **When discovery answers:** all providers are asked at once. Discovery answers at the earliest of:
  - every provider answered (COMPLETE);
  - Relay's verified EXECUTABLE route arrived and the compare window passed (1.5 s; 1 s for chat);
  - the deadline passed (12 s for UI and estimates; 5.5 s for chat and channels).
- **Stragglers:**
  - They are aborted (request-scoped `AbortSignal`) and reported as `TEMPORARILY_UNAVAILABLE` with
    `<PROVIDER>_DISCOVERY_WINDOW_ELAPSED`.
  - A late answer is discarded, never merged.
- **What cannot change:** only Relay can be EXECUTABLE in discovery, so the window never changes the recommended route.
  Refusal classification, rate-limit handling and ranking are unchanged.
- **New result fields:** `completeness`, `pendingProviders` and `timing`. They are presentation only.
- **Where it shows:**
  - The chat tools report `comparison: PROVISIONAL | COMPARED` and `notCompared`, and `get_quote` does too on failure.
  - The bridge panel shows a provisional notice (EN and PT).
  - Provider durations are logged.

**Legacy router** (`server/router-service.ts`):
- Provider quotes are asked at once with `Promise.allSettled` and folded in the reviewed preference order. Selection and
  `considered` are identical to before.
- The destination observation overlaps the quotes. Error order is preserved: `ROUTER_NO_EXECUTABLE_ROUTE`, then the
  allowance read, then the destination.

**Uniswap V3 catalog quotes** (`server/public-testnet-service.ts`):
- **`DeploymentFactCache`:** immutable deployment facts are remembered per process for 10 minutes, on live mainnets only.
  - **What is cached:** a pinned contract's code, router and quoter immutables, a listed token having code, and a CREATE2
    pool's code and immutables.
  - **When:** facts are committed only after the quote's same-block reorg check passes. A failed verification is never
    remembered, and Stock Token state is never cached.
  - **Always fresh:** liquidity, `slot0`, the quoter output, decimals, the head, balances, nonces, gas and the reorg check.
  - **Switch:** `GRYLOO_DEPLOYMENT_FACT_CACHE=off` turns the cache off on every catalog network.
- **Fee tiers:** asked together, with failures judged in tier order.
- **Duplicate reads removed:**
  - `bindSwapOwner` reads the native balance once;
  - `begin` reads one native balance (instead of up to three);
  - gas, price and L1 fee are read together and judged in their original order.

**Swap estimates** (`server/build-estimate.ts`): the USD observation starts alongside the quote, once per asset.

**Jupiter** (`packages/reference-compiler/src/jupiter.ts`):
- The cluster check overlaps `/build`, but the cluster verdict is judged first.
- Lookup tables, balances and blockhash are read together, with failures judged in the original order.
- **`mode=fast` is evaluated and not enabled.** The official docs, pinned in `skills/protocols/jupiter`, call it BETA,
  with no route splitting and a global priority-fee estimate. FloFi's Review binds the minimum output and caps the fee.
  A test guards that Review sends no `mode`.

**Uniswap Trading API:**
- FloFi quotes on-chain through QuoterV2 and does not use the Trading API.
- `FASTEST`/`BEST_PRICE` are Trading API `routingPreference` values and do not apply. Using them would mean an API key
  and calldata that FloFi's adapters would have to verify. They are documented, not added.

**Opt-in dedicated read pacing** (`public-testnet-rpc.ts`): with `GRYLOO_RPC_READ_PROFILE=dedicated`, operator-configured
endpoints run up to 6 reads at once, 25 ms apart, with a shared transport-failure pause. Public default endpoints keep the
measured 250 ms, one-at-a-time pacing.

### Privy fast handoff (P0)

- **Chat readiness:** the chat checks Privy `canSign` before accepting a Review, the same check as Canvas Authorize.
  Nothing is accepted, begun or claimed for a wallet that cannot show the request.
- **Signing gate (`app/flofi-wallet-action.ts`):**
  - one wallet query instead of the account record's three, with an existence check only when there is no wallet, so the
    error codes are unchanged;
  - nonce and fee reads run together and are judged in the same order (`server/managed-signing.ts`).
- **No status round trip before the wallet prompt:** `begin` saved exactly `run + attempt`, so the page shows that
  directly.
- **Review deadline in Privy:** Privy's confirmation now states "Confirm before HH:MM:SS UTC", taken from FloFi's server
  summary.
- **Privy settings memoized by content:** a cookie-setting server action re-renders the layout with a new `config`
  object, which no longer hands Privy new settings.
- **Wallet-state messages:** rejection, wrong network and unknown submission have clear text in EN and PT.
- **Unchanged and fail-closed:** `floFiSigningGate`, the claim, exact bytes, `showWalletUIs` and cancel. There is no
  automatic or delegated signing and no re-signing.

### Execution and lifecycle (P0)

- **Observation schedule** (`domain/observation-schedule.ts`):
  - every 2 s for 30 s (as before), then 4 s and 10 s, about 4.5 minutes in total;
  - read-only observe only;
  - each loop stops on unmount or when another run becomes the page's run.
  - Jupiter follows a submitted swap in the background, so the page lock is released.
- **After a refresh:** a run with a transaction in flight resumes observing by itself. Recovery stays read-only and never
  creates a new transaction.
- **Canonical lifecycle** (`domain/canonical-execution-status.ts`):
  - `AUTHORIZATION_PENDING`, `SUBMITTED`, `HASH_KNOWN`, `CONFIRMED_ONCHAIN` and `SETTLEMENT_PENDING` (cross-chain);
  - `RECONCILED`, the only status where `completed` is true;
  - `REJECTED`, `REVERTED`, `FAILED`, `INCONCLUSIVE` and `INTERVENTION_REQUIRED`.
  - It is added to the MCP execution status view and checked against the Dashboard mapping by a test.

### Performance observability (P1)

- **Journey marks** (`domain/journey-metrics.ts`): content-free marks per journey (a random id, the chain reference, the
  provider label, the wallet type and the outcome). They produce all required metrics:
  - `intent_to_first_quote_ms`, `intent_to_best_quote_ms`, `quote_to_review_ready_ms`;
  - `review_to_wallet_open_ms`, `wallet_open_to_user_decision_ms`, `authorization_to_submission_ms`;
  - `submission_to_hash_ms`, `submission_to_confirmation_ms`, `confirmation_to_reconciliation_ms`;
  - `workflow_total_duration_ms`;
  - plus system-only splits: `review_request_to_ready_ms` and `authorize_to_wallet_open_ms`.
- **User time vs system time:** the person's time in the wallet (`userMs`) is separated from system latency
  (`systemMs`). Spans that mix both are reported but never summed as system latency.
- **Where it is wired:** the live quote, the EVM swap journey and the Jupiter journey. The browser sends a same-origin
  beacon to `POST /api/flofi/journey` (`server/journey-telemetry.ts`).
- **The endpoint:**
  - closed schema, same-origin, a 4 KiB cap (also without `Content-Length`), and a per-process rate bound;
  - writes the existing `createLogger` JSON stream, with no new table or analytics system;
  - labels events `CLIENT_REPORTED`;
  - `FLOFI_JOURNEY_TELEMETRY=off` drops them.
- **Report** (`scripts/journey-latency-report.mjs`): nearest-rank p50/p95 per metric and per network, operation, provider
  and wallet, read from those logs (plus server-measured discovery durations).
  - It requires an `--environment` label, which it copies verbatim.
  - A group with fewer than 20 samples prints `INSUFFICIENT_SAMPLE`.

## 4. Before/after evidence (environment and provenance labelled)

No public provider, public RPC, live Privy or production log was exercised. Every figure below is LOCAL or MOCKED.

| Stage | Before | After | Evidence |
| --- | --- | --- | --- |
| Discovery with one hanging provider | Waited for the slowest provider (up to 20 s); chat tool timed out at 8 s with no result | Relay executable at 400 ms + 1.5 s compare → **1.9 s**, Relay recommended, straggler aborted | MOCKED, fake clock (`discovery.test.ts`) |
| Discovery, all providers inside window | Same result | Identical candidates and recommendation (COMPLETE) | MOCKED fixtures recorded 2026-10-25 |
| Rate-limited provider + valid provider | Classified, but waits for all | Classified `LIFI_HTTP_429`, Relay recommended | MOCKED |
| Legacy router quotes | Sum of providers | Max of providers (2 in flight observed), selection identical | MOCKED harness (`router-service.test.ts`) |
| Uniswap catalog quote, RPC reads per quote (Base/Arbitrum fixture, 1 live pool) | 25 | **11** warm (cold unchanged) | MOCKED chain (`build-estimate-catalog.test.ts`) |
| Same, Robinhood Stock Token pair | 30 | **17** warm | MOCKED |
| Same, modelled at the public 250 ms pacing | 6.25 s / 7.5 s floor | 2.75 s / 4.25 s floor | Arithmetic on MOCKED counts; with 4 live pools the count is about 46 → 17 (derived, not measured) |
| USD on estimates | Up to 2.5 s after the quote | Starts before the first chain read | MOCKED ordering test |
| Jupiter Review prologue | Genesis RTT, then `/build` | Overlapped (order asserted), cluster verdict still first | MOCKED |
| `begin` (EVM) | 3 native balance reads; gas, price and L1 fee one after another | 1 balance read; gas, price and L1 fee together | Code + existing suites |
| Privy gate DB reads | Session + 3 account queries (gate and broadcast each) | Session + 1 wallet query | Code + wallet suites |
| Server actions before the wallet prompt (EVM swap) | `begin` → `publicStatus` → wallet | `begin` → wallet | Code |
| Following a submission | 60 s, then a manual click; nothing after refresh | About 4.5 min automatically, resumed after refresh | Unit tests (schedule); store code |

**p50/p95 are not reported:** no genuine sample exists. The report tool prints `INSUFFICIENT_SAMPLE` until production or
preview logs with at least 20 journeys per group are supplied, and it labels journey timings as client-reported.

## 5. End-user scenarios (automated evidence; all loopback or MOCKED)

| # | Scenario | Coverage |
| --- | --- | --- |
| 1 | Base USDC → ETH/WETH | Catalog quote, cache and fresh-read tests; existing base-swap and native-ETH suites |
| 2 | Solana SOL ↔ USDC (Jupiter) | `reference-compiler` Jupiter suite (31), including overlap and cluster precedence |
| 3 | Base → Arbitrum bridge | Router suite (31), including concurrent providers with an unchanged selection |
| 4 | Cross-chain involving Solana | Discovery suite on recorded Solana → Base answers |
| 5 | Multi-step chat | `flofi-conversation` suite (20) |
| 6 | Privy embedded EVM wallet | `flofi-privy-signer` suite (8), wallet suites; PR #146 browser `auth-wallets` not re-run here |
| 7 | Privy embedded Solana wallet | `flofi-privy-signer` suite |
| 8 | Authenticated user, no second Google login | Unchanged PR #146 session; chat now checks readiness before Review |
| 9 | External wallet | Unchanged path; journeys tag `external` |
| 10 | Slow provider / timeout | Discovery window tests |
| 11 | Rate-limited provider with another valid one | Discovery 429 test |
| 12 | Expired quote requiring new Review | Existing `QUOTE_EXPIRED_REVIEW_REQUIRED` paths unchanged and passing |
| 13 | Wallet rejection | Signer suite; new swap-store messages |
| 14 | Refresh after submission | Store recovery code with run guards. **Gap:** no store-level unit test; covered by the critical browser tier only where its specs reach it |
| 15 | Lost wallet response after possible submission | Existing UNKNOWN reconciliation unchanged |
| 16 | Double click / concurrent request | Existing locks unchanged; the chat path adds a refusal only |
| 17 | Genuine failure vs inconclusive | Canonical status tests (14 statuses × flags, Dashboard agreement) |
| 18 | Disconnect → `/login` | Unchanged from PR #146 (not modified) |
| 19 | Chat / MCP / channel continuity | Copilot tool, channel and MCP suites; MCP lifecycle field |
| 20 | Multiple users without leakage | Fact cache holds no user data; PostgreSQL tenancy suites pass |

## 6. Gates (this session)

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass |
| `pnpm schemas:check` (Node 24.21.0) | pass (11 exports) |
| `pnpm test` | **503 files, 6116 tests pass**, 2 pre-existing conditional skips; `verify-results`: 35 required suites pass |
| `pnpm test:postgres` (PostgreSQL 16 loopback) | 567 pass, 3 skipped; **1 fails because of the environment**: `forward-compatibility.pg.test.ts` asserts PostgreSQL 18 behaviour (named NOT NULL constraints). CI pins `postgres:18.6`; only 16 was available here, and this build touches no migration or cloud-runtime code |
| `agent_guard.py check`, `governance_lite.py`, `test_ci_*` (179, including 9 new skills-registry tests) and `test_governance_lite` (21) | pass |
| `skill_registry.py verify` | pass |
| `skill_registry.py check-upstream --fetch` | 32 pinned sources UNCHANGED over live HTTPS; 12 doc sites UNREACHABLE from this network |
| Critical browser tier (`guarded-release-browser.mjs critical`) | **6/6 profiles pass**: copilot-learning, canvas-corrections, solana-wallet-refusal, supply-provenance, review-execute-recovery-components, solana-transfer-ux |
| Extended profiles relevant to this build | **pass**: auth-wallets (13 tests, Privy loopback stand-in), jupiter-provenance, router-provenance, execution-continuity (34 tests) |
| Remaining extended shards | not run locally; CircleCI runs the complete suites |

## 7. Specialist review (existing agents, read-only, at most 3 at once)

flofi-wallet-execution with flofi-security, flofi-swap with flofi-protocol-integrations, and flofi-bridge with
flofi-workflow reviewed the diff. They ran as general agents following `.claude/agents/*.md` plus their
`agent_guard.py domain` contracts and selected skills; the flofi-* agent types were not exposed in this session.

| Severity | Finding | Resolution |
| --- | --- | --- |
| Medium | Jupiter recovery poll could overwrite a newer simulation and its recovery pointer | Fixed: followed-run guard, unmount stop, background observation |
| Medium | Deploy skew: new web + old API rejected the extra `discover` argument | Fixed: fallback to the one-argument call; API-first release order documented |
| Low | Public-testnet recovery write lacked a run check | Fixed |
| Low | Execute loops ignored unmount; Jupiter held its lock for the longer schedule | Fixed |
| Low | Facts cached before the reorg check | Fixed: committed after the same-block check (test) |
| Low | Kill switch ignored on Robinhood Chain | Fixed (test) |
| Low | Telemetry body read unbounded without Content-Length; events forgeable | Byte-capped read (test); events labelled `CLIENT_REPORTED` and the report labels its evidence |
| Low | Canonical status gaps (`SUBMISSION_RESULT_UNKNOWN`, `REFUNDED`, …) | Mapped (tests) |
| Low | `get_quote` hid provisional comparisons; caller-signal listener leak; 6.5 s window close to the 8 s limit | Fixed; chat window now 5.5 s |
| Low | Skill text over-generalised Jupiter `begin` and estimate block; tokenizer kept trailing punctuation | Fixed (test) |
| Low (existing) | Quoter catch treats a transport error as "tier unavailable" | **Not changed**: some nodes report reverts with codes FloFi maps to transport errors. Narrowing it without live measurement could fail healthy quotes. Recorded for follow-up |

## 8. Multichain engineering skills registry

- **Structure:** `skills/` holds 17 skills:
  - networks: EVM core, Ethereum, Base, Arbitrum One, Solana;
  - protocols: Uniswap, Aave, Jupiter, Orca, Across, LI.FI, Relay;
  - operations: swap, bridge, liquidity, lending, execution.

  Each has FloFi-written guidance (`SKILL.md`, with its sha256 pinned) and a manifest declaring its scope, the existing
  domains it informs, path globs, keywords, dependencies, registered capability tuples, its sources and
  `ENGINEERING_REFERENCE_ONLY`.
- **Sources:** 22 official files are pinned at exact upstream commits with normalized digests (fetched from GitHub
  `raw.githubusercontent.com`, the only allowed host):
  - Jupiter docs: `/build`, `reduce-latency`;
  - Uniswap docs (swap routing) and v3-periphery QuoterV2;
  - the Solana Foundation official `solana-dev` skill and the solana.com transaction and fee docs;
  - Arbitrum docs;
  - ethereum.org transactions, gas, blocks and proof-of-stake;
  - OP Stack exec-engine;
  - Aave v3-core Pool; Orca Whirlpools; Across contracts; LI.FI SDK; Relay kit.
- **Verification status:**
  - Licensed sources are VERIFIED.
  - Jupiter and Arbitrum documentation repositories state no licence, so their pinned files are PENDING_VERIFICATION, with
    change detection active.
  - The owner-named sites are recorded as PENDING_VERIFICATION because this network could not reach them:
    ethereum.org/developers/tools/ethskills, solana.com/skills, developers.jup.ag, developers.uniswap.org,
    docs.base.org, docs.arbitrum.io and others.
  - The third-party `skills.rest/skill/arbitrum-defi-guide` is THIRD_PARTY PENDING_VERIFICATION. It may become VERIFIED
    only after a cross-check against verified official sources.
- **`scripts/skill_registry.py`** (no AI, no execution):
  - `verify`: provenance, licence, official URL prefixes, guidance digest, negation-aware safety lint, dependencies and
    cycles;
  - `select`: deterministic selection from path globs, task keywords and network/protocol/operation, then dependencies,
    with reviewers batched to three;
  - `check-upstream`: offline snapshot or explicit `--fetch` over HTTPS (same-host redirects, 2 MiB cap, hash only), with
    `--proposal` for code review;
  - `digest`.
- **Integration with the existing agents:**
  - `agent_guard.py check` validates the registry in the existing CI jobs.
  - `impact` and `domain` list the `SKILL.md` files the existing specialists should Read. There is no new agent, agent
    definition or orchestration.
  - A unit test (`platform/engineering-skills.test.ts`) asserts three things:
    - every capability a skill names exists in `executionCapabilityRegistry`;
    - the Capability API still profiles those networks;
    - no runtime source imports or reads `skills/`.
- **Used in this build:** the review batches were selected with it, and the specialists read:
  - Jupiter, for the `mode=fast` decision;
  - Uniswap, for the Trading API distinction and the cacheable immutable facts;
  - EVM core and Solana, for the parallelization rules;
  - bridge and Relay, for the discovery window;
  - execution, for the lifecycle and journey rules.

## 9. Release considerations

- **No migration, schema certificate, dependency or credential change.**
- **Optional variables** (`docs/deploy/ENVIRONMENT.md` §5k): `GRYLOO_RPC_READ_PROFILE=dedicated` (opt-in),
  `GRYLOO_DEPLOYMENT_FACT_CACHE=off` (kill switch) and `FLOFI_JOURNEY_TELEMETRY=off`.
- **Deploy order:** the API (Railway) before the web (Vercel). A newer web against an older API keeps working through
  the fallback.
- **`mode=fast` stays off.** Enabling it needs a measured comparison on real pairs and sizes and an owner decision.

## 10. Limitations (honest)

- **Live providers not exercised.** Public providers, public RPC, live Privy and production logs were not exercised.
  Every latency figure is LOCAL or MOCKED, and p50/p95 are not available.
- **PostgreSQL:** run on version 16, not CI's 18.6 (one environment-dependent test, §6).
- **Browser provenance:** the browser tier used the environment's pre-installed Chromium headless shell revision 1243.
  The verified bootstrap download host was unreachable.
- **EVM wallet readiness:** Privy's `useWallets().ready` is not added to `canSign`, because live Privy was unavailable
  to confirm its semantics. Recommended for the owner's live verification.
- **Not addressed in this build:**
  - batching paced reads (JSON-RPC batch or Multicall3);
  - automatic observation in the other flow stores (router, liquidity, transfers);
  - per-client telemetry authentication;
  - a developer-API lifecycle field (the versioned public API is unchanged).
- **Specialist reviews are advisory.** CircleCI remains the certification authority.
