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
| CircleCI / PR | Not yet |

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
