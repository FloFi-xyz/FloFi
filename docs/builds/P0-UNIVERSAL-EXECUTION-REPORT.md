# P0 — Universal workflow execution: catalog, minimum authorizations, Governance

Owner request (2026-11-09): restore main's Governance, then make every supported catalog card executable in any technically valid workflow,
authorized with the fewest wallet interactions the wallet really supports, with honest values in Execute, continuity after approval, and
verified deploys. This report covers PR #174 (Governance) and the universal-execution PR that follows it. Nothing here executed a real
transaction, moved funds or signed for anyone; every chain in the tests is a MOCKED loopback double.

## A. main's Governance failure (PR #174, merged `7c579a3`)

| | |
|---|---|
| Failing job | CircleCI `governance` on main `2fd691e` (merge of #173) |
| Failing command | `git diff --check HEAD^1 HEAD` → `docs/deploy/USER-FUNDED-EXECUTION.md:158: new blank line at EOF.` |
| Reproduced | `git diff --check 1fd05a1 2fd691e` exits 2 locally (not a false positive) |
| Root cause | CircleCI builds the pushed branch: on a branch `HEAD^1 HEAD` is only the **last** commit. The blank line came from an earlier commit of #173, so every PR build passed; on main the merge commit's `HEAD^1` is the previous main, so the whole PR diff was checked. GitHub Actions `pull_request` checks the merge ref and would have caught it; CircleCI, the certification authority, did not. |
| Fix | Blank line removed. CircleCI Governance keeps `git diff --check HEAD^1 HEAD` and **adds** `git diff --check "$(git merge-base FETCH_HEAD HEAD)" HEAD` after `git fetch --no-tags origin main`: every commit a branch adds is checked before merge. No gate removed or relaxed. `scripts/test_ci_optimization.py` asserts the check stays fail-closed (verified to fail without it). |
| Result | PR #174 CircleCI green at `74aa8a3` (governance, certification-checks, browser-1, browser-2, certification) and Vercel Preview green; merged at the verified head SHA. **main `7c579a3`: CircleCI governance, certification-checks, certification-browser-1/2 and certification all green.** Vercel production READY at `7c579a3` (readiness `ok: true`, commit `7c579a3`); Railway `flofi-api` and `flofi-worker` SUCCESS at `7c579a3`. |

## B. Audit (8 read-only dimensions, evidence `file:line` in the session transcript)

Catalog and connections, EVM builders, Solana, bridges and cross-chain continuation, the Editor's whole-workflow path, Execute values, chat/
Editor/MCP/channel parity, browser e2e infrastructure. Key facts:

- **Connections are typed bindings, not a list of pairs.** Consumers: swap, bridge, supply, repay, transfer, add_liquidity. Producers: swap,
  bridge (without explicit recipient), withdraw, borrow. A binding needs the exact token (chain, address, decimals). Swap→Swap, Swap→Transfer,
  Swap→Supply, Borrow→Swap, Borrow→Repay, Swap→Liquidity, Withdraw→Swap, Withdraw→Transfer, Bridge→Swap/Supply/Transfer, Swap→Bridge and
  Bridge→Bridge all compose on every network where the action exists, up to 8 steps.
- **Rejected for real reasons:** Supply→Borrow / Repay→Withdraw / Bridge→Borrow as *amount bindings* (Borrow and Withdraw take funds from Aave,
  not the wallet; Supply and Repay deliver nothing) — all still compose as ordered steps with their own amounts; native ETH → Aave (the Pool
  takes WETH); a bridge to an explicit third-party recipient funds nothing; cross-chain binding without a bridge.
- **The batching gap was FloFi code, not protocol:** batches carried only USDC⇄WETH swaps at 0.05%, supply, borrow and transfer; every other
  catalog swap, every Robinhood Chain swap, repay and withdraw ran step by step.

## C. What changed (universal-execution PR)

Wallet batches (EIP-5792 `wallet_sendCalls`, atomic required, `from` = the owner; the owner's own wallet signs, sends and pays; no paymaster,
no executor):

1. **Aave Repay and Withdraw join batches** with the owner-signed flows' own rules: a *partial* repayment (below the debt read now, plus what the
   batch borrows first) and health factor ≥ 2.0 after a withdrawal, proven by the whole-batch `eth_simulateV1`. Debt-token and aToken burns are
   optional reconciliation legs; a repayment executed for less than signed never reconciles. A repay that is no longer partial when due halts
   the run (resume runs it through its own flow, which reads the debt again).
