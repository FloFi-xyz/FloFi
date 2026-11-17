# BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 — execution status, chat and history reliability

**Scope:** the six owner-authorized items of the November 17, 2026 report (UX-01, EXEC-01, EXEC-02, CHAT-01, PERF-01, ADMIN-01). Branch
`fix/execution-ux-reliability-001`, from `main` at `caa5701` (PR #206). No migration, schema, dependency, environment variable, infrastructure,
signing, authorization, routing, chain/token, fee or finality rule changed. No transaction was signed, submitted or repeated; no production record was
read or changed from this session (it has no Railway, Neon or Vercel credentials — see §B).

Evidence levels: **CODE** = reproduced against the real code before the fix and passing after it; **BROWSER** = the production build in the pinned
headless shell on loopback; **MOCKED** = the real services on the MOCKED loopback chains/harness; **PRODUCTION** = read-only production evidence
(none from this session; the owner's report is quoted as such).

## A. Root causes and corrections

### UX-01 — chat message wrapping (P2) · CODE + BROWSER

**Root cause.** `.chat-row>.message{max-width:calc(100% - 36px)}` applied to the owner's bubble inside `.chat-row-you`, a shrink-to-fit row
(`align-self:flex-end`). The row's width is the bubble's max-content plus the 8 px gap and 28 px avatar, so the percentage resolved back to exactly
the bubble's own text width. Any sub-pixel rounding — browser zoom 80–90 %, display scaling — made it a fraction narrower, and
`overflow-wrap:anywhere` then broke the last character ("Continua / r", "Deu / certo?", "12345678 / 9"). Reproduced with the real stylesheet and
fonts: every short message wrapped at 90 % and 80 % zoom, none at 100 %. Isolation showed the wrap disappears only when that max-width is removed
(not by removing padding, the avatar, `overflow-wrap`, or the row's own max-width).

**Correction** (`src/app/globals.css`): the owner's bubble has no percentage max-width; the row's existing `max-width:min(100%,560px)` and the
bubble's flex shrink (`min-width:0`) keep long text and unbroken addresses inside the panel. FloFi's bubbles (stretched rows, no cycle) are unchanged.

**Regression** (`e2e/chat-message-wrapping.spec.ts`, default-product profile): `Continuar`, `Deu certo?`, `123456789`, `0.990877`, `100 USDC`, long
PT/EN sentences and EVM/Solana addresses, at 1440/1280/390 px × light/dark × zoom 1, 0.9, 0.8, 1.1, 1.25 — measured on the rendered line boxes
(distinct line tops of the text range) and on overflow of the bubble and the log. It fails with the old rule re-injected (“1440px Light zoom 0.9:
Continuar is one line — received 2”) and passes with the fix.

### EXEC-01 — bridge reconciliation (P1) · CODE + MOCKED

**Conclusion: legitimate safe-head finality, made worse by stale presentation; no backend reconciliation defect found in the code.**

- `router-service.ts observeSettlement` marks success only when the source and destination blocks are at or below each chain's `safe` head and still
  canonical. `DESTINATION_OBSERVED` + `ROUTER_AWAITING_FINALITY` with `needs_observation` and no evidence is exactly the state between "fill verified
  on Arbitrum" and "Arbitrum's safe head passed the fill". Arbitrum's `safe` head follows its L1 batch posting and can lag by tens of minutes
  (recorded in `docs/builds/BUILD-JOURNEY-001-REPORT.md`).
- The worker retries a pending reconciliation with `backoffMs`: ≈15 s, 30 s, 60 s, 120 s, 240 s, 480 s, then 600 s (±20 %). Six deliveries match a
  run roughly 8–16 minutes old that is still waiting for finality — consistent with the owner's observation, not with a stuck or crashed task.
- The browser stopped reading the run once the deposit confirmed (`router-store.execute()` polls only while the attempt is
  SUBMITTING/PENDING), so Execute, the Assistant and the Canvas kept the deposit-time state until "Check status"; and the router lifecycle labelled an
  already observed fill "Waiting for delivery", with "0 of 1 actions completed" as the only explanation (EXEC-02).

**Not changed (by design and scope):** finality tags, safe-head and canonical-block checks, fill/recipient/amount/deposit validation, provider-hint
handling, retry budgets and worker scheduling. Follow-up for the owner (not implemented): once finality is reached, the 600 s backoff cap can delay
`RECONCILED` by up to ~10 minutes; a bounded finality re-check cadence would shorten that but changes shared worker pacing and retry budgets.

**Regression** (`src/server/router-service.test.ts`, MOCKED): fill observed with the Arbitrum safe head far behind → `DESTINATION_OBSERVED` /
`ROUTER_AWAITING_FINALITY` / no evidence / still observed; a failing destination `safe` read leaves the durable record (fill, hashes, phase)
unchanged; once the safe head passes, the same observation reconciles with the same source and destination hashes as evidence; zero new sends.

### EXEC-02 — execution status synchronization (P1) · CODE + MOCKED

**Root causes.** (1) No client re-read of a settling bridge (above). (2) The shared phase vocabulary had no "delivery observed, finality pending"
state, so router runs said "Waiting for delivery on Arbitrum" after the fill was observed, and universal runs' observed delivery still counted as
`AWAITING_DESTINATION` in the whole-workflow progress. (3) The Canvas header kept the authoring state ("Configured · Simulate and review before
signing") while editing was paused for the execution. (4) The Dashboard summary said only "awaiting its final outcome".

**Corrections.**
- `domain/execution-phase.ts`: presentation phase `DESTINATION_OBSERVED` — "Transfer observed on {0}" / "Transferência observada em {0}"; active
  tone; never completes a step; locks resubmission.
- `domain/execution-lifecycle.ts`: router and universal destination operations take that phase only while the record holds a verified `destination`
  and the run is still PENDING (never for recovery, reconciliation-required, divergent or refunded runs). With every wallet request confirmed, the
  lifecycle reads **"Transfer observed on destination chain — The funds have been observed on the destination chain. FloFi is still verifying final
  settlement. No additional wallet signature is required."** (PT: **"Transferência observada no destino — Os fundos foram observados na rede de
  destino. A FloFi continua a verificar a finalização da operação. Não precisa assinar novamente."**). Execute, the Assistant's progress messages,
  the Dashboard run view and the whole-workflow progress (`domain/workflow-progress.ts`) all read it from the same projection.
- `lib/dashboard/run-mapping.ts`: a `DESTINATION_OBSERVED` summary (not flagged for attention) is "In progress" with the same explanation.
- `components/workflow-canvas.tsx` / `app-shell.tsx`: while editing is paused, the Canvas header states the live execution label instead of the
  authoring state; the existing lock and lifecycle policy are unchanged.
- `state/settlement-sync.ts` + `domain/settlement-sync.ts`, in the router and universal stores: while a run is PENDING in
  SOURCE_CONFIRMED/IN_FLIGHT/DESTINATION_OBSERVED/RECOVERY_REQUIRED and the page is visible, re-read its **durable** record every 15 s (the existing
  `status` read: a database read, never an observation or chain RPC), once more when the tab becomes visible, and stop when final. An answer is
  adopted only for the same run, when no other store operation started meanwhile (epoch), and when it does not move the run back (verdict, phase,
  destination, each side's finality). "Check status" stays the manual fallback.

**Regressions:** `domain/execution-ux-reliability.test.ts` (lifecycle, progress, never-completed, divergent/recovery excluded, stale guard),
`state/settlement-sync.test.ts` (cadence, visibility, busy, epoch discard, regression discard, stop when final), `lib/dashboard/run-mapping.test.ts`.

### CHAT-01 — contextual execution status questions (P1) · CODE

**Root cause.** "Deu certo?" matched none of the conversation's lifecycle commands, so it went to the Copilot's read-only question path, whose
`PROPOSAL` topic answered "Não há proposta pendente." The conversation never treated the current execution as the subject of such questions.

**Correction.** `domain/conversation-lifecycle.ts` recognizes whole questions about the outcome (Deu certo? Funcionou? Já terminou? Qual o status?
A bridge foi concluída? Did it work? Was it successful? Is it complete? …; "status", "verificar status" and "What's the status?" stay the existing
Status command, which re-reads the record), receipt (Recebi os tokens? Did I receive the tokens?)
and signatures (Preciso assinar novamente? Do I need to sign again?). While this workflow has a started execution, `state/flofi-conversation.ts`
answers them from that execution's lifecycle only (`executionStatusAnswer`): reconciled → yes; delivery observed → the destination-observed
sentence; a request in the wallet, an unknown outcome or a failure → said as such; receipt never claimed before the delivery is observed; the last
failed status read is disclosed. Every answer is marked read-only, keeps an open question's buttons, never answers a confirmation, and offers the
existing "Check status". Without an execution, the earlier behaviour is unchanged. No new model, provider, prompt or memory.

**Regressions:** `domain/execution-ux-reliability.test.ts` (PT/EN matching, non-matches for commands/authoring, answers per state).

### PERF-01 — history loading (P1) · CODE + BROWSER (MOCKED runtime)

**Root cause.** The Dashboard read the history list, the opened record and its disposition through Server Actions. Next.js 16 dispatches Server
Actions **one at a time per client** (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`). Every page load sends ~60 mount-time
availability actions (measured: `crossChainRouterMode` ×13, `walletSessionStatus` ×5, `catalogSwapAvailability` ×4, `catalogLiquidityMode` ×4,
`cowInfo` ×3, … 32 distinct actions), plus whatever is in flight (a 10.7 s swap preview, an observation). The record read waited behind all of them;
at production round-trip latencies this is consistent with the ~30 s "Carregando a execução…".

**Correction.** `GET /api/dashboard/history` (`src/app/api/dashboard/history/route.ts`) serves `view=list|detail|disposition` with the same
`withFlightAccess` boundary and the same owner-scoped `loadDashboardSnapshot` / `loadDashboardRunDetail` / `ownerHistoryOperation` reads (never
cached; input validated). `src/app/dashboard-reads.ts` fetches it with abort on navigation. Only the history change (delete/archive) stays an action.
While the record loads, the summary this wallet's own listing already showed is displayed, marked "Loading execution details…" (never another
wallet's, never substituted for a record the server does not return). The local-only wallet-session fallback key is now one per process
(`server/wallet-session.ts`): it was one per server bundle, so a Route Handler could not read a session a Server Action sealed on a local server
(hosted deployments always use the configured secret and fail closed without one).

**Measurement** — same machine, same production build, same MOCKED embedded runtime and disposable PostgreSQL, one owned reconciled bridge run;
time from `page.goto('/app/dashboard/runs/<id>')` to the run id and "Evidence" being visible; "held" = every Server Action response delayed 10 s
(models slow concurrent actions):

| | Unheld n | median | p95 | Held n | median | p95 | Record reads per open | Server Actions before visible |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Before (actions) | 8 | 1 932 ms | 1 973 ms | 4 | **not visible within 60 s** | — | 1 (action, queued) | 61 |
| After (GET route) | 8 | 1 326 ms | 1 434 ms | 4 | 1 297 ms | 1 337 ms | 1 (GET) | 6–10 unheld, 1–2 held |

The 2 s p95 target holds locally under both conditions. Production p95 was **not** measured from this session (no production access); the remaining
bottleneck is server-side (Flight boundary, owner check, the API run read, then the evidence and record reads in parallel). The ~60 mount-time
availability actions still run and still delay other action-based UI on every page; reducing them is outside this build's scope.

**Regression** (`e2e/acceptance-workflows.spec.ts`, workflow-acceptance profile): with every Server Action held 10 s, an owned record opens in < 5 s
with exactly one record read, and the history list lists it with exactly one list read. Plus `src/app/api/dashboard/history/route.test.ts`
(boundary, validation, refusal, no-store) and `src/server/wallet-session.test.ts` (one key per process, configured secret and hosted refusal kept).

### ADMIN-01 — repeatedly interrupted recovery diagnostics (P1) · CODE

**Conclusion: intended safety behaviour, poorly explained.** `backend/app.ts` stops a reconcile task as `NONCE_CONFLICT_STABLE_OPERATOR_REVIEW`
once complete investigations of the same nonce conflict return identical evidence; an operator's recovery re-queues one read-only check which, with
unchanged evidence (the stability count is kept), stops again after one or two deliveries — the October 27 Arbitrum → Base run's November 14/16/17
history. No recovery defect was found; eligibility, retry limits, authorization, audit and attention handling are unchanged.

**Correction.** `admin/support/recovery.ts` `stoppedAgainDetail`: a stopped-again verification now says why — a stable nonce conflict (by design,
not a temporary failure; resuming with unchanged evidence stops again; outcome UNKNOWN; nothing submitted, repeated or marked settled) vs. a temporary
condition (an RPC/provider that did not answer) vs. anything else — with the number of checks. The incident page names the exact execution, states
that an accepted recovery only re-queues a read-only check and establishes no settlement, shows the stop code and whether it is temporary, and labels
the operator's text "Operator's reason (as typed; not verified evidence)"; the global history shows the stop code and label.

**Regression:** `admin/support/support.test.ts` (stable conflict, temporary RPC, other codes, missing count).

## B. Bridge execution evidence

| | November 17 Base → Arbitrum `xroute-876a0bfd…` | October 27 Arbitrum → Base `xroute-a09617c2…` |
| --- | --- | --- |
| Reported state | DESTINATION_OBSERVED, ROUTER_AWAITING_FINALITY, needs_observation, 6 deliveries, no evidence | SUBMISSION_RESULT_UNKNOWN, ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION, attention; recoveries on Nov 14/16/17 stopped with NONCE_CONFLICT_STABLE_OPERATOR_REVIEW |
| Latest authoritative state | **Not re-read**: this session has no production database or API credentials | **Not re-read** (same reason) |
| Assessment | Legitimate finality wait + stale client + missing wording (code evidence) | Intended stop for a stable conflict; diagnostics improved |
| Engineering correction | Presentation and synchronization only; finality untouched | Diagnostics only; recovery rules untouched |
| Records modified | None | None |

## C–E

Certification, deployment, rollback references and scope compliance are recorded in the PR description and the final delivery report.
