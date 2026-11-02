#!/usr/bin/env python3
"""Local safety checks. The human owner authorizes repository changes by PR review."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


# Retain the old scanner's credential families. Never print matched values.
SECRET_PATTERNS = {
    "credential assignment": r"(?im)\b(?:api[_-]?key|secret|private[_-]?key)[\"']?\s*[:=]\s*(?:[\"']([A-Za-z0-9+/=_-]{16,})[\"']|([A-Za-z0-9+/=_-]{16,})(?=\s*(?:$|#)))",
    "private key PEM": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "GitHub token": r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",
    "AWS access key": r"\bAKIA[0-9A-Z]{16}\b",
    "Slack token": r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
    "API token": r"\bsk-[A-Za-z0-9_-]{20,}\b",
    "seed phrase": r"(?i)\b(?:mnemonic|seed[_-]?phrase)\s*[:=]\s*[\"']((?:[a-z]+\s+){11,23}[a-z]+)[\"']",
}
PLACEHOLDER = re.compile(r"(?i)^(?:YOUR[_-].*|REPLACE[_-]ME.*|EXAMPLE[_-].*|PLACEHOLDER[_-].*|<[^>]+>)$")
AUTO_MERGE = re.compile(
    r"(?i)\bgh\s+pr\s+merge\b|enablePullRequestAuto" r"Merge|mergePullRequest\s*\("
    r"|/pulls/" r"[^\s]+/merge\b|\b(?:auto[-_]merge|merge[-_]me)@"
)
GOVERNANCE = ".github/workflows/governance.yml"
CONTRACTS = ".github/workflows/contracts.yml"
DEPENDENCY_POLICY = "docs/security/dependency-policy.json"
SBOM_SCRIPT = "scripts/ci-sbom.sh"
# BUILD-FLOFI-CI-ARCHITECTURE-001 (owner decision): no time-based installation restriction. pnpm 11 applies a 1440-minute
# default when minimumReleaseAge is unset, so the workspace sets 0 explicitly; waivers no longer exist.
RELEASE_AGE_SETTINGS = re.compile(r"(?mi)^\s*['\"]?(?:minimumReleaseAge\w*|minimum-release-age[\w-]*)['\"]?\s*[:=]")
# pnpm 11 settings that would silently weaken dependency security (checked on the parsed workspace, so quoting or flow
# style cannot hide them). None: forbidden whenever set; any other value: forbidden when equal to it.
WORKSPACE_FORBIDDEN = {"audit": None, "auditConfig": None, "auditLevel": None, "registry": None, "registries": None,
                       "dangerouslyAllowAllBuilds": None, "onlyBuiltDependencies": None, "allowBuilds": None,
                       "gitBranchLockfile": None, "mergeGitBranchLockfiles": None, "mergeGitBranchLockfilesBranchPattern": None,
                       "lockfileDir": None, "useLockfile": False, "lockfile": False,
                       "sharedWorkspaceLockfile": False, "optional": False}
WORKSPACE_REQUIRED = {"minimumReleaseAge": 0, "ignoreScripts": True, "strictPeerDependencies": True, "autoInstallPeers": False}


def dependency_policy_errors(files):
    """The policy must exist, parse and keep its mandatory invariants (dependency_security.policy_errors)."""
    from dependency_security import policy_errors
    try:
        policy = json.loads(files.get(DEPENDENCY_POLICY, ""))
    except (ValueError, TypeError):
        return [f"{DEPENDENCY_POLICY}: missing or invalid dependency security policy"]
    return [f"{DEPENDENCY_POLICY}: {error}" for error in policy_errors(policy)]


def workspace_settings(files):
    """pnpm-workspace.yaml parsed with the dependency engine's fail-closed YAML subset (tags, anchors, merges refused)."""
    from dependency_security import parse_yaml
    try:
        settings = parse_yaml(files.get("pnpm-workspace.yaml", ""))
    except ValueError as exc:
        return None, [f"pnpm-workspace.yaml: unsupported YAML ({exc})"]
    if not isinstance(settings, dict):
        return None, ["pnpm-workspace.yaml: not a mapping"]
    return settings, []


