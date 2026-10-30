# BUILD-FLOFI-AGENTS-001 engineering report

## Scope and audited baseline

Worktree: `~/projects/flofi-agent-guard-001`; branch:
`codex/build-flofi-agents-001`. A fresh fetch confirmed HEAD and origin/main at
`9e95b5c55d3e51ccfa5929819d3f15039db09f59` before implementation. The checkout
was clean. Root CLAUDE.md, scope governance, nested Next.js guidance, all workspace
packages, dapp modules, tests, channel/MCP/OAuth routes and certification paths
were inspected. Source and reproducible results were used over historical reports.

Relevant open work included draft PR #137 (Base favorable requotes) and PR #102
(Cloud Build bootstrap), plus older feature drafts. No implementation was copied
from #137; its `public-testnet-service.ts` and `base-swap.test.ts` files are
unchanged by this branch. Its financial fix remains a separate owner review and
acceptance dependency. This build neither fixes nor certifies that outstanding P0.
The existing Base swap suite is mapped and required, so future merged requote
regressions run through the same result enforcement.

## Delivered protections

- Nineteen supported project-scoped Codex definitions, with inherited model and
  permission settings; a three-subagent concurrency ceiling; concise root
  orchestration compatible with CLAUDE.md and nested instructions.
- An explicit inventory of **1,149 maintained files in 160 module groups**,
  covering all 19 primary domains. It includes routes, schemas, SQL migrations,
  static assets, scripts, deployment configs and machine-readable API/security
  documents. New unknown source roots fail closed instead of inheriting ownership.
- [The matrix](COVERAGE.md) and [machine inventory](coverage.json) contain primary
  owners, domain dependencies, 114 representative suite references and gaps.
  Missing/duplicated ownership, stale/deleted sources, invalid agents, missing
  suites and stale documentation fail deterministic checks.
- **195 new capability contracts** dynamically cover every registered executable
  public profile: wallet/network/artifact/simulation/authorization refusals,
  unsupported identities and evidence ceilings. Fork replay cannot become public
  execution evidence. They query the real capability resolver without providers.
- **Four new cross-surface contracts** compose scripted EN/PT clarification with
  the real Canvas reducer, channel canonicalization, direct engine and HTTP MCP
  gateway. Native ETH/WETH identity and current semantic hashes agree; old/edited
  hashes and public test-network requests fail. All fetch and execution ports are
  blocked. Swap-to-bridge in these tests establishes authoring parity only.
- The same existing unit and PostgreSQL runs emit JSON. The guard requires
  **26 unit suites and 26 PostgreSQL suites**, each present once with nonempty
  assertions and every case passed. Missing, failed, skipped, pending or todo
  required cases fail the existing certification stage.
- CircleCI, GitHub Actions and full GCP fallback retain the same **18 ledger
  stages and 49 guarded browser profiles**. No build/job/full-suite duplication,
  relaxed security gates, changed dependencies or paid AI CI service was added.
- GCP source snapshots allow exactly the bounded project config and 19 known
  agent definitions, preserving exact archive digests and credential/symlink
  refusal. Local upload-file enumeration confirmed those 20 files; no upload or
  Cloud Build execution occurred. The historical source snapshot is untouched.

Independent advisory reviews found dispatch gaps for billing routes, channel
learning privacy, database ownership, shared-core chat consumers and published
machine contracts. Those mappings were corrected and have deterministic dispatch
assertions. Advisory reviews are not included in test pass totals.

## Local validation

Toolchain: Node 24.21.0, pnpm 11.22.0, PostgreSQL 18.6, pinned Anvil 1.8.3 and
headless-shell revision 1243. Dependencies were installed from the existing cache
with the frozen lockfile and lifecycle scripts disabled. PostgreSQL used a new
disposable `/tmp` cluster on loopback port 55439; no remote database was accessed.

| Check | Actual result |
| --- | --- |
| Installed Codex discovery | PASS: Codex 0.163.0 exposed all 19 names/descriptions in its actual spawn tool schema; loopback rejecting endpoint, zero model responses |
| Ownership/matrix/agent contract | PASS: all 19 domains, 160 groups, 1,149 inventoried files; no unmapped maintained files |
| Focused new/financial suites | 230 passed in 8 suites, including native ETH, exact Review bytes, simulation and composition/recovery |
| Full typecheck and lint | PASS |
| Production app and all package builds | PASS; initial restricted-process attempt could not parse TypeScript subprocess output; unchanged build passed outside that sandbox |
| Schema drift | PASS: 11 unchanged schema exports |
| Full unit/contract run | 5,712 passed, 2 existing optional skips, zero failures; all 26 required suites passed every case |
| Full PostgreSQL run | 513 passed, 3 existing certified-ahead compatibility skips, zero failures; all 26 required suites passed every case |
| Python CI/inventory/parity/source-snapshot tests | 108 passed after the CLI compatibility follow-up, including 35 guard self-tests and skipped/missing-result refusal checks |
| Governance self-tests and scanner | 19 passed; scanner and whitespace checks passed |
| Anvil compatibility | 4 passed, 10 owner-gated skips |
| Offline fork suite | 31 passed, 32 owner-gated skips; no public financial execution claim |
| Five fresh-process synthetic fork rehearsals | PASS: five passes, 50 provider-equivalent local requests each; MOCKED engineering evidence |
| MCP in-chat browser profile | Independent complete second attempt: 26 passed in 76.46 s. First full attempt: 25 passed, 1 timeout; its diagnostic retry passed but its original profile remained FAILED |
| Dependency integrity/license/release age | PASS: 263 exact locked registry entries, unchanged approved exceptions |
| Dependency audit | PASS: no known vulnerabilities |
| Ephemeral CycloneDX 1.6 SBOM | PASS: 263 registry components, ten workspace manifests/importers independently checked, 16 reviewed license exceptions; generated SBOM removed |

