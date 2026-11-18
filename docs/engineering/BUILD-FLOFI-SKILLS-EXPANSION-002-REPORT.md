# BUILD-FLOFI-SKILLS-EXPANSION-002

Expanded FloFi engineering skills from 17 to 29 while preserving the existing 19
Codex specialists and their 19 generated Claude Code twins. Skills remain
reference-only engineering knowledge: they never run, sign, submit or decide, and
no product runtime imports them. The execution capability registry and
deterministic tests remain the financial authority.

This change updates skill manifests, selection, coverage ownership, registry
verification and engineering documentation. No product financial execution logic,
production configuration, environment variables, database schemas, wallet signing,
transaction execution, fee policies, agent security boundaries or required CI
certification gates changed.

## Skills delivered

| Skill | Owner domain(s) | Capability tuples | Notes |
| --- | --- | --- | --- |
| `networks/robinhood` | flofi-protocol-integrations (+ adjacent) | Registered Robinhood mainnet swap/liquidity/transfer/bridge tuples | Depends on `networks/evm-core` |
| `protocols/0x` | flofi-swap (+ adjacent) | None | Knowledge only; FloFi has no registered 0x EXECUTE path |
| `operations/account-abstraction` | flofi-wallet-execution | None | EIP-4337/7702 guidance; no invented AA product capability |
| `operations/gas-abstraction` | flofi-wallet-execution | None | Paymaster/Kora guidance; empty capabilities until registry EXECUTE rows exist |
| `operations/wallet-infrastructure` | flofi-wallet-execution | None | Privy/session/connection guidance |
| `operations/token-transfers` | flofi-transfer-payments | Existing transfer tuples only | ERC-20/SPL/native paths already registered |
| `engineering/mcp` | flofi-mcp | None | OAuth routes, transport and handoff |
| `engineering/ai-orchestration` | flofi-chat | None | Provider fallback, bounded calls, caching |
| `engineering/finops` | flofi-admin-analytics | None | Unit economics and billing meters |
| `engineering/web3-security` | flofi-security | None | Authz, identity and signing boundaries |
| `engineering/neon-postgresql` | flofi-data-privacy | None | Migrations, pooling, fixtures |
| `engineering/infrastructure-cicd` | flofi-infrastructure-ci | None | CircleCI/Railway/health and drain |

The prior 17 network/protocol/operation skills remain. Existing skills
`networks/evm-core` and `operations/{execution,bridge}` were adjusted only for
accurate dependency and selection coverage. Totals: **29 skills**, **19 Codex
roles**, **19 Claude twins**.

## Selection and ownership

- Path globs now cover OAuth routes, wallet connection state, fee/compiler and
  database fixture paths identified in specialist review.
- Task selection is deterministic (normalized case/punctuation) and focused so
  unrelated engineering skills are not pulled into financial diffs.
- `agent_evolution.py` selects skills from every changed path (including new
  skill files and tests) and keeps ownership gaps independent of skill matches.
- Nine new `skills--*` modules in `coverage.json` assign exact skill files to
  primary owners with suites and honest gaps. `COVERAGE.md` regenerated.

## Specialist review disposition

Codex completed domain contract reviews for the affected owners (protocol
integrations, wallet/execution, MCP, security, infrastructure, data/privacy,
admin/analytics, chat, swap and transfer) and mapped the missing selection
paths. Focused selector unit tests cover those paths.

Cursor resumed after Codex hit its usage limit. Cursor did **not** re-invoke the
repository's named Codex CLI or Claude Code specialists as native subprocesses
for a second full review pass. Cursor used the same domain contracts from
`agent_guard.py impact` / `domain`, the recovered Codex review artifacts under
`/tmp/flofi-skills-*`, and the Cursor `flofi-*` read-only reviewer contracts as
references. That limitation is intentional to avoid duplicating completed review
work; CircleCI remains the certification authority.

## External source verification

`python3 scripts/skill_registry.py verify` passes with 29 skills. Source status
mix is verified pins plus pending leads. `check-upstream --fetch` on 2026-11-18
observed:

| State | Count | Disposition |
| --- | ---: | --- |
| UNCHANGED | 65 | Digest match |
| CHANGED | 11 | Mutable vendor HTML/docs drifted after pin; left pending for weekly review (no silent re-pin) |
| UNPINNED | 9 | Existing unpinned leads |
| UNREACHABLE | 3 | `solana.com/skills`, `dev.orca.so`, Uniswap Trading API docs |

External documentation availability is not a mandatory online CI dependency.
Pending provenance stays pending until license, immutable revision and FloFi
guidance are reviewed.

## Validation

Recovered and completed locally on Node 24.21.0 / pnpm 11.22.0:

| Check | Result |
| --- | --- |
| `python3 scripts/agent_guard.py check` | PASS (19 domains, 185 modules) |
| `python3 scripts/skill_registry.py verify` | PASS (29 skills) |
| `python3 scripts/agent_guard.py claude-agents` | PASS (19 twins match Codex) |
| `python3 scripts/verify_codex_agents.py` | PASS (Codex CLI 0.170.0; 19 roles; loopback) |
| `python3 scripts/verify_claude_agents.py` | PASS (Claude Code 2.1.316; 19 Read-only; loopback) |
| `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` | PASS (328 tests) |
| `python3 scripts/governance_lite.py` | PASS |
| `python3 scripts/skill_registry.py check-upstream --fetch` | Advisory report (see above) |
| Focused `engineering-skills.test.ts` | PASS (3 tests) |
| `pnpm check` (Node 24.21.0) | PASS — typecheck, lint, build, 11 schema exports; Test Files 724 passed \| 2 skipped; Tests 9386 passed \| 2 skipped |

An earlier Codex `pnpm check` was interrupted by the usage limit after a
sandbox/loopback restart; its final result was not trusted. A subsequent local
run on Node v24.22.1 failed the schema-export pin before tests; that is a local
toolchain PATH mismatch (Cursor agent Node shadowing nvm), not a product
regression. The delivery rerun used `/home/asus/.nvm/versions/node/v24.21.0`.

## CLI and evolution compatibility

Offline Codex and Claude discovery probes passed through loopback with zero
external model responses. Agent Evolution still publishes an advisory JSON report
from the merge-base; weekly maintenance continues to combine upstream
observations with ownership, parity and regression gap checks without adding
scheduled paid infrastructure.

## Remaining gaps

- Pending and changed external sources need separate human provenance review.
- Empty capability arrays on AA/gas/wallet/0x/engineering skills are deliberate:
  skills must not invent MAINNET EXECUTE rows.
- Hosted MCP clients, live Privy, Neon rollout and Railway edge behavior still
  require separate acceptance evidence outside this engineering-only build.
