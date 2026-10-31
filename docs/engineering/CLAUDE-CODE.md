# FloFi engineering specialists in Claude Code

The 19 Claude Code specialists in `.claude/agents/` are read-only reviewers for
repository changes, with no shell: their only tool is Read. They are development infrastructure, not end-user or runtime
transaction agents. They are generated twins of the Codex roles in
`.codex/agents/` and share one source of truth:

| Contract | Single source | Consumed by |
| --- | --- | --- |
| Domain identifiers | `DOMAINS` in `scripts/agent_guard.py`, Codex role names | Codex roles, Claude twins, coverage.json, snapshot allowlists |
| Ownership, dependencies, suites, required regressions, gaps | `docs/engineering/coverage.json` | `agent_guard.py impact`/`domain`/`review`, both assistants |
| Shared instructions and financial invariants | The identical preamble of every Codex role | Copied verbatim into each Claude twin |
| Domain specialty and description | The Codex role | Copied verbatim into its Claude twin |

No Claude file lists owned paths. The main session runs
`python3 scripts/agent_guard.py domain <name> --base origin/main` and hands the live
contract to the specialist, which can also Read `docs/engineering/coverage.json`.

## Codex and Claude differences

| Concern | Codex (`.codex/`) | Claude Code (`.claude/`) |
| --- | --- | --- |
| Definition | TOML role, parent model/tools/permissions | Markdown + YAML frontmatter, `model: inherit` |
| Read-only review | Instruction; edits allowed when main assigns disjoint files | Enforced: `tools: Read`; `disallowedTools` removes Agent, Bash, Edit, Write, NotebookEdit, Grep, Glob, web and MCP tools; the PreToolUse guard denies every other tool and applies a path rule to Read; main runs every command, search and test and owns all edits |
| Concurrency (max 3) | Enforced by `.codex/config.toml` | Claude Code has no project setting; CLAUDE.md instructs it and `review` reports the observed peak |
| No grandchildren | Instruction | Enforced: no Agent tool in specialists |
| Discovery probe | `verify_codex_agents.py` (spawn-tool schema, rejecting endpoint) | `verify_claude_agents.py` (scripted loopback model, full spawn) |
| Observed invocation | Not recorded | Hook ledger (SubagentStart/SubagentStop) |

Specialists cannot search, list directories, diff or run tests. That is deliberate:
iterative hardening of a shell-command allowlist kept surfacing bypasses (abbreviated
options, ugrep/bfs extensions, quoting, implicit `git diff --no-index`), so command
execution moved entirely to the main session. Grep and Glob (absent from 2.1.314 and
2.1.316 anyway) are excluded too: their filters can override `.gitignore`.

## Setup

- Claude Code 2.1.295 or later (`onFailure` hook field). Verified with 2.1.314 and 2.1.316.
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
most three running. Give each the base, the changed paths, the relevant diff and the
output of `agent_guard.py domain <name> --base origin/main`." Specialists Read the
files they need and return any search, diff or test they want as a request. The main
session runs those, the focused tests and the normal gates (`pnpm check`, the
governance suites, applicable PostgreSQL/fork/browser runners), then:

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
uncommitted changes in the worktree when `review` runs, or a HEAD or worktree state
it cannot determine.
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
  "Read-only pre-PR review of this branch against origin/main using the flofi-swap, flofi-mcp and flofi-workflow subagents in parallel. Do not edit files. Run git diff and agent_guard.py impact/domain yourself and give each specialist the changed paths, relevant diff and its domain report; they can only Read. Summarize each specialist's findings and FLOFI_REVIEW_RESULT line." \
  > "$stream"
python3 scripts/agent_guard.py review --base origin/main --stream-json "$stream"
rm -f "$stream"
```

## Read-only guard

`.claude/hooks/flofi_agent_hooks.py guard` runs on every PreToolUse (`python3 -I`,
`onFailure: block`). It ignores the main session and non-FloFi agents. For any agent
named `flofi-*` it denies every tool except Read, and allows a Read only when the
path:

- is a non-empty file path without `~` or a `..` component as written;
- resolves (following symlinks) inside the repository;
- is not inside `.git` (any case), not Git-ignored (`git check-ignore`; an error
  also refuses) and has no secret-like component in the written or resolved path
  (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa`, credentials files,
  `.mode-a`, `.public-testnet`, the agent ledger).

