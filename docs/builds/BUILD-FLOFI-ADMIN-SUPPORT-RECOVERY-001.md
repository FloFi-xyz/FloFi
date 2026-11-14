# BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001 — Support, incident diagnostics and safe recovery

`/admin/support` (navigation: **Operations → Support & Recovery**) lets an authorized operator find real incidents, understand them,
and — when, and only when, a registered action applies — fix them from the Admin without a pull request or a deployment. It adds no
database migration, no environment variable and no Railway or Vercel setting. It changes no transaction, wallet, signing, authorization,
mainnet or production-configuration behaviour.

## 1. Discovery: capability inventory

What already existed in the backend, and what the Admin now does with it. Every candidate operation is classified; only those whose
safety the existing code already guarantees became recovery actions.

| Existing mechanism | Where | Behaviour that matters | Classification | In this build |
|---|---|---|---|---|
| `execution_runs` projection (status, `needs_observation`, `attention_required`, `error_code`) | migration 0001, `log-store` projector | Written in the same transaction as each run snapshot | Read-only diagnostics | Incident source and diagnostics |
| `execution_attempts`, `journal_entries` (hash-chained, append-only) | 0001 | Per-attempt state and transaction hash; state transitions | Read-only diagnostics | Timeline (observed / inferred / unknown) |
| Durable work queue `work_items` (READY/LEASED/DONE/DEAD, fenced leases, open-dedupe unique index) | `cloud-runtime/work-queue.ts` | `dead()` sets `attention_required`; the sweeper never re-arms a flagged run | — | The gap this build closes |
| Worker `reconcile` handler | `backend/app.ts` | Re-checks under the run lease that the run still needs observation, then runs the flow's read-only `observe`; never signs, submits, or touches PREPARED | **Conditional idempotent retry** | **`execution.resume-observation`** |
| Worker `evidence.archive` handler | `backend/app.ts` | Content-addressed store write + `ON CONFLICT DO NOTHING` metadata row | **Conditional idempotent retry** | **`execution.retry-evidence-archive`** |
| Sweeper (`sweep`) | `work-queue.ts` | Re-creates missing reconcile/evidence tasks for unflagged runs every minute | Safe state reconciliation (automatic) | Reported: "check not scheduled" means the sweeper is not running |
| Copilot versioned settings + rollback | `admin_settings_versions`, AI Settings | Append-only, audited, validated | Safe reversible administrative adjustment | Linked as guided recovery (never duplicated) |
| In-app owner recovery (`recover-known`, `recover-unknown`, `reconcile`) | `domain/execution-recovery.ts` | Runs with the owner's own wallet | **User action required** | Recommended to the operator; never executed by the Admin |
| `delegation.execute` tasks, `delegated_executions` | 0011, delegation executor | Server-side delegated submission | **Prohibited administrative operation** | Diagnostics only; never retried |
| `automation.evaluate` / `automation.notify` | automations worker | Create proposals, occurrences and notifications | **Prohibited** (non-idempotent side effects) | Diagnostics only |
| `workflow-run.advance`, `workflow_runs` | 0015, workflow-run worker | Advances multi-step runs (may hand off to delegation) | **Prohibited** | Diagnostics only |
| Transaction submission, wallet signing, allowance approval | flows, wallet | Owner-signed only | **Prohibited** | Not reachable from the Admin |
| Unknown outcome → success/failure | — | Would fabricate a result | **Prohibited** | Unknown stays unknown everywhere |
| Schema defects, unclassified statuses, corrupt state, `WORK_PAYLOAD_INVALID` | — | Need a code change or migration | **Code change required** | Classified "Engineering fix required" |
| Missing handler / disabled feature / evidence store not configured | worker env | Need a deployment configuration change | **Code/configuration change required** | Classified "Engineering fix required" (configuration) |
| `/readyz`, queue/scheduler/database probes | `admin/health.ts` | Existing System Health probes | Read-only diagnostics | Platform incidents |

The only executable actions re-queue an existing idempotent task under the run's **original identity** — the same work kind, dedupe key
(`<flow>:<runId>`) and payload the projector and the sweeper use — so the existing worker, its leases and its own re-checks decide
everything that follows. There is no generic retry and no parallel recovery engine.

## 2. Architecture

