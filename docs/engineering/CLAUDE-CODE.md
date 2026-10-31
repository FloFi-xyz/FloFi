# FloFi engineering specialists in Claude Code

The 19 Claude Code specialists in `.claude/agents/` are read-only reviewers for
repository changes. They are development infrastructure, not end-user or runtime
transaction agents. They are generated twins of the Codex roles in
`.codex/agents/` and share one source of truth:

| Contract | Single source | Consumed by |
| --- | --- | --- |
| Domain identifiers | `DOMAINS` in `scripts/agent_guard.py`, Codex role names | Codex roles, Claude twins, coverage.json, snapshot allowlists |
| Ownership, dependencies, suites, required regressions, gaps | `docs/engineering/coverage.json` | `agent_guard.py impact`/`domain`/`review`, both assistants |
| Shared instructions and financial invariants | The identical preamble of every Codex role | Copied verbatim into each Claude twin |
| Domain specialty and description | The Codex role | Copied verbatim into its Claude twin |

No Claude file lists owned paths. A specialist loads its live contract with
`python3 scripts/agent_guard.py domain <name> --base origin/main`.

## Codex and Claude differences

| Concern | Codex (`.codex/`) | Claude Code (`.claude/`) |
| --- | --- | --- |
| Definition | TOML role, parent model/tools/permissions | Markdown + YAML frontmatter, `model: inherit` |
| Read-only review | Instruction; edits allowed when main assigns disjoint files | Enforced: `tools: Read, Grep, Glob, Bash`, `disallowedTools` removes Agent, Edit, Write, NotebookEdit, web and MCP tools, and the PreToolUse guard bounds Bash/Read; main owns all edits |
| Concurrency (max 3) | Enforced by `.codex/config.toml` | Claude Code has no project setting; CLAUDE.md instructs it and `review` reports the observed peak |
| No grandchildren | Instruction | Enforced: no Agent tool in specialists |
| Discovery probe | `verify_codex_agents.py` (spawn-tool schema, rejecting endpoint) | `verify_claude_agents.py` (scripted loopback model, full spawn) |
| Observed invocation | Not recorded | Hook ledger (SubagentStart/SubagentStop) |

Grep and Glob are absent from some Claude Code builds (including 2.1.314); there the
specialists resolve to Read and Bash, so code search goes through the guarded Bash.

## Setup

- Claude Code 2.1.295 or later (`onFailure` hook field). Verified with 2.1.314.
- Accept the workspace trust dialog; interactive sessions hold back project hooks
  until then. `-p`/SDK sessions treat the folder as trusted and run them.
- Claude Code watches `.claude/agents/` only when the directory existed at session
  start. A session started before this directory existed must be restarted (or a
  new `claude -p` used) before the agents appear. Edits to existing agent files and
  hook settings are then picked up live.
- `claude agents` manages background sessions; it is not an agent-definition list.
  Discovery is shown by the `init` event of `claude -p --output-format stream-json
  --verbose` (`agents`) and checked by the probe below.

## Pre-PR review procedure

From the repository root on the working branch:

```sh
git status --short && git diff --stat origin/main...HEAD
python3 scripts/agent_guard.py check
python3 scripts/agent_guard.py impact --base origin/main
```

Ask the main session, for example: "Review this branch against origin/main with
the specialists selected by the impact report. Include flofi-workflow for shared
core and flofi-security for authorization, wallet or identity boundaries; keep at
most three running; give each the base, changed paths and concerns." Run the
focused tests and normal gates in the main session (`pnpm check`, the governance
suites, applicable PostgreSQL/fork/browser runners), then:

```sh
python3 scripts/agent_guard.py review --base origin/main \
  --skip flofi-payments-billing="No billing source or contract changed"
```

`review` defaults to `$CLAUDE_CODE_SESSION_ID`; pass `--session <id>` (repeatable)
for other sessions, `--stream-json <file>` to take headless sessions, their
discovered agents (`init`) and failed specialists with the API error type,
`--unit-report`/`--postgres-report` to verify fresh Vitest JSON reports and `--json`
for machine output. It prints changed domains and why, expected versus actually
invoked specialists, completion, structured results and the reviewed commit, guard
denials, recorded gates, coverage gaps, skips, problems and warnings.

