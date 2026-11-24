# BUILD-FLOFI-MAINNET-BRIDGE-RECONCILIATION-003

P0 mainnet Relay settlement binding recovery and Live Quote performance. Branch
`fix/mainnet-bridge-reconciliation-003` from `main` `3e5dedcd`. Nothing in this build was merged,
deployed or executed with real funds. Production facts below were read read-only.

## 1. Takeover

The previous Claude/Codex session stopped at its usage limit with ~30 uncommitted files, no commit,
push or PR. This session preserved that work and resumed from its stopping point.

**Inherited (kept):**

- Workstream A: direct registered destination-executor native payout binding; ERC-20
  `RELAY_EVM_TOKEN_V1` order proof; historical token re-proof before evidence; workflow funding
  gates that refuse unproven ERC-20 universal deliveries; recovery UX labels and provider-reported
  explorer links that remain non-authoritative.
- Workstream B: dedicated catalog QUOTE RPC transport with JSON-RPC batching; indicative parallel
  pool/token reads; streaming NDJSON so the token amount paints before optional USD; Railway
  `purpose: 'QUOTE'` path with simulation fallback; client-side USD enrichment; unresolved
  `OUTPUT_REFERENCE` quotes stay unavailable.
- Benchmarks (baseline vs candidate), production HTTP samples, closed-loop incident fixtures, and a
  green disposable PostgreSQL suite (1022 tests) from the prior session.

**Found incomplete at takeover:**

| Finding | Effect | Resolution |
| --- | --- | --- |
| Focused suite had 4 failures mid-edit / under load | Blocking local gate | Re-ran: 213/213 pass |
| `flofi-dependency-evidence.json` in worktree root | `agent_guard check` unmapped | Removed (CI `$RUNNER_TEMP` artifact only) |
| No build ledger / PR | Delivery incomplete | This document; PR after gates |
| Typecheck / `pnpm check` interrupted | Unknown compile state | Re-run in this session |
| Specialist handbacks incomplete | Review ledger incomplete | Re-invoked bridge, security, workflow |

## 2. Workstream A — confirmed root cause

A Base → Ethereum native fill stayed `RECOVERY_REQUIRED` with
`UNIVERSAL_DELIVERY_ORDER_NOT_BOUND` while Relay reported `FILLED`.

Independent read-only observation (public RPC + Alchemy-capable path):

- Source (Base): owner `depositNative` into Relay Depository with the committed order id.
- Destination (Ethereum): a **registered Ethereum settlement executor** (not the order's origin
  solver) sent a **direct** type-2 native transfer to the reviewed recipient with
  `input === orderId`, value ≥ minimum, `gasUsed ≈ 22k`, empty logs, canonical and past safe head.
- Prior FINOPS-002 bound (1) origin-solver direct pays and (2) RelayRouter contract fills from
  registered executors. A registered **destination** executor paying the recipient directly was
  unbound → fail-closed pending, never a false RECONCILED.

Same error class as FINOPS-002 (order not independently bound), different fill shape.

Production status at last read-only Neon inspection (2026-11-24 ~15:17 UTC): phase
`RECOVERY_REQUIRED`, `needs_observation=true`, reconcile task `READY`, no evidence. Provider
`FILLED` is not settlement proof. After this release deploys to API + worker, the existing
reconcile queue should re-observe; if the task is DEAD/attention-stopped, use
`admin-cli reconcile-history` from FINOPS-002 §6. No deposit resubmission. No forced state.

## 3. Workstream A — implementation

- `evm-chain.ts`: bind direct native payout when `to === recipient`, `data === orderId`, and sender
  is the reviewed solver **or** a registered destination executor on a signed type-0..4 tx; keep
  the ≤23k / empty-code direct amount path (no provider status; no balance delta). ERC-20 path
  requires `transfer`/`transferFrom` calldata ending in the order word, matching Transfer log, and
  `UNBOUND_TOKEN` when `requireTokenBinding` fails.
- `service.ts`: pass settlement executors + `requireTokenBinding` on delivery verification; persist
  `orderProof: 'RELAY_EVM_TOKEN_V1'` for bound ERC-20; re-prove legacy final destinations before
  issuing evidence; map `UNBOUND_TOKEN` → `UNIVERSAL_DELIVERY_ORDER_NOT_BOUND`.
- Workflow funding: `deliveredByRecord` / `amountsAvailable` / runner refuse ERC-20 universal
  amounts without `orderProof` so Bridge → Aave cannot spend an unbound delivery.
- Tests: Base→Ethereum direct executor matrix (solver, registered executor, unregistered, wrong
  order/recipient, below minimum).

