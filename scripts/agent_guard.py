#!/usr/bin/env python3
"""Repository-owned ownership and regression evidence contracts (no AI/network).

Ownership is an explicit file inventory, not a permissive directory glob. Relevant
suite references describe coverage, not execution. Only verify-results checks a
fresh test report; CircleCI still owns complete release certification.
"""

import argparse
from collections import Counter
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
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
# Claude Code twins of the Codex roles. They are generated from the Codex
# definitions, read-only and bounded by the project hook; see CLAUDE-CODE.md.
CLAUDE_SETTINGS = ".claude/settings.json"
CLAUDE_HOOK = ".claude/hooks/flofi_agent_hooks.py"
CLAUDE_RUNS = ".claude/flofi-agent-runs"
CLAUDE_AGENTS = frozenset(f".claude/agents/{domain}.md" for domain in DOMAINS)
CLAUDE_FILES = CLAUDE_AGENTS | {CLAUDE_SETTINGS, CLAUDE_HOOK}
CLAUDE_FRONTMATTER = {"tools": "Read, Grep, Glob, Bash", "model": "inherit",
                      "disallowedTools": "Agent, Edit, Write, NotebookEdit, WebFetch, WebSearch, mcp__*"}
_HOOK_ARGS = ["${CLAUDE_PROJECT_DIR}/" + CLAUDE_HOOK]
_RECORD = [{"hooks": [{"type": "command", "command": "python3", "args": _HOOK_ARGS + ["record"], "timeout": 10}]}]
_RECORD_BASH = [{"matcher": "Bash", **_RECORD[0]}]
CLAUDE_SETTINGS_CONTENT = {"hooks": {
    "SessionStart": _RECORD, "SubagentStart": _RECORD, "SubagentStop": _RECORD, "SessionEnd": _RECORD,
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "python3", "args": _HOOK_ARGS + ["guard"],
                                               "timeout": 10, "onFailure": "block"}]}],
    "PostToolUse": _RECORD_BASH, "PostToolUseFailure": _RECORD_BASH,
}}
SHARED_CORE_DOMAINS = frozenset({
    "flofi-workflow", "flofi-security", "flofi-swap", "flofi-bridge", "flofi-lending", "flofi-liquidity",
    "flofi-transfer-payments", "flofi-wallet-execution", "flofi-mcp", "flofi-developers", "flofi-chat",
    "flofi-frontend-ux", "flofi-data-privacy", "flofi-channels", "flofi-automations",
})
MAX_CONCURRENT_REVIEWS = 3


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
    if path.startswith(("tests/", "third_party/", "prompts/", "LICENSES/", ".codex/agents/", ".claude/agents/")):
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


def codex_contract(agent):
    """Split a Codex role into the shared preamble and its one-line specialty."""
    lines = agent["developer_instructions"].strip().split("\n")
    if not lines[-1].startswith("Specialty: ") or any(line.startswith("Specialty:") for line in lines[:-1]):
        raise ValueError(f"{agent['name']}: Codex instructions must end with one Specialty line")
    return "\n".join(lines[:-1]).strip(), lines[-1].removeprefix("Specialty: ").strip()


