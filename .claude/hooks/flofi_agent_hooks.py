#!/usr/bin/env python3
"""FloFi Claude Code hooks: Read-only reviewer guard and local lifecycle ledger.

guard  (PreToolUse, onFailure=block): only for agents named flofi-*. Specialists have
       no shell: every tool except Read is denied, and Read must name a file inside
       the repository that is not reached through .., not in .git, not Git-ignored and
       not named like a secret. Other agents and the main session are untouched.
record (lifecycle and Bash results): appends minimal metadata to the Git-ignored
       .claude/flofi-agent-runs/<session>.jsonl. Never stores prompts, commands,
       tool output, transcripts or wallet data; never prints and never blocks.

Standard library only, no network. Set FLOFI_AGENT_TELEMETRY=off to disable record.
"""

import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUNS = ".claude/flofi-agent-runs"
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
SAFE_AGENT = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
REVIEW_TOOLS = {"Read"}  # specialists have no shell, search or write tools
SENSITIVE_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", ".credentials.json",
                   "credentials.db", "application_default_credentials.json", ".netrc", "disposable-phrase",
                   ".mode-a", ".public-testnet", "flofi-agent-runs"}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")
RESULT = re.compile(r'FLOFI_REVIEW_RESULT (\{.*\})')
LEDGER_LIMIT = 1 << 20


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
TEST_PATH = re.compile(r"[A-Za-z0-9_./@-]{1,200}\.(?:test|spec)\.tsx?")


def sensitive(part):
    lower = part.lower()
    return ((lower.startswith(".env") and lower != ".env.example") or lower in SENSITIVE_NAMES
            or lower.endswith(SENSITIVE_SUFFIXES) or lower.startswith("alchemy-key"))


