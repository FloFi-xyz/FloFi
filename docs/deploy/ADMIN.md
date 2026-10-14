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
| Schema | migration `0012_admin_control_plane` | additive: five `admin_*` tables and one read index (automation evaluation history); nothing on `execution_runs` |

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
* **Rolling deployments.** Platform state opens only on exactly the shipped migrations, so while the database is one migration behind or
  ahead of a serving build (between the Railway pre-deploy and the Vercel promotion, in either order) platform state refuses cold
  instances. The web chat's settings read does not depend on that: it checks only the migration that created the settings table
  (`server/copilot-settings-source.ts`). Before `0012` is applied it uses the environment bootstrap (no settings can exist yet); with a
  later migration applied it keeps reading the administrator's version; any other migration history fails closed. Channels need platform
  state for everything they do, so in that window they are unavailable as before, Copilot included.
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

Every FloFi process verifies the **exact** shipped migration set. During any migration rollout the database and a serving build disagree
for a while, and platform state (MCP, Developer, Channels, approvals, `/admin`) refuses cold instances on the side that disagrees — in
both directions (`SCHEMA_NOT_MIGRATED` for a build ahead of the database, `MIGRATION_HISTORY_MISMATCH` for one behind it). Warm instances
keep working (`0012` is additive). This is unchanged from every earlier migration; the steps below keep the window to seconds. Measured on a
loopback copy with 200,000 runs and 400,000 evaluations: `0012` applied in under 0.5 s with an API write transaction open, and no run write
waited for it (`src/admin/rollout.pg.test.ts` replays each window).

1. Before merging, set on Vercel Production (Sensitive): `FLOFI_ADMIN=enabled` and a dedicated `FLOFI_ADMIN_SESSION_SECRET`. The
   current build ignores both, so no extra redeploy is needed later.
2. Vercel → Project → Settings → Environments → Production: turn **off** *Auto-assign Custom Production Domains*, so the merge builds a
   *Staged* production deployment that serves no traffic (or deploy it with `vercel deploy --prod --skip-domain`).
3. Merge the PR (owner). Let the Vercel build finish, staged.
4. Railway `flofi-api`: the pre-deploy `migrate` applies `0012_admin_control_plane`, then the API starts. Confirm `migrate.applied
   versions=12` in the deploy log. `0012` takes no lock on `execution_runs`; it waits at most 5 s for the automation evaluation history
   (worker writes only) and otherwise fails and rolls back entirely — the previous deployment keeps serving; redeploy to retry.
   `flofi-worker` deploys from the same commit: if its container starts before the API's pre-deploy finished, it exits with
   `backend.failed stage=schema error_code=SCHEMA_NOT_MIGRATED` and Railway restarts it until the migration is in — expected, and work
   is durable, so nothing is lost.
5. Immediately promote the staged Vercel deployment (*Promote to Production*, or `vercel promote <deployment url>`; no rebuild). Turn
   auto-assignment back on afterwards if you want. If Vercel was left on auto-assignment and finished first, the new build's platform
   state refuses until step 4 completes; the web Copilot keeps working on its environment bootstrap.
6. Grant the first administrator with the CLI (§3), then sign in at `/admin`.
7. Optional: `admin-cli index` to backfill the facts cache for history (otherwise it fills in small batches as the console is used).
8. AI Settings starts on the environment bootstrap; save a version only after a successful live test.

Turning the console off: unset `FLOFI_ADMIN` (404) or `end-sessions`. Code rollback below `0012` is not possible against a migrated
database: a pre-`0012` build refuses the newer schema on every cold start, so `vercel rollback` (or a Railway rollback) to such a build
breaks platform state and the API/worker restarts. Disable the console by configuration instead, and keep the break-glass
`FLOFI_COPILOT_RUNTIME_CONFIG=disabled` for the Copilot.
