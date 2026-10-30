# FloFi engineering orchestration

Read [CLAUDE.md](CLAUDE.md), [scope guard](docs/SCOPE_GUARD.md) and applicable
nested AGENTS.md before changing code. Owner instructions govern. Use a named
branch and deliver a PR for owner review; never merge, deploy or operate funds.

Before implementation, run `python3 scripts/agent_guard.py check` and
`python3 scripts/agent_guard.py impact --base origin/main`. The explicit source
inventory, domain dependencies, suite references and known gaps live in
[coverage.json](docs/engineering/coverage.json); usage and capability limits are
in [the engineering guide](docs/engineering/README.md).

Delegate independent reviews to the affected `.codex/agents/flofi-*.toml`
specialists. Use the impact report to select reviewers; do not spawn all 19.
Claude Code uses generated read-only twins in `.claude/agents/` with the same
domains and coverage.json contracts. After editing a Codex role, review
`python3 scripts/agent_guard.py claude-agents` and apply it with `--overwrite`.
For shared financial-core changes always include flofi-workflow integration
review and affected action domains, with flofi-security for authorization or
identity boundaries. Review each affected boundary even when work runs in batches.
Keep at most three subagents active (plus the main agent), and no grandchildren.
Small documentation-only work can stay in the main agent.

Reviews are read-only by default. Assign explicit disjoint file ownership before
delegating edits; main owns shared files and coordinates transfers. Subagents must
escalate cross-domain findings to main, with severity, impacted paths, concrete
failure/reproduction and test evidence. Main resolves findings and runs integration
checks after combining work. Report unresolved risks and skipped/failed/not-run
checks. An AI review is advisory and never a deterministic certification pass.

New maintained source files must be assigned explicitly to a module in coverage.json
with a primary domain, dependencies and relevant suites or an honest coverage gap.
Do not regenerate ownership blindly or remove tests/gates to make checks pass.
Run focused suites, normal repository gates and applicable PostgreSQL/fork/browser
checks. CircleCI's existing certification ledger remains authoritative.

Preserve mainnet-first public UX, optional Canvas, chat/MCP workflow continuity,
tenant/wallet isolation and explicit applicable wallet authorization. Registry
capabilities, current source and reproducible tests outrank historical reports.
Never invent action/network support, activate deferred fees, add transaction-path
agents, assume delegated signing, change production configuration or credentials,
or create/sign/broadcast real-money transactions. Replay, fixtures and disposable
loopback forks are test evidence only; never report them as public execution.