`--strict` exits 1 on any problem: an expected specialist missing, failed,
incomplete, blocked or completed without a valid result line (unless skipped with a
reason), a recorded gate whose latest run failed, more than three reviewers at once,
invalid ledger rows, an unmapped maintained file, a failing required-suite report or
uncommitted changes in the worktree when `review` runs.
A specialist also counts as a problem when none of its valid reviews started and
finished on the current HEAD with a known-clean worktree, unless accepted with
`--accept-stale DOMAIN=REASON`. Agent definitions changed since a session, earlier
gate failures that later passed and accepted stale reviews are listed as warnings.
A ledger that reached its 1 MiB size limit is a problem.

A repeatable headless variant (uses your Claude account; never in CI). The stream
holds the whole conversation, so keep it private and delete it after summarizing:

```sh
stream="$(umask 077 && mktemp "${TMPDIR:-/tmp}/flofi-review.XXXXXX")"
claude -p --output-format stream-json --verbose \
  --allowedTools="Agent,Read,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*),Bash(git grep:*),Bash(rg:*),Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(sed -n:*),Bash(python3 scripts/agent_guard.py:*)" \
  "Read-only pre-PR review of this branch against origin/main using the flofi-swap, flofi-mcp and flofi-workflow subagents in parallel. Do not edit files. Summarize each specialist's findings and FLOFI_REVIEW_RESULT line." \
  > "$stream"
python3 scripts/agent_guard.py review --base origin/main --stream-json "$stream"
rm -f "$stream"
```

## Read-only guard

`.claude/hooks/flofi_agent_hooks.py guard` runs on every PreToolUse (`python3 -I`,
`onFailure: block`). It ignores the main session and non-FloFi agents. For any agent
named `flofi-*` it allows Read/Grep/Glob and Bash single pipelines built only from:

- `git` read subcommands (diff, log, show, diff-tree, status, ls-files, grep,
  rev-parse, merge-base, blame, ls-tree, rev-list, shortlog, describe, name-rev),
  with no global options except `--no-pager`;
- `rg`, `grep`, `cat`, `head`, `tail`, `wc`, `ls`, `cut`, `tr`, `sort`, `stat`,
  `basename`, `dirname`, `realpath`, `pwd`, `find` (name/type/path predicates only),
  `sed -n 'N,Mp'` and `python3 scripts/agent_guard.py check|impact|report|domain`.

Every option of every command and git subcommand must be on an explicit allowlist.
Denylists were not enough: GNU tools and git accept abbreviated long options
(`git grep --open=` runs a pager program, `sort --out=` writes), Claude Code's
`grep` is ugrep (pager, filter and config options; recurses into directory operands)
and its `find` is bfs. So `rg -g`/`--hidden` (they override `.gitignore` or reach
`.git`), `grep -r`/`-f`, `git grep -O`/`--no-index`/`--untracked` exclusions,
`--output`, `--ext-diff`, `--textconv`, `--show-signature`, `git cat-file` and every
unknown or abbreviated option are refused. File-reading commands take files, not
directories. Context and count options take numbers, never a path. The guard splits
commands with its own Bash-compatible tokenizer (a differential test compares it
with Bash): only an unquoted `|` separates stages, so a quoted or escaped `|` stays an
argument as it does in Bash. Unquoted `#`, `*`, `?`, `[`, word-initial `~`, chaining,
redirection (other than `2>/dev/null`/`2>&1`), expansion, subshells, background jobs
and environment assignments are refused; quote patterns instead. A `grep`/`rg`/
`git grep` pattern (`-e` or the first operand) is never path-checked, because it is
never opened as a file. Paths (operands and option values) must be
inside the repository, outside `.git` (any case), not Git-ignored (except
`node_modules` outside its dot directories) and not named like a secret. Names (not
contents) of ignored files can still appear through `find` and `ls`. The working directory must be such a
location too. Read may also open long output that Claude Code saved in this
session's own `tool-results/` directory. The Grep tool's `glob` filter is refused.

Any internal guard error or unreadable hook input is an explicit deny. On 2.1.314,
`onFailure: block` was also verified to block a guard that is missing, exits 1 or
times out. A broken guard therefore blocks every tool call, including the main
session's; restore the file from Git, or set `"disableAllHooks": true` in the
ignored `.claude/settings.local.json` while repairing.

