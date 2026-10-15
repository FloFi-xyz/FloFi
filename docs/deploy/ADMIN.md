# FloFi Admin console — operator guide (BUILD-ADMIN-001)

A private console at `/admin` for operators: platform-wide workflow analytics (network distribution included), automation and
delegated-execution metrics, system health, and versioned runtime settings for the Copilot interpreter. It is separate from the product:
nothing links to it, end users see no change, and it adds no step, limit or condition to the permissionless user journey.

The console has **no financial authority**. It cannot sign, submit, approve, cancel or change an execution, a rule or an approval. The
Copilot stays an untrusted interpreter: an administrator chooses *which model interprets and how*, never what it may do (instructions,
strict output schema, grounding and every later Simulate/Review/signature step are code, not settings).

## 1. What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| `/admin` pages and `/admin/api/*` | Vercel (Next.js server) | server components and JSON route handlers; nothing new runs on Railway |
| Admin state, analytics reads | the existing PostgreSQL platform state (`platformStateHost`) | the same database and tenant as the Railway API/worker in production; Vercel already holds the pooled `DATABASE_URL` for MCP/Developer/Channels |
| Copilot settings resolver | wherever the Copilot runs: the chat server action and Channel Core (both Vercel) | one primary-key read per live Copilot request, no cache |
| Grants | operator CLI `apps/reference-dapp/backend/admin-cli.ts` | the console cannot create, elevate or restore an administrator |
| Schema | migration `0012_admin_control_plane` | additive: five `admin_*` tables and one read index (automation evaluation history); nothing on `execution_runs`. Certified for the previous build (BUILD-DB-COMPAT-001, [SCHEMA-COMPATIBILITY.md §3](SCHEMA-COMPATIBILITY.md#3-certificate-0012_admin_control_plane)): its bytes are frozen (SHA-256 `25556fbf…`) |

## 2. Enable (Vercel, server-only variables)

| Variable | Value |
| --- | --- |
| `FLOFI_ADMIN` | `enabled` (anything else: `/admin` answers 404) |
| `FLOFI_ADMIN_SESSION_SECRET` | `openssl rand -hex 32`, **dedicated**: 32–512 characters, refused if equal to any other secret FloFi reads (`FLOFI_SESSION_SECRET`, `API_AUTH_TOKEN`, channel, automation, developer, MCP, webhook, provider, object-store or cron secrets, `OPENAI_API_KEY`) |
| `DATABASE_URL` | already required for platform state (pooled Neon URL); without it the console reports `ADMIN_STORE_NOT_CONFIGURED` |
| `FLOFI_COPILOT_RUNTIME_CONFIG` | optional break-glass: `disabled` ignores stored Copilot settings and uses `OPENAI_COPILOT_*` only |

Never `NEXT_PUBLIC_*`. Rotating `FLOFI_ADMIN_SESSION_SECRET` signs every administrator out (sessions are also server-side rows).

## 3. Grant, revoke, audit (operator CLI)

Run from a trusted shell with the deployment's database URL (the CLI prints ids and codes only, never a secret):

```sh
export DATABASE_URL=…   # read with `read -rs`, never pasted into a chat or committed
node apps/reference-dapp/backend/admin-cli.ts grant --tenant default --wallet 0x… --role OPERATOR --label "Owner"
node apps/reference-dapp/backend/admin-cli.ts list --tenant default
node apps/reference-dapp/backend/admin-cli.ts revoke --tenant default --principal adm_…     # ends that administrator's sessions at once
node apps/reference-dapp/backend/admin-cli.ts end-sessions --tenant default                 # signs every administrator out
node apps/reference-dapp/backend/admin-cli.ts audit --tenant default --limit 50
node apps/reference-dapp/backend/admin-cli.ts index --tenant default                         # optional analytics backfill (read-only on runs)
```

A Vercel Preview uses `--preview-branch <git branch>` instead of `--tenant`. Roles: **VIEWER** reads everything; **OPERATOR** also changes
AI settings and runs live probes. One active grant per wallet; a role change is `revoke` + `grant`.

## 4. Sign-in and sessions

The administrator opens `/admin`, picks an injected EVM wallet and signs an admin-only EIP-4361 statement ("This signature authorizes no
transaction, moves no funds and grants no access by itself"). The server recovers the signer and admits it only with an ACTIVE grant, then
records a server-side session (4 hours, absolute). The browser holds only a sealed, host-bound reference in an HttpOnly, SameSite=Strict
cookie scoped to `/admin`. Every page and API re-reads the session row and the grant, so sign-out, `revoke` and `end-sessions` are
immediate. A signed challenge opens at most one session. A product wallet session is never accepted here, nor the reverse.

Mutations require a same-origin `POST` with `application/json`, a matching `Origin`, no cross-site `Sec-Fetch-Site`, and the session's
CSRF token header. `/admin` responses are `no-store`, `noindex`, `no-referrer` and never framed. Refused sign-ins are audited without
the wallet address.

## 5. AI Settings (Copilot runtime configuration)

Settings: model id, temperature (0–1 or not sent), reasoning effort (or not sent), max output tokens (256–16,384), request timeout
(5–60 s); a default plus optional overrides for FloFi chat (web), Telegram and WhatsApp (an override replaces the default as a whole).

* **Versioned and audited.** Each save appends version *n + 1* (append-only, gapless; a concurrent save of the same version loses with
  `ADMIN_SETTINGS_VERSION_CONFLICT`). *Restore* appends a version copying an older one; *Return to environment bootstrap* appends an empty
  version. Every change and every refusal is in the audit trail.
* **Effective on the next request, everywhere.** Each live Copilot request reads the latest version (one primary-key lookup, no cache), so
  every Vercel instance applies a change on its next request. No rebuild, redeploy or environment edit.
* **Precedence.** `FLOFI_COPILOT` (off/replay/live) and `OPENAI_API_KEY` stay environment-only. With platform state and no break-glass:
  the latest valid version; with no version (or an empty one): the unchanged `OPENAI_COPILOT_*` bootstrap.
* **Fail closed, never silently different.** A stored document that no longer validates, or a database that cannot be read, makes the
  live Copilot unavailable (users keep the existing "not configured/unavailable" messages; the exact grammar keeps working; the precise
  code is logged as `flofi.copilot.settings`). It never falls back to another model and never serves a cached version. A read whose pooled
  connection dropped (a restarting or scaled-to-zero database) is repeated once, at once, on a fresh connection.
* **Rolling deployments.** Platform state opens on exactly the shipped migrations, or on newer ones the build's forward-compatibility
  certificate names (BUILD-DB-COMPAT-001). The previous build carries the certificate for this `0012`, so it keeps opening after the
  migration; this build has no certificate yet, so while the database is behind it (it went live before the Railway pre-deploy applied
  `0012`) or ahead of it by a later, uncertified migration, its platform state refuses cold instances. The web chat's settings read does
  not depend on that: it checks only the migration that created the settings table (`server/copilot-settings-source.ts`). Before `0012`
  is applied it uses the environment bootstrap (no settings can exist yet); with a later migration applied it keeps reading the
  administrator's version; any other migration history fails closed. Channels need platform state for everything they do, so in that
  window they are unavailable as before, Copilot included.
* **Compatibility checks.** Known model families refuse incompatible parameters (temperature on GPT-5 / o-series, reasoning effort on
  GPT-4o / GPT-4.1, `minimal` on o-series). Any other model id needs an explicit "unverified model" acknowledgment; its parameters are sent
  exactly as configured. *Test with a live request* sends the real strict-schema request once with the candidate settings (OPERATOR, at
  most 10 per 10 minutes, audited) and reports the result, token usage and only allow-listed provider rejection fields (e.g.
  `unsupported_parameter` on `temperature`).

Recovery: set `FLOFI_COPILOT_RUNTIME_CONFIG=disabled` and redeploy, or use *Return to environment bootstrap*. A future migration that
changes `admin_settings_versions` must keep the previous build's read meaningful (append-only, latest version active, a document the
previous build either validates or refuses).

## 6. Analytics semantics

* **Workflow / execution / action.** A workflow is a `workflow_id`. An execution is a root run: recovery runs fold into the run they
  recover; a Solana composition's step runs fold into the composition (by the ids its record names). An action is a financial node of the
  execution's canonical workflow, with its own network (template `mock-*` nodes and the derived liquidity preparation are not actions).
  A step retried inside one run is one action, decided by its latest live attempt.
* **Ranges.** An execution belongs to the range its root run started in. Its recoveries and composition steps are folded in wherever they
  were created; a recovery (or composition step) of an execution that started before the range is never counted again in it.
* **Row limit.** Runs that cannot have started (no evidence, no attempt past PREPARED/CANCELLED, not a composition or recovery) only count
  as simulated (and maybe authorized): they are counted in SQL, never loaded. At most 20,000 runs that may have started are loaded per view,
  newest first; when a range holds more, every figure covers only executions started from a stated instant on, and the page says so.
* **Funnel.** Simulated (runs created) → reviewed & authorized → started (the wallet was asked) → submitted (a transaction exists:
  *executed*) → completed & reconciled (a reconciled verdict with nothing left to observe). A hash alone is never success. Started
  executions where nothing landed (declined, expired, cancelled) are counted separately.
* **Outcomes** follow each flow's recorded vocabulary; an unknown status is reported as *Unclassified*, never as success. Success/failure
  rates use finished executions (completed + failed + partial + uncertain).
* **Environments are never mixed.** Mainnet, Testnet/Devnet and Mocked are separate views, from each run's recorded provenance.
* **Network distribution.** One primary network per executed action (a bridge counts on its source; its destination appears as an
  arrival and in workflow participation), so the shares sum to 100 %. Per-network workflow participation overlaps and is labelled so.
* **Facts cache.** Actions and networks come from each run's canonical record, indexed into `admin_run_facts` off the execution path (a
  bounded batch on each analytics visit, or `admin-cli index`). Runs not yet indexed, or whose record cannot be read, are counted as
  executions but never assigned a network; financial nodes a record names without a recognizable network are counted as missing; an
  unindexed composition may have its step runs counted on their own until it is indexed. The console says how many of each, on Overview
  and Workflows alike.
* **Automations** are counted by their own state machines. Delegated executions are separate records: never added to the standard
  totals and kept out of the network distribution (they carry no provenance flag); the Overview says how many were created in the range.
  Executions an owner started from a proposal are standard executions (in the totals); the Automations page shows how many proposals were
  applied and how many executions FloFi linked to them through their approval handoff — a verified lower bound (links are recorded when the
  owner reopens the occurrence; approval handoffs are deleted after 30 days, evaluations after 90).
* **Fees.** No FloFi fee is charged or recorded on current `main`. The console shows completed workflows *eligible* under the intended
  0.1 % model, and marks fees charged/collected as not implemented. No revenue is estimated.

## 7. Production rollout (owner actions, in order)

This build is **Release B** of a two-release rollout. **Release A** is BUILD-DB-COMPAT-001 (`main` at `23783f1`): every process it runs
serves the database both at `0011` and at exactly this `0012`, by a certificate pinned to 0012's SHA-256. The general contract, its
tests and the emergency reversal are in [SCHEMA-COMPATIBILITY.md](SCHEMA-COMPATIBILITY.md) §4–§5; this section is the 0012-specific
procedure. Nothing here is automatic: each step is an owner action.

### 7.1 Before merging

1. **Release A everywhere.** Every process that can reach the production database runs `23783f1` or a descendant: the active Railway
   `flofi-api` and `flofi-worker` deployments (no older one draining), the Vercel Production deployment (`/api/readiness` →
   `deployment.commit`), any Preview or other environment whose `DATABASE_URL` is Production's, and every operator CLI checkout
   (`admin-cli.ts`, `developer-admin.ts`, `import-journal`). Database still at `0011` (`schemaVersion: 11`). A process older than
   Release A refuses the database on every cold start from the instant 0012 commits.
2. **Size the index build** (read-only): `SELECT count(*), pg_size_pretty(pg_total_relation_size('automation_evaluations')) FROM
   automation_evaluations;`. Measured on loopback PostgreSQL 18.6: 0.3 s at 400,000 rows, 1.6 s at 2,000,000. The runner's 30 s statement
   timeout bounds it; a history too large for that makes 0012 roll back whole and needs a separate decision.
3. **Variables:** set on Vercel Production (Sensitive) `FLOFI_ADMIN=enabled` and a dedicated `FLOFI_ADMIN_SESSION_SECRET` (§2). Release A
   ignores both, so no extra redeploy is needed later.
4. **Stage, don't expose:** Vercel → Project → Settings → Environments → Production: turn **off** *Auto-assign Custom Production Domains*,
   so the merge builds a *Staged* production deployment that serves no traffic (or deploy it with `vercel deploy --prod --skip-domain`).
   Recommended: turn off auto-deploy on Railway `flofi-worker` for this release, so the new worker starts after the migration.
5. **Previews:** see §7.5 before pushing the PR (its own Preview build may migrate the Preview database).

### 7.2 What 0012 locks, and what waits for it

0012 runs in one transaction under the migration runner's advisory lock, with `SET LOCAL lock_timeout = '5s'` and the runner's 30 s
statement timeout. While it is open it holds (observed with `pg_locks` in `packages/cloud-runtime/test/forward-compatibility.pg.test.ts`):

| Lock | Why | What waits until 0012 commits |
| --- | --- | --- |
| `tenants` `SHARE ROW EXCLUSIVE` | three new foreign keys to `tenants` | creating a brand-new tenant (the first request of a new Preview branch). Release A's cold starts only read an existing tenant and do not wait; a build older than Release A inserts on every cold start and would. |
| `automation_evaluations` `SHARE` | the new index `automation_evaluations_at` | every evaluation insert or delete: the worker's evaluations and retention delete, **and the API's owner routes that write an evaluation in the same transaction** — automation create, state change and rebind, delegated authorization activate and revoke. They return once 0012 commits (≈ the durations in 7.1 step 2). |

Nothing else is locked: no lock on `execution_runs` (run writes, journals, the work queue, the sweep never wait), nor on MCP, Developer,
Channels, approval or delegated-execution tables. The comment above the index in 0012 says it holds only the worker's evaluation inserts
("never an API request"); that is incomplete, as the table shows, but the comment is part of the certified bytes and stays as it is.

If either lock cannot be taken within 5 s (a long transaction on `tenants` or `automation_evaluations`), 0012 fails with `55P03` and
rolls back **whole** (no partial schema, nothing recorded in `schema_migrations`): the Railway pre-deploy fails, the previous deployment
keeps serving, redeploy to retry. The same holds if the index build exceeds the 30 s statement timeout.

### 7.3 Deployment order

1. **Owner merges** the PR. Vercel builds the staged production deployment; Railway deploys `flofi-api` (and `flofi-worker` unless paused).
2. **Railway `flofi-api` pre-deploy** applies 0012. Confirm `migrate.applied versions=12 schema_version=12` in the deploy log — not
   `versions=none`, which a Release A image also logs on a 0012 database. `55P03`: see 7.2, redeploy.
3. From that commit on, the Release A processes keep serving and cold-starting: Railway logs `forward_migrations=12_admin_control_plane`,
   `/api/readiness` reports `schemaVersion: 12`. The new API starts (`api.starting schema_version=12`).
4. **Deploy `flofi-worker`** (`worker.starting schema_version=12`). If it was not paused and its container started before step 2 finished,
   it exited `backend.failed stage=schema error_code=SCHEMA_NOT_MIGRATED` and Railway restarts it until 0012 is in: expected, durable work
   waits, nothing is lost.
5. **Promote** the staged Vercel deployment (*Promote to Production*, or `vercel promote <deployment url>`; no rebuild). Until then Vercel
   Production keeps serving Release A on 0012. Promote only after step 2: this build's platform state (MCP, Developer, Channels, approvals,
   `/admin`) refuses a database still at 0011 (`SCHEMA_NOT_MIGRATED`); the web Copilot keeps its environment bootstrap meanwhile. Turn
   auto-assignment and worker auto-deploy back on afterwards if you want.