## 4. Workstream B — confirmed root cause

Railway HTTP samples clustered ~4 s and ~11–12 s for Ethereum/Arbitrum swap previews (HTTP 200).
Closed-loop benchmarks showed many sequential paced `eth_*` reads against public endpoints; Base
additionally hit the 25 req/s item limit when batching too aggressively.

Root cause: Live Quote reused the full execution-oriented sequential RPC path (and waited on
optional USD) instead of a read-only indicative quote path with batching and early token paint.

## 5. Workstream B — implementation and measurements

- `createCatalogQuoteReadRpc`: coalesce independent quote reads into JSON-RPC batches (Base batch
  size 5); fall back to solo on incompatible envelopes; metrics via `measureQuoteRpc`.
- Indicative catalog quote: parallel independent reads; quoter reverts only remove a tier;
  unanswered RPC still fails closed.
- BFF/client: NDJSON stream — token estimate first, USD second; primary amount never waits on USD.
- Backend: `purpose: 'QUOTE'` for catalog swaps; principal-free preview access span; simulation
  fallback when an older API lacks QUOTE.

Local closed-loop before/after (process-warm samples; not CircleCI certification):

| Network | Baseline P50 / P95 (ms) | Candidate P50 / P95 (ms) | Wire envelopes P50 |
| --- | ---:| ---:| ---:|
| ethereum | 4215 / 11435 | 1261 / 3358 | 17 → 5 |
| arbitrum-one | 4259 / 11709 | 1257 / 3507 | 17 → 5 |
| base | 1249 / 11447 | 1754 / 6430 | 5 → 7 (public 25/s pacing) |
| robinhood | 5196 / 12542 | 2771 / 5198 | 21 → 11 |
| solana | 114 / 404 | 112 / 489 | 1 (Jupiter rate limits unchanged) |

Targets not fully met on Base P95 under public endpoint limits; Alchemy/configured RPC remains
preferred in production. No new paid services. Batching reduces public item count / cost per quote
on Ethereum/Arbitrum; Base may still pace.

## 6. Security invariants preserved

- Provider `FILLED` never alone reconciles.
- Balance increases never alone prove settlement.
- No incident tx/wallet/order hardcoded into production logic.
- No deposit resubmission; no forced execution states.
- ERC-20 downstream funding requires `RELAY_EVM_TOKEN_V1`.
- Quote batch transport is read-only allowlisted methods; Review/execution keep the regular path.
- Slippage, recipient, asset and chain checks unchanged in authority.

## 7. Gates and reviews (session ledger)

Prior-session ledger (superseded by §10 for the current revision):

| Gate | Result |
| --- | --- |
| `agent_guard.py check` | PASS |
| Focused unit (service, build-estimate*, workflow-sequence, preview) | 213 passed |
| Incident-class unit (direct executor + I/J) | 8 passed |
| Disposable PostgreSQL (prior session) | 1022 passed |
| Typecheck | PASS (Node 24.21.0) |
| `pnpm check` (typecheck, lint, build, schemas, unit) | PASS — 10093 passed / 2 skipped |
| `governance_lite.py` + unit | PASS |
| Fork suite | Prior failure was `E2E_PORT_OCCUPIED` (environmental); re-run pending |
| Specialist: flofi-workflow (Grok) | 1 high: canvas `DELIVERY_NOT_PROVEN` fail-open — fixed |
| Specialist: flofi-bridge (Grok) | no-findings; added fail-closed cases for type 0x4 / high gas / recipient code / missing type |
| Specialist: flofi-security (Grok) | no-findings |
| Specialist: flofi-swap (Grok) | no-findings; note: add unit coverage for createCatalogQuoteReadRpc / NDJSON stream in a follow-up if CI time allows |
| CircleCI / PR | PR #250 opened; certification of `5a6439f` failed (see §10) |

## 8. CTO authorization required

- Merge and production deploy: owner authorized 2026-11-24 contingent on green CircleCI
  certification of this revision (Vercel + Railway API + Worker ordinary deploy).
- Any production mutation beyond ordinary deploy and worker observation (including
  `reconcile-history --apply`) still needs separate authorization.
- New paid RPC/quote services (none introduced here).

## 9. Bridge → Aave readiness

Code path: universal ERC-20 delivery must carry `orderProof` before
`amountsAvailable` / `deliveredByRecord` fund a later Aave supply. Native deliveries unchanged.
Authoring Live Quotes stay distinct from reconciled amounts; unresolved
`OUTPUT_REFERENCE` quotes are unavailable. End-to-end public mainnet USDC Ethereum → Base → Aave
Supply still requires post-deploy owner wallet testing — not certified by this document alone.