def claude_agent_text(agent):
    """Deterministic Claude Code twin of one Codex role (no ownership copy)."""
    name = agent["name"]
    shared, specialty = codex_contract(agent)
    description = (f"{agent['description']} Use proactively for read-only FloFi engineering review when "
                   f"`agent_guard.py impact` selects {name}. Returns structured findings; never edits, "
                   "commits, deploys or signs.")
    front = [("name", name), ("description", json.dumps(description)),
             *((key, CLAUDE_FRONTMATTER[key]) for key in ("tools", "disallowedTools", "model"))]
    return "\n".join(["---", *(f"{key}: {value}" for key, value in front), "---", "",
        f"# {name} — FloFi engineering review specialist", "",
        f"Generated from `.codex/agents/{name}.toml` by `python3 scripts/agent_guard.py claude-agents --write`.",
        "Edit the Codex definition or the generator, not this file; `agent_guard.py check` refuses drift.", "",
        f"You are the Claude Code twin of the Codex `{name}` specialist: a read-only reviewer of FloFi",
        "repository changes for the main Claude session. You are development infrastructure, never an",
        "end-user or runtime transaction agent. In Claude Code, specialists stay read-only; main owns all edits.", "",
        "## Shared Codex/Claude contract", "", shared, "",
        "## Specialty", "", specialty, "",
        "## Domain ownership and regression responsibilities", "",
        f"- Domain ID `{name}` is shared with `.codex/agents/{name}.toml` and with `primary`/`dependencies` in",
        "  `docs/engineering/coverage.json`, the only ownership matrix. Do not keep or infer another one.",
        f"- Load your current contract first: `python3 scripts/agent_guard.py domain {name} --base <ref>` (main",
        "  names the ref; default `origin/main`). It lists owned and dependent modules, cross-domain",
        "  dependencies, mapped and required suites, coverage gaps and the changed paths in your scope.",
        f"- Primary review: changed modules whose `primary` is `{name}`. Dependency review: changed modules that",
        f"  list `{name}` in `dependencies`, and shared financial core when main assigns it.",
        "- Regression duties: every mapped suite of an affected module still exists, still exercises the changed",
        "  boundary and is not skipped, weakened or removed; required unit/PostgreSQL suites stay unconditional;",
        "  new maintained files are explicitly owned in coverage.json or reported as unmapped.",
        "- Report findings that belong to another domain to main with that domain ID instead of reviewing it in depth.", "",
        "## How to review", "",
        "1. Start from the base, paths and concerns main assigned. Inspect from the repository root, without `cd`",
        "   or `git -C`: `git diff <base>...HEAD`, `git diff`, `git status --short`, `git log`, `git show`, `git grep`,",
        "   `rg`, non-recursive `grep`, `find`, `ls`, `cat`, `head`, `tail`, `wc`, `sed -n 'N,Mp'` and",
        "   `python3 scripts/agent_guard.py check|impact|domain|report` (relative path). Pipes are allowed; chaining",
        "   is not. Page long output with `| head`, `| tail` or `| sed -n 'N,Mp'`; Read may open output that",
        "   Claude Code saved for this session under `tool-results/`.",
        "2. Trace behavior through current source, `executionCapabilityRegistry` and the tests mapped to the",
        "   affected modules. Historical reports may be stale.",
        "3. You cannot run builds or test suites. Give main the exact focused command (for example",
        "   `pnpm exec vitest run <suite path>`) and mark it not run.", "",
        "## Boundaries", "",
        f"- Read-only. The project hook `{CLAUDE_HOOK}` denies other tools, writes, shell expansion or",
        "  chaining, and paths outside the repository, Git internals, ignored local state or secrets for",
        "  `flofi-*` agents. Report a denial instead of working around it.",
        "- Never edit, stage, commit, push, merge, deploy, change production configuration or credentials, or",
        "  create, sign or broadcast transactions. Never spawn subagents.",
        "- Never read, quote or summarize credentials, private keys, seed phrases, `.env` files or wallet secrets.", "",
        "## Findings contract", "",
        "Return to main, most severe first:",
        "- Each finding: severity (critical, high, medium or low), concrete defect, impacted `file:line` or",
        "  symbol, reproduction or test command with its actual result or \"not run\", affected domains and",
        "  evidence limits.",
        "- Coverage gaps and checks you could not perform.",
        "- \"No concrete findings\" when that is the honest result.", "",
        "End with exactly one final line and nothing after it:", "",
        "FLOFI_REVIEW_RESULT {\"domain\":\"" + name + "\",\"result\":\"<findings|no-findings|blocked>\","
        "\"findings\":<count>,\"highest\":\"<critical|high|medium|low|none>\"}", "",
        "Use `blocked` when the review could not be completed.", ""])