There is no command parser and no search: a specialist cannot run anything. Claude
Code normalizes Read paths before PreToolUse, so the rule applies to the canonical
path; a `..` that stays inside the repository is an ordinary repository Read.

Any internal guard error or unreadable hook input is an explicit deny. On 2.1.314,
`onFailure: block` was also verified to block a guard that is missing, exits 1 or
times out. A broken guard therefore blocks every tool call, including the main
session's; restore the file from Git, or set `"disableAllHooks": true` in the
ignored `.claude/settings.local.json` while repairing.

Limits: hooks are skipped with `--bare`, `disableAllHooks` or an untrusted
interactive folder; the frontmatter `tools: Read` and `disallowedTools` still leave
specialists without Bash, write, search, agent, web and MCP tools, but Read is then
unguarded. Untracked, non-ignored files are readable, so keep local secrets ignored.
`python3` and `git` come from `PATH`; the hook runs from the checked-out branch and
its content is protected by review, not pinned. The guard is a review boundary, not
a sandbox for hostile code.

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
| `test` | gate IDs from a fixed list, run identity per gate (`run-` plus a 12-hex HMAC of the gate, working directory, `cd` target and filtering arguments, keyed by an owner-only `.scope-key` beside the ledger; `legacy` for rows written before identities, `unknown` without a key), pass/fail/unknown, exit code, pipeline flag, agent, repository-relative test file paths |
| `session_end` | reason |

Every row also carries `v` (format version: 2 since run identities and per-review
commits; older rows are read as legacy) and `t` (UTC time, seconds). Prompts,
commands, tool output, transcripts, findings text, environment values, file names
from `git status`, wallet data and conversations are never stored. Files stay until
you delete them (one per session; writing stops once a file reaches 1 MiB, so it can
exceed that by one row); nothing uploads them. A start without a stop means the
specialist failed, was interrupted or is still running; hooks cannot tell which, but
a headless stream can (for example `rate_limit` when the account's usage limit ends a
specialist). A result trailer must be self-consistent (`no-findings` is 0/`none`). Delete the directory at any
time; set `FLOFI_AGENT_TELEMETRY=off` to stop recording. A gate's status is the
shell exit status, recorded only when the line is a single command or an all-`&&`
chain that succeeded; pipelines, `;`, `||` and `&` record "not observed", and a failure
of a multi-command line is not attributed to any gate; splitting respects quotes.
`--strict` counts each gate run by its exact identity, in time order: only a later
pass of the same identity clears a failure. A different, narrower, legacy or unknown
run never does; `guarded-release-browser.mjs list` is not recorded as a gate. Only `verify-results` on a fresh report checks required
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
loopback Messages API: the main session spawns each of the 19 specialists; each Reads
a repository file and attempts Bash and Reads outside the repository, escaping
through `..` and of a secret-named file. The probe checks discovery, exact
descriptions, that the resolved tool set is exactly Read, system prompts, that Bash
never runs, guard denials and the ledger. No real model, credentials or external AI service is
used, so it proves harness wiring, not model judgment or automatic delegation.

## Evidence levels

| Level | Mechanism | Establishes |
| --- | --- | --- |
| Automatic CI | `agent_guard.py check`, governance suites (existing jobs) | Definitions (Read-only), parity, settings, guard path rule and ledger contracts |
| Model-driven delegation | CLAUDE.md, agent descriptions | A request, not a guarantee, that Claude delegates |
| Observed delegation | Hook ledger, `agent_guard.py review` | What actually started, completed and returned |
| Manual acceptance | `verify_claude_agents.py`, real-model sessions, owner review | Installed-harness behavior and advisory findings |