## 10. CI recovery (second takeover, 2026-11-24)

The previous session stopped after opening PR #250 at `5a6439f`. This session resumed on the same
branch and PR, keeping the Workstream A/B implementation. It did not start another build.

### 10.1 Why `5a6439f` failed certification

Every failed job's log was read (CircleCI workflow `0214b60c…`). There were two independent,
deterministic root causes. Neither was transient, so no job was rerun.

| Job | First failing step | Cause |
| --- | --- | --- |
| certification-build, Vercel Preview | `next build` TypeScript phase | TS2352 in `sequence-presentation.test.ts`: a cast `SequenceStep` fixture without the required `ownerReceives`, without `funding[].input`, and with a partial `projection` |
| certification-checks | `pnpm typecheck` | Same TS2352 |
| certification-unit | `agent_guard.py check` (0.45 s) | `coverage.json` was edited but `COVERAGE.md` was not regenerated ("Stale coverage report") |

- Governance and supply-chain passed.
- Lint, schema drift, PostgreSQL, fork, unit and all 8 browser jobs never ran.

**Why the earlier local `pnpm check` passed.** The committed fixture fails `tsc` deterministically
under Node 24.21.0 (reproduced). So the recorded pass cannot have covered the committed file.
Both failures are consistent with the workflow-specialist fix (`sequence-presentation.ts`, its new
test and the `coverage.json` entry) being added after `pnpm check` ran.

**Hidden failure that the early stops masked.** Locally, the PostgreSQL suite failed
`confirm-run.pg.test.ts` (Swap → Bridge → Swap). Its mocked universal bridge reported a Base ERC-20
delivery without `RELAY_EVM_TOKEN_V1`, and the new funding gate correctly refused it. The prior
session's "1022 PostgreSQL passed" predates the gate.

### 10.2 Corrections

**CI fixes**
- `sequence-presentation.test.ts` now builds its steps with the production `workflowSequence`
  constructor (owner-receiving producer → dependent step). There is no cast and no `unknown` or
  `any`, and the type was not made optional.
- `COVERAGE.md` was regenerated.
- `confirm-run.pg.test.ts` is now parametrised:
  - **Proven:** a realistic Relay record carrying `RELAY_EVM_TOKEN_V1`, read by the real universal
    parser, funds the destination swap at 39 USDC.
  - **Unproven:** the same record without the proof gives:
    - the bridge step `RECONCILED` with no counted delivery;
    - the destination swap `BLOCKED`;
    - the run `HALTED` with `WORKFLOW_BINDING_NOTHING_RECEIVED`.

  The gate was not weakened.

**Fixes from specialist review**
- `sequence-restore.ts` (workflow M2 and security MEDIUM): after a reload, a universal step that its
  own record proves completed, but whose ERC-20 delivery is not proven, is restored as completed with
  `received: null`. This includes a pointer an earlier client stored with an amount it no longer
  proves.
  - The dependent step then shows `DELIVERY_NOT_PROVEN`.
  - The executed bridge is never re-offered through "Discard".
  - Only two proven amounts that disagree stay UNVERIFIED.
  - Before the fix, `main` and `5a6439f` re-offered the bridge or withheld it indefinitely.
- `received-amounts.ts` (workflow L2): a universal record whose amount is not proven
  (`received: null`) is recognised by its own format. It no longer falls through to the Router shape,
  which counted `destination.amount` without a verdict or proof. This was pre-existing on `main`.
- NDJSON route (swap L3): the optional USD continuation now has a rejection path and a guarded close,
  so a failed USD read never holds the stream open.
- Client (swap L2): the second NDJSON line is attached only if `isUsdEstimate` accepts its shape.

**Added regression coverage**

Each test below was confirmed to fail against a mutation of the code it guards.

- `catalog-quote-rpc.test.ts` (new, required unit suite), covering `createCatalogQuoteReadRpc`:
  - envelope batching and id mapping;
  - Base 5-item cap;
  - fallback on every incompatible envelope shape, including stray items beside complete answers;
  - pause and resume;
  - per-item rate-limit and history retry; reverts never retried;
  - outage fails closed;
  - method allowlist, also inside a shared envelope;
  - chain binding;
  - abort isolation.
- `app/api/build-estimate/route.test.ts` (new, required unit suite): the token line is sent before
  USD resolves; USD line; no USD; rejection; cancel; refused and plain JSON.
