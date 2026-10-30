#!/usr/bin/env python3
"""Repository-owned ownership and regression evidence contracts (no AI/network).

Ownership is an explicit file inventory, not a permissive directory glob. Relevant
suite references describe coverage, not execution. Only verify-results checks a
fresh test report; CircleCI still owns complete release certification.
"""

import argparse
from collections import Counter
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "docs/engineering/coverage.json"
DOMAINS = tuple("flofi-" + name for name in (
    "swap", "bridge", "lending", "liquidity", "transfer-payments", "workflow",
    "chat", "mcp", "channels", "wallet-execution", "security", "developers",
    "automations", "frontend-ux", "admin-analytics", "data-privacy",
    "infrastructure-ci", "protocol-integrations", "payments-billing",
))


def git_paths(root=ROOT):
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root, check=True, capture_output=True,
    )
    return sorted(set(p.decode() for p in result.stdout.split(b"\0") if p))


def maintained(path):
    """Conservative universe: unknown new roots/files are included by default.

    Documentation, vendored legal material and test fixtures are not production
    modules. Their tests/governance remain in the existing certification gates.
    Agent definitions are checked separately against the exact 19-domain set.
    """
    p = PurePosixPath(path)
    if path.startswith("docs/"):
        # Published schemas and machine-consumed policy are maintained contracts.
        # Build reports and this guard's own manifest are validated separately.
        return (not path.startswith(("docs/builds/", "docs/engineering/"))
                and p.suffix in {".json", ".yaml", ".yml", ".sql", ".toml"})
    if path.startswith(("tests/", "third_party/", "prompts/", "LICENSES/", ".codex/agents/")):
        return False
    if p.suffix == ".md" or p.name in {"LICENSE", "NOTICE", ".DS_Store"}:
        return False
    if any(part in {"test", "e2e", "test-utils", "__pycache__"} for part in p.parts):
        return False
    return not (".test." in p.name or ".spec." in p.name or ".test-harness." in p.name
                or p.name.startswith("test_") or p.suffix == ".pyc")


def safe_path(path):
    return (isinstance(path, str) and bool(path) and "\\" not in path
            and not PurePosixPath(path).is_absolute()
            and all(part not in {".", ".."} for part in path.split("/")))


def load(root=ROOT):
    return json.loads((root / MANIFEST).read_text())


