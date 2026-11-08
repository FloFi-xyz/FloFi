# P0 — Full mainnet catalog reliability and performance

Branch `claude/dazzling-babbage-mt5lik`, base `main` at `0a102dc`. Date: 2026-11-08. Scope: the six production incidents (P0-A…F) and a
catalog-wide coherence audit. Every number below is either measured (source named) or marked as not measured.

**Status in one paragraph.** The six incidents have confirmed root causes and code fixes with regression tests. The catalog is now
coherent between the public tool contract, discovery and the runtimes (a new parity test fails on any drift). No capability is
`LIVE_CERTIFIED` by this build: this session signed nothing and verified no transaction on chain. Production holds reconciled
owner-signed runs with archived evidence for six flows (see §F). Those are leads for the owner to verify, not certification by this PR.
Two items need owner action outside the code: the Vercel `FLOFI_WORKFLOW_RUNS` gate (P0-F) and dedicated RPC endpoints on Railway (P0-B).

## B. Root causes (confirmed)

| Incident | Confirmed cause | Evidence |
|---|---|---|
| **P0-A** Arbitrum quote 39–48 s, `CLOUD_API_UNAVAILABLE` | Each flow has **one** paced read transport per API process (`backend/app.ts` `depsFor`, base line 73), and the public profile serialises reads 250 ms apart (`public-testnet-rpc.ts` base line 108). The Editor's superseded estimates were cancelled in the browser, but the cancellation never reached Vercel → Railway. Their previews kept running on that one queue, and the live quote waited behind them. Each preview could also hold the queue through up to 31.5 s of retry backoff (6 retries, 500 ms·2ⁿ). Railway's preview deadline (80 s) was longer than the BFF's 30 s, so Railway worked for nobody. | Railway `flofi-api`, 2026-11-07: five `arbitrum-swap` previews started between 23:48:18 and 23:48:30. They finished in 39 262 / 42 469 / 47 147 / 48 037 / 40 583 ms. A lone warm preview takes 3.0–4.1 s and a cold one ~11 s (same logs, Nov 1–5). Raw export: `/tmp/claude-0/evidence/railway-arbitrum-swap.json` (session artefact). |
| **P0-B** RPC pacing | Same mechanism. The API reads the public endpoint whenever `GRYLOO_<NETWORK>_RPC_URL` is unset **on Railway**. The Vercel value has no effect on quotes, because the web tier forwards them (`API_BASE_URL`). `GRYLOO_RPC_READ_PROFILE` is unset on Vercel, and nothing in this session showed it set on Railway, so even configured endpoints stay one-at-a-time. Aave reads have their own serial queue with a fixed 150 ms delay per read, even on operator endpoints (`supply-rpc.ts`). | Vercel project env names (no values read): the five `GRYLOO_*_RPC_URL` are present in Production; `GRYLOO_RPC_READ_PROFILE` is absent. Railway: per the owner's check, `GRYLOO_ARBITRUM_RPC_URL` is absent on `flofi-api`. This session did not list Railway variables, because that API can return plaintext values. |
| **P0-C** "cannot be combined" when editing 0.0012 WETH | `canvasAmountCommand` fell through to the legacy `SET_SWAP_AMOUNT` for every amount-only edit (base `canvas-action-setup.ts:191`). That command only understands the Base reference pair, so `editor.ts` rejected every catalog or Solana swap with `INVALID_SWAP_NODE`. `canvasAmountMessage` (base line 226) turned that, and ~40 other codes, into the composition message. The draft stayed in `amountInputs`, which blocks generation, so Simulate became unavailable. | Reproduced with the Canvas's own reducer and context: Arbitrum WETH→USDC, Arbitrum USDC→WETH, Ethereum, Robinhood Chain and Solana all failed; Base USDC→WETH (the reference pair) worked. Regression: `domain/catalog-amount-edit.test.ts`. |
| **P0-D** MCP refused an Ethereum swap | The tool schemas did include `ethereum`. `get_supported_networks` returns `name: "Ethereum"` and `chainId: "eip155:1"`, but the schema accepted only the id, with an opaque error. Discovery also omitted the 8 Solana⇄EVM bridge directions that compose accepts. And compose explained a Universal Router bridge as "Base → Optimism USDC bridge": `bridgeDetails` excludes only `flofi.router`, not `flofi.router.universal` (base `bridge-authoring.ts:18`, `proposal.ts:104`, `commands.ts`). It explained a 1 USDC mainnet transfer as "Self-transfer test ETH" (base `proposal.ts:122`). | Live production MCP, 2026-11-08: `network:"ethereum"` → ok. `network:"Ethereum"` → `strategy.network: /strategy/network const, /strategy/network anyOf`. `get_capabilities(bridge, solana)` → `[]`, while a Solana→Base simulate returned a live Relay route. The compose output for that bridge read "Base → Optimism". |
| **P0-E** `MCP_SIMULATION_BUSY` | `platform/preview.ts` (base lines 22, 45): **2** slots per web instance, shared by MCP, the Developer API and channels across all flows, with immediate refusal and no queue. Three concurrent simulations on one Vercel instance → the third is refused before reaching Railway. | Code. The reported production observation (Aave alone in 5.7 s) is consistent with this. |
| **P0-F** workflow runs | Every web gate (Editor, Chat, MCP, `/approve`, Developer API, automations) reads the **web tier's own** `FLOFI_WORKFLOW_RUNS`. None asks the worker. With it unset on Vercel, every multi-step workflow is refused (`WORKFLOW_RUNS_NOT_ENABLED` / `EDITOR_RUNS_NOT_ENABLED`). User-funded groups are reachable only through workflow runs, so `FLOFI_USER_FUNDED_EXECUTION=enabled` on Vercel has no effect today. | Vercel Production env names: `FLOFI_WORKFLOW_RUNS` absent (`hiddenProductionEnvCount: 0`, no pagination), `FLOFI_USER_FUNDED_EXECUTION` present. Gates: `workflow-runs/service.ts:37`, `platform/approvals.ts:124`, `mcp/execution.ts:204`, `editor/approval.ts:53`, `server/workflow-run-surface.ts:33`. Team-level shared env vars were not listable with the tools available here. |
| Observability | `withSpan` logged `outcome: ok` for every resolved result, including `{ ok: false, code }` refusals (base `telemetry.ts:84`). All 416 `flow.preview` lines of Nov 1–8 say `ok`, so refusals were invisible in latency and success metrics. | Railway export above. |

