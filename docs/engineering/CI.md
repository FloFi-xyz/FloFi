# CircleCI certification: architecture, lifecycle and maintenance

CircleCI is the certification authority (GitHub Actions stays disabled; Cloud Build runs the same plan on one worker when the owner
submits a source snapshot). This page describes the topology introduced by
[BUILD-FLOFI-CI-ARCHITECTURE-002](../builds/BUILD-FLOFI-CI-ARCHITECTURE-002.md) and the rules that keep pipelines from being wasted.

## Topology

```
t=0      governance (small) ─────────┐            certification-build (large: install, pnpm build, function traces, pack)
                                     │                         │  workspace: build.tar + manifest (this revision only)
after governance:                    ├─ certification-supply-chain (small): dependency security, audit, SBOM
                                     ├─ certification-checks (large + PostgreSQL): typecheck, lint, schema drift,
                                     │     PostgreSQL suites, anvil + fork suite
                                     ├─ certification-unit (large): package build, unit and contract suites, exported API
after governance + build:            └─ certification-browser-1 … -8 (medium + PostgreSQL): verify and unpack the build,
                                           anvil, headless shell; job 1 runs the critical tier first; job k runs shard k/8;
                                           job 8 then runs the composition fork and browser step
fan-in:  certification (small): `python3 scripts/ci-observe.py verify` (the ledger)
```

| Job | Runner | Work |
| --- | --- | --- |
| `governance` | small | governance unit tests, CI tests, `governance_lite.py`, whitespace over every commit the branch adds |
| `certification-build` | large, no database | the one production build of the revision; `scripts/ci_build_artifact.py pack` |
| `certification-supply-chain` | small | dependency security policy, audit, SBOM: a new upstream advisory blocks certification without hiding any other job's results |
| `certification-checks` | large + PostgreSQL | typecheck, lint, schema drift, PostgreSQL suites, fork suite |
| `certification-unit` | large, no database | `turbo run build` of the packages, then the unit and contract suites with their result guard |
| `certification-browser-1..8` | medium + PostgreSQL | `ci_build_artifact.py unpack`, then the browser shards (critical tier first in job 1, composition last in job 8) |
| `certification` | small | the ledger: every required stage and every planned browser profile, each exactly once, all for this revision |

Every job keeps its own loopback ports and disposable PostgreSQL. Status contexts keep their names
(`ci/circleci: governance`, `certification-checks`, `certification-browser-1`, `certification-browser-2`, `certification`); the
new jobs add their own contexts. `certification` stays the gate: it only runs when every job passed, and it fails closed.

### The build artifact

`certification-build` writes `build.tar` (every workspace `packages/*/dist` and `apps/*/.next` without `.next/cache`) and a manifest
with the revision, the `pnpm-lock.yaml` SHA-256 and the tar's SHA-256 (a build output with hard links fails the build job). Each browser
job, after its own checkout and frozen install, refuses an artifact of another revision or lockfile, a digest mismatch, outputs that
already exist, members outside those output roots, absolute or `..` paths, devices and hard links, any member below a link of the
archive, and links pointing anywhere but the checkout's `node_modules/`; it then extracts, from the same open file it hashed, with the
tarfile `data` filter. Because the build job starts beside governance, it runs `governance_lite.py` itself before installing. CircleCI
workspaces belong to one workflow (one revision; "Rerun failed jobs" keeps the revision), so a build never crosses commits or branches,
and no cache is involved. Every browser profile now certifies the same build.

### Browser shards

`scripts/guarded-release-browser.mjs` computes the shards: a deterministic balancer (longest first, then moves and swaps that lower the
most loaded shard) over the median measured seconds in `scripts/ci-browser-timings.json`. Shard 1 counts the critical tier and the last
shard the composition step as fixed load. A profile without a measurement counts as the median profile, so adding a profile needs no
manual placement. Each shard runs shortest first. `node scripts/guarded-release-browser.mjs list` prints the plan with
`shardSeconds`. GitHub Actions and Cloud Build run all shards in one place.

