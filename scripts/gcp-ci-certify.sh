#!/usr/bin/env bash
# Cloud Build's independent certification stages, after verified setup and build.
# Run one workload at a time on E2_STANDARD_2. Every failure survives the fan-in.
set -euo pipefail

failed_stages=()
run_required() {
  local label="$1" status=0
  shift
  "$@" || status=$?
  if [ "$status" -ne 0 ]; then
    failed_stages+=("$label (exit $status)")
    printf 'Required stage FAILED: %s (exit %s); continuing independent stages\n' "$label" "$status" >&2
  fi
}
run_stage() {
  # A fresh Bash is essential: putting a shell function in an ||/if condition
  # disables errexit throughout it and could conceal failures inside a stage.
  run_required "$1" bash -euo pipefail -c 'source scripts/ci-observe.sh "$1"; source /dev/stdin' gcp-ci-stage "$1"
}

# Keep screenshots, error context, JUnit and per-profile results. Automatic trace
# reruns would delay untouched profiles and consume the fixed 180-minute budget.
export FLOFI_BROWSER_FAILURE_TRACE=off

run_stage 'Critical browser regressions' <<'STAGE'
node scripts/guarded-release-browser.mjs critical --collect-failures
STAGE
run_stage 'Guarded browser suites' <<'STAGE'
browser_status=0
node scripts/guarded-release-browser.mjs extended --shard 1/2 --collect-failures || browser_status=$?
node scripts/guarded-release-browser.mjs extended --shard 2/2 --collect-failures || browser_status=$?
exit "$browser_status"
STAGE

run_required 'Composition fork and browser' bash scripts/gcp-ci-composition.sh

run_stage 'Typecheck' <<'STAGE'
pnpm typecheck
STAGE

run_stage 'Lint' <<'STAGE'
pnpm lint
pnpm exec eslint scripts/guarded-release-browser.mjs
STAGE

run_stage 'Schema drift' <<'STAGE'
pnpm schemas:check
STAGE

run_stage 'Unit and contract tests' <<'STAGE'
# PNG rasterization is CPU-intensive. On the 2-vCPU Cloud Build worker,
# four concurrent Vitest workers can starve the 120-second render test.
# Run that exact spec first with an exclusive worker, then the rest of the
# unchanged unit inventory with two workers. No tests are skipped.
png_spec=apps/reference-dapp/src/server/workflow-visual-image.test.ts
pnpm exec vitest run "$png_spec" --maxWorkers=1 --testTimeout=30000
pnpm exec vitest run packages apps/reference-dapp/src apps/reference-dapp/backend \
  --exclude '**/*.fork.test.ts' \
  --exclude '**/*.pg.test.ts' \
  --exclude '**/*.live.test.ts' \
  --exclude '**/*.remote.test.ts' \
  --exclude "$png_spec" \
  --maxWorkers=2 --testTimeout=30000
python3 scripts/summarize-screenshot-diffs.py --self-test
test -f packages/reference-linter/dist/index.js
test -f packages/reference-linter/dist/index.d.ts
pnpm --filter @defi-workflow-engine/reference-linter exec node --input-type=module -e "const m = await import('@defi-workflow-engine/reference-linter'); for (const key of ['lintWorkflow','validateAuthoringWorkflow','createReviewContext','digestArtifact','digestRawResponse','digestSelfCheck','reviewMockedArtifactChain','mockedSwapOutputs','mockedFixtureBytes','collectBaseTranscript','deriveBaseObservation','reviewBaseObservation']) if (typeof m[key] !== 'function') throw new Error('Missing linter export: '+key); if (!Object.isFrozen(m.MOCKED_CHAIN_PROFILE)) throw new Error('Mocked chain profile must be frozen'); if (!Object.isFrozen(m.BASE_OBSERVATION_PROFILE)) throw new Error('BASE_OBSERVATION_PROFILE must be frozen'); await m.digestSelfCheck()"
STAGE

run_stage 'PostgreSQL' <<'STAGE'
pnpm test:postgres
STAGE

run_required 'Anvil and offline forks' bash .circleci/scripts/ci-fork.sh

# Always reach the strict fan-in after independent stages, even if they failed.
# Missing, incomplete, failed, repeated or unplanned profiles remain failures.
run_required 'Certification ledger' python3 scripts/ci-observe.py verify
if [ "${#failed_stages[@]}" -ne 0 ]; then
  printf 'Cloud certification: FAIL\n' >&2
  printf '  %s\n' "${failed_stages[@]}" >&2
  exit 1
fi
printf 'Cloud certification: PASS\n'
