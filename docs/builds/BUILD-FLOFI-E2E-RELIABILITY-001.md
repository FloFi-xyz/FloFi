# BUILD-FLOFI-E2E-RELIABILITY-001 — End-to-end execution reliability (swap continuation, transaction truth, MCP timeouts, #149)

**Status:** ready for owner review. Branch `claude/festive-keller-om54li`, based on `main` at `3a2f5a6` (PR #150 `3769eff` and PR #151 merged).
Nothing is merged, deployed or configured. Production was only **read** (Railway logs, Vercel logs, and two canonical run records in Neon
through read-only `SELECT`s that extracted quote and attempt state only, no wallet data). No transaction was signed or submitted.

Build 2 (BUILD-FLOFI-CHAT-EDITOR-UX-001, Dashboard | Chat | Editor) is **not** part of this PR: it starts from `main` after the owner merges this one.

## 1. The 2026-11-01 Base swap failure — reproduced, root cause proven

User request: “I want to change 1 USDC to ETH on Base” (MetaMask, Uniswap v3, 100 bps). Evidence levels: **PROD-RECORD** = the canonical
durable run records (Neon, read-only); **PROD-LOG** = Railway API logs; **CODE** = reproduced deterministically in tests.

| Time (UTC) | API call (Railway) | Canonical record |
| --- | --- | --- |
| 23:09:16 | `base-swap prepare` (run `bas-08aa…`) | quote at block 53392602: best tier **0.30%**, expected 441563838510788 wei, minimum 437148200125680 |
| 23:09:37 | `review` | Review bound to that quote |
| 23:09:42 | `begin` → `status` | fresh quote at block 53392615 (26 s later, **not expired**): reviewed tier −0.014 %, best tier now **0.01 %**; Review **cleared**, fresh quote saved (`QUOTE_CHANGED_REVIEW_REQUIRED`) |
| 23:09:52 / 23:09:56 | `prepare` (run `bas-76e5…`), `review` | quote at block 53392620 (0.01 %), minimum 437086854550434 |
| 23:10:02 | `begin` | approval attempt `PREPARED` (same block quote) |
| 23:10:06–23:10:13 | `report`, `observe` ×2 | approval `HASH` → `PENDING` → **`CONFIRMED` on-chain** |
| 23:10:21 | `begin` → `status` | fresh quote at block 53392635 (29 s after the quote, **not expired**): −0.034 %; Review **cleared** (`QUOTE_CHANGED_REVIEW_REQUIRED`). **No swap was ever prepared.** |

`begin` returning a refusal is an HTTP 200 `{ ok: false, code }`, and the API logged it as `flow.call … outcome: ok`, so the code itself was
invisible in production logs; the client then called `status` (the `begin → status` pairs above). The stored records prove the code.

**Root causes (all CODE-reproduced; the first is PROD-RECORD-proven):**

1. **The execution boundary treated every 1-wei quote movement as material.** `begin()` compared the fresh observation with the reviewed
   observation (`catalogEconomics`: `expectedOut`, `minimumOut`, pool, fee) instead of with the reviewed **bounds**. On an active pool the quote
   moves every block, so a live Base Review almost never survived to Execute; the owner-bound networks (Arbitrum One, Ethereum) had the same
   defect twice over, because the re-bound owner calldata carried the fresh minimum (`OWNER_STATE_CHANGED_REVIEW_REQUIRED`).
   *Test:* `base-swap.test.ts` “P0 reproduction” fails on `main` with exactly `QUOTE_CHANGED_REVIEW_REQUIRED` and passes on this branch.
2. **Codes were replaced by a sentence that matched nothing.** The public swap store kept `message(code)` (English text) as its error, unlike
   every other runtime store. The chat's quote-moved recovery (`QUOTE_MOVED`) and the Review/Simulate projection (`simulationError`) classify
   codes, so the refusal fell through to the generic “FloFi could not complete this simulation, and nothing was sent.”
3. **The chat had no path for a refused continuation.** Once an execution record exists, the chat only announced phases; a refused
   Continue left it silent, and a busy runtime was announced as “reconciling”, repeating “0 of 1 actions completed”. The continuation
   question itself (“The previous wallet request is confirmed…”) never said that the confirmed request was only a token approval.

Hypotheses from the brief that the evidence **rules out**: quote expiry (both refusals were well inside the 60 s window), review-state
corruption, a wallet lifecycle mismatch, and an approval that did not land (it is `CONFIRMED` with a receipt).

**Same root cause, earlier incident.** Draft PR #137 (2026-10-30, never merged, stale base) recorded two more Base refusals of the same
kind (`bas-bb8c…`, `bas-6cfe…`, fresh quotes *better* than reviewed) and proposed “fresh expected ≥ reviewed minimum”. It would still have
refused the 2026-11-01 run 1 (its economics keep the **best** pool/fee tier, and run 1's best tier switched 0.3 % → 0.01 %), it compared the
best tier rather than the reviewed route, and it did not touch the owner-bound calldata or the chat. This build supersedes it; the owner can
close #137.

## 2. Fixes

### 2.1 Swap engine (`src/server/public-testnet-service.ts`) — all swap networks (Base, Arbitrum One, Ethereum, Robinhood Chain, testnet pairs)
- `reviewedBoundsHold(reviewed, fresh)`: the Review authorizes an exact input on a reviewed **route** (pool + fee tier) with a reviewed
  **minimum output**. Execution proceeds while the reviewed route still quotes **at least the reviewed minimum and at most half a slippage band
  above the reviewed expected output**, and the assets, amount, slippage setting, native/conversion kind, decimals and workflow are unchanged.
  The fresh best tier may differ; the transaction is still built on the reviewed route with the reviewed minimum (the router reverts below
  it), so execution never leaves the reviewed constraints. Native-ETH and owner-bound swaps also carry the reviewed deadline; a plain ERC-20
  `exactInputSingle` on Base/Robinhood has no on-chain deadline (pre-existing; FloFi's 60 s Review window and 15 s signing margin still apply).
- The upper half-band (the liquidity runtime's drift rule) keeps the signed minimum from sitting further below the *current* price than the
  owner's slippage setting allows — the room a sandwich could take (security/swap review).
- **Material** (fresh Review required, a presentable fresh quote is saved, nothing is prepared): reviewed route below the minimum, above the
  half-band or no longer quoting, other assets/amount/slippage/kind, Stock Token multiplier change, quote expiry or less than **15 s** of the
  quote window left to sign (`QUOTE_EXPIRED_REVIEW_REQUIRED`).
- **One run, one wallet:** a run whose earlier request came from wallet A is never continued by wallet B (`OWNER_REVIEW_MISMATCH`), also for
  Reviews that bind no owner.
- **Owner-bound networks:** the owner's exact preflight is re-run on the reviewed route, minimum and deadline (`pinReviewedBounds`), so inside
  the bound its calldata is byte-identical to the reviewed calldata; only a real owner change (nonce, allowance, step, EIP-7702 delegation, a
  gas estimate above the reviewed gas limit, or a gas price above the reviewed transaction's own fee ceiling) still needs a new Review, and the
  balance is checked against the reviewed fee budget. Before, any 1-wei gas-price rise retired an Ethereum Review (ceilings were compared, not
  the fresh price against the reviewed ceiling). The reviewed transaction is what the wallet is asked to sign, unchanged.
- On owner-bound networks the swap after an approval is always a **new owner transaction** (step, nonce, allowance change), so it legitimately
  gets its own fresh owner-bound Review: the chat presents it with one “Accept and continue” question (§2.2).
- Unchanged: nonce reservation, relayed-submission reconciliation (PR #150 §1a), duplicate prevention, exact-approval amount, receipt
  reconciliation, the 0.1 % fee policy (not implemented here, by instruction), evidence levels.

### 2.2 Chat continuation (`src/state/flofi-conversation.ts`, `src/domain/conversation-*.ts`)
- The continuation question names what landed and what has not been sent, from the durable record (`executionContinuation`): “Approve USDC is
  confirmed on-chain. An approval only allows the spend; it is not the action itself. Swap has not been sent yet and needs its own confirmation
  in your wallet. Continue to your wallet?”
- A continuation that ends without a new wallet request is reported with its reason. A moved/expired quote or changed owner state is
  re-quoted at once **for the remaining request only** (read-only), and its fresh Review is accepted with **one** explicit answer
  (`CONFIRM_CONTINUE_REVIEW`), which re-checks the binding and opens the wallet. When the reviewed quote expires while the approval confirms,
  FloFi prepares that fresh Review once by itself; it never re-offers the same continuation after “Not now” and never repeats the landed request.
- Once any request of the run landed, no message says “nothing was sent” about the run; refusals say “nothing **new** was sent”.
- “Reconciling” is announced only while a submitted request is observed, not while a runtime is merely busy.
- The shared progress message (Chat, Canvas, Execute) distinguishes a confirmed approval from the action: “0 of 1 actions completed. The token
  approval is confirmed on-chain; it only allows the spend. The action itself has not been sent yet and needs its own confirmation in your wallet.”

### 2.3 Codes, not sentences (`src/state/public-testnet-store.tsx`, `src/domain/simulation-presentation.ts`)
- The public swap store keeps the runtime code; the engineering panel renders `publicSwapMessage(code)`. The mainnet message for
  `INSUFFICIENT_INPUT` no longer says “test token”.
- `simulationError` classifies the swap engine's own boundary codes that previously hit the generic fallback: `SUBMISSION_RESULT_UNKNOWN`,
  `RELAYED_EXECUTION_PENDING`, `RECONCILIATION_MISMATCH`, `WALLET_AUTHORIZATION_REJECTED`, `WALLET_NOT_FOUND`/`WALLET_CONNECTION_REJECTED`,
  `OWNER_REVIEW_MISMATCH`, `ATTEMPT_ALREADY_ACTIVE`/`SWAP_ALREADY_ATTEMPTED`, and FloFi Wallet (`FLOFI_WALLET_*`) refusals.

### 2.4 Wallet continuity (`src/state/review-authorization.ts`)
- A Base/Robinhood swap Review binds no owner (same quote for every wallet; `begin` re-reads the executing wallet's balance and allowance). A
  not-yet-accepted one now adopts the first wallet that connects **on its own network** (account first, then chain) instead of retiring as
  “Wallet changed”. Accepted Reviews, other networks, a second wallet and a new restoration still retire it; owner-bound Reviews keep PR #150's rule.

### 2.5 Observability (`backend/app.ts`)
- A refused flow call is logged as `flow.refused` with `{ flow, action, run_id, code }` (classified code only; no arguments, accounts or amounts).

## 2.6 Issue #149 — P0 transaction truth

| Item | Root cause | Fix | Tests |
| --- | --- | --- | --- |
| Dashboard “Not started” after a landed approval (Aave, Uniswap liquidity, lending, swap) | Run summaries (`packages/cloud-runtime/src/queries.ts` `listRuns`) carry no attempts; the status column alone loses the evidence: Aave/Uniswap show `AUTHORIZED` after a reconciled approval, lending returns to `SIMULATED` after a refreshed Review, `base-swap` shows the approval's `CONFIRMED`; `run-mapping.ts` mapped these to “Not started / nothing was sent” or a generic attention state. | `lib/dashboard/data-service.ts` reads each ambiguous run's own owner-scoped record (at most 5 at a time) and attaches its attempts; `run-mapping.ts` follows `canonicalRunLifecycle` (the evidence MCP's execution status reads); `landed-attempts.ts` names what landed (“Approval confirmed · main action not sent / not submitted / failed / awaiting wallet confirmation”); an approval-only run is “Partially completed”, never Completed; an unreadable record is “Unresolved”, never “nothing was sent”. | `landed-attempts.test.ts` (Aave, Uniswap, lending, the base-swap production shape; every status × attempt-history combination against the canonical lifecycle), `data-service-attempts.test.ts` (bounded reads, owner/id mismatch, read failure), `dashboard-landed.test.tsx` |
| Automations History “Owner executed — reconciling” for simulated/refused runs | `automations-workspace.tsx` fell through to “Owner executed” whenever a run had no error code. | `automations/run-facts.ts` attaches attempts (same single read); `components/automation-run-status.ts` maps the canonical lifecycle: simulated, reviewed, refused, awaiting wallet, submitted, hash pending, confirmed onchain, settlement pending, partial, reverted, failed, unresolved; “reconciled” only with verified evidence; an applied proposal without a run is “Intention only — not simulated or sent yet”. | `automation-run-status.test.tsx` |
| Pix `get_approval_status` | see §2.8 (MCP) | | |
| Channel route discovery without the web's capability gate | `server/channel-copilot-toolkit.ts`, wired from `channels/http.ts` and `dispatch-http.ts`, had no `GRYLOO_UNIVERSAL_ROUTER` gate. | `channels/route-discovery.ts` for both entry points: live → the existing toolkit; off → the web's own refusal (`UNIVERSAL_ROUTER_NOT_ENABLED`); harness → closed. With a remote API the web deployment's env also needs `GRYLOO_UNIVERSAL_ROUTER=live` for channel discovery. | `route-discovery.test.ts` (parity with `universalRouterMode`, off/on/harness, wiring) |

Follow-up (performance, not correctness): aggregate attempts into `listRuns` (`json_agg` over `execution_attempts`) so the Dashboard needs no
per-run reads; it already skips them when a summary carries attempts.

## 2.7 Issue #149 — P1 privacy, reliability and agent infrastructure

| Item | Decision / fix | Evidence |
| --- | --- | --- |
| Journey telemetry (LGPD/GDPR) | **Off by default.** Collection needs both `NEXT_PUBLIC_FLOFI_JOURNEY_TELEMETRY=on` (browser beacon; otherwise no request) and `FLOFI_JOURNEY_TELEMETRY=on` (receiver; otherwise 204 without reading cookie or body). Unchanged bounds: 4 KiB body, schema, 60 events/account/10 min, 600/min/instance, bounded memory; content-free fields only. Policy `docs/privacy/JOURNEY-TELEMETRY.md` (purpose, LGPD art. 7 IX/10 and GDPR 6(1)(f) balancing, retention = log platform's, deletion, access, opt-out) — an **engineering policy pending owner/legal review**; `/privacy` must describe the processing before anyone turns it on. `docs/deploy/ENVIRONMENT.md` corrected. | `journey-metrics.test.ts`, `journey-telemetry.test.ts`, `route.test.ts` |
| Uniswap quoter: RPC vs no liquidity | The engine already separates them (`readNotAnswered` since BUILD-FLOFI-EXECUTION-PERFORMANCE-001: an unanswered read fails the quote closed as `PUBLIC_RPC_UNAVAILABLE`; an explicit revert removes only that fee tier; no tier left is `POOL_UNUSABLE`), and the Build estimate names both. The Simulate/Review/chat path did not: `POOL_UNUSABLE` fell through to the generic “could not complete this simulation”, and an RPC outage read as “Simulation is currently unavailable”. `simulationError` now says which one happened (“…not a liquidity problem; try again shortly” / “No pool for this pair has usable liquidity for this amount…”). | `simulation-presentation.test.ts` |
| Auto-follow for router, liquidity, transfer | The chat now follows every runtime's durable record after a landed request and continues only through each runtime's own Review/continuation gates (§2.2); observation stays read-only. | `flofi-conversation.test.ts` |
| Privy EVM `canSign` | `privyCanSign` uses each ecosystem's own readiness: EVM also waits for Privy's `useWallets().ready` (embedded frame and the person's EVM wallets), and the provider value updates when it becomes ready. `floFiSigningGate` and exact-byte checks unchanged. **Not verified against a live Privy app** (needs a real app id and browser). | `privy-bridge.test.tsx` (fails without the readiness check), `privy-client.test.ts` |
| Specialist report hand-back | In auto mode Claude Code appends `SubagentHandback` to every subagent and delivers only reports sent through it; the read-only guard denied it, so reports were lost. The guard now allows exactly that tool with one non-empty `message` and records only the validated `FLOFI_REVIEW_RESULT`; frontmatter stays `tools: Read`, everything else stays denied; 19 agents regenerated; the probe gained an auto-mode phase. | `test_ci_claude_agents.py`, `test_ci_agent_guard.py`, `verify_claude_agents.py` |
| Protocol documentation | Uniswap re-verified (digest, MIT licence, GPL-2.0-or-later header, claims, review date 2026-11-02). Jupiter stays **pending** (no licence at the pinned revision; developers.jup.ag blocked). Arbitrum third-party guide **pending** (never read; its overstated cross-check list removed); the official Arbitrum sources stay pending (no licence). Blocker: this session's network policy denies developers.jup.ag, developers.uniswap.org, docs.arbitrum.io and skills.rest. | `skill_registry.py verify` |

## 2.8 `/api/mcp` 300-second timeouts, and Pix `get_approval_status`

**Evidence (PROD-LOG, read-only):** Vercel runtime errors list **252 × “Task timed out after 300 seconds” for 55 users, all on `/api/mcp`**,
2026-10-07 → 2026-11-01T23:54Z. Runtime logs are kept 1 h on this plan, so individual requests could not be tied to a method or tool; a
timed-out request left no line at all (`mcp.tool` was logged only when a tool finished). Production reports `runtime: "remote"`.

**Root causes (CODE, reproduced by tests; not individually confirmed in production logs):**
1. **`subscriptions/listen` never ended.** The SDK advertises `tools.listChanged: true` by default, so a 2026-07-28 client keeps an SSE stream
   open with keep-alives until `request.signal` aborts. The gateway forwarded the request **without a signal** and awaited `response.text()`
   before closing, so the function ran until the platform killed it.
2. **No deadline on the remote runtime.** MCP called the cloud API with the client defaults: up to 4 × 240 s per call (3 × 240 s for previews).
   One slow preview already exceeds the function limit with one retry.
3. (HYPOTHESIS, why previews are slow) the backend `previewFlow` had no deadline, and paced public RPC reads retry with backoff (up to ~31 s
   per read) through one queue per flow.

**Fixes:**
- `src/mcp/deadline.ts`: one budget per request (150 s total; tools stop 10 s earlier; the platform limit stays 300 s; `maxDuration` not
  raised), per-operation caps (read 15 s, preview 90 s, store 20 s), a UUID `requestId` per request.
- `src/mcp/gateway.ts`: the forwarded request carries an abort signal (client close or deadline); OAuth, wallet-link and body reads are
  bounded; at the hard deadline the gateway answers a JSON-RPC error itself; every response has `x-flofi-request-id`; every request ends with
  one metadata-only `mcp.request` log line. The server advertises `listChanged: false` (cause 1).
- `src/mcp/runtime.ts` / `src/server/cloud-api-client.ts`: remote calls carry the signal; a caller deadline ends retries
  (`CLOUD_API_DEADLINE_EXCEEDED`, never retried); 2 attempts for reads, 1 for previews. A timeout is never read as “off” or “not found”.
- `src/mcp/tools.ts`: every tool is bounded; timeouts are classified by what the tool may have done — read-only → `NOT_COMPLETED`; status
  reads → `STATUS_UNKNOWN` (“not evidence that nothing was submitted”); `request_user_approval` / `open_approval_session` → outcome
  `UNKNOWN`, `automaticRetry: false`, next `get_approval_status`. Nothing is resubmitted after a timeout.
- `backend/app.ts`: a read-only preview has an 80 s total deadline (`CLOUD_PREVIEW_TIMEOUT`, logged `flow.preview_timeout`); its storage is
  per call and discarded, so stopping is safe.
- `platform/approvals.ts`: a failed run read is **incomplete**, never “no runs” — `approvalProgress` returns `runsComplete: false` and an
  UNKNOWN note; `sharedRuns` (developer API, events) refuses with `CLOUD_RUNTIME_UNAVAILABLE` (public `SERVICE_UNAVAILABLE`) instead of `[]`.

**Pix `get_approval_status` (issue #149):** `src/mcp/pix-approval-status.ts` lists, for an approval whose plan runs through `pix-payment`,
only the runs durably bound to that approval, each read as the claimant wallet (summary and record owner must both be that wallet, created
after the claim, status shared and approval applied); it shows the recorded and shared execution status, never “not started”, counts a run as
settled only with `PAYMENT_SETTLED` evidence whose bundle hash matches the record, and never changes the approval. **Limitation (genuine
gap):** nothing creates Pix approvals or binds Pix runs to an approval today, so the list stays empty until a Pix flow calls
`handoffs.bindRuns(handoffId, [runId])` when it starts a run from an applied approval.

**Not fixed:** in-process DApp server actions still allow 4 × 240 s for cloud calls (they are not on the MCP path); an embedded-runtime call
cannot be cancelled, only no longer awaited.

Tests: `deadline.test.ts` (silent provider bounded within budget, client abort reaches the fetch, no retry and a single write, the listen
hang, a late-committing approval write → `UNKNOWN` with one row), `deadline.pg.test.ts`, `pix-approval-status.test.ts` (incl. cross-account
and cross-owner isolation), `cloud-api-client.test.ts`, `gateway.test.ts`, `platform/approvals.test.ts` (incomplete reads),
`cloud-execution.pg.test.ts` (bounded preview, no run written).

## 3. Same failure class across the other operations (audit)

| Capability | Execution-boundary quote check | Error codes to chat/Review | Continuation after approval | Result |
| --- | --- | --- | --- | --- |
| EVM swaps (Base, Arbitrum One, Ethereum, Robinhood; testnet pairs) | exact equality → **fixed** (§2.1) | sentence → **fixed** (§2.3) | **fixed** (§2.2) | fixed |
| Bridges (Router, Universal) | `compareRoutes`/`compareUniversalRoutes` `REQUOTE`: fresh expected ≥ reviewed minimum, reviewed bytes executed — already correct | codes | generic chat continuation (§2.2) applies | no engine change |
| Uniswap v3 liquidity | tolerance (`drift` ≤ half the slippage band) — already correct | codes | §2.2 applies | no engine change |
| Aave supply / withdraw / borrow / repay | no price quote; exact amounts; fee/gas ceilings | codes | §2.2 applies | no engine change |
| Solana swap (Jupiter), Solana transfer, Orca | exact signed message + blockhash expiry (no requote) | codes | single request (composition: own flow) | no change |
| EVM transfers | gas ceiling only | codes | single request | no change |

## 4. Tests (deterministic; MOCKED / loopback — never mainnet evidence)

| Area | Tests |
| --- | --- |
| Production reproduction | `base-swap.test.ts`: USDC → native ETH, approval required, best tier switches and the reviewed tier moves −0.014 %/−0.048 % after Review, approval lands, swap prepared under the **same** Review on the reviewed tier with the reviewed minimum, received ≥ minimum, native delta = received − gas, no WETH left; duplicate Execute after the outcome refused. Fails on `main` with `QUOTE_CHANGED_REVIEW_REQUIRED`. |
| Material change / expiry after a landed approval | `base-swap.test.ts`: −2 % on a 1 % Review → `QUOTE_CHANGED_REVIEW_REQUIRED`, approval stays `CONFIRMED`, presentable fresh quote saved; expiry → refresh → Review → swap; exactly one approval. |
| Within bounds / below minimum (owner-bound) | `arbitrum-runtime.test.ts`, `ethereum-runtime.test.ts`: +25 % and −0.25 % keep the Review and sign exactly the reviewed transaction; −2.5 % on a 0.5 % Review → `QUOTE_CHANGED_REVIEW_REQUIRED`; allowance, nonce, fee and expiry changes still retire it. |
| Pair profile | `public-testnet-service.test.ts`: below-minimum material; better and slightly worse quotes keep the Review and sign the reviewed minimum. |
| Chat | `flofi-conversation.test.ts`: landed approval named; refused continuation for a moved quote re-quotes the swap only and asks once; expiry while the approval confirms → one automatic re-quote, one question, never re-offered after “Not now”; PT copy. |
| Wallet continuity | `review-authorization.test.ts`: owner-free Review adopts the first wallet on its network only. |
| Logging | `cloud-execution.pg.test.ts` (PostgreSQL 16 loopback): `flow.refused` carries only the classified code. |
| Browser | `conversational-workflow.spec.ts`, `chat-sequence.spec.ts` assert the new continuation wording (profile `execution-continuity`). |

## 5. Owner validation on mainnet (user-authorized, through the reviewed wallet flow; never automated)

Prerequisite: this branch deployed to both Vercel and the Railway API. Use a small amount you are willing to swap.

1. Base, MetaMask, a wallet **without** a USDC allowance for the Uniswap SwapRouter02: in Chat, “swap 1 USDC to ETH on Base”. Review, confirm,
   execute. Confirm the **approval** in MetaMask. Expect: “Approve USDC is confirmed on-chain … Swap has not been sent yet … Continue to your wallet?”
2. Answer Continue within the quote window. Expect a second MetaMask request (the swap), then “Execution completed” with an explorer link;
   Dashboard shows the run reconciled; the received ETH ≥ the reviewed minimum. Railway shows no `flow.refused` for that run's `begin`.
3. Repeat with a wallet that **already** has the allowance: one MetaMask request only.
4. Wait > 60 s after the approval before answering: expect “The reviewed quote expired …” → a fresh quote for the swap only → one question → swap.
5. Decline the swap in MetaMask: expect “You declined this request in your wallet … Earlier confirmed requests stay recorded.”, approval still
   shown as confirmed, no “nothing was sent” for the run.
6. On Arbitrum One (owner-bound), steps 1–2 with an EOA and with a MetaMask Smart Account. After the approval confirms, expect FloFi to show a
   fresh quote for the swap and ask “Accept this updated quote and continue …?” **before** the second MetaMask request (the swap is a new
   owner-bound transaction with its own Review).
Observe in Railway: `flow.refused` events now carry the code of any refusal.