```
/admin/support (server page)  ──reads──▶  support/view.ts ──▶ incidents.ts  (derived incidents, bounded SQL over existing indexes)
/admin/support/incident?id=…  ──reads──▶                  ──▶ diagnostics.ts (search, timeline, notes)   + health.ts / copilot-view.ts
RecoveryPanel / NoteForm (client) ──POST /admin/api/support──▶ support-http.ts ──▶ recovery.ts ──▶ registry.ts (typed, pure eligibility)
                                                                                   └── one transaction: lock run row → replay? → re-read →
                                                                                       stateToken → eligibility → INSERT work item (ON CONFLICT)
                                                                                       → clear attention (if no other stopped task) → audit
existing Railway worker ──claims──▶ reconcile / evidence.archive handlers (unchanged) ──▶ verify (support/recovery.ts) on every read
```

- **Incidents are derived, never stored.** An incident is a condition the durable state shows now; it disappears when the condition does.
  Sources: execution runs (stopped or unscheduled checks, stopped evidence archiving, uncertain, partial, unclassified, flagged, and failed
  in the last 30 days), stopped background tasks not tied to a run (90 days), multi-step workflow runs in ATTENTION, unresolved delegated
  executions, and the existing System Health / AI Settings conditions. Each read has a fixed LIMIT over an existing index; a source that
  cannot be read is shown as unavailable and the list is marked incomplete.
- **Classification** (`incidents.ts`) is deterministic and reuses the Workflows classifier (`analytics/classify.ts`): severity, category
  (the twelve categories of the brief), affected feature, environment and networks, what is known about the outcome, whether anything was
  submitted, whether funds could be involved, eligibility, and a recommended next step. Eligibility is one of: Recoverable now, Recovery
  requires confirmation (guided AI configuration restore), Waiting for external system, User action required, Engineering fix required,
  Investigation required. "Recoverable now" requires a registered action whose eligibility check passes for that specific execution.
- **Error explanations** (`codes.ts`): exact codes, then ordered name patterns, then an explicit "not in the catalog" fallback. They state
  what a code means, a likely cause only when the code establishes one, the user's action, and whether a deployment could be needed. What
  happened to a specific execution is always read from its own facts, never from its code.
- **Timeline** (`diagnostics.ts`): eight milestones (created, validated, simulation/quote, owner authorization, submitted, seen on the
  network, confirmed/reverted/not found, final state) from the journal and attempts, each marked Observed, Inferred, Unknown, Not recorded
  or Not reached. An unknown submission or result is shown as unknown, never as failed.

## 3. Recovery actions and their exact boundaries