- `state/build-estimate.test.ts` (now mapped):
  - `useLiveQuote` is `ready` with the token amount while USD is pending, then enriched in place;
  - a malformed USD line is dropped;
  - USD is never applied after expiry, including a throttled tab before the timer fires.
- `build-estimate-production.test.ts`:
  - QUOTE is asked first;
  - fallback to `SIMULATION` only on `PREVIEW_QUOTE_NOT_AVAILABLE`, within the remaining budget,
    never after a cancel;
  - the server returns the token estimate before a slow price source answers.
- `workflow-store.test.tsx`: a producer with `received: null` yields `DELIVERY_NOT_PROVEN`, which is
  distinct from `NOTHING_DELIVERED`. This guards where the earlier HIGH was found.
- `sequence-restore.test.ts`: the owner journey **USDC Ethereum → Bridge to Base → Aave Supply**
  after a reload, proven and unproven.
- `universal-router/service.test.ts`, incident replay: a `RECOVERY_REQUIRED` run with a persisted
  FILLED hint and an already-final, registered-executor, type-2 direct payout (`data === orderId`,
  22,280 gas) reconciles in one ordinary observation after a restart. The fresh hint is `unknown`,
  the bundle hash is stable, and no `orderProof` is set on a native delivery.

### 10.3 Local gates on the final tree (Node 24.21.0, pnpm 11.22.0, Anvil 1.8.3)

Local gates are not CircleCI certification.

| Gate | Result |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `schemas:check` | PASS |
| `CI=1 pnpm build` (incl. TypeScript over tests) + `function_traces.py` | PASS (112 functions, largest 48.4 MB) |
| Unit job (`agent_guard check` → `pnpm test` → `verify-results` → self-tests) | see §10.6 |
| PostgreSQL (`pnpm test:postgres` + `verify-results --stage postgres`) | see §10.6 |
| Fork job (`ci-fork.sh`, pinned Anvil, ports 8545–8547 free) | PASS: Anvil 4 passed / 10 owner-gated skips; fork 32 passed / 32 owner-gated skips; F1 five-pass; 3 closed transcripts verified |
| Governance (`governance_lite`, unittest 21 + 336, `git diff --check`) | PASS |
| Browser (critical tier + selected profiles) | see §10.6 |

Skipped cases are not passes. The prior `E2E_PORT_OCCUPIED` came from concurrent worktrees on another
machine. The supported remedy is `FLOFI_E2E_FORK_PORT`, never killing a process.

### 10.4 Specialist reviews (this session, read-only)

| Specialist | Result | Resolution |
| --- | --- | --- |
| flofi-infrastructure-ci | no findings | — |
| flofi-swap | 5 low | Expiry test strengthened; USD shape validated; route rejection path added; envelope-error / pause-expiry / abort / history tests added; QUOTE allowlist checked against every read the QUOTE reader makes (none denied) |
| flofi-workflow | M1, M2, L1–L3 | **M1:** not a defect. Any `fundingIssue` makes `sequenceIssue` non-null, which makes every runtime's simulation source `unavailable` and refuses Continue. **M2:** fixed. **L1:** store test added. **L2:** fixed. **L3:** documented in §10.5 |
| flofi-bridge | no false binding found; M1, M2, L1, L2 | **M2:** measured against real fills, see below. **M1, L1, L2:** follow-ups, all fail-closed |
| flofi-security | MEDIUM, LOW | **MEDIUM:** fixed (legacy stored amount). **LOW:** defence in depth; every Canvas entry point gates on `sequenceIssue`. The single completion call site uses the proof-gated `deliveredByRecord` and waits (`awaitingDelivery`) rather than completing with an unproven amount |

The read hook blocked the reviewers from the diff files. Each reviewed the current source instead.
AI review is advisory.

### 10.5 Evidence, risks and follow-ups

**Incident inputs, read-only on public RPC.**
- Destination tx `0x8037…` is type 0x2, sent from `0x331d…2466`. That address was already in
  `RELAY_SETTLEMENT_EXECUTORS[1]` on `main`; this PR changed only the comment.
- It pays the owner `0x90f5…d303`, with input equal to the order `0x0774…1273` and 0.000979944904752018 ETH.
- It used 22,280 gas, emitted no logs, succeeded, and sits in block 26,485,177, below `safe` and `finalized`.
- The recipient's block-pinned `eth_getCode` (EIP-1898, `requireCanonical`) returns `0x`.
- Still unverified: the persisted `minimumOutput`, `lastHint`, claim records and work-item state.
  This session has no production database access.

