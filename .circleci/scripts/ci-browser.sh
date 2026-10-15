#!/usr/bin/env bash
# Exact CircleCI backup copy of the approved GitHub Actions certification command.
# Keep aligned with .github/workflows/contracts.yml; fail closed on any error.
set -euo pipefail
source scripts/ci-observe.sh 'Guarded browser suites'
export BUILD002_BROWSER_CACHE="$RUNNER_TEMP/gryloo-playwright/chromium_headless_shell-1243"
# BUILD-003F: the browser suite drives the MOCKED synthetic local fork on loopback chain 31337.
export GRYLOO_ANVIL_BIN="$RUNNER_TEMP/gryloo-anvil/foundry-v1.8.3/anvil"
export GRYLOO_MODE_A_RUNTIME="$RUNNER_TEMP/gryloo-mode-a-e2e"
# Approved production Review rejects MOCKED financial authority. Run the current
# product paths and explicit provenance boundaries in the same profiles as local verification.
# Positive local financial lifecycle/recovery remains enforced by pnpm test, PostgreSQL
# and the pinned offline fork gates above; historical browser diagnostics remain intact.
export GRYLOO_COW_RUNTIME="$RUNNER_TEMP/gryloo-cow-e2e"
node scripts/guarded-release-browser.mjs product
pnpm --filter @defi-workflow-engine/reference-dapp exec playwright test mcp-route-presentation.spec.ts
# BUILD-DEVELOPER-001: a third-party server integrates with the SDK alone (operator CLI key, strategy, approval, signed loopback
# webhooks) and the end user reaches FloFi's Review, where MOCKED financial authority stays blocked (no wallet transaction), on the
# same embedded loopback harness (no public network, no real transaction). The full lifecycle is proven by journey.pg.test.ts.
GRYLOO_MCP_E2E=EMBEDDED_LOOPBACK_ONLY TEST_DATABASE_URL="postgres://flofi@127.0.0.1:5432/postgres" pnpm --filter @defi-workflow-engine/reference-dapp exec playwright test developer-journey.spec.ts
# BUILD-MCP-002: consumer OAuth and in-chat approval on disposable loopback infrastructure.
GRYLOO_MCP_E2E=EMBEDDED_LOOPBACK_ONLY TEST_DATABASE_URL="postgres://flofi@127.0.0.1:5432/postgres" pnpm --filter @defi-workflow-engine/reference-dapp exec playwright test mcp-in-chat.spec.ts mcp-route-presentation.spec.ts
# Each invocation gets a fresh disposable database; keep the production OAuth registration rate limit intact.
GRYLOO_MCP_E2E=EMBEDDED_LOOPBACK_ONLY TEST_DATABASE_URL="postgres://flofi@127.0.0.1:5432/postgres" pnpm --filter @defi-workflow-engine/reference-dapp exec playwright test channel-signing.spec.ts
# BUILD-CHANNELS-001: the channels' /approve paths on the same embedded loopback harness — WhatsApp with the FIXTURE provider (nothing
# is sent to Meta) and Telegram against the loopback Bot API double (nothing reaches Telegram): the real webhook routes, the
# intended-wallet rule, the owner's Review where MOCKED authority stays blocked, the status ping and the scheduled dispatch.
GRYLOO_MCP_E2E=EMBEDDED_LOOPBACK_ONLY GRYLOO_CHANNEL_E2E=FIXTURE_LOOPBACK_ONLY TEST_DATABASE_URL="postgres://flofi@127.0.0.1:5432/postgres" pnpm --filter @defi-workflow-engine/reference-dapp exec playwright test whatsapp-approve.spec.ts telegram-approve.spec.ts
# BUILD-007: only official digest-pinned test-time artifacts are downloaded, outside Git.
export GRYLOO_B007_INPUTS="$RUNNER_TEMP/gryloo-build-007-inputs"
mkdir -p "$GRYLOO_B007_INPUTS"
python3 - <<'PYCODE'
import hashlib, os, pathlib, re, tarfile, urllib.request
root=pathlib.Path(os.environ['GRYLOO_B007_INPUTS'])
# Roles mastercopies: upstream removed this file from main in d50a1b2 (2026-10-15); fetch the exact bytes from the commit that last changed it (1ddde84db902), digest unchanged.
sources={
  'safe':('https://registry.npmjs.org/@safe-global/safe-contracts/-/safe-contracts-1.4.1.tgz','8803f7cf26e2c58300b8136342faa7b8bce59436e300f52115fa25b095e0bf79'),
  'roles':('https://raw.githubusercontent.com/gnosisguild/zodiac-modifier-roles/1ddde84db9024c6c1898d1f4cf5dabded3e824f1/packages/evm/mastercopies.json','a80d737a2b5394897fad0aa290b129bc446fdb1736efc3e1ad06edcd2d8ea224'),
}
for name,(url,expected) in sources.items():
  raw=urllib.request.urlopen(url,timeout=60).read()
  if hashlib.sha256(raw).hexdigest()!=expected: raise SystemExit('BUILD-007 official artifact digest changed: '+name)
  (root/({'safe':'safe.tgz','roles':'roles-mastercopies.json'}[name])).write_bytes(raw)