def parse_claude_agent(text):
    """Strict YAML subset: exact keys in order, plain scalars, JSON-quoted description."""
    match = re.fullmatch(r"---\n((?:[A-Za-z]+: [^\n]+\n)+)---\n(.+)", text, re.S)
    if not match:
        raise ValueError("frontmatter must open on line 1 and close with ---")
    fields = dict(line.split(": ", 1) for line in match[1].splitlines())
    if list(fields) != ["name", "description", "tools", "disallowedTools", "model"]:
        raise ValueError("frontmatter fields must be name, description, tools, disallowedTools, model")
    description = json.loads(fields["description"])
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description must be a non-empty quoted string")
    for key in ("name", "tools", "disallowedTools", "model"):
        if not re.fullmatch(r"[A-Za-z0-9_*-]+(?:, [A-Za-z0-9_*-]+)*", fields[key]):
            raise ValueError(f"{key} must be a plain scalar")
    return {**fields, "description": description}, match[2]


def claude_errors(root, paths, codex):
    """Exact 19 generated read-only twins, bounded settings and no local Claude state."""
    errors = []
    for path in paths:
        parts = PurePosixPath(path).parts
        if ".claude" in parts[1:]:
            errors.append(f"{path}: nested Claude project configuration is not allowed")
        elif parts[0] == ".claude" and path not in CLAUDE_FILES:
            errors.append(f"{path}: unexpected project Claude file (keep local state ignored)")
    agents_dir = root / ".claude/agents"
    present = {str(p.relative_to(root)) for p in agents_dir.rglob("*")} if agents_dir.is_dir() else set()
    for path in sorted(present - CLAUDE_AGENTS):
        errors.append(f"{path}: Claude agent definitions must cover exactly the 19 FloFi domains")
    for path in sorted(CLAUDE_AGENTS):
        target, name = root / path, PurePosixPath(path).stem
        if agents_dir.is_symlink() or target.is_symlink() or not target.is_file():
            errors.append(f"{path}: missing or non-regular Claude agent")
            continue
        text = target.read_text()
        try:
            fields, _ = parse_claude_agent(text)
            if fields["name"] != name or any(fields[k] != v for k, v in CLAUDE_FRONTMATTER.items()):
                errors.append(f"{path}: name, read-only tools or model inheritance changed")
        except ValueError as exc:
            errors.append(f"{path}: invalid frontmatter: {exc}")
        if name in codex:
            try:
                if text != claude_agent_text(codex[name]):
                    errors.append(f"{path}: out of sync with .codex/agents/{name}.toml; "
                                  "run python3 scripts/agent_guard.py claude-agents")
            except ValueError as exc:
                errors.append(str(exc))
    shared = set()
    for agent in codex.values():
        try:
            shared.add(codex_contract(agent)[0])
        except ValueError:
            pass
    if len(shared) > 1:
        errors.append("Codex agents must share one identical contract preamble")
    settings, hook = root / CLAUDE_SETTINGS, root / CLAUDE_HOOK
    try:
        if settings.is_symlink() or json.loads(settings.read_text()) != CLAUDE_SETTINGS_CONTENT:
            errors.append(f"{CLAUDE_SETTINGS}: must contain exactly the FloFi lifecycle and read-only guard hooks")
    except (OSError, ValueError):
        errors.append(f"{CLAUDE_SETTINGS}: missing or invalid project Claude settings")
    if hook.is_symlink() or not hook.is_file():
        errors.append(f"{CLAUDE_HOOK}: missing or non-regular hook")
    return errors


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
    errors.extend(claude_errors(root, paths, {
        name: agent for name, agent in definitions.items() if name in DOMAINS
        and all(isinstance(agent.get(key), str) for key in ("name", "description", "developer_instructions"))}))
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
    modules, domains, suites, unmapped, reasons = {}, set(), set(), [], {}

    def mark(names, reason):
        for name in names:
            domains.add(name)
            reasons.setdefault(name, set()).add(reason)

    for path in changed:
        affected = [owners[path]] if path in owners else [
            module for module in data["modules"]
            if any(data["suites"][suite]["path"] == path for suite in module["suites"])
        ]
        governance = path == MANIFEST or path in {"AGENTS.md", "CLAUDE.md", "docs/SCOPE_GUARD.md"}
        if governance:
            affected = data["modules"]
        if path.startswith((".codex/agents/", ".claude/agents/")):
            domain = PurePosixPath(path).stem
            mark([domain if domain in DOMAINS else "flofi-infrastructure-ci", "flofi-infrastructure-ci"],
                 "agent definition")
        for module in affected:
            modules[module["id"]] = module
            mark([module["primary"]], "governance change" if governance
                 else "primary owner" if path in owners else "mapped suite changed")
            mark(module["dependencies"], "governance change" if governance else "dependency")
            suites.update(module["suites"])
            if module.get("sharedFinancialCore"):
                mark(SHARED_CORE_DOMAINS, "governance change" if governance else "shared financial core")
        if not affected and maintained(path):
            unmapped.append(path)
    return {"domains": sorted(domains), "modules": sorted(modules), "suites": sorted(suites),
            "unmapped": sorted(unmapped), "maxConcurrentSubagents": MAX_CONCURRENT_REVIEWS,
            "reasons": {name: sorted(items) for name, items in sorted(reasons.items())},
            "gaps": {name: row["gaps"] for name, row in sorted(modules.items()) if row["gaps"]},
            "note": "Review selection only. Existing full CI coverage is never filtered by this plan."}


