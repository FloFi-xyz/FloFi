#!/usr/bin/env bash
# BUILD-CI-GCP-002. Fail-closed manual certification mirror of CircleCI #105.
# No production accounts, keys, wallet RPCs or deployment.
set -euo pipefail

# CircleCI's cimg image runs unprivileged; Cloud Build's /workspace is root-owned.
root="$(mktemp -d /tmp/flofi-gcp-ci.XXXXXX)"
trap 'rm -rf "$root"' EXIT
# Do not preserve root ownership from Cloud Build's /workspace mount.
# The CircleCI image runs as an unprivileged user.
cp -R /workspace "$root/source"
cd "$root/source"
# Cloud Build normally provides an existing .git repository and origin.
# Fetch the exact triggering commit with its immediate parent if needed,
# without assuming that the checkout is a pristine source archive.
test -n "${FLOFI_SOURCE_SHA:-}" || { echo "Missing exact Cloud Build source SHA"; exit 1; }
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -q
fi
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin https://github.com/alrimarleskovar/FloFi.git
else
  git remote add origin https://github.com/alrimarleskovar/FloFi.git
fi
git fetch --quiet --depth=2 origin "$FLOFI_SOURCE_SHA"
test "$(git rev-parse FETCH_HEAD)" = "$FLOFI_SOURCE_SHA"
git checkout --detach -q FETCH_HEAD
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
# CircleCI sets CI=true and Cloud Build does not. Without it Vitest accepts `.only` and writes missing snapshots instead of failing.
export CI=true
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
  original_status=$?
  trap - EXIT
  kill "$pg_proxy_pid" 2>/dev/null || true
  # CircleCI's on_fail step: make a screenshot failure diagnosable from the log before the workspace is deleted.
  if [ "$original_status" -ne 0 ]; then python3 scripts/summarize-screenshot-diffs.py apps/reference-dapp/test-results || true; fi
  python3 scripts/ci-observe.py summary || true
  rm -rf "$root"
  exit "$original_status"
}
trap cleanup EXIT
# The proxy accepts connections even when PostgreSQL is down: require PostgreSQL's own answer to an SSLRequest through it.
pg_answers() {
  node -e "const s=require('node:net').connect(5432,'127.0.0.1');s.setTimeout(2000,()=>process.exit(1));s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(1));s.on('connect',()=>s.write(Buffer.from([0,0,0,8,4,210,22,47])));s.on('data',d=>process.exit(d[0]===78||d[0]===83?0:1))"
}
for attempt in $(seq 1 60); do
  if pg_answers; then break; fi
  if ! kill -0 "$pg_proxy_pid" 2>/dev/null; then echo 'PostgreSQL proxy stopped'; exit 1; fi
  sleep 1
done
pg_answers || { echo 'PostgreSQL unavailable through the proxy'; exit 1; }

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