with tarfile.open(root/'safe.tgz','r:gz') as archive:
  archive.extractall(root/'safe',filter='data')
source=urllib.request.urlopen('https://raw.githubusercontent.com/ethereum/ercs/master/ERCS/erc-2470.md',timeout=60).read().decode()
matches=[bytes.fromhex(value[2:]) for value in re.findall(r'0x[0-9a-fA-F]{680}',source)]
init=next((value for value in matches if hashlib.sha256(value).hexdigest()=='dae33ba7a8745a325d78fd9dbf4585b47524070f5c8b73c84bf373e91a24fff6'),None)
if init is None or len(init)!=340: raise SystemExit('BUILD-007 ERC-2470 initcode pin changed')
(root/'erc2470-initcode.bin').write_bytes(init)
PYCODE
# The disposable executor key must stay under /tmp/ (enforced by the harness and the composition service);
# it is a few small files and is removed when this step exits so the persistent runner's tmpfs does not fill.
export GRYLOO_MODE_B_RUNTIME="/tmp/gryloo-b007-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
export GRYLOO_MODE_B_SAFE_PACKAGE="$GRYLOO_B007_INPUTS/safe/package"
export GRYLOO_MODE_B_ROLES_MASTERCOPIES="$GRYLOO_B007_INPUTS/roles-mastercopies.json"
export GRYLOO_MODE_B_EIP2470_INITCODE="$GRYLOO_B007_INPUTS/erc2470-initcode.bin"
export GRYLOO_COMPOSITION_INTERIM_TRANSCRIPT_PATH="$PWD/apps/reference-dapp/e2e/fork/composition-transcript.json"
export GRYLOO_COMPOSITION_INTERIM_TRANSCRIPT_SHA256="$(sha256sum "$GRYLOO_COMPOSITION_INTERIM_TRANSCRIPT_PATH" | cut -d' ' -f1)"
node apps/reference-dapp/e2e/fork/composition-harness.mjs serve > "$RUNNER_TEMP/gryloo-b007-harness.log" 2>&1 &
b007_pid=$!
flofi_ci_cleanup() {
  kill "$b007_pid" 2>/dev/null || true
  rm -rf "$GRYLOO_MODE_B_RUNTIME"
}
for attempt in $(seq 1 120); do
  if [ -s "$GRYLOO_MODE_B_RUNTIME/profile.json" ] && [ -s "$GRYLOO_MODE_B_RUNTIME/mode-b-keys.json" ]; then break; fi
  if ! kill -0 "$b007_pid" 2>/dev/null; then cat "$RUNNER_TEMP/gryloo-b007-harness.log"; exit 1; fi
  sleep 1
done
test -s "$GRYLOO_MODE_B_RUNTIME/profile.json"
export GRYLOO_COMPOSITION_PROFILE="$GRYLOO_MODE_B_RUNTIME/profile.json"
export GRYLOO_COMPOSITION_EXECUTOR_KEY_FILE="$GRYLOO_MODE_B_RUNTIME/mode-b-keys.json"
export GRYLOO_COMPOSITION_SMOKE_PROFILE="$GRYLOO_COMPOSITION_PROFILE"
export GRYLOO_COMPOSITION_MODE=fork
# The three files share one Anvil fork; the compiler file temporarily replaces Position Manager code inside a
# snapshot, so the reconciler's code-identity read must not run concurrently with it.
pnpm exec vitest run packages/reference-compiler/test/composition.fork.test.ts packages/reference-executor/test/composition.fork.test.ts packages/reference-reconciler/test/composition.fork.test.ts --no-file-parallelism --testTimeout=120000
node scripts/guarded-release-browser.mjs composition
