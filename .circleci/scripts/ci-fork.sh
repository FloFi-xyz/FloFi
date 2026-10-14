#!/usr/bin/env bash
# Exact CircleCI backup copy of the approved GitHub Actions certification command.
# Keep aligned with .github/workflows/contracts.yml; fail closed on any error.
set -euo pipefail
source scripts/ci-observe.sh 'Anvil and offline forks'
export GRYLOO_ANVIL_BIN="$RUNNER_TEMP/gryloo-anvil/foundry-v1.8.3/anvil"
# DEC-0026/DEC-0027: pure G1 checks run; owner-secret pinned-account cases are owner-only local F2 gates.
pnpm test:anvil
pnpm test:fork --testTimeout=30000
# BUILD-003F F1: five fresh-process synthetic rehearsals (MOCKED engineering evidence, loopback only).
node apps/reference-dapp/e2e/fork/offline-rehearsal.mjs > "$RUNNER_TEMP/build-003f-f1.json"
node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if (r.status!=='PASS'||r.passes.length!==5) process.exit(1); console.log('F1 five-pass', r.status, r.passes.map(p=>p.providerEquivalentRequests).join(','))" "$RUNNER_TEMP/build-003f-f1.json"
# BUILD-003F F4 static check: the committed transcript's structure, digests and identity, never its secret inputs.
if [ -f apps/reference-dapp/e2e/fork/base-fork-transcript.json ]; then
  node --input-type=module -e "import { readFileSync } from 'node:fs'; import { verifyTranscriptDocument } from './apps/reference-dapp/e2e/fork/replay-upstream.mjs'; import { transcriptIdentity } from './apps/reference-dapp/e2e/fork/harness.mjs'; const t = JSON.parse(readFileSync('apps/reference-dapp/e2e/fork/base-fork-transcript.json', 'utf8')); const counts = verifyTranscriptDocument(t, { accounts: t.identity.accounts }); if (transcriptIdentity({ sourceBlockNumber: t.sourceBlockNumber, sourceBlockHash: t.sourceBlockHash, accounts: t.identity.accounts }).identityHash !== t.identityHash) process.exit(1); console.log('Transcript verified', JSON.stringify(counts));"
fi
# BUILD-006: a distinct complete transcript is mandatory for the fork evidence gate.
# Static validation runs in CI without owner material, provider credentials or external RPC.
test -f apps/reference-dapp/e2e/fork/liquidity-transcript.json
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { verifyLiquidityTranscript } from './apps/reference-dapp/e2e/fork/liquidity-replay-upstream.mjs'; const t=JSON.parse(readFileSync('apps/reference-dapp/e2e/fork/liquidity-transcript.json','utf8')); const r=verifyLiquidityTranscript(t,t.identity.accounts); if (t.sourceChainId!==8453 || r.providerRequests<1) process.exit(1); console.log('BUILD-006 closed transcript verified',r.providerRequests,r.localReplies);"
# BUILD-007 has a separate complete source recording and cannot reuse BUILD-003F or BUILD-006 evidence.
test -f apps/reference-dapp/e2e/fork/composition-transcript.json
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { verifyCompositionTranscript } from './apps/reference-dapp/e2e/fork/composition-replay-upstream.mjs'; const t=JSON.parse(readFileSync('apps/reference-dapp/e2e/fork/composition-transcript.json','utf8')); const r=verifyCompositionTranscript(t,t.identity.accounts); if(t.sourceChainId!==8453||r.providerRequests<1||t.codeFingerprints.composition.syntheticCodePins) process.exit(1); console.log('BUILD-007 closed transcript verified',r.providerRequests,r.localReplies);"