2. **Any catalog ERC-20 swap on Ethereum, Base, Arbitrum One and Robinhood Chain** batches through the network's registered SwapRouter02 /
   QuoterV2 / factory, at the best tier whose canonical pool exists. Both tokens are verified **on chain** first (code present, `decimals()` equal
   to the catalog; listing is never authority); on Robinhood Chain only its pinned assets batch. A tier is skipped only when the chain answered
   with a revert; a rate limit or timeout refuses instead of silently picking a worse pool. Stock Tokens, native ETH and WETH9 wrap/unwrap keep
   their own flows with a closed reason.
3. **Batched ERC-20 transfers** batch only catalog assets with matching decimals (never Stock Tokens; on Robinhood only pinned assets) and verify
   the token on chain the same way.
4. **Every swap output is proven received in full:** the whole-batch simulation reads the owner's output-token balance around each swap
   (simulated sequence only) and refuses a token that delivers less than the pool sent (fee-on-transfer / rebasing). Without `eth_simulateV1`, a
   batch with Aave calls, or one in which a later call spends a swap's output, is refused (the steps then run step by step); a swap whose output
   is spent inside a group is never signed upfront as a user operation (the planner makes it a batch signed when due).
5. **Every wallet batch expires on chain:** swaps are `multicall(deadline, [exactInputSingle])`; any batch without a deadlined swap (transfers,
   Aave) starts with a `multicall(deadline, [])` guard on the registered router (no router → refused). A prompt confirmed after the 10-minute
   validity reverts whole, so ending a run after that validity can never leave a later execution unrecorded.
6. **No overlapping preparations:** a prepared batch is handed out while it has more than 3 minutes left; with less it is refused
   `USER_FUNDED_PREPARED_STILL_VALID` (confirm the open request, or ask again after it expires); after its validity it is prepared again in place
   (version-checked, every earlier preparation kept for reconciliation). A batch the wallet sent is always recorded and reconciled.
7. **Run expiry never drops a batch the wallet may still send:** no batch is prepared when it could outlive the run; at expiry the pass waits until
   a handed-out batch's validity has passed, never blocks an answered one, and blocks only from the state and version it read. A batch stopped
   while its answer was outstanding is recorded as `WALLET_BATCH_OUTCOME_UNKNOWN` ("may have executed; check your wallet"), never "nothing sent".
8. **Answers are checked:** a different batch id or different hashes for an already-answered group are refused `WALLET_BATCH_ANSWER_MISMATCH` and
   logged (never accepted silently); every answer and block write is a version-checked compare-and-set.
9. **Base L1 data fee** is in the fee ceiling the owner's balance must cover and in the reconciled gas paid.
10. **Solana sign-all:** the blockhash send budget is checked once, while provably nothing was sent; a late signature is refused at authorization
    (the group is prepared again). Once sent, "expired" is declared only when provable (finalized height + fresh status read); a tail that expires
    later is reconciled as a partial result. The fee ceiling includes deposits.
11. **A due group refused for good halts the run at once** (it stayed RUNNING for up to 7 days), also the first group, unless a batch of it was
    already handed to the wallet; Resume continues through each step's own owner-signed flow. `runView.resumable` says when Resume is accepted.
