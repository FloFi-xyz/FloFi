# BUILD-FLOFI-CLAUDE-AGENTS-001 — implementation and verification report

Native Claude Code engineering specialists that share the BUILD-FLOFI-AGENTS-001
contracts. Development infrastructure only: no application, API, database, wallet,
fee, financial-execution or production configuration changed. Usage:
[CLAUDE-CODE.md](CLAUDE-CODE.md).

Branch `claude/build-flofi-claude-agents-001` (PR #142). It started from main
`c7abc58` and was rebased without conflicts onto `39459013` (#141), `6b7bd62` (#145)
and `749e5cd` (#143, #144); every rebase was checked with `git range-diff` (all
patches identical) and the ownership inventory of each merged build was preserved.
Local backup refs: `backup/claude-agents-001-pre-rebase-{749e49e,29a234a,09e5898}`.

## Final design: no-shell specialists

- 19 Claude Code specialists in `.claude/agents/`, generated from the 19 unchanged
  Codex roles: same domain IDs, verbatim shared preamble, specialty and
  description, `model: inherit`, **`tools: Read` only**; `disallowedTools`
  removes Agent, Bash, Edit, Write, NotebookEdit, Grep, Glob, web and MCP tools.
- The main session runs every command: `git diff`, `agent_guard.py
  impact|domain|review`, searches and tests. It hands specialists the changed
  paths, diffs and domain reports; specialists request anything else.
- `.claude/hooks/flofi_agent_hooks.py guard` (PreToolUse, `python3 -I`,
  `onFailure: block`) denies every tool except Read for `flofi-*` agents and applies
  one fail-closed path rule to Read: no `~` or written `..`, canonical path inside
  the repository, not in `.git`, not Git-ignored, no secret-like component. There is
  no command parser.
- Unchanged from earlier phases: the lifecycle/test ledger and `review` binding,
  `agent_guard.py check` parity and settings validation, the exact Cloud Build
  `.claude` allowlist, `.dockerignore` exclusion and CircleCI certification.

Single source of truth: domain IDs (`DOMAINS`, Codex role names); ownership,
dependencies, suites, required regressions and gaps (`coverage.json` only; no Claude
file lists owned paths); shared instructions and financial invariants (the identical
Codex preamble, copied verbatim).

## Why the shell guard was abandoned

The first design gave specialists a policed Bash. Real reviews kept finding bypasses,
each reproduced against the real tools before it was fixed:

| Batch | Ledger session | Commit (as reviewed) | Outcome |
| --- | --- | --- | --- |
| 1 | `fad31fb6` | pre-#141 head | swap 1 low; mcp none; workflow 2 low (paging, impact label) |
| 2 | `c24c17d1` | `749e49e` | data-privacy 5 low; security and infra-ci **failed: `rate_limit`** |
| 3 | `02277d33` | `6c268e0` | security 9, **critical** (abbreviated options, `#`, globs, `rg -g`); infra-ci 4, medium |
| 4 | `47c53eb1` | `29a234a` | infra-ci 4, medium; security **failed: `rate_limit`** |
| 5 | `1bbe13d9` | `e2f188e` | security 9, **critical** (quoted `\|` read `.env`); infra-ci 8, medium; data-privacy 4, low |
| 6 | `57153903` | `746fff1` | security 5, high (ugrep context); infra-ci 7, medium; data-privacy 4, low |
| 7 | `9a467b89` | `511783c` | security 5, **high** (`git diff ../repo` implicit no-index); infra-ci 6, medium; data-privacy 4, medium |
| 8 | `5d83b14c` | `09e5898` | cancelled by the owner decision below; no results |

Hashes in batches 3–8 are the commits as reviewed, before later rebases. On
2026-10-31 the owner stopped parser hardening and chose Read-only specialists; the
command layer (~350 lines) was deleted in `refactor(engineering): no-shell
specialists`. Every fix in the history above stays in the branch where it still
applies (ledger hardening, review binding, gate run identity, docs).

## Claude Code facts used (2.1.314 and 2.1.316)

- Agents are Markdown with YAML frontmatter; `tools` and `disallowedTools` are
  honored (the denylist applies first); `model: inherit` works.
- `.claude/agents/` is watched only if it existed at session start (a session that
  created it reported `Agent type 'flofi-swap' not found`); after a restart the
  agents appeared in this session's own agent list.
- `claude -p --output-format stream-json --verbose` lists discovered agents in its
  `init` event and reports subagent failures in `task_updated` (`error type`).
- Project settings hooks run in `-p` sessions without the trust dialog; PreToolUse,
  SubagentStart and SubagentStop carry `agent_type`/`agent_id`.
- `onFailure: block` blocks a guard that is missing, exits 1 or times out.
- Read paths are normalized before PreToolUse, so the guard sees canonical paths.
- A usage-limit 429 ends a background subagent without SubagentStop; the ledger
  shows it as started without completion, and the stream names `rate_limit`.

## Evidence

### AUTOMATIC CI

Existing CircleCI, GitHub Actions and Cloud Build steps run `agent_guard.py check`
and every `test_ci_*.py` suite; no job was added and no AI runs in CI. Local runs on
the final tree (Python 3.14 locally, CI uses 3.12.3; 3.12 grammar verified):

| Check | Result |
| --- | --- |
| `python3 scripts/agent_guard.py check` | PASS (19 domains, 163 modules) |
| `python3 scripts/agent_guard.py claude-agents` | 19 twins match their Codex roles; `.codex/` identical to main |
| `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` | 169 tests OK |
| `test_governance_lite.py`, `governance_lite.py`, `git diff --check` | OK |
| Frozen install, dependency verification, audit, typecheck, lint, build, schemas, unit tests + `verify-results` | Recorded in the PR description for the final commit |

### MODEL-DRIVEN DELEGATION

CLAUDE.md and the agent descriptions request selective, bounded delegation; the
model decides whether and whom to delegate.

### ACTUAL OBSERVED DELEGATION

The table above records every real-model batch from the hook ledgers and streams.
The two final batches required by the owner, on the final commit, are:

- Batch A: flofi-security, flofi-infrastructure-ci, flofi-data-privacy.
- Batch B: flofi-swap, flofi-mcp, flofi-workflow.

They review this exact commit, so their results, the consolidated `agent_guard.py
review --strict` output and the GO/NO-GO verdict are recorded in the PR #142
description rather than in a later commit that would make them stale. The other 13
domains are skipped with the stated justification: no source, contract or suite of
theirs changed, and their twins are checked byte for byte against the Codex roles.

### MANUAL ACCEPTANCE

| Check | Result |
| --- | --- |
| `python3 scripts/verify_claude_agents.py` (scripted loopback model, no real model) | PASS on 2.1.316: 19 discovered with exact descriptions; each resolves to exactly `Read`, reads a repository file, has Bash refused and outside, escaping `..` and secret-named Reads denied, and is recorded by SubagentStart/SubagentStop |
| `python3 scripts/verify_codex_agents.py` (codex-cli 0.163.0) | PASS: 19 roles in the actual spawn schema |
| `onFailure: block` | Verified for a missing guard, exit 1 and timeout |
| Interactive trust dialog, Cloud Build upload | Not run (owner-operated); covered by unit tests |

## Not run and limits

- PostgreSQL, fork and browser suites were not run locally: no TypeScript, SQL, UI
  or runtime file changed and Docker is unavailable in this WSL session. CircleCI
  runs them unchanged.
- The guard is a review boundary, not a sandbox. With hooks disabled (`--bare`,
  `disableAllHooks`, untrusted interactive folder), specialists still have only
  Read, but Read is unguarded. Untracked, non-ignored files are readable.
- Local review streams lived in `/tmp` and were lost in a WSL restart after
  batch 4; the hook ledgers (in the repository, Git-ignored) and Claude Code
  transcripts survived and are the evidence used here.
- No real-money, signing, deployment, merge or production action was taken.

## Product invariants

Unchanged by construction: mainnet-first public product, no mock production data,
optional Canvas, chat/MCP continuity, action semantics, wallet authorization,
recovery/reconciliation/evidence, user and network isolation, Developers API/SDK
compatibility, LGPD boundaries, no automatic signing and no fee activation. The
specialists are development reviewers with no transaction path and no shell.
