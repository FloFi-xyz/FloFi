# BUILD-FLOFI-EXECUTION-PERFORMANCE-001 — End-to-end transaction acceleration and multichain engineering skills

**Status:** ready for owner review. PR: [FloFi-xyz/FloFi#148](https://github.com/FloFi-xyz/FloFi/pull/148), now based on `main` after PRs #146 and #147
were merged (integration in §1a). Nothing is merged, deployed or configured, and no production database, credential or real-money transaction was
touched.

## 1. Baseline

| Item | Value |
| --- | --- |
| Repository | `alrimarleskovar/FloFi` (GitHub also reports `FloFi-xyz/FloFi`) |
| Dependency | PR #146 BUILD-FLOFI-PRIVY-UX-001, **open, not merged** at implementation |
| PR #146 head used | `ea4099eab4aff5339281d0841e98b20c76ddad5f` (newer than the prompt's historical `9dc8d23e`) |
| This branch | `claude/build-flofi-execution-performance-001`, stacked on PR #146; PR #146 and its branch are unchanged |
| Toolchain | Node **24.21.0** (official binary, SHA-256 checked) for the gates, pnpm 11.22.0, Anvil 1.8.3 (publisher digest verified); PostgreSQL 16 loopback at first, then **PostgreSQL 18.6** from CI's exact image digest for the integration (§1a, §6) |

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

## 1a. Integration with `main` (after PRs #146 and #147 merged)

| Item | Value |
| --- | --- |
| `main` at integration | `c9aa047f8cca67c80595a2b56d492577ee2f1130` (PR #146 and PR #147 merged) |
| PR #148 head before | `bb6a434c` (stacked on the pre-merge Privy branch; GitHub reported conflicts and a failed `certification-checks`) |
| Method | `git merge --no-ff origin/main` (merge commit `dbaab3c7`); no rebase, no force-push, published history unchanged; PR retargeted to `main` |
| Diff vs `main` afterwards | only this build's files; nothing from #146/#147 recreated, duplicated or reverted |

**Conflicts and how they were resolved.**
- `accounts/privy-client.tsx`: kept `main`'s `FloFiPrivyProvider` (signer-document gating, `usePathname`, `useSyncExternalStore`, reload), and added
  only this build's content-keyed memo of the Privy settings. The signing gate, `showWalletUIs: true`, signer-origin isolation, CSP, schema-19
  compatibility, account isolation, exact-byte signing and wallet authorization are unchanged.
- `docs/engineering/coverage.json` / `COVERAGE.md`: rebuilt from `main` plus this build's suites, modules and sources; `COVERAGE.md` regenerated.

**The failed `certification-checks` job.** Root cause: the "dedicated" RPC pacing test in `server/router-runtime.test.ts` measured real
wall-clock spacing between concurrent reads, so a loaded CI container could measure less than the asserted interval (a flaky test, not a product
defect). Fix: the test runs on fake timers (`vi.useFakeTimers` + `advanceTimersByTimeAsync`), so the spacing is exact. A later review showed its
shared-pause check could pass vacuously; it now fails a read first, so the reads queued behind it must wait out the shared 500 ms pause (a
mutation to a per-call backoff fails it). No test was skipped or deleted.

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
  - `AUTHORIZATION_PENDING`, `SUBMITTED`, `HASH_KNOWN`, `CONFIRMED_ONCHAIN` and `SETTLEMENT_PENDING` (cross-chain, and Pix's payout);
  - `RECONCILED`, the only status where `completed` is true: the `RECONCILED` verdict, or a flow's settled end state (a composition's
    `COMPLETED`, Pix's `PAYMENT_SETTLED`) only with recorded evidence;
  - `REJECTED`, `REVERTED`, `FAILED`, `INCONCLUSIVE` and `INTERVENTION_REQUIRED`.
  - Once the wallet was asked it is never `NOT_STARTED`: a run that still reads `AUTHORIZED` (as Pix keeps it) follows its latest attempt
    (`SUBMITTING`/`SUBMISSION_RESULT_UNKNOWN` → `INCONCLUSIVE`), and a recorded `*_RESULT_UNKNOWN` error is `INCONCLUSIVE` even without attempts.
    Working phases (`EXECUTING`, `PAUSED`, `PRODUCING`, `BOUND`, `CONSUMING`) follow the latest attempt. A hash is claimed only when recorded.
  - It is added to the MCP execution status view (`lifecycle`, described in `get_execution_status`) and checked against the Dashboard mapping,
    which shares its evidence and unknown-result rules, across evidence and error variants.

### Performance observability (P1)

- **Journey marks** (`domain/journey-metrics.ts`): content-free marks per journey (a random id, the chain reference, the
  provider label, the wallet type and the outcome). They produce all required metrics:
  - `intent_to_first_quote_ms`, `intent_to_best_quote_ms`, `quote_to_review_ready_ms`;
  - `review_to_wallet_open_ms`, `wallet_open_to_user_decision_ms`, `decision_to_submission_ms` (renamed from
    `authorization_to_submission_ms`: the shared logger redacts any key containing `authorization`, so that stage never reached the logs);
  - `submission_to_hash_ms`, `submission_to_confirmation_ms`, `confirmation_to_reconciliation_ms`;
  - `workflow_total_duration_ms`;
  - plus system-only splits: `review_request_to_ready_ms` and `authorize_to_wallet_open_ms`.
- **User time vs system time:** the person's time in the wallet (`userMs`) is separated from system latency
  (`systemMs`). Spans that mix both are reported but never summed as system latency. The server recomputes both from the metrics it
  accepted (the client's figures are ignored) and logs `null`, never 0, for a total with no measured stage.
- **Where it is wired:** the live quote, the EVM swap journey and the Jupiter journey. The browser sends a same-origin
  beacon to `POST /api/flofi/journey` (`server/journey-telemetry.ts`).
- **The endpoint** (reviewed for abuse resistance, privacy and log cost):
  - closed schema, same-origin, a 4 KiB cap (also without `Content-Length`);
  - **requires a signed-in FloFi session**: the sealed, host-bound account cookie is checked cryptographically (no database read). It skips the
    store's revocation check to keep a database read off every beacon, so a revoked session can send rate-bounded, content-free timings until its
    cookie expires; the account is only an in-memory rate key (HMAC under a per-process random key, dropped when its window ends), never logged;
  - bounds per server instance: 60 events per account per 10 minutes, 600 per minute overall; a journey id is logged once (409 on a repeat);
  - a journey id is always a fresh v4 UUID, never the quote correlation id, so a journey line cannot be joined to a quote's server trace;
  - one log line (at most about 0.8 KB) per accepted event, on the existing `createLogger` stream, with no new table or analytics system;
  - each line is labelled `CLIENT_REPORTED` and names its deployment and the network's registry environment (MAINNET/TESTNET);
  - `FLOFI_JOURNEY_TELEMETRY` fails closed: only unset or `on` logs (`off`, `disabled` or a typo drops every event).
- **Discovery timings** (server-measured): each provider's answer time is logged once per discovery on `quote.discovery_window`, with the providers
  still pending when the window closed; the per-route `quote.provider_result` line keeps `main`'s content-free shape.
- **Report** (`scripts/journey-latency-report.mjs`, format v2): nearest-rank p50/p95 per metric and per network, operation, provider, wallet and
  outcome, split by network environment.
  - It requires an `--environment` label, copied verbatim, and excludes (and counts) journey lines written by another deployment.
  - A journey reported twice counts once; a provider answer counts once per discovery, with its timeouts counted beside the percentile.
  - A group with fewer than 20 samples prints `INSUFFICIENT_SAMPLE`; the minimum can be raised, never lowered.
  - The script is linted, and its metric list is drift-tested against `JOURNEY_METRICS`.

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
| USD on estimates | Up to 2.5 s after the quote | Starts right before the first quote read, only after the network gates pass | MOCKED ordering tests (a refused path starts no price observation) |
| Uniswap quoter read failures | Any failure dropped that fee tier (an outage could return a worse tier) | Classified by evidence: an explicit revert drops the tier; an outage, rate limit or lagging node fails the quote closed | MOCKED JSON-RPC classification tests |
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
| 6 | Privy embedded EVM wallet | `flofi-privy-signer` suite (9, including the local-clock Review deadline), wallet suites; browser `auth-wallets` profile passes on the merged head |
| 7 | Privy embedded Solana wallet | `flofi-privy-signer` suite |
| 8 | Authenticated user, no second Google login | Unchanged PR #146 session; chat now checks readiness before Review |
| 9 | External wallet | Unchanged path; journeys tag `external` |
| 10 | Slow provider / timeout | Discovery window tests |
| 11 | Rate-limited provider with another valid one | Discovery 429 test |
| 12 | Expired quote requiring new Review | Existing `QUOTE_EXPIRED_REVIEW_REQUIRED` paths unchanged and passing |
| 13 | Wallet rejection | Signer suite; new swap-store messages |
| 14 | Refresh after submission | Store recovery code with run guards and token-superseded loops; the follow after Execute and after a reload use the same stopping rule. **Gap:** no store-level unit test; covered by the critical and execution-continuity browser profiles where their specs reach it |
| 15 | Lost wallet response after possible submission | Existing UNKNOWN reconciliation unchanged |
| 16 | Double click / concurrent request | Existing locks unchanged; the chat path adds a refusal only |
| 17 | Genuine failure vs inconclusive | Canonical status tests (46 recorded statuses × observation, attention, evidence and unknown-result variants, Dashboard agreement; Pix, lending and composition cases; Pix records through the real projector) |
| 18 | Disconnect → `/login` | Unchanged from PR #146 (not modified) |
| 19 | Chat / MCP / channel continuity | Copilot tool suite (provisional comparisons), channel toolkit (conversational window with a hanging provider), MCP `lifecycle` asserted end to end; the chat's wallet check also guards a continuation (no dedicated unit test for that path) |
| 20 | Multiple users without leakage | Fact cache holds no user data; PostgreSQL tenancy suites pass |

## 6. Gates (final head)

Final code: `6b65a26d` plus the last review follow-ups (a boundary test, the reverted-attempt mapping, two wording fixes and a comment);
later build-record commits change documentation only. Toolchain: Node 24.21.0 (official binary), pnpm
11.22.0, PostgreSQL **18.6** from CI's exact image digest (`postgres:18.6-bookworm@sha256:3725f4e2…`), headless shell revision 1243.

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` (now including `scripts/journey-latency-report.mjs`), `pnpm build` | pass |
| `pnpm schemas:check` | pass (11 exports) |
| `pnpm test` + `agent_guard.py verify-results --stage unit` | **507 files, 6174 tests pass** on the final code, 2 existing conditional skips; **43 required suites** pass (two journey suites newly required) |
| `pnpm test:postgres` (PostgreSQL 18.6) + `verify-results --stage postgres` | **89 files, 575 tests pass** at `6b65a26d`, 3 existing conditional skips; **29 required suites** pass (the version-16 environment failure is gone) |
| `governance_lite.py`, `test_ci_*` (179) and `test_governance_lite` (21), `agent_guard.py check`, `skill_registry.py verify` | pass |
| `skill_registry.py check-upstream --fetch` (first session) | 32 pinned sources UNCHANGED; 12 UNPINNED sites (11 official + the third-party Arbitrum guide) unreachable from this network |
| Browser at `143561ce` | **pass**: critical tier 6/6 (copilot-learning, canvas-corrections, solana-wallet-refusal, supply-provenance, review-execute-recovery-components, solana-transfer-ux), auth-wallets, jupiter-provenance, router-provenance, execution-continuity (34 tests) |
| Browser at `6b65a26d` (after the last UI fixes) | critical tier **6/6 pass**; execution-continuity, universal-bridge, owner-history and auth-wallets were running when this record was written (result on the PR) |
| Remaining extended shards | not run locally; CircleCI runs every profile (browser-1/2) |
| CircleCI / Vercel Preview on the final head | reported on the PR: CircleCI is the certification authority, and a record cannot certify the commit that contains it |

## 7. Specialist review (the existing 19 agents, read-only, at most 3 at once)

The `flofi-*` agent types ran as themselves (Read-only, no shell), three at a time, each given the base, the changed paths, the relevant diff
and its `agent_guard.py domain` report; the main session ran every search and test they asked for. **18 of the 19** reviewed this PR in six
batches; flofi-payments-billing (selected only because `coverage.json` changed) was not run. No reviewer edited, committed or signed anything.

**Integration finding (reported, not changed):** the repository hook `.claude/hooks/flofi_agent_hooks.py` denies `SubagentHandback` to the
flofi-* reviewers (and refuses reads outside the repository or of gitignored files), so each report was taken from the reviewer's final
message, and later batches were given their context in the prompt. The reviewers' restrictions were not relaxed; the owner may want the hook to
allow the handback tool. `agent_guard.py review` records each reviewer's result and the denials.

| Batch | Reviewers | Findings (highest) |
| --- | --- | --- |
| 1 | flofi-security, flofi-wallet-execution, flofi-workflow | 3 low; 5 (low); 5 (medium) |
| 2 | flofi-swap, flofi-bridge, flofi-protocol-integrations | 3 low; 3 low; 8 low |
| 3 | flofi-admin-analytics, flofi-data-privacy, flofi-infrastructure-ci | 10 (medium); 5 (low); 5 (medium) |
| 4 | flofi-mcp, flofi-channels, flofi-chat | 5 (medium); 3 low; 3 (medium) |
| 5 | flofi-transfer-payments, flofi-frontend-ux, flofi-lending | 4 (**high**); 10 (medium); 7 (medium) |
| 6 | flofi-liquidity, flofi-automations, flofi-developers | 3 (medium); 3 (low; none in this PR's code); none |

Verified findings and their resolution (each fixed with a test unless stated):

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | A Pix payment stays AUTHORIZED while its attempt is submitting or its wallet result is unknown; the Dashboard list (no attempts) said "nothing was sent" | The Pix projector publishes the attempt state while AUTHORIZED, as transfers do; projector → lifecycle → Dashboard test |
| Medium | `lifecycle` said NOT_STARTED after a wallet request | Attempt-based classification; `*_RESULT_UNKNOWN` errors are INCONCLUSIVE (shared with the Dashboard) |
| Medium | Pix/composition states mis-mapped (PAYMENT_SETTLED, PAYMENT_PENDING, COMPLETED, working phases) | Mapped as recorded; settled labels complete only with evidence |
| Medium | Lending: a landed-but-unreconciled borrow read FAILED (final); revert after a confirmed supply read FAILED | INTERVENTION_REQUIRED / PARTIALLY_COMPLETED; between steps not final; routine recovery follows the attempt |
| Medium | Journey metric `authorization_to_submission_ms` always `[REDACTED]` by the logger | Renamed; tested through the real logger |
| Medium | `user_ms`/`system_ms` logged 0 when unmeasured; client could set them | Server recomputes; `null` when unmeasured |
| Medium | Provider answer times counted per route; timeouts dropped; 20-sample floor met by duplicates | One sample per provider per discovery; timeouts counted; journeys deduplicated; floor never lowered |
| Medium | Governance test would fail on 2027-01-31; pacing test's shared-pause check vacuous | Dated explicitly; failure ordered first (mutation fails it) |
| Medium | Chat could call a provisional route "cheapest" or slow providers "unavailable" | Tool rule 15, `NOT_COMPARED_IN_TIME`, `ROUTE_COMPARISON_INCOMPLETE`, marker on success |
| Medium | Swap refusal asked for a Simulate the page cannot offer; Dashboard called expired/refused requests "declined" | Copy names what happened; status-specific chips (EN/PT) |
| Medium | Base L1-fee call misnamed in the skill | `getL1FeeUpperBound(uint256)`, selector verified |
| Medium (earlier) | Jupiter recovery could overwrite a newer run; deploy skew | Run guard and token-superseded loops; fallback (as before) |
| Low | Quoter catch dropped a tier on an outage | Classified by evidence (an explicit revert drops the tier; an unanswered read fails the quote) |
| Low | Journey id reused the quote correlation id; off switch failed open; unkeyed rate hash | Fresh UUID; fails closed; HMAC with per-process key, windows purged |
| Low | Discovery compare window could start on a route FloFi cannot execute; late answer test missing | Only a Universal-Router route starts it; stubborn-transport test |
| Low | USD observation started before network gates; EIP-7702 designator could be cached | Started after the gates; never cached |
| Low | Channel window untested; misleading wiring comments; chat continuation skipped the wallet check | Hanging-provider test (mutation fails it); comments fixed; check added |
| Low | Privy deadline in UTC only; provisional note not announced; European Portuguese strings | Local clock with offset; one live region; Brazilian Portuguese |
| Low | Report script unlinted / metric list drift; source URLs with dot segments; MAINNET rows | Linted and drift-tested; refused; MAINNET `EXECUTE` required |
| Low | A reverted Uniswap approval or mint (run still `SIMULATED`) read INCONCLUSIVE forever | A proven revert is REVERTED, or PARTIALLY_COMPLETED after a confirmed step |
| Low | `NOT_EXECUTED` (also a composition leg never signed) was worded "expired" | "Was not executed" (EN/PT); "expired" only for `EXPIRED` |
| Info | The lifecycle must never become a completion or settlement gate | Boundary test: no automation, delegation or workflow-run module reads it |

Not changed here (recorded for the owner): the Dashboard list has no attempts, so an Aave, lending or Uniswap liquidity run whose approval
(or first step) already landed can still read "Not started … nothing was sent" there while MCP is precise. Reported as medium by three
reviewers; the branch predates this PR. A projector change like the Pix fix would misdescribe a run that was re-reviewed after a revert or
decline, so the right fix is a run-summary flag for a landed attempt that both mappings honour; the Automations History label "Owner executed —
reconciling" for runs only simulated or declined is pre-existing too; channel discovery does not apply the
web path's `GRYLOO_UNIVERSAL_ROUTER` gate (pre-existing); `get_approval_status` never lists Pix runs and requires `errorCode === null` for
`reconciled`, which differs from the lifecycle's RECONCILED_WITH_ATTENTION (pre-existing; owner decision); lending/Aave "proven not
submitted" attempts read INCONCLUSIVE until a new attempt (overstates, never understates); the developer API has no `lifecycle` field.

**Intelligence Engine and Capability API.** No new runtime AI or authority. The Copilot's read-only tools (`platform/copilot-tools.ts`) carry the
provisional-comparison facts and rule 15 tells the model how to state them; the skills test asserts the Capability API
(`domain/intelligence/capability-api.ts`) still profiles every network a skill names and that no runtime code reads `skills/`.

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
  - `verify`: provenance, licence, official URL prefixes (a source URL with a `.`/`..` segment, literal or percent-encoded, or an encoded or
    backslash separator is refused, so a prefix check cannot be escaped), guidance digest, negation-aware safety lint, dependencies and
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
    - every capability a skill names exists in `executionCapabilityRegistry` as a MAINNET row with `EXECUTE` (a MOCK or fork row is not
      enough; no execution evidence is claimed);
    - the Capability API still profiles those networks;
    - no runtime source imports or reads `skills/`.
- **Corrections after specialist review:** Base's L1 fee is read with `getL1FeeUpperBound(uint256)` (selector `0xf1c7a58b`, verified with
  keccak), not `getL1Fee(bytes)`, and the catalog Review budget is the execution fee with the L1 bound added at `begin`; QuoterV2 catches its own
  callback revert and returns the amounts (call it with `eth_call` only); an EIP-7702 delegation designator is never a cacheable fact; Aave is
  "registered, deployment-gated"; Across lists its WETH routes; bridge wording names `pendingProviders` and `PARTIAL`. Digests regenerated.
- **Governance test is date-independent:** `test_ci_skill_registry` passes `today` explicitly; it would otherwise have turned a pinned source
  STALE on 2027-01-31 and failed every governance job (checked by running the suite with the clock set to 2028).
- **Used in this build:** the review batches were selected with it, and the specialists read:
  - Jupiter, for the `mode=fast` decision;
  - Uniswap, for the Trading API distinction and the cacheable immutable facts;
  - EVM core and Solana, for the parallelization rules;
  - bridge and Relay, for the discovery window;
  - execution, for the lifecycle and journey rules.

## 9. Release considerations

- **No migration, schema certificate, dependency or credential change.**
- **Optional variables** (`docs/deploy/ENVIRONMENT.md` §5k): `GRYLOO_RPC_READ_PROFILE=dedicated` (opt-in; unset keeps the previous pacing),
  `GRYLOO_DEPLOYMENT_FACT_CACHE=off` (kill switch; unset turns the new cache on) and `FLOFI_JOURNEY_TELEMETRY` (unset turns the new timing log
  on; anything but `on` turns it off). None is required in Production or Preview.
- **Deploy order:** the API (Railway) before the web (Vercel). A newer web against an older API keeps working through
  the fallback.
- **`mode=fast` stays off.** Enabling it needs a measured comparison on real pairs and sizes and an owner decision.

## 10. Limitations (honest)

- **Live providers not exercised.** Public providers, public RPC, live Privy and production logs were not exercised.
  Every latency figure is LOCAL or MOCKED, and p50/p95 are not available.
- **PostgreSQL:** the integration ran on 18.6 from CI's image digest (all suites pass, §6); the first session's version-16 run is superseded.
- **Browser provenance:** the browser tier used the environment's pre-installed Chromium headless shell revision 1243.
  The verified bootstrap download host was unreachable.
- **EVM wallet readiness:** Privy's `useWallets().ready` is not added to `canSign`, because live Privy was unavailable
  to confirm its semantics. Recommended for the owner's live verification.
- **Not addressed in this build:**
  - batching paced reads (JSON-RPC batch or Multicall3);
  - automatic observation in the other flow stores (router, liquidity, transfers);
  - a developer-API lifecycle field (the versioned public API is unchanged; the MCP view has it);
  - the Dashboard list still has no attempts, so a summary that only an attempt can classify reads "Unresolved" there while MCP is precise;
  - channel route discovery does not apply the web path's `GRYLOO_UNIVERSAL_ROUTER` gate or the loopback harness transport (pre-existing on
    `main`; read-only public quotes; recorded for the owner);
  - a legal basis and retention period for the journey timing log stream (owner/counsel decision; ENVIRONMENT.md §5k).
- **Telemetry bounds are per server instance** (in-memory counters), so N instances admit up to N times the stated rates.
- **Specialist reviews are advisory.** CircleCI remains the certification authority.
