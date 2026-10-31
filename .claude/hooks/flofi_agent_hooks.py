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

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUNS = ".claude/flofi-agent-runs"
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
SAFE_AGENT = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
READ_ONLY_TOOLS = {"Read", "Grep", "Glob", "Bash"}
GUARD_SCRIPTS = {"check", "impact", "report", "domain"}
SENSITIVE_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", ".credentials.json",
                   "credentials.db", "application_default_credentials.json", ".netrc", "disposable-phrase",
                   ".mode-a", ".public-testnet", "flofi-agent-runs"}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")
RESULT = re.compile(r'FLOFI_REVIEW_RESULT (\{.*\})')
LEDGER_LIMIT = 1 << 20


def options(flags="", valued="", longs="", long_valued="", numeric=False, numbers=""):
    """An explicit option allowlist. Anything else, abbreviations included, is refused:
    GNU tools and git accept unambiguous prefixes, and Claude Code's grep (ugrep) and
    find (bfs) add pager, filter and exec options of their own. `numbers` lists options
    whose value must be a count (ugrep's optional-argument context options would
    otherwise take a directory operand as their value)."""
    return {"flags": set(flags), "valued": set(valued), "longs": set(longs.split()),
            "long_valued": set(long_valued.split()), "numeric": numeric, "numbers": set(numbers.split())}


COUNT = re.compile(r"[+-]?\d{1,9}[KMGkmgb]?")
PATTERN_OPTIONS = {"-e", "--regexp"}


COMMANDS = {
    "cat": options("nAbeEsStTuv"), "wc": options("lwcmL"), "ls": options("laA1RhdFStrpi"),
    "head": options("qv", "nc", "", "--lines --bytes", numeric=True, numbers="-n -c --lines --bytes"),
    "tail": options("qv", "nc", "", "--lines --bytes", numeric=True, numbers="-n -c --lines --bytes"),
    "cut": options("s", "dfcb", "", "--delimiter --fields --characters --bytes"), "tr": options("dsc"),
    "sort": options("nrufbhVMg", "kt", "", "--key --field-separator"), "stat": options("L", "c", "", "--format"),
    "basename": options(), "dirname": options(), "realpath": options("e"), "pwd": options(),
    "grep": options("nilLcwxvohHEFsq", "eABCm", "--line-number --ignore-case --files-with-matches --count "
                    "--word-regexp --line-regexp --invert-match --only-matching --extended-regexp --fixed-strings "
                    "--no-filename --with-filename", "--regexp --after-context --before-context --context --max-count",
                    numbers="-A -B -C -m --after-context --before-context --context --max-count"),
    # No -g/--glob (overrides .gitignore), --hidden (.git), -u, --pre, -L or -z.
    "rg": options("nNiSslcwxvoFUHIq", "eABCmtTM", "--line-number --no-line-number --ignore-case --smart-case "
                  "--case-sensitive --files --files-with-matches --files-without-match --count --count-matches "
                  "--word-regexp --line-regexp --invert-match --only-matching --fixed-strings --multiline --heading "
                  "--no-heading --with-filename --no-filename --column --vimgrep --json --stats --trim --quiet",
                  "--regexp --after-context --before-context --context --max-count --type --type-not --sort --sortr "
                  "--max-columns --max-depth --max-filesize",
                  numbers="-A -B -C -m -M --after-context --before-context --context --max-count --max-columns "
                  "--max-depth --max-filesize"),
}
FILE_COMMANDS = {"cat", "head", "tail", "wc", "cut", "sort", "grep", "sed"}  # files only: ugrep recurses directories
_DIFF = ("--stat --shortstat --numstat --name-only --name-status --summary --patch --no-patch --no-color "
         "--no-renames --cached --staged --merge-base --ignore-all-space --ignore-space-change --word-diff --raw "
         "--minimal --patience --histogram --find-renames --check --no-ext-diff --no-textconv --full-index --color ")
_DIFF_VALUED = "--diff-filter --unified --color --word-diff --stat "
_LOG = ("--oneline --graph --decorate --no-decorate --first-parent --no-merges --merges --follow --reverse "
        "--abbrev-commit --all --topo-order --date-order ")
