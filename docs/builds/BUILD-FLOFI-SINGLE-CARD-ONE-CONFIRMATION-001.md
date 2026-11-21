# BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 — one wallet confirmation for single financial cards

**Goal.** For every eligible single-action card: one FloFi authorization click → ONE wallet confirmation → automatic execution → automatic
reconciliation → final result. No new banners, modals, labels or technical text; nothing signed or sent without the owner's explicit click.

**Owner decision (this build).** The engine change ships now. It stays **dormant** until the operator applies the certified migration
`0032_single_step_runs` ([release procedure](../deploy/RELEASE-SINGLE-STEP-RUNS-0032.md)). Until then single cards keep today's flows. The
automatic-reconciliation improvements for per-flow cards apply right after deployment.

## 1. Root cause

1. **Single cards never reached the atomic engine.** Three gates kept a one-card Canvas workflow off the user-funded execution groups, which
   already fold exact approvals into one EIP-5792 `wallet_sendCalls`, simulate the whole batch and reconcile independently:
   - `workflowSequence` returns `null` for fewer than two actions (`domain/workflow-sequence.ts`).
   - So `useEditorWorkflowRun({ enabled: Boolean(sequence) … })` in `components/app-shell.tsx` stayed disabled.
   - The server's `editorWorkflowStrategy` refused `EDITOR_WORKFLOW_SINGLE_STEP`.
2. **The run engine could not hold a one-step run.**
   - `startEditorRun` required a `SEQUENTIAL` plan of ≥ 2 steps.
   - `requestApproval` / `workflowPlan` / `evaluateWorkflowGates` turn one step into `SINGLE_FLOW`.
   - `ensureForClaim` refused fewer than two steps.
   - The database enforces `workflow_runs.step_count CHECK (BETWEEN 2 AND 8)` (migration 0015).
3. **Every per-flow single-card runtime models the approval as its own wallet request.**

   | Runtime | Approval handling | Extra owner action before the second wallet prompt |
   | --- | --- | --- |
   | Catalog swap (`public-testnet-service.ts`) | `step: 'approval' \| 'swap'`, separate `eth_sendTransaction` | "Continue to swap". On Arbitrum One / Ethereum: a new Review and a second "Authorize in wallet" |
   | Aave supply / repay (`supply-service.ts`) | `APPROVAL` step | "Continue to wallet" |
   | Router / Relay bridges | approval step | "Continue to bridge"; plus a `personal_sign` at Simulate without a session |
   | Uniswap mint | `APPROVE_TOKEN0`, `APPROVE_TOKEN1`, `MINT` | Up to three requests |

4. **Some per-flow stores observed only once after the hash.** Supply and transfer did; the Uniswap stores stopped after 20 × 2 s. The
   Canvas then showed a manual "Check confirmation".

## 2. Architecture (minimal; no parallel execution system)

The single card runs through the **existing** Editor whole-workflow path, as a user-funded workflow run of ONE step. It reuses the existing
pieces unchanged:

- planner: `planExecutionGroups`
- call builder: `buildEvmGroupCalls` (exact approval only when the allowance is short; reset to 0 first if non-zero; never unlimited)
- whole-batch simulation
- browser EIP-5792 sender (attempt marker, stable id, 5720 read-back)
- server reconciliation from chain receipts
- recovery: hand-out token, no second live batch, `WALLET_BATCH_OUTCOME_UNKNOWN` → HALTED

| Change | Where |
| --- | --- |
| Editor-only opt-in `singleStepRun`: a SEQUENTIAL plan of one step. Refused (`APPROVAL_REQUESTER_INVALID`) for MCP, Developer API, channels and automations, which keep their one-step `SINGLE_FLOW` contract | `platform/approvals.ts` |
| `{ run?: boolean }` plans and gates one step as a run (adds `WORKFLOW_RUNS_NOT_ENABLED`). Default unchanged | `mcp/execution.ts` |
| A stored SEQUENTIAL plan is re-verified as a run; a run is always evaluated as a run | `platform/approvals.ts` `verifyHandoff`, `workflow-runs/service.ts` |
| One-step runs only for `EDITOR_SESSION` handoffs (others still need ≥ 2) | `workflow-runs/service.ts` `ensureForClaim` |
| `editorWorkflowStrategy(input, { singleStep })`: the card lints alone, is read into its chat command and must reproduce exactly. Its strategy and hash are the step's own (the MCP / Developer identity) | `editor/workflow-strategy.ts` |
| Review / Authorize pass the opt-in only when `singleStepRunsSupported(db)` finds the exact certified 0032 identity in `schema_migrations` (fail closed). Availability reports `singleStep`. A non-exported `startSingleCardRun` keeps "Run workflow" multi-step only | `app/editor-workflow-execution-action.ts`, `workflow-runs/pg-store.ts`, `editor/approval.ts`, `editor/workflow-execution.ts` |
| A single EVM card whose runtime the groups build (`SINGLE_CARD_RUNTIMES`: catalog swap, Router bridge, transfer, Aave) enables the hook when single-step runs exist. A Review that is not one confirmation, or that refuses the batch, falls back to the card's own flow, whose read-only simulation continues at once (Router / Relay wait for the click, because they may ask a sign-in). A completed one-step run is recorded as the executed first step, so an added action continues from it | `components/app-shell.tsx`, `domain/workflow-sequence.ts` |
| A stored run of the shown workflow is followed whatever the availability answer, so a started card is never offered again. The one-confirmation mechanism sentence is omitted for one step | `components/editor-workflow-run.tsx` |
| `0032_single_step_runs`: `step_count BETWEEN 1 AND 8`, nothing else. Certified for the v28 build, operator-applied on exact schema 31 (`single-step-runs-migrate`) | `packages/cloud-runtime`, `admin/cli-commands.ts`, `docs/deploy/SCHEMA-COMPATIBILITY.md` §24 |
| Per-flow stores follow a submitted request automatically to its final verdict, strictly read-only, and expose `following`. The Canvas shows the existing "Reconciling…" status instead of a manual check, which returns only if the follow ends unsettled | `state/{supply,robinhood-transfer,uniswap-liquidity,uniswap-position,public-testnet}-store.tsx`, `state/execution-controls.ts` |

