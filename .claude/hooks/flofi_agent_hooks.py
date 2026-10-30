#!/usr/bin/env python3
"""FloFi Claude Code hooks: read-only reviewer guard and local lifecycle ledger.

guard  (PreToolUse, onFailure=block): only for agents named flofi-*. Allows Read/
       Grep/Glob and an allowlist of repository-scoped read-only shell commands;
       denies everything else. Other agents and the main session are untouched.
record (lifecycle and Bash results): appends minimal metadata to the Git-ignored
       .claude/flofi-agent-runs/<session>.jsonl. Never stores prompts, commands,
       tool output, transcripts or wallet data; never prints and never blocks.

Standard library only, no network. Set FLOFI_AGENT_TELEMETRY=off to disable record.
"""

import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUNS = ".claude/flofi-agent-runs"
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
SAFE_AGENT = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
READ_ONLY_TOOLS = {"Read", "Grep", "Glob", "Bash"}
GIT_READ = {"diff", "log", "show", "status", "ls-files", "grep", "rev-parse", "merge-base", "blame",
            "cat-file", "ls-tree", "diff-tree", "rev-list", "shortlog", "describe", "name-rev"}
GIT_DENY = ("--output", "--ext-diff", "--no-index", "-O", "--open-files-in-pager", "--no-exclude-standard")
COMMANDS = {"cat", "head", "tail", "wc", "ls", "cut", "tr", "nl", "sort", "diff", "stat", "basename",
            "dirname", "realpath", "pwd", "jq", "rg", "grep", "find", "sed", "git", "python3"}
# Long options are matched by prefix; letters are refused inside short-option bundles.
DENY_LONG = {"rg": ("--pre", "--follow", "--unrestricted", "--no-ignore", "--search-zip"),
             "grep": ("--recursive", "--dereference-recursive", "--directories", "--devices"),
             "tail": ("--follow", "--retry"), "sort": ("--output", "--compress-program", "--temporary-directory")}
DENY_SHORT = {"rg": "uLz", "grep": "rRdD", "tail": "fF", "sort": "oT"}
FIND_DENY = {"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls", "-L", "-follow"}
GUARD_SCRIPTS = {"check", "impact", "report", "domain"}
SENSITIVE_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", ".credentials.json",
                   "credentials.db", "application_default_credentials.json", ".netrc", "disposable-phrase",
                   ".mode-a", ".public-testnet", "flofi-agent-runs"}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")
REDIRECTS = re.compile(r"(?<!\S)2>(?:/dev/null|&1)(?!\S)")
RESULT = re.compile(r'FLOFI_REVIEW_RESULT (\{.*\})')
GATES = (
    ("pnpm-check", r"pnpm check"), ("pnpm-typecheck", r"pnpm typecheck"), ("pnpm-lint", r"pnpm lint"),
    ("pnpm-build", r"pnpm build"), ("pnpm-schemas-check", r"pnpm schemas:check"),
    ("pnpm-test", r"pnpm test(?: .*)?"), ("pnpm-test-postgres", r"pnpm test:postgres(?: .*)?"),
    ("pnpm-test-fork", r"pnpm test:fork(?: .*)?"), ("pnpm-test-anvil", r"pnpm test:anvil(?: .*)?"),
    ("vitest-focused", r"pnpm (?:--filter \S+ )?(?:exec )?vitest run .+"),
    ("agent-guard-check", r"python3 scripts/agent_guard\.py check"),
    ("agent-guard-verify-results", r"python3 scripts/agent_guard\.py verify-results .+"),
    ("governance-lite", r"python3 scripts/governance_lite\.py"),
    ("governance-unittests", r"python3 -m unittest discover -s scripts -p '?test_(?:ci_\*|governance_lite)\.py'?"),
    ("guarded-browser", r"node scripts/guarded-release-browser\.mjs [a-z0-9-]+.*"),
    ("claude-agent-probe", r"python3 scripts/verify_claude_agents\.py.*"),
    ("codex-agent-probe", r"python3 scripts/verify_codex_agents\.py"),
)
TEST_PATH = re.compile(r"[A-Za-z0-9_./@-]+\.(?:test|spec)\.tsx?")


def sensitive(part):
    lower = part.lower()
    return ((lower.startswith(".env") and lower != ".env.example") or lower in SENSITIVE_NAMES
            or lower.endswith(SENSITIVE_SUFFIXES) or lower.startswith("alchemy-key"))