_LOG_VALUED = "--max-count --skip --since --until --after --before --author --committer --grep --format --pretty --date --abbrev "
GIT = {
    "diff": options("pswbRM", "U", _DIFF, _DIFF_VALUED, numbers="-U --unified"),
    "log": options("pswbM", "nSGU", _DIFF + _LOG, _DIFF_VALUED + _LOG_VALUED, numeric=True,
                   numbers="-n -U --unified --max-count --skip"),
    "show": options("pswbM", "U", _DIFF + "--oneline --abbrev-commit", _DIFF_VALUED + "--format --pretty --date --abbrev",
                    numbers="-U --unified"),
    "diff-tree": options("rpsM", "U", _DIFF + "--no-commit-id --root", _DIFF_VALUED, numbers="-U --unified"),
    # No --ignored: reviewers do not need the names of ignored local files.
    "status": options("sb", "", "--short --branch --porcelain --long"),
    "ls-files": options("comdzst", "", "--cached --others --modified --deleted --exclude-standard "
                        "--full-name --stage --directory --error-unmatch"),
    "grep": options("nilLcwvEFPhHpoqI", "eABCm", "--line-number --ignore-case --files-with-matches "
                    "--files-without-match --count --word-regexp --invert-match --extended-regexp --fixed-strings "
                    "--perl-regexp --cached --untracked --heading --break --show-function --name-only --only-matching "
                    "--quiet --all-match --and --or --not",
                    "--regexp --after-context --before-context --context --max-count --max-depth",
                    numbers="-A -B -C -m --after-context --before-context --context --max-count --max-depth"),
    "rev-parse": options("q", "", "--abbrev-ref --short --show-toplevel --verify --is-inside-work-tree "
                         "--symbolic-full-name --quiet"),
    "merge-base": options("a", "", "--is-ancestor --all --fork-point --octopus"),
    "blame": options("wsecltfnMC", "L", "--porcelain --line-porcelain --show-name --show-number"),
    "ls-tree": options("rdtlz", "", "--long --name-only --name-status --full-name --full-tree", "--abbrev"),
    "rev-list": options("", "n", "--count --all --first-parent --merges --no-merges --reverse --left-right",
                        "--max-count --since --until", numbers="-n --max-count"),
    "shortlog": options("sne", "", "--summary --numbered --email"),
    "describe": options("", "", "--tags --always --long --contains --all", "--abbrev --match"),
    "name-rev": options("", "", "--name-only --tags --always"),
}
FIND_UNARY = {"-print", "-print0", "-prune", "-o", "-or", "-a", "-and", "-not", "!", "(", ")", "-empty", "-true",
              "-false", "-depth", "-xdev", "-mount", "-daystart"}