## C. Fixes (code)

**Quote and preview path (P0-A/B), systemic, every flow and network:**
- Cancellation reaches the RPC queue. The browser's abort flows through the route (`request.signal`), `readBuildEstimate` → `cloudPreview` → `previewCloudFlow` to Railway. The API HTTP boundary now exposes `request.signal`, aborted on client disconnect (`cloud-runtime/src/http.ts`). `previewFlow` abandons a computation once every caller has gone. `untilAborted` passes that signal with each read (`RpcContext`). `pacedReadRpc`, the dedicated-profile variant, the node client, chain binding, the bridge failover client and the Aave client then **drop queued reads whose caller is gone** (`RPC_READ_ABANDONED`) and stop retry backoff early. They cancel the in-flight fetch too. Reads still waited for are untouched.
- Identical concurrent previews (same flow, purpose and arguments) share **one** computation on the API (`backend/app.ts` `previewFlow`). The computation runs at most to the process limit (80 s). Each caller gets its own copy and stops waiting at its own deadline, and the computation is abandoned as soon as no caller waits, whatever the reason. A result that cannot be copied is never shared by reference. Nothing is persisted by a preview, so sharing changes no authority.
- Coordinated deadlines. The BFF sends `x-flofi-deadline-ms` (its attempt timeout minus 1.5 s). The API stops at min(that, 80 s) and answers a classified `CLOUD_PREVIEW_TIMEOUT` while the BFF still waits. The BFF's own timeout now also cancels the API call. Chain of waits: browser 45 s ≥ route 45 s > BFF 30 s > API 28.5 s.
- Browser: one in-flight request per exact snapshot (`state/build-estimate.ts` `sharedEstimate`). A card that finished its debounce reuses an answer that arrived meanwhile, still bound to its own expiry. Different amounts, nodes, owners or chains never share.
- Aave reads honour the dedicated read profile on an operator endpoint (25 ms instead of 150 ms before each read).
- Unchanged on purpose: quotes are never cached beyond in-flight sharing and the browser's existing expiry-bound reuse. Stale quotes never authorise (Simulate and Review re-quote). The immutable deployment-fact cache (10 min) keeps its safety rules. No RPC endpoint is declared dedicated in code.