def validate(data, paths, root=ROOT):
    errors = []
    if data.get("version") != 1:
        errors.append("Unsupported coverage manifest version")
    definitions = {}
    for path in sorted((root / ".codex/agents").glob("*.toml")):
        try:
            agent = tomllib.loads(path.read_text())
            if set(agent) != {"name", "description", "developer_instructions"}:
                errors.append(f"{path.name}: unexpected/missing agent fields")
            for key in ("name", "description", "developer_instructions"):
                if not isinstance(agent.get(key), str) or not agent[key].strip():
                    errors.append(f"{path.name}: invalid {key}")
            name = agent.get("name")
            if name in definitions or path.stem != name:
                errors.append(f"{path.name}: duplicate name or filename mismatch")
            definitions[name] = agent
        except (ValueError, OSError) as exc:
            errors.append(f"{path.name}: {exc}")
    if set(definitions) != set(DOMAINS):
        errors.append("Agent definitions must cover exactly the 19 FloFi domains")
    config = tomllib.loads((root / ".codex/config.toml").read_text())
    if config != {"agents": {"max_concurrent_threads_per_session": 3}}:
        errors.append("Project Codex configuration must retain the bounded agent pool")
    suites = data.get("suites", {})
    for name, suite in suites.items():
        path = suite.get("path")
        if not safe_path(path) or not (root / path).is_file() or (root / path).is_symlink():
            errors.append(f"{name}: missing or unsafe suite {path}")
        if suite.get("stage") not in {"unit", "postgres", "fork", "browser", "governance"}:
            errors.append(f"{name}: unknown certification stage")
        elif isinstance(path, str):
            stage = suite["stage"]
            valid = {
                "unit": (path.startswith(("packages/", "apps/reference-dapp/src/", "apps/reference-dapp/backend/"))
                         and path.endswith((".test.ts", ".test.tsx"))
                         and not any(marker in path for marker in (".pg.", ".fork.", ".live.", ".remote."))),
                "postgres": path.endswith(".pg.test.ts"),
                "fork": path.endswith(".fork.test.ts"),
                "browser": path.startswith("apps/reference-dapp/e2e/") and path.endswith(".spec.ts"),
                "governance": path.startswith("scripts/test_") and path.endswith(".py"),
            }[stage]
            if not valid:
                errors.append(f"{name}: suite path is outside the {stage} runner's selection")
    required = data.get("requiredUnitSuites", [])
    for stage, key in (("unit", "requiredUnitSuites"), ("postgres", "requiredPostgresSuites")):
        selected = data.get(key, [])
        if not selected or len(set(selected)) != len(selected):
            errors.append(f"Required {stage} regression suite list is empty or duplicated")
        for name in selected:
            if name not in suites or suites[name].get("stage") != stage:
                errors.append(f"{name}: required regression suite must belong to the {stage} stage")
    owned, module_ids, primaries = {}, set(), set()
    for module in data.get("modules", []):
        name = module.get("id")
        if not isinstance(name, str) or not name or name in module_ids:
            errors.append(f"Duplicate or invalid module {name}")
        module_ids.add(name)
        primary = module.get("primary")
        primaries.add(primary)
        if primary not in DOMAINS:
            errors.append(f"{name}: unknown primary domain {primary}")
        dependencies = module.get("dependencies", [])
        if (not isinstance(dependencies, list) or not dependencies
                or len(set(dependencies)) != len(dependencies)
                or primary in dependencies or set(dependencies) - set(DOMAINS)):
            errors.append(f"{name}: invalid cross-domain dependencies")
        tests, gaps = module.get("suites", []), module.get("gaps", [])
        if not tests and not gaps:
            errors.append(f"{name}: tests or explicit coverage gap required")
        if set(tests) - set(suites):
            errors.append(f"{name}: unknown suite references {set(tests) - set(suites)}")
        if any(not isinstance(gap, str) or not gap.strip() for gap in gaps):
            errors.append(f"{name}: empty coverage gap")
        sources = module.get("sources", [])
        if not sources:
            errors.append(f"{name}: module has no sources")
        for path in sources:
            if not safe_path(path) or not (root / path).is_file() or (root / path).is_symlink():
                errors.append(f"{name}: missing or unsafe source {path}")
            if path in owned:
                errors.append(f"{path}: multiple primary owners")
            owned[path] = module
    if primaries != set(DOMAINS):
        errors.append(f"Domains without primary ownership: {sorted(set(DOMAINS) - primaries)}")
    required_domains = {module["primary"] for module in data.get("modules", [])
                        if set(module.get("suites", [])) & set(required)}
    # Infrastructure is deterministically checked by the existing Python
    # governance/parity suites and the mandatory inventory command itself.
    missing = set(DOMAINS) - {"flofi-infrastructure-ci"} - required_domains
    if missing:
        errors.append(f"Domains without required unit regressions: {sorted(missing)}")
    actual = {path for path in paths if maintained(path)}
    for path in sorted(actual - set(owned)):
        errors.append(f"Unmapped maintained source: {path}")
    for path in sorted(set(owned) - actual):
        errors.append(f"Stale/non-production inventory entry: {path}")
    return errors


def impact(data, changed):
    owners = {path: module for module in data["modules"] for path in module["sources"]}
    modules, domains, suites, unmapped = {}, set(), set(), []
    for path in changed:
        affected = [owners[path]] if path in owners else [
            module for module in data["modules"]
            if any(data["suites"][suite]["path"] == path for suite in module["suites"])
        ]
        if path == MANIFEST or path in {"AGENTS.md", "CLAUDE.md", "docs/SCOPE_GUARD.md"}:
            affected = data["modules"]
        if path.startswith(".codex/agents/"):
            domain = PurePosixPath(path).stem
            domains.add(domain if domain in DOMAINS else "flofi-infrastructure-ci")
            domains.add("flofi-infrastructure-ci")
        for module in affected:
            modules[module["id"]] = module
            domains.update([module["primary"], *module["dependencies"]])
            suites.update(module["suites"])
            if module.get("sharedFinancialCore"):
                domains.update({"flofi-workflow", "flofi-security", "flofi-swap", "flofi-bridge",
                                "flofi-lending", "flofi-liquidity", "flofi-transfer-payments",
                                "flofi-wallet-execution", "flofi-mcp", "flofi-developers",
                                "flofi-chat", "flofi-frontend-ux", "flofi-data-privacy",
                                "flofi-channels", "flofi-automations"})
        if not affected and maintained(path):
            unmapped.append(path)
    return {"domains": sorted(domains), "modules": sorted(modules), "suites": sorted(suites),
            "unmapped": sorted(unmapped), "maxConcurrentSubagents": 3,
            "gaps": {name: row["gaps"] for name, row in sorted(modules.items()) if row["gaps"]},
            "note": "Review selection only. Existing full CI coverage is never filtered by this plan."}