An earlier full unit attempt inside the restrictive process sandbox failed
existing subprocess/loopback tests (`EPERM`), and is not counted as a pass. The
complete unchanged suite was rerun outside it. The first standalone SBOM attempt
lacked the dependency-evidence file from the preceding stage; the completed
ordered-input run passed. No tests or timeouts were weakened to obtain results.

Reproduce inventory and evidence checks with the commands in [README.md](README.md).
The new suites run through normal `pnpm test`. Full unit and PostgreSQL JSON
reports are verified in the same CI stage that creates them; standalone report
verification is not bound to a revision and cannot prove freshness or certification.
Local logs/reports and browser artifacts remain outside tracked source under
`/tmp/flofi-agent-*` and the ignored dapp `test-results` directory. These are local
engineering observations, not a CircleCI certification ledger for a published SHA.

### CircleCI follow-up: Python 3.12.3 argument parsing

The first CircleCI run on `f7b009a` passed governance and both complete browser
jobs. In [certification-checks job 753](https://app.circleci.com/workflow/b9b00e92-8046-4da5-8822-f3bd1a8decdc/job/b791db46-0417-4a0a-8cda-5cff92328e2d),
all 513 PostgreSQL tests passed (three existing compatibility skips), then the
new verification command exited 2 with `unrecognized arguments` for its report
path. CircleCI uses Python 3.12.3; the local implementation run used 3.14.4.
That older parser does not consume the optional report positional after
`--stage postgres` when using `parse_args()`.

The guard now uses strict `parse_intermixed_args()`. Five real subprocess CLI
tests cover the exact unit/PG commands, report/option ordering, required-case
failures, missing reports, unknown options and excess positionals. Required
suite lists, failure criteria, CI commands and ledger requirements are unchanged.
The exact CPython 3.12.3 argparse source reproduced the pre-fix failure locally;
all 35 guard tests pass with that parser and with local Python 3.14.4. The full
Python CI suite passed 108 tests and governance passed 19 after the fix. Product
test counts above remain evidence from the implementation run; the new CircleCI
run on the fix is authoritative for certification.

## Coverage gaps and acceptance boundaries

All maintained files have a primary owner. This is **structural ownership
coverage**, not measured line/branch coverage or a claim that every file has its
own behavioral test. One group, `acceptance-utilities` (12 operator entry points),
explicitly has no mapped dedicated deterministic suite. Underlying engine tests
do not certify those scripts. Static assets have selected presentation tests but
no behavioral check for every individual file. Other groups list representative
tests and explicit limitations in the matrix.

Untested or externally dependent boundaries remain:

- PR #137's favorable/deteriorated requote acceptance on the owner-wallet Base
  runtime; this branch deliberately leaves that separate fix untouched.
- Live public settlement, provider/RPC uptime, extension/hardware-wallet signing
  ceremonies and real-user authorization. Injected wallets and replay are test
  provenance, not public-chain success.
- General public action composition: registry discovery is not executable
  support. Generic composition bindings remain finite (including Orca Devnet),
  with separately tested finite EVM/local and lending flows; arbitrary mainnet
  swap-to-bridge/liquidity sequences are not certified.
- External ChatGPT/Claude OAuth/client acceptance, Telegram provider delivery and
  real partner/webhook receivers. WhatsApp remains fixture-only with hosted
  refusal. Developer API credentials remain sandbox-only.
- Production delegated signing and unattended DCA financial execution. Automation
  proposals retain applicable user confirmation and wallet authority.
- Hosted Neon operations, real retention/deletion operations, legal LGPD
  acceptance, complete accessibility/device/language audits and production
  analytics completeness.
- Payment-provider availability and real charges. Woovi is configuration gated,
  PixBlock is unavailable, Mercado Pago stores tokenized card metadata without
  charging, and existing 10 bps obligations remain `NOT_SETTLED`.
- The two optional unit skips, three certified-ahead PostgreSQL skips and
  owner-gated fork skips above are **not passing tests**. None belongs to the
  designated required result lists. Their missing acceptance remains visible.
- This local run does not replace the complete CircleCI browser matrix or owner
  branch protection. The first MCP browser timeout is retained as a flakiness
  observation; a diagnostic retry is never promoted into certification.

## How future work is protected

**Automatic on every PR:** existing complete CI, inventory/schema/dependency
guards, new deterministic contracts, mandatory unit/PG result verification,
existing browser plan and certification fan-in. New maintained modules must
receive deliberate ownership and tests or explicit gaps; deletion of mapped
suites cannot silently preserve a structural pass. Shared-core changes retain
the full CI suites and request cross-domain review.

**Requires an active Codex session:** impact analysis, selective specialist
reviews, coordination of disjoint edits and escalation/resolution of findings.
Agents are available for future sessions; no always-on model service is required.

**Requires manual/external acceptance:** supported real wallets, external
clients/providers, real public execution and hosted operational acceptance.
There were no production flag/infrastructure/database/credential changes, real
transactions, financial signatures, fee activation, deployments, merges or
automatic merging. No runtime transaction agent was introduced.