**Editor (P0-C):** an amount-only edit of a catalog or Solana action is applied through its own crypto input (`SET_CRYPTO_ACTION`: same pair, network and slippage, new amount, same node). It goes through the same history guard, new revision and stale Simulation/Review as before. A field error (e.g. more decimals than the asset has) is named rather than reduced to `INVALID_COMMAND`. `canvasAmountMessage` keeps "cannot be combined" for real composition conflicts only. Specific codes get specific messages. Any other code says the change was not applied and shows the reference. Base reference swaps, Send, Aave and bridges keep their existing commands. Chat edits were checked and already use `SET_CRYPTO_ACTION` for catalog swaps.

**MCP and catalog (P0-D):**
- `src/mcp/network-aliases.ts`: before validation, a network field is read through FloFi's network registry: id, name, registry alias or CAIP-2, case-insensitive. This applies to the tool filter, a strategy, every `steps[]` entry and a planning goal. Only networks of the tool's scope are recognised: nothing is guessed (`eth` and `mainnet` stay refused) and no test network crosses scope. The canonical id is what is composed, so the IR and hash are identical. A refused network now lists the accepted ids.
- The 8 Universal Router Solana⇄EVM directions are catalog rows: discovery, capabilities, Chat and channel parity, and both committed matrices. They are classified `IMPLEMENTED_UNCERTIFIED` by the existing generator. Route availability is still answered at Simulate.
- `engine/catalog-schema-parity.test.ts`: per action, the public schema's networks equal discovery's, and every accepted bridge pair is a row.
- Compose explanations and summaries now describe a universal bridge by its real route and symbols, and an EVM transfer by its real asset and recipient. The visual model shows token symbols instead of `address@decimals`.

**Simulation capacity (P0-E):** default 4 slots per instance (`FLOFI_SIMULATION_CONCURRENCY`, 1–16). A request that finds them full waits in a FIFO (≤ `FLOFI_SIMULATION_WAIT_MS`, default 5 s, ≤ 8 waiting) and gets `SIMULATION_BUSY` only if no slot frees. The per-account MCP budget is consulted when a slot is taken at once, or **before** queueing, so a principal whose budget is spent never occupies a waiting seat. A queued request that then times out with BUSY has spent one unit. A request whose MCP call ends while it waits (`ctx.budget.signal`) leaves the queue, spends nothing more, and a multi-step preview starts no further step. Identical previews are coalesced on the API (above). **Intentional change to an abuse control, for owner review:** the cap rises from 2 to 4 and a short queue replaces instant refusal. The hourly per-account budget, the per-conversation channel budget and the Developer API rate limits are unchanged.

