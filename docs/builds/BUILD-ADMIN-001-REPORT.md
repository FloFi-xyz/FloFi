# BUILD-ADMIN-001 — FloFi private Admin & runtime control plane: report

Branch `claude/build-admin-001`, baseline `fa7816b` (= `origin/main` at preflight). Local commits only: nothing pushed, no PR, no merge,
no deploy, no production variable or database touched, no public-chain transaction. Plan: [BUILD-ADMIN-001-PLAN.md](BUILD-ADMIN-001-PLAN.md);
operator guide: [ADMIN.md](../deploy/ADMIN.md).

## 1. Implemented

**A — Admin foundation and security.** Isolated `/admin` (own layout/CSS, `noindex`/`no-store`/`DENY` headers, not linked from the
product). `FLOFI_ADMIN=enabled` + a dedicated `FLOFI_ADMIN_SESSION_SECRET` (refused when shared with any other FloFi secret). Sign-in: the
wallet signs an admin-only EIP-4361 statement (own sealed kinds, HKDF key, `/admin` cookies); an ACTIVE grant in `admin_principals` is
required; server-side `admin_sessions` re-checked on every request (sign-out/revocation immediate); a signed challenge opens at most one
session. Roles VIEWER/OPERATOR. Grants only through the operator CLI (`backend/admin-cli.ts`: grant, revoke, list, end-sessions, audit,
index). CSRF/origin: same-origin JSON POST + `Origin` + `Sec-Fetch-Site` + session-bound CSRF header. Append-only `admin_audit_events`
(refused sign-ins stored without an address). Access & audit page.

**B — Dynamic Copilot configuration.** Versioned, append-only, gapless `admin_settings_versions`; save / rollback (new version restoring
an older one) / reset to the environment bootstrap, with optimistic concurrency; default + WEB/TELEGRAM/WHATSAPP overrides; model id,
temperature or omitted, reasoning effort, max output tokens, timeout — environment bounds plus a model capability catalog that refuses
known-incompatible combinations (unknown models need an explicit acknowledgment). Rate-limited, audited live probe through the real strict
request, reporting only allow-listed upstream rejection fields. Resolver reads the active version per live request (no cache) in the web
chat server action and Channel Core; mode and API key stay environment-only; break-glass `FLOFI_COPILOT_RUNTIME_CONFIG=disabled`; an
unreadable store or invalid stored document fails closed with the existing user-facing codes. AI Settings page (status, effective
settings per channel, editor, live test, history/restore).

**C — Analytics and dashboards.** Correlation model workflow → execution (recoveries and composition step runs folded) → action
(canonical workflow node). Pure per-flow classifier (simulated / authorized / started / submitted / outcome). Off-path facts indexer
(`admin_run_facts`) for actions, CAIP-2 networks and bridge destinations. Overview (funnel, outcomes, rates, activity, network
distribution with exclusive action-level shares, outcome bars, overlapping participation, bridge routes, top networks per action type,
adoption trend; utilization; fee observability), Workflows, Automations, System Health. Mainnet / Testnet-Devnet / Mocked never mixed.

## 2. Files and migrations

Migration `packages/cloud-runtime/migrations/0012_admin_control_plane.sql` (+ `SHIPPED_MIGRATIONS`): `admin_principals`,
`admin_sessions`, `admin_audit_events`, `admin_settings_versions`, `admin_run_facts`; index `automation_evaluations_at`; a 5 s lock timeout.
No earlier migration edited. (0012 was revised by the pre-PR hardening below, before it was ever pushed or applied outside disposable
local databases: see §6.)

New: `apps/reference-dapp/src/admin/**`, `src/app/admin/**`, `src/components/admin/**`, `src/server/copilot-settings.ts`,
`copilot-runtime.ts`, `runtime-settings-store.ts`, `backend/admin-cli.ts`, tests, `e2e/admin-console.spec.ts`, `docs/deploy/ADMIN.md`.
Compatibility edits: `src/app/copilot-action.ts`, `src/channels/core/interpreter.ts` (optional injected per-turn resolver; env path
unchanged), `src/channels/http.ts`, `src/channels/dispatch-http.ts`, `src/server/session-principal.ts` (pure `originFromHeaders`),
`next.config.ts` (admin headers), `playwright.config.ts` (`FLOFI_ADMIN_E2E`), `scripts/guarded-release-browser.mjs` (`admin-console`
profile), `docs/deploy/ENVIRONMENT.md`.

