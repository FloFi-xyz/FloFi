# BUILD-FLOFI-UNIVERSAL-E2E-001 dependency security correction (zod)

CircleCI rejected BUILD-FLOFI-UNIVERSAL-E2E-001's first pipeline at the `Dependency audit` stage of `certification-checks` (job 250). The
cause was a new advisory against a transitive dependency of the official MCP SDK. The build itself changes no dependency. `main`
(`78ea792`) carries the same graph, so every branch fails the same audit until the graph is corrected. This correction is a separate
branch from `main` (`codex/build-flofi-universal-e2e-001-deps`), and the build is stacked on it.

## Advisory

[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high: "Zod can exhaust memory while validating oversized
constrained collections". Vulnerable `< 4.6.6`, first patched `4.6.6`.

The repository's only consumer is the MCP SDK, through two paths:

- `@modelcontextprotocol/server@2.3.0 > zod`
- `@modelcontextprotocol/server@2.3.0 > @modelcontextprotocol/core@2.3.0 > zod`

The server validates untrusted MCP requests with it, so the advisory applies.

## Change

| Package | Version change | Published UTC | License | Dependencies |
| --- | --- | --- | --- | --- |
| `zod` | `4.6.5` → `4.6.6` | 2026-10-11T16:18:23.878Z | MIT | none |

`4.6.6` is the advisory's exact patched version. It is 12 days old, which passes the 7-day `minimumReleaseAge`, so no waiver is needed.
Both SDK packages declare `zod: ^4.2.0`, so the patch stays inside their own ranges.

The change follows the existing pattern in `pnpm-workspace.yaml` ("exact security patches for the existing transitive consumers only"):
two exact overrides, `'@modelcontextprotocol/server@2.3.0>zod': 4.6.6` and `'@modelcontextprotocol/core@2.3.0>zod': 4.6.6`.

The lockfile changes only the `zod` identity, its integrity
(`sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==`, equal to the registry's) and the two
snapshot edges.

The graph still contains **263** registry identities, and no package name is new. The reviewed `packages` / `snapshots` graph SHA-256 in
`scripts/bootstrap-ci.py` moves from `7ee7f5d8…7e3d6d` to
`09b25974a6387957335365ee01f5fbe770be8a50eff72b570b5f9c7f450c016c`. The gate continues to reject any other graph.

## Verification (local, 2026-10-23)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `python3 scripts/bootstrap-ci.py --verify-dependencies` | 263 entries, integrities and release ages verified against fresh registry metadata; the 16 reviewed license exceptions unchanged; dependency evidence SHA-256 `60c4e81862e5f6d00779247901dd03ad5895f6824ae92a65bd556dbe0d824424` |
| `pnpm audit --audit-level low` | No known vulnerabilities |
| `scripts/test_*.py` (75 tests) | Passed |
| Unit suite (`pnpm test`) | 408 files: 4,779 passed, 2 skipped (pre-existing), 0 failed |

The MCP PostgreSQL suites, which exercise the SDK end to end, run in CircleCI `certification`.