def path_reason(value, cwd, root=ROOT):
    if not isinstance(value, str) or not value or "\0" in value:
        return "invalid path"
    if value.startswith("~"):
        return "home-directory paths are outside the repository"
    try:
        resolved = (Path(cwd) / value).resolve()
        relative = resolved.relative_to(root.resolve())
    except (OSError, RuntimeError, ValueError):
        return "paths outside the repository are not readable"
    if ".git" in relative.parts:
        return "Git internals are not readable"
    if any(sensitive(part) for part in relative.parts):
        return "secret or local-state paths are not readable"
    if relative.parts and "node_modules" not in relative.parts:
        ignored = subprocess.run(["git", "check-ignore", "-q", "--", str(relative)], cwd=root,
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        if ignored.returncode != 1:
            return "Git-ignored local state is not readable"
    return None


def candidate_paths(token, cwd):
    """Tokens that the shell or the tool may treat as files, including glob expansions."""
    values = [token.split("=", 1)[1]] if token.startswith("-") and "=" in token else [token]
    found = []
    for value in values:
        if any(char in value for char in "*?["):
            found += [match for match in glob.glob(value, root_dir=cwd, include_hidden=True)]
        if (value.startswith(("/", "~", ".")) or "/" in value or (Path(cwd) / value).exists()):
            found.append(value)
    return found


def unquoted_reason(command):
    quote, index = None, 0
    while index < len(command):
        char = command[index]
        if quote == "'":
            if char == "'":
                quote = None
        elif char == "\\":
            index += 1
            if index < len(command) and command[index] in "\n\r":
                return "line continuations are not allowed"
        elif char in "$`":
            return "shell expansion is not allowed"
        elif quote == '"':
            if char == '"':
                quote = None
        elif char in "'\"":
            quote = char
        elif char in ";&<>(){}\n\r":
            return "command chaining, redirection, subshells and background jobs are not allowed"
        index += 1
    return "unterminated quote" if quote else None


def option_reason(name, args):
    for arg in args:
        if arg.startswith("--") and arg.startswith(DENY_LONG.get(name, ())):
            return f"{name} {arg.split('=', 1)[0]} is not allowed"
        if arg.startswith("-") and not arg.startswith("--") and set(arg[1:]) & set(DENY_SHORT.get(name, "")):
            return f"{name} {arg} is not allowed"
    return None


def segment_reason(argv, cwd, root=ROOT):
    name, args = argv[0], argv[1:]
    if name not in COMMANDS:
        return f"{name} is not an allowed read-only inspection command"
    if name == "git":
        while args and args[0] == "--no-pager":
            args = args[1:]
        if not args or args[0] not in GIT_READ:
            return "only read-only git subcommands without global options are allowed"
        if any(arg.startswith(GIT_DENY) for arg in args[1:]):
            return "git output files, external diff, no-index and pager options are not allowed"
        for arg in args[1:]:
            value = arg.split("=", 1)[1] if arg.startswith("-") and "=" in arg else arg
            if value.startswith(("/", "~")) or ".." in value.split("/"):
                reason = path_reason(value, cwd, root)
                if reason:
                    return reason
        return None
    if name == "python3":
        script = (Path(cwd) / args[0]).resolve() if args else None
        if (script != root.resolve() / "scripts/agent_guard.py" or len(args) < 2 or args[1] not in GUARD_SCRIPTS
                or any(not re.fullmatch(r"[A-Za-z0-9_./@^~:=-]+", arg) for arg in args[2:])):
            return "python3 may only run scripts/agent_guard.py check, impact, report or domain"
    if name == "find" and FIND_DENY & set(args):
        return "find actions that execute, delete, write or follow links are not allowed"
    if name == "sed" and (len(args) < 3 or args[0] != "-n" or not re.fullmatch(r"(?:\d+|\$)(?:,(?:\d+|\$))?p", args[1])
                          or any(arg.startswith("-") for arg in args[2:])):
        return "sed is limited to sed -n 'N,Mp' FILE..."
    reason = option_reason(name, args)
    if reason:
        return reason
    for arg in args[1:] if name == "python3" else args:
        for value in candidate_paths(arg, cwd):
            reason = path_reason(value, cwd, root)
            if reason:
                return reason
    return None


def bash_reason(tool_input, cwd, root=ROOT):
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip() or len(command) > 4000:
        return "empty or oversized command"
    if tool_input.get("run_in_background"):
        return "background commands are not allowed"
    command = REDIRECTS.sub(" ", command)
    reason = unquoted_reason(command)
    if reason:
        return reason
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars="|")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return "unparseable command"
    segments, current = [], []
    for token in tokens:
        if token == "|":
            segments.append(current)
            current = []
        elif set(token) == {"|"}:
            return "only simple pipes are allowed"
        else:
            current.append(token)
    segments.append(current)
    if any(not segment or "=" in segment[0] for segment in segments):
        return "empty pipeline stages and environment assignments are not allowed"
    for segment in segments:
        reason = segment_reason(segment, cwd, root)
        if reason:
            return reason
    return None


def guard_reason(event, root=ROOT):
    agent = event.get("agent_type") or ""
    if not isinstance(agent, str) or not agent.startswith("flofi-"):
        return None
    tool, tool_input = event.get("tool_name"), event.get("tool_input") or {}
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else str(root)
    if path_reason(cwd, root, root):
        cwd = str(root)
    if tool not in READ_ONLY_TOOLS or not isinstance(tool_input, dict):
        return f"{tool} is not available to read-only FloFi reviewers"
    if tool == "Bash":
        return bash_reason(tool_input, cwd, root)
    if tool == "Read":
        return path_reason(tool_input.get("file_path"), cwd, root)
    pattern = tool_input.get("pattern") if tool == "Glob" else None
    if isinstance(pattern, str) and (pattern.startswith(("/", "~")) or ".." in pattern.split("/")):
        return "glob patterns must stay inside the repository"
    return path_reason(tool_input.get("path") or ".", cwd, root)


