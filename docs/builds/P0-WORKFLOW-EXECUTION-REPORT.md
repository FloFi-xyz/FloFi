# P0 — Restore whole-workflow execution, minimum authorization and direct Canvas edits

Branch `claude/dazzling-babbage-mt5lik`, base `main` at `1fd05a1` (production at the time of the report). Nothing in this report was merged,
deployed, migrated or changed in production. No transaction was signed or sent, and no real funds were used. Evidence levels are stated
for each claim: **PRODUCTION-LOG** (read-only Railway/Vercel logs), **CODE**, **UNIT**, **PG** (PostgreSQL suites), **BROWSER**
(Playwright on loopback replays). None of this is `LIVE_CERTIFIED`: that needs the owner's real receipts (§K).

## A. Diagnosis (owner report: Arbitrum One, MetaMask, Swap 3 USDC → WETH, Supply 0.0013 WETH, Borrow 0.8 USDC)

### A.1 Production evidence (read-only Railway `flofi-api` logs, deployment `1fd05a1`, 2026-11-08) — PRODUCTION-LOG

Run `ars-f961c83fa7282d8d7819160f` (`arbitrum-swap`, the owner-step public flow driven by the Editor's per-step sequence):

| Time (UTC) | Call | Duration | Result |
|---|---|---|---|
| 20:32:56 | prepare | 7 222 ms | OK |
| 20:32:58 | review | 284 ms | OK |
| 20:33:08 | begin (USDC approval) | 9 851 ms | OK → wallet prompt 1 |
| 20:33:33 | begin (swap) | 10 432 ms | **REFUSED `OWNER_STATE_CHANGED_REVIEW_REQUIRED`** |
| 20:33:50 | refresh | 11 664 ms | OK (new quote, Review invalidated) |
| 20:34:05 | review | 358 ms | OK |
| 20:34:16 | begin (swap) | 11 086 ms | OK → wallet prompt 2 |

Run `ars-6732c781baf833f606f4cbb5` (20:44:38–20:45:49) repeats the same pattern. After it, `arbitrum-aave` simulate was **refused
`SUPPLY_ALLOWANCE_OVERRIDE_UNVERIFIED`** at 20:46:07 (8 242 ms) and 20:48:41 (8 953 ms). Step 2 (Supply) never ran, so neither did Step 3.
`arbitrum-swap` Simulate previews took 4 058 ms and 4 057 ms.

Vercel Production already had user-funded execution enabled for `eip155:1`, `eip155:8453`, `eip155:42161`, `eip155:4663` and Solana, with
an RPC configured for each EVM chain. Only names and flags were read; no value was read or is shown. An EIP-5792 batch for this exact
workflow was therefore available on `/approve`, **but the Editor never used it**.

### A.2 Root causes — CODE

| # | Root cause | Where (at `1fd05a1`) | Symptom |
|---|---|---|---|
| RC-1 | The Editor's primary CTA ran the legacy **per-step sequence**: one runtime per step, with `runtimeWorkflow` set to the step projection. It never called `wallet_getCapabilities` and never planned groups. "Run workflow" (to `/approve`) was a secondary button, and it disappeared once anything had started (`editor-run.ts:30`). | `app-shell.tsx` (`sequenceNote` "Confirm each step · Step X of Y"), `workflow-store.tsx:212`, `domain/workflow-sequence.ts` | "Confirm each step — Step 1 of 3"; one Review and one return to the Canvas per step |
| RC-2 | The owner-bound swap Review (Arbitrum and Ethereum) binds only the approval transaction. After the run's own approval confirms, `begin` re-binds the swap (nonce + 1, new allowance) and refuses it as an owner-state change. | `public-testnet-service.ts` (`ownerReviewChanged`, `begin`) | The swap stayed "Waiting", then "Review required" and a re-Simulate |
| RC-3 | Aave Supply allowance-override slot discovery scanned mapping indices 0..15 only. Arbitrum WETH (aeWETH, an OpenZeppelin upgradeable token) keeps `_allowances` at index **52**. | `packages/reference-compiler/src/supply.ts` | Every Arbitrum WETH Supply that needed an approval was refused `SUPPLY_ALLOWANCE_OVERRIDE_UNVERIFIED` |
| RC-4 | Canvas setup cards for Supply, Borrow, Repay, Withdraw and Send always carried a whole-form proposal ("Review X change" / "Apply proposal"). Committed Aave cards needed Review when a reserve draft existed, and Send always needed it. | `workflow-canvas.tsx`, `domain/canvas-action-setup.ts` (`amountEditNeedsReview`) | Amount edits needed two extra clicks and a proposal |
| RC-5 | The live-quote key was the hash of the **whole workflow, revision included**. Any edit anywhere re-quoted every Swap and Bridge card and blanked the value it showed. The Execute stage passed no estimate at all. | `state/build-estimate.ts` (`useLiveQuote`), `simulate-workflow-canvas.tsx` | Quote cascades and duplicates; Execute showed "3 USDC → — WETH" |
| RC-6 | The user-funded EVM batch had no whole-batch simulation and no Aave health-factor projection: it ran `estimateGas` on the first call only. It added an `approve` even when the allowance already covered the amount. | `user-funded/groups.ts`, `user-funded/evm-calls.ts` | Unsafe borrows would only fail in the wallet; extra approve calls |

## B. What #166 built and what #168 replaced — CODE

**PR #166** (merge `3bdfe07`, with schema certificate #167):
- **Delegated single authorization.** The owner signed once per chain with `eth_signTypedData_v4`, after MetaMask's EIP-7702 upgrade, an
  ERC-7710 grant of the run's exact calls. The grant carried Redeemer, Timestamp, LimitedCalls, ValueLte, AllowedTargets, ExactCalldata and
  IdEnforcer caveats.
- **Executor.** An AWS KMS secp256k1 key redeemed each grant, sending and **paying gas from FloFi's address** (ADR-0008).
- **Editor.** "Run workflow" (an EDITOR_SESSION handoff to `/approve`) and Enter/blur for Aave amounts.
- **Production use.** Configured, but never used in production: zero grants, authorizations or executions.

**PR #168** (merge `0a102dc`, with certificate #170) retired that executor under invariant **S1: FloFi never pays a user's gas**:
- **Executor disabled.** The executor transport has no send method. Every delegated step is refused with `EXECUTOR_GAS_PAYER_REFUSED`
  before simulation, and every executor-funded operation throws `EXECUTOR_FUNDED_GAS_RETIRED`.
- **Single authorization unavailable.** `delegatedSingleAuthorization.available` can never be true.
- **Replacement: `USER_FUNDED` execution groups.** Each one is paid by the owner's wallet:

| Strategy | When it is used | Wallet interaction |
|---|---|---|
| `EVM_WALLET_BATCH` | EIP-5792 `wallet_sendCalls`, atomic, when the wallet reports `atomic` `supported`/`ready` for the chain | 1 per group |
| `EVM_USER_OPERATION` | The owner's own ERC-4337 account, only for a group that waits for a bridge delivery; no paymaster (`ERC4337_SPONSORED_REFUSED`) | 1 signature |
| `SOLANA_SIGN_ALL` | Wallet Standard `signAllTransactions` | 1 per group |
| `EVM_OWNER_STEP` / `SOLANA_OWNER_STEP` | Fallback: each step through its own reviewed flow | 1+ per step |

This P0 **does not reactivate the KMS executor**. It adds no paymaster, treasury, reimbursement or FloFi gas. It uses #168's user-funded
groups from the Editor itself.

## C. Editor path: before and after — CODE, PG, BROWSER

**Before.** Build → Simulate (step 1 only) → "Authorize in wallet" (step 1's own runtime) → approval → swap re-Review (RC-2) → back to the
Canvas for step 2 → Supply simulate refused (RC-3). `wallet_getCapabilities` was never called from the Editor.

**After.** For a multi-step workflow, when workflow runs and user-funded execution are available and the owner has a FloFi account
session, the primary CTA is **"Review whole workflow"** (`app-shell.tsx` `groupedPrimary`). It stays primary until the Review shows the
workflow cannot be grouped or the Review fails; the step-by-step path is primary then. It opens the Execute stage with `EditorWorkflowRunPanel` (`components/editor-workflow-run.tsx`):

1. **Wallet capabilities.** `walletProfile(evmAccount, EVM_MAINNETS)` calls `wallet_getCapabilities` and records EIP-5792 `atomic` per CAIP-2
   chain.
2. **Review** (read-only; server action `reviewEditorWorkflow`, `editor/workflow-execution.ts`). The pipeline is `editorWorkflowStrategy`
   (exact parity with the Canvas) → `composeWorkflowBound` → `requirementOf` → `planExecutionGroups(facts, real wallet profile,
   userFundedBuildable)` → `prepareGroup(0)`.
   - `prepareGroup(0)` builds the exact calls, takes fresh quotes and signs minimums.
   - It adds approvals only when the current allowance is short, with approve(0) first when a non-zero allowance must be reset.
   - It simulates the **whole batch** with `eth_simulateV1`, including Aave `getUserAccountData` after the batch.
   - The panel shows:
     - what each step spends, its expected output and signed minimum, its provider and the step it is bound to;
     - per group: the mechanism, calls and approvals, the fee estimate and maximum, and the payer (owner);
     - the health factor after the batch, and the wallet prompts, signatures, transactions, batched calls and network switches;
     - how long the prices stay valid, and every downgrade reason.
3. **Authorize** (one click; server action `authorizeEditorWorkflow`).
   - Steps, in order: account session and EVM wallet proof → `startEditorWorkflowRun` → claim with the proven wallet → start USER_FUNDED →
     refuse with `EDITOR_EXECUTION_PLAN_CHANGED` unless group 0 is still grouped → prepare group 0.
   - Any failure cancels the run.
   - The browser compares the prepared minimums with the reviewed ones. A worse value moves the panel to **"confirm-update"** and nothing
     is sent.
   - The browser sends `wallet_sendCalls` (atomicRequired; the app-provided id `sha256(runId:group)` makes a resend a readback, never a
     second batch).
   - Then: `authorizeUserFundedGroup` → follow `wallet_getCallsStatus` → reconcile from Transfer logs.
4. **Persistence and recovery.** The run lives in PostgreSQL. The panel stores `{approvalId}` under `flofi.editor-workflow-run.v1` and polls
   status every 4 s.
   - **After a refresh,** it reads the batch back by its known id instead of sending again.
   - **Due groups** (WHEN_DUE) are prompted in the same panel.
   - **Unknown outcomes** stay `SUBMISSION_RESULT_UNKNOWN` and are **never resubmitted automatically**.

**Fallback (explicit, with its reason shown).** When a plan contains an owner-step group, the per-step sequence is used. That covers: a
wallet without atomic batching (`WALLET_ATOMIC_BATCH_UNSUPPORTED`), a bridge, an action not buildable as a call, slippage above 3 %, or an
Aave beneficiary that is not the owner.
- The fallback now continues after its own approval: RC-2 is handled by an automatic **read-only** re-quote, once per continuation key, so
  the owner is not sent back to the Canvas.
- Step 2 can run on Arbitrum (RC-3 fixed).
- Chat in the Editor no longer starts the per-step sequence when the grouped path is primary; it points to "Review whole workflow".

## D. Fixes — CODE, with tests

| Issue | Fix | Main files | Tests |
|---|---|---|---|
| 1. Three-step workflow | Editor grouped path (§C). Whole-batch `eth_simulateV1`: every call must succeed and every swap must meet its minimum (`SWAP_MINIMUM_NOT_MET`); a borrow needs HF ≥ 2 after the batch (`BORROW_UNSAFE_HEALTH_FACTOR`). A missing `eth_simulateV1` refuses Aave batches (`USER_FUNDED_SIMULATION_UNAVAILABLE`), never signing blind. Allowance-aware approvals. Planning refuses at plan time anything that would only fail at Authorize: slippage > 300 bps, Aave beneficiary ≠ owner. Supply of registered reserves without the delegation-only `validateSupplyCap` flag is allowed, because the batch simulation proves the cap. | `editor/workflow-execution.ts`, `app/editor-workflow-execution-action.ts`, `components/editor-workflow-run.tsx`, `user-funded/batch-simulation.ts`, `user-funded/evm-calls.ts`, `user-funded/groups.ts`, `user-funded/planned.ts`, `workflow-runs/service.ts` | `user-funded/arbitrum-batch.test.ts` (6), `editor/workflow-execution.pg.test.ts` (3) |
| 1b. RC-2 | Per-step fallback: after the run's own approval, a read-only re-quote runs automatically once; the owner then confirms the swap. | `components/app-shell.tsx` | BROWSER (Scenario A spec, fallback path) |
| 1c. RC-3 | Allowance slot candidates are 0..63 plus the ERC-7201 OZ v5 base + 1. | `packages/reference-compiler/src/supply.ts` | `server/arbitrum-lending.test.ts` (index 52 and ERC-7201; verified to fail with the old 0..15 scan) |
| 2. Amount edits | Amounts apply directly on **Enter** and on **blur** for Swap, Supply, Borrow, Repay, Withdraw, Send and Bridge, and after a **1.2 s typing pause** when the typed value is canonical and positive (not on Send, whose recipient is confirmed with Enter or blur). Setup cards have no proposal. The settings forms submit directly. Re-picking a saved token or reserve drops the draft. Errors are shown inline; only the dependent state is invalidated. Review/Apply remains only for an external (e.g. chat) proposal, and for a changed **beneficiary**, network or asset in the Supply settings form. | `domain/canvas-action-setup.ts`, `state/workflow-store.tsx`, `components/composer-card.tsx`, `components/workflow-canvas.tsx`, `components/artifact-inspector.tsx`, `domain/editor-history.ts` | `e2e/canvas-lending-amount-enter.spec.ts` (Scenario A: Enter, blur, pause; `noProposal`), updated specs §H |
| 3. Execute "— WETH" | The Execute stage receives live estimates. A quote is keyed by its **node snapshot** (node alone at revision 0, or the full workflow when it reads an output reference), so it survives unrelated edits and revisions. An expired quote stays visible, marked **"Quote expired: updating"**, never "—". The grouped panel shows expected and minimum per step, the fee, the HF after and the validity. Authorize compares the freshly prepared minimums with the reviewed ones (`confirm-update`), so stale quotes are never signed. | `state/build-estimate.ts`, `components/simulate-workflow-canvas.tsx`, `components/composer-card.tsx`, `components/editor-workflow-run.tsx` | `state/build-estimate.test.ts` (snapshot key, expiry, hidden page, cascade regression) |
| 4. Slow quotes | No cascade: an edit re-quotes only the edited node. The key is memoized; an expired quote refreshes only while the page is visible. The Aave paced client waits only for the remaining spacing (`lastStart + delay − now`) instead of a fixed 150 ms before each read. The grouped prepare path uses 9 unpaced RPC calls (§G). | `state/build-estimate.ts`, `server/supply-rpc.ts` | `state/build-estimate.test.ts`, `server/supply-rpc.test.ts` |
| 5. Persistent state | The grouped run state lives in PostgreSQL and the browser keeps only `approvalId`. Readback is by app-provided batch id. Nothing goes back after an approval: the panel follows the run and never re-opens the Canvas. Unknown outcomes are not resubmitted. | `components/editor-workflow-run.tsx`, `workflow-runs/service.ts` (`RunGroupView.planned`, owner only) | `editor/workflow-execution.pg.test.ts` (COMPLETED and reload) |
| 6. Minimum authorizations | Counts are kept separate and never rounded down: wallet prompts (`atLeast` when a fallback step may ask again), signatures, transactions, batched calls, network switches and one-time setup. "Single" is never claimed; the copy says "one wallet confirmation" only when it is exactly one. The stale "authorize the whole workflow once where available" text in Run workflow was removed. | `editor/workflow-execution.ts`, `components/editor-run-action.tsx`, `i18n/*` | PG (counts asserted) |

## E. Capability matrix (this build) — CODE

Buildable as calls in a user-funded EVM batch:
- **Swap:** USDC ⇄ WETH, Uniswap v3 0.05 %, slippage ≤ 300 bps.
- **Supply and Borrow:** Aave V3 on registered reserves, beneficiary = owner.
- **Send:** ERC-20 or native token transfer.

Everything else is an owner step.

| Network | Swap | Supply | Borrow | Send | Repay / Withdraw / Pool / Bridge / Stocks |
|---|---|---|---|---|---|
| Ethereum (`eip155:1`) | batch | batch | batch | batch | owner step |
| Base (`eip155:8453`) | batch | batch | batch | batch | owner step |
| Arbitrum One (`eip155:42161`) | batch | batch | batch | batch | owner step |
| Robinhood Chain (`eip155:4663`) | owner step (no registered profile) | — (no Aave market) | — | batch | owner step |
| Solana | `SOLANA_SIGN_ALL` for Jupiter swaps that do not depend on another step of the group; otherwise owner step | — | — | sign-all (independent steps) | owner step |

By wallet:

| Wallet | EVM same-chain group | Notes |
|---|---|---|
| MetaMask with EIP-5792 `atomic` `supported` / `ready` on the chain | **1 wallet prompt**: 1 batch, N calls, 1 transaction | `ready` may ask once for MetaMask's own account upgrade; it is shown as one-time setup |
| A wallet without EIP-5792 or `atomic` `unsupported` | owner steps, at least 1 prompt per transaction | reason `WALLET_ATOMIC_BATCH_UNSUPPORTED` |
| An ERC-4337 smart account with a bundler configured | 1 signature per delayed group (after a bridge) | owner prefund pays; no paymaster |
| Solana Wallet Standard wallet (Phantom etc.) | 1 `signAllTransactions` per group | the FloFi embedded wallet is not used to sign |

**Surfaces.** **Editor** gets the grouped path in place (new). **`/approve`** and **MCP** already planned user-funded groups (#168);
`request_user_approval` exposes `userFunded`, and the planner now receives the run's EVM owner (`evmOwner`). Channels (WhatsApp, Telegram)
hand off to `/approve` and get the same plan.

**Chat in the Editor.** It does not start a per-step sequence when the grouped path is primary.

## F. Wallet interactions: before and after (Scenario A, Arbitrum One, MetaMask)

| | Before (production, per-step) | After (Editor grouped, `atomic` supported) | After (wallet without batching) |
|---|---|---|---|
| Returns to the Canvas | 2+ (re-Simulate after the approval, then step 2) | **0** | 0 (the Simulate/Review refresh after an approval is automatic) |
| Wallet prompts | 2 for step 1, then blocked (step 2 refused) | **1** (`wallet_sendCalls`), plus a sign-in proof only if the session has none | 5 (approve, swap, approve, supply, borrow) |
| Transactions | 2, then blocked | **1** atomic batch of 5 calls (approve USDC, swap, approve WETH, supply, borrow), fewer when allowances already cover | 5 |
| Signatures | 2 | 1 | 5 |
| Network switches | 0 when on Arbitrum | 0 when on Arbitrum (1 if the wallet is elsewhere, shown) | same |
| Gas payer | owner | owner (no paymaster, no `capabilities` sent) | owner |

PG-asserted counts:
- Grouped: `walletPrompts 1, signatures 1, transactions 1, batchedCalls 5, networkSwitches 0`.
- Unsupported wallet: `STEP_BY_STEP, walletPrompts ≥ 3 (atLeast)`.

## G. Latency: before and after

**Before** (PRODUCTION-LOG, step 1 only, server time): prepare 7.2 s + review 0.3 s + begin 9.9 s + refused begin 10.4 s + refresh 11.7 s +
review 0.4 s + begin 11.1 s + observes about 7 s, ≈ **58 s of server time for one step**. Step 2's simulate then spent 8–9 s and was refused.
Simulate previews took 4.06 s.

**After.** Only the call counts below were measured. Production wall time is not measured until an owner-approved deploy.
- **Grouped Review/prepare: 9 RPC calls.** `eth_call` ×3 (two quotes and an allowance), `eth_blockNumber` ×2, `eth_simulateV1` ×1,
  fee reads ×2 and `eth_getBalance` ×1. They run **unpaced** on the user-funded RPC. This replaces the per-step prepare, begin, refresh and
  review chain, and the Aave override discovery, which made sequential paced reads on the shared Railway transport.
- **Authorize** reuses the same prepare once more (fresh quotes); nothing else is chained.
- **Quote cascade.** Before: every edit re-quoted every Swap/Bridge card (key = whole workflow and revision) and blanked it. After: an edit
  of Supply or Borrow re-quotes **0** swap cards, and an edit of the swap re-quotes **1**. Expired quotes refresh only while the page is
  visible. Regression test in `build-estimate.test.ts`.
- **Aave pacing.** The fixed 150 ms pause before each read is now "wait only the remaining spacing". This gains up to 150 ms per read when
  the RPC round trip is already ≥ 150 ms, and little when it is faster (honest: a modest gain).
- **Not changed (owner configuration).** Railway's dedicated read RPCs are **not assumed**. With the public RPC, the serial 250 ms pacing for
  catalog quotes remains (§I).

## H. Tests

**New tests.**
- `user-funded/arbitrum-batch.test.ts` (9): buildability, 5 calls, simulation and HF, reconcile, allowance skip and reset, unsafe HF, beyond
  collateral, simulation unavailable; a batch sent from an earlier preparation reconciles after re-preparation; simulation-failure
  classification (method refusal vs lagging node); a user-operation group with an Aave step is refused.
- `editor/workflow-execution.pg.test.ts` (5): Review → Authorize → wallet batch → COMPLETED → reload; lost answer → expiry → re-preparation →
  the first batch still reconciles; ended runs do not count against the pending-approval limit; unsafe-HF refusal; STEP_BY_STEP for
  unsupported atomic.
- `components/user-funded-browser.test.ts` (3): only EIP-5792 status 400 is reported as "not sent".
- `workflow-runs/execution-groups.test.ts`: a post-bridge Aave group is a wallet batch signed when due, never an upfront user operation.
- Regressions in `server/arbitrum-lending.test.ts` (aeWETH index 52, ERC-7201), `server/supply-rpc.test.ts` (spacing) and
  `state/build-estimate.test.ts` (snapshot key, expiry, hidden page, cascade).
- **Playwright** `e2e/canvas-lending-amount-enter.spec.ts`, **Scenario A**: chat-authored Swap → Supply → Borrow; Supply edited with Enter,
  Borrow on blur, Swap after a typing pause. It asserts no proposal, the revisions and the IR amounts `3000000`, `1300000000000000` and
  `800000`. CI runs it in the `arbitrum-authoring-certification` profile (`playwright.arbitrum-authoring.config.ts`).

**Updated specs** (behaviour change, explained for review):
- Shared fixtures `composer-authoring-fixtures.ts` (`configureCanvasAction`) and `supply-fixtures.ts` (`authorSupply`) now apply lending
  amounts with Enter and assert that no proposal appears, instead of clicking "Review X change" and "Apply proposal".
- Updated specs: `copilot.spec.ts`, `base-mainnet-lending-catalog.spec.ts`, `workflow-ux-authoring.spec.ts`, `canvas-automation-ux.spec.ts`
  and `canvas-workflow-ux.spec.ts`.
- No test was deleted or skipped.
- Diagnostic specs that are not in any CI profile still encode the old lending Review/Apply flow: `card-numeric-entry`,
  `composer-product-cleanup`, `crypto-action-picker`, `build-layout` and `build-empty-mascot`. They were not updated; they are listed here
  for the owner.

**Not covered.** There is no browser e2e for the grouped `wallet_sendCalls` journey in the Editor, including the lost-answer recovery in the
browser hook. Its proof is UNIT and PG on the EVM double with `eth_simulateV1`, plus code review.

**Local browser results.**
- **Pass:** `canvas-automation-ux`, `copilot`, `supply-provenance`, `unsafe-lending-simulations`, `review-execute-recovery-components`,
  `workflow-ux-authoring`, `base-mainnet-authoring`.
- **`default-product` fails locally on 11 tests, and every one fails identically on unmodified `origin/main` in this sandbox.**
  - **Screenshot baselines (9):** sandbox fonts. The pixel diffs are identical on `main`.
  - **`build009` (2):** they need a live LI.FI quote from `li.quest`, which the sandbox cannot reach.
  - CircleCI is the authority for this profile.

Gate results are recorded in the PR description: `pnpm check`, PostgreSQL suites, governance-lite, `agent_guard review` and CircleCI.

## H.1 Engineering review (specialists) and what changed

Read-only specialist reviews were run per `agent_guard` impact: wallet-execution, security, workflow, lending, swap, protocol-integrations and
frontend-ux. Every major finding was verified in code and fixed, with a test where one is practical:

| Finding | Fix |
|---|---|
| A batch the wallet sent, whose answer was lost, was shown as "Nothing was sent". It could be ended, prepared again, or sent twice by a wallet that ignores the app id. | The browser keeps the id the wallet answered with, per workflow, and reads the batch back before any re-preparation or re-send. Recovery is automatic for PREPARED groups, and End is hidden while the batch may be in the wallet. |
| Re-preparing an expired batch under the same EIP-5792 id made a batch sent earlier reconcile as FAILED. | The new artifact keeps up to 8 earlier preparations, and reconciliation matches the one the batch came from (unit and PG tests). |
| Statuses 500 and 600 (chain failure, partial) were reported as "not sent". | Only 400 means not sent. Otherwise receipts are reported, or the batch stays pending (unit test). |
| The "lower minimum" confirmation could be skipped or hidden by the poll. | It runs on every preparation, fails closed without planned values, and the poll keeps it visible. |
| The run pointer was deleted on any status refusal, and one global key was shared across workflows. | The pointer is kept unless the run no longer exists, keyed per workflow. Sign-in is retried. |
| Authorize was not bound to the Review (wallet, workflow, plan). | The reviewed wallet must be the proven one. The frozen reviewed workflow is sent, and the server refuses a different hash or group plan. The Send recipient is shown in full and checked again. |
| A failed Review locked the step-by-step path. Availability did not require an account session. Reviews had no rate limit and did not register catalogs. | Fixed as named. 30 Reviews per account per 10 minutes. |
| The claim auto-started confirm-each-step when grouping was not fewer, which orphaned the Editor's run. | The Review offers grouping only when it asks fewer times, the claim's own rule. |
| Failed Authorize attempts filled the pending-approval limit. | A claimed handoff whose run ended no longer counts (PG test). |
| User-operation groups with Aave steps skipped the HF and supply-cap simulation (pre-existing). | The planner never makes one, and the builder refuses one: `USER_OPERATION_AAVE_SIGNED_WHEN_DUE`. |
| Transient node lag was read as "this RPC cannot simulate". | Simulation runs at `latest`. Only method-level refusals mean unsupported. |

Not changed:
- **No swap deadline.** The batched swap call carries no on-chain deadline; this is a pre-existing call template. The Review now says
  so. Re-encoding the swap with a deadline (SwapRouter02 `multicall(deadline, …)`) is left for a follow-up.
- **Count copy.** The wallet-confirmation count now also names a possible network switch and the one-time sign-in message.

## I. Configuration (names only; no secret read or shown) — **[OWNER]**

1. **`FLOFI_USER_FUNDED_RPC_<chainId>` must answer `eth_simulateV1`** (Ethereum, Base, Arbitrum). Without it, batches containing Aave calls are
   refused with `USER_FUNDED_SIMULATION_UNAVAILABLE`; batches without Aave fall back to the gas-estimate path. Check it read-only with:
   ```bash
   curl -s "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_simulateV1","params":[{"blockStateCalls":[{"calls":[]}]},"latest"]}'
   ```
   (`$RPC` comes from the owner's own secret store and is never pasted into chat.) The sandbox used for this build could not reach public RPCs,
   so this was **not verified here**.
2. Existing flags, unchanged:
   - `FLOFI_WORKFLOW_RUNS=enabled`;
   - `FLOFI_USER_FUNDED_EXECUTION=enabled`;
   - `FLOFI_USER_FUNDED_CHAINS`;
   - `FLOFI_EDITOR_WORKFLOW_RUNS` (not `disabled`), plus the session secret and public origin.
3. **Optional, for quote latency:** keyed `GRYLOO_*_RPC_URL` with `GRYLOO_RPC_READ_PROFILE=dedicated` on Railway `flofi-api`. Without them,
   catalog quotes keep the public RPC's serial pacing.
4. **No new variable or secret, and no migration.** The Editor path reuses `workflow_runs` and `workflow_run_groups` (migration 0023).
5. **Recovery:** two `SUBMISSION_RESULT_UNKNOWN` runs from the earlier session remain for the owner to observe; they are never resubmitted
   automatically.

## J. Limitations and open items

- **Grouped path scope.** It covers plans whose groups are all wallet-grouped. Plans with an owner-step group use the per-step fallback,
  with the reason shown.
- **Expired prices.** When the reviewed prices expire, they stay visible marked "Expired at …", Authorize is disabled, and the owner reviews
  again. A due group whose preparation expired is prepared again from fresh facts under the same batch id (never a second batch). "End
  workflow" is refused during a prepared group's 10-minute validity. On the Canvas, an expired quote stays visible marked "Quote expired:
  updating".
- **Per-wallet behaviour.** MetaMask `ready` (account not yet upgraded) prompts MetaMask's own upgrade once. Wallets that report EIP-5792
  but not `atomic` fall back to owner steps.
- **Supply settings form.** A changed beneficiary, network or asset there is still a reviewed proposal; the beneficiary is security
  relevant. The Canvas card applies token and reserve picks directly.
- **Grouping must ask fewer times.** A workflow whose grouping would not ask the wallet fewer times than its steps uses the step-by-step
  path; for example, one step on each of two networks. The reason is shown.
- **Wallets that ignore the app id.** For a wallet that ignores the app-provided EIP-5792 id, protection against a second send is the
  id kept in the browser. Clearing site data during the wallet prompt removes it, and the wallet is then the last guard.

## K. Release — owner only

Owner steps (merge, deploy, configuration and the first real-funds run) are the owner's decision. Suggested first evidence after
deploy, with a small amount and the owner's own wallet: Scenario A on Arbitrum One from the Editor. Record the batch id, transaction hash,
gas paid and payer, and the health factor after; only that would raise the evidence level for this path.
