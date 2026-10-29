# BUILD-FLOFI-CHAT-E2E-FIX-002 — Multi-action chat workflows, honest Review and status, ETH ≠ WETH

Branch `claude/build-flofi-chat-e2e-fix-002`, based on `main` 59d8f19 (PR #134). Implementation, not a plan. All engineering evidence is local
and MOCKED (loopback harnesses, scripted test wallets, committed replay answers). Nothing was quoted from a public provider, signed by an owner
wallet or sent to a public network. No production system, environment variable, migration, fee or Vercel/Railway/Neon setting was touched.

## 1. Diagnosis of the production observations

| Observation | Root cause (verified) |
| --- | --- |
| Chat added Swap, then appended Bridge; **chat and manual simulation both failed** | Every owner-wallet runtime FloFi has serves exactly one action. The linter refuses a two-action workflow as a whole (`ROUTER_ISOLATED_ONLY` for a certified Router bridge, `UNIVERSAL_ISOLATED_ONLY` for a universal bridge, `CATALOG_SWAP_ISOLATED_ONLY` for catalog swaps). That `reviewError` makes `invalidWorkflow` true, so the Canvas CTA and the chat's "Review workflow" are both blocked. `selectOwnerRuntime` also picks the runtime from **one** action (the bridge), so even an unblocked simulation could only ever cover the bridge. Reproduced by `workflow-sequence.test.ts` ("reproduces the production failure"). |
| Two independent swaps "cannot be one route" | They lint together, but the public swap runtime takes one swap only. The previous browser spec even asserted this failure as expected behavior. |
| Native ETH cannot be selected; **WETH used instead** | `catalog-swap-authoring.ts` rejects native assets (`SWAP_NATIVE_ASSET_UNSUPPORTED`). The Canvas swap picker offers only ERC-20s. The Copilot (`copilot-authoring.ts` `catalogToken`, and the Base reference-pair branch) **resolved "ETH" to WETH** and only added a note. |
| Bridge run "Not started", "Needs attention", "0 of 1 actions completed", waiting operations | A bridge simulation creates a durable run (`PREPARED`/`QUOTED`) before any wallet request. For such a run the dashboard combined "Not started" with a generic "Needs attention" (from `errorCode` / `attentionRequired`), the lifecycle message "0 of 1 actions completed. Each new wallet request requires your explicit confirmation.", and operations labelled "Waiting", as if a wallet request were pending. "0 of **1**" also shows the run only ever covered one action of the workflow. |
| Wallet on Arbitrum while the source operation is on Base | `requiredSigningChain` correctly asked for Base, but the chat only said "switch, then ask me again" and never continued. In a two-action workflow the required chain came from the canonical workflow's first node, not from the step being reviewed. |
| Execute after confirmation sometimes silent | Found while testing: the swap store keeps a start failure (e.g. `INSUFFICIENT_INPUT`) as its own error without rejecting, so `requestFailed` never became true. The chat then stayed on "Opening the reviewed wallet request" indefinitely, with no execution record and no reason. |

## 2. What changed

### P0.1 — complete workflow simulation and sequential execution (`domain/workflow-sequence.ts`, `state/workflow-store.tsx`, `components/app-shell.tsx`)

* A workflow of **several independent owner-wallet actions** that no composition runtime serves as a whole (lending composition, the Solana bound
  composition, the engineering graphs and anything with resource edges keep their paths) is a **sequence**: the actions run in Canvas order
  (dependency order, else authoring order), each **through its own existing runtime**, one step at a time.
* `runtimeWorkflow` is what every owner-wallet runtime serves: the current step's **projection** (the canonical workflow with only that node,
  same id and revision), validated with its own network's trusted review context. The public swap, certified Router, universal Router, Jupiter,
  Solana transfer, EVM transfer and Aave stores read it. For a workflow that is not a sequence, it is the same object as `state.workflow`, so
  their behavior is unchanged. The Canvas, chat authoring and saving keep the canonical workflow.
