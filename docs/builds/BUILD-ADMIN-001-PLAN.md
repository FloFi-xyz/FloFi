# BUILD-ADMIN-001 — FloFi private Admin & runtime control plane: plan

Baseline: branch `claude/build-admin-001` at `fa7816b` (= `origin/main` after fetch). Local implementation only: no push, PR, merge,
deploy, production variable or production database change.

## 1. Preflight findings (current `main`, not historical reports)

| Area | Finding | Consequence |
| --- | --- | --- |
| Governance | `CLAUDE.md` + `docs/SCOPE_GUARD.md` (GOVERNANCE-LITE). No root `AGENTS.md`; `apps/reference-dapp/AGENTS.md` only carries the Next.js 16 note. | Any path may change; safety gates preserved. |
| Topology | Vercel (Next.js BFF) → Railway API/worker → Neon. Since BUILD-PLATFORM-STATE-001, Vercel may hold the pooled `DATABASE_URL` for platform state through `platformStateHost` (same database and tenant as Railway). | The admin runs on the Next.js server and reads PostgreSQL through `platformStateHost`; nothing new on Railway. |
| Copilot | Called only on the Next.js server: the chat server action (`app/copilot-action.ts`) and Channel Core (`channels/core/interpreter.ts`, Vercel routes). Settings come from `OPENAI_COPILOT_*` env; invalid tuning makes it unavailable; no default model. | The runtime-settings resolver runs on the Next.js server, reading PostgreSQL per request (no cache → every instance sees a change on its next request). |
| Identity | EIP-4361 wallet sessions (`server/wallet-session.ts`, `recoverPersonalSigner`), sealed HMAC cookies; passkeys (WebAuthn) for delegation. No admin concept anywhere. Operator CLIs exist (`backend/developer-admin.ts`, `channels-admin.ts`). | Admin = wallet proof with an admin-only statement + an explicit grant in PostgreSQL made by an operator CLI + a separate admin secret/session. A wallet session never implies admin. |
| Executions | `execution_runs` (one row per run, `flow`, `status`, `provenance`, `recovery_of`, `attention_required`, `has_evidence`), `execution_attempts` (per step), `journal_entries`, `evidence_objects`. Status = run verdict (`RECONCILED`/`DIVERGENT`/`INCONCLUSIVE`/`NOT_EXECUTED`/…) or the open attempt's state or a phase. Simulation creates a run. | "Executed" must come from attempts/evidence, not run existence. A classifier maps each flow's vocabulary to outcomes; unknown statuses are reported, never folded into success. |
| Compositions | `lending-composition` = one run, steps as attempts. `solana-devnet-composition` = a coordinator run **plus** child step runs projected under `solana-devnet-swap` / `orca-liquidity` (same `workflow_id`). | Child runs must be folded into their composition (exact ids from the composition record: `producerRunId`, `consumerRunIds`), or Swap/Liquidity would be double counted. |
| Networks | The projection has no chain. Several flows span networks (`aave-supply`, `uniswap-liquidity`, `base-sepolia-swap`, `robinhood-transfer`). Every run record carries the canonical semantic workflow (`nodes[].actionType`, `nodes[].chainId`; bridge destination in `inputs['asset-out']`). | An off-path indexer derives action/network facts from canonical records into a rebuildable cache table; labels/environments come from the existing catalog (`networkIdentity`, `EVM_WALLET_NETWORKS`). |
| Delegation | `delegated_executions` / `_steps` are separate tables; the delegated executor never writes `execution_runs`. Production delegated signing is blocked (no custody). Steps record `chain` but no provenance. | Reported in the Automations section only, never added to standard totals or the network distribution (no double count, no unlabeled MOCKED mixing). |
| Fees | No FloFi platform fee exists on `main`: Jupiter execution refuses any `platformFeeBps ≠ 0`; LI.FI "integrator" lines are LI.FI's own fee. No fee evidence. | Fee panel reports *eligible* completed executions only; charged/collected/revenue are "not implemented" — no numbers invented, no fee logic added. |
| Migrations | Last shipped: `0011_delegated_execution`. `assertSchemaCurrent` requires exactly the shipped set (old builds refuse a newer schema). | Additive `0012_admin_control_plane`; rollout: migrate (Railway pre-deploy) then deploy API/worker and Vercel together. |
| Libraries | No chart library; workspace dependency sets are pinned by `bootstrap-ci.py`. | Charts are hand-drawn SVG; no new dependency. |

## 2. Architecture

- **Isolated `/admin`** (own layout and CSS, never linked from the product, `noindex`, `no-store`, `frame-ancestors 'none'`). Server
  components read through an admin service after `requireAdmin`; mutations go through JSON route handlers under `/admin/api/*`.
