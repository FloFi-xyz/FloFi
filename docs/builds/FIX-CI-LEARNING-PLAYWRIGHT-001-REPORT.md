# FIX-CI-LEARNING-PLAYWRIGHT-001 — learning spec race, parallel certification, Playwright diagnostics

Base `65c929e` (main after PR #104). CI and test-only: no product code, production configuration, deployment, database or financial
capability changes. Certification keeps every suite; nothing is skipped, retried into a pass or mocked away.

## 1. Root cause of main's failure

`copilot-learning-memory.spec.ts:129` asserted one remaining `learning_subjects` row after **Delete everything** ("B's own row only").

- Wallet B never has a subject. Proving B and reading its Privacy & memory page use `subjectFor(…, create = false)`. B's chat turn cannot
  observe anything, because automatic learning is not permitted for B under the consent basis. A read never stores anything.
- `store.erase()` deletes A's subject; `learning_memories`, `learning_evidence` and `learning_automatic_settings` cascade (0013/0014 FKs).
  The correct count after deletion is **0**. The deletion logic is right and unchanged.
- The assertion passed on PR #104 only because it **raced** the erase. The spec waited for "FloFi keeps no meanings for this wallet.",
  but that text was already visible before the click (learning had just been turned off). So the query ran before the erase committed
  and still saw A's row. On main's run the erase won the race (0 rows).
- Proven locally: with `store.erase()` turned into a no-op, the **old spec still passed** while the new spec failed at the post-erase wait.

The fix waits for a signal that only appears after the erase: the consent-dependent "Use my saved meanings" switch disappears and the
two-step button returns. Only then does it assert that nothing personal remains: subjects, memories, evidence, settings and contributor
support are all 0. Wallet isolation is now explicit: A's subject is captured at consent, and after B proves, reads and chats, A's subject
is still the only one. Before deletion, A's subject and its recorded "off" choice are shown to survive turning learning off. The reviewed
glossary stays published.

## 2. Certification structure

Baseline (CircleCI `large`, one sequential job after governance): green workflows **2,416 s** (job 53) and **2,377 s** (job 55),
created → stopped; main's failing run reported the learning regression after **1,630 s** (job 57, 27m10s), behind about 12 minutes
of install, typecheck, lint, build, units, PostgreSQL and forks, and 12 earlier browser profiles.

CircleCI now fans out after `governance` into three parallel `large` jobs, each in its own container with its own loopback ports,
disposable PostgreSQL and production build:

| Job | Contents |
| --- | --- |
| `certification-checks` | registry integrity/licence/age, audit, SBOM, typecheck, lint, schema drift, unit + exported API checks, PostgreSQL, anvil + offline forks |
| `certification-browser-1` | build, then **critical** profiles first, then guarded browser part 1/2 |
| `certification-browser-2` | build, guarded browser part 2/2 (with the MCP, developer and channel suites), BUILD-007 composition fork + browser |
| `certification` (fan-in, `small`) | requires all three; `ci-observe.py verify` checks that every required stage and every planned browser profile passed, each profile exactly once |

The required status `ci/circleci: certification` keeps its name. It is reported only when all three jobs passed and the ledger is
complete. If any job fails, it never runs, so a merge stays blocked. GitHub Actions (disabled, kept at parity) runs the same commands in
one job in fail-fast order: build → **critical** → units → PostgreSQL → forks → the remaining browser profiles → composition → SBOM →
ledger. `scripts/test_ci_optimization.py` keeps both at equal coverage. It checks that every mandatory gate is unconditional in both
systems, that the CircleCI scripts are exact copies of the Actions steps, that each browser profile runs exactly once per system, and
that critical runs before the slow suites.

Critical tier (`node scripts/guarded-release-browser.mjs critical`): `copilot-learning` (learning and wallet isolation), `canvas-corrections`
(Canvas basics), `solana-wallet-refusal` (P0 reviewed-bytes refusal), `supply-provenance` (MOCKED never authorizes) and
`review-execute-recovery-components` (Simulate/Review/Execute). It takes about 3.5 min on CircleCI (168 s locally).

## 3. Playwright and runner improvements

- One plan, validated at start-up (`critical`, `extended [--shard n/2]`, `product` = both, `composition`, `profile <name>`, `list`): every
  product profile is placed exactly once or the runner refuses to start. `profile <name>` reproduces one CI profile locally.
- The five MCP/developer/channel Playwright commands are profiles of the same runner now (same specs and harness settings), with timing,
  reports and failure handling. The two `mcp-route-presentation.spec.ts` runs are **not** duplicates: OAuth disabled vs enabled.
- Per-profile `--output` (a later profile no longer wipes earlier artifacts), per-profile JUnit (`store_test_results`; the profile name is in
  the class name, as one spec runs in ten profiles), and `screenshot: 'only-on-failure'` in the CI configs.
- An actionable failure block: profile, phase, exit code, specs, settings (database URL redacted), artifact paths, a reproduce command, and
  the profiles that never ran (never counted as passes). Exit codes are preserved.
- Failure traces without slowing green runs: recording traces on every run costs **+26%** (76 s → 97 s, twice each, Review/Execute profile).
  Instead, after a profile has failed, only its failed tests are re-run once with `--trace on` into `<profile>-trace/`. That run never
  reaches JUnit or the result. If it passes, the log says the failure is intermittent and the profile stays FAILED.
- Profile timing tables (slowest first) per run and per job (`ci-observe.py summary`), and JSON reports for the ledger and artifacts.
- Not changed, deliberately: `workers: 1`, `retries: 0`, shared per-profile harnesses, deterministic replay, loopback-only infrastructure.
  Web-server start-up measured ~3 s per profile locally and `pnpm exec` 0.5 s, so changing harness start-up would gain under a minute.
  Parallelism comes only from separate containers.

## 4. Validation

| Check | Result |
| --- | --- |
| `copilot-learning` before the fix, local | passed (raced: query before erase) |
| `copilot-learning` after the fix, 4 separate runs + through the runner | 5/5 passed |
| Mutation: erase made a no-op | old spec **passed**; new spec failed at the post-erase wait |
| `critical` phase, private network namespace (no internet), disposable PostgreSQL | 5/5 profiles PASS, 168 s |
| Browser part 2/2, same namespace (incl. the five former MCP/developer/channel commands) | 18/18 profiles PASS, 656 s |
| Browser part 1/2 except `default-product`, same namespace | 17/17 profiles PASS, 267 s |
| Test count of every locally run profile (40 of 41) vs main's CircleCI job 55 | identical (MCP group 11/1/21/6/2) |
| `test_ci_optimization.py` (40 tests) and 14 deliberate breakages | 40 pass; 14/14 breakages caught |
| `test_governance_lite.py`, `governance_lite.py`, eslint, app typecheck | pass |
| CircleCI certification (new structure) | see PR |

Not run locally: `default-product` (BUILD-009 requests a real read-only quote server-side) and the BUILD-007 composition step (digest-pinned
public downloads). Both are unchanged and run in CI. Local and mock evidence does not prove public execution.
