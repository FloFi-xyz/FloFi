#!/usr/bin/env python3
"""Report engineering knowledge maintenance from local Git and reviewed metadata."""

import argparse
import datetime as dt
import fnmatch
import json
from pathlib import Path
import re
import subprocess
import sys

import agent_guard as guard
import skill_registry as registry


# Explicit contract sources plus conventional names for emerging provider surfaces.
# Candidates require human review. A file change cannot prove a capability changed.
CAPABILITY_PATH = re.compile(
    r"(^packages/action-registry/src/|/gas-(abstraction|sponsorship)/"
    r"|(?:^|[/.-])(?:adapter|capabilit(?:y|ies)|catalog|chains?|networks?|providers?|router|routes|rpc)(?:[/.-]|$))"
)
REGRESSION_PATH = re.compile(r"(?:\.(?:test|spec)\.[^/]+$|^scripts/test_.*\.py$)")
ENGINEERING_DOCS = ("docs/engineering/", "docs/adr/", "docs/decisions/")
ENGINEERING_INSTRUCTIONS = {"AGENTS.md", "CLAUDE.md", "docs/SCOPE_GUARD.md", "docs/DECISIONS.md"}


def index(data):
    sources, suites = {}, {}
    for module in data["modules"]:
        for path in module["sources"]:
            sources[path] = module
        for suite in module["suites"]:
            suites.setdefault(data["suites"][suite]["path"], []).append(module)
    return sources, suites


