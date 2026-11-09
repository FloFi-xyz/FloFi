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

Wallet batches (EIP-5792 `wallet_sendCalls`, atomic required, the owner's own wallet signs, sends and pays; no paymaster, no executor):

1. **Aave Repay and Withdraw join batches** with the owner-signed flows' own rules: a *partial* repayment (below the debt read now, plus what the
   batch borrows first) and health factor ≥ 2.0 after a withdrawal, proven by the whole-batch `eth_simulateV1`. Debt-token and aToken burns are
   reconciled as optional protocol legs; a repayment executed for less than signed never reconciles.
2. **Any catalog ERC-20 swap on Ethereum, Base, Arbitrum One and Robinhood Chain** batches through the network's own registered SwapRouter02 /
   QuoterV2 / factory, at the best tier whose canonical pool exists (the owner-signed catalog swap's rule). Stock Tokens, native ETH and WETH9
   wrap/unwrap keep their own flows, with a closed reason.
3. **On-chain expiry for every batch that needs it:** swaps are `multicall(deadline, [exactInputSingle])`; a batch with Aave calls and no swap starts
   with a `multicall(deadline, [])` guard. A prompt confirmed after the 10-minute validity reverts whole (EIP-5792 requests have no expiry).
4. **A cached preparation is handed to the wallet only with ≥ 3 minutes left**, else re-prepared under the same EIP-5792 id.
5. **Base L1 data fee** is in the fee ceiling the owner's balance must cover and in the reconciled gas paid.
6. **Solana sign-all groups are never half-sent:** before the first transaction is sent the signed group must still have the blockhash budget
   for all of them; "expired" is declared only when provable (finalized height + fresh status read); the fee ceiling includes deposits.
7. **A due group that can never be prepared halts the run at once** (it stayed RUNNING for up to 7 days); resuming a group blocked because the
   RPC cannot simulate continues it through each step's own owner-signed flow.
8. **/approve never re-sends a batch whose wallet answer was lost** (the Editor's PR #173 protection, now on the page every MCP, channel and chat
   handoff uses).
9. **Honest counts and reasons:** counts made with assumed wallet capabilities (MCP, channels, a claim before the browser read the wallet) are
   lower bounds — never "single", always "at least"; the planner reports the builder's real reason a step cannot be batched; the Editor asks
   the wallet only about the workflow's own chains and treats an unreported chain as unknown, not "unsupported"; wallet pre-send refusals
   (EIP-5792 57xx, 4100/4200) are "nothing sent".
10. **Editor / Execute:** Resume for a HALTED run; a link to the signing page for a step the run asks to sign through its own flow; each group's
    health factor and fee (also for later groups); expired prepared amounts marked; truncated health factor; fee ceiling worded as an estimate
    the wallet finalizes; a Solana-only workflow keeps the per-step path instead of a dead end; non-batch kinds fail closed.
11. **Labels:** a bridge's assets were always shown as USDC; liquidity deposits were labelled by decimals — now by their own identity.
12. **Readiness** (`/api/flofi/readiness?probe=networks`) reports per mainnet endpoint and per user-funded chain whether it answers
    `eth_simulateV1` (SUPPORTED / UNSUPPORTED / UNKNOWN), read-only, never a URL.

## D. Capability matrix (code facts at this PR; production certification is separate)

| Action | Provider / profile | Networks | Composes as | Wallet grouping (user-funded) | Execute values | Limits (kind) |
|---|---|---|---|---|---|---|
| Swap | Uniswap v3 catalog (SwapRouter02, QuoterV2) | Ethereum, Base, Arbitrum One, Robinhood Chain | producer + consumer | **EIP-5792 batch** for any two catalog ERC-20s, best existing tier, slippage ≤ 3%, on-chain deadline | input, expected, minimum, protocol, network, fee | native ETH / WETH wrap / Stock Tokens: own flow (code); slippage > 3%: own flow (code) |
| Swap | Jupiter | Solana | producer + consumer | **sign-all** for independent steps (Wallet Standard multi-input) | input, expected, minimum, fee + deposits | a step spending an unlanded output starts its own group (protocol: no simulation on another tx's post-state); FloFi Wallet: one prompt per tx (wallet); only SOL/USDC/USDT (code) |
| Transfer | native / ERC-20 | all EVM mainnets | consumer (+ producer to self) | **batch** | amount, recipient | — |
| Transfer | SOL / SPL / Token-2022 | Solana | consumer | **sign-all** | amount, recipient, fee + deposits | — |
| Bridge | Cross-chain Router (Across via LI.FI, direct Across) | USDC/USDG among Ethereum, Base, Arbitrum One, Robinhood | producer (own wallet) + consumer | own flow (owner step); ends its group; next group signed when the delivery reconciles | route, guaranteed minimum (own Review) | not batchable yet (code, L) |
| Bridge | Universal router (Relay) | all 20 directed pairs incl. Solana | producer + consumer | own flow | own Review | LI.FI / Mayan / Across discovered but not executable (code) |
| Supply / Borrow | Aave V3 | Ethereum, Base, Arbitrum One | Supply consumer; Borrow producer | **batch**, simulated (`eth_simulateV1`), HF ≥ 2 after borrow | amount, HF after, fee | needs `eth_simulateV1` on the RPC (deployment); never an upfront user operation; no market on Robinhood/Solana (protocol) |
| Repay / Withdraw | Aave V3 | Ethereum, Base, Arbitrum One | Repay consumer; Withdraw producer | **batch** (new), simulated, partial repay, HF ≥ 2 after withdraw | amount, HF after, fee | full repayment not offered (owner-flow rule) |
| Add liquidity | Uniswap v3 (catalog), Orca SOL/USDC | EVM catalog networks, Solana | consumer (one binding per deposit) | own flow (two inputs) | own Review | not batchable yet (code, L) |
| Remove liquidity | Orca (Canvas only) | Solana | — | — | — | not in the strategy grammar (code, L) |
| Automations | single swap | Base, Ethereum, Solana | — | own flow | — | multi-step automations not offered (code) |

Interaction counts are exact only after the owner's browser reads the wallet (`/approve`, the Editor); a requester (MCP, channel) reports
"at least N".

## E. Wallet interactions (examples, MetaMask with `atomic` supported)

| Workflow | Before this PR | After |
|---|---|---|
| Arbitrum Swap USDC→WETH → Supply → Borrow | 1 `wallet_sendCalls` (PR #173) | 1 (+ deadline, unchanged count) |
| Arbitrum Repay → Withdraw → Swap WETH→USDC | 3+ confirmations (repay, withdraw own flows; approvals) | **1** `wallet_sendCalls` |
| Robinhood Swap WETH→USDG → Transfer | 2+ (swap own flow + approval, transfer) | **1** |
| Arbitrum Swap USDC→ARB → Transfer | 2+ | **1** |
| Swap → Uniswap liquidity → Supply (RPC without `eth_simulateV1` at due time) | run RUNNING for 7 days, every attempt refused | run HALTED at once → Resume → Supply through its own flow → COMPLETED |

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

(filled at delivery)

## J. Deploy verification

(filled after merge)

## K. Real limits and owner actions

- **Not batchable yet (code, larger work):** bridges (deposit as the last call of a batch), add/remove liquidity, native-ETH swaps, Solana
  dependent steps in one message, the Editor running owner-step groups in place (it links the signing page) and Solana sign-all from the Editor.
- **Protocol / wallet limits:** EIP-5792 batching is the wallet's choice per chain; dependent Solana steps cannot be simulated before the producer
  lands; a bridge delivery cannot be atomic with the source; requester-side counts are lower bounds.
- **Owner actions:** dedicated read profile for quote latency (F); RPCs whose readiness reports `simulateV1: UNSUPPORTED` refuse Aave batches
  on that chain (the steps then run through their own flows) until the owner points `FLOFI_USER_FUNDED_RPC_<id>` at an endpoint that supports it;
  the first owner-signed mainnet run of a batch is the owner's decision.