| | `execution.resume-observation` | `execution.retry-evidence-archive` |
|---|---|---|
| Applies to | A run that still `needs_observation`, whose newest `reconcile` task is DEAD with a transient stop reason, or that has no queued check | A run with an unarchived Evidence Bundle whose newest `evidence.archive` task is DEAD with a transient stop reason |
| Never applies when | The run does not ask for observation; a check is READY or LEASED (worker processing); the stop reason is permanent (corrupt state, invalid payload, unknown task kind, unclassified handler failure); the run is flagged but its check did not stop (no registered condition); 3 operator recoveries in 7 days | Already archived; no bundle; queued or running; archiving did not stop (the sweeper handles it); permanent stop reason; retry limit |
| Effect | Inserts one `reconcile` task (original identity); clears `attention_required` only when this kind's own stopped task set it and no other stopped task (per kind and dedupe key) holds it | Inserts one `evidence.archive` task; same attention rule |
| Funds | None: the handler only reads the network; it cannot sign, submit or replace a transaction | None: copies a record of a finished execution |
| Idempotency | Open-task unique index; same-key requests replay the first result (24 h) | Content addressing + insert-if-absent |
| Concurrency | A per-tenant transaction advisory lock (recoveries are serialized, so idempotency keys and the rate limit are checked consistently), then `SELECT … FOR UPDATE` on the run's projection row in its own statement, then every fact re-read in a fresh statement (it sees whatever the queue's dead-letter or the projector committed while waiting), then `ON CONFLICT DO NOTHING` | Same |
| Stale preview | The preview returns a `stateToken` (SHA-256 over every fact eligibility reads); execution requires it unchanged under the lock | Same |
| Verification | Re-reads the task and run: queued/running → **pending verification**; the run no longer asks for observation → **task completed** (the execution's own outcome is shown separately and can still be unknown); DEAD → **stopped again**; otherwise **inconclusive**. A read-back failure after commit reports inconclusive, never failure | Metadata row present → task completed |

Authorization: the existing admin boundary (sealed session → server-side session row → ACTIVE principal, role re-read per request;
POST + JSON + same Origin + no cross-site fetch metadata + CSRF token). Preview is a read (any role). Execution and notes need the new
`recover` permission, which maps to OPERATOR exactly like `write`; it is a separate name so it can be narrowed later without touching
callers. Every request needs a reason (3–200 characters of well-formed text without control, format/bidi, separator characters or markup) and
an idempotency key. Tenant-wide limit: 30 successful recoveries per 10 minutes, checked inside the serialized transaction. Only a registered
action name is ever copied into an audit record.

Audit (append-only `admin_audit_events`, existing table): `SUPPORT_RECOVERY` OK events carry the operation id (`rop_…`), action, run,
flow, idempotency key, queued task id, whether attention was cleared, the precondition observed (`DEAD:OBSERVATION_BUDGET_EXHAUSTED`), run
status and the operator's reason. Refused and failed attempts are recorded with their code (bounded at 200 per 10 minutes). A replayed
request adds no second OK record, so audit rows never look like duplicate actions. `SUPPORT_SEARCH` records the identifier type, a 16-hex
HMAC fingerprint under a dedicated subkey of the admin key (it cannot be reversed by hashing candidate addresses without it) and the result
count — never the value; the row is written in the same transaction as the lookup, so a lookup whose audit fails returns nothing. `SUPPORT_NOTE` records the note (≤ 500 characters, plain text). No address,
key, token, transcript or payload is stored.

## 4. Support lookups and privacy

Lookups are CSRF-protected POSTs to `/admin/api/support`, so an identifier never appears in a URL, a request log or the browser history.
Search accepts only closed identifier shapes: transaction hash or Solana signature, wallet address (EVM or Solana), execution or workflow id, multi-step
workflow run, delegated execution, incident id and background task id. Free text is refused. Results are capped at 25, use existing
indexes (`execution_attempts_transaction`, `execution_runs_owner_history`, `workflow_runs_owner`, `delegated_executions_owner`, primary
keys) and never show a full wallet address. A wallet lookup links a person to their executions, so it needs the OPERATOR role. Each
administrator is limited to 120 lookups per 10 minutes (checked before anything, refused lookups included, is audited).

Funds: submission is read with the same rules as the Workflows classifier (a hash, evidence, a post-broadcast state or a started composition
phase is *submitted*; a possibly-broadcast attempt or a run the flow still observes is *unknown*). Only mainnet runs — or runs whose provenance
is not recognised, shown verbatim — are marked as possibly involving real funds and can be high severity; test-network and mocked runs say so.

## 5. Deployment and migration

- **No migration.** Recovery records and notes are audit events in the existing append-only table (its `kind` index serves the history
  reads); recovery writes use existing columns (`work_items` insert, `execution_runs.attention_required`). Nothing locks or alters a table.
- **No environment variable, no Railway change, no Vercel change.** The console runs where it already runs (Vercel, `FLOFI_ADMIN=enabled`);
  the worker already runs the two handlers. The Admin makes no RPC or provider call for support (System Health's existing `/readyz` probe
  excepted), so an external outage degrades only that probe.
- **Rolling deployment:** an older Vercel deployment simply lacks the page; an older worker handles the re-queued tasks with the same
  handlers. Rolling back the build leaves only audit rows behind.

## 6. Validation

| Gate | Result |
|---|---|
| Unit: `src/admin/support/support.test.ts` | catalog, registry eligibility, state token, attention rule, classification of every incident kind, search shapes, notes, timeline evidence, verification |
| PostgreSQL: `src/admin/support/support-http.pg.test.ts` (served handler, real admin sessions) | discovery from persisted rows, incomplete telemetry, tenant isolation, VIEWER refusal (audited), CSRF and origin refusal, unregistered action refusal, idempotent replay and key reuse, 6 concurrent requests → 1 task, stale preview, worker already processing, pending confirmation, finalized execution, permanent stop reason, attention kept for another stopped task, retry limit with STOPPED_AGAIN verification, no attempt/journal side effects, evidence retry, search redaction and wallet restriction, query bounds, note validation |
| PostgreSQL end to end: `backend/support-recovery-cloud.pg.test.ts` | real transfer service + real worker `reconcile` handler on a MOCKED chain: stopped check discovered → resumed → reconciled → verified RESOLVED, exactly one transaction on chain, nothing left to recover |
| Browser: `e2e/admin-console.spec.ts` (Support & Recovery) | discover → diagnose → preview → confirm → run → result; note; audited lookup; 390 px without horizontal scroll; VIEWER read-only; token-less API refusal |

The exact commands and their output for this build are in the pull request.

## 7. Known limitations and unsupported incident types

- Only the two re-queue actions are executable. Delegated executions, automation evaluations and notifications, multi-step workflow
  advances, emails, transaction submission and anything involving a signature are diagnostic only, by design.
- Outcome-unknown executions in owner-recoverable statuses need the owner to open FloFi; the Admin cannot act for them.
- When a task's dead reason is `OBSERVATION_BUDGET_EXHAUSTED`, the queue does not keep the retry reasons that preceded it, so the
  underlying cause (RPC outage, disabled network) is not visible; a resumed check that hits the same cause stops again after its budget.
- The Admin does not read chain state itself; the worker remains the only observer. A stuck worker shows as "check not scheduled" or
  "waiting longer than 5 minutes" and needs the Railway service.
- Incident notes (New / Investigating / Escalated / Resolution noted) come from notes only; the condition itself stays open until the
  durable state changes. "Under investigation" needs an explicit note within the 90-day notes window; an older acknowledgement lapses.
- Completed background tasks are pruned after 14 days while stopped ones are kept. A stopped task whose successful re-run was pruned therefore
  reads as unresolved again, except for the two recovery kinds, whose resolution is read from the run itself (no longer observed with a reconciled
  verdict; evidence present in the store). No other task kind tied to an execution exists today.
- Failed executions are listed for 30 days and stopped tasks for 90 days; very old stopped checks still appear while the run is flagged.
- Recovery is proven against loopback PostgreSQL, the real worker handler and MOCKED chains, not against a production incident.
- Audit text (reasons, notes) and lookup fingerprints are stored in the append-only audit table, which has no deletion path. The owner
  approved an auditable recovery history but **not** indefinite retention of identifiable personal data; the retention periods, purposes,
  candidate lawful bases and the structural options for enforcing them are proposed for counsel in §9 and are **not implemented** (they need a
  reviewed migration). Identifier screening of free text is best effort. Opening a diagnostics page is not audited (lookups are).
- No index was added (no migration): the `attention_required` and `needs_observation` candidate scans and the stopped-task supersession check
  use the same unindexed predicates as System Health, bounded by LIMIT. On a very large tenant they can read many rows per Support page load;
  partial indexes would be a future, separately reviewed migration.
- A VIEWER sees transaction hashes in diagnostics; a public explorer reveals their sender, so the OPERATOR-only wallet lookup limits
  convenience, not knowledge.
- A run that the sweeper re-arms through its PREPARED / `*_SUBMISSION_EXPIRED_NOT_EXECUTED` path (`needs_observation` false) is not
  recoverable from the Admin if that check stops; it is listed as flagged for attention (investigation).
- Network names come from indexed analytics facts; a run that was never indexed shows its environment only.

## 8. Addendum — execution attention, historical incidents and reconciliation accuracy

### 8.1 Problem

The raw `execution_runs.attention_required` flag is written only by the queue's dead-letter (`work-queue.ts` `dead()`) and is never cleared
except by a registered Support recovery. System Health counted it as "flagged for attention", Workflows listed every flagged run as "requiring
attention" and the Overview counted range-scoped classifier attention, so a run whose stopped task was later superseded, or whose
transaction completed, still looked like an active incident — and the three pages could disagree.

### 8.2 One model, two dimensions

`src/admin/support/lifecycle.ts` is the single classifier, used by System Health (`health.ts`), the Overview attention list
(`attention.ts`), the Overview and Workflows range figures (`analytics/view.ts` → `summarize`), Workflows' attention sections and Support &
Recovery (`incidents.ts`, `view.ts`). The **transaction outcome** (from `analytics/classify.ts`, unchanged) and the **incident lifecycle** are
separate fields everywhere.

| Lifecycle | Rule (durable evidence only) |
|---|---|
| Active | an unresolved condition exists now: outcome unknown; partial; unclassified status; observation exhausted (needs observation, newest `reconcile` DEAD); check not scheduled (needs observation, no open check, quiet > 15 min); evidence archiving stopped (bundle not in the store, newest `evidence.archive` DEAD); another task kind stopped and not superseded; a stopped task re-queued and not finished. **The flag is not required.** |
| Under investigation | active, and the latest support note on the incident (90-day window) is an acknowledgement, finding, decision or escalation. Opening a page never counts. A later "resolution" note cannot resolve an active condition. |
| Historical attention | flagged, no active condition now, but no incident-specific evidence of resolution (e.g. the run stopped being observed without an Evidence Bundle, or no stopped task is recorded so the cause cannot be reconstructed). **Not a resolution.** |
| Verified resolved | flagged, no active condition, final outcome, and **every** task that ever stopped for the run has resolution evidence: a later run of the same task completed; or the stopped check was superseded by a reconciled verdict with an Evidence Bundle and every submitted attempt reconciled; or the stopped archive's bundle is now in the evidence store. A terminal status alone never qualifies. |

Stopped tasks are read from `work_items` (DEAD rows are never pruned) through a new `stoppedKinds` field of the recovery facts. It is not part
of the recovery eligibility rules or the state token, so the registry's preconditions and the recovery engine are unchanged (asserted by tests).
An owner "review required" code (`<FLOW>_SEMANTIC_EDIT_REQUIRES_REVIEW`, `_WALLET_CHANGED_REVIEW_REQUIRED` — set by a flow's `invalidate` when the
owner edits the workflow after review) is reported separately: it gates future execution of that workflow, is not an operational incident and is
not evidence of resolution. Nothing writes: the flag, the error code, the execution status and the evidence are shown as recorded.

### 8.3 Admin pages

- **System Health** — "Execution attention": active (with under investigation), outcome unknown, observation exhausted / not scheduled,
  awaiting reconciliation, historical attention, verified resolved; the raw flag total is in the technical details. An attention item is
  raised only for active incidents (red when one is on mainnet or an unrecognised network); "Operating normally" mentions historical flags as
  "not verified resolved". A truncated classification raises its own warning.
- **Overview** — the glance tile is "Active execution incidents" (all environments, all time, from the same model; historical counted apart);
  the range KPI "Active incidents" counts executions in the range and environment that have an open lifecycle run.
- **Workflows** — "Requiring attention" lists active and under-investigation runs from the shared model (all environments, all time, same count
  as System Health), with the transaction outcome, the lifecycle, the reason and a Diagnose link; "Historical attention" lists historical and
  verified-resolved runs separately; every execution row carries its lifecycle badge. If the model cannot be read, the old classifier list is
  shown with a warning that it mixes historical flags.
- **Support & Recovery** — an "Execution attention" KPI row with the same figures, a Lifecycle filter (Open — default — Active, Under
  investigation, Historical, Verified resolved, Final failures, All), the lifecycle on every incident card, and on Diagnose the lifecycle, its
  explanation and the stopped-task history (times stopped, last reason, status now, resolution basis). Historical and verified-resolved
  executions are incidents of kind `ATTENTION_HISTORICAL` with eligibility "No action needed" and no actions. A new note type,
  "Acknowledged — under investigation", records explicit review.

Intentional scope differences are labelled on the page: the glance tile, System Health, Workflows' attention sections and Support's KPI row are
all-time and all-environment run counts; the Overview range KPI counts executions (recovery runs folded in) in the selected range and environment.

### 8.4 Interaction with the recovery registry

Unchanged: the same two actions, preconditions, state token, lock order and verification. Incident kinds map from the lifecycle conditions
(observation exhausted → "Transaction check stopped", offering *Resume transaction check* when the registry's own check allows it). Historical and
verified-resolved incidents offer no action. No "mark resolved" control exists; notes change only the incident lifecycle, never transaction truth.
Nothing re-opens a stopped job automatically.

### 8.5 The production snapshot (2026-11-14) — what this build can and cannot establish

This session has **no access to the production database or to production logs** (and requested none). The classification below is therefore
the rule each record falls under, given the facts reported in the request; the deciding fact for the ten terminal records — their stopped-task
history and whether their Evidence Bundle is in the store — was not in the snapshot. The deployed Support page computes it read-only
(`/admin/support?lifecycle=ALL`); the equivalent read-only query is in §8.6.

| Records | Status · environment | Classification under this build |
|---|---|---|
| Execution A `xuni-379461c2…1d21`, Execution B `xroute-a09617c2…fd32` | SUBMISSION_RESULT_UNKNOWN · PUBLIC_MAINNET | **Active** — observation exhausted (500 deliveries, `OBSERVATION_BUDGET_EXHAUSTED`) and outcome unknown; high severity, funds possibly involved, submission unknown. Never failed, never resolved. |
| 6 × RECONCILED · PUBLIC_TESTNET, 2 × RECONCILED · PUBLIC_DEVNET, 1 × COMPLETED · PUBLIC_DEVNET | terminal | Per record: **active** if a stopped task is still unresolved (typically an evidence archive whose bundle is not in the store); **verified resolved** if every stopped task has resolution evidence (re-run completed, reconciled verdict with Evidence Bundle and all attempts reconciled, or bundle archived); otherwise **historical**. The terminal status alone decides nothing. |
| Jupiter `jupiter-swap` RECONCILED · PUBLIC_MAINNET, `JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW`, has_evidence | terminal | Same rule. The error code is the owner's "edited after review" authoring state (the swap had already reconciled), reported as *owner review pending — not an incident*; it is neither the reason for the flag (only a stopped task sets it) nor evidence of resolution. |

So the active count is **at least 2** (A and B) and at most 2 + the number of terminal records with an unresolved stopped task. If every terminal
record's stopped task was a superseded check with a reconciled verdict and evidence (or an archive whose bundle is now stored), the result is
2 active and 10 historical/verified — but that must be read from the data, not assumed.

**Execution A — `UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION`.** In `universal-router/service.ts` this verdict is recorded only when no
receipt exists for the attempt's hash (none was reported), the deposit-log scan found nothing, and the account's nonce reserved for the reviewed
transaction was consumed by a transaction whose target, data or value differ (`sameEvmIntent` false). The service stores that transaction's hash
as `conflictingTransactionHash` in the run's durable log (not in `execution_attempts`, so not shown by the Admin). What this establishes: the
reviewed transaction did **not** land at that nonce. What it does not: whether the wallet sent the same intent with another nonce. Outcome:
**unknown** — nonce consumption is not proof of execution or non-execution.

**Execution B — `ROUTER_TRANSACTION_NOT_OBSERVED`.** In `router-service.ts` this is recorded only when neither a transaction nor a replacement
hash was reported, the nonce was not yet consumed at the last check, no matching transaction was in the node's pending pool and the deposit
scan found no deposit — and the protocol deposit deadline had not been proven passed with a complete scan (that case is recorded as
`ROUTER_SUBMISSION_EXPIRED_NOT_EXECUTED`, provably not executed). No transaction hash exists anywhere for B by construction. Outcome:
**never demonstrably submitted, but not excluded** — still unknown.

**Read-only next steps for the owner (not performed here).** For each, from the run's log: chain, sender, prepared nonce, prepared block and
(for A) `conflictingTransactionHash`. Then, on at least two independent sources (RPC providers or explorers), at a finalized block:
(1) the account's current nonce and the transaction at the prepared nonce; (2) for A, confirm the conflicting transaction and compare its
target/data/value; (3) search the sender's later transactions for the reviewed intent (another nonce); (4) the bridge's deposit events for this
depositor from the prepared block to the route's `depositMustLandBy`, and the destination fill; (5) for B, whether `depositMustLandBy` has passed on a
finalized block with a complete scan, which is the only protocol-backed proof of non-execution. The registered, read-only *Resume transaction
check* lets the service itself re-run exactly these checks (for B it can reach the provable `…_EXPIRED_NOT_EXECUTED` verdict if the scan
completes); it is eligible for both runs, is **not** run by this build, and should be run only by an operator after reading §3 — for A it will
conclude the same unless the deposit scan finds the deposit, and either run can stop again after its budget if the original cause persists.

### 8.6 Read-only classification query

Run in a read-only transaction; it returns no address, hash or key — only presence flags and codes.

```sql
BEGIN READ ONLY;
SELECT r.run_id, r.flow, r.status, r.provenance, r.error_code, r.needs_observation, r.has_evidence,
  EXISTS (SELECT 1 FROM evidence_objects e WHERE e.tenant_id = r.tenant_id AND e.run_id = r.run_id) AS evidence_archived,
  (SELECT json_agg(json_build_object('step', a.step, 'state', a.state, 'hash', a.transaction_hash IS NOT NULL, 'reconciled', a.reconciled) ORDER BY a.created_at)
     FROM execution_attempts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id) AS attempts,
  (SELECT json_agg(json_build_object('kind', d.kind, 'stopped', d.n, 'last_error', d.last_error, 'newest_state',
       (SELECT w.state FROM work_items w WHERE w.tenant_id = r.tenant_id AND w.run_id = r.run_id AND w.kind = d.kind ORDER BY w.id DESC LIMIT 1)))
     FROM (SELECT kind, count(*) AS n, (array_agg(last_error ORDER BY id DESC))[1] AS last_error FROM work_items
           WHERE tenant_id = r.tenant_id AND run_id = r.run_id AND state = 'DEAD' GROUP BY kind) d) AS stopped
FROM execution_runs r WHERE r.tenant_id = 'default' AND r.attention_required ORDER BY r.updated_at DESC;
ROLLBACK;
```

Map each row with §8.2: an unresolved `stopped` kind (newest state DEAD — for `reconcile` while `needs_observation`, for `evidence.archive` while
not archived) or an unknown/partial/unclassified status → active; every stopped kind resolved and a final outcome → verified resolved; else
historical.

### 8.7 Validation (addendum)

| Requirement | Test |
|---|---|
| 1 terminal + historical flag · 2 terminal + independent unresolved incident · 3 reconciled + unrelated owner review · 4/7 uncertain without hash or evidence · 5 two exhausted mainnet jobs with 500 deliveries · 6 nonce consumed by a different transaction · 8 inconclusive evidence after a completed check · 9 active vs historical counts (the 12-record shape) · 11 purity / no mutation · recovery eligibility and state token unchanged | `src/admin/support/lifecycle.test.ts` |
| 10 consistency across Overview, System Health, Workflows and Support · 11/15 nothing written (runs, attempts, tasks, evidence, audit) · 14 cross-tenant isolation · 12 lifecycle audit append-only · 13 VIEWER refused / OPERATOR acknowledgement → under investigation; a resolution note cannot resolve an active condition | `src/admin/support/support-http.pg.test.ts` (database rows shaped like production) |
| Attention items: active only, red on mainnet, historical never alerting, truncation warning | `src/admin/attention.test.ts` |
| Browser: historical flag kept out of the open list and listed under its own lifecycle; Workflows and System Health show the same split; a note makes the incident under investigation while the outcome stays not established | `e2e/admin-console.spec.ts` |
| 16 existing Support & Recovery suites | unchanged and passing (unit, PostgreSQL, end-to-end cloud recovery, browser) |

No migration, no environment variable, no Railway or Vercel change. No production read or write was made by this build.

## 9. Privacy, retention and lawful bases (proposal for counsel — not implemented)

**Owner decision (2026-11-14).** Keep an auditable operational recovery history; do **not** keep identifiable personal data indefinitely;
minimise personal data in notes and reasons; pseudonymise lookup identifiers; design for retention limits and data-subject rights; do not add a
deletion mechanism that compromises financial audit integrity; document options before changing audit storage.

**What is stored today** (all in `admin_audit_events`, append-only by trigger; nothing deletes it):

| Record | Personal data | Minimisation in place |
|---|---|---|
| `SUPPORT_RECOVERY` | operator principal id; execution run id (pseudonymous, links to an owner wallet through the run); operator's reason | reason screened: no wallet addresses, hashes, e-mails, 8+ digit runs or @handles; ids and codes only otherwise |
| `SUPPORT_NOTE` | operator principal id; incident id; note text | same screening; notes shown only to administrators |
| `SUPPORT_SEARCH` | operator principal id; identifier **type**; a 64-bit keyed fingerprint (HMAC with a dedicated subkey of `FLOFI_ADMIN_SESSION_SECRET`); result count | the identifier itself is never stored, logged or put in a URL; wallet lookups need OPERATOR |

The fingerprint is pseudonymous personal data (re-identifiable by whoever holds the key and the identifier); it exists so the owner can answer
*who looked up this person, and when* — itself an input to an access request.

**Proposed retention, purposes and candidate lawful bases.** LGPD art. 6 X (accountability) is a **principle** and art. 18 lists **data-subject
rights**; neither is a lawful basis. The candidate bases are LGPD art. 7 (and art. 11 for sensitive data, which none of these records should
contain) and GDPR art. 6(1). Each needs counsel's confirmation, and legitimate interest needs a documented balancing test (LGPD art. 10; GDPR
recital 47 / art. 6(1)(f)).

| Record | Purpose | Proposed retention | Candidate LGPD basis | Candidate GDPR basis |
|---|---|---|---|---|
| Recovery event skeleton (who, when, action, run id, operation id, outcome, code, verification) | accountability for administrative actions on execution infrastructure; security; defence in disputes about an execution | as long as the related execution record is kept, capped at 5 years after the execution (to be aligned with whatever retention counsel sets for the execution history itself) | art. 7 IX legitimate interest; art. 7 VI regular exercise of rights in proceedings; art. 7 II only where a specific legal or regulatory duty applies to FloFi | art. 6(1)(f); art. 6(1)(c) only for a specific Union/Member State obligation; art. 17(3)(e) for legal claims |
| Recovery reason text, note text | explain a decision to other operators | 12 months, then redact the text and keep the skeleton and a hash | art. 7 IX | art. 6(1)(f) |
| Lookup audit (type, fingerprint, count) | access accountability, abuse detection, answering access requests | 12 months | art. 7 IX (security and accountability of access; cf. art. 46 duty) | art. 6(1)(f) (cf. art. 32 duty) |
| Notes window used by the UI ("under investigation") | operational state | 90 days (display only, already implemented) | — | — |

Counsel should also confirm: whether any record falls under Marco Civil da Internet art. 15 (application access logs, 6 months) — these are
operator records, not end-user access logs, so probably not; the privacy notice text covering operator access to execution records for support;
and treatment of database backups (Neon point-in-time recovery keeps deleted or redacted data until the backup window passes).

**Rights handling.** Access (LGPD art. 18 II / GDPR art. 15): records about a person are found by computing the fingerprint of their wallet and
by their run ids; a documented, read-only owner procedure is needed (not built). Correction: notes are append-only; a correcting note is
added. Erasure / anonymisation (LGPD art. 18 IV and VI / GDPR art. 17): not possible in place today; the options below make it possible
without touching the event skeleton. Objection: handled by the legitimate-interest balancing test.

**Structural options (each needs a reviewed migration; none was made):**

1. **Separate the free text (recommended).** A new table `admin_support_texts (tenant_id, text_id, body, created_at, expires_at)`; audit rows
   keep `text_id` and the SHA-256 of the body. A retention job (and an erasure request) deletes expired or requested bodies; the audit table stays
   strictly append-only and still proves that a text existed and what its hash was. *Risk:* the content is gone for a later dispute; a two-table
   write must stay atomic (one transaction, as today).
2. **Epoch keys for fingerprints and text (crypto-shredding).** Random per-period keys in a new key table; fingerprints and encrypted bodies
   use the period key; deleting a key after the retention period makes that period's fingerprints unlinkable and bodies unreadable without
   touching rows. *Risk:* key-management complexity; keys in backups; losing a key early loses audit content.
3. **Narrow, audited redaction inside `admin_audit_events`.** A SECURITY DEFINER function allowed to null only `detail.text`/`detail.reason` of
   `SUPPORT_*` rows older than the retention period, writing a `SUPPORT_REDACTION` event. *Risk:* weakens the table's append-only guarantee and
   needs a trigger change; hardest to defend as tamper-evident. Not recommended.

Until one is approved and built, rotating `FLOFI_ADMIN_SESSION_SECRET` (which also ends every admin session) is the only available way to make
existing fingerprints unlinkable, and reasons and notes are kept as written — so operators must keep personal data out of them.
