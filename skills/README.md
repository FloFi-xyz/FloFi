# FloFi multichain engineering skills

Versioned, reviewed network and protocol knowledge for FloFi's existing 19 engineering specialists (`.codex/agents/`,
`.claude/agents/`). A skill is **reference material for engineers and reviewers**: it never runs, signs, submits, routes or
decides anything, and no product runtime code imports it (a unit test enforces this). The deterministic runtime and the
execution capability registry remain the financial authority; tests remain the evidence.

```
skills/
  registry.json                 index + official publisher locations (URL prefixes)
  networks/{evm-core,ethereum,base,arbitrum,solana}/
  protocols/{uniswap,aave,jupiter,orca,across,lifi,relay}/
  operations/{swap,bridge,liquidity,lending,execution}/
    skill.json                  manifest: scope, domains, paths/keywords, registered capabilities, sources, digests
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
for the changed paths. Selection is deterministic (path globs, task keywords, explicit network/protocol/operation, then
dependencies), batched to the three-subagent limit, and never filters CI.

## Provenance and updates

- Every source records its URL, publisher, kind (official docs, SDK, skill or third party), licence and status.
  `VERIFIED` requires an official location listed in `registry.json`, a recorded licence, the reviewed revision and the
  normalized sha256 of the reviewed content. Third-party material is `VERIFIED` only after a cross-check against
  verified official sources; until then it is a lead, not guidance.
- `check-upstream --fetch` re-fetches each source over HTTPS (same-host redirects only, 2 MiB bound), hashes it and
  reports `UNCHANGED`, `CHANGED`, `UNPINNED`, `STALE` or `UNREACHABLE`. It never parses, renders or executes remote
  content and never edits a manifest; `--proposal FILE` writes a review proposal for a normal pull request.
- Editing a `SKILL.md` changes its digest: record it with `skill_registry.py digest <id>` in the same reviewed change.
- New maintained files here must be listed in `docs/engineering/coverage.json` (module `skills--protocol-integrations`).
