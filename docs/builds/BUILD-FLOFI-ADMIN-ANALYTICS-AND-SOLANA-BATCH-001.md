# BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001

| | |
|---|---|
| Baseline | `origin/main` at `fed320e44ec7afc43ad4a2eb5959313ec97a98a2` (merge of PR #260, BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001) |
| Branch | `claude/compassionate-curie-fmhg6j` |
| Jira | KAN-25 (WS01, Admin execution counters by channel), KAN-20 (WS02, Solana Batch Payment) |
| Commits | WS01: `a7b4519`, `80db193`. WS02: `35a5a8a` (package core), `0a9c91c` (app), plus the review and record commits listed in the PR |
| Status | See [Final status](#12-final-status) |

Nothing in this build executes a real-money transaction, deploys, merges or changes production configuration. Every execution test runs on
offline mock chains, wallet doubles or closed loopback (evidence `MOCKED`). No migration, no new dependency, provider, vendor or paid service.

Scope is exactly two deliverables (owner instruction): (1) Admin counters of completed executions by originating channel; (2) atomic Batch
Payment on Solana Mainnet in the existing Batch Payment card, with Phantom and Solflare. Not redesigned: authentication, native channel signing,
mixed-network workflows, the Developer API, approval retention and the execution architecture.

## 1. Reuse

| Existing piece | Reused for |
|---|---|
| Admin Overview, `adminPage()` auth, `Section`, `admin-segmented` period links, `loadRuns` / `executionsOf` / `classifyRun` | WS01 section and its counting |
| `mcp_handoffs` (immutable `requester_kind`, `client_id`), `workflow_runs.handoff_id`, `run_ids` bindings, `cimdClientId` | WS01 attribution (read-only) |
| Batch Payment card, node grammar (`payment-NN-recipient/amount`), 2..8 limit, exact bindings, `batches[]` hash binding | WS02 authoring |
| Solana transfer compiler (legs byte-identical to `solanaTransferInstructions`), v0 codec, Lighthouse wallet guard verifier, offline mocks | WS02 transaction |
| User-funded `SOLANA_SIGN_ALL` group (CAS states, single submission, provable expiry), `/approve`, Wallet Standard signing | WS02 execution |
| Kora recovery scan algorithm (`recoverKoraTransaction` paging bounds) | WS02 duplicate-payment proof |

## 2. WS01: completed executions by channel

### 2.1 What one count is

One unique financial run that completed and reconciled:
- a `workflow_runs` row in state `COMPLETED`, with `completed_at` set, no step outside `RECONCILED`/`SKIPPED` and at least one `RECONCILED` step.
  A Batch Payment of up to 8 recipients is one run and counts once;
- or a single-flow execution (root run with its recoveries and composition steps folded in) classified `COMPLETED` (reconciled, nothing left to observe).

Never counted: owner-signed steps of a workflow run (`OWNER_RUN` outcomes) and live developer steps (`wfr_…-step-N`), simulations, quotes, approval
requests, rejected signatures, retries, reconciliation passes, recoveries, steps and Batch Payment recipients. An execution belongs to the period its
root run or workflow run was created in. Periods: Today (from UTC midnight), Last 7 days, Last 30 days (default), All time. The table shows the page's
environment; automation-rule runs are reported in a note, outside the table and its total.

### 2.2 Attribution (trusted server-side records only)

| Record | Origin |
|---|---|
| Workflow run | Its immutable handoff (`requester_kind`, `client_id`); a run whose requester kind differs from its handoff's is Unknown origin |
| Single flow | The handoffs whose `run_ids` name any of its runs (written only by the pre-existing `sharedRunsRead` and native signing); exactly one origin gives that channel, none or several give Unknown origin |

Channel mapping (`channelOf`, pure): `EDITOR_SESSION` FloFi Web; `DEVELOPER_PROJECT` Developer API; `AUTOMATION_RULE` automation note;
`CHANNEL_CONVERSATION` with `telegram:<bot id>` Telegram, otherwise Unknown origin; `MCP_ACCOUNT` with an exact CIMD client id on `chatgpt.com` or
`claude.ai` ChatGPT MCP or Claude MCP, anything else (DCR, other hosts, look-alikes) Unidentified MCP client. `client_name` is never read. No channel is
inferred from wallet addresses, amounts or timestamps. FloFi Web comes only from positive records (Editor workflow runs, and one-step runs an Editor
approval recorded); Web Chat and the Editor are one row because no record separates them.

`80db193` removed two parts of `a7b4519` after review: the simulation-time binder (it consumed the 16-run `run_ids` list, which makes native signing
fail closed and blocks the owner from deleting an unstarted simulation) and the time-based Web rule (`FLOFI_ADMIN_WEB_ATTRIBUTION_FROM`). No execution is
classified Web by time or by the absence of an approval.

### 2.3 Historical coverage and limits

- No backfill. Workflow runs keep their origin while the run and its handoff exist (the reference does not cascade). One-step runs are attributed only
  while a `run_ids` binding exists. Everything else is Unknown origin: direct app one-step runs, approval runs never recorded, earlier history.
- An approval records at most 16 runs (`0005`, `bindRuns`; unchanged). Approvals may be removed by retention (`HandoffStore.purge`); their bindings go
  with them. Observed, not fixed (out of scope): the single-statement purge fails while any old approval is referenced by a workflow run.
- A durable per-execution origin record was designed but not implemented in this build (owner scope instruction). Expect a large Unknown origin share.
- Reads are bounded (4 s statement timeout; 20,000 runs, 5,000 groups, 20,000 bindings); truncation turns every figure into a lower bound with a note;
  more bindings than the bound is the closed code `ADMIN_CHANNEL_COUNTS_UNAVAILABLE`, never an estimate.

### 2.4 Access and evidence

Only `app/admin/page.tsx` imports the loader, after `await adminPage()` (static scan test). Console off gives 404, no or dead session redirects to
`/admin/login`, and the loader is never called (`channels.test.ts`). The UI shows aggregate counts only. Evidence: `channels.test.ts`,
`channels.pg.test.ts` (exact counts per channel on fixtures: every requester kind, the 8-recipient batch once, step and `wfr_` exclusions, recoveries,
bindings, deleted approval, unbound runs Unknown at any age, environment and period boundaries), `e2e/admin-console.spec.ts` (section, Total, period).

Production configuration: none. No environment variable. Activation is the deploy.

## 3. WS02: Solana Batch Payment

### 3.1 Asset and wallet matrix

| | SOL | USDC | USDT | Token-2022 / other mints | Devnet |
|---|---|---|---|---|---|
| Authoring and execution | yes (lamports) | yes (SPL Token, 6) | yes (SPL Token, 6) | refused, never advertised | refused |

| Wallet | Batch |
|---|---|
| Phantom, Solflare (Wallet Standard `solana:signTransaction`, one transaction) | supported (MOCKED evidence) |
| FloFi embedded wallet | refused by the planner's atomic check, before anything is signed: `FLOFI_WALLET_SOLANA_BATCH_PAYMENT_UNSUPPORTED` (no Solana signing binding for workflow-run groups) |
| Kora fee payer | refused for batches; fees and deposits are paid in SOL by the owner |
| Native channel signing (PR #259) | not used, see 3.8 |

### 3.2 Atomic transaction

One v0 message, no lookup tables, owner is fee payer and only signer: `[SetComputeUnitLimit, SetComputeUnitPrice, leg_1 .. leg_N]`. SOL leg: System
`Transfer`. SPL leg: ATA `CreateIdempotent` plus `TransferChecked` (mint, decimals, program and destination owner validated). Each leg is
byte-identical to a reviewed single Solana transfer. Integer base units, u64 bounded. No custom program, custody or provider. The planner places
the batch in exactly one `SOLANA_SIGN_ALL` group holding one `BATCH_PAYMENT` transaction; when that is not possible the atomic check refuses with
`BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE`. It never splits, downgrades, drops recipients or reduces amounts.

### 3.3 Limits (measured on the offline cluster, asserted exactly for N = 2..8)

| Asset | v0 transaction bytes | With Phantom's observed guard | Accounts | Instruction trace bound |
|---|---|---|---|---|
| SOL | 49N + 220 (612 at N = 8) | + 62 (674) | N + 3 | 2 + N + 8 |
| SPL | 91N + 348 (1,076 at N = 8, any number of ATA creations) | + 93 (1,169) | 2N + 7 | 2 + 6N + 8 (worst case: every ATA created) |

Refused before signing: unsigned bytes above 1,232 - 96 (`TRANSACTION_TOO_LARGE`), more than 64 accounts, a trace bound above 64. Compute is measured
by simulation (probe without priority fee), reviewed limit `ceil(1.2 x consumed) + 5,000`, cap `min(1,400,000, N x 200,000)`; above the cap the batch
is refused (`COMPUTE_LIMIT_EXCEEDED`), never capped silently. Signed transaction at most 1,232 bytes.

### 3.4 Token accounts, rent and costs

`CreateIdempotent` is present for every SPL recipient: it creates, and charges rent, only when the ATA is missing, and atomically checks an existing
ATA's owner and mint. Review shows the actual deposits for missing ATAs and the worst-case maximum (an existing ATA can be closed before execution).
Balance checks use the worst case: `requiredLamports = (SOL total) + fee + sum(maximum deposits) + rent-exempt reserve`; a shortfall is refused with the
numbers (`SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL`, rendered by the existing fee-shortfall panel in SOL). A new SOL recipient must receive at least the
rent-exempt minimum. The simulation verifies every recipient's exact delta, the source debit, created-account rent and the owner's debit.

### 3.5 Binding, signing and reconciliation

The manifest (owner, chain, asset, recipients, amounts, order) is inside the workflow hash; the prepared artifact carries its `manifestHash`. At
authorization and again before sending, the stored message is decoded by a closed decoder and compared with the reviewed legs; the signed bytes must be
the reviewed message or it plus only a verified Lighthouse guard (PR #120 policy): same fee payer, signers and blockhash, no compute-budget change, no
new account. A second, different wallet answer is refused (`SOLANA_BATCH_PAYMENT_ANSWER_MISMATCH`). The signature is known before sending; FloFi
sends once and resends only identical bytes while the blockhash is valid. Reconciliation reads the finalized transaction: exact per-recipient lamport
or token deltas, the owner's delta equal to the total plus fee plus created deposits, nothing else moving. A failed transaction is FAILED for every leg
and settles nothing; a successful transaction that does not match is UNMATCHED (ATTENTION), never FAILED and never resent. Evidence only after
finalized reconciliation.

### 3.6 Expired blockhash and refreshed preparation

A refreshed preparation recomposes the same immutable strategy: identical `manifestHash` and legs; only blockhash, fee, measured compute, source account
and per-recipient deposits may differ, and the owner signs the new bytes. An answer after `validUntil` (50 s) is refused; signed too late for the send
budget is BLOCKED and never sent. Duplicate-payment protection (Solana batch groups only, no migration): an expired, unsigned batch preparation is
prepared again only after the finalized height passes its last valid block height (`SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE` until then, about
20-40 s) and the owner's history over that window shows no landed copy. A landed copy halts the run (`BATCH_PAYMENT_EARLIER_REQUEST_LANDED`) and
nothing is asked again; an unreadable history retries (`BATCH_PAYMENT_EARLIER_REQUEST_UNPROVEN`); a history beyond the scan bound halts
(`BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE`).

### 3.7 Compositions and channels

| Path | Behavior |
|---|---|
| Batch alone | One group, one prompt, one transaction, 2..8 recipients |
| Jupiter swap, Universal Bridge, Swap -> Bridge, Aave withdraw -> Bridge, then Solana batch | Batch group signed when due with legs bound exactly to the reconciled delivery; an insufficient delivery is BLOCKED (`WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT`), Resume refused, new Review. Step budget 8 |
| Editor | In-place Simulate, Review, Execute for a Solana-only Batch Payment (the card), Sign-In With Solana; other Solana or mixed workflows keep their existing paths |
| Chat / Copilot, ChatGPT MCP, Claude MCP, Telegram | Same workflow hash; executed through the existing `/approve` page with Phantom or Solflare |
| Developer API production keys | Refused (`BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE`), unchanged PR #260 restriction |

Owner example: "Send 0.01 SOL to A, 0.02 SOL to B and 0.03 SOL to C" is one Batch Payment card, three recipients verbatim, total 0.06 SOL
(60,000,000 lamports); Editor, MCP and Telegram produce the same hash; one group, one transaction, RECONCILED per recipient on the offline cluster.
Missing or ambiguous input ("wallet A") never becomes an address: FloFi asks a clarifying question, or discards an interpreter answer that carries
the placeholder (`COPILOT_INTENT_INVALID`); it never invents an address or amount. Base58 recipients are never lower-cased.

### 3.8 Native channel signing (PR #259): not used for a batch

Native Phantom/Solflare signing drives one `SINGLE_FLOW` execution-run flow (`platform/native-signing.ts`, `server/native-signing/runtime.ts`). A batch
has 2..8 legs, is planned `SEQUENTIAL` with no flow and executes as one workflow-run user-funded `SOLANA_SIGN_ALL` group, which native signing has no
flow to call. Reuse would need a second execution path for the same payment (out of scope). Telegram, ChatGPT and Claude keep the existing `/approve`
link; `start_wallet_session` answers `NATIVE_SIGNING_NOT_AVAILABLE_FOR_THIS_OPERATION`. Native signing code is unchanged (tests:
`platform/native-signing.test.ts`, `mcp/native-signing.pg.test.ts`, `channels/telegram/native-signing.pg.test.ts`).

### 3.9 Mixed EVM/Solana Editor workflows

The Editor's in-place whole-workflow run has excluded any workflow with a Solana node since `2de5465` (PR #251, merge `52b87cf`), unchanged through
`fed320e`. This build keeps that exclusion (pinned by `editor-workflow-run.mixed-namespace.test.ts`) and opens the in-place run only to a Solana-only
Batch Payment. Mixed workflows with a Solana batch run through `/approve` from Chat, MCP and Telegram proposals. Preexisting, not a regression.

### 3.10 EVM Batch Payment unchanged

No EVM line of the contracts changed; the EVM golden hashes (USDC `0x07660e18…517d`, native `0xa070eb8b…5530`) were computed from the untouched
build and pinned; the planner reproduces 60 fed320e EVM plans exactly (`testdata/evm-batch-plans.fed320e.json`); EIP-5792 / smart-account, wallet
restrictions, MCP consent, the 8-step limit and `expectedStepCount`, native channel signing, Review-to-signature integrity and reconciliation suites
pass unmodified (`batch-payment-run.pg`, `groups`, `groups-kora`, `execution-groups`, `engine/batch-payment`, `mcp/batch-payment`, `developer/batch-payment`).

## 4. UX preservation

Visible changes are limited to: the Admin Overview section "Completed executions by channel"; `Solana` in the existing Batch Payment card's Network
select with SOL/USDC/USDT, the Solana recipient placeholder and problem copy; the Solana wording of the existing Review, run and `/approve` panels
for a Solana batch. No new card, page, navigation, rail entry or layout. Default draft stays Base / USDC. No visual baseline changed.

## 5. Tests added or extended

Packages: `workflow-contracts/test/batch-payment.test.ts`, `action-registry/test/solana-batch-payment.test.ts`,
`reference-linter/test/batch-payment-solana.test.ts`, `reference-compiler/test/solana-batch-payment.test.ts`,
`reference-reconciler/test/solana-batch-payment.test.ts`. App (`apps/reference-dapp/src/`): `user-funded/groups-solana-batch.test.ts`,
`workflow-runs/{execution-groups,user-funded-pass,permanent-due-refusals}.test.ts`, `workflow-runs/solana-batch-payment-run.pg.test.ts`,
`editor/{workflow-execution-solana-batch,authorize-binding,approval,batch-payment-canvas}.test.ts(x)`, `editor/editor-solana-batch-run.pg.test.ts`,
`components/editor-workflow-run.{solana-batch,solana-batch-panel,mixed-namespace}.test.ts(x)`, `components/workflow-run-panel.wallet-batch.test.tsx`,
`domain/{commands,copilot-batch-payment-solana,approved-ux,review-block,runtime-selection}.test.ts`, `engine/*`, `mcp/batch-payment.test.ts`,
`mcp/native-signing.pg.test.ts`, `channels/core/*`, `channels/telegram/native-signing.pg.test.ts`, `platform/{native-signing,conversation-state,
batch-payment-capabilities,settlement-regression-matrix}.test.ts`, `developer/batch-payment.test.ts`, `admin/analytics/channels{,.pg}.test.ts`;
browser `e2e/batch-payment-card.spec.ts` (Solana card), `e2e/admin-console.spec.ts`.

## 6. Specialist reviews

Pending; dispositions are recorded in the PR.

## 7. Certification

Local (PostgreSQL 16.15, pinned anvil 1.8.3, offline):

| Gate | Result |
|---|---|
| `pnpm check` (typecheck, lint, build, schema drift, unit) | pass: 842 unit files, 10,756 tests; 2 existing skipped suites (fork-pinned) |
| PostgreSQL suites (workflow-runs, editor, platform, admin, backend; 62 files) | 61 pass; `backend/database-privileges.pg.test.ts` fails on PG16 only (MAINTAIN privilege is PG17+), preexisting |
| `governance_lite.py` and its unittests; `agent_guard.py check` | pass |
| Browser profiles `canvas-workflow-ux` (incl. the Solana card test), `admin-console`, `editor-single-card`, `editor-wallet-batch`, `approve-workflow-run` | pass |
| Browser profile `default-product-1` | 9 environmental failures (font rendering of 7 screenshots, no DNS for a public quote host); the clean `fed320e` build fails the same 9 with pixel-identical renders |

Not run locally: PostgreSQL 18 (CircleCI only, `postgres:18.6`), fork suites (owner fork phrase), the other browser shards. CircleCI certification of the
exact final commit is recorded in the PR.

## 8. Limitations

- Solana evidence is MOCKED: real Phantom/Solflare display of 8 recipients, Lighthouse appends on large transactions and mainnet compute costs are
  unverified. The first owner-initiated batch is the only proof.
- Two signed variants of one preparation broadcast outside FloFi (Phantom's guard differs per prompt) are not prevented; FloFi sends only the first
  recorded answer. Non-batch `SOLANA_SIGN_ALL` groups keep the existing re-preparation (preexisting).
- A swap followed by a batch is not run in place in the Editor; it runs through `/approve`.
- MCP and Telegram can hand off a Solana batch only where the existing settings `FLOFI_MCP_HANDOFF_MAINNET_NETWORKS`,
  `FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS` and the user-funded chains include Solana (no new setting).
- WS01 limits in 2.3.

## 9. Owner acceptance (after CTO approval; no real-money transaction without CTO authorization)

1. Admin: open `/admin`, check the section for each period and environment; counts are aggregate, Unknown origin is expected for history.
2. Solana: with Phantom or Solflare, author a 2-recipient SOL batch with small amounts in the Editor card, Simulate, Review (recipients, total, fee,
   deposits, atomic), Execute, one signature; then a USDC batch with one recipient without a USDC account (deposit shown). Confirm one transaction per
   batch and the reconciled per-recipient result. Repeat from ChatGPT, Claude and Telegram through `/approve`.
3. PR #260 mainnet acceptance tasks remain pending.

## 10. Migration and rollback

No schema migration, no environment variable, no backfill. Rollback: redeploy the previous build. Solana batch preparations are JSON inside the
existing `user_funded_groups` columns, and an older build does not know the `BATCH_PAYMENT` transaction kind (at `fed320e` an unknown Solana kind
takes the Jupiter branch of authorization and reconciliation). Before rolling back, make sure no Solana batch group is in flight (no group
`PREPARED`, `AUTHORIZED` or `SUBMITTED` whose prepared transaction kind is `BATCH_PAYMENT`); let it settle or end it first.

## 11. Statuses

| Status | |
|---|---|
| ENGINEERING COMPLETE | yes |
| CI CERTIFIED | pending (recorded in the PR) |
| READY FOR OWNER ACCEPTANCE | after CTO approval and CI certification |
| LIVE VERIFIED | no (no deploy, no real-wallet execution) |
| BLOCKED-PARTIAL | none |

## 12. Final status

ENGINEERING COMPLETE. CI certification, CTO review and owner acceptance pending. Not merged, not deployed.