12. **The owner's browser:** every pre-send check runs first (network; the wallet's *selected* account must be the run's account); the "may have
    been sent" marker is written immediately before `wallet_sendCalls` with a per-tab nonce, read back (no durable marker → nothing is sent), and
    shared by the Editor and `/approve`; `/approve` records a known batch id before preparing again; wallet pre-send refusals are "nothing sent".
13. **Honest counts and wording everywhere:** requester counts (MCP, channels) are "at least N", never "single"; the planner shows each step's
    closed reason; `runView.halted` (PARTIAL / NOTHING_SENT / STOPPED) is decided by the server from its records and used by the Editor,
    `/approve`, MCP and the Telegram/WhatsApp channels; the chat now shows the user-funded at-least count and announces a second halt.
14. **Grouping is never more interactions:** the recommendation prefers user-funded groups when at least one group is a batch / sign-all and it
    needs no more wallet interactions than steps (the step count is only a lower bound for confirming each step); a tie no longer forces it.
15. **Editor / Execute:** Resume when the server accepts it; a link to the signing page for an owner-step group; per-group health factor and fee;
    expired prepared amounts marked; step-by-step offered for every refusal no retry can change; bridge/liquidity labels by asset identity.
16. **Readiness** (`/api/flofi/readiness?probe=networks`) reports per mainnet endpoint and per user-funded chain whether it answers
    `eth_simulateV1` (SUPPORTED / UNSUPPORTED / UNKNOWN), read-only, never a URL.

## D. Capability matrix (code facts at this PR; production certification is separate)

Proven through the real code paths, not card connections: `workflow-runs/universal-composition.test.ts` composes and plans **256 ordered action
pairs and 1,784 triples** across the five mainnets (536 cross-chain through bridges) with the product's composer and planner;
`workflow-runs/universal-runs.pg.test.ts` executes mixed workflows end to end on PostgreSQL (section E).