**Real Relay ERC-20 fill shapes (bridge M2).** Measured on 14 recent Relay USDC fills, Ethereum → Base,
read from Relay's public requests API and Base public RPC.
- 14/14 carry, as their last calldata word, the order word committed in the owner's origin deposit
  (not the API request id).
- 13/14 are a direct `transferFrom` on USDC from a registered Base executor, which the strict
  `RELAY_EVM_TOKEN_V1` rule binds.
- 1/14 went through an unregistered contract (`0x251e…`, selector `0x6bf15957`). That fill would stay
  `RECOVERY_REQUIRED`: fail-closed, but it would block the dependent Aave step.

**Residual follow-ups (fail-closed, not addressed here).**
- **Legacy token re-proof failure (bridge M1):** the run stays `DESTINATION_OBSERVED` with no attention escalation.
- **Block-pinned `eth_getCode` (bridge L1):** the mock does not prove the call is block-pinned.
- **In-flight Bridge → Supply runs (workflow L3):** runs whose ERC-20 bridge reconciled before this
  deploy halt at the Supply boundary with `WORKFLOW_BINDING_NOTHING_RECEIVED`. Funds stay in the
  owner's wallet.
- **Delegated or batched Relay steps:** `proofRequired` keys on `flow`. Relay never runs in delegated
  or batched steps today.

### 10.6 Live Quote latency (measured this session)

**Method**
- Same process and code, alternating per sample.
- **Baseline:** the regular paced transport plus the full verification path (`purpose: EXECUTION`),
  which is what `main`'s Live Quote used.
- **Candidate:** `purpose: QUOTE` over `createCatalogQuoteReadRpc`.
- Process-warm (deployment facts cached, as the production reader is), 20 samples each after one
  warm-up, one sequential client.
- Default public RPCs, from this session's container through its egress proxy.
- Read-only (`eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getStorageAt`, `eth_call`).
  No wallet, no transaction.
- This measures RPC quote latency only. It is not the browser → Vercel → Railway end-to-end path and
  not production certification.

Sampled 2026-11-24 17:11–17:20 UTC.

| Network | Baseline P50 / P95 (ms) | Candidate P50 / P95 (ms) | Candidate HTTP requests per quote (logical reads) | Errors (40 quotes) |
| --- | ---:| ---:| ---:| ---:|
| Ethereum | 4135 / 4316 | 1134 / 1290 | 5 (17) | 0 |
| Arbitrum One | 4060 / 4262 | 1054 / 1262 | 5 (17) | 0 |
| Base | 4069 / 4260 | 1551 / 1757 | 7 (17; public 5-item envelope cap) | 0 |
| Robinhood | 4064 / 4265 | 1061 / 1254 | 5 (17) | 0 |

The earlier ledger's "17 → 5 wire envelopes" means 17 logical reads carried in 5 HTTP requests.

Compared with the prior session's table (§5):
- **Base:** the earlier median regression (1249 → 1754 ms) was not reproduced. Base improves here
  (4069 → 1551 ms). Base remains the slowest network: the 5-item cap needs 7 requests.
- **P95 tails:** every candidate P95 is under the 2.5 s objective in this environment. The prior
  11–12 s baseline tails, and the 3.4–6.4 s candidate tails, did not appear. Those depend on public
  endpoint rate limiting, which this single sequential client did not trigger.
- **Solana:** not measured. Jupiter's quote path does not use this transport, and the prior session
  saw no change there.

**Remaining deviations**
- No end-to-end (browser → Vercel → Railway) or production latency was measured. Production quotes
  must be sampled after deploy.
- Base keeps its ≈ 0.5 s premium.
- Behaviour under concurrent load and public rate limiting is not measured.

Token-first painting is covered by tests rather than timing:
- the server returns the token estimate before a slow price source answers;
- the route sends the token line before USD resolves;
- `useLiveQuote` is `ready` with the amount while USD is pending.

### 10.7 Classification

| Track | Status |
| --- | --- |
| Code implementation | Complete for this PR's scope; residual follow-ups in §10.5 |
| CircleCI certification | Pending on the pushed revision; see PR #250 |
| Production deployment | Not deployed. The production readiness endpoint reports `main` `3e5dedc` READY. Merge and deploy are human actions and this session did not perform them |
| Incident recovery (`xuni-02c5…d970`) | Not recovered. Expected to reconcile through ordinary worker observation after deploy (replayed in tests). It must be verified read-only after deploy. `reconcile-history --apply` needs separate CTO authorization |
| Real-wallet acceptance (USDC Ethereum → Base → Aave V3 Supply) | Not performed. Needs the owner's wallet and explicit signing. Automated and fixture evidence is not funded mainnet acceptance |