def verify_results(data, report, root=ROOT, stage="unit"):
    """Reject absent, zero-test, skipped, failed or duplicate required suites."""
    errors = []
    if report.get("success") is not True:
        errors.append(f"{stage} report did not succeed")
    rows = report.get("testResults", [])
    required = data[{"unit": "requiredUnitSuites", "postgres": "requiredPostgresSuites"}[stage]]
    if not required:
        errors.append(f"Required {stage} suite list is empty")
    for suite_id in required:
        path = data["suites"][suite_id]["path"]
        expected = (root / path).resolve()
        matches = [row for row in rows if Path(row.get("name", "")).resolve() == expected]
        if len(matches) != 1:
            errors.append(f"{path}: required suite missing or repeated")
            continue
        suite = matches[0]
        cases = suite.get("assertionResults", [])
        if (suite.get("status") != "passed" or not cases
                or any(case.get("status") != "passed" for case in cases)):
            errors.append(f"{path}: required cases failed, skipped, pending or absent")
    return errors


def coverage_report(data):
    lines = ["# FloFi ownership and coverage inventory", "",
             "Generated by `python3 scripts/agent_guard.py report`. Suite references are coverage",
             "pointers, not claims of passing tests or public availability. See README.md for limitations.", "",
             "| Module | Primary owner | Dependencies | Files | Suite IDs | Gaps |",
             "| --- | --- | --- | ---: | --- | --- |"]
    for m in data["modules"]:
        lines.append(f"| {m['id']} | {m['primary']} | {', '.join(m['dependencies'])} | {len(m['sources'])} | "
                     f"{', '.join(m['suites']) or 'None'} | {'; '.join(m['gaps']) or 'See evidence limits'} |")
    lines += ["", "Every maintained source file is enumerated in coverage.json under its module.",
              "Uncovered files cause `check` to fail; modules without suites below are explicit gaps.", ""]
    gaps = [m["id"] for m in data["modules"] if not m["suites"]]
    lines.append("Modules with no mapped deterministic suite: " + (", ".join(gaps) or "None") + ".")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "impact", "report", "verify-results"])
    parser.add_argument("result_file", nargs="?")
    parser.add_argument("--base", help="Explicit Git ref to compare using merge-base; no network fetch")
    parser.add_argument("--stage", choices=["unit", "postgres"], default="unit", help="Test report's existing certification stage")
    args = parser.parse_args()
    data = load()
    if args.command == "verify-results":
        if not args.result_file:
            parser.error("verify-results requires the fresh Vitest JSON report path")
        errors = verify_results(data, json.loads(Path(args.result_file).read_text()), stage=args.stage)
    elif args.command == "impact":
        if not args.base:
            parser.error("impact requires an explicit --base ref")
        base = subprocess.check_output(["git", "merge-base", "HEAD", args.base], cwd=ROOT, text=True).strip()
        changed = subprocess.check_output(["git", "diff", "--name-only", "-z", base], cwd=ROOT).decode().split("\0")
        changed += subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
        result = impact(data, sorted(set(filter(None, changed))))
        print(json.dumps(result, indent=2))
        return int(bool(result["unmapped"]))
    elif args.command == "report":
        print(coverage_report(data), end="")
        return 0
    else:
        errors = validate(data, git_paths())
        report = ROOT / "docs/engineering/COVERAGE.md"
        if not report.is_file() or report.read_text() != coverage_report(data):
            errors.append("Stale coverage report: python3 scripts/agent_guard.py report > docs/engineering/COVERAGE.md")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    if args.command == "verify-results":
        key = "requiredUnitSuites" if args.stage == "unit" else "requiredPostgresSuites"
        print(f"Engineering {args.stage} results: PASS ({len(data[key])} required suites; every case passed)")
        return 0
    counts = Counter(m["primary"] for m in data["modules"])
    print(f"Engineering {args.command}: PASS ({len(counts)} domains, {len(data['modules'])} modules; "
          "structural/test-result evidence only, not release certification)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        print(f"Engineering guard failed: {exc}", file=sys.stderr)
        sys.exit(1)