def release_age_errors(files):
    """Test R: no release-age gate, waiver list or hidden pnpm default may come back; no setting may silence advisories,
    switch lockfiles, enable dependency scripts or change the registry."""
    errors = []
    workspace = files.get("pnpm-workspace.yaml", "")
    settings, parse_errors = workspace_settings(files)
    errors.extend(parse_errors)
    if workspace.splitlines().count("minimumReleaseAge: 0") != 1 or len(RELEASE_AGE_SETTINGS.findall(workspace)) != 1:
        errors.append("pnpm-workspace.yaml: minimumReleaseAge must be exactly 0 (no release-age gate or waiver list)")
    if RELEASE_AGE_SETTINGS.search(files.get(".npmrc", "")):
        errors.append(".npmrc: release-age settings are not allowed")
    if settings is not None:
        for key, value in WORKSPACE_REQUIRED.items():
            if settings.get(key) != value or type(settings.get(key)) is not type(value):
                errors.append(f"pnpm-workspace.yaml: {key} must be {str(value).lower()}")
        for key, forbidden in WORKSPACE_FORBIDDEN.items():
            if key in settings and (forbidden is None or settings[key] == forbidden):
                errors.append(f"pnpm-workspace.yaml: {key} bypasses dependency security (advisories, lockfile, scripts or registry)")
        if any(key.lower().startswith("minimumreleaseage") and key != "minimumReleaseAge" for key in settings):
            errors.append("pnpm-workspace.yaml: release-age waivers are not allowed")
    npmrc = {}
    for line in files.get(".npmrc", "").splitlines():
        if "=" in line and not line.strip().startswith(("#", ";")):
            key, value = line.split("=", 1)
            npmrc[key.strip().strip("'\"").strip()] = value.strip().strip("'\"").strip()
    if npmrc.get("registry") != "https://registry.npmjs.org/" or any(key.endswith(":registry") for key in npmrc):
        errors.append(".npmrc: only https://registry.npmjs.org/ may be configured")
    return errors


def secret_errors(path, body):
    errors = []
    for label, pattern in SECRET_PATTERNS.items():
        for match in re.finditer(pattern, body):
            value = next(group for group in match.groups() if group is not None) if match.lastindex else match.group()
            if PLACEHOLDER.fullmatch(value):
                continue
            line = body.count("\n", 0, match.start()) + 1
            errors.append(f"{path}:{line}: possible {label}")
    return errors


def context_errors(branch, event="local"):
    # CI also verifies owner-merged main. A detached CI checkout is expected;
    # use the event's source branch, not the checkout's symbolic branch.
    if not branch or branch == "HEAD":
        return ["Work must have a named branch"]
    if branch in {"main", "master"} and event != "push":
        return ["Agent work and PRs must use a branch other than main/master"]
    return []