- **Authorization boundary:** `FLOFI_ADMIN=enabled` + `FLOFI_ADMIN_SESSION_SECRET` (≥ 32 chars, must differ from the wallet-session
  and API secrets) or `/admin` answers 404. Sign-in: the wallet signs an admin-only EIP-4361 statement (own sealed kind, own key, own
  cookies scoped to `Path=/admin`, SameSite=Strict, HttpOnly, Secure off-loopback); the server recovers the signer, requires an ACTIVE
  grant in `admin_principals`, and records a server-side session (`admin_sessions`, 4 h absolute) that every request re-checks (logout
  and grant revocation are immediate). Roles: `VIEWER` (read) and `OPERATOR` (read + AI settings). Grants are created/revoked only by
  the operator CLI with database access (`backend/admin-cli.ts`) — no in-app privilege escalation.
- **CSRF/origin:** every mutation is `POST` + `application/json` + `Origin` equal to the request origin + `Sec-Fetch-Site` not
  cross-site + a session-bound CSRF token header (HMAC of the session id). Sign-in endpoints check Origin and the sealed challenge.
- **Audit:** append-only `admin_audit_events` (DB trigger) for sign-in/out, refused sign-ins (no address stored), settings changes,
  rollbacks, probes and CLI grants/revocations. Content-free: ids, closed codes, versions.
- **Runtime settings (Phase B):** append-only `admin_settings_versions` (key `copilot`, monotonically versioned, optimistic
  concurrency by primary key); the active document is the latest version; rollback writes a new version copying an older one; a
  `null` document returns to the environment bootstrap. `FLOFI_COPILOT` mode and `OPENAI_API_KEY` stay environment-only.
  `FLOFI_COPILOT_RUNTIME_CONFIG=disabled` is the break-glass to ignore the database. Scopes: default + `WEB`, `TELEGRAM`, `WHATSAPP`.
  Validation: bounds as today plus a model capability catalog (known families refuse incompatible temperature/reasoning
  combinations; unknown models need explicit acknowledgment) and an optional audited, rate-limited live probe through the existing
  strict-schema request. A database read failure fails closed (`COPILOT_CONFIG_UNAVAILABLE`); the exact grammar keeps working.
- **Analytics (Phase C):** read-only SQL over the projections + `admin_run_facts` (derived cache: actions, networks, bridge route,
  composition parent; rebuildable, no addresses). Facts are filled off the execution path — lazily and bounded when an admin opens
  analytics, or by `admin-cli index`. Classification is a pure, tested function per flow vocabulary.

## 3. Counting model

`workflow` (`workflow_id`) → `execution` (a root run: not a recovery (`recovery_of`) and not a composition child) → `action` (a node of
the run's canonical workflow). Funnel per root run: simulated → reviewed/authorized → started (an attempt beyond PREPARED/CANCELLED, or
evidence) → submitted (a transaction) → outcome (`COMPLETED` = reconciled verdict without pending observation, `FAILED`, `PARTIAL`,
`UNCERTAIN`, `IN_PROGRESS`, `NOT_EXECUTED` = started but nothing landed, `UNCLASSIFIED` = unknown status, reported). Re-simulations
never start; observations/reconciliation update one projection row; recovery runs fold into their root; delegated executions are
separate. Network distribution: one primary network per executed action (bridge = source), environment from provenance
(`MOCKED` never mixed with public data; mainnet vs testnet/devnet labelled); per-network distinct-workflow participation includes
bridge destinations and is presented as overlapping.

## 4. Files (planned)

- `packages/cloud-runtime/migrations/0012_admin_control_plane.sql`, `src/migrations.ts` (manifest).
- `apps/reference-dapp/src/admin/*` (config, session, store, authorize, http handlers, copilot settings + resolver, analytics
  classify/actions/indexer/queries/networks, automations, health) and tests (`*.test.ts`, `*.pg.test.ts`).
- `apps/reference-dapp/src/app/admin/**` (layout, login, Overview, Workflows, Automations, AI Settings, System Health, route handlers).
- `apps/reference-dapp/backend/admin-cli.ts` (+ test). Compatibility edits: `app/copilot-action.ts`, `channels/core/interpreter.ts`,
  `channels/http.ts`, `channels/dispatch-http.ts` (resolve settings per request; env behavior unchanged without a database),
  `next.config.ts` (admin security headers), docs (`docs/deploy/ADMIN.md`, `ENVIRONMENT.md`), an admin browser spec.

## 5. Tests

Unit: session sealing/tamper/expiry/host binding, key distinctness, CSRF/origin refusals, role checks, settings validation and model
catalog, resolver precedence, run classification, action/network extraction. PostgreSQL: 0012 additive + append-only triggers;
grants/sessions/audit; versioning, rollback and a change picked up by two independent resolver instances; route handlers end to end;
indexer + aggregation with compositions/recoveries/re-simulations/MOCKED; automation metrics. Browser: `/admin` sign-in with an
injected test wallet (loopback, no provider), refusal of an unknown wallet, dashboard rendering. Then `pnpm check`, governance-lite.