def append(session, record, root=ROOT):
    if os.environ.get("FLOFI_AGENT_TELEMETRY") == "off" or not SAFE_ID.fullmatch(session or ""):
        return
    runs = root / RUNS
    if runs.parent.is_symlink() or runs.is_symlink():
        return
    runs.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"v": 1, "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
    descriptor = os.open(runs / f"{session}.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
    finally:
        os.close(descriptor)


def agent_fields(event):
    agent, agent_id = event.get("agent_type"), event.get("agent_id")
    return {"agent": agent if isinstance(agent, str) and SAFE_AGENT.fullmatch(agent) else "other",
            "agentId": agent_id if isinstance(agent_id, str) and SAFE_ID.fullmatch(agent_id) else None}


def review_result(agent, message):
    """Only the validated machine-readable trailer survives; the text never does."""
    if not isinstance(message, str):
        return None
    for line in [line.strip().strip("`").strip() for line in message.strip().splitlines() if line.strip()][-5:][::-1]:
        match = RESULT.fullmatch(line)
        if not match:
            continue
        try:
            value = json.loads(match[1])
        except ValueError:
            return None
        findings = value.get("findings") if isinstance(value, dict) else None
        if (value.get("domain") == agent and value.get("result") in {"findings", "no-findings", "blocked"}
                and type(findings) is int and 0 <= findings <= 999
                and value.get("highest") in {"critical", "high", "medium", "low", "none"}):
            return {"result": value["result"], "findings": findings, "highest": value["highest"]}
        return None
    return None


def gate_record(event):
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    gates, suites, piped = [], [], False
    for segment in re.split(r"&&|\|\||;|\n", command):
        stages = segment.split("|")
        head = re.sub(r"^\s*(?:cd \S+\s*$|(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:timeout \d+[smh]? )?)", "", stages[0]).strip()
        head = REDIRECTS.sub(" ", head).strip()
        for gate, pattern in GATES:
            if re.fullmatch(pattern, head):
                gates.append(gate)
                piped = piped or len(stages) > 1
                suites += [token for token in head.split() if TEST_PATH.fullmatch(token) and ".." not in token]
    if not gates:
        return None
    record = {"event": "test", "gates": sorted(set(gates)), "piped": piped, "suites": sorted(set(suites))[:20],
              "agent": agent_fields(event)["agent"] if event.get("agent_type") else "main"}
    if tool_input.get("run_in_background"):
        return {**record, "ok": None, "exit": None}
    if event.get("hook_event_name") == "PostToolUseFailure":
        code = re.match(r"Exit code (\d+)", str(event.get("error", "")))
        return {**record, "ok": False, "exit": int(code[1]) if code else None}
    response = event.get("tool_response") if isinstance(event.get("tool_response"), dict) else {}
    return {**record, "ok": not response.get("interrupted"), "exit": None if response.get("interrupted") else 0}


def record(event, root=ROOT):
    name, session = event.get("hook_event_name"), event.get("session_id")
    if name == "SessionStart":
        definitions = {}
        for path in sorted((root / ".claude/agents").glob("flofi-*.md")):
            if path.is_file() and not path.is_symlink():
                definitions[path.stem] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        source = event.get("source")
        append(session, {"event": "session_start", "definitions": definitions,
                         "source": source if source in {"startup", "resume", "clear", "compact", "fork"} else "other"}, root)
    elif name == "SubagentStart" and event.get("agent_type"):
        append(session, {"event": "subagent_start", **agent_fields(event)}, root)
    elif name == "SubagentStop" and event.get("agent_type"):
        fields = agent_fields(event)
        append(session, {"event": "subagent_stop", **fields,
                         "review": review_result(fields["agent"], event.get("last_assistant_message"))}, root)
    elif name == "SessionEnd":
        reason = event.get("reason")
        append(session, {"event": "session_end", "reason": reason if reason in {
            "clear", "resume", "logout", "prompt_input_exit", "other"} else "other"}, root)
    elif name in {"PostToolUse", "PostToolUseFailure"} and event.get("tool_name") == "Bash":
        entry = gate_record(event)
        if entry:
            append(session, entry, root)


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode == "record":
        try:
            record(json.load(sys.stdin))
        except Exception:  # Observability must never interrupt a session.
            pass
        return 0
    if mode != "guard":
        return 1
    event = json.load(sys.stdin)  # Malformed input fails closed through onFailure=block.
    reason = guard_reason(event)
    if reason:
        try:
            append(event.get("session_id"), {"event": "guard_deny", **agent_fields(event),
                                             "tool": event.get("tool_name") if event.get("tool_name") in READ_ONLY_TOOLS else "other"})
        except Exception:  # The denial below must still be returned.
            pass
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": f"FloFi read-only review guard: {reason}. Report it to the main session; "
                                        "it runs tests and makes any changes."}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