def control_errors(files):
    """Surface obvious gate removal; no hashes, build scopes or approval manifests."""
    errors = []
    required = (GOVERNANCE, CONTRACTS, "scripts/guarded-release-browser.mjs", "scripts/governance_lite.py",
                "scripts/test_governance_lite.py", "CLAUDE.md", "docs/SCOPE_GUARD.md",
                "scripts/bootstrap-ci.py", "pnpm-lock.yaml", "pnpm-workspace.yaml", DEPENDENCY_POLICY,
                "scripts/dependency_security.py", "scripts/sbom_verify.py", SBOM_SCRIPT, "scripts/function_traces.py")
    errors.extend("Missing safety control: " + path for path in required if not files.get(path))
    for path, commands in {
        GOVERNANCE: ("python3 -m unittest discover -s scripts -p 'test_governance_lite.py'",
                     "python3 scripts/governance_lite.py", "git diff --check", "git diff --check HEAD^1 HEAD"),
        CONTRACTS: ("python3 scripts/bootstrap-ci.py", "pnpm install --frozen-lockfile --ignore-scripts",
                    "python3 scripts/dependency_security.py verify", "bash scripts/ci-sbom.sh", "pnpm typecheck", "pnpm lint",
                    "pnpm build", "python3 scripts/function_traces.py apps/reference-dapp", "pnpm schemas:check", "python3 scripts/agent_guard.py check",
                    'pnpm test --reporter=default --reporter=json --outputFile="$RUNNER_TEMP/flofi-agent-unit.json"',
                    'python3 scripts/agent_guard.py verify-results "$RUNNER_TEMP/flofi-agent-unit.json"', "pnpm test:anvil",
                    "pnpm test:fork --testTimeout=30000", "pnpm audit --audit-level low",
                    "node scripts/guarded-release-browser.mjs critical",
                    "node scripts/guarded-release-browser.mjs extended",
                    "node scripts/guarded-release-browser.mjs composition"),
    }.items():
        body = files.get(path, "")
        for command in commands:
            if not re.search(r"(?m)^          " + re.escape(command) + r"$", body):
                errors.append(f"{path}: required gate missing: {command}")
        # These workflows use unconditional jobs and fail-fast Bash. Only
        # failure diagnostics/artifact steps may be conditional.
        for line in body.splitlines():
            if re.match(r"\s*(?:continue-on-error|if):", line) and line.strip() not in {
                "if: failure()", "if: ${{ failure() && steps.browser.outcome == 'failure' }}"
            }:
                errors.append(f"{path}: conditional or ignored safety gate")
        for step in re.split(r"(?m)^      - ", body):
            if any(re.search(r"(?m)^          " + re.escape(command) + "$", step) for command in commands):
                if (re.search(r"(?m)^\s*if:", step) or "          set -euo pipefail\n" not in step
                        or re.search(r"(?m)^          (?:exit\s+0|set\s+\+e)\b", step)):
                    errors.append(f"{path}: safety step must be unconditional and fail fast")
        if not re.search(r"(?m)^  push:\s*$", body) or not re.search(r"(?m)^  pull_request:\s*$", body):
            errors.append(f"{path}: push/PR trigger missing")
    for path, body in files.items():
        if path.startswith(".github/workflows/"):
            if "\npermissions:\n  contents: read\n" not in body:
                errors.append(f"{path}: read-only permissions required")
            if re.search(r"(?m)^\s*[\w-]+:\s*write\b", body) or "pull_request" + "_target" in body:
                errors.append(f"{path}: privileged workflow")
            if re.search(r"\$\{\{\s*secrets\.", body):
                errors.append(f"{path}: repository secret access in CI")
        if path.startswith((".github/", "scripts/")) and AUTO_MERGE.search(body):
            errors.append(f"{path}: automated merge command")
    try:
        manifest = json.loads(files.get("package.json", "{}"))
        for name, tool in (("typecheck", "turbo run typecheck"), ("build", "turbo run build"),
                           ("schemas:check", "node scripts/export-schemas.mjs --check"),
                           ("lint", "eslint "), ("test", "vitest run ")):
            command = manifest.get("scripts", {}).get(name, "")
            if not command.startswith(tool) or re.search(r"\|\|\s*(?:true|exit\s+0)|--passWithNoTests", command):
                errors.append(f"package.json: {name} gate missing")
        if manifest.get("private") is not True or manifest.get("packageManager") != "pnpm@11.22.0":
            errors.append("package.json: private workspace or approved package manager changed")
        if manifest.get("engines") != {"node": "24.21.0", "pnpm": "11.22.0"}:
            errors.append("package.json: approved toolchain changed")
        for path, body in files.items():
            if path.startswith(("packages/", "apps/")) and path.endswith("/package.json"):
                package = json.loads(body)
                license_path = "LICENSES/" + package.get("license", "") + ".txt"
                if not files.get(license_path) or files.get(path.removesuffix("package.json") + "LICENSE") != files[license_path]:
                    errors.append(f"{path}: package license copy mismatch")
    except (ValueError, TypeError):
        errors.append("Invalid package manifest")
    for line in ("ignore-scripts=true", "engine-strict=true", "strict-peer-dependencies=true", "auto-install-peers=false"):
        if line not in files.get(".npmrc", "").splitlines():
            errors.append(".npmrc: dependency control missing: " + line)
    if "registry=https://registry.npmjs.org/" not in files.get(".npmrc", "").splitlines():
        errors.append(".npmrc: dependency control missing: registry=https://registry.npmjs.org/")
    for line in ("strictPeerDependencies: true", "autoInstallPeers: false"):
        if line not in files.get("pnpm-workspace.yaml", "").splitlines():
            errors.append("pnpm-workspace.yaml: dependency control missing: " + line)
    errors.extend(release_age_errors(files))
    errors.extend(f"{path}: only the root pnpm-lock.yaml may define the installed graph" for path in files
                  if re.fullmatch(r"(?:.*/)?pnpm-lock(?:\.[^/]+)?\.yaml", path) and path != "pnpm-lock.yaml")
    errors.extend(dependency_policy_errors(files))
    # The one SBOM gate every CI provider calls: it must generate, validate and fail fast.
    sbom = files.get(SBOM_SCRIPT, "")
    for line in ("set -euo pipefail",
                 'pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 --lockfile-only --out "$flofi_sbom"',
                 'python3 scripts/sbom_verify.py "$flofi_sbom" "$RUNNER_TEMP/flofi-dependency-evidence.json"'):
        if line not in sbom.splitlines():
            errors.append(f"{SBOM_SCRIPT}: required line missing: {line}")
    if re.search(r"(?m)\|\|\s*(?:true|exit\s+0|:)|^\s*(?:set\s+\+e|exit\s+0)\b", sbom):
        errors.append(f"{SBOM_SCRIPT}: ignored failure")
    return errors


def validate(files, branch, event="local"):
    errors = context_errors(branch, event) + control_errors(files)
    for path, body in files.items():
        errors.extend(secret_errors(path, body))
    return errors


def main():
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    paths = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split(b"\0")
    files = {}
    errors = []
    for raw in sorted(set(paths) - {b""}):
        path = os.fsdecode(raw)
        file = root / path
        if file.is_symlink():
            errors.append(f"{path}: tracked symlink requires review")
        elif file.is_file():
            data = file.read_bytes()
            if b"\0" not in data:
                try:
                    files[path] = data.decode("utf-8")
                except UnicodeDecodeError:
                    pass
    branch = os.environ.get("GOVERNANCE_BRANCH") or subprocess.check_output(["git", "branch", "--show-current"], text=True).strip()
    errors.extend(validate(files, branch, os.environ.get("GOVERNANCE_EVENT", "local")))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Governance-lite passed ({len(files)} text files; no build scope or history required)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