* **Funding.** Step k is funded by the latest earlier step that delivers exactly k's input asset (chain + address + decimals, native = no
  address) to the owner's own wallet. A funded step is simulated only after its producer reconciled, and spends **min(authored amount, amount the
  producer's reconciled record proves it delivered)**. This is FloFi's existing binding rule (`engine/workflow-bindings.ts`). The bound amount is
  re-authored through the card's own amount command and never edits the owner's workflow. Delivered amounts are read only from reconciled
  records (`deliveredByRecord`: public swap `outcome`, universal `received` with verdict `RECONCILED`, Router fill `transferAmount`). Independent
  steps spend their authored amounts.
* **Hand-off.** A step hands over only when its run is final and every action of it is confirmed. When a later step spends its output, the
  hand-off also waits for the reconciled record to prove the delivered amount. Nothing is submitted by the hand-off: the next step needs its own
  fresh simulation, Review, two chat confirmations and the wallet's signature. Executed steps are kept only while the workflow still holds
  exactly those nodes.
* **Exact missing capability, before step 1.** Every step's runtime is resolved up front. A step without a sequence-capable runtime ("Step 2
  (Supply on Base) cannot run as part of a multi-action workflow yet: FloFi executes this action only as its own workflow"), or whose provider
  this deployment does not serve ("…cannot run on this deployment: its provider is not available here"), blocks the review before anything
  runs. A workflow is never left half-executed by design. A provider whose availability has not answered yet is *unknown*, not unavailable, and
  the chat waits for it.

### P0.2 — chat-first simulation (`state/flofi-conversation.ts`, `domain/conversation-lifecycle.ts`)

* "Review workflow" / "simulate" / "revisar" (existing grammar) run the real simulation of the current step without leaving the chat.
* **Unapplied Canvas amount**: named with the step, action and typed value; applied ("Apply it"/"Aplicar") or discarded ("Discard it"/"Descartar")
  only on an explicit answer, through the same card actions the Canvas uses. A refused apply says why. The review then continues by itself.
* **Wallet on another network than the step**: the chat offers the existing network switch (`wallet_switchEthereumChain` through
  `useWalletConnection`). Once the wallet reports the step's network the review continues by itself; a failed or rejected switch is reported.
* The required signing chain is the current step's chain.

### P0.3 — native ETH (`domain/copilot-authoring.ts`, `domain/commands.ts`, `domain/copilot-messages.ts`)

ETH and WETH are now always distinct in authoring. A swap that names native ETH on an EVM network is **refused with the missing capability**
(Copilot and the deterministic chat grammar), never authored as WETH. An explicit WETH swap is unchanged. See §3 for the audit and what is
**not** implemented.

### P0.4 — minimal chat Review (`components/conversation-cards.tsx`, `simulate-workspace.tsx`, `execute-workspace.tsx`, `globals.css`)

* In the public chat-first workspace, Simulate and Execute show the canvas (or timeline) beside the chat. The Simulation Summary and Execution
  Summary move into an optional, collapsed **"Simulation details" / "Execution details"** surface under it, so there is no third column.
  "Connect execution wallet" and "Create new workflow", which only that summary offered, stay visible beside the collapsed details. The `/approve`
  signing surfaces and the engineering workspace keep their existing layout.
* In a sequence, the Canvas action and the Simulation summary name the step they serve ("Step 1 of 2: Swap. Each step is simulated, reviewed
  and signed on its own, in order; this result covers this step only."), so a Canvas-only user never reads one step's result as the whole
  workflow's.
* The chat Review lists **every action in order** with its state ("Simulated now", "Simulated with a fresh quote after step N reconciles; you
  confirm it separately", "Completed and reconciled · delivered X"), amounts, networks and funding. For the step simulated now it shows the
  estimated output, minimum received, slippage and price impact. Then come the network, provider and FloFi fee lines, and an **Estimated total
  cost**: exact per-asset decimal sums of the simulation's own fee lines, with what it excludes listed (costs the simulation does not provide,
  later steps not simulated yet). Missing values say "Not provided by this simulation", and nothing is estimated or converted. Material risks
  include the sequence risk ("runs as N separate wallet transactions; earlier steps stay executed if a later one fails"). Approvals and limits
  sit in an optional details element.
* FloFi fee: shown exactly where the step's runtime records it (the universal Router's 0.1% obligation). No fee was invented for runtimes that
  record none, and fees were not changed.

