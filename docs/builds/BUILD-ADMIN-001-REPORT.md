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
`admin_sessions`, `admin_audit_events`, `admin_settings_versions`, `admin_run_facts`; indexes `execution_runs_created`,
`automation_evaluations_at`. No earlier migration edited.

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
- Standard executions that started from an automation proposal cannot be attributed to the automation (no durable link today).
- Delegated execution records carry no provenance flag, so they are kept out of the network distribution and standard totals.
- Runs not yet indexed (or with unreadable records) count as executions without a network; history fills in on visits or via
  `admin-cli index`. One view reads at most 20,000 runs per range (flagged when truncated).
- "Reviewed & authorized" is derived from journal entries/status where a flow projects them; flows without a projected journal rely on
  their current status.
- Fees: none is charged on `main`; only eligibility is counted. Revenue, notional volume and USD values are not available.
- Worker liveness is inferred from durable activity; Railway flow enablement is not visible to the console.
- The model capability catalog covers GPT-5 (base/mini/nano), o1/o3/o3-mini/o4-mini, GPT-4.1 and GPT-4o; newer ids are "unverified" and
  rely on the live probe.
- Admin sign-in supports EVM wallets only; no passkey step-up yet.

## 5. Production rollout (not executed)

See [ADMIN.md §7](../deploy/ADMIN.md#7-production-rollout-owner-actions-in-order): migrate (Railway pre-deploy) → deploy API/worker →
deploy Vercel promptly (every process verifies the exact shipped migration set) → set `FLOFI_ADMIN` and `FLOFI_ADMIN_SESSION_SECRET` on
Vercel → grant the first administrator with the CLI → optional `admin-cli index` backfill.