## 3. Wallet interaction matrix (owner wallet prompts; the target wallet is MetaMask reporting EIP-5792 `atomic` on the card's chain)

"After" assumes 0032 is applied and user-funded execution is enabled for the chain. Counts are **wallet confirmations** (prompts). Reading
capabilities and batch status (`wallet_getCapabilities`, `wallet_getCallsStatus`) never prompts.

| Card (networks) | Before (FloFi clicks / wallet prompts) | After | Notes |
| --- | --- | --- | --- |
| Catalog swap ERC-20 → token, allowance short (Base, Arbitrum One, Ethereum; Robinhood pinned assets) | 2 / 2 `eth_sendTransaction` ("Continue to swap"; on Arbitrum One / Ethereum a second Review + Authorize) | **1 / 1 `wallet_sendCalls`** [approve exact, swap] | Approval is folded in only when short |
| Catalog swap, allowance sufficient | 1 / 1 | **1 / 1** [swap] | |
| Aave Supply / Repay, allowance short (Base, Arbitrum One, Ethereum) | ≥ 2 / 2, plus manual "Check confirmation" | **1 / 1** [guard, approve exact, action] | Health factor proven by the batch simulation |
| Aave Borrow / Withdraw | 1 / 1, plus manual check | **1 / 1** [guard, action], automatic reconciliation | |
| Transfer, catalog ERC-20 / native to an EOA | 1 / 1, plus manual check | **1 / 1** [guard, transfer], automatic reconciliation | Stock Tokens and contract recipients keep their own flow |
| Certified Router bridge (Across, same asset, to the owner) | Up to 3 (sign-in at Simulate, approve, deposit) / 2 clicks | **1 / 1** [approve exact, deposit]; the run completes on the verified fill | A sign-in is asked only if no 8-hour wallet session exists |
| Solana swap / transfer / Orca position | 1 / 1 | 1 / 1 (unchanged) | Already one `solana:signTransaction` |
| **Not one confirmation (unchanged, never presented as one)** | | | |
| Universal (Relay) bridge, LI.FI or explicit-recipient Router routes | Up to 3 / 2 | Unchanged | No batch builder |
| Uniswap add liquidity | Up to 3 / 3 | Unchanged | No batch builder for `mint` |
| ERC-20 → native ETH swap, Stock Token swap | 2 / 2 | Unchanged | No batch builder for these paths |
| Robinhood Chain 0x Gasless swap | 1–2 typed-data signatures | Unchanged | Its permit may be unlimited; never presented as compliant |
| Any card with a wallet without EIP-5792 atomic, or FloFi Wallet (Privy, no `wallet_sendCalls`) | As before | As before | The Review plans `STEP_BY_STEP`; the card keeps its own flow and its existing wording |
| Any card before 0032 is applied (right after this deploy) | As before | As before, with automatic reconciliation | Dormant gate |

**Circle-paid fee (ADR-0010).** When the owner's ETH cannot pay and Circle is eligible, a group needs two signatures (a USDC permit, then the
operation). That is shown honestly as two wallet requests, never as one.

## 4. Evidence (deterministic MOCKED chains; CI evidence only — no public execution, no real funds)

