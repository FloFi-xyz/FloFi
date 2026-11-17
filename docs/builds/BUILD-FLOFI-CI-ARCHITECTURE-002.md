# BUILD-FLOFI-CI-ARCHITECTURE-002 — CI performance, concurrency and cost

- Status: implemented on branch `claude/hopeful-hypatia-9gjxig`; one PR open for owner review (not merged, nothing deployed).
- Scope: CI orchestration, its tests and documentation. No product behaviour, UX, financial logic, wallet, protocol, schema, migration,
  production variable or dependency changed. The only file under `apps/` is `apps/reference-dapp/playwright.config.ts` (a test
  configuration hook used only by a diagnostic render after a screenshot failure, §5.6).
- Maintained guide: [docs/engineering/CI.md](../engineering/CI.md) (topology, lifecycle rules, rebalancing, rollback).

## 1. Baseline

| Item | Value |
| --- | --- |
| Base main SHA | `63755e0655450f8965071fb0575eca35cf0401ce` (merge of PR #207) |
| Previous architecture | BUILD-FLOFI-CI-ARCHITECTURE-001 (PR #151): governance, then three large jobs (`certification-checks` with browser shard 3, `certification-browser-1` critical + shard 1, `certification-browser-2` shard 2 + composition), each building the app, then the `certification` ledger fan-in |
| Toolchain | Node 24.21.0, pnpm 11.22.0, Anvil 1.8.3, headless shell 1243 (unchanged) |
| Suites at base | 55 guarded browser profiles + composition; 706 unit files / 9,181 unit tests (2 env-gated skips, pre-existing); 131 PostgreSQL files; fork and offline suites |
| Rates used for cost | CircleCI Docker credits per minute, billed per second: small 5, medium 10, large 20 (CircleCI's published resource-class rates; confirm on the plan's pricing page). "Large-minutes" = credits ÷ 20 |

## 2. Phase 1 — audit of 27 pipelines (30 workflows)

All pipelines from 2026-11-16 14:40 to 2026-11-17 16:26 UTC (the last 26 pipelines plus `58726036`, the most recent earlier one with a
rerun), green, failed and rerun. Per workflow, job and step timestamps, outcomes, failure causes and resource usage were collected through
the CircleCI API (one agent per two pipelines) and then re-read independently for every pipeline; the only differences found were 27 jobs
that never started (governance failed first), whose end times the API fills and the collector left empty. Per-profile and per-test seconds
come from the jobs' own `playwright-results` artifacts (JUnit and guarded reports). No pipeline was triggered, rerun or cancelled.

### 2.1 Pipelines

| Pipeline | Branch | Revision | Event | Outcome | Wall clock | Large-min | Credits | Failure / note |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `a81bafb7` | claude/zealous-heisenberg | `7d91a8b` | PR synchronize | succeeded | 34.3 min | 91.2 | 1830 | |
| `ca8a31d3` | claude/zealous-heisenberg | `14aba05` | PR synchronize | failed | 33.4 min | 89.6 | 1797 | browser-1 test |
| `f910e675` | claude/zealous-heisenberg | `d45f136` | PR opened | failed | 1.0 min | 0.0 | 5 | governance (whitespace) |
| `a99874e5` | main | `63755e0` | push | succeeded | 35.9 min | 92.6 | 1857 | |
| `96c29b31` | fix/execution-ux-reliability | `987a0f5` | PR opened | succeeded | 33.9 min | 89.0 | 1786 | |
| `ee86f65a` | main | `caa5701` | push | failed | 30.9 min | 72.2 | 1450 | browser-1 flaky (`channel-approve`) |
| `ee86f65a` | main | `caa5701` | rerun | succeeded | 27.6 min | 27.3 | 547 | rerun of failed jobs, same SHA |
| `2cd74064` | claude/festive-bell | `7b9de81` | PR synchronize | succeeded | 33.4 min | 86.8 | 1742 | |
| `c30c862a` | claude/festive-bell | `b8b0eb7` | PR synchronize | failed | 29.6 min | 66.6 | 1337 | unit test; superseded by `2cd74064` |
| `8a47c5fa` | claude/festive-bell | `abfa059` | PR synchronize | succeeded | 30.5 min | 84.5 | 1696 | |
| `45846a49` | claude/festive-bell | `3d81a32` | PR opened | failed | 1.0 min | 0.0 | 5 | governance (CI plan test) |
| `382390a6` | main | `c105e1d` | push | succeeded | 31.2 min | 85.9 | 1724 | |
| `62caa354` | claude/peaceful-keller | `31f8a4e` | PR synchronize | failed | 33.3 min | 89.4 | 1792 | checks flaky (`flight`) |
| `62caa354` | claude/peaceful-keller | `31f8a4e` | rerun | succeeded | 31.7 min | 31.4 | 629 | rerun of failed jobs, same SHA |
| `d6042ff7` | claude/peaceful-keller | `12ba9dd` | PR opened | failed | 29.9 min | 84.3 | 1691 | checks flaky (`flight`); superseded after 1.7 min |
| `39fb8569` | main | `d49f80a` | push | succeeded | 32.6 min | 86.9 | 1747 | |
| `8920b0cb` | claude/zealous-heisenberg | `f3c3e8a` | PR synchronize | succeeded | 33.0 min | 87.4 | 1753 | |
| `31240083` | claude/zealous-heisenberg | `c237225` | PR synchronize | failed | 34.1 min | 92.1 | 1847 | visual baselines |
| `b81e6554` | claude/zealous-heisenberg | `a9d27c9` | PR synchronize | failed | 31.2 min | 87.6 | 1758 | visual baselines |
| `eb03df3b` | claude/zealous-heisenberg | `3ab5416` | PR synchronize | failed | 32.7 min | 87.3 | 1752 | visual baselines; superseded by `b81e6554` |
| `f799a1fd` | claude/zealous-heisenberg | `fa49c21` | PR synchronize | failed | 32.7 min | 58.8 | 1181 | visual baselines; dependency policy (Next.js advisory) |
| `79fae58f` | claude/zealous-heisenberg | `ae7a367` | PR opened | failed | 32.5 min | 58.5 | 1176 | visual baselines; dependency policy; superseded by `f799a1fd` |
| `a3f461d2` | main | `b41ee5d` | push | succeeded | 30.3 min | 83.4 | 1676 | |
| `83af78e0` | claude/busy-turing | `b690ce5` | PR synchronize | succeeded | 31.6 min | 83.7 | 1681 | |
| `87126631` | claude/busy-turing | `c062742` | PR synchronize | failed | 30.0 min | 83.3 | 1670 | visual baselines |
| `23ba33b2` | claude/busy-turing | `a070dcc` | PR synchronize | failed | 32.7 min | 88.6 | 1778 | visual baselines; browser-2 test |
| `ede427a7` | claude/busy-turing | `97baae2` | PR synchronize | failed | 1.0 min | 0.0 | 5 | governance (CI plan test) |
| `47870eb7` | claude/busy-turing | `601383d` | PR opened | failed | 0.9 min | 0.0 | 4 | governance (CI plan test) |
| `58726036` | claude/eloquent-carson | `543008c` | PR synchronize | failed | 28.9 min | 81.1 | 1626 | checks flaky (`flight-closed-beta`) |
| `58726036` | claude/eloquent-carson | `543008c` | rerun | succeeded | 31.8 min | 31.6 | 633 | rerun of failed jobs, same SHA |

### 2.2 The green certification (10 first-attempt green workflows)

| Metric | Mean | Min | Max |
| --- | ---: | ---: | ---: |
| Wall clock | **32.7 min** (1960.6 s) | 30.3 min | 35.9 min |
| Runner compute | 87.1 large-min | 83.4 | 92.6 |
| Credits (est.) | 1,749 | 1,676 | 1,857 |
| `certification-checks` (the critical path) | 31.1 min | 28.7 | 34.4 |
| `certification-browser-1` / `-2` | 29.0 / 27.0 min | | |
| Queue (job eligible → started) | ≤ 3.8 s | | |

Mean step seconds: spin-up 17–21 (large + PostgreSQL), checkout 7, archive cache 1.3, toolchain 6.8, install 10.3; production build
124 (checks, after typecheck) / 151 / 158 (browser jobs); dependency security 16.2, typecheck 114.5, lint 49.7, unit 500.4, PostgreSQL
343.4, fork 41.0; critical tier 319.5, shard 1 1212.8, shard 2 1384.6, shard 3 623.2, composition 26.1. Three builds per certification
(≈ 7.2 min of compute) and 55 profile start-ups (≈ 10–15 s each). Resource usage (CircleCI, per job): the unit suite saturates 4 cores
for ~9 min; PostgreSQL ~2.3 cores; the browser phases average **1.1–1.7 of 4 cores** with 2–3.2 GiB, and `execution-continuity`
(~12 min) sits at ~0.5 cores — it waits on the loopback lifecycle.

Cold vs warm cache: the tool-archive cache is keyed per branch; a branch's first pipeline (cold) bootstrapped Node/pnpm in 7.0 s, anvil
3.8 s and the headless shell 2.7 s, against 6.8 / 3.5 / 2.4 s warm. The cache saves under a second per job (as ARCH-001 measured); no
other cache exists.

### 2.3 Where the credits went (30 workflows, 40,176 credits)

| Category | Workflows | Credits | Share |
| --- | ---: | ---: | ---: |
| Green first attempt | 10 | 17,493 | 43.5% |
| Failed: visual baselines (one PR, sequential screenshot fixes) | 7 | 11,163 | 27.8% |
| Failed: transient (flaky tests `flight`, `flight-closed-beta`, `channel-approve`) | 4 | 6,559 | 16.3% |
| Failed: deterministic test | 2 | 3,134 | 7.8% |
| Reruns of failed jobs (same SHA, one each, all green) | 3 | 1,808 | 4.5% |
| Failed: governance (≈ 1 min each) | 4 | 19 | 0.0% |

- **Superseded pipelines ran on:** four pipelines kept running after a newer push to the same branch: **216 large-min ≈ 4,330 credits
  (10.8%)**, e.g. `d6042ff7`, superseded 1.7 minutes after it started, ran 82.5 more large-minutes. No pipeline was cancelled, so
  CircleCI's auto-cancel did not act on these GitHub App `pull_request` pipelines (the setting is off or does not reach them; it cannot
  be read through the API available here).
- **Duplicate triggers: none.** 60 consecutive pipelines (2026-11-14 → 11-17) had 60 distinct revisions: `pull_request` opened /
  synchronize for branches and `push` for `main`. GitHub Actions has not run since 2026-10-14 (disabled), so it adds no pipelines.
- **Reruns** followed the rule already: one "rerun failed jobs" per revision, same SHA, for flaky failures only.
- **Failing jobs run to completion**, so one failing run shows every failure; the visual-baseline loop came from screenshots that only
  render once the earlier screenshot of the same test matches (seven certifications for one PR).

### 2.4 Comparison with BUILD-FLOFI-CI-ARCHITECTURE-001

| | ARCH-001 after (4 runs) | Base of this build (10 runs) | Change |
| --- | ---: | ---: | ---: |
| Wall clock | 1432.9 s (23.9 min) | 1960.6 s (32.7 min) | +37% |
| Runner compute | 66.8 large-min | 87.1 large-min | +30% |
| Browser profiles | 50 | 55 + composition | +5 |
| Unit tests | 6,241 | 9,181 | +47% |

The suite grew; the three-job layout stayed, so every job grew with it, and `certification-checks` (unit ~8.3 min + PostgreSQL ~5.7 min
+ shard 3) became the critical path.

## 3. Design

```
t=0   governance (small, ~1 min) ─┐   certification-build (large, no DB): install, pnpm build, function traces, pack (~3.5 min)
                                  ├─ certification-supply-chain (small): dependency security, audit, SBOM
                                  ├─ certification-checks (large + PostgreSQL): typecheck, lint, schema, PostgreSQL, fork
                                  ├─ certification-unit (large, no DB): package build, unit and contract suites
      governance + build ─────────┴─ certification-browser-1 … -8 (medium + PostgreSQL): verified build, critical tier (job 1),
                                     shard k/8, composition (job 8)
fan-in: certification (small): the unchanged ledger
```

Design rules: one build per revision instead of three; no job of the critical path does work another job could do in parallel; the
browser suites, which wait on loopback lifecycles, run on half-price runners in more parallel lanes; every job keeps its own loopback
ports and disposable PostgreSQL; the ledger and its fail-closed rules are unchanged.

## 4. Phase 2 — pipeline lifecycle

| Finding | Action |
| --- | --- |
| No duplicate trigger (one pipeline per revision; Actions disabled) | None needed; documented. |
| Superseded pipelines ran to completion (216 large-min in the audit) | **Owner setting:** CircleCI → Project Settings → Advanced → *Auto-cancel redundant workflows* (never applies to the default branch). **Repository guard** `scripts/ci_supersede.py`, independent of that setting: at every stage start and between browser profiles, a job of a pull-request branch whose head moved to another commit stops with exit 75 and outcome `superseded`. It never acts on `main`, other branches or other pipelines; it reads only `git ls-remote origin refs/heads/<branch>` with the checkout's own access, at most once per 45 s; any read error lets the job continue. A superseded job is never a pass: the stage record says `superseded` and the ledger refuses it. |
| Reruns followed the rule (one, same SHA, failed jobs, flaky only) | Written down for every session: [CLAUDE.md](../../CLAUDE.md), [AGENTS.md](../../AGENTS.md), [CI guide](../engineering/CI.md#pipeline-lifecycle). |
| Visual-baseline loops (27.8% of the audited credits) | After a screenshot difference the runner renders every screenshot of the failed tests into `<profile>-candidate-baselines/` (artifact), so one run shows all baselines a change needs (§5.6). |
| Flaky tests (`flight` board ×2, `flight-closed-beta`, `channel-approve`; 16.3% + 4.5% reruns) | Not changed here (test behaviour is out of scope); listed for owners with CircleCI's flaky-test evidence (§9). |
| Separate docs-only pushes started full certifications while one was running | Rule: consolidate fixes and records into one push; a push supersedes the running certification. |
| An upstream advisory stopped `certification-checks` at its first step (2 audited runs, and this PR's first run), hiding typecheck, lint, PostgreSQL and fork results | The supply-chain gates (dependency policy, audit, SBOM) run in their own small job, `certification-supply-chain`: the advisory still blocks certification, and every other result arrives in the same run. |

Main certifications, other branches and other developers' pipelines are never cancelled by either mechanism.

## 5. Phase 3 — performance decisions

### 5.1 Adopted

| Change | Measured basis | Effect |
| --- | --- | --- |
| **One build per workflow** (`certification-build`, `scripts/ci_build_artifact.py`) | Three builds per certification (124/151/158 s); pack 0.9 s and unpack 0.9 s for 166 MiB / 3,780 entries locally; the 383 MiB compiler cache never travels | −2 builds per certification; every browser profile certifies the same build |
| Build starts with governance | Governance 63.6 s mean; only 4 of 30 workflows failed there | ~1 min off the critical path; a governance failure wastes ≤ 1 build (~3.5 large-min) |
| Unit suites in their own job, with their own package build | Unit 500 s CPU-bound; packages-only build 32 s locally; the clean-checkout unit run passes without `.next` (704 files, 9,179 tests) | Off the critical path; no dependency on the build job |
| Checks job without browser shard and unit suite | 10.3 min of static, PostgreSQL and fork work | Ends ~11.4 min |
| **Eight browser jobs on `medium`** | Browser phases use 1.1–1.7 of 4 cores; pinned to 2 CPUs locally: `review-execute-recovery-components` 134.5 → 152.3 s (+13%), `approve-workflow-run` 119.3 → 120.3 s (+0.8%), `flight` 88.0 → 101.8 s (+16%); measured on CircleCI medium: +10.6% median, 2.4–3.2 GiB of 4 GiB, all 58 profiles green (§7.3) | Half-price runners, eight lanes of ~8.4 min of profiles |
| **Shards computed from measurements** (deterministic balancer, `scripts/ci-browser-timings.json`, `scripts/ci_timings.py`) | Median seconds of 12–18 green runs per profile; 8 shards of 453–454 s (shard 1 includes the critical tier, shard 8 composition) | No manual shard lists; a new profile is placed automatically |
| **Two long profiles split into parts** | `execution-continuity` 718 s median (≈ 0.5 core, waiting), `default-product` 572 s; per-spec JUnit medians | Parts of 243–294 s with identical settings, each on its own servers and database; same specs exactly once |

### 5.2 Investigated, not adopted

| Option | Finding | Decision |
| --- | --- | --- |
| Two Playwright lanes in one container (port and database isolation) | App and synthetic-fork ports are configurable, but 15+ harness ports (8549–8581) are hard-coded across `e2e/`, `src/` and `packages/`; only harness-free profiles (~920 s) could share a container | Not adopted: it would need product-code changes and adds cross-talk risk; parallelism stays at container level |
| More Playwright workers per profile | Profiles share one server, database, fork and harness journal | `workers: 1` kept |
| Vitest `isolate: false` | −116 s locally (import is 48% of the unit suite's time) | Not adopted: changes test isolation semantics |
| Vitest threads pool / xlarge for unit | The unit job is off the critical path; xlarge is cost-neutral at best | Not adopted |
| More PostgreSQL workers | 131 files, each with its own database, ~2.3 cores at 2 workers; more workers risk connection limits in concurrency suites | Kept at 2 (off the critical path) |
| Turbo concurrency 4 | Package phase 32 s locally; it only matters inside the build job (Next.js builds alone after the packages) | Kept at 2 (≤ 10–15 s at stake, test-pinned memory guard) |
| Next.js build cache, pnpm store, `node_modules` in caches | CircleCI caches cross branches (poisoning); install is 10 s | Not adopted (unchanged from ARCH-001) |
| All jobs on `large` with the same topology | Projected 12.6 min but ~1,870 credits (+7%) | Rejected: no cost increase without benefit |

### 5.3 Ledger and isolation

Unchanged rules: every required stage (18) succeeded in some job, every planned browser profile exactly once, everything for this
revision. New outcomes are refusals too: `superseded` (exit 75) like `cancelled/interrupted`, `failure` and `incomplete`. The split
parts are separate planned profiles, so a missing, repeated, failed or other-revision part fails the ledger exactly like any profile.

### 5.4 Build artifact safety

The artifact is a workflow-workspace file, not a cache: it is produced and consumed inside one workflow, which belongs to one revision
(a "rerun failed jobs" workflow keeps it). Consumers refuse before writing anything: another revision or lockfile, a digest mismatch,
existing outputs, members outside `packages/*/dist` and `apps/*/.next` (and `.next/cache`), absolute or `..` names, devices and hard
links, any member below a link of the archive, links pointing anywhere but the checkout's `node_modules/` (lexically, so link chains
cannot escape), a member count different from the manifest, and a Python without the tarfile `data` filter; extraction reads the same
open file that was hashed and uses the `data` filter as a second check. The build job refuses hard links when packing and, since it
starts beside governance, runs `governance_lite.py` before installing anything.

### 5.5 Browser profile parts

`default-product-1/2` and `execution-continuity-1/2/3` carry the same settings as the former profiles; together they run the former
spec lists, each spec exactly once (`scripts/test_ci_optimization.py`). Each part starts its own synthetic fork (the runtime folder is
recreated at start), app server and, where configured, a fresh `flofi_e2e_*` database. The flofi-workflow review found no spec that
depends on another spec's state.

### 5.6 Candidate baselines after a screenshot difference

`scripts/guarded-release-browser.mjs` (diagnostic only, after a profile already failed): if the failed run left a `*-diff.png`, the failed
tests run once more with `FLOFI_CANDIDATE_BASELINES=<output>-candidate-baselines`. `apps/reference-dapp/playwright.config.ts` then points
`snapshotPathTemplate` at that empty directory (same layout as `e2e/`), so each screenshot is written instead of compared and the test
reaches its later screenshots. The committed baselines are neither read nor written, the profile stays failed, and certifying runs
delete the variable. Verified locally: `visual-shell.spec.ts` wrote its three screenshots to the candidate directory and the checkout
stayed clean.

## 6. Phase 4 — governance and security

- No test, assertion, gate, security control, dependency-policy rule, SBOM check, tenant-isolation, financial or PostgreSQL suite was
  removed, skipped or moved to a nightly run; every former browser spec still runs exactly once.
- Certification stays fail-closed and bound to the exact SHA (§5.3); the build artifact is revision- and lockfile-bound (§5.4).
- GitHub Actions stays disabled and its workflows are unchanged; Cloud Build runs the same plan (`extended --collect-failures` in one
  pass instead of three shard calls) with the same ledger; the parity tests cover all three providers.
- No dependency added; no credential, secret or production variable touched; the supersede guard uses the checkout's existing read
  access and never prints it.
- Intentional test changes for owner review: `SPLIT_PROFILES` (parts must equal the former lists), the new topology assertions, the
  workspace rule (only `certification-build` may persist `flofi-build`), the Cloud Build count 55 → 58 profiles, and new tests for the
  artifact, the supersede guard, the balancer, the timings tool and the candidate baselines.

## 7. Phase 5 — validation and results

### 7.1 Local validation (pinned Node 24.21.0, pnpm 11.22.0; evidence, not certification)

| Check | Result |
| --- | --- |
| `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` | 282 tests OK (38 new or changed for this build) |
| `test_governance_lite.py`, `governance_lite.py`, `agent_guard.py check`, `git diff --check`, eslint of the runner and Playwright config | PASS |
| CircleCI `validate_config` on the exact final file | valid |
| Unit job flow in a clean worktree (no `.next`; packages built by turbo) | 704 files / 9,179 tests passed, 2 env-gated skips (pre-existing); result guard PASS (122 required suites); 430 s |
| Build artifact | pack 0.9 s, unpack 0.9 s (166 MiB, 3,780 entries); `.next/server` byte-identical after the round trip; second unpack refused |
| Split browser parts, from the unpacked artifact in a clean worktree | `execution-continuity-1/2/3`: 12 + 16 + 10 = 38/38 (the former profile's 38); `default-product-2`: 92/92; `default-product-1`: 78 passed, 9 failed — the same 9 fail when their five spec files run without any split (7 local screenshot differences, the known local/CI rendering difference, and 2 `build009` bridge quotes this sandbox's network blocks) |
| Candidate baselines | real Playwright: `visual-shell.spec.ts` wrote its 3 screenshots into the candidate directory (`e2e/` layout); checkout unchanged |
| Two CPUs (`taskset`) | `review-execute-recovery-components` +13.2%, `approve-workflow-run` +0.8%, `flight` +15.6% |

### 7.2 Ledger refusals (the real `ci-observe.py verify` on a complete synthetic ledger of the real plan, then one mutation each)

| Case | Result |
| --- | --- |
| Complete | PASS (18 required stages over 11 jobs, 58 browser profiles each exactly once, all for the revision) |
| Profile missing (`default-product-2` never ran) | FAIL: `extended browser profiles never ran: default-product-2` |
| Profile duplicated (`execution-continuity-1` twice) | FAIL: `unplanned or repeated: execution-continuity-1` |
| Browser run cancelled (report left `RUNNING`) | FAIL: `browser run composition did not pass: RUNNING` |
| Browser run superseded | FAIL: `browser run extended-shard-3-of-8 did not pass: SUPERSEDED` |
| Browser report of another SHA | FAIL: `belongs to revision 'ddd…', not ccc…` and its profiles `never ran` |
| Stage cancelled/interrupted, stage superseded (exit 75), stage of another SHA, required stage missing | FAIL each, naming the stage |

### 7.3 CircleCI: first run of the new topology (pipeline `a0752ae4`, revision `c6febbc`, cold archive cache)

| Job | Runner | Seconds | Ends after pipeline start | Credits |
| --- | --- | ---: | ---: | ---: |
| governance | small | 84.5 | 1.5 min | 7.0 |
| certification-build | large | 203.4 | 3.4 min | 67.8 |
| certification-unit | large | 611.2 | 11.7 min | 203.7 |
| certification-browser-1 … -8 | medium | 526.8 – 618.7 (mean 574.6) | 12.3 – 13.8 min | 87.8 – 103.1 (766.2 in all) |
| certification-checks | large | 53.1 | stopped by the advisory (§7.5) | 17.7 |

- **All eight browser jobs passed on medium on the first attempt**: 58 profiles, every one PASS. Memory peaked at 2.39–3.20 GiB of 4 GiB
  (56–74%), CPU averaged 0.85–1.47 of 2 cores. Profiles ran a median 10.6% slower than their large-runner medians (×0.92 – ×1.47); the
  local two-CPU estimate was 1–16%.
- Build job: spin-up 11.4 s (no database), governance-lite 7.0 s, install 9.4 s, production build 150.2 s, pack 1.6 s, persist 7.8 s;
  memory peak 4.6 GiB of 8. Each browser job then attached the workspace in 2.4–2.9 s and verified and unpacked the build in 2.1–2.7 s
  instead of building for ~150 s.
- Unit job: package build 30.4 s, unit suite 547.7 s (main's last run: 548.8 s), 3.68 of 4 cores — CPU-bound, so it stays on large.
- The supersede guard read the branch head from CircleCI (`Supersede check: claude/hopeful-hypatia-9gjxig still points to this revision
  (c6febbc9f87e)`); the image's Python is 3.12.3 (tarfile `data` filter present).
- Cold cache: the first pipeline of the branch missed the archive cache (Node, pnpm, anvil, headless shell downloaded and verified):
  toolchain 6.7–8.6 s, anvil 3.6–4.2 s, headless shell 2.5–3.7 s.

**Wall clock: 13.8 min to the last job** (the fan-in adds ~15 s): **−58%** against the 32.7-min mean. Measured credits 1,062 with the
checks job stopped early; with its typecheck, lint, PostgreSQL and fork stages (audited means: ~600 s on large, ~200 credits) and the
small supply-chain job (~60 s, ~5 credits) the complete certification comes to **~1,250 credits (−28.5%)**.

After this run the timings were refreshed from its own medium reports (`scripts/ci_timings.py`): the eight shards went from a measured
478–531 s to an estimated 501–502 s each.

### 7.4 CircleCI: second run (warm cache, rebalanced shards, supply-chain job)

Pending: results are added when the run completes.

### 7.5 Blocker outside this build: GHSA-fc5q-39xc-vjpf (picomatch ≤ 4.0.7, high)

The dependency policy now blocks `picomatch@4.0.7` (ReDoS; dev-tooling paths through `typescript-eslint` → `tinyglobby`/`fdir`). The
advisory names `>= 4.0.8` as patched, but npm's latest release is 4.0.7 and every 3.x release is in the vulnerable range, so no
compliant version exists yet. By the owner's policy (DEC-0057) advisories block and cannot be excepted, so **no revision of any branch,
`main` included, can certify until upstream publishes 4.0.8**. This build does not touch the policy or the lockfile. Because the
supply-chain gates now run in their own job, every other job still reports its results while the advisory stands; `certification`
stays blocked, as it must.

### 7.6 Before / after

| Metric | Before (10 green runs) | After (first run; complete-run projection) | Change |
| --- | ---: | ---: | ---: |
| Wall clock | 32.7 min mean, 35.9 max | 13.8 min to the last job (~14.1 with the fan-in) | −57% |
| Critical path | `certification-checks` 31.1 min | `certification-browser-2` 10.3 min after a 3.4-min build | |
| Runner compute | 87.1 large-min | ~62.5 large-min equivalent (browser jobs at half rate) | −28% |
| Credits | 1,749 | ~1,250 | −28.5% |
| Production builds per certification | 3 | 1 | −2 |
| Browser profiles | 55 + composition | 58 + composition (same specs, each once) | parts |
| Tests | unchanged | unchanged (every former spec and suite runs) | 0 |
| Superseded pipelines left running | 4 in the audit (216 large-min) | stopped by the guard (and the CircleCI setting, once enabled) | |

## 8. Rollback

See [docs/engineering/CI.md § Rollback](../engineering/CI.md#rollback).
