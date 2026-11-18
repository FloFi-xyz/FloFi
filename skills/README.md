# FloFi engineering skills

Versioned, reviewed network, protocol, execution and engineering knowledge for FloFi's 19 specialists (`.codex/agents/`,
`.claude/agents/`). A skill is **reference material for engineers and reviewers**: it never runs, signs, submits, routes or
decides anything, and no product runtime code imports it (a unit test enforces this). The deterministic runtime and the
execution capability registry remain the financial authority; tests remain the evidence.

```
skills/
  registry.json                 index + official publisher locations (URL prefixes)
  networks/{evm-core,ethereum,base,arbitrum,solana,robinhood}/
  protocols/{uniswap,aave,jupiter,orca,across,lifi,relay,0x}/
  operations/{swap,bridge,liquidity,lending,execution,account-abstraction,gas-abstraction,wallet-infrastructure,token-transfers}/
  engineering/{mcp,ai-orchestration,finops,web3-security,neon-postgresql,infrastructure-cicd}/
    skill.json                  manifest with scope, domains, paths, keywords, capabilities, sources and digests
    SKILL.md                    FloFi-written guidance (its sha256 is pinned in skill.json)
```

## Using skills

```sh
python3 scripts/skill_registry.py verify                          # also part of agent_guard.py check (CI)
python3 scripts/skill_registry.py select --base origin/main       # skills + specialists for the current diff
python3 scripts/skill_registry.py select --task "speed up the Jupiter build" --network solana
python3 scripts/agent_guard.py domain flofi-swap --base origin/main   # the domain contract now lists its skills
```

`agent_guard.py impact` and `domain` include a `skills` section: the `SKILL.md` files a read-only specialist should Read
for the changed paths. Selection is deterministic over path globs, exact skill-file paths, whole task words or phrases,
explicit network/protocol/operation, and dependencies. Use `dependsOn` for guidance needed whenever the skill is
selected. Use Markdown links for optional related topics. Capability tuples are optional in purpose and represented
by an empty array when the skill has no matching registered mainnet action. Delegation is batched to the
three-subagent limit. CI still runs its complete suite.

## Provenance and updates

- Every source records its URL, publisher, kind (official docs, SDK, skill or third party), licence and status.
  `VERIFIED` requires an official location listed in `registry.json`, a recorded licence, the reviewed revision and the
  normalized sha256 of the reviewed content. Third-party material is `VERIFIED` only after a cross-check against
  verified official sources; until then it is a lead, not guidance.
- `check-upstream --fetch` re-fetches each source over HTTPS (same-host redirects only, 2 MiB bound), hashes it and
  reports `UNCHANGED`, `CHANGED`, `UNPINNED`, `STALE` or `UNREACHABLE`. It never parses, renders or executes remote
  content and never edits a manifest; `--proposal FILE` writes a review proposal for a normal pull request.
- Editing a `SKILL.md` changes its digest: record it with `skill_registry.py digest <id>` in the same reviewed change.
- Assign every new manifest to its domain's skills module in `docs/engineering/coverage.json` with exact suites and gaps.

Use the weekly maintenance procedure to combine upstream observations with
ownership, parity and regression gap checks. [Agent Evolution](../docs/engineering/AGENT-EVOLUTION.md)

The expansion report records the skills, their reviewed source status and the domain matrix.
[BUILD-FLOFI-SKILLS-EXPANSION-002](../docs/engineering/BUILD-FLOFI-SKILLS-EXPANSION-002-REPORT.md)
