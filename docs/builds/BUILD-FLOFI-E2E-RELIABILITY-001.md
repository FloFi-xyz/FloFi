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

## 2. Fixes

### 2.1 Swap engine (`src/server/public-testnet-service.ts`) — all swap networks (Base, Arbitrum One, Ethereum, Robinhood Chain, testnet pairs)
- `reviewedBoundsHold(reviewed, fresh)`: the Review authorizes an exact input on a reviewed **route** (pool + fee tier) with a reviewed
  **minimum output**. Execution proceeds while the reviewed route still quotes **at least the reviewed minimum** and the assets, amount, slippage
  setting, native/conversion kind, decimals and workflow are unchanged. The fresh best tier may differ; the transaction is still built on the
  reviewed route with the reviewed minimum and deadline (the router reverts below the minimum), so execution can never leave the reviewed
  constraints. Price improvements and small adverse moves inside the bound need no new Review.
- **Material** (fresh Review required, a presentable fresh quote is saved, nothing is prepared): reviewed route below the minimum or no longer
  quoting, other assets/amount/slippage/kind, Stock Token multiplier change, quote expiry (`QUOTE_EXPIRED_REVIEW_REQUIRED`).
- **Owner-bound networks:** the owner's exact preflight is re-run on the reviewed route, minimum and deadline (`pinReviewedBounds`), so inside
  the bound its calldata is byte-identical to the reviewed calldata; only a real owner change (nonce, allowance, step, EIP-7702 delegation, gas
  or fee ceiling) still needs a new Review. The reviewed transaction is what the wallet is asked to sign, unchanged.
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
6. On Arbitrum One (owner-bound), steps 1–2 with an EOA and with a MetaMask Smart Account.
Observe in Railway: `flow.refused` events now carry the code of any refusal.
