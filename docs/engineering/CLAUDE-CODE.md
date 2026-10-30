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
for other sessions, `--unit-report`/`--postgres-report` to verify fresh Vitest JSON
reports, `--json` for machine output and `--strict` to exit 1 when an expected
specialist is missing, incomplete or blocked without justification, a recorded gate
failed, more than three ran at once, or a maintained file is unmapped. It prints
changed domains and why, expected versus actually invoked specialists, completion
and structured results, guard denials, recorded gates, coverage gaps and skips.

A repeatable headless variant (uses your Claude account; never in CI):

```sh
claude -p --output-format stream-json --verbose \
  --allowedTools="Agent,Read,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*),Bash(git grep:*),Bash(rg:*),Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(sed -n:*),Bash(python3 scripts/agent_guard.py:*)" \
  "Read-only pre-PR review of this branch against origin/main using the flofi-swap, flofi-mcp and flofi-workflow subagents in parallel. Do not edit files. Summarize each specialist's findings and FLOFI_REVIEW_RESULT line." \
  > "${TMPDIR:-/tmp}/flofi-review.jsonl"
python3 scripts/agent_guard.py review --base origin/main --session \
  "$(jq -r 'select(.subtype == "init") | .session_id' "${TMPDIR:-/tmp}/flofi-review.jsonl")"
```

## Read-only guard

`.claude/hooks/flofi_agent_hooks.py guard` runs on every PreToolUse with
`onFailure: block`. It ignores the main session and non-FloFi agents. For any agent
named `flofi-*` it denies tools other than Read/Grep/Glob/Bash and allows Bash only
for single pipelines of `git` read subcommands (no global options, output files,
external diff, `--no-index` or pager), `rg`/`grep` without ignore bypass or
recursion, `find` without actions, `sed -n 'N,Mp'`, common read-only utilities and
`python3 scripts/agent_guard.py check|impact|report|domain`. It denies chaining,
redirection (other than `2>/dev/null`/`2>&1`), expansion, subshells, background
jobs, environment assignments and any path outside the repository, inside `.git`,
Git-ignored (except `node_modules`) or named like a secret, including glob matches.

Limits: hooks are skipped with `--bare`, `disableAllHooks` or an untrusted
interactive folder. The frontmatter allowlist and denylist still remove write,
agent, web and MCP tools; Bash then falls back to the session's permission mode.
The guard is a review boundary, not a sandbox for hostile code.

## Lifecycle ledger

`record` appends to `.claude/flofi-agent-runs/<session>.jsonl` (Git-ignored, mode
0600, directory 0700, refused through symlinks; excluded from Cloud Build uploads):

| Event | Stored fields |
| --- | --- |
| `session_start` | source; SHA-256 prefix of each `flofi-*.md` present (defined) |
| `subagent_start` / `subagent_stop` | agent name, agent ID; validated `FLOFI_REVIEW_RESULT` (result, count, highest severity) or null |
| `guard_deny` | agent name, agent ID, tool name |
| `test` | gate IDs from a fixed list, pass/fail/unknown, exit code, pipeline flag, test file paths |
| `session_end` | reason |

Prompts, commands, tool output, transcripts, findings text, environment values,
wallet data and conversations are never stored. A start without a stop means the
specialist failed, was interrupted or is still running. Delete the directory at any
time; set `FLOFI_AGENT_TELEMETRY=off` to stop recording. A gate's status is the
shell exit status (a pipeline reports its last command); only `verify-results` on a
fresh report checks required suites, and only CircleCI certifies a release.

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
