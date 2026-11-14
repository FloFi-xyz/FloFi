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
- Incident status (New / Investigating / Escalated / Resolution noted) comes from notes only; the condition itself stays open until the
  durable state changes.
- Failed executions are listed for 30 days and stopped tasks for 90 days; very old stopped checks still appear while the run is flagged.
- Recovery is proven against loopback PostgreSQL, the real worker handler and MOCKED chains, not against a production incident.
- Audit text (reasons, notes) and lookup fingerprints are append-only with no retention period and are not removed by an owner's history purge;
  identifier screening of free text is best effort. Retention and its legal basis need the owner's (and counsel's) acceptance — see ADMIN.md §5c.
  Opening a diagnostics page is not audited (lookups are).
- No index was added (no migration): the `attention_required` and `needs_observation` candidate scans and the stopped-task supersession check
  use the same unindexed predicates as System Health, bounded by LIMIT. On a very large tenant they can read many rows per Support page load;
  partial indexes would be a future, separately reviewed migration.
- A VIEWER sees transaction hashes in diagnostics; a public explorer reveals their sender, so the OPERATOR-only wallet lookup limits
  convenience, not knowledge.
- A run that the sweeper re-arms through its PREPARED / `*_SUBMISSION_EXPIRED_NOT_EXECUTED` path (`needs_observation` false) is not
  recoverable from the Admin if that check stops; it is listed as flagged for attention (investigation).
- Network names come from indexed analytics facts; a run that was never indexed shows its environment only.