6. **Validate:** `/readyz`, `/api/readiness` (`READY`, schema 12), an owner run (Simulate → Review → wallet → reconciled), worker
   reconciliation and evidence, Channels (message → approval link), Developer API, MCP OAuth + approval, `/approve`.
7. Grant the first administrator with the CLI (§3), sign in at `/admin`; optionally `admin-cli index` to backfill the facts cache. AI
   Settings starts on the environment bootstrap: save a version only after a successful live test.

### 7.4 Safe rollback

| Situation | Safe action |
| --- | --- |
| The console misbehaves, the rest is fine | Configuration, not a rollback: unset `FLOFI_ADMIN` (`/admin` answers 404) or `admin-cli end-sessions`; `FLOFI_COPILOT_RUNTIME_CONFIG=disabled` (or *Return to environment bootstrap*) for the Copilot. |
| 0012 not applied (pre-deploy failed or not reached) | Nothing to undo in the database. Railway `flofi-api` keeps its Release A deployment (a failed pre-deploy never starts the new one) and Vercel Production stays on Release A (the staged deployment serves nothing: don't promote it). A Release B `flofi-worker` that already deployed restarts with `SCHEMA_NOT_MIGRATED` while durable work waits: redeploy its Release A deployment until 0012 is applied. Fix the cause and redeploy. |
| 0012 applied; Release B misbehaves | Roll the application back to **Release A** (`23783f1`) or any later build that carries the 0012 certificate — never earlier. Railway: redeploy the Release A deployment of `flofi-api` (its pre-deploy `migrate` succeeds with `versions=none`, changing nothing) and of `flofi-worker`; Vercel: *Instant Rollback* / promote the Release A deployment. Release A serves on 0012; the `admin_*` tables stay, unused. |
| 0012 applied; a build **older than Release A** | **Unsafe — never.** It refuses the database on every cold start: Railway refuses to deploy it (its pre-deploy fails `MIGRATION_HISTORY_MISMATCH`; the current deployment keeps serving), and on Vercel every new function instance would refuse platform state and embedded flows. Vercel's rollback list shows such deployments: choose only one that descends from `23783f1`. |
| 0012 itself must go (last resort) | [SCHEMA-COMPATIBILITY.md §5.1](SCHEMA-COMPATIBILITY.md#51-emergency-reversal-of-0012-last-resort), owner decision, with a backup, and only while **every** process runs Release A (never while a Release B process serves). It destroys every admin grant, session, audit event, settings version and analytics fact. Release B's pre-deploy can apply 0012 again afterwards. |

What a rollback to Release A changes for users: `/admin` no longer exists (404), and the web chat and Channel Copilot use the
`OPENAI_COPILOT_*` environment bootstrap again — Release A never reads `admin_settings_versions`. Rolling forward again makes the latest
stored settings version active on the next request; use *Return to environment bootstrap* first if that is not wanted. The schema is
never rolled back by a runner: from the commit of 0012 on, only Release A and later builds can cold-start.

### 7.5 Preview builds and the production database

With `FLOFI_MIGRATE_ON_BUILD=preview` on the Preview environment, every Preview build runs `main.ts migrate` on its Preview `DATABASE_URL`
(`deploy/vercel/build.sh`), so this PR's own Preview build applies 0012 as soon as it builds. Production is protected twice:

* `build.sh` migrates only when `VERCEL_ENV=preview` (a Production build never migrates; Production migrates only in the Railway pre-deploy);
* in a Preview, `main.ts migrate` first refuses — changing nothing, failing the Preview build with `backend.failed stage=preview_database
  error_code=PREVIEW_DATABASE_NOT_DEDICATED` — a database that a non-Preview deployment writes to: any tenant-scoped row outside the
  Preview `pv-…` tenants, or a tenant other than the seeded `default` outside them (`backend/preview-migration.ts`). A Preview whose
  `DATABASE_URL` is Production's by mistake therefore never applies 0012 to Production. A copy of Production (e.g. a Neon branch of the
  production branch) is refused the same way; give Previews a database that holds no Production state.

On a dedicated, shared Preview database, 0012 applied by this PR's Preview makes Previews of branches older than Release A refuse platform
state on cold starts: rebase them. Without `FLOFI_MIGRATE_ON_BUILD`, a Preview never migrates; on a database still at 0011 its platform
state refuses (`SCHEMA_NOT_MIGRATED`) and changes nothing.
