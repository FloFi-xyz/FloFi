#!/usr/bin/env bash
# Canonical CycloneDX 1.6 SBOM gate. CircleCI, GitHub Actions and Cloud Build all run this one script; the validator is
# scripts/sbom_verify.py (inventory computed from pnpm-lock.yaml, licenses from the dependency security evidence).
set -euo pipefail
source scripts/ci-observe.sh 'SBOM'
flofi_sbom="$RUNNER_TEMP/flofi-sbom.cdx.json"
flofi_ci_cleanup() {
  rm -f "$flofi_sbom"
}
pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 --lockfile-only --out "$flofi_sbom"
python3 scripts/sbom_verify.py "$flofi_sbom" "$RUNNER_TEMP/flofi-dependency-evidence.json"
