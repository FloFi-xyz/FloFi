#!/usr/bin/env bash
# BUILD-CI-GCP-002. Fail-closed manual certification mirror of CircleCI #105.
# No production accounts, keys, wallet RPCs or deployment.
set -euo pipefail

# CircleCI's cimg image runs unprivileged; Cloud Build's /workspace is root-owned.
root="$(mktemp -d /tmp/flofi-gcp-ci.XXXXXX)"
trap 'rm -rf "$root"' EXIT
cp -a /workspace "$root/source"
cd "$root/source"
export RUNNER_TEMP="$root/temp"
export FLOFI_CI_ARCHIVE_CACHE="$RUNNER_TEMP/archives"
export GITHUB_PATH="$RUNNER_TEMP/github-path"
export GITHUB_ENV="$RUNNER_TEMP/github-env"
export GITHUB_STEP_SUMMARY="$RUNNER_TEMP/summary.md"
export GITHUB_RUN_ID="gcp"
export GITHUB_RUN_ATTEMPT="1"
export TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
export COREPACK_ENABLE_AUTO_PIN=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PYTHONDONTWRITEBYTECODE=1 FLOFI_E2E_APP_PORT=3100
export TEST_DATABASE_URL='postgres://flofi@127.0.0.1:5432/postgres'
mkdir -p "$RUNNER_TEMP" "$FLOFI_CI_ARCHIVE_CACHE"
touch "$GITHUB_PATH" "$GITHUB_ENV" "$GITHUB_STEP_SUMMARY"

# Cloud Build's containers have their own loopback. Bind a local TCP proxy to
# the PostgreSQL sidecar on the private Cloud Build Docker network.
cat > "$RUNNER_TEMP/pg-proxy.cjs" <<'NODE'
const net = require('node:net');
const server = net.createServer(client => {
  const upstream = net.connect(5432, 'flofi-gcp-postgres');
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
server.listen(5432, '127.0.0.1');
NODE
node "$RUNNER_TEMP/pg-proxy.cjs" &
pg_proxy_pid=$!
cleanup() {
  kill "$pg_proxy_pid" 2>/dev/null || true
  python3 scripts/ci-observe.py summary || true
}
trap cleanup EXIT
for attempt in $(seq 1 60); do
  if (echo >/dev/tcp/127.0.0.1/5432) >/dev/null 2>&1; then break; fi
  if ! kill -0 "$pg_proxy_pid" 2>/dev/null; then echo 'PostgreSQL proxy stopped'; exit 1; fi
  sleep 1
done
(echo >/dev/tcp/127.0.0.1/5432) >/dev/null 2>&1 || { echo 'PostgreSQL proxy unavailable'; exit 1; }

# Governance is required even if the rest of the suite is subsequently red.
python3 -m unittest discover -s scripts -p 'test_governance_lite.py'
python3 -m unittest discover -s scripts -p 'test_ci_*.py'
export GOVERNANCE_BRANCH="${BRANCH_NAME:-build/ci-gcp-002-full-cert}" GOVERNANCE_EVENT=push
python3 scripts/governance_lite.py
git diff --check
git diff --check HEAD^1 HEAD

(
  source scripts/ci-observe.sh 'Toolchain bootstrap'
  python3 scripts/bootstrap-ci.py
)
toolbin="$(tail -n 1 "$GITHUB_PATH")"
test -x "$toolbin/node"
test -x "$toolbin/pnpm"
export PATH="$toolbin:$PATH"
(
  source scripts/ci-observe.sh 'Toolchain identity'
  test "$(node --version)" = v24.21.0
  test "$(pnpm --version)" = 11.22.0
  git --version
  python3 --version
)
(
  source scripts/ci-observe.sh 'Frozen dependency install'
  pnpm install --frozen-lockfile --ignore-scripts
)
(
  source scripts/ci-observe.sh 'Dependency integrity license and age'
  python3 scripts/bootstrap-ci.py --verify-dependencies
)
(
  source scripts/ci-observe.sh 'Dependency audit'
  pnpm audit --audit-level low
)
bash .circleci/scripts/ci-sbom.sh
(
  source scripts/ci-observe.sh Typecheck
  pnpm typecheck
)
(
  source scripts/ci-observe.sh Lint
  pnpm lint
  pnpm exec eslint scripts/guarded-release-browser.mjs
)
(
  source scripts/ci-observe.sh 'Production build'
  pnpm build
)
(
  source scripts/ci-observe.sh 'Schema drift'
  pnpm schemas:check
)
(
  source scripts/ci-observe.sh 'Unit and contract tests'
  pnpm test
  python3 scripts/summarize-screenshot-diffs.py --self-test
  test -f packages/reference-linter/dist/index.js
  test -f packages/reference-linter/dist/index.d.ts
  pnpm --filter @defi-workflow-engine/reference-linter exec node --input-type=module -e "const m = await import('@defi-workflow-engine/reference-linter'); for (const key of ['lintWorkflow','validateAuthoringWorkflow','createReviewContext','digestArtifact','digestRawResponse','digestSelfCheck','reviewMockedArtifactChain','mockedSwapOutputs','mockedFixtureBytes','collectBaseTranscript','deriveBaseObservation','reviewBaseObservation']) if (typeof m[key] !== 'function') throw new Error('Missing linter export: '+key); if (!Object.isFrozen(m.MOCKED_CHAIN_PROFILE)) throw new Error('Mocked chain profile must be frozen'); if (!Object.isFrozen(m.BASE_OBSERVATION_PROFILE)) throw new Error('BASE_OBSERVATION_PROFILE must be frozen'); await m.digestSelfCheck()"
)
(
  source scripts/ci-observe.sh PostgreSQL
  pnpm test:postgres
)
(
  source scripts/ci-observe.sh 'Anvil bootstrap'
  python3 scripts/bootstrap-anvil.py "$RUNNER_TEMP/gryloo-anvil/foundry-v1.8.3"
)
bash .circleci/scripts/ci-fork.sh
(
  source scripts/ci-observe.sh 'Browser bootstrap'
  export BUILD002_BROWSER_CACHE="$RUNNER_TEMP/gryloo-playwright/chromium_headless_shell-1243"
  python3 scripts/bootstrap-playwright.py "$BUILD002_BROWSER_CACHE"
)
export BUILD002_BROWSER_CACHE="$RUNNER_TEMP/gryloo-playwright/chromium_headless_shell-1243"
export GRYLOO_ANVIL_BIN="$RUNNER_TEMP/gryloo-anvil/foundry-v1.8.3/anvil"
export GRYLOO_MODE_A_RUNTIME="$RUNNER_TEMP/gryloo-mode-a-e2e"
export GRYLOO_COW_RUNTIME="$RUNNER_TEMP/gryloo-cow-e2e"
(
  source scripts/ci-observe.sh 'Critical browser regressions'
  node scripts/guarded-release-browser.mjs critical
)
(
  source scripts/ci-observe.sh 'Guarded browser suites'
  node scripts/guarded-release-browser.mjs extended --shard 1/2
  node scripts/guarded-release-browser.mjs extended --shard 2/2
)
bash .circleci/scripts/ci-composition.sh

# Strict fan-in; omitted/repeated tests are FAIL, not green.
python3 scripts/ci-observe.py verify
python3 scripts/ci-observe.py summary
