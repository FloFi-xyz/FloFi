# BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001

| | |
|---|---|
| Baseline | `origin/main` at `ca62ace55656bdc7459a3eb47821c6302042bc1c` (merge of PR #261) |
| Branch | `claude/gifted-lovelace-wz9a1v` |
| Jira | KAN-25 (attribution), KAN-21 (bridge reconciliation), KAN-20 (Batch Payment), parent and subtasks listed in the PR |
| Status | See [Status by item](#9-status-by-item). Not accepted by Product. |

Nothing in this build signs, submits or moves funds, deploys, merges or changes production configuration. Every execution test runs on offline
mock chains, wallet doubles or disposable PostgreSQL (evidence `MOCKED`). Production was read only (Neon, `SELECT` statements; no write).
Fee collection is not active and cannot become active from this build.

## 1. Scope delivered

| Workstream | Delivered |
|---|---|
| Revenue (P0) | Canonical 0.80% policy, principal accounting, durable fee ledger (0037), fail-closed activation, Admin fee panel, 0.1% → 0.80% disclosures. Collection: **Blocked** |
| Bridge reconciliation (P0) | Production root cause for the reported run; Nitro execution-gas fix for direct native payouts on Arbitrum One and Robinhood Chain; regression tests |
| Attribution (P0) | Durable `execution_origins` (0037), recorded at creation from trusted server context, audited evidence backfill, approved corrections, Admin rows |
| Formatting (P1) | Global rule on read-only Canvas values, normalized exact values, balance shortcuts below one unit, global regression suite |
| Batch Payment (P1) | Short validation message EN/PT ("Enter a valid address." / "Informe um endereço válido."), field still highlighted |
| Not delivered | Canonical workflow state and dynamic dependency extensions (E01/E02/E05–E08), assistant intelligence (E03/E04/E09/E10), Batch Payment + Credentials conversation, assistant-driven Canvas sync, responsive layout (E11). See §8 |

## 2. Revenue: the 0.80% platform fee

**Policy** (`src/platform-fee/policy.ts`): 80 bps of the principal the owner independently introduces, one fee per completed workflow execution,
integer floor division per exact asset (`floor(principal × 80 / 10 000)`), policy id `flofi-platform-fee/v2-80bps`.

**Principal** (`src/platform-fee/principal.ts`, pure): for each executable step (Batch Payment legs included), in order:
- an input bound to an earlier step's output (`bindings`) is derived, never principal;
- an unbound input of an asset an earlier step delivered to the owner (same chain, address, decimals) is derived up to what was delivered; when
  the delivered amount is not known (Review) coverage is unbounded, so an estimate never charges more than a final settlement could;
- the rest is principal when the action is feeable: swap, bridge, supply, transfer, Batch Payment. Not feeable pending an approved policy:
  borrow, repay, withdraw, add liquidity, the lending composition, any swap touching a Stock Token. Their outputs still cover later steps;
- an unreadable step (unknown action, unreadable input, an asset of unknown class on a Stock Token network) makes the execution UNSUPPORTED:
  never charged.
Settlement (`settledFee`) is, per asset, the smaller of the Review-time estimate and the final basis from reconciled deliveries; an asset not in
the estimate is never charged.

Examples (tests `principal.test.ts`): 100 USDC swap → 0.80 USDC; swap → bridge → supply on the same funds → 0.80 USDC once; Batch Payment of
100 USDC → 0.80 USDC once; swap 100 USDC + independent supply 50 USDC → 1.20 USDC; 124 raw USDC → 0; 125 wei → 1 wei.

**Ledger** (`platform_fee_ledger`, migration 0037; `src/platform-fee/ledger.ts`): one row per workflow run (the canonical execution identity,
never the saved workflow), inserted `ON CONFLICT DO NOTHING`. COMPLETED → DUE / NOT_APPLICABLE / UNSUPPORTED; FAILED, CANCELLED, EXPIRED after a
step started → WAIVED; never started → no row; PENDING, RUNNING, HALTED, ATTENTION → no row until the outcome is known. The table's trigger
allows only DUE → COLLECTION_PENDING → COLLECTED | COLLECTION_FAILED → COLLECTION_PENDING as compare-and-set on `version`; COLLECTED requires
its collection transactions in the row; an owed or collected row cannot be deleted. Accrual runs only from `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM`
(nothing earlier is ever accounted), via the operator command `platform-fee-accrue` (dry run by default).

**Collection: not implemented (Blocked).** No treasury address exists, no accounting policy is approved and the collection rail is an owner
decision (Relay app fees, a separate owner-authorized transfer after completion, or an invoice; options recorded in
BUILD-CROSSCHAIN-UNIVERSAL-001-REPORT.md). `activation.ts` reports the first missing condition and is never active:
`PLATFORM_FEE_COLLECTION_DISABLED`, `…_TREASURY_NOT_CONFIGURED`, `…_TREASURY_INVALID`, `…_POLICY_NOT_APPROVED`, `…_AUTHORIZED_BASIS_NOT_RECORDED`
(no workflow Review discloses or stores the fee basis a collector would be capped by).
Because nothing is collected, every disclosure keeps "not charged at this time" and only the rate changes (0.1% → 0.80%).

**Universal bridge**: its existing per-run obligation uses the canonical rate and the rate its own Review disclosed (`reviewedFeeRate`): a Review
made under 10 bps keeps 10 bps (F15), so historical records stay valid.

**Not covered**: single-flow executions without a workflow run (most single cards today) are not accounted in the ledger; the universal bridge
keeps its own obligation. MCP, Telegram and the Developer API share the same policy module but show no new fee line beyond the existing universal
bridge disclosure.

## 3. Bridge reconciliation (reported Ethereum → Robinhood Chain incident)

Production evidence (read-only, 2026-11-27 UTC): the user's sequence was two single-flow runs, `ethereum-swap` (created 03:56:17, reconciled
03:58:51) and `crosschain-universal` Ethereum → Robinhood Chain (created 03:58:59). Relay reported FILLED at 03:59:41; the run waited at
`UNIVERSAL_AWAITING_FINALITY` and the worker reconciled it at 04:13:56 without any user action.

**Confirmed**: the backend did reconcile the reported bridge, about 14 minutes after delivery, under the existing finality policy (both chains'
`safe` heads; Ethereum's dominates). **Not confirmed**: what the user saw. The web client follows a settling run from its durable record every
15 s while the page is visible (`useSettlementSync`), so a hidden tab, a closed page or failing reads over a slow connection would show
"waiting for finality" until the next read; no data shows which. The VPN is not established as a cause.

**Confirmed defect found on the way** (`evm-chain.ts`): Arbitrum Nitro receipts fold L1 posting gas into `gasUsed` (`gasUsedForL1`); the
trace-free proof of a direct native payout required `gasUsed <= 23 000`, which a Nitro payout exceeds (RH-DEMO-001: 25 359 = 21 000 + 4 359).
Such a delivery then needs a trace RPC and stays `UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE` without one. The bound now applies to
`gasUsed - gasUsedForL1` on chains 42161, 421614, 4663 and 46630 only. Production has one run in exactly that state: Base → Arbitrum One
WETH → ETH, created 2026-11-25 14:40, 332 worker deliveries so far. Whether its fill is a direct payout within the bound is a **hypothesis**:
the receipt is not stored and the Arbitrum RPC is not reachable from this build environment. After deployment the worker re-observes it on its
own; if the work item has reached its observation budget first, `admin-cli reconcile-history --flow crosschain-universal --apply` re-arms it
(read-only re-observation, no transaction).

Tests: `service.test.ts` "Nitro destinations…" (Ethereum → Robinhood, Base → Robinhood, Base → Arbitrum, each across a worker restart; four
refusal cases) fail without the fix and pass with it; the 195 universal-router tests pass.

## 4. Attribution: durable execution origins (KAN-25)

**Root cause** of 71/79 Unknown origin: a single flow created in the web app has no origin record at all (only approval bindings and workflow
runs carried one), and nothing separates Chat from the Editor (same page, same server actions).

**Now** (migration 0037, `src/workflow-runs/execution-origins.ts`), first record wins, never updated:
- workflow run: its approval's immutable requester, in the creating transaction (own savepoint);
- single flow created by `/app` server actions: `web`, from the proxy's authoritative `x-flofi-pathname`, carried BFF → API as
  `x-flofi-execution-surface` on the bearer-authenticated call, recorded after `simulate`/`prepare` succeeds (best effort, never fails the call);
- single flow signed on an approval page: the approval's channel when `bindRuns` binds it.
`web_chat` and `web_editor` stay reserved: no trusted server-side signal distinguishes them (**Blocked**: it needs Chat executions to carry a
server-held conversation identity).

**Historical recovery** (`origin-backfill`, audited, idempotent, dry run by default): BOUND → the approval's origin; NO_APPROVAL → `legacy_web`;
AMBIGUOUS, CONFLICTING_BINDINGS, BEFORE_COMPLETE_HISTORY → stay Unknown. Read-only production pre-check (SQL equivalent): 78 reconciled root
single flows → 70 Legacy Web, 5 Unknown (an MCP approval for the same wallet and flow could have created them), 2 MCP-bound, 1 workflow step.
The 70 assume the owner's statement that no approval was ever removed (`--assert-approvals-never-purged`); with the default 31-day horizon only
runs from 2026-11-09 on are recoverable.
Execution totals do not change. Corrections: `origin-correct` (approval reference, append-only audit). Not yet run on production.

**Admin**: rows FloFi Web (Chat or Editor), Legacy Web, ChatGPT MCP, Claude MCP, Telegram, Developer API, Unidentified MCP client, Unknown;
a FloFi Web total; automation in its note; the obsolete "no origin record" notes disappear once 0037 is active. The fee panel shows ledger
states, owed amounts per exact asset and accounted executions by origin. Different tokens are never added or converted to money.

## 5. Formatting (R06/R07)

Read-only Canvas source and liquidity values now use the global six-significant-digit rule with the exact value one tap away; exact values are
normalized (0.040000000000000000 → 0.04, PT 0,04); balance shortcuts below one unit keep six significant digits (nonzero never "0…").
`token-amount-global.test.ts` pins the owner's examples. Surfaces the formatting audit listed that still format on their own (legacy runtime
panels, Execute step amounts rounding up/down by purpose, Dashboard rounding down, MCP base-unit facts) are unchanged in this build.

## 6. Database and environment

Migration 0037 (optional, certified for v28, `revenue-origins-migrate` on exact schema 36): three tables, five indexes, three non-SECURITY
DEFINER trigger functions. Least-privilege policy moved to schema 37. Procedure: [RELEASE-REVENUE-ORIGINS-0037.md](../deploy/RELEASE-REVENUE-ORIGINS-0037.md);
schema facts: SCHEMA-COMPATIBILITY.md §29. New variables (all optional, none set by this build): `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM`,
`FLOFI_PLATFORM_FEE_COLLECTION`, `FLOFI_PLATFORM_FEE_TREASURY_EVM`, `FLOFI_PLATFORM_FEE_TREASURY_SOLANA`, `FLOFI_PLATFORM_FEE_POLICY_APPROVAL`
(ENVIRONMENT.md §5q).

## 7. Tests run locally

See the PR for exact commands and counts at the final head. PostgreSQL suites ran on a disposable loopback PostgreSQL 18.6 (the CI version).

## 8. Not delivered in this build

E01/E02/E05–E08 (canonical revision propagation, dynamic "all received" consumption beyond existing bindings, stale downstream amounts),
E03/E04/E09/E10 (read-only questions, natural-language references, language independence, cost explanations), Batch Payment with saved
Credentials in Chat (R09–R12), assistant-driven Canvas highlighting (P1-03), responsive Conversation/Plan switching (E11). Existing behavior is
unchanged; nothing was partially wired.

## 9. Status by item

See the PR description for the full matrix (A01–A10, R01–R12, F01–F20, attribution tests).