### P0.5 — chat-driven execution

"Do you confirm this workflow?" (step 1) / "Do you confirm step k of n?" → "Would you like to execute step k of n now?" → the existing
Authorize-in-wallet control. Progress and reconciliation come from the durable record. A completed step announces what it delivered and
simulates the next step by itself (read-only); the last one says "All n steps … are completed and reconciled". A wallet request that cannot
start is reported with the runtime's classified reason (e.g. "Your available balance is too low for this workflow"), and nothing is retried.

### P0.6 — honest status (`domain/execution-lifecycle.ts`, `lib/dashboard/run-mapping.ts`)

A record with no wallet request is "Not started" with "Simulated or reviewed only: no wallet request was made, so nothing was sent." Its
operations read "Not requested", not "Waiting". A recorded issue of such a run ("The simulation or Review recorded an issue before any wallet
request, so nothing was sent") is not presented as "Needs attention". Runs that reached the network keep their attention items. History is
unchanged. The existing distinctions remain: declined (Transaction not submitted), partial, failed, uncertain and completed.

### P0.7 — layout

The browser test asserts, at 1920/1440/1280/1024/390/375 px, for Build, Simulate and Execute:
* one stage column;
* summaries hidden but one click away;
* chat ≥ 300 px wide, beside the stage above 1280 px and stacked below at full width at or under 1280 px;
* the chat input reachable;
* no horizontal overflow, with details closed or open;
* the in-chat Review never overflowing its column.

## 3. Native ETH audit (Base, Arbitrum One, Ethereum, Robinhood Chain)

| Action | Native ETH today | Notes |
| --- | --- | --- |
| Send | Supported | Native transfer runtime (`asset.transfer`). |
| Bridge | Supported | Universal Router (Relay) `NATIVE` input/output (`depositNative`), distinct identity (`nativeId`, no address). |
| Swap | **Not supported** | The catalog swap IR binds ERC-20 addresses. The swap service (`server/public-testnet-service.ts`) quotes, approves, sends `value: 0x0` and reconciles ERC-20 balances and receipt logs only. MCP `composeStrategy` already refuses (`ACTION_ASSETS_UNSUPPORTED`). |
| Wrap / unwrap (WETH9) | **Not supported** | No action, runtime or reviewed call exists. |

**Not implemented in this build (explicit limitation).** Native-ETH swaps through Uniswap SwapRouter02 need changes across that real-funds
service:
* payable `exactInputSingle` with `msg.value` and no approval step;
* `multicall(exactInputSingle → router, unwrapWETH9(min, owner))` for native output;
* native-balance reconciliation net of the exact receipt gas cost (and the OP-Stack L1 fee);
* receipt verification of the WETH Deposit/Withdrawal events, the strict owner-bound review (Arbitrum/Ethereum), the concurrency proof path;
* a native side in the catalog swap IR, linter and hash.

Wrap/unwrap needs a WETH9 runtime (deposit/withdraw, 1:1 verification). This is a dedicated real-funds build; doing it partially here would
weaken the fail-closed guarantees. What *is* guaranteed now: no path silently substitutes WETH for ETH, and the refusal names the missing
capability. Separately, the landing page's assistant demo prompt "Swap 0.5 ETH to USDC on Base." advertises a native swap that FloFi refuses.
That is marketing copy with golden screenshots, left for the owner to decide.

## 4. Tests

Unit (Vitest, repository root): `workflow-sequence.test.ts` (production reproduction, ordering, projection, funding, bound amount through the
card command, completion history, delivery proofs, ETH ≠ WETH in the chat grammar), `flofi-conversation.test.ts` (unapplied edit
apply/discard/refused, network switch resume and rejection, sequence step-by-step Review and hand-off, delivery wait, finished sequence, step that
cannot run, start that ends without a record), `conversation-lifecycle.test.ts` (edit answers, exact per-asset cost sums), `run-mapping.test.ts`
(never-started runs), Copilot corpora/evaluations updated for the ETH refusal.

Browser (`e2e/chat-sequence.spec.ts`, profile `execution-continuity`; MOCKED loopback swap harness now pricing USDC ⇄ WETH both ways, with
loopback-only controls for balance and quote availability):
1. Funded Swap → Swap. Step 1 reviewed, confirmed, signed (approval + swap) and reconciled. Step 2 is simulated by itself and spends exactly what
   step 1 delivered (0.0005 WETH, capped at the authored 0.001 WETH), then is confirmed, signed and reconciled: 4 wallet sends. The canonical
   workflow is unchanged.
2. Independent steps with an unapplied Canvas amount: named, a refused apply explained, discarded in PT-BR, then the review continues. Both
   authored amounts are kept.
3. Wallet on Arbitrum Sepolia for a Base Sepolia step: one `wallet_switchEthereumChain`, then the review continues by itself.
4. Missing provider quote (quoter revert) → "The simulation did not produce a review"; balance too low → the wallet request never starts and the
   reason is shown; 0 sends.
5. Layout at six widths (above).

`conversational-workflow.spec.ts` was updated: two independent swaps are now reviewed as a sequence (the old expectation encoded the production
bug). `copilot.spec.ts`: "Swap 100 USDC to ETH on Base" is refused, and the explicit WETH request is authored (a matching entry was added to the
committed replay answers). Specs that read the Simulation/Execution summaries in the public `/app` workspace now open the details surface first:
`execute-product-workspace`, `workflow-ux-execution`, `acceptance-workflows`, `acceptance-swap-read`, `canvas-automation-ux` and `visual-shell`.
The two `visual-shell` goldens (`simulate.png`, `execute.png`) were regenerated. Their changed pixels are confined to the stage area left of the
chat (x 20–1079, below the header); the header, chat and `build.png` are unchanged, and the new goldens pass without updating.

**Not covered by a browser execution (honest):** a Swap → **Bridge** sequence executed end to end. No loopback harness lets the owner authorize a
bridge: MOCKED Router and universal provenance keep "Authorize in wallet" disabled by product rule. Swap → Bridge is covered by unit tests of the
sequence, funding, Router/universal delivery proofs and runtime selection. Its browser coverage is the same sequence machinery on two swaps, so
step 2 being a bridge is not exercised in the browser. Quote expiry between the two confirmations is covered by unit tests (existing and new),
not in the browser. No real-provider read-only evidence was produced in this build.

## 5. Gates (local, final tree)

* `pnpm typecheck` ✓; `pnpm lint` ✓; `pnpm build` ✓; `pnpm schemas:check` ✓ (11 exports).
* `pnpm test`: 5465 passed, 2 skipped (pre-existing), 0 failed.
* PostgreSQL suites touching changed modules (learning, WhatsApp channel journeys): 57 passed on a disposable pinned PostgreSQL 18.6.
* `python3 scripts/governance_lite.py` ✓, its unittest suite (19) ✓, the CI orchestration tests `test_ci_*.py` (64) ✓, `git diff --check` clean.
* Guarded browser product phase (`node scripts/guarded-release-browser.mjs profile <name>` with CI's environment, every one of the 48 product
  profiles). 41 passed on the first pass. The 7 that failed did so only on intended layout changes (summaries now collapsed details, two
  goldens, one replay answer); after updating those specs they all passed on the final build.
* Not run locally: the `composition` phase (its spec uses the engineering workspace, whose layout is unchanged) and the fork suites (no fork code
  changed). CircleCI is authoritative.

## 6. Remaining limitations

* Native ETH swaps and WETH wrap/unwrap are not implemented (§3).
* The sequence position (which step is current, what earlier steps delivered) lives in this browser visit. Each step's run is durable and
  recovered as before. After a reload in the middle of a sequence, the in-flight step's run is recovered and observed, but the chat does not
  resume the remaining steps by itself; the owner reviews them again.
* Positions (Uniswap/Orca liquidity), the Solana composition and engineering/fork paths are not offered as sequence steps. The chat names the step.
* Multi-action workflows from MCP/Telegram keep their existing server-side workflow runs (`FLOFI_WORKFLOW_RUNS`); this build does not change
  those boundaries.