def domain_contract(data, domain, changed=None):
    """One domain's live view of coverage.json, shared by its Codex and Claude roles."""
    if domain not in DOMAINS:
        raise ValueError(f"Unknown domain {domain}")
    required = set(data["requiredUnitSuites"]) | set(data["requiredPostgresSuites"])
    owned = [m for m in data["modules"] if m["primary"] == domain]
    suite_ids = sorted({suite for module in owned for suite in module["suites"]})
    result = {
        "domain": domain, "codexAgent": f".codex/agents/{domain}.toml", "claudeAgent": f".claude/agents/{domain}.md",
        "ownedModules": [{"id": m["id"], "files": len(m["sources"]), "dependencies": m["dependencies"],
                          "sharedFinancialCore": bool(m.get("sharedFinancialCore")), "suites": m["suites"],
                          "gaps": m["gaps"]} for m in owned],
        "dependencyReviewOf": sorted(m["id"] for m in data["modules"] if domain in m["dependencies"]),
        "dependsOn": sorted({name for module in owned for name in module["dependencies"]}),
        "suites": {suite: data["suites"][suite] for suite in suite_ids},
        "requiredSuites": sorted(set(suite_ids) & required),
    }
    if changed is not None:
        owners = {path: module for module in data["modules"] for path in module["sources"]}
        suite_paths = {data["suites"][suite]["path"] for suite in suite_ids}
        result["changedPaths"] = {
            "owned": sorted(p for p in changed if p in owners and owners[p]["primary"] == domain),
            "dependency": sorted(p for p in changed if p in owners and domain in owners[p]["dependencies"]),
            "sharedFinancialCore": sorted(p for p in changed if p in owners and owners[p].get("sharedFinancialCore")),
            "mappedSuites": sorted(p for p in changed if p in suite_paths),
        }
        result["selectedBecause"] = impact(data, changed)["reasons"].get(domain, [])
    return result


def review_fields(value):
    """Same self-consistency rule as the hook: no-findings is 0/none, findings is at least 1."""
    if not isinstance(value, dict):
        return None
    result, findings, highest = value.get("result"), value.get("findings"), value.get("highest")
    if (type(findings) is not int or not 0 <= findings <= 999
            or highest not in {"critical", "high", "medium", "low", "none"}
            or result not in {"findings", "no-findings", "blocked"}
            or (result == "no-findings" and (findings, highest) != (0, "none"))
            or (result == "findings" and (findings == 0 or highest == "none"))):
        return None
    return {"result": result, "findings": findings, "highest": highest}