| Suite | What it proves |
| --- | --- |
| `apps/reference-dapp/src/editor/single-card-run.pg.test.ts` (PostgreSQL, schema 32) | **Mandatory scenario: Arbitrum One + MetaMask, Uniswap V3 "Swap 0.0006 WETH → USDC", allowance short.** Review: one confirmation, `[approve(router, 0.0006 WETH exact), swap]`. One SEQUENTIAL EDITOR_SESSION handoff of one step and one run. Exactly ONE wallet batch (counted at the chain double); FloFi submits nothing itself. Automatic reconciliation from the chain to COMPLETED (spent exactly 0.0006 WETH, received ≥ minimum, allowance back to 0). Reload: nothing prepared or sent again. Also covered: existing allowance (no approval call); non-zero allowance (reset, then exact); a declined prompt (same batch on retry, never a second; wallet-reported "not sent" stops the run, nothing executed); insufficient balance and provider failure (refused at Review, nothing stored); unsupported / unknown capabilities and FloFi Wallet (`STEP_BY_STEP`); native-ETH swap (not batched); unanswered batch (never resent; HALTED with `WALLET_BATCH_OUTCOME_UNKNOWN`); dormant gate (a schema-28 database refuses the run row, a tampered ledger is not 0032); a channel one-step request keeps SINGLE_FLOW and cannot opt in |
| `apps/reference-dapp/src/editor/single-card-review.test.ts` | Every eligible card is one confirmation with the exact calls: swaps on Arbitrum One / Base / Ethereum (short and sufficient allowance; atomic `ready`); Aave Supply, Borrow, Repay, Withdraw; ERC-20 and native transfers; the Across bridge. Never one confirmation: unsupported or unknown capability, FloFi Wallet, native-ETH swap, a chain the wallet does not batch |
| `apps/reference-dapp/src/editor/single-card-strategy.test.ts` | The single-step opt-in; MCP / Developer `SINGLE_FLOW` unchanged; run gates; Editor-only approval opt-in; `deliveredByRun` |
| `apps/reference-dapp/src/components/editor-workflow-run.single-card.test.ts` | Hook: off without `singleStep`; one Authorize → exactly one `wallet_sendCalls`, no `personal_sign` with a session, automatic report; reload follows the completed run without resending; a step-by-step Review goes back to the card's own flow |
| `apps/reference-dapp/src/state/{supply,robinhood-transfer}-store.test.tsx`, `uniswap-*-store.test.tsx`, `execution-controls.test.ts` | Automatic read-only follow to the final verdict after one confirmation; a reload resumes it; one `eth_sendTransaction`; no manual check while following |
| `packages/cloud-runtime/test/certificate-0032.pg.test.ts`, `apps/reference-dapp/backend/single-step-runs-migrate.pg.test.ts`, `forward-compatibility.test.ts` | Migration bytes and certificate; a catalog diff of exactly one constraint; the v28 build serves schema 32 only with this certificate; rollback; operator command |
| `apps/reference-dapp/e2e/editor-single-card.spec.ts` (profile `editor-wallet-batch`) | The real Editor UI with an instrumented MetaMask-like wallet counting every EIP-1193 method (Base, the only MOCKED full-Editor harness) |

**Real-mainnet acceptance** (Arbitrum One, real MetaMask, real funds) is an owner action. It is possible only after the owner applies 0032
and is not claimed by this build.

## 5. Limitations (honest)

- **Dormant until 0032 is applied.** The operator procedure requires schema 31, i.e. 0029–0031 applied by their own procedures first.
- **EIP-5792 atomic is wallet-dependent.**
  - Wallets without it, and FloFi Wallet (Privy has no `wallet_sendCalls`), keep the per-flow flows.
  - MetaMask's `ready` → in-confirmation EIP-7702 upgrade is wallet behaviour, not verified against a real wallet here.
- **Other prompts the wallet may add.** A wallet on another chain may prompt `wallet_switchEthereumChain` before the batch. A first sign-in
  (EIP-4361) is asked once per 8-hour session if none exists; an existing session is reused.
- **Reconciliation of a wallet batch needs the hash from the browser.** The wallet's `wallet_getCallsStatus` report supplies it. If the tab
  closes after the wallet sends, the run waits (never expires a sent batch) until the owner reopens the page, where it is read back
  automatically.
- **In-app chat.** While the one-confirmation path is active for a single card, the chat treats it as it already treats multi-step runs: it
  points to the existing "Simulate workflow → Review operation → Authorize workflow" actions instead of driving the Review itself. This is a
  visible change for chat-driven single cards once 0032 is active. Authoring, explanations and the per-flow fallback are unchanged.
- **Same-chain wallet prompt.** If the wallet is on another chain, the batch sender asks `wallet_switchEthereumChain` inside Authorize. This is
  one more wallet prompt. Before, the per-flow path asked for the same switch behind a separate "Switch to …" click.

## 6. Specialist review (read-only reviewers, findings resolved in this PR)

- **Wallet execution**
  - A stored run now dominates the shell whatever the availability answer, so a started card is never offered again through its own flow.
  - Automatic observations are bounded at 30 s, so `following` can never hide the manual check forever.
  - The supply follow reads the latest attempt of its step.
  - Uniswap follows end quietly on a thrown read.
- **Workflow**
  - A completed single-card run is restorable after a reload (`workflow-run` in `RESTORABLE_RUNTIMES`). It is proven server-side by
    `editorSingleRunRecord` / `singleCardRunRecord`: one step, the card's own canonical hash, and its state.
  - The executed step's wallet is the run's own.
- **Security**
  - The single-card run is EVM-only server-side and only ever starts an EVM batch group.
  - A failed Authorize withdraws its own handoff.
  - The availability helper fails closed.
  - The ledger read follows the Review limiter.
  - The fallback auto-simulate never reaches a sign-in or the wallet selector.
  - Stale comments were corrected.