FIND_BINARY = {"-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-type",
               "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-newer", "-perm", "-links"}
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
    if any(part.lower() == ".git" for part in relative.parts):
        return "Git internals are not readable"
    if any(sensitive(part) for part in relative.parts):
        return "secret or local-state paths are not readable"
    exempt = "node_modules" in relative.parts and not any(
        part.startswith(".") and part != ".pnpm"
        for part in relative.parts[relative.parts.index("node_modules") + 1:]) if "node_modules" in relative.parts else False
    if relative.parts and not exempt:
        ignored = subprocess.run(["git", "check-ignore", "-q", "--", str(relative)], cwd=root,
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        if ignored.returncode != 1:
            return "Git-ignored local state is not readable"
    return None


def looks_like_path(value, cwd):
    if value.startswith(("/", "~", ".")) or "/" in value:
        return True
    try:
        return (Path(cwd) / value).exists()
    except (OSError, ValueError):
        return True  # e.g. ENAMETOOLONG: let path_reason refuse it


REDIRECT_WORDS = {"2>/dev/null", "2>&1"}


def pipeline_words(command):
    """Split a command the way Bash would for this restricted grammar.

    Only an unquoted | separates stages (shlex returned a quoted '|' as a pipe).
    Quotes are removed; anything whose meaning could differ between Bash and this
    scanner is refused: expansion, unquoted comment/glob characters, home-directory
    tildes, chaining, redirection other than 2>/dev/null or 2>&1, and continuations.
    """
    stages, word, in_word, operator, quote, previous, index = [[]], [], False, False, None, " ", 0

    def finish():
        nonlocal word, in_word, operator
        if in_word:
            text = "".join(word)
            if not operator:
                stages[-1].append(text)
            elif text not in REDIRECT_WORDS:
                raise ValueError("command chaining, redirection, subshells and background jobs are not allowed")
        word, in_word, operator = [], False, False

    while index < len(command):
        char = command[index]
        following = command[index + 1] if index + 1 < len(command) else ""
        if quote == "'":
            if char == "'":
                quote = None
            else:
                word.append(char)
        elif quote == '"':
            if char == '"':
                quote = None
            elif char in "$`":
                raise ValueError("shell expansion is not allowed")
            elif char == "\\" and following and following in '"\\':
                word.append(following)
                index += 1
            elif char == "\\" and following and following in "\n\r":
                raise ValueError("line continuations are not allowed")
            else:
                word.append(char)
        elif char == "\\":
            if not following or following in "\n\r":
                raise ValueError("line continuations are not allowed")
            word.append(following)
            in_word = True
            index += 1
        elif char in " \t":
            finish()
        elif char == "|":
            finish()
            if following == "|":
                raise ValueError("only simple pipes are allowed")
            stages.append([])
        elif char in "'\"":
            quote, in_word = char, True
        elif char in "$`":
            raise ValueError("shell expansion is not allowed")
        elif char in "#*?[":
            raise ValueError("unquoted comments and glob patterns are not allowed; quote patterns")
        elif char == "~" and (not in_word or previous in "=:"):
            raise ValueError("home-directory expansion is not allowed")
        elif char in ";&<>(){}\n\r":
            word.append(char)
            in_word = operator = True
        else:
            word.append(char)
            in_word = True
        previous = char
        index += 1
    if quote:
        raise ValueError("unterminated quote")
    finish()
    return stages


def parse_options(name, args, spec):
    """(positionals, path-like option values, pattern given) or a denial reason."""
    positionals, values, index, ended, patterns = [], [], 0, False, False

    def take(option, value):
        nonlocal patterns
        if option in spec["numbers"] and not COUNT.fullmatch(value):
            return f"{name} {option} takes a number"
        if option in PATTERN_OPTIONS:
            patterns = True  # a pattern is never opened as a file
        else:
            values.append(value)
        return None
    while index < len(args):
        arg = args[index]
        index += 1
        if ended or arg == "-" or not arg.startswith("-"):
            positionals.append(arg)
        elif arg == "--":
            ended = True
        elif arg.startswith("--"):
            option, has_value, value = arg.partition("=")
            if has_value and option in spec["long_valued"]:
                reason = take(option, value)
            elif not has_value and option in spec["longs"]:
                reason = None
            elif not has_value and option in spec["long_valued"] and index < len(args):
                reason = take(option, args[index])
                index += 1
            else:
                return f"{name} {option} is not an allowed option"
            if reason:
                return reason
        elif spec["numeric"] and arg[1:].isdigit():
            pass
        else:
            for position, letter in enumerate(arg[1:], 1):
                if letter in spec["flags"]:
                    continue
                if letter in spec["valued"]:
                    value = arg[position + 1:]
                    if not value:
                        if index >= len(args):
                            return f"{name} -{letter} needs a value"
                        value = args[index]
                        index += 1
                    reason = take("-" + letter, value)
                    if reason:
                        return reason
                    break
                return f"{name} -{letter} is not an allowed option"
    return positionals, values, patterns


def find_reason(args, cwd, root):
    index = 0
    while index < len(args) and not args[index].startswith("-") and args[index] not in {"!", "(", ")"}:
        reason = path_reason(args[index], cwd, root)
        if reason:
            return reason
        index += 1
    while index < len(args):
        token = args[index]
        if token in FIND_BINARY and index + 1 < len(args):
            if token == "-newer":
                reason = path_reason(args[index + 1], cwd, root)
                if reason:
                    return reason
            index += 2
        elif token in FIND_UNARY:
            index += 1
        else:
            return f"find {token} is not an allowed predicate"
    return None


def segment_reason(argv, cwd, root=ROOT):
    name, args = argv[0], argv[1:]
    if name == "find":
        return find_reason(args, cwd, root)
    if name == "sed":
        if len(args) < 2 or args[0] != "-n" or not re.fullmatch(r"(?:\d+|\$)(?:,(?:\d+|\$))?p", args[1]) or any(
                arg.startswith("-") for arg in args[2:]):
            return "sed is limited to sed -n 'N,Mp' [FILE...]"
        positionals, values, patterns = args[2:], [], True
    elif name == "python3":
        script = (Path(cwd) / args[0]).resolve() if args else None
        if (script != root.resolve() / "scripts/agent_guard.py" or len(args) < 2 or args[1] not in GUARD_SCRIPTS
                or any(not re.fullmatch(r"[A-Za-z0-9_./@^~:=-]+", arg) for arg in args[2:])):
            return "python3 may only run scripts/agent_guard.py check, impact, report or domain"
        positionals, values, patterns = args[2:], [], True
    elif name == "git":
        while args and args[0] in {"--no-pager", "--no-optional-locks"}:
            args = args[1:]
        if not args or args[0] not in GIT:
            return "only read-only git subcommands without global options are allowed"
        parsed = parse_options("git " + args[0], args[1:], GIT[args[0]])
        if isinstance(parsed, str):
            return parsed
        positionals, values, patterns = parsed
        name = "git " + args[0]
    elif name in COMMANDS:
        parsed = parse_options(name, args, COMMANDS[name])
        if isinstance(parsed, str):
            return parsed
        positionals, values, patterns = parsed
    else:
        return f"{name} is not an allowed read-only inspection command"
    if name in {"grep", "rg", "git grep"} and not patterns and positionals:
        positionals = positionals[1:]  # the first operand is the pattern, never opened as a file
    for position, value in enumerate(positionals + values):
        if looks_like_path(value, cwd):
            reason = path_reason(value, cwd, root)
            if reason:
                return reason
        if name in FILE_COMMANDS and position < len(positionals) and (Path(cwd) / value).is_dir():
            return f"{name} takes files, not directories (it could recurse into ignored files)"
    return None


def bash_reason(tool_input, cwd, root=ROOT):
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip() or len(command) > 4000:
        return "empty or oversized command"
    if tool_input.get("run_in_background"):
        return "background commands are not allowed"
    try:
        stages = pipeline_words(command)
    except ValueError as exc:
        return str(exc)
    if any(not stage or "=" in stage[0] for stage in stages):
        return "empty pipeline stages and environment assignments are not allowed"
    for stage in stages:
        reason = segment_reason(stage, cwd, root)
        if reason:
            return reason
    return None


def saved_output(event, value):
    """Claude Code persists long tool output under the session's own tool-results directory."""
    transcript, session = event.get("transcript_path"), event.get("session_id")
    if not (isinstance(transcript, str) and isinstance(value, str) and isinstance(session, str)
            and SAFE_ID.fullmatch(session) and transcript.endswith(f"/{session}.jsonl")):
        return False
    folder = Path(transcript.removesuffix(".jsonl"), "tool-results").resolve()
    target = Path(value).resolve()
    return target.parent == folder and target.is_file() and target.suffix == ".txt"


def guard_reason(event, root=ROOT):
    agent = event.get("agent_type") or ""
    if not isinstance(agent, str) or not agent.startswith("flofi-"):
        return None
    tool, tool_input, cwd = event.get("tool_name"), event.get("tool_input") or {}, event.get("cwd")
    if tool not in READ_ONLY_TOOLS or not isinstance(tool_input, dict):
        return f"{tool} is not available to read-only FloFi reviewers"
    if not isinstance(cwd, str) or path_reason(cwd, root, root):
        return "the working directory must be a readable location inside the repository"
    if tool == "Bash":
        return bash_reason(tool_input, cwd, root)
    if tool == "Read":
        if saved_output(event, tool_input.get("file_path")):
            return None
        return path_reason(tool_input.get("file_path"), cwd, root)
    if tool == "Grep" and tool_input.get("glob") is not None:
        return "Grep glob filters override .gitignore; use type or path instead"
    pattern = tool_input.get("pattern") if tool == "Glob" else None
    if isinstance(pattern, str) and (pattern.startswith(("/", "~")) or ".." in pattern.split("/")):
        return "glob patterns must stay inside the repository"
    return path_reason(tool_input.get("path") or ".", cwd, root)


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
    record = {"v": 1, "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
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
    """Quote-aware split of a main-session command line into (segment, separator) pairs."""
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


def gate_scope(gate, words):
    """Which run of a gate this was, so a narrower pass never clears a full-run failure."""
    if gate == "guarded-browser":
        profile = words[2] if len(words) > 2 else ""
        return profile if re.fullmatch(r"[a-z0-9-]{1,40}", profile) else "other"
    if gate == "vitest-focused":
        return "filtered"
    extra = [w for w in words[2:] if not w.startswith(("--reporter=", "--outputFile="))]
    return "filtered" if gate.startswith("pnpm-test") and extra else "full"


def gate_record(event, root=ROOT):
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    parts = command_parts(command)
    separators = [separator for _segment, separator in parts if separator]
    gates, suites, scopes = [], [], {}
    for segment, _separator in parts:
        head = re.sub(r"^\s*(?:cd \S+\s*$|(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:timeout \d+[smh]? )?)", "", segment)
        head = re.sub(r"(?<!\S)2>(?:/dev/null|&1)(?!\S)", " ", head).strip()
        for gate, pattern in GATES:
            if re.fullmatch(pattern, head):
                gates.append(gate)
                scopes[gate] = gate_scope(gate, head.split())
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
        result = subprocess.run(["git", "--no-optional-locks", *args], cwd=root, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=5,
                                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        return result.stdout if result.returncode == 0 else None
    try:
        head, status = git("rev-parse", "HEAD"), git("status", "--porcelain")
    except (OSError, subprocess.SubprocessError):
        head = status = None
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
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=5).stdout.strip()
        append(session, {"event": "session_start", "definitions": definitions,
                         "head": head if re.fullmatch(r"[0-9a-f]{40}", head) else None,
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
                                         "tool": event.get("tool_name") if event.get("tool_name") in READ_ONLY_TOOLS else "other"}, root)
    except Exception:  # The denial below must still be returned.
        pass
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": f"FloFi read-only review guard: {reason}. Report it to the main session; "
                                    "it runs tests and makes any changes."}}


if __name__ == "__main__":
    sys.exit(main())