def assess(root, base, today, upstream=None):
    data = guard.load(root)
    paths = guard.git_paths(root)
    sources, suites = index(data)
    prior_sources, prior_suites = {}, {}
    prior_modules = {}
    before = {}
    revision, changed = None, []
    if base is not None:
        revision, changed = guard.changed_paths(base, root, include_renamed_sources=True)
        previous = subprocess.check_output(["git", "show", f"{revision}:{guard.MANIFEST}"], cwd=root)
        before = json.loads(previous)
        prior_sources, prior_suites = index(before)
        prior_modules = {module["id"]: module for module in before["modules"]}

    changed = set(changed)
    relevant = sorted(changed & (sources.keys() | suites.keys() | prior_sources.keys() | prior_suites.keys()))
    modules = {}
    for path in relevant:
        for module in (prior_sources.get(path), sources.get(path), *prior_suites.get(path, []), *suites.get(path, [])):
            if module is not None:
                modules[module["id"]] = module
    current_modules = {module["id"]: module for module in data["modules"]}
    inventory_changes = sorted(
        key for key in prior_modules.keys() | current_modules.keys()
        if prior_modules.get(key) != current_modules.get(key)
    ) if guard.MANIFEST in changed else []
    suite_changes, required_changes = [], {}
    if guard.MANIFEST in changed:
        previous_contracts, current_contracts = before["suites"], data["suites"]
        suite_changes = sorted(key for key in previous_contracts.keys() | current_contracts.keys()
                               if previous_contracts.get(key) != current_contracts.get(key))
        for field in ("requiredUnitSuites", "requiredPostgresSuites"):
            old, new = set(before.get(field, [])), set(data.get(field, []))
            if old != new:
                required_changes[field] = {"added": sorted(new - old), "removed": sorted(old - new)}
    reviewed_suites = set(suite_changes)
    for delta in required_changes.values():
        reviewed_suites.update(delta["added"], delta["removed"])
    suite_modules = {key for manifest in (prior_modules, current_modules) for key, module in manifest.items()
                     if reviewed_suites.intersection(module["suites"])}
    selected_modules = current_modules.keys() if base is None else modules.keys() | set(inventory_changes) | suite_modules
    gaps = {key: current_modules[key]["gaps"] for key in sorted(selected_modules & current_modules.keys())
            if current_modules[key]["gaps"]}
    changed_sources = sorted(changed & (sources.keys() | prior_sources.keys()))
    capabilities = sorted(path for path in changed if guard.maintained(path) and CAPABILITY_PATH.search(path))
    tests = sorted(path for path in changed if path in suites or path in prior_suites or REGRESSION_PATH.search(path))
    docs = sorted(path for path in changed if path in ENGINEERING_INSTRUCTIONS
                  or path.startswith(ENGINEERING_DOCS) and path.endswith(".md"))
    roles = sorted(path for path in changed if path.startswith((".codex/agents/", ".claude/agents/")))
    skill_files = sorted(path for path in changed if path.startswith("skills/"))
    _, skills = registry.load(root)
    selected_skills = sorted(row["id"] for row in registry.select(root, paths=sorted(set(changed_sources + capabilities)))["skills"])
    skill_patterns = [pattern for skill in skills.values() if skill for pattern in skill["appliesTo"]["paths"]]
    unmatched_capabilities = [path for path in capabilities
                              if not any(fnmatch.fnmatchcase(path, pattern) for pattern in skill_patterns)]
    changed_skills = {skill for skill in skills if any(path.startswith(f"skills/{skill}/") for path in skill_files)}
    scope = set(skills) if base is None or registry.REGISTRY in changed else set(selected_skills) | changed_skills
    skill_notes = [note for note in registry.warnings(root, today) if note.split(":", 1)[0] in scope]
    upstream_actions = []
    upstream_skills = set()
    if upstream is not None:
        urls = {(key, source["url"]) for key, skill in skills.items() if skill
                for source in skill["sources"]}
        for row in upstream:
            skill, url, state = row["skill"], row["url"], row["state"]
            if (skill, url) in urls and (state in {"CHANGED", "UNPINNED", "STALE", "NOT_CHECKED"}
                                        or re.fullmatch(r"UNREACHABLE: [A-Za-z][A-Za-z0-9]*", state)):
                upstream_actions.append(f"{skill}: {state} {url}")
                upstream_skills.add(skill)
    skill_review_ids = changed_skills | upstream_skills | {note.split(":", 1)[0] for note in skill_notes}
    codex_dir = root / ".codex/agents"
    claude_dir = root / ".claude/agents"
    codex_files = list(codex_dir.glob("*.toml"))
    claude_files = list(claude_dir.glob("*"))
    parity = (any(path.is_symlink() for path in (codex_dir, claude_dir, *codex_files, *claude_files))
              or {path.stem for path in codex_files} != set(guard.DOMAINS)
              or {path.relative_to(root).as_posix() for path in claude_files} != guard.CLAUDE_AGENTS
              or guard.claude_sync(root)[0])
    maintained = {path for path in paths if guard.maintained(path)}
    missing_owners = sorted(path for path in maintained - sources.keys()
                            if (root / path).exists() or (root / path).is_symlink())
    stale_owners = sorted(path for path in sources
                          if path not in maintained or not (root / path).is_file() or (root / path).is_symlink())
    missing_suites = sorted(path for path in (suite["path"] for suite in data["suites"].values())
                            if not (root / path).is_file() or (root / path).is_symlink())
    unlinked_tests = sorted(path for path in tests if path not in suites and (root / path).is_file())
    affected_domains = {Path(path).stem for path in roles if Path(path).stem in guard.DOMAINS}
    if base is not None:
        for key in selected_modules:
            for module in (prior_modules.get(key), current_modules.get(key)):
                if module:
                    affected_domains.update((module["primary"], *module["dependencies"]))
    actions = []
    if changed_sources or capabilities or roles or docs:
        actions.append("Compare changed behavior with the affected role guidance. Verify availability, gates and evidence against current source.")
    if capabilities or selected_skills or skill_files or skill_notes or upstream_actions:
        actions.append("Check relevant skills for stale claims or missing protocol coverage. Review sources and provenance before editing.")
    if tests or gaps or missing_suites:
        actions.append("Check regression contracts and coverage gaps. Capture a reusable lesson when the diff changes a failure mode.")
    if guard.MANIFEST in changed:
        actions.append("Verify changes to suite links and required regression sets against the existing certification gates.")
    if missing_owners or stale_owners or inventory_changes:
        actions.append("Review explicit ownership, dependencies and suite links in coverage.json.")
    if parity:
        actions.append("Inspect agent_guard.py claude-agents and regenerate the Claude twins after reviewing the canonical roles.")
    return {
        "comparisonBase": revision,
        "mode": "inventory" if base is None else "diff",
        "asOf": today.isoformat(),
        "maintenance": "review-required" if actions else "no-signal",
        "actions": actions,
        "affectedDomains": sorted(affected_domains),
        "sourceChanges": changed_sources,
        "capabilityCandidates": capabilities,
        "capabilityCandidatesWithoutSkillMatch": unmatched_capabilities,
        "regressionChanges": tests,
        "unlinkedChangedTests": unlinked_tests,
        "missingSuites": missing_suites,
        "suiteContractChanges": suite_changes,
        "requiredSuiteChanges": required_changes,
        "coverageGaps": gaps,
        "inventoryChanges": inventory_changes,
        "missingOwners": missing_owners,
        "staleOwners": stale_owners,
        "roleChanges": roles,
        "engineeringDocChanges": docs,
        "claudeParity": "drift" if parity else "matches",
        "skillChanges": skill_files,
        "suggestedSkills": selected_skills,
        "skillReviewDomains": {skill: sorted(skills[skill]["domains"]) for skill in sorted(skill_review_ids) if skills[skill]},
        "skillReviewNotes": skill_notes,
        "upstreamReportProvided": upstream is not None,
        "upstreamActions": sorted(set(upstream_actions)),
        "notice": "Advisory signals. Inspect behavior and record the disposition in the PR. A changed document does not clear a signal.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--base", help="Local Git ref. Use its merge base with HEAD.")
    mode.add_argument("--inventory", action="store_true", help="Check current ownership, parity, gaps and skill review dates.")
    parser.add_argument("--as-of", type=dt.date.fromisoformat, default=dt.date.today(), help="Review date (YYYY-MM-DD).")
    parser.add_argument("--upstream-report", type=Path, help="JSON from skill_registry.py check-upstream. No network access.")
    args = parser.parse_args()
    try:
        upstream = json.loads(args.upstream_report.read_text()) if args.upstream_report else None
        print(json.dumps(assess(guard.ROOT, args.base, args.as_of, upstream), indent=2))
    except (KeyError, OSError, TypeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Agent Evolution report unavailable: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
