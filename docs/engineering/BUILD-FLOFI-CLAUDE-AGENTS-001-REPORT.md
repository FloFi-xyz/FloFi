# BUILD-FLOFI-CLAUDE-AGENTS-001 — implementation and verification report

Native Claude Code engineering specialists that share the BUILD-FLOFI-AGENTS-001
contracts. Development infrastructure only: no application, API, database, wallet,
fee or production configuration changed. Usage: [CLAUDE-CODE.md](CLAUDE-CODE.md).

Branch `claude/build-flofi-claude-agents-001`, started from main `c7abc58` and
rebased onto main `39459013` (PR #141) without conflicts. PR #141's new build-entry
sources keep their ownership; the pre-rebase head is kept as
`backup/claude-agents-001-pre-rebase-749e49e` (local only).

## Audit

- 19 Codex roles share one identical preamble and end with one `Specialty:` line;
  `.codex/config.toml` bounds the pool to three; `agent_guard.py` owns domains,
  inventory, impact and required-suite verification; CircleCI, GitHub Actions and
  the Cloud Build fallback all run `agent_guard.py check` and the `test_ci_*.py`
  governance suites. Cloud Build uploads admit an exact `.codex/` allowlist.
- Installed Claude Code 2.1.314, checked against the official subagent and hook
  documentation and by experiment:
  - Agents are Markdown with YAML frontmatter; `tools`/`disallowedTools`/`model`
    are honored; the denylist applies before the allowlist.
  - This build has no Grep/Glob tools, so specialists resolve to Read and Bash.
  - `claude -p --output-format stream-json --verbose` lists discovered agents in
    its `init` event; the delegation listing reads `- name: description (Tools: …)`.
  - The `.claude/agents/` watcher is attached only if the directory existed at
    session start. This build session reported `Agent type 'flofi-swap' not found`;
    fresh sessions discovered all 19.
  - Project settings hooks run in `-p` sessions without the trust dialog;
    SubagentStart/SubagentStop/PreToolUse carry `agent_type`/`agent_id`.
  - `onFailure: "block"` works: with the guard script missing, an explicitly allowed
    Bash call was blocked and created nothing.
  - Claude Code has no project setting for concurrent subagents.

Differences between the assistants and how each is handled are tabulated in the guide.

## Delivered

| Item | Files |
| --- | --- |
| 19 read-only specialists | `.claude/agents/flofi-*.md`, generated from `.codex/agents/*.toml` |
| Shared contracts and checks | `scripts/agent_guard.py`: twin generation/parity, exact settings, `.claude` path rules, `domain`, `review`, `claude-agents`, impact reasons |
| Read-only guard and ledger | `.claude/settings.json`, `.claude/hooks/flofi_agent_hooks.py`, `.gitignore` |
| Upload allowlist | `.gcloudignore`, `scripts/gcp-source-snapshot.py` |
| Harness probe | `scripts/verify_claude_agents.py` (optional, local) |
| Deterministic tests | `scripts/test_ci_claude_agents.py` (new), `test_ci_agent_guard.py`, `test_ci_source_snapshot.py` |
| Ownership | `coverage.json`/`COVERAGE.md`: three sources and the new governance suite under infrastructure-ci, plus an explicit model-delegation gap |
| Orchestration and docs | `CLAUDE.md`, `AGENTS.md`, `docs/engineering/README.md`, `CLAUDE-CODE.md`, this report |

No second ownership matrix exists: twins carry only the Codex text and load
`agent_guard.py domain <name>`. No CI job, workflow, model service or credential was
added; the existing `agent_guard.py check` and `test_ci_*.py` steps cover the new
contracts in CircleCI, GitHub Actions and Cloud Build.

## Evidence

### AUTOMATIC CI (deterministic, existing jobs)

Run locally on the rebased tree (Python 3.14 here; CI uses 3.12.3, all syntax and
APIs checked against 3.12; CircleCI is authoritative):

| Check | Result |
| --- | --- |
| `python3 scripts/agent_guard.py check` | PASS (19 domains, 162 modules); twins, settings and `.claude` rules included |
| `python3 scripts/agent_guard.py claude-agents` | 19 twins match their Codex roles |
| `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` | 153 tests OK |
| `test_governance_lite.py` suite, `governance_lite.py`, `git diff --check` | OK / passed / clean |
| `COVERAGE.md` regeneration | identical |
| Frozen install, `bootstrap-ci.py --verify-dependencies`, `pnpm audit --audit-level low` | PASS / PASS / no known vulnerabilities |
| `pnpm typecheck`, `lint` (+ guarded browser script), `build`, `schemas:check` | PASS (11 schema exports verified) |
| `pnpm test` JSON + `agent_guard.py verify-results` | 460 files / 5,812 tests passed; 2 pre-existing conditional skips (`mode-b-service`, `composition-service`, need local fork artifacts; not required suites); 33 required suites, every case passed |

Negative controls: the probe failed when an agent's `tools` and `disallowedTools`
were both widened (resolved tools `Read, Bash, Edit`) and when the hook settings were
removed (no guard denials, no lifecycle records). Widening only `tools` still
resolved to `Read, Bash`, because `disallowedTools` removed Edit.

### MODEL-DRIVEN DELEGATION

CLAUDE.md and the agent descriptions request selective, bounded delegation. That is
not a guarantee: the model decides whether and whom to delegate.

### ACTUAL OBSERVED DELEGATION

Fresh `claude -p` sessions on the user's account (no MCP servers, read-only
`--allowedTools`), recorded by the hooks and by stream-json:

| Session | Specialist | Discovered | Started | Completed | Result |
| --- | --- | --- | --- | --- | --- |
| `fad31fb6…` (batch 1, $3.06 nominal) | flofi-swap | yes | yes | yes | findings: 1, low |
| | flofi-mcp | yes | yes | yes | no-findings |
| | flofi-workflow | yes | yes | yes | findings: 2, low |
| `c24c17d1…` (batch 2, $5.18 nominal) | flofi-data-privacy | yes | yes | yes | findings: 5, low |
| | flofi-security | yes | yes | **failed** | `rate_limit` (HTTP 429, account usage limit) |
| | flofi-infrastructure-ci | yes | yes | **failed** | `rate_limit` (HTTP 429, account usage limit) |

The main session delegated each batch in parallel; peak concurrency was 3. Guard
denials were recorded (batch 1: 7, batch 2: 4), all for commands outside the policy;
no tool or runtime error other than the usage limit. Batch 1 ran on the definitions
before the fixes below; batch 2 on the current ones.

Findings and resolution (all fixed with tests):
- swap, workflow: `sed -n` refused as a pipe stage, and Claude Code's saved long
  output (session `tool-results/`) unreadable, so reviewers could not page; workflow:
  governance-only changes labelled "shared financial core".
- data-privacy: absolute test paths could expose the local user; ledger permissions
  applied only at creation (hard links and pre-existing loose modes); reader looser
  than writer; documented stream file predictable and world-readable; inconsistent
  result trailers accepted.
- Self-review: `git blame --contents=FILE` and `git grep -f FILE` bypassed path
  checks; `jq` exposed `$ENV`; `diff -r` recursed into ignored files;
  `rg --hostname-bin` executes a program; bundled `git -O` opens a pager.
- Running `review` on these sessions found two of its own bugs: the reader dropped
  `subagent_start` rows, and definition hashes from different sessions were merged.

Outstanding: real-model flofi-security and flofi-infrastructure-ci reviews of this PR
must be re-run after the usage limit resets. The other 13 domains were skipped with
the justification in the review summary (no source, contract or suite changed; their
twins are byte-checked against the Codex roles).

### MANUAL ACCEPTANCE

| Check | Result |
| --- | --- |
| `python3 scripts/verify_claude_agents.py` | PASS: 19 discovered with exact descriptions, read-only tools, allowed command ran, forbidden command and outside read denied, SubagentStart/SubagentStop recorded; zero real model responses |
| `python3 scripts/verify_codex_agents.py` (codex-cli 0.163.0) | PASS: 19 roles in the actual spawn schema |
| Interactive Claude Code session (trust dialog, `/agents`) | Not run; restart requirement observed in this session |
| Cloud Build upload with the new allowlist | Not run (owner-operated); covered by snapshot unit tests |

## Not run

PostgreSQL, fork and browser suites were not run locally: no TypeScript, SQL, UI or
runtime file changed, and Docker is unavailable in this WSL session. CircleCI runs
them unchanged. No real-money, signing, deployment, merge or production action was
taken.

## Product invariants

Unchanged by construction (no application, contract, migration, wallet, fee,
channel, MCP or developer-API file changed): mainnet-first public product, no mock
production data, optional Canvas, chat/MCP continuity, action semantics, wallet
authorization, recovery/reconciliation/evidence, user and network isolation,
Developers API/SDK compatibility, LGPD boundaries, no automatic signing and no fee
activation. The specialists are development reviewers with no transaction path.