Intentional test changes (for owner review): `src/delegation/migration.pg.test.ts` is bounded to the first eleven migrations (the
convention the 0010 suite used when 0011 shipped); `src/channels/boundaries.test.ts` adds `src/server/copilot-runtime.ts` to the server
modules channel wiring may import, plus a new closure check that it reaches no flow, runtime, handoff or wallet code. Channel Core's own
import boundary is unchanged.

## 3. Tests

All runs local, on Node 24.21.0 / pnpm 11.22.0, against a disposable loopback PostgreSQL (CI-pinned `postgres:18.6-bookworm` image) and
loopback/MOCKED harnesses only. No provider, public RPC or chain was contacted by any test.

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | **passed** — 376 files, 4,268 tests passed, 2 skipped (pre-existing `it.skipIf` cases in `mode-b-service` and `composition-service` that need pinned fork artifacts; unrelated) |
| `pnpm test:postgres` (all `*.pg.test.ts`) | **passed** — 59 files, 370 tests, none skipped |
| New admin suites inside the above | unit: session/config/CSRF/guard 11, settings validation 5, resolver 6, classifier 7, record facts 5, counting semantics 6; PostgreSQL: migration 0012 3, admin API 7, Copilot settings + cross-instance pickup 5, analytics with a real reconciled MOCKED Router run 5; CLI smoke 1 |
| `python3 scripts/governance_lite.py` + `test_governance_lite.py` + `test_ci_*.py` | **passed** (19 + 22 self-tests); `git diff --check fa7816b..HEAD` clean |
| Browser (Playwright, headless shell 1243, loopback) | **passed** — `admin-console.spec.ts` 1 (new `admin-console` profile); regressions on touched code: `copilot` profile 13, `chat-automations` profile 8, channels approve (`whatsapp-approve`, `telegram-approve`) 2, `channel-signing` 6 |
| Client bundle scan | no secret names, SQL or admin table names in `.next/static`; only the CSRF header name |

Not run locally (reported, not claimed): the full guarded browser `product` phase (25 profiles) and `composition` phase, the fork
suites, the MCP browser suites, `pnpm audit`, `bootstrap-ci.py --verify-dependencies` and SBOM generation. No dependency, lockfile or
workflow file changed; no executor, compiler or reconciler package changed.

The Copilot settings were never exercised against the real OpenAI API (no key used): the cross-instance and probe tests stub the
Responses endpoint. A live probe from `/admin` → AI Settings is the owner's acceptance step once deployed.

## 4. Known limitations

- Unsaved Canvas drafts never reach the server: "created" is reported as saved workflows plus simulated runs.
- Standard executions started from an automation proposal are linked only where FloFi recorded the link (verified lower bound; see §6).
- Delegated execution records carry no provenance flag, so they are kept out of the network distribution and standard totals (the
  Overview says how many exist in the range).
- Runs not yet indexed (or with unreadable records) count as executions without a network; history fills in on visits or via
  `admin-cli index`. One view loads at most 20,000 runs that may have started (never-started simulations are counted in SQL); a truncated
  view states the instant it covers from.
- "Reviewed & authorized" is derived from journal entries/status where a flow projects them; flows without a projected journal rely on
  their current status.
- Fees: none is charged on `main`; only eligibility is counted. Revenue, notional volume and USD values are not available.
- Worker liveness is inferred from durable activity; Railway flow enablement is not visible to the console.
- The model capability catalog covers GPT-5 (base/mini/nano), o1/o3/o3-mini/o4-mini, GPT-4.1 and GPT-4o; newer ids are "unverified" and
  rely on the live probe.