| Action | Provider / profile | Networks | Composes as | Wallet grouping (user-funded) | Limits (kind) |
|---|---|---|---|---|---|
| Swap | Uniswap v3 catalog | Ethereum, Base, Arbitrum One, Robinhood Chain | producer + consumer | **EIP-5792 batch** (any two catalog ERC-20s verified on chain, best existing tier, slippage ≤ 3%, on-chain deadline) | native ETH / WETH wrap / Stock Tokens: own flow; slippage > 3%: refused at composition (`CATALOG_SWAP_SLIPPAGE_INVALID`), except the Base USDC⇄WETH reference swap, which runs its own flow (`WORKFLOW_SLIPPAGE_UNSUPPORTED`) |
| Swap | Jupiter | Solana | producer + consumer | **sign-all** (Wallet Standard multi-input) | a step spending an unlanded output of its group starts a new group (`SOLANA_GROUP_STEP_DEPENDENT`); slippage > 3% refused (`SOLANA_SLIPPAGE_OUT_OF_RANGE`) |
| Transfer | native / ERC-20 | all EVM mainnets | consumer only | **batch** (with the expiry guard) | Stock Tokens / non-catalog tokens: own flow (`USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED`) |
| Transfer | SOL / SPL / Token-2022 | Solana | consumer only | **sign-all** | — |
| Bridge | Cross-chain Router / universal router | EVM ↔ EVM, EVM ↔ Solana | producer (to the owner's own wallet) + consumer | **own flow** (owner step, alone); the destination group is signed when the delivery reconciles | not batchable (quoted when it runs; a delivery cannot be atomic with the source) |
| Supply / Borrow | Aave V3 | Ethereum, Base, Arbitrum One | Supply consumer; Borrow producer | **batch**, simulated, HF ≥ 2 after borrow | needs `eth_simulateV1` on the RPC; never an upfront user operation; no market on Robinhood/Solana |
| Repay / Withdraw | Aave V3 | Ethereum, Base, Arbitrum One | Repay consumer; Withdraw producer | **batch**, simulated, partial repay, HF ≥ 2 after withdraw | full repayment not offered (owner-flow rule) |
| Add liquidity | Uniswap v3 (catalog), Orca SOL/USDC | EVM catalog networks, Solana | consumer (one binding per deposit) | **own flow** (owner step, alone) | two inputs: not batchable (`USER_FUNDED_ACTION_NOT_BUILDABLE`) |
| Remove liquidity | Orca (Canvas only) | Solana | — | — | not in the strategy grammar |
| Automations | single swap | Base, Ethereum, Solana | — | own flow | multi-step automations not offered |

Binding rules (asserted for every pair on every network): producers swap, bridge-to-own-wallet, withdraw, borrow → consumers swap, bridge,
supply, repay, transfer, add_liquidity on the same chain. X → borrow/withdraw is `WORKFLOW_BINDING_CONSUMER_UNSUPPORTED` (they take funds from
Aave, not the wallet); transfer/supply/repay/add_liquidity → X is `WORKFLOW_BINDING_PRODUCER_UNSUPPORTED` (they deliver nothing to the wallet);
both still compose as ordered steps with their own amounts. Cross-chain binding needs a bridge. Every unbound pair composes.

Interaction counts are exact only after the owner's browser reads the wallet (`/approve`, the Editor); a requester (MCP, channel) reports
"at least N".

## E. Wallet interactions (MetaMask-like wallet with `atomic` supported; from the planner matrix and the PostgreSQL runs)

| Workflow | Wallet interactions |
|---|---|
| Arbitrum Swap USDC→WETH → Supply → Borrow | **1** `wallet_sendCalls` (browser e2e: exactly one request, 5 calls) |
| Arbitrum Repay → Withdraw → Swap (bound to the withdrawal) | **1** — `[approve, repay, withdraw, approve, swap]`, run COMPLETED (PostgreSQL) |
| Robinhood Swap WETH→USDG → Transfer | **1** |
| Arbitrum Swap → Supply → Uniswap liquidity → Withdraw → Transfer | 1 + 2 (batch, liquidity flow, batch) — calls asserted, liquidity got exactly the swap's leftover, COMPLETED |
| Arbitrum Swap → Bridge → Base Supply + Transfer (sharing the delivery) | 1 + 2 (batch, bridge flow, batch signed when the delivery landed), 1 network switch, COMPLETED |
| Ethereum Swap → Bridge → Base Supply + Transfer | at least 1 + 2 |
| Solana Swap + Transfer → Bridge → Arbitrum Repay | at least 1 + 2 (Solana 2, EVM 1) |
| Robinhood Swap → Bridge to Solana → Jupiter + Orca | at least 1 + 3 |
| Base liquidity alone | 1 (its own flow; never "single") |
| Any RPC without `eth_simulateV1` for an Aave group | the run halts at once → Resume → each step through its own flow |

## F. Performance (production, read-only)

Railway `flofi-api` HTTP logs, last ~27 h (501 requests): `POST /v1/previews/arbitrum-swap` p50 6.6 s, p95 21.3 s, p99 21.8 s;
`POST /v1/flows/arbitrum-swap/begin` p50 10.0 s, p95 11.2 s. The first Canvas quote of an EVM catalog swap runs the swap's whole read
sequence on the API (~10–14 RPC reads per quote after the deployment-fact cache), serialized by the API's public-endpoint pacing (one at a time,
250 ms) unless the operator declares dedicated endpoints. Readiness (web tier) measured 157–176 ms per mainnet endpoint round trip.
Owner action (no code change, an environment decision): if the `GRYLOO_*_RPC_URL` endpoints on Railway `flofi-api` are dedicated (keyed)
providers, set `GRYLOO_RPC_READ_PROFILE=dedicated` there (25 ms between starts, 6 in flight); it never applies to public defaults.

## G. `eth_simulateV1` in production

Vercel production `FLOFI_USER_FUNDED_RPC_<id>` hosts (names and hosts only): Ethereum `ethereum-rpc.publicnode.com`, Base `mainnet.base.org`,
Arbitrum One `arb1.arbitrum.io`, Robinhood `rpc.mainnet.chain.robinhood.com`. The sandbox cannot reach public RPCs; support is read after deploy
from the new readiness probe (section J).

