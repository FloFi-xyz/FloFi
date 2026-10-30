# FloFi engineering agents and regression contracts

This is repository engineering infrastructure. The 19 custom Codex agents review
changes; they do not participate in end-user transactions. Deterministic tests
remain the product evidence, and CircleCI remains the certification authority.
Claude Code uses 19 generated read-only twins of the same roles and contracts;
see [the Claude Code guide](CLAUDE-CODE.md).

The inventory was audited against main `9e95b5c55d3e51ccfa5929819d3f15039db09f59`.
Current source and capability registries take precedence over old build reports.
PR [#137](https://github.com/alrimarleskovar/FloFi/pull/137) was open and draft at
implementation: its favorable Base requote fix and implementation files are not
included here. Follow-up acceptance must include that fix after owner review.

## Ownership and review

[COVERAGE.md](COVERAGE.md) is the generated module/owner/dependency/test matrix.
[coverage.json](coverage.json) enumerates each maintained source file, primary
owner, known domain dependencies, representative suites and explicit evidence
gaps. Static assets, migrations, route entry points, scripts and platform configs
are included. Documentation, test fixtures and vendored legal material are
outside the production inventory; existing governance/tests still protect them.
Published machine-readable API/security contracts under docs/ are included too.
Unknown new roots are included by default, so adding a new API/service cannot
silently inherit a permissive directory ownership rule.

The specialties cover swap, bridge, lending, liquidity, transfers/payment journeys,
workflow, chat, MCP, channels, wallet/execution, security, developers, automations,
frontend UX, admin/analytics, data/privacy, infrastructure/CI, protocol integrations
and payments/billing. MCP protocol/authentication and channel delivery have distinct
owners. Adjacent responsibilities are coordinated through the module dependencies.

In a trusted Codex project, start a new session at the repo root:

```sh
python3 scripts/agent_guard.py check
python3 scripts/agent_guard.py impact --base origin/main
```

Ask: “Review this change with the affected FloFi specialists from the impact
report. Include flofi-workflow for shared core; keep at most three subagents
active. Return reproducible defects and evidence gaps.” Codex can spawn the
named project agents. Batch reviews when there are more affected domains than
slots. Do not launch 19 reviews for every edit. Assign disjoint file ownership
before authorizing edits; the main agent resolves integration conflicts.

Shared-core inventory rows expand financial/integration review. Changes to mapped
test suites select their owners too. The impact command compares the explicit
base's merge-base to the working tree, including new untracked files; it never
fetches or changes branches. It is advisory selection, never a CI test filter.
CI continues to run the existing complete required suites on every PR.

These definitions follow the officially supported
[project-scoped custom-agent format](https://learn.chatgpt.com/docs/agent-configuration/subagents).
They inherit the parent model, permissions and tool configuration. Project config
bounds concurrent subagents to three. Root AGENTS.md requests selective delegation;
nested Next.js instructions and CLAUDE.md remain applicable.

Validate the installed harness, separately from CI:

```sh
codex --version
python3 scripts/verify_codex_agents.py
```

The probe uses a disposable Codex home and a rejecting loopback endpoint. It
inspects the actual spawn tool schema for all 19 names/descriptions, without a
model response, external AI service, credentials or financial operations. The
CLI's intentional HTTP rejection is not an agent/model test. The command fails
if the installed CLI cannot discover the roles. Verified with Codex 0.163.0.
Project trust/managed settings can restrict availability; do not weaken them.

## Maintaining the contract

When adding or moving a maintained file, explicitly update its module's `sources`
in coverage.json. Review its primary domain and dependencies. Add exact suite
paths with their existing certification stage, or describe the missing coverage
in `gaps`. A new domain concern must receive deliberate ownership; do not blindly
auto-generate assignments. Deletion of a mapped source or suite also requires a
reviewed inventory update. A file cannot have multiple primary owners.

For new required regression contracts, add the suite ID to `requiredUnitSuites`
or `requiredPostgresSuites`; keep these suites unconditional and free of owner/provider
credentials. Regenerate the readable matrix and run the guards:

```sh
python3 scripts/agent_guard.py report > docs/engineering/COVERAGE.md
python3 scripts/agent_guard.py check
python3 -m unittest discover -s scripts -p 'test_ci_*.py'
python3 -m unittest discover -s scripts -p 'test_governance_lite.py'
python3 scripts/governance_lite.py
```

Run focused Vitest suites during development. The normal workspace gates remain
typecheck, lint, build, schema drift and unit tests. After building package exports:

```sh
pnpm test --reporter=default --reporter=json --outputFile=/tmp/flofi-agent-unit.json
python3 scripts/agent_guard.py verify-results /tmp/flofi-agent-unit.json
```

Use disposable loopback PostgreSQL for `pnpm test:postgres` and the existing
closed replay/fork and guarded browser runners for relevant integration changes.
Never substitute public providers or wallet funds for a missing local fixture.
The existing PostgreSQL CI run also emits JSON and runs
`python3 scripts/agent_guard.py verify-results --stage postgres <report.json>`.

## Automatic protection and evidence limits

| Mechanism | Runs automatically | What it establishes |
| --- | --- | --- |
| Agent TOML and ownership guard/self-tests | Existing Governance/Contracts CI | Exact 19-agent schema, bounded pool, complete explicit maintained-file inventory, valid dependencies, extant suites/gaps and current matrix |
| New registry regression | Existing unit run | Every registered public execution capability retains wallet/network/artifact/simulation/authorization boundaries; unsupported identities fail; readiness never promotes evidence |
| New cross-surface regression | Existing unit run | Scripted EN/PT clarification, actual Canvas reducer, channel canonicalization, direct engine and MCP share current hashes and native ETH/WETH identity; stale hashes and public testnets refuse |
| Required suite result verifier | Existing Unit/contract and PostgreSQL stages | Each designated suite appears exactly once, contains cases, and every case passed; skipped/todo/missing/failed cases fail the stage |
| Existing PostgreSQL/fork/browser/security gates and ledger | Unchanged complete CI | Existing durability, isolation, browser, fork, dependency/audit/SBOM and certification requirements |
| Claude twin parity, settings and hook self-tests | Existing Governance/Contracts CI | 19 generated read-only Claude agents match their Codex roles, exact hook settings, no local Claude state, guard and ledger behavior |
| Selective specialist review | Active Codex or Claude session | Advisory domain/integration review with concrete defects and test evidence; no deterministic pass |
| Claude lifecycle ledger | Claude Code hooks, locally | Which specialists actually started and completed, their structured result, guard denials and recorded gates; not certification |
| Owner/provider/real-wallet acceptance | Explicit manual acceptance | Real extension/device behavior, external OAuth clients/provider delivery and actual supported public execution |

Standalone result verification trusts its input report; it does not bind an
arbitrary report to a Git revision or prove freshness. CI produces and verifies
each report in the same fail-fast stage. No standalone report replaces the ledger.

The ownership guard is structural coverage, not measured line/branch coverage or
a guarantee that every module has a dedicated behavioral test. Suite pointers
are representative and module gaps remain visible. It prevents silent unowned
additions and lost mapped suites; it does not infer business behavior or make
PR-controlled code tamper-proof. Owner review and owner-managed branch protection
are still required. All old certification stages and guarded browser profiles
remain required. Existing optional owner-only fork cases may skip; they remain
explicit limitations and are not designated required unit regressions.

Capabilities must be resolved from `executionCapabilityRegistry` and applicable
runtime gates. Discovery/reference catalogs are not evidence of execution.
Developer credentials are sandbox-only; WhatsApp is fixture-only; automation
proposals do not imply production delegated signing. Payment provider support
is conditional, Mercado Pago does not charge, and existing 10 bps obligations
remain `NOT_SETTLED`. This build does not activate fee collection.

Offline fixtures, replay, injected wallets and disposable forks establish their
stated test behavior only. They do not establish public-chain settlement, live
model understanding, external ChatGPT/Claude acceptance, Neon production
operations, full accessibility/LGPD compliance or arbitrary action composition.
See the [engineering report](BUILD-FLOFI-AGENTS-001-REPORT.md) for actual results.