Limits: hooks are skipped with `--bare`, `disableAllHooks` or an untrusted
interactive folder. The frontmatter allowlist and denylist still remove write,
agent, web and MCP tools; Bash then falls back to the session's permission mode.
`python3` and `git` come from `PATH`; the hook runs from the checked-out branch and
its content is protected by review, not pinned. Allowed `git` commands can still run
programs configured in the user's own Git config (for example `core.fsmonitor`).
The guard is a review boundary, not a sandbox for hostile code.

## Lifecycle ledger

`record` appends to `.claude/flofi-agent-runs/<session>.jsonl` (Git-ignored;
excluded from Cloud Build uploads). Every write re-applies mode 0600/0700 and refuses
symlinks, hard-linked or foreign-owned files; `review` re-validates every row on read
and refuses a symlinked ledger directory:

| Event | Stored fields |
| --- | --- |
| `session_start` | source; Git HEAD; SHA-256 prefix of each `flofi-*.md` present (defined) |
| `subagent_start` / `subagent_stop` | agent name, agent ID, Git HEAD and whether the worktree had uncommitted changes (the reviewed state); validated `FLOFI_REVIEW_RESULT` (result, count, highest severity) or null |
| `guard_deny` | agent name, agent ID, tool name |
| `test` | gate IDs from a fixed list, scope per gate (`full`, `filtered` or browser profile), pass/fail/unknown, exit code, pipeline flag, agent, repository-relative test file paths |
| `session_end` | reason |

Every row also carries `v` (format version) and `t` (UTC time, seconds). Prompts,
commands, tool output, transcripts, findings text, environment values, file names
from `git status`, wallet data and conversations are never stored. Files stay until
you delete them (one per session, at most 1 MiB each); nothing uploads them. A start without a stop means the
specialist failed, was interrupted or is still running; hooks cannot tell which, but
a headless stream can (for example `rate_limit` when the account's usage limit ends a
specialist). A result trailer must be self-consistent (`no-findings` is 0/`none`). Delete the directory at any
time; set `FLOFI_AGENT_TELEMETRY=off` to stop recording. A gate's status is the
shell exit status, recorded only when the line is a single command or an all-`&&`
chain that succeeded; pipelines, `;`, `||` and `&` record "not observed", and a failure
of a multi-command line is not attributed to any gate; splitting respects quotes.
`--strict` counts each gate run (gate, scope and test files) by its latest known
result in time order: only a later pass of the same run or a full run of the gate
clears a failure. Only `verify-results` on a fresh report checks required
suites, and only CircleCI certifies a release.

## Maintenance and verification

Edit a Codex role, then `python3 scripts/agent_guard.py claude-agents` (diff) and
`--overwrite` to apply; `--write` only creates missing twins and never replaces a
differing file. `agent_guard.py check` fails on drift, extra or missing agents,
broader tools, changed hook settings, local `.claude/` state or nested `.claude/`
configuration. A new domain needs a Codex role, `DOMAINS`, coverage ownership, a
twin and both allowlists (`.gcloudignore`, snapshot).

```sh
python3 scripts/agent_guard.py check
python3 -m unittest discover -s scripts -p 'test_ci_*.py'
python3 scripts/verify_claude_agents.py   # optional, needs the claude CLI
```

The probe starts the installed CLI with a disposable config directory and a scripted
loopback Messages API: the main session spawns each of the 19 specialists, each
runs one allowed command and attempts a forbidden command and an outside read, and
the probe checks discovery, exact descriptions, resolved tools, system prompts,
guard denials and the ledger. No real model, credentials or external AI service is
used, so it proves harness wiring, not model judgment or automatic delegation.

## Evidence levels

| Level | Mechanism | Establishes |
| --- | --- | --- |
| Automatic CI | `agent_guard.py check`, governance suites (existing jobs) | Definitions, parity, settings, guard and ledger contracts |
| Model-driven delegation | CLAUDE.md, agent descriptions | A request, not a guarantee, that Claude delegates |
| Observed delegation | Hook ledger, `agent_guard.py review` | What actually started, completed and returned |
| Manual acceptance | `verify_claude_agents.py`, real-model sessions, owner review | Installed-harness behavior and advisory findings |