- Admin sign-in supports EVM wallets only; no passkey step-up yet.

## 5. Production rollout (not executed)

See [ADMIN.md §7](../deploy/ADMIN.md#7-production-rollout-owner-actions-in-order) (revised in §7 below): Release A (BUILD-DB-COMPAT-001)
everywhere → admin variables set and the Vercel production deployment staged → merge → Railway pre-deploy applies 0012 (Release A keeps
serving on it) → API, then worker → promote the staged Vercel deployment → validate → grant the first administrator with the CLI → optional
`admin-cli index` backfill. Rollback after 0012: to Release A or later only.

## 6. Pre-PR hardening (2026-10-14)

Review of rollout compatibility, analytics completeness and Copilot resilience before the PR. Local commits only; nothing pushed, merged
or deployed. Scenario evidence comes from the real migration runner, schema checks, admin host and web chat server action against a
disposable loopback PostgreSQL (CI image), with a 200,000-run / 400,000-evaluation fixture for timings.

**P0 — migration and rolling deployment.**

| Finding (measured on the previous `0012`) | Change |
| --- | --- |
| `CREATE INDEX execution_runs_created` waited for an open API write transaction and queued every later run write behind it (3.5 s stall with a 3 s writer; unbounded by anything but the pool's 30 s statement timeout). | Index removed. Ranged analytics reads are bounded by the existing `execution_runs_history (tenant_id, updated_at)` index (`updated_at ≥ created_at` holds for every projection write; 1 h slack for transaction-start skew). Measured: 0012 applies in < 0.5 s with an API transaction open; the next run write is not delayed; 24 h analytics read uses `execution_runs_history` (1 ms). |
| No bound on lock waits inside the migration. | `SET LOCAL lock_timeout = '5s'`: a long writer on the evaluation history makes 0012 fail with `55P03` and roll back entirely (tested), instead of queueing writers. |
| Web chat Copilot became dependent on the exact schema: with `DATABASE_URL` set (production Vercel), a new build live before the Railway pre-deploy, or this build after any *later* migration, answered `COPILOT_CONFIG_UNAVAILABLE` on every cold instance. On `main` it never touched the database. | `server/copilot-settings-source.ts`: when platform state refuses the schema, the settings read checks only the migration that created the table (exact identities up to `admin_control_plane`). Not applied → environment bootstrap (no settings can exist); applied → the administrator's version; any other history → fail closed. Measured: bootstrap before 0012, administrator's model with a later migration applied, `unavailable` on a tampered history. |
| Strict schema check (pre-existing, every migration): old builds' cold starts refuse after migrate; new builds refuse before it. MCP/Developer/Channels/approvals/`/admin` are affected in that window. | Not changed (platform-wide policy; see escalations). Rollout procedure rewritten to stage the Vercel production deployment and promote it right after the Railway pre-deploy (`ADMIN.md` §7, Vercel staged deployments), and to set the admin variables before merging (no extra redeploy). Rolling back below 0012 is documented as breaking cold starts. |

**P1 — analytics completeness.**

- *20,000-run limit:* the limit now applies only to runs that may have started; never-started runs are counted in SQL by the facts the
  classifier reads (grouped, then classified by the same `classifyRun`). With 80 % simulations at ~3,500 runs/day a 7-day view went from
  truncated (20,000 of 24,191) to complete (4,838 loaded + 19,353 counted, 97 ms). A truncated view reports `runsInRange`, the instant it
  covers from, and draws the activity series only where covered; Overview **and Workflows** say so.
- *Range edges / retries:* an execution belongs to the range its root started in. Recoveries created after the range are loaded and
  folded in; a recovery of a run that started before the range is no longer counted as a new execution (it was, and was double counted
  across adjacent ranges). Lending step retries: the latest live attempt decides (a reverted attempt followed by a pending retry is no
  longer a failure); still one action.
- *Compositions:* a composition created before the range is still (re)indexed while it grows, so its step runs inside the range are
  never counted on their own; unindexed compositions are reported (their steps may be counted separately until indexed).
- *Network distribution:* the derived `asset.liquidity.prepare` node was counted as a second Liquidity action; template and derived nodes
  are now excluded (the engine's own financial-node rule). Financial nodes with no recognizable type/network, or beyond 16, are stored as
  `skipped_nodes` and reported instead of silently dropped.
- *Delegated executions:* the Overview and Workflows notes give the number created in the range and say they are not in the figures.
- *Automation → execution:* the console claimed no link exists. Approval handoffs do record verified run ids (`sharedRuns`: claimant's
  own run, after the claim, exactly the proposed workflow hash; recorded when the owner reopens the occurrence). The Automations page now
  shows proposals sent, applied, and linked executions (with outcomes and environments) as a lower bound, plus approvals already deleted
  by the 30-day handoff retention, and flags evaluation counts older than the 90-day retention.

**P1 — Copilot resilience.** Fail-closed semantics are unchanged: no environment fallback once settings may exist, no cache. Added: the
schema-window source above, and one immediate re-read when the failure is the connection itself (`08xxx`, `57P01–57P03`, `ECONNRESET`,
`EPIPE`, pg's terminated-connection errors) — the same read on a fresh connection, never a different answer. Remaining dependency compared
with `main`: when runtime settings are enabled (default wherever `DATABASE_URL` is set) and the database is unreachable, the web Copilot
is unavailable (the exact grammar keeps working; Simulate/Execute need the database through the Railway API anyway).

**Escalated to the owner (not implemented — policy decisions):**

1. *Last-known-good settings.* A per-instance cache of the last verified version, served for at most N seconds when the read fails, would
   mask transient outages on warm instances (cold instances gain nothing). Cost: during an outage an instance may keep a model an
   administrator just replaced (e.g. for cost or safety) for up to N seconds, which contradicts "effective on the next request,
   everywhere". Recommendation: do not add it now; revisit with N ≤ 60 s and a logged `STALE` outcome if outages are observed.
2. *Default-on runtime settings.* Alternative: opt-in (`FLOFI_COPILOT_RUNTIME_CONFIG=enabled`) so web Copilot never depends on the
   database until the owner enables the console's AI Settings. Recommendation: keep default-on (the schema-window dependency is removed;
   what remains is database reachability).
3. *Forward-compatible schema checks.* Letting builds accept a database ahead by migrations declared backward compatible would close
   the platform-state window of every future migration, but it changes the fail-closed schema contract of every process. Recommendation:
   separate build with its own review; until then use the staged-promotion procedure.

Verification of the hardening (local, Node 24.21.0 / pnpm 11.22.0, disposable loopback PostgreSQL `postgres:18.6-bookworm`, loopback
harnesses only; no provider, public RPC or chain contacted):

| Gate | Result |
| --- | --- |
| `pnpm check` | **passed** — 377 files, 4,276 tests, 2 skipped (the same pre-existing `skipIf` cases in `mode-b-service` / `composition-service`) |
| `pnpm test:postgres` | **passed** — 60 files, 377 tests, none skipped (new: `rollout.pg.test.ts` 4; analytics +3) |
| Browser profiles (headless shell 1243) | **passed** — `admin-console` 1 (now also asserts the Workflows and Automations sections), `copilot` 13, `chat-automations` 8 |
| Rollout probe (scratch, not committed) | 0011 → 0012 phases at 200,000 runs / 400,000 evaluations, before and after the change (figures above) |

Not run (unchanged from §3): the full guarded `product`/`composition` phases, fork suites, MCP browser suites, `pnpm audit`,
`bootstrap-ci.py --verify-dependencies`, SBOM. No dependency, lockfile, workflow or executor/compiler/reconciler file changed.

Intentional test changes for review: `src/admin/migration.pg.test.ts` now expects one added index (not two) and the `skipped_nodes`
check; the analytics test helper `extend()` moves `updated_at` forward as the real projection does. New suites:
`src/admin/rollout.pg.test.ts`, `src/server/copilot-settings-source.test.ts`.

## 7. Integration onto `main` after BUILD-DB-COMPAT-001 (2026-10-15)

BUILD-DB-COMPAT-001 (Release A) was merged into `main` as `23783f1` and deployed to Vercel and Railway with the production schema at
`0011`. This build was rebased onto it locally; nothing was pushed, merged, deployed or migrated.

**Rebase.** The six commits replayed onto `23783f1` without conflicts. The only file both sides changed,
`packages/cloud-runtime/src/migrations.ts`, merged cleanly (this build adds its `SHIPPED_MIGRATIONS` row; `main` added the certificate
below it). Every rebased commit has the same diff as before (only hunk context differs); the pre-rebase tip `53b1a8b` is kept locally
as branch `claude/build-admin-001-pre-rebase-53b1a8b`. Commits A–C still carry the earlier, never-shipped drafts of `0012`, so
`forward-compatibility.test.ts` fails on those three commits taken alone; the branch head (what CI tests and a merge ships) passes.

**0012 is byte-identical** to the certified version: SHA-256 `25556fbfd8e45acf0e692fc340eee56fa2f064f4106225960d63e3da9c303af2`, git
blob `50c4c92c`, identical (`cmp`) to `packages/cloud-runtime/test/fixtures/0012_admin_control_plane.sql`, and equal to the certificate
in `CERTIFIED_FORWARD_MIGRATIONS` (asserted by `forward-compatibility.test.ts`).

**Changes made during integration** (one commit):

| Change | Why |
| --- | --- |
| `backend/preview-migration.ts` + `main.ts migrate` | In a Vercel Preview, the runner first refuses, changing nothing, a database that a non-Preview deployment writes to (`PREVIEW_DATABASE_NOT_DEDICATED`, stage `preview_database`): any tenant-scoped row outside the Preview `pv-…` tenants, or a tenant other than the `default` that migration 0001 seeds everywhere. A Preview whose `DATABASE_URL` is Production's by mistake can no longer apply 0012 (or any later migration) to Production. Railway's pre-deploy path is unchanged. |
| `backend/admin-cli.ts` | `assertSchemaCompatible`, like every other production caller since Release A. No certificate exists for the v12 build, so its decision equals the strict check today. |
| `src/admin/rollout.pg.test.ts` | The "after" phase asserted that the previous build refuses on a cold start — no longer what the deployed previous build (Release A) does. It now asserts Release A serves and cold-starts on 0012 and that its runner (a rollback's pre-deploy) applies and changes nothing; the strict, pre-Release-A refusal is still asserted. |
| `docs/deploy/ADMIN.md` §1, §5, §7 | §7 rewritten: Release A preconditions, 0012's locks and what waits for them (including the API owner automation/delegation routes BUILD-DB-COMPAT-001 found; the 0012 comment that says otherwise is part of the certified bytes and stays), deployment order, safe rollback, Preview builds. |
| `SCHEMA-COMPATIBILITY.md`, `ENVIRONMENT.md`, `CLOUD.md`, `deploy/vercel/build.sh`, `server/copilot-settings-source.ts` | Callers table (Admin, `admin-cli.ts`), Release B Preview note, the Preview guard, comments matching the certificate world. |

Escalation 3 of §6 (forward-compatible schema checks) is now answered by BUILD-DB-COMPAT-001: builds serve a newer schema only under a
certificate pinned to exact migration identities, one release ahead.

**Combined forward-compatibility contract, verified.**

| Property | Evidence |
| --- | --- |
| Shipped 0012 = certified 0012; the v12 build has no certificate of its own, so it is strict for itself | `forward-compatibility.test.ts` (7 tests) on the combined tree |
| 0012 additive on a v11 catalog; its locks; emergency reversal | `forward-compatibility.pg.test.ts` (7 tests) on the combined tree (fixture = shipped bytes) |
| Release A serves, cold-starts and rolls back onto 0012; pre-Release-A refuses | `src/admin/rollout.pg.test.ts` (4 tests) |
| Release A's own API/worker continuity, real cold starts and every Vercel path on 0012 | `backend/schema-compatibility.pg.test.ts` run in a detached worktree at `23783f1`: 3 passed. In the combined tree this suite **skips itself** (3 skipped: no certificate for the v12 build) — not counted as a pass here |
| The combined build's real runner and Release A's real processes | scratch cross-build check (not committed), loopback PostgreSQL: Release A `main.ts migrate` → 1–11; combined `api` on 11 → `SCHEMA_NOT_MIGRATED`; combined `migrate` → `versions=12`, ledger row `12 admin_control_plane 25556fbf…`; Release A `migrate` → `versions=none schema_version=12 application_schema_version=11 forward_migrations=12_admin_control_plane`, ledger unchanged; Release A `api` (`/readyz` 200) and `worker` start with `forward_migrations=12_admin_control_plane`; Release A `developer-admin.ts create-project` works; combined `api`, `worker` and `admin-cli list` start on 12 |
| Preview guard | `backend/preview-migration.pg.test.ts` (3 tests, real `main.ts migrate` processes); fails as expected with the guard disabled |

**Gates on the integrated head** (local, Node 24.21.0 / pnpm 11.22.0, disposable loopback PostgreSQL `postgres:18.6-bookworm`, loopback
and MOCKED harnesses only; no provider, public RPC or chain contacted):

| Gate | Result |
| --- | --- |
| `pnpm check` | **passed** — 378 files passed, 2 skipped; 4,283 tests passed, 2 skipped (the pre-existing fork-artifact `skipIf` cases in `mode-b-service` and `composition-service`) |
| `pnpm test:postgres` | **passed** — 62 files passed, 1 skipped; 387 tests passed, 3 skipped (`schema-compatibility.pg.test.ts`, by design, see above) |
| `python3 scripts/governance_lite.py` + `test_governance_lite.py` + `test_ci_*.py` | **passed** (19 + 22 self-tests); `git diff --check origin/main..HEAD` clean |
| Browser profiles (headless shell 1243, loopback) | **passed** — `admin-console` 1, `copilot` 13, `chat-automations` 8, `workflow-acceptance` 5, `execution-continuity` 9, `cloud-provenance` 1 (each profile's spec set and environment taken from `scripts/guarded-release-browser.mjs`; none skipped) |

Not run (as in §3): the full guarded `product`/`composition` phases, fork suites, MCP browser suites, `pnpm audit`,
`bootstrap-ci.py --verify-dependencies`, SBOM. No dependency, lockfile, workflow or executor/compiler/reconciler file changed.

**Remaining deployment risks** (see `ADMIN.md` §7):

1. Anything still older than Release A when 0012 commits refuses the database on cold start: older Vercel deployments (they stay in the
   rollback list), Previews or other environments sharing the production database, operator CLIs from old checkouts.
2. While 0012 is open (≈ 0.3–1.6 s measured on loopback for 0.4–2 M evaluations), new tenants and every evaluation write wait, API owner
   automation/delegation routes included. A lock it cannot take in 5 s, or an index build over 30 s, rolls it back whole (redeploy).
   Production's evaluation history has not been sized (owner, read-only).
3. Release B promoted (or auto-assigned) before the pre-deploy applied 0012: its platform state refuses until then. Stage the Vercel
   deployment; promote after `migrate.applied versions=12`. A Release A image's pre-deploy also "succeeds" (`versions=none`) on 0012.
4. Rolling back to Release A drops `/admin` and returns the Copilot to the environment bootstrap; rolling forward reactivates the latest
   stored settings version.
5. The Preview guard fails Preview builds closed on any database that holds non-Preview rows — including a copy of Production (e.g. a
   Neon branch) or a Preview database once used with `TENANT_ID=default`. It assumes no production deployment uses a `pv-…` `TENANT_ID`
   (free-form, `default` per the docs). With `FLOFI_MIGRATE_ON_BUILD=preview`, this PR's Preview build migrates the shared Preview
   database: Previews of branches older than Release A then refuse platform state.
6. Zero downtime is demonstrated for code paths on loopback PostgreSQL, not for Railway/Vercel orchestration, Neon's pooler or
   production volumes.
