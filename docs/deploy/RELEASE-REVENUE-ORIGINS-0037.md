# Release: execution origins and the platform fee ledger (migration 0037)

BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001. Owner-run procedure. Nothing here signs, submits or moves funds. Every step is idempotent.
Schema facts: [SCHEMA-COMPATIBILITY.md §29](SCHEMA-COMPATIBILITY.md#29-certificate-0037_execution_origins_platform_fees).

## 0. Preconditions

- The production database is at exact schema 36 (`schema_migrations` head `36 studio_certification`).
- The build that carries the 0037 certificate is deployed to every database consumer (API, worker, web). Until step 1 it serves schema 36
  with origin recording, the backfill and the fee ledger dormant.

## 0b. Rehearse

Rehearse steps 1 to 3 on a disposable Neon branch of production with the dedicated SQL roles, and keep the catalog and verify reports.

## 1. Apply 0037

```bash
DATABASE_MIGRATION_URL=… node apps/reference-dapp/backend/admin-cli.ts revenue-origins-migrate --tenant default
```

Expected: `{"applied":[37]}`; a rerun applies nothing. A lock timeout (5 s) rolls back completely; retry later.

## 2. Apply the schema-37 least-privilege policy

Apply `docs/deploy/database-privileges/apply.sql` with the updated `policy.sql` as described in
[DATABASE-LEAST-PRIVILEGE.md](DATABASE-LEAST-PRIVILEGE.md), then run `verify.sql`. The policy pins the schema-37 ledger, so it must be applied
after step 1, never before. New grants: runtime `SI` on `execution_origins`; admin web `S` on the three new tables; admin operations `SI` on
the three new tables and `S` on `workflow_run_steps` (read-only step facts the backfill and the accrual need).

Run step 2 immediately after step 1. In between, on a database enforcing the schema-36 policy, origin writes fail quietly (nothing breaks;
those executions keep no origin) and the Admin fee and channel panels are unavailable. From step 2 on, new executions record their origin
when they are created (§2b), approval-page runs included.

## 2b. What is recorded at creation (no step to run)

First record wins; nothing ever updates an origin row. Evidence codes are closed values in `execution_origins.evidence`.

| Created by | Origin | Evidence |
|---|---|---|
| `/app`, the Review the web Chat itself started, with the Chat's initiation reference verified on the server | `web_chat` | `WEB_CHAT_INITIATION` |
| `/app`, anything else (Editor controls; no or an unverifiable reference; no FloFi account session) | `web_editor` | `WEB_EDITOR_SERVER_ACTION` |
| `/app`, through an API still receiving a BFF of the previous build (rolling deployment only) | `web` (legacy) | `WEB_APP_SERVER_ACTION` |
| An approval page (`/approve`, `/mcp/approve`), the run's reviewed workflow hashing exactly to one live single-flow approval claimed by the request's proven wallet, which also owns the run | the approval's requester (`mcp_chatgpt`, `mcp_claude`, `mcp_other`, `telegram`, `developer_api`, `automation`) | `APPROVAL_PAGE_CREATION` |
| A workflow run from an Editor handoff, created by the in-place Authorize carrying a verified Chat reference | `web_chat` | `WEB_CHAT_INITIATION` |
| Any other workflow run (Editor handoffs included) | its approval's requester (Editor: `web_editor`) | `APPROVAL_REQUESTER` |

The approval-page attribution no longer depends on the owner's status sharing: sharing still decides only what the requester can see, and
`bindRuns` still binds (and, for a web record made at creation, corrects once through an append-only row) when sharing is on. Approvals of
different channels that all match the same run record nothing (Unknown until a binding or the backfill decides).

**The Chat initiation reference** (`src/server/chat-initiation.ts`): the Chat's own server action issues it to the FloFi account signed in on
that request, on `/app` only; HMAC-SHA256 with a key derived (HKDF, purpose `flofi/chat-initiation/v1`) from the wallet-session key
(`FLOFI_SESSION_SECRET`, else `API_AUTH_TOKEN`): no new variable. It carries a keyed digest of tenant and account (no account id, wallet address or
email in clear), its issue and expiry instants (15 minutes) and a nonce. The browser presents it in a host-only, `SameSite=Strict` cookie scoped
to `/app` only while the Chat's own Review runs. FloFi's web server verifies it on every creating call against that request's account session and
tells the API only the closed result (`x-flofi-execution-surface: web-chat | web-editor | approval-page`, plus the proven wallets for an approval
page, on the bearer-authenticated call). Anything unverifiable is Web Editor; nothing ever fails or waits for it. What it proves: the server issued
it recently to the account that creates the run and the browser presented it for the Chat's Review; not which control a person pressed. Rotating
the session secret only makes Chat executions in flight record as Web Editor.

**Deployment order** (remote runtime): deploy the API before the web. An API of the previous build ignores the new header values (those
executions keep no creation origin; approval-page runs are still bound when sharing is on); a web of the previous build sends `web-app`, which the
new API records as the legacy `web`. On the embedded runtime both halves ship together.

**Check after deploy** (read only):

```sql
SELECT origin, evidence, count(*) FROM execution_origins WHERE recorded_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2;
```

## 3. Recover historical origins (dry run first)

```bash
DATABASE_ADMIN_OPERATIONS_URL=… node apps/reference-dapp/backend/admin-cli.ts origin-backfill --tenant default \
  --approvals-complete-since <oldest retained approval, ISO>
```

The dry run reports every root single-flow run without an origin by class: `BOUND` (an approval bound it), `NO_APPROVAL` (no approval page
could have created it: Legacy Web), `AMBIGUOUS` (an approval could have; stays Unknown), `CONFLICTING_BINDINGS`, `BEFORE_COMPLETE_HISTORY`.
`--approvals-complete-since` must not precede the oldest retained approval (the command refuses with `ORIGIN_BACKFILL_HISTORY_INCOMPLETE`).
An applied approval can produce runs until retention removes it (30 days), so by default only runs created 31 days after the oldest retained
approval can be proven approval-free. If the owner confirms that no approval was ever removed (retention never ran), add
`--assert-approvals-never-purged` (recorded in the audit event); the horizon is then one day:

```bash
… origin-backfill --tenant default --approvals-complete-since <same> --assert-approvals-never-purged --apply --approval-ref <owner approval reference>
```

It writes only missing origins (first record wins) and one `EXECUTION_ORIGINS_BACKFILLED` audit event, never changes an execution, its
evidence, amounts or timestamps, and never creates a fee obligation. A rerun records nothing.

Read-only pre-check on production (2026-11-27, SQL equivalent of the dry run, nothing written): 78 reconciled root single-flow mainnet runs;
70 `NO_APPROVAL` (would be Legacy Web), 5 `AMBIGUOUS` (stay Unknown), 2 bound to MCP approvals, 1 a workflow-run step (not an execution).
The 36 retained approvals start 2026-10-09T23:04:09Z, before the first mainnet run (2026-10-11T22:14:24Z), and 20 are older than 30 days, so
retention has removed nothing since 2026-11-08; whether anything older was ever removed cannot be proven from the database, so the short horizon
needs the owner's `--assert-approvals-never-purged`. Without it, the default 31-day horizon recovers only runs from 2026-11-09 on. The exact
figures are the command's own dry-run output after step 2.

A run that automated evidence cannot resolve can be corrected only with an approval reference (audit trail; the recorded origin is never
rewritten):

```bash
… origin-correct --tenant default --run <run id> --origin <web_chat|web_editor|web|legacy_web|mcp_chatgpt|mcp_claude|mcp_other|telegram|developer_api|automation|unknown> \
  --reason-code <CODE> --approval-ref <ref>
```

## 4. Fee accounting (optional, owner decision)

Set `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM` to the instant accounting starts (never in the past: anything created before it is never
accounted). Then:

```bash
DATABASE_ADMIN_OPERATIONS_URL=… FLOFI_PLATFORM_FEE_ACCOUNTING_FROM=… node apps/reference-dapp/backend/admin-cli.ts platform-fee-accrue --tenant default
… platform-fee-accrue --tenant default --apply
```

It records what terminal workflow runs owe (DUE / NOT_APPLICABLE / WAIVED / UNSUPPORTED), one row per run. Collection is not implemented and
stays off: the Admin fee panel shows `PLATFORM_FEE_AUTHORIZED_BASIS_NOT_RECORDED` (or an earlier missing condition). Rows are accrued estimates of
what the policy would charge, not amounts any owner authorized: no workflow Review discloses or records a fee basis yet. Activating collection needs
a separate, reviewed build with an approved collection rail, a verified treasury and an approved accounting policy.

## Before any fee policy change

Run a complete `platform-fee-accrue --apply` pass first. Accounting never starts before the current policy's effective instant, so completions
of the earlier policy that were never accrued are not accounted afterwards.

## Rollback

- Accounting: unset `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM`; nothing new is accrued, existing rows stay.
- Code: roll back to a build that carries this certificate; it serves schema 37. A 0036-only binary refuses schema 37.
- Emergency schema reversal (0037 as head only): `docs/deploy/RELEASE-REVENUE-ORIGINS-0037.reversal.sql` as the migration owner (refuses
  while any fee is owed or collected), then restart every consumer and re-apply the schema-36 policy (`ca62ace`). Origins are lost; nothing
  else changes.
