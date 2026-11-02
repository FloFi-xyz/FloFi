# BUILD-FLOFI-VERCEL-STORAGE-001 — Vercel storage reduction

- Status: function-package fix, CI gate and owner-run cleanup tool on branch `claude/sleepy-noether-9g1cxy`; PR open for
  owner review (not merged, not deployed).
- Base: `main` at `3a2f5a6` (merge of PR #151). Date: 2026-11-02.
- Authority used: read-only inspection of the Vercel team, project, deployments, aliases, domains and environment variable
  **names**; GitHub PR and branch state; local production builds. No deployment was deleted and no Vercel setting was
  changed (section 2 explains why). No production deployment, environment variable, credential, Railway or Neon resource was
  touched.

## 1. What could and could not be done from this session

| Phase | Outcome | Reason |
| --- | --- | --- |
| 1. Verify storage | Inventory done. Usage figures **not readable** | The Vercel connector has no usage tool; its billing-charges call returns `404 costs_not_found` for this team; `vercel.com` is outside this session's network allowlist. The 49.34 GB figure is the owner's dashboard reading, not re-measured here |
| 1. Attribution FloFi / RoundFi / SolVerdict | **Not possible** | The connector sees one team (`alrimarleskovars-projects`) with one project (`flofi`); no RoundFi or SolVerdict project is visible to it |
| 2. Delete deployments | **Not executed**; verified plan and guarded tool delivered | The connector exposes no deployment-deletion operation (only cancel). `api.vercel.com` is blocked by the session's network policy, so the CLI/REST route is unavailable too |
| 3. Native retention | **Not applied**; exact settings below | No connector operation edits deployment retention (`update_project` has no expiration fields; no team-update tool) |
| 4. Function packages | **Done**: −71.6% per function, CI gate | Sections 4–5 |
| 5. Verify in Usage | **Not possible** from here | Same as phase 1 |

## 2. Inventory (Vercel connector, 2026-11-02 02:47 UTC)

Project `flofi` (`prj_2fqdtcn7AUVmGxGswx6OAAIleIe6`), team `team_absG3FziUYYbVkInIRrJDUYU`: **84 deployments**:
25 production (READY), 54 preview (READY), 2 canceled, 2 errored, 1 building. Older deployments (late September to
mid-October, the Gryloo era) no longer exist; 77 alias records still name them.

Facts the cleanup rules depend on:

- The custom domains `flofi.xyz`, `www.flofi.xyz`, `wallet.flofi.xyz` and `flofi-defi.vercel.app` (and the
  `gryloo.vercel.app` redirect) point at `dpl_2bE13XzzVncdzytxNbS2MyWbQE3p` (production, `3769eff`, PR #150), **not**
  at the newest production deployment `dpl_GuEpMS6kaKPQbS3nKivbQ8ye3QiH` (`3a2f5a6`, PR #151), which holds only the
  `flofi-alrimarleskovars-projects` and `git-main` aliases. Both are preserved. The owner may want to check whether
  production domain assignment is intentionally manual.
- Open PRs whose previews are preserved: #140 `release/schema-0017-compat-v16`, #137
  `fix/p0-live-swap-requote-20261030`, #102 `build/ci-gcp-001-bootstrap`, #55 `codex/build-privacy-001-cloak`, #54
  `codex/build-tempo-001`, #52 `codex/build-016-mode-c-automation`.
- A concurrent build was running on `claude/festive-keller-om54li` (BUILD-FLOFI-E2E-RELIABILITY-001, `0862e88`): preserved.
- No Vercel environment variable names a repository file (no `*_JOURNAL`, `*_PROFILE`, `*_FILE`, `*_HARNESS`), so the
  journal and fork modes that read files by path are not configured on Vercel.

## 3. Cleanup: verified plan and the owner-run tool

`scripts/vercel_deployment_cleanup.py` evaluates every rule on live state each time it runs, plans by default, deletes only
with `--apply --expect N` and fetches each deployment again immediately before deleting it (skipping it if it became
aliased, changed state or target, or moved project). It **never** removes: production or custom-environment deployments,
rollback candidates, aliased deployments, anything less than 24 hours old or still building, any deployment of a branch
with an open PR, the latest two deployments of an active branch (open PR, a commit or a deployment within 24 hours), the
latest READY deployment of any branch, or anything whose project, repository or branch is unknown. GitHub state is
required (GITHUB_TOKEN or `gh`); without it nothing is removed.

### Removable at the snapshot (hand-verified; the tool's unit test replays this exact state and gets the same 14)

| Deployment | Created (UTC) | Kind | Branch (PR) | Why removable |
| --- | --- | --- | --- | --- |
| `dpl_7Cr5oariDqeye7f7jyd7vuRKQkSQ` | 11-01 02:08 | superseded preview | claude/wonderful-shannon-nacbbz (#143, #146 merged) | 7th newest of its branch, unaliased |
| `dpl_6JRwVzAXaNFPsDNWS6zjqY6H69EA` | 11-01 01:51 | superseded preview | claude/build-flofi-execution-performance-001 (#148 merged) | not in latest two, unaliased |
| `dpl_8YnZrLC5DVVnGDeUjMcrbFCfpfHJ` | 11-01 01:50 | superseded preview | claude/wonderful-shannon-nacbbz | superseded, unaliased |
| `dpl_BvwV3DtQj3C24VCqpQ6eAyiDHSK2` | 11-01 01:36 | superseded preview | claude/build-flofi-execution-performance-001 | superseded, unaliased |
| `dpl_8exvTbhQBF7JrMaBsbXHbvZsncrY` | 11-01 00:51 | superseded preview | release/schema-0019-compat (#147 merged) | superseded by `8970183`, unaliased |
| `dpl_FyMnvzxCLLFXVPxqMN767s2KDaLy` | 10-31 23:53 | superseded preview | claude/wonderful-shannon-nacbbz | superseded, unaliased |
| `dpl_27RLwBFuLRcGgXZ4BQGUvhxyAV8L` | 10-31 23:01 | superseded preview | claude/wonderful-shannon-nacbbz | superseded, unaliased |
| `dpl_2mBqX6zdatTKhCSa6vSh1heALaEg` | 10-31 19:19 | superseded preview | claude/build-flofi-landing07-readme-001 (#144 merged) | same commit later deployed to production; branch alias moved |
| `dpl_3REJLnPog8CxQQV5SVRmRrAxTYQH` | 10-31 14:33 | superseded preview | release/schema-0018-compat-v17-20261031 (#145 merged) | superseded, unaliased |
| `dpl_F7kp9bW93eTt5AcLYxWjgUVxnr1s` | 10-30 23:16 | superseded preview | claude/build-flofi-claude-agents-001 (#142 merged) | superseded, unaliased |
| `dpl_AFo22PdoQyJEB8jbcYdje6mgAYA8` | 10-30 21:50 | superseded preview | claude/festive-darwin-du0oft (#141 merged) | superseded, unaliased |
| `dpl_Gaw2tR7o7hNwmpbTRAgz8KL2zaKF` | 10-29 23:26 | superseded preview | claude/build-flofi-bridge-live-fix-003 (#136 merged) | superseded, unaliased |
| `dpl_9v4TzUp1CSfjBmVDjo85t29xirtc` | 10-28 11:55 | errored | codex/fix-financial-execution-truth-001 (#130 merged) | ERROR, unaliased |
| `dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR` | 10-27 20:39 | canceled | codex/build-copilot-context-engine-001 (#129 merged) | CANCELED, unaliased |

Preserved at the snapshot (70), by first reason: production 25, created in the last 24 hours 25, aliased 18 (custom
domains, branch URLs, open PRs), branch with an open PR 1, latest READY deployment of a merged branch 1.

Once the 24-hour window passes, the same rules add the superseded previews of merged PRs #146, #148, #150 and #151:
the tool's test computes **39 removable** at 2026-11-03 03:00 UTC (35 superseded previews, 2 errored, 2 canceled)
for the same inventory. The tool decides at run time; pushes to this PR's branch keep that branch's previews protected
while it has an open PR.

### Owner steps (from a clone of this branch, with your own credentials; nothing is printed)

1. Make `VERCEL_TOKEN` (a token with access to the team) available in your shell, and be logged in with `gh` (or set
   `GITHUB_TOKEN`).
2. `python3 scripts/vercel_deployment_cleanup.py --report /tmp/flofi-vercel-plan.json` and read the plan.
3. `python3 scripts/vercel_deployment_cleanup.py --apply --expect N --report /tmp/flofi-vercel-cleanup.json`, with N
   the removable count of the plan you reviewed. A different count refuses to run.

The same list can be deleted from the Vercel dashboard (Deployments, select, Delete) after checking that each has no
domain. Vercel keeps deleted deployments recoverable for 30 days before removing them permanently; whether Usage drops at
deletion or at permanent removal is not stated in the documentation available here.

## 4. Native retention (owner action in the dashboard; not applied)

Project `flofi` → Settings → Deployment Retention Policy (the API equivalent is the project's deployment-expiration setting):

| Setting | Recommended | Why |
| --- | --- | --- |
| Production | **unchanged** | Mandate: production retention is not changed |
| Preview | 1 month | Superseded previews stop accumulating. Caveat: the documentation available here does not say whether aliased branch deployments of open PRs are exempt. Previews of the dormant open PRs #52, #54, #55 (created 2026-10-04..08) would reach one month on 2026-11-04..08. If they must stay, choose 2 months, or redeploy a PR's branch when it is needed |
| Errored | 1 week | Build logs stay available for diagnosis |
| Canceled | 1 day (or the shortest offered) | Canceled builds hold nothing needed |

No custom scheduled automation is added: native retention handles the steady state; the cleanup tool is for today's
backlog.

## 5. Function packages (implemented)

### Root cause (measured)

The production build printed `Turbopack build encountered 1 warning: Dynamic filesystem access causes tracing of the
whole project` at `packages/cloud-runtime/dist/migrations.js:103` (`readdir(directory)` in `loadMigrations`). Every route
that imports `@defi-workflow-engine/cloud-runtime` (58 of 69) therefore shipped the entire app directory:
`e2e/visual-evidence` (77.9 MB, 375 screenshots and reports), Playwright snapshots, fork transcripts, TypeScript sources and
tests, `public/` (10.4 MB), `tsconfig.tsbuildinfo` and the Playwright configs. Functions never call `loadMigrations`: they
verify the schema against `SHIPPED_MIGRATIONS`; only the `migrate` command reads the SQL files from disk.

### Changes

| File | Change | Runtime effect |
| --- | --- | --- |
| `packages/cloud-runtime/src/migrations.ts` | `/*turbopackIgnore: true*/` on the two filesystem calls of `loadMigrations` | None (comment); `migrate` reads the same files |
| `apps/reference-dapp/next.config.ts` | `RUNTIME_FIXTURES` (Copilot replay v1/v2, recorded Base observations) shipped with **every** route (`'/**'`), previously listed for `/app`, `/approve`, `/mcp/approve` and reaching other routes only through the whole-project trace | Channels, MCP and API routes keep the replay files they had |
| `apps/reference-dapp/next.config.ts` | `TRACE_EXCLUDES`: e2e evidence and fork transcripts, test data, TypeScript sources and tests, `backend/`, `public/` | None: no server code reads these by path (searched); functions run compiled `.next/server` chunks; `public/` is served by the CDN |
| `scripts/function_traces.py` + CI | Gate after `pnpm build` in CircleCI, GitHub Actions and Cloud Build | Fails the Production build stage on a regression |

Two further `<dir>/<name>` patterns (journal paths matching every app JSON file, Router journals matching `router-*`)
were traced to no single call site; `turbopackIgnore` on the two likeliest calls had no effect and was reverted. The
excludes cover their files instead.

### Measured on local production builds (pinned Node 24.21.0, pnpm 11.22.0, Next 16.4.1 Turbopack)

Function = a route's trace plus the Next server runtime trace, each file once (what Vercel packages per function).

| Metric | main `3a2f5a6` | Migration fix only | This branch | Change |
| --- | --- | --- | --- | --- |
| Largest function | 159.4 MB | 48.6 MB | **45.2 MB** | −71.6% |
| Distinct traced files (all functions) | 3,963 / 177.0 MB | 1,932 / 66.2 MB | 1,874 / **62.8 MB** | −64.5% bytes |
| Sum over 69 functions, before deduplication | 9,264.7 MB | 2,817.5 MB | **2,643.4 MB** | −71.5% |
| App files in functions | ~2,000 (e2e, src, public, configs) | 65 | 7 (3 runtime fixtures, `package.json`, 2 `tsconfig*.json`, `vercel.json`) | |
| Turbopack whole-project warning | yes | no | no | |

What remains in a function is the framework and the app itself: compiled server chunks (24.6 MB, shared), `next`
(15.5 MB), and `sharp` with libvips (19.7 MB) in 5 routes. Whether `sharp` can go with `images.unoptimized: true` is not
proven and is left for a follow-up.

The gate fails on the regression: rebuilding with only the migration fix reverted (excludes kept) produced the
whole-project warning again, and `scripts/function_traces.py` failed on `tsconfig.tsbuildinfo`, `next.config.ts` and the
Playwright configs (the excludes hid the rest). Its budget is 64 MB per function (measured 45.0 MB by the gate's own count).

## 6. Storage results and estimates

Measured here: none of the Usage figures (section 1). Everything below is an **estimate** labelled as such.

- Starting point (owner reading): 49.34 GB Functions Storage. Visible to the connector: 79 READY deployments in `flofi`
  (plus 5 canceled/errored/building), so on average **≈0.62 GB per READY deployment** (estimate: assumes the figure is
  FloFi's and spread evenly).
- Cleanup now (12 READY previews): **≈7.5 GB**. Cleanup after the 24-hour window (35 READY previews): **≈22 GB**,
  leaving ≈27 GB (estimate).
- Remaining above 10 GB: the **25 production deployments (≈15.6 GB est.)** are protected by the mandate (no production
  deletion, production retention unchanged), plus the protected previews (open PRs, aliased branch URLs, recent work).
  10 GB is not reachable without an owner decision on production deployment retention.
- After this PR is merged and deployed: each new deployment's function payload is 64–72% smaller on the measured traces,
  i.e. **≈0.18–0.22 GB instead of ≈0.62 GB** per deployment (estimate; Vercel's packaging and billing are not observable
  here). Existing deployments keep their size until removed.

## 7. Validation

| Check | Result |
| --- | --- |
| `python3 -m unittest scripts/test_ci_function_traces.py` | 11 OK |
| `python3 -m unittest scripts/test_ci_vercel_deployment_cleanup.py` (incl. the real-inventory replay) | 9 OK |
| `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` | 245 OK |
| `python3 -m unittest discover -s scripts -p 'test_governance_lite.py'`, `python3 scripts/governance_lite.py` | 21 OK / PASS |
| `python3 scripts/agent_guard.py check` | PASS |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests; pinned Node 24.21.0) | PASS: 511 files, 6,241 tests passed, 2 skipped (the same environment-gated skips as `main`) |
| `python3 scripts/function_traces.py apps/reference-dapp` on that build | PASS, largest 45.0 MB |
| CircleCI certification (browser suites on the built app) | see PR; note it serves `next start` from a full checkout, so it cannot see a file missing from a Vercel function |
| Vercel preview of this branch (the only place traced packages run) | see PR |

## 8. Owner decisions requested

1. Run the cleanup tool (section 3) or delete the listed deployments in the dashboard.
2. Apply the retention settings (section 4); choose Preview 1 month or 2 months for the dormant open PRs.
3. Production retention: the only route to ≤10 GB; not changed here.
4. Whether `flofi.xyz` should follow the newest production deployment (`3a2f5a6`); it still serves `3769eff`.
5. Give the Vercel connector access to RoundFi and SolVerdict if their share should be measured.