**Workflow gates (P0-F):** `/api/flofi/readiness` gains `workflows` (`runs`, `userFunded` — reporting `INEFFECTIVE_WORKFLOW_RUNS_DISABLED` for today's production combination — `editorRuns` and the simulation admission). The env reference documents which service reads which gate. Enabling it is an owner action (§E).

**Observability:** a resolved `{ ok: false, code }` (or an HTTP `{ status, body: { ok: false } }`) is logged `outcome: refused` with `result_code`. Every log line carries `deployment` (the platform commit, 12 chars). Previews log `purpose`, `deadline_ms`, `flow.preview_coalesced` and `flow.preview_abandoned`. The quote route logs `duration_ms` and `outcome` (`ok`/`refused`/`cancelled`). The correlation id already travels browser → route → API → provider; the API `traceparent` is derived from it. Nothing new logs an address, amount, payload or credential, and the redaction rules are unchanged.

**Tests added or updated** (including the review fixes) (all loopback/MOCKED; none is evidence of production availability): `backend/preview.test.ts` (coalescing, abandonment, deadline header), `backend/preview-contention.test.ts` (incident shape, before/after), `public-testnet-rpc.test.ts` (dropped queued reads, backoff ends, in-flight fetch cancelled), `cloud-runtime/test/http-disconnect.test.ts`, `cloud-runtime/test/evidence-telemetry.test.ts` (refused outcome), `state/build-estimate.test.ts` (one request per snapshot), `build-estimate-production.test.ts` (browser signal reaches the preview), `cloud-api-client.test.ts` (deadline header), `domain/catalog-amount-edit.test.ts` (P0-C on six networks plus messages), `mcp/mainnet-only.test.ts` (aliases, scope, truthful explanations), `engine/catalog-schema-parity.test.ts`, `platform/preview.test.ts` and `mcp/simulation.test.ts` (admission; the existing cap tests pin their original 2-slot, no-wait settings), `server/readiness.test.ts`, and both parity tests (8 Solana bridge commands).

**Specialist review (read-only flofi-workflow, flofi-security, flofi-mcp) and what changed because of it.**
- Fixed: a preview whose transport could not be built (e.g. an `http://` RPC URL) would have left an unhandled promise rejection and crashed the API process. It is now a classified refusal for every caller (test added).
- Fixed: callers that join a shared preview no longer inherit the first caller's deadline (test added). A computation is abandoned as soon as no caller waits, and an abandoned entry is removed at once.
- Fixed: cancelled MCP waiters leave the simulation queue. Exhausted budgets cannot occupy waiting seats.
- Fixed: the MCP network hint lists only the networks valid for the refused field's action, once per field.
- Fixed: a Canvas amount-only edit is refused (`ACTION_EDIT_CHANGES_SETTINGS`) if rebuilding the action would change anything but the amount (network, adapters, protocols, slippage, pair or range).
- Not changed, noted: the Developer API still requires canonical network ids (aliases are an MCP convenience). Logs of a shared preview carry the first caller's trace id. A response timestamp can reveal that an identical preview is in flight (needs the exact arguments; low impact).

## D. Performance

| Measurement | Before | After | Source |
|---|---|---|---|
| Arbitrum swap preview, production (Railway `flow.preview`, n=111) | p50 4.1 s, p95 11.8 s, **p99 47.1 s**, max 48.0 s | not deployed: no production measurement yet | Railway logs 2026-11-01…08 |
| Base swap preview, production (n=301) | p50 3.8 s, p95 11.3 s, p99 11.5 s, max 22.6 s | not deployed | same |
| Live quote behind 4 superseded quotes on one paced queue (loopback, 20 ms reads, 10 ms spacing, warm) | 617 ms (4.3× the 144 ms alone) | **150 ms** (alone: 139 ms) | `backend/preview-contention.test.ts`, local run |
| Node reads after the lone quote (4 superseded + the live one; 6 reads per quote) | 30 | **7** (the live 6 + 1 already started) | same; asserted deterministically in the test |
| Local field edit | no RPC (unchanged) | no RPC | `useLiveQuote` debounce 200 ms, then one request per snapshot |

The incident's 39–48 s came from queueing behind abandoned work, which this build removes. The remaining floor is the per-quote cost on a public
endpoint: ~16 reads warm and ~50 cold (first quote after 10 minutes idle: pinned-code and pool facts are re-verified), one at a time 250 ms
apart → ~3–4 s warm and ~11 s cold, as measured. **Bringing the warm p95 well under 10 s and the cold quote down needs a dedicated endpoint on
Railway with `GRYLOO_RPC_READ_PROFILE=dedicated` (§E)**: up to 6 reads in flight, 25 ms apart, so the four fee tiers are read in parallel. Not
measured here: this sandbox has no egress to mainnet RPC (proxy 403), and the endpoints' capacity is the owner's to confirm.


## E. Configuration (names only; no value was read or is shown)

| Variable | Service | State | Action |
|---|---|---|---|
| `FLOFI_USER_FUNDED_EXECUTION`, `FLOFI_USER_FUNDED_CHAINS`, `FLOFI_USER_FUNDED_RPC_{1,8453,42161,4663}` | Vercel Production | **Already configured** | — |
| `GRYLOO_{ARBITRUM,BASE,ETHEREUM,ROBINHOOD,SOLANA}_RPC_URL` | Vercel Production | **Already configured** (sensitive) | They do not affect quotes or simulations, which run on the API. |
| `API_BASE_URL`, `DATABASE_URL`, `FLOFI_DELEGATION*` | Vercel Production | Already configured | — |
| `FLOFI_WORKFLOW_RUNS=enabled` | Vercel Production | **Missing** | **Owner action.** Without it every multi-step workflow is refused on the web tier, and user-funded groups are ineffective. Scope it to Production only (Preview shares the production database). After setting it, `/api/flofi/readiness` should report `workflows.runs: ENABLED` and `userFunded: ENABLED`. |
| `FLOFI_WORKFLOW_RUNS=enabled` | Railway `flofi-worker` | Already configured (per the owner's check) | — |
| `GRYLOO_ARBITRUM_RPC_URL` (and the BASE, ETHEREUM, ROBINHOOD and SOLANA ones) | Railway `flofi-api` and `flofi-worker` | **Missing for Arbitrum** (per the owner's check). The others were not verified here. | **Owner action.** Set keyed provider endpoints on the API and worker. Without them the API reads public endpoints. |
| `GRYLOO_RPC_READ_PROFILE=dedicated` | Railway `flofi-api` and `flofi-worker` | Not set on Vercel. Not verified on Railway. | **Owner action, only after** the endpoints above are confirmed to be keyed providers with capacity for parallel reads. Never for a public endpoint. |
| `FLOFI_SIMULATION_CONCURRENCY`, `FLOFI_SIMULATION_WAIT_MS` | Vercel | **Optional** (new; defaults 4 and 5000) | None required. |
| `GRYLOO_DEPLOYMENT_FACT_CACHE` | all | Optional (default on) | — |
| Team-level shared env vars on Vercel | Vercel | **Not verified** (not listable with the tools available here) | Owner: confirm that none overrides the variables above. |

No incorrect value was found among the variables inspected. Values were never read.

## A. Audit matrix

Generated from the committed capability matrix (`docs/builds/BUILD-FLOFI-MAINNET-PRODUCT-001-CAPABILITY-MATRIX.json`, produced by
`engine/mainnet-product-matrix.ts` from the code registries), annotated with this session's evidence. It has 54 rows plus the per-step sequence rows:
50 `IMPLEMENTED_UNCERTIFIED`, 4 `NOT_IMPLEMENTED` (remove liquidity on the four EVM networks), 0 `LIVE_CERTIFIED`. "Code status" is the
generator's classification. A production record is listed per **flow**, not per route.

| Row | Action | Network → destination | Flow (provider) | Channels with a creation/approval path | Code status | Reconciled PUBLIC_MAINNET runs of this row's flow (any route of that flow; archived evidence, not re-verified on chain here) | Evidence gathered in this session | Preview latency, Railway 2026-11-01…08 |
|---|---|---|---|---|---|---|---|---|
| `bridge-base-arbitrum-one` | bridge | base → arbitrum-one | `crosschain-router` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-router` | — | 6.9 s (n=1) |
| `swap-base` | swap | base | `base-swap` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 2 run(s) of `base-swap` | — | p50 3.8 s / p95 11.3 s / p99 11.5 s (n=301) |
| `swap-solana` | swap | solana | `jupiter-swap` (jupiter.swap-v2) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 2 run(s) of `jupiter-swap` | — | 0.6 s (n=1, QUOTE purpose) |
| `transfer-solana` | transfer | solana | `solana-transfer` (solana.spl-transfer) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `add-liquidity-solana` | add_liquidity | solana | `orca-liquidity-mainnet` (orca.whirlpools-mainnet-liquidity) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-base-robinhood` | bridge | base → robinhood | `crosschain-router-base-to-robinhood` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-robinhood-base` | bridge | robinhood → base | `crosschain-router-robinhood-to-base` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-arbitrum-robinhood` | bridge | arbitrum-one → robinhood | `crosschain-router-arbitrum-to-robinhood` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-robinhood-arbitrum` | bridge | robinhood → arbitrum-one | `crosschain-router-robinhood-to-arbitrum` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `swap-robinhood` | swap | robinhood | `robinhood-swap` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `add-liquidity-robinhood` | add_liquidity | robinhood | `robinhood-liquidity` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `transfer-robinhood` | transfer | robinhood | `robinhood-mainnet-transfer` (evm.token-transfer) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-arbitrum-base` | bridge | arbitrum-one → base | `crosschain-router-arbitrum-to-base` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-router-arbitrum-to-base` | — | — |
| `add-liquidity-base` | add_liquidity | base | `base-liquidity` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `transfer-base` | transfer | base | `base-mainnet-transfer` (evm.token-transfer) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `supply-base` | supply | base | `base-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | 4.9 s (n=1) |
| `borrow-base` | borrow | base | `base-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `repay-base` | repay | base | `base-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `withdraw-base` | withdraw | base | `base-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `supply-arbitrum` | supply | arbitrum-one | `arbitrum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `borrow-arbitrum` | borrow | arbitrum-one | `arbitrum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `repay-arbitrum` | repay | arbitrum-one | `arbitrum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `withdraw-arbitrum` | withdraw | arbitrum-one | `arbitrum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `swap-arbitrum` | swap | arbitrum-one | `arbitrum-swap` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 4 run(s) of `arbitrum-swap` | Live quote via MCP simulate 2026-11-08 00:28Z: 0.0012 WETH → 2.682908 USDC (min 2.656078, 0.01% pool, block 522228672) | p50 4.1 s / p95 11.8 s / p99 47.1 s (n=111) |
| `transfer-arbitrum` | transfer | arbitrum-one | `arbitrum-mainnet-transfer` (evm.token-transfer) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `add-liquidity-arbitrum` | add_liquidity | arbitrum-one | `arbitrum-liquidity` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `supply-ethereum` | supply | ethereum | `ethereum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `borrow-ethereum` | borrow | ethereum | `ethereum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `repay-ethereum` | repay | ethereum | `ethereum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `withdraw-ethereum` | withdraw | ethereum | `ethereum-aave` (aave-v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `swap-ethereum` | swap | ethereum | `ethereum-swap` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | Live compose OK (`ethereum`); `Ethereum` refused before this fix | — |
| `transfer-ethereum` | transfer | ethereum | `ethereum-mainnet-transfer` (evm.token-transfer) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `add-liquidity-ethereum` | add_liquidity | ethereum | `ethereum-liquidity` (uniswap.v3) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-ethereum-base` | bridge | ethereum → base | `crosschain-router-ethereum-to-base` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-base-ethereum` | bridge | base → ethereum | `crosschain-router-base-to-ethereum` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-ethereum-arbitrum` | bridge | ethereum → arbitrum-one | `crosschain-router-ethereum-to-arbitrum` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-arbitrum-ethereum` | bridge | arbitrum-one → ethereum | `crosschain-router-arbitrum-to-ethereum` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-ethereum-robinhood` | bridge | ethereum → robinhood | `crosschain-router-ethereum-to-robinhood` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-robinhood-ethereum` | bridge | robinhood → ethereum | `crosschain-router-robinhood-to-ethereum` (flofi.router) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-solana-base` | bridge | solana → base | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | Live route via MCP simulate 2026-11-08 00:32Z: Relay, 5 USDC → 4.977663 (min 4.927887), Solana simulateTransaction slot 466714797 | — |
| `bridge-base-solana` | bridge | base → solana | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `bridge-solana-arbitrum-one` | bridge | solana → arbitrum-one | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `bridge-arbitrum-one-solana` | bridge | arbitrum-one → solana | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `bridge-solana-ethereum` | bridge | solana → ethereum | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `bridge-ethereum-solana` | bridge | ethereum → solana | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `bridge-solana-robinhood` | bridge | solana → robinhood | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `bridge-robinhood-solana` | bridge | robinhood → solana | `crosschain-universal` (flofi.router.universal) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `remove-liquidity-solana` | remove_liquidity | solana | `orca-liquidity-mainnet` (orca.whirlpools-mainnet-liquidity) | Editor | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `remove-liquidity-base` | remove_liquidity | base | `None` (uniswap.v3) | — | NOT_IMPLEMENTED | — | — | — |
| `remove-liquidity-arbitrum-one` | remove_liquidity | arbitrum-one | `None` (uniswap.v3) | — | NOT_IMPLEMENTED | — | — | — |
| `remove-liquidity-ethereum` | remove_liquidity | ethereum | `None` (uniswap.v3) | — | NOT_IMPLEMENTED | — | — | — |
| `remove-liquidity-robinhood` | remove_liquidity | robinhood | `None` (uniswap.v3) | — | NOT_IMPLEMENTED | — | — | — |
| `sequence-user-funded-groups` | sequence_user_funded | ethereum, base, arbitrum-one (EIP-5792 batches: USDC⇄WETH Uniswap v3, Aave V3 supply/borrow, transfers); robinhood (transfers); solana (sign-all: transfers, Jupiter swaps); any other step through its own flow | `workflow-run` (eip-5792, erc-4337 v0.7 (owner account, no paymaster), wallet-standard solana:signTransaction) | MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `bridge-evm-solana` | bridge | any EVM network → solana | `crosschain-universal` (relay-depository) | Editor Chat MCP /approve Telegram | IMPLEMENTED_UNCERTIFIED | 1 run(s) of `crosschain-universal` | — | — |
| `sequence-confirm-each-step` | sequence | any (per step) | `workflow-run` (per step) | MCP /approve Telegram DevAPI | IMPLEMENTED_UNCERTIFIED | — | — | — |
| `sequence-bound-amounts-confirm-mode` | sequence_bound_amounts | any (per step) | `workflow-run` (per step) | MCP /approve Telegram DevAPI | IMPLEMENTED_UNCERTIFIED | — | — | — |

**Inventory beyond the advertised rows.**
- *Universal bridges, EVM ⇄ Solana*: now 8 catalog rows. Compose and Chat produce byte-identical IR. A live route was observed for Solana → Base (Relay); LI.FI and Mayan are reported `NOT_EXECUTABLE` by the router itself, and Across executes only on the certified Router.
- *Remove liquidity*: `NOT_IMPLEMENTED` on Base, Arbitrum One, Ethereum and Robinhood Chain (the generator's status). It is not offered as available.
- *Workflow sequences, amount bindings, user-funded groups*: implemented. The web tier refuses them in production today because of `FLOFI_WORKFLOW_RUNS` (§E). Bindings resolve from reconciled receipts (confirm-each-step) or signed guaranteed minimums (inside one user-funded group), as `get_capabilities` states.
- *Automations / DCA, delegated execution*: production `get_capabilities` reports delegated execution retired (`EXECUTOR_FUNDED_GAS_RETIRED`). Automations were not exercised in this session.
- *Stock Tokens, Token-2022*: in the contract (Robinhood catalog symbols; `tokenProgram: token-2022` for Solana SPL transfers). Not exercised live in this session.
- *Channels*: per row above. WhatsApp is `POLICY_BLOCKED` everywhere, and the Developer API has no execution path on any mainnet row (`developerApi: false`).

**Recovery attention.** Production has 2 runs in `SUBMISSION_RESULT_UNKNOWN` since 2026-11-01 (`crosschain-router-arbitrum-to-base` and
`crosschain-universal`) and 6 `PREPARED` router runs from 2026-10-28/29 (aggregate counts only). The owner should check them in the run history
and recovery tools. Nothing was changed.

## F. Certification

| Gate | Result |
|---|---|
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | **pass** locally on Node 24.21.0 / pnpm 11.22.0: 569 test files, 6 873 tests passed, 2 skipped (pre-existing conditional skips) |
| `python3 scripts/governance_lite.py` | pass |
| `python3 scripts/agent_guard.py check` | pass (new `src/mcp/network-aliases.ts` mapped in `coverage.json`; `COVERAGE.md` regenerated) |
| PostgreSQL suites (`*.pg.test.ts`) | **not run**: no PostgreSQL in this sandbox. CircleCI runs them. |
| Browser (Playwright, loopback, pinned headless shell 1243) | **pass**: `playwright.arbitrum-authoring.config.ts` 24/24 (including Canvas Enter-to-apply for Supply/Borrow/Repay/Withdraw) and `playwright.canvas-workflow-ux.config.ts` 21/21 (including "Arbitrum One Swap: one coalesced request, latest amount wins"). The other browser profiles were not run here; CircleCI's browser profiles remain the authority. |
| Specialist review (`agent_guard.py review`) | flofi-workflow, flofi-security and flofi-mcp reviewed the uncommitted tree, and their findings were fixed (§C). flofi-swap, flofi-bridge and flofi-frontend-ux reviewed commit `e9e7ff5`; see the PR. The other 13 domains the guard selects (by dependency) were not invoked. The guard reports them as unreviewed. |
| Read-only mainnet checks | Done through the production MCP only, since the sandbox has no RPC egress: Arbitrum WETH→USDC live quote, Ethereum compose, Solana → Base live route (§A). |
| Signed mainnet execution | **None** by this session. No row is promoted to `LIVE_CERTIFIED`. The six flows with reconciled runs and archived evidence (arbitrum-swap 4, base-swap 2, jupiter-swap 2, crosschain-router 1, crosschain-router-arbitrum-to-base 1, crosschain-universal 1) can be verified by the owner with `get_evidence` and an explorer. A row should be upgraded only for the exact route that evidence proves. |

## G. Release (after owner approval only)

1. Review and merge the PR (owner). No migration, no schema change and no new dependency.
2. Deploy **Railway `flofi-api` first**, then `flofi-worker`, then Vercel. An older API ignores `x-flofi-deadline-ms` and the client disconnect (it behaves as before). A newer API with an older web tier also behaves as before.
3. Owner configuration (§E): `FLOFI_WORKFLOW_RUNS=enabled` on Vercel Production. Keyed RPC endpoints on Railway, then `GRYLOO_RPC_READ_PROFILE=dedicated` there.
4. Verify after deploy: `/api/flofi/readiness` → `workflows`. Railway logs: `flow.preview` with `outcome`, `result_code`, `deployment`, and `flow.preview_coalesced` / `flow.preview_abandoned` during typing. Re-measure arbitrum-swap and base-swap p95 from `flow.preview` over a day.