def read_reason(value, root=ROOT):
    """Fail-closed path rule for a specialist's Read."""
    if not isinstance(value, str) or not value or "\0" in value or value.startswith("~"):
        return "Read needs a repository file path"
    written = PurePosixPath(value)
    if ".." in written.parts:
        return "paths must not contain .. components"
    try:
        resolved = (Path(value) if written.is_absolute() else root / value).resolve()  # follows symlinks
        relative = resolved.relative_to(root.resolve())
    except (OSError, RuntimeError, ValueError):
        return "paths outside the repository are not readable"
    if any(part.lower() == ".git" for part in relative.parts):
        return "Git internals are not readable"
    if any(sensitive(part) for part in (*written.parts, *relative.parts)):
        return "secret or local-state paths are not readable"
    if relative.parts:
        ignored = subprocess.run(["git", "check-ignore", "-q", "--", str(relative)], cwd=root,
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        if ignored.returncode != 1:  # 0 ignored, 128 error: both refuse
            return "Git-ignored local state is not readable"
    return None


def guard_reason(event, root=ROOT):
    agent = event.get("agent_type") or ""
    if not isinstance(agent, str) or not agent.startswith("flofi-"):
        return None
    tool, tool_input = event.get("tool_name"), event.get("tool_input")
    if tool not in REVIEW_TOOLS or not isinstance(tool_input, dict):
        return f"{tool} is not available to FloFi reviewers, which only Read; ask the main session"
    return read_reason(tool_input.get("file_path"), root)


def append(session, record, root=ROOT):
    """Owner-only append; refuses symlinks, hard links and foreign-owned ledgers."""
    if os.environ.get("FLOFI_AGENT_TELEMETRY") == "off" or not isinstance(session, str) or not SAFE_ID.fullmatch(session):
        return
    runs = root / RUNS
    if runs.parent.is_symlink() or not runs.parent.is_dir() or runs.is_symlink():
        return
    try:
        os.mkdir(runs, 0o700)
    except FileExistsError:
        pass
    record = {"v": 2, "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
    directory = os.open(runs, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(directory).st_uid != os.geteuid():
            return
        os.fchmod(directory, 0o700)
        # O_NONBLOCK: a FIFO planted at the ledger path fails instead of hanging the hook.
        try:
            descriptor = os.open(f"{session}.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW
                                 | os.O_NONBLOCK, 0o600, dir_fd=directory)
        except OSError:  # symlink, FIFO without reader or other refusal
            return
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
                    or info.st_size > LEDGER_LIMIT):
                return
            os.fchmod(descriptor, 0o600)
            os.write(descriptor, (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)


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
        return review_fields(value) if isinstance(value, dict) and value.get("domain") == agent else None
    return None


def review_fields(value):
    """A self-consistent result: no-findings is 0/none, findings is at least 1 below none."""
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


def suite_path(token, root=ROOT):
    """Repository-relative test path only; absolute paths would expose the local user."""
    if not TEST_PATH.fullmatch(token) or ".." in token.split("/"):
        return None
    if token.startswith("/"):
        try:
            return str(Path(token).relative_to(root.resolve()))
        except ValueError:
            return None
    return token


def command_parts(command):
    """Quote-aware split of a main-session command line into (segment, separator) pairs.

    Telemetry only: it classifies which test gates the main session ran. It is not a
    security boundary; specialists cannot run commands at all.
    """
    parts, current, quote, index = [], [], None, 0
    while index < len(command):
        char, pair = command[index], command[index:index + 2]
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"' and index + 1 < len(command):
                current.append(command[index + 1])
                index += 1
        elif char == "\\" and index + 1 < len(command):
            current.append(command[index:index + 2])
            index += 1
        elif char in "'\"":
            quote = char
            current.append(char)
        elif char == "#" and (not current or current[-1][-1:].isspace()):
            while index + 1 < len(command) and command[index + 1] != "\n":
                index += 1  # an unquoted word-initial # starts a comment
        elif pair in {"&&", "||"}:
            parts.append(("".join(current), pair))
            current = []
            index += 1
        elif pair in {">&", "&>"} or (char == "&" and command[index - 1:index] == ">"):
            current.append(char)  # redirections such as 2>&1 are not separators
        elif char in ";&|\n":
            parts.append(("".join(current), char))
            current = []
        else:
            current.append(char)
        index += 1
    parts.append(("".join(current), ""))
    return parts


NEUTRAL_ARGUMENTS = ("--reporter=", "--outputFile=", "--testTimeout=", "--maxWorkers=")


def scope_key(root=ROOT):
    """Per-checkout HMAC key for run identities (owner-only file beside the ledger)."""
    runs = root / RUNS
    if runs.parent.is_symlink() or not runs.parent.is_dir() or runs.is_symlink():
        return None
    try:
        os.mkdir(runs, 0o700)
    except FileExistsError:
        pass
    except OSError:
        return None
    path = runs / ".scope-key"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(os.urandom(32))
    except FileExistsError:
        pass
    except OSError:
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            key = stream.read(64)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or len(key) != 32:
        return None
    return key


def gate_scope(gate, words, place, root=ROOT):
    """The exact identity of a gate run: gate, working directory and every filtering argument.

    A keyed digest, so it never stores paths or names and cannot be confirmed by guessing.
    Only a later pass with the same identity clears a failure.
    """
    material = [w for w in words if not w.startswith(NEUTRAL_ARGUMENTS)]
    if gate == "agent-guard-verify-results":
        material = [w for w in material if not w.endswith(".json")]  # the fresh report path, not a filter
    key = scope_key(root)
    if key is None:
        return "unknown"
    return "run-" + hmac.new(key, "\0".join([gate, place, *material]).encode(), "sha256").hexdigest()[:12]


def gate_record(event, root=ROOT):
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    parts = command_parts(command)
    separators = [separator for _segment, separator in parts if separator]
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else ""
    try:
        place = str(Path(cwd).resolve().relative_to(root.resolve()))
    except (OSError, ValueError):
        place = "outside"
    gates, suites, scopes = [], [], {}
    for segment, _separator in parts:
        moved = re.fullmatch(r"\s*cd\s+(\S+)\s*", segment)
        if moved:
            place = f"{place}|cd {moved[1]}"  # the gate runs wherever the line moved to
            continue
        head = re.sub(r"^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:timeout \d+[smh]? )?)", "", segment)
        head = re.sub(r"(?<!\S)2>(?:/dev/null|&1)(?!\S)", " ", head).strip()
        if re.fullmatch(r"node scripts/guarded-release-browser\.mjs (?:list|--help)", head):
            continue  # prints the plan; runs nothing
        for gate, pattern in GATES:
            if re.fullmatch(pattern, head):
                gates.append(gate)
                scopes[gate] = gate_scope(gate, head.split(), place, root)
                suites += [path for path in (suite_path(token, root) for token in head.split()) if path]
    if not gates:
        return None
    piped = "|" in separators
    record = {"event": "test", "gates": sorted(set(gates)), "piped": piped, "suites": sorted(set(suites))[:20],
              "scopes": dict(sorted(scopes.items())),
              "agent": agent_fields(event)["agent"] if event.get("agent_type") else "main"}
    if tool_input.get("run_in_background"):
        return {**record, "ok": None, "exit": None}
    if event.get("hook_event_name") == "PostToolUseFailure":
        code = re.match(r"Exit code (\d+)", str(event.get("error", "")))
        if not separators:
            return {**record, "ok": False, "exit": int(code[1]) if code else None}
        return {**record, "ok": None, "exit": None}  # another command may have failed or stopped the gate
    response = event.get("tool_response") if isinstance(event.get("tool_response"), dict) else {}
    if response.get("interrupted"):
        return {**record, "ok": False, "exit": None}
    # Only an all-&& chain lets one exit status speak for each gate in it.
    certain = all(separator == "&&" for separator in separators)
    return {**record, "ok": True, "exit": 0} if certain else {**record, "ok": None, "exit": None}


def worktree_state(root=ROOT):
    """The commit a specialist reviewed, and whether uncommitted changes were present.

    A failed or slow Git call yields unknown (None), never "clean", and never drops the row.
    """
    def git(*args):
        try:
            result = subprocess.run(["git", "--no-optional-locks", *args], cwd=root, stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=5,
                                    env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout if result.returncode == 0 else None
    head, status = git("rev-parse", "HEAD"), git("status", "--porcelain")
    head = head.strip() if head else ""
    return {"head": head if re.fullmatch(r"[0-9a-f]{40}", head) else None,
            "dirty": None if status is None else bool(status.strip())}


def record(event, root=ROOT):
    name, session = event.get("hook_event_name"), event.get("session_id")
    if name == "SessionStart":
        definitions = {}
        for path in sorted((root / ".claude/agents").glob("flofi-*.md")):
            if path.is_file() and not path.is_symlink():
                definitions[path.stem] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        source = event.get("source")
        append(session, {"event": "session_start", "definitions": definitions,
                         "head": worktree_state(root)["head"],
                         "source": source if source in {"startup", "resume", "clear", "compact", "fork"} else "other"}, root)
    elif name == "SubagentStart" and event.get("agent_type"):
        append(session, {"event": "subagent_start", **agent_fields(event), **worktree_state(root)}, root)
    elif name == "SubagentStop" and event.get("agent_type"):
        fields = agent_fields(event)
        append(session, {"event": "subagent_stop", **fields, **worktree_state(root),
                         "review": review_result(fields["agent"], event.get("last_assistant_message"))}, root)
    elif name == "SessionEnd":
        reason = event.get("reason")
        append(session, {"event": "session_end", "reason": reason if reason in {
            "clear", "resume", "logout", "prompt_input_exit", "other"} else "other"}, root)
    elif name in {"PostToolUse", "PostToolUseFailure"} and event.get("tool_name") == "Bash":
        entry = gate_record(event, root)
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
    try:
        event = json.load(sys.stdin)
    except ValueError:
        event = None
    decision = guard(event)
    if decision:
        print(json.dumps(decision))
    return 0


def guard(event, root=ROOT):
    """Deny explicitly on any internal error, independent of the hook's onFailure setting."""
    try:
        reason = guard_reason(event, root) if isinstance(event, dict) else "unreadable hook input"
    except Exception:
        reason = "the guard could not evaluate this call"
    if not reason:
        return None
    try:
        append(event.get("session_id"), {"event": "guard_deny", **agent_fields(event),
                                         "tool": "Read" if event.get("tool_name") == "Read" else "other"}, root)
    except Exception:  # The denial below must still be returned.
        pass
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": f"FloFi read-only review guard: {reason}. Report it to the main session; "
                                    "it runs commands, searches and tests and makes any changes."}}


if __name__ == "__main__":
    sys.exit(main())