Profiles longer than a shard's share run as parts with identical settings (`default-product-1..2`, `execution-continuity-1..3`); each
part starts its own servers and database, and together the parts run exactly the former spec lists (`scripts/test_ci_optimization.py`).

## Pipeline lifecycle

Triggers: `pull_request` opened/synchronize for branches and `push` for `main` (one pipeline per revision; no duplicate trigger was found
in 60 consecutive pipelines). Every `main` revision is certified; nothing cancels it.

1. **Superseded revisions stop.** Owner setting: CircleCI → Project Settings → Advanced → **Auto-cancel redundant workflows** (it never
   applies to the default branch). Independently, the repository guard `scripts/ci_supersede.py` (enabled by `FLOFI_CI_SUPERSEDE_CHECK=1`
   in the CircleCI executors) runs at every stage start and between browser profiles: when the job's pull-request branch now points to
   another commit (`git ls-remote` with the checkout's own access, at most once per 45 s), the job stops with exit 75, records
   `superseded` and is never a pass. It never acts on `main`, on other branches or on other pipelines, and any read error lets the job
   continue.
2. **Consolidate before pushing.** All jobs of a failing certification run to completion, so one run shows every failing job. Read all
   of them, fix everything, run the focused local gates, then push once. A push while a needed certification runs supersedes it.
3. **No manual pipelines** for a revision that already has one (no API trigger, no "Rerun workflow from start").
4. **Reruns: at most one, same revision, failed jobs only**, and only for a failure shown to be transient: an infrastructure error
   (download, spin-up, out of memory, agent), or a test in CircleCI's flaky-test list failing on timing, unrelated to the diff. Use
   "Rerun failed jobs"; the ledger accepts the original passing jobs' records of the same revision. Deterministic failures (assertions,
   visual baselines, governance, dependency policy, typecheck, lint, schema drift) are fixed before any new certification.
5. **Visual baselines.** A test stops at its first differing screenshot, so its later screenshots only render once the first matches. After
   a screenshot difference the guarded runner renders every screenshot of the failed tests once more into
   `playwright-results/<profile>-candidate-baselines/` (the `e2e/` layout; `FLOFI_CANDIDATE_BASELINES`, never set in a certifying run;
   committed baselines are neither read nor written; the profile stays failed). Review those renders, copy only the intended changes into
   `apps/reference-dapp/e2e/*-snapshots/`, and push them together.

## Maintenance

- **Rebalance** when profile times drift: download the `playwright-results/guarded-*.json` artifacts of a few green certifications and run
  `python3 scripts/ci_timings.py update <directory>`; review `node scripts/guarded-release-browser.mjs list` (`shardSeconds`).
- **Change the number of browser jobs:** `BROWSER_SHARDS` in `scripts/guarded-release-browser.mjs` and the `certification-browser-<n>`
  jobs, their `requires` and the fan-in in `.circleci/config.yml` (the CI tests require them to match).
- **Split a long profile** into parts with identical settings and add it to `SPLIT_PROFILES` in `scripts/test_ci_optimization.py`.

## Rollback

| Change | Rollback |
| --- | --- |
| Whole build | Revert the merge commit of BUILD-FLOFI-CI-ARCHITECTURE-002; nothing persistent depends on it (no schema, cache key or setting changed). |
| Medium browser runners | `resource_class: large` in the `certification-browser` executor (one line). |
| Supersede guard | `FLOFI_CI_SUPERSEDE_CHECK: "0"` in the shared executor environment (one line). |
| Shared build | In `prepare-browser`, replace the attach/unpack steps with `production-build` and drop `certification-build` from the browser jobs' `requires` (the CI tests document the expected shape). |
| Shard count | Change `BROWSER_SHARDS` and the browser jobs together. |