def ledger_row(row):
    """Re-validate a local ledger row on read and keep only the documented fields."""
    if not isinstance(row, dict):
        return None
    event = row.get("event")
    name = (lambda value: value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", value) else "other")
    clean = {"event": event}
    if event in {"subagent_start", "subagent_stop", "guard_deny"}:
        agent_id = row.get("agentId")
        clean.update(agent=name(row.get("agent")), agentId=agent_id if isinstance(agent_id, str)
                     and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", agent_id) else None)
    if event == "subagent_stop":
        clean["review"] = review_fields(row.get("review"))
    elif event == "guard_deny":
        clean["tool"] = row.get("tool") if row.get("tool") in {"Read", "Grep", "Glob", "Bash"} else "other"
    elif event == "session_start":
        definitions = row.get("definitions") if isinstance(row.get("definitions"), dict) else {}
        clean["definitions"] = {key: value for key, value in definitions.items() if key in DOMAINS
                                and isinstance(value, str) and re.fullmatch(r"[0-9a-f]{16}", value)}
    elif event == "test":
        gates, suites = row.get("gates"), row.get("suites")
        if not isinstance(gates, list) or not gates or not all(
                isinstance(gate, str) and re.fullmatch(r"[a-z0-9-]{1,40}", gate) for gate in gates):
            return None
        clean.update(gates=gates, ok=row.get("ok") if row.get("ok") in (True, False, None) else None,
                     exit=row.get("exit") if type(row.get("exit")) is int else None, piped=row.get("piped") is True,
                     agent=name(row.get("agent")), suites=[s for s in suites if isinstance(s, str) and safe_path(s)
                                                            and len(s) <= 220][:20] if isinstance(suites, list) else [])
    elif event not in {"subagent_start", "session_end"}:
        return None
    return clean


def read_runs(session, root=ROOT):
    """Hook-recorded lifecycle for one Claude session; never contains prompts or output."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session):
        raise ValueError("Invalid Claude session id")
    runs = root / CLAUDE_RUNS
    path = runs / f"{session}.jsonl"
    events, malformed = [], 0
    found = (not runs.parent.is_symlink() and not runs.is_symlink() and path.is_file() and not path.is_symlink())
    for line in path.read_text().splitlines() if found else []:
        try:
            row = ledger_row(json.loads(line))
        except ValueError:
            row = None
        if row:
            events.append(row)
        else:
            malformed += 1
    return {"session": session, "found": found, "events": events, "malformed": malformed}


def stream_sessions(stream_text):
    """Discovered agents and failed subagent tasks in `claude -p --output-format stream-json` output.

    Only agent names, task IDs and the API error type are kept, never message text.
    """
    sessions = {}
    for line in stream_text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or not isinstance(event.get("session_id"), str):
            continue
        session = sessions.setdefault(event["session_id"], {"agents": [], "failed": {}})
        patch = event.get("patch") if isinstance(event.get("patch"), dict) else {}
        if event.get("subtype") == "init" and isinstance(event.get("agents"), list):
            session["agents"] = sorted(a for a in event["agents"] if isinstance(a, str))
        elif (event.get("subtype") == "task_updated" and patch.get("status") in {"failed", "killed"}
              and isinstance(event.get("task_id"), str)):
            error = re.search(r"error type ([a-z_]{1,40})", str(patch.get("error", "")))
            session["failed"][event["task_id"]] = error[1] if error else patch["status"]
    return {key: value for key, value in sessions.items() if value["agents"] or value["failed"]}


def review_summary(data, plan, runs, skips=None, reports=(), root=ROOT, streams=None):
    """Combine expected specialists with what hooks actually observed. Advisory only."""
    skips, streams = skips or {}, streams or {}
    agents, tests, denials, definitions, peak = {}, [], Counter(), [], 0
    for run in runs:
        running = set()
        for row in run["events"]:
            key = f"{run['session']}/{row.get('agentId')}"
            if row["event"] == "session_start" and isinstance(row.get("definitions"), dict):
                definitions.append((run["session"], row["definitions"]))
            elif row["event"] == "subagent_start":
                failure = streams.get(run["session"], {}).get("failed", {}).get(row.get("agentId"))
                agents[key] = {"agent": row.get("agent"), "status": "failed" if failure else "started",
                               "review": None, "error": failure}
                if str(row.get("agent")).startswith("flofi-"):
                    running.add(key)
                    peak = max(peak, len(running))
            elif row["event"] == "subagent_stop":
                agents.setdefault(key, {"agent": row.get("agent"), "status": "started", "review": None, "error": None})
                agents[key].update(status="completed", review=row.get("review"))
                running.discard(key)
            elif row["event"] == "test":
                tests.append(row)
            elif row["event"] == "guard_deny":
                denials[row.get("agent")] += 1
    current = {}
    for path in sorted(CLAUDE_AGENTS):
        target = root / path
        current[PurePosixPath(path).stem] = (hashlib.sha256(target.read_bytes()).hexdigest()[:16]
                                              if target.is_file() and not target.is_symlink() else None)
    rows, problems = [], []
    for domain in plan["domains"]:
        seen = [a for a in agents.values() if a["agent"] == domain]
        done = [a for a in seen if a["status"] == "completed"]
        failed = sorted({a["error"] for a in seen if a["status"] == "failed"})
        reviews = [a["review"] for a in done if isinstance(a["review"], dict)]
        status = ("completed" if done else "failed" if failed else "incomplete" if seen
                  else "skipped" if domain in skips else "not-invoked")
        rows.append({"domain": domain, "selectedBecause": plan.get("reasons", {}).get(domain, []),
                     "defined": current.get(domain) is not None,
                     "discovered": any(domain in s["agents"] for s in streams.values()) if streams else None,
                     "failures": failed,
                     "status": status, "invocations": len(seen), "completed": len(done),
                     "reviews": reviews, "unstructured": len(done) - len(reviews),
                     "skipReason": skips.get(domain), "guardDenials": denials.get(domain, 0)})
        if status == "failed":
            problems.append(f"{domain}: specialist failed ({', '.join(failed)}) without a review result")
        elif status == "incomplete":
            problems.append(f"{domain}: started without a recorded completion (failed, interrupted or still running)")
        elif status == "not-invoked":
            problems.append(f"{domain}: expected specialist not invoked and no skip justification")
        if any(review.get("result") == "blocked" for review in reviews):
            problems.append(f"{domain}: specialist reported its review as blocked")
    for test in tests:
        if test.get("ok") is False:
            problems.append(f"Recorded gate failed: {', '.join(test.get('gates', []))}")
    if peak > MAX_CONCURRENT_REVIEWS:
        problems.append(f"Observed {peak} concurrent flofi-* reviewers; the limit is {MAX_CONCURRENT_REVIEWS}")
    problems.extend(f"Unmapped maintained source: {path}" for path in plan["unmapped"])
    verified = []
    for stage, path in reports:
        errors = verify_results(data, json.loads(Path(path).read_text()), root, stage)
        verified.append({"stage": stage, "report": str(path), "errors": errors})
        problems.extend(errors)
    changed_definitions = {session: sorted(name for name, digest in recorded.items() if current.get(name) != digest)
                           for session, recorded in definitions}
    return {
        "base": plan.get("base"), "sessions": [{"session": r["session"], "found": r["found"],
                                                "events": len(r["events"]), "malformed": r["malformed"]} for r in runs],
        "documentationOnly": not plan["domains"] and not plan["modules"] and not plan["unmapped"],
        "specialists": rows, "discoveryObserved": sorted(s for s, v in streams.items() if v["agents"]),
        "unexpectedAgents": sorted({str(a["agent"]) for a in agents.values()} - set(plan["domains"])),
        "definitionsAtSessionStart": {session: len(recorded) for session, recorded in definitions},
        "definitionsChangedSince": {session: names for session, names in changed_definitions.items() if names},
        "peakConcurrentReviewers": peak, "tests": tests, "reports": verified,
        "gaps": plan["gaps"], "problems": problems,
        "evidence": ("Hook-observed lifecycle only. Delegation is model-driven and advisory; recorded gates are "
                     "shell exit statuses, not certification. CircleCI remains the certification authority."),
    }


def review_markdown(summary):
    lines = ["# FloFi Claude review summary", "", summary["evidence"], "",
             f"Base: `{summary['base']}`. Sessions: " + (", ".join(
                 f"`{s['session']}` ({s['events']} events{'' if s['found'] else ', no ledger'})"
                 for s in summary["sessions"]) or "none") + ".", ""]
    if summary["documentationOnly"]:
        lines += ["No maintained source, suite or governance contract changed: documentation-only, "
                  "specialist review not required.", ""]
    lines += ["## Changed domains and specialists", "",
              "| Domain | Selected because | Defined | Discovered | Status | Result |",
              "| --- | --- | --- | --- | --- | --- |"]
    for row in summary["specialists"]:
        result = "; ".join(f"{r.get('result')} ({r.get('findings')} findings, highest {r.get('highest')})"
                           for r in row["reviews"]) or ("unstructured" if row["unstructured"] else "")
        if row["status"] == "skipped":
            result = "Skipped: " + row["skipReason"]
        elif row["status"] == "failed":
            result = "Failed: " + ", ".join(row["failures"])
        if row["guardDenials"]:
            result += f"; {row['guardDenials']} guard denials"
        seen = {True: "yes", False: "no", None: "not observed"}
        lines.append(f"| {row['domain']} | {', '.join(row['selectedBecause'])} | {seen[row['defined']]} | "
                     f"{seen[row['discovered']]} | {row['status']} | {result or '—'} |")
    lines += ["", f"Agents invoked outside the plan: {', '.join(summary['unexpectedAgents']) or 'none'}.",
              f"Peak concurrent flofi-* reviewers: {summary['peakConcurrentReviewers']} (limit {MAX_CONCURRENT_REVIEWS}).",
              "Claude agent definitions recorded at session start: " + (", ".join(
                  f"{count} in `{session}`" for session, count in summary["definitionsAtSessionStart"].items()) or "none")
              + "; changed since: " + ("; ".join(f"{len(names)} since `{session}`"
                                                for session, names in summary["definitionsChangedSince"].items()) or "none")
              + ".", "", "## Tests recorded by hooks", ""]
    for test in summary["tests"]:
        state = {True: "passed", False: "failed", None: "result not observed"}[test.get("ok")]
        notes = (" (pipeline: status of the last command)" if test.get("piped") else "") + (
            f"; suites: {', '.join(test['suites'])}" if test.get("suites") else "")
        lines.append(f"- {', '.join(test.get('gates', []))} by {test.get('agent', 'main')}: {state}"
                     + (f", exit {test['exit']}" if test.get("exit") is not None else "") + notes)
    if not summary["tests"]:
        lines.append("- None recorded in these sessions.")
    for report in summary["reports"]:
        lines.append(f"- Required {report['stage']} suites in `{report['report']}`: "
                     + ("PASS" if not report["errors"] else "FAIL: " + "; ".join(report["errors"])))
    gaps = summary["gaps"]
    lines += ["", "## Coverage gaps in affected modules", ""]
    if len(gaps) > 15:
        lines.append(f"{len(gaps)} affected modules declare gaps: {', '.join(gaps)}. Full text: `--json`.")
    else:
        lines += [f"- {module}: {'; '.join(items)}" for module, items in gaps.items()] or ["- None."]
    lines += ["", "## Problems and unresolved reviews", ""]
    lines += [f"- {problem}" for problem in summary["problems"]] or ["- None."]
    return "\n".join(lines) + "\n"


def claude_sync(root=ROOT, write=False, overwrite=False):
    """Generate missing Claude twins; never replace a differing file without --overwrite."""
    drift, messages = False, []
    for domain in DOMAINS:
        path = f".claude/agents/{domain}.md"
        expected = claude_agent_text(tomllib.loads((root / f".codex/agents/{domain}.toml").read_text()))
        target = root / path
        if target.is_symlink():
            raise ValueError(f"{path}: symlink refused")
        current = target.read_text() if target.is_file() else None
        if current == expected:
            continue
        if current is not None and not overwrite:
            drift = True
            messages.extend(difflib.unified_diff(current.splitlines(), expected.splitlines(),
                                                 f"{path} (current)", f"{path} (generated)", lineterm=""))
            messages.append(f"{path}: differs from the generated twin; not overwritten. Move intended text into "
                            "the Codex definition or generator, or pass --overwrite after reviewing the diff.")
        elif write or overwrite:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(expected)
            messages.append(f"Wrote {path}")
        else:
            drift = True
            messages.append(f"{path}: missing")
    return drift, messages


def changed_paths(base, root=ROOT):
    merge_base = subprocess.check_output(["git", "merge-base", "HEAD", base], cwd=root, text=True).strip()
    changed = subprocess.check_output(["git", "diff", "--name-only", "-z", merge_base], cwd=root).decode().split("\0")
    changed += subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
    return merge_base, sorted(set(filter(None, changed)))


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
    parser.add_argument("command", choices=["check", "impact", "report", "verify-results", "domain", "review", "claude-agents"])
    parser.add_argument("result_file", nargs="?", help="verify-results: Vitest JSON report; domain: domain ID")
    parser.add_argument("--base", help="Explicit Git ref to compare using merge-base; no network fetch")
    parser.add_argument("--stage", choices=["unit", "postgres"], default="unit", help="Test report's existing certification stage")
    parser.add_argument("--session", action="append", help="review: Claude session ID (default $CLAUDE_CODE_SESSION_ID)")
    parser.add_argument("--skip", action="append", default=[], metavar="DOMAIN=REASON", help="review: justified skipped specialist")
    parser.add_argument("--unit-report", help="review: fresh Vitest JSON report to verify for required unit suites")
    parser.add_argument("--postgres-report", help="review: fresh Vitest JSON report for required PostgreSQL suites")
    parser.add_argument("--stream-json", action="append", default=[], help="review: claude -p stream-json output (discovery and session ID)")
    parser.add_argument("--json", action="store_true", help="review: print JSON instead of Markdown")
    parser.add_argument("--strict", action="store_true", help="review: exit 1 on unresolved reviews or failures")
    parser.add_argument("--write", action="store_true", help="claude-agents: create missing generated agents")
    parser.add_argument("--overwrite", action="store_true", help="claude-agents: also replace differing agents")
    # Python 3.12.3 (CircleCI) otherwise leaves the optional result positional
    # unconsumed in `verify-results --stage postgres report.json`.
    args = parser.parse_intermixed_args()
    if args.command == "claude-agents":
        drift, messages = claude_sync(write=args.write, overwrite=args.overwrite)
        print("\n".join(messages or ["Claude agents: 19 generated twins match their Codex definitions"]))
        return int(drift)
    data = load()
    if args.command == "verify-results":
        if not args.result_file:
            parser.error("verify-results requires the fresh Vitest JSON report path")
        errors = verify_results(data, json.loads(Path(args.result_file).read_text()), stage=args.stage)
    elif args.command in {"impact", "domain", "review"}:
        if args.command != "domain" and not args.base:
            parser.error(f"{args.command} requires an explicit --base ref")
        if args.command == "domain" and not args.result_file:
            parser.error("domain requires a FloFi domain ID")
        merge_base, changed = changed_paths(args.base) if args.base else (None, None)
        if args.command == "domain":
            print(json.dumps(domain_contract(data, args.result_file, changed), indent=2))
            return 0
        result = impact(data, changed)
        if args.command == "impact":
            print(json.dumps(result, indent=2))
            return int(bool(result["unmapped"]))
        streams = {}
        for path in args.stream_json:
            streams.update(stream_sessions(Path(path).read_text()))
        sessions = args.session or sorted(streams) or [os.environ.get("CLAUDE_CODE_SESSION_ID", "")]
        if not all(sessions):
            parser.error("review requires --session when CLAUDE_CODE_SESSION_ID is not set")
        skips = dict(item.split("=", 1) for item in args.skip if "=" in item and item.split("=", 1)[1].strip())
        if len(skips) != len(args.skip) or set(skips) - set(DOMAINS):
            parser.error("--skip takes DOMAIN=REASON with a known domain and a non-empty reason")
        reports = [(stage, path) for stage, path in (("unit", args.unit_report), ("postgres", args.postgres_report)) if path]
        summary = review_summary(data, {**result, "base": f"{args.base} ({merge_base[:12]})"},
                                 [read_runs(session) for session in sessions], skips, reports, streams=streams)
        print(json.dumps(summary, indent=2) if args.json else review_markdown(summary), end="\n" if args.json else "")
        return int(args.strict and bool(summary["problems"]))
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