## H. Tests

(filled at delivery)

## I. Reviews

Read-only FloFi specialists (`.claude/agents/flofi-*`), each finding then fixed in its own commit, checked by an independent adversarial
verifier and mutation-checked (the new test fails with the fix reverted). AI review is advisory; CircleCI is the certification authority.

| Round | Reviewers | Real findings fixed (severity) |
|---|---|---|
| 1 | workflow, security, wallet-execution | re-preparation could lose a sent batch (P1); `blockDueGroup` ignored its compare-and-set (P1); Solana group marked FAILED after its first send (P1); token decimals trusted from the catalog, fee-on-transfer outputs, Aave batch without expiry, resume dropping batch history, browser marker before pre-send checks, wallet account not checked, lost answer unrecordable after a failed re-preparation (P2) |
| 2 (verifiers) | adversarial verifiers | fee-on-transfer check compared with the minimum instead of the full receipt; no-simulation bound swaps; two-tab marker race; lost-answer marker before prepare (P1/P2) |
| 3 | lending, swap, frontend-ux, infrastructure-ci | stale repay never halting; user operations spending a swap output unsimulated; transient RPC error picking a worse fee tier; raw codes and "partially completed" for nothing-sent runs; false expiry note; End hidden; the e2e reload check proving nothing; skipped proof certified PASS (P2) |
| 4 | workflow, wallet-execution, security, mcp, channels | **transfer-only batches without on-chain expiry (P1)**; **run expiry blocking a batch the wallet could still send (P1)**; overlapping preparations; mismatched second answers accepted; markers failing open without storage; unversioned answer write; batched transfers without token checks; PARTIAL note claiming nothing later was sent; Resume on expired runs; channel counts, repeated halts and batch-wait notices (P2) |
| 4b / 4c (verifiers + universal proof) | adversarial verifiers, composition proof | outcome-unknown batches worded "nothing completed" (P1); answers compared in every state; version-checked "not sent" path; no-simulation pre-check of the first real call; dated expiry text; a tie in interaction counts forcing step-by-step mode; missing Solana group reason (P2) |
| Final | security, wallet-execution, workflow (adversarial, on the final HEAD) | see below |

## J. Deploy verification

(filled after merge)

## K. Real limits and owner actions

- **Run step by step by design (technical reasons):** bridges (quoted when they run; a delivery cannot be atomic with its source), add liquidity
  (two inputs, its own review), native-ETH swaps and WETH9 wrap/unwrap (value path), Stock Tokens (disposability checks in their own flow);
  remove liquidity is not in the strategy grammar.
- **Signed when due (a separate prompt, never step by step):** any group after the first, a group that spends a bridge delivery, an Aave group
  after a bridge, a Solana step spending an unlanded output of its own group.
- **Protocol / wallet limits:** EIP-5792 batching is the wallet's choice per chain; requester-side counts are lower bounds; two different wallet
  instances of the same account (desktop and mobile) do not share EIP-5792 id de-duplication, so confirming the same prompt on both could
  execute twice — FloFi refuses and logs a second, different answer (`WALLET_BATCH_ANSWER_MISMATCH`) but cannot stop a second device.
- **Not covered by automated tests:** Solana sign-all through the run engine (planner level only; the harness has no Solana RPC), the real bridge
  flow's destination observation (flow double), EVM user operations with a real bundler (planner level), native-value transfers on the EVM double.
- **Owner actions:** dedicated read profile for quote latency (F); a chain whose readiness reports `simulateV1: UNSUPPORTED` refuses Aave and
  bound-swap batches there (they run step by step) until `FLOFI_USER_FUNDED_RPC_<id>` points at an endpoint that supports it; the first
  owner-signed mainnet batch is the owner's decision.
