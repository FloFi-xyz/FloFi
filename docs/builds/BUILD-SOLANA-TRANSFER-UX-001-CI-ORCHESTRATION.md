# Cloud certification orchestration — ready, not submitted

This change fixes collection and ordering in the next authorized source-snapshot run. The last remote certification remains **FAILURE** (`609a0156-d8b5-4afc-bac7-82ca65715638`). No further Cloud Build was submitted, and no full local certification or new product audit ran.

Execution order:

1. Pinned disposable PostgreSQL, exact uploaded-source verification, governance/CI self-tests and governance controls.
2. Toolchain bootstrap/identity, frozen install, dependency integrity/license/age, vulnerability audit and SBOM.
3. Production build, pinned Anvil and browser bootstrap. These prerequisites remain fail-fast.
4. All six critical browser profiles, starting with `copilot-learning`.
5. All 38 extended profiles, sequentially through both existing groups.
6. Composition setup, the three existing serial fork tests, then the composition browser profile. A fork-test failure is retained while the browser profile still runs; failed prerequisite setup stops this stage.
7. Typecheck, lint, schema drift, complete units/contracts (exclusive PNG worker, then two workers), complete PostgreSQL, then Anvil/offline forks.
8. Strict final certification ledger, followed by the existing timing/resource summary and cleanup.

`gcp-ci-certify.sh` collects stage exit statuses through fresh child Bash processes. This preserves `errexit` inside a stage: a later command cannot conceal an earlier failure. `--collect-failures` makes the guarded browser runner attempt every independent profile in the selected group and retain every individual result, exit code, timing, JUnit file and artifact directory. Ordinary callers retain their existing fail-fast behavior.

Cloud disables automatic diagnostic trace reruns to spend the fixed time budget on untouched profiles. This does not enable retries or change assertions; original failures stay failed. Screenshots, error context, JUnit and timing reports remain enabled. The ledger still requires all **18 stages** successful and all **45 browser profiles** passed exactly once. Missing, failed, incomplete, repeated or unplanned evidence fails certification. An aggregate stage failure also fails the overall command independently of the ledger result.

One attempt can therefore collect failures across all browser groups instead of stopping at the first profile. Required setup must succeed, and the existing 10,800-second whole-build limit still applies. The dedicated service account, default-pool `E2_STANDARD_2`, sequential workloads, single browser worker, disposable PostgreSQL, synthetic/loopback transports and wallet security assertions are preserved. Composition uses the exact existing pinned setup; a regression check requires it to stay identical to the shared CI setup.

Validation:

- **54/54 CI self-tests passed** (11.519s), including real runner/collector/ledger execution with lightweight workload doubles. Injected failures in learning, default-product, approve-authorize and composition fork tests still attempted all 45 browser profiles and reached a failed ledger. Separate checks retain non-browser failures and prove that later successful commands cannot mask them. This is orchestration validation, not full application certification.
- **19/19 governance self-tests passed** (1.147s); existing fail-fast governance assertions remain unchanged.
- Shell syntax, JavaScript syntax, targeted ESLint and whitespace checks passed.
- The existing 60-second learning test passed **5/5 fresh guarded-profile invocations**, each with one browser worker and CPU affinity `0,1` inherited by the browser, app and harness processes. Each invocation created/dropped its own test database on pinned loopback-only disposable PostgreSQL. Test durations: 16.4s, 16.3s, 15.2s, 17.3s, 15.3s. Complete invocation times: 25.86s, 24.44s, 22.95s, 25.20s, 23.12s. No additional learning-test edits, retries, or weakened assertions. Local CPU affinity matches Cloud concurrency; it does not reproduce identical VM speed.

Local evidence: `/tmp/flofi-ci-orchestration-selftests-20261020.log`, `/tmp/flofi-ci-orchestration-governance-20261020.log`, `/tmp/flofi-ci-learning-repeat-20261020/results.json` and the five adjacent `run-*/browser.log` files. The disposable local PostgreSQL container was stopped and removed after validation.

The previous source manifest remains the historical submitted snapshot. Regenerate it only when preparing a newly authorized submission. No push, PR, deployment, billing change, production database access or public broadcast occurred. Fresh explicit authorization is required before another Cloud Build submission.
