# BUILD-ARB-001 — Phase 8 local certification

Date: 2026-10-12. Local CI equivalence: **PASS**. GitHub certification and merge must evaluate the final pushed commit.
Worktree: `/home/asus/projects/flofi-arb`; branch: `codex/build-arb-001-network-ux`.
Current main / merge base: `4df974f6ae6ae1d22b86f220db6281294cd20035` (BUILD-BASE-001 / PR #81).
Main was fetched again after validation and remains the branch's ancestor; no integration/restack was needed.
Resolve this certification's commit with `git log -1 --format=%H -- docs/builds/BUILD-ARB-001-PHASE-8-CERTIFICATION.md`.

## Recovery and scope

Recovered HEAD `0924cb2c64997ecc6c8bdc1774f780007aa57433` already contained the final toolbar distribution correction.
The actual worktree contained 13 uncommitted files from the preceding account; no Phase 8 validation process remained active.
Existing completed logs were reviewed before resuming. No branch or worktree was created, and phases 1–7B were preserved.

The implementation covers Arbitrum registration/catalogs, existing owner-wallet swap and Send adapters, bidirectional Base/Arbitrum
Router parity, existing Uniswap v3 liquidity and the bounded one-reserve Aave V3 runtime. Phase 6 certifies shared Canvas/chat/MCP/channel
authoring. Phase 7A's UX-001–007 and Phase 7B's toolbar fit, canonical insertion auto-fit and generic workflow connections are retained.
Arbitrary authoring dependencies grant no additional financial execution authority.

## Phase 8 repairs and classifications

The earlier records' “pre-existing” labels described inheritance from earlier BUILD-ARB phases, rather than independence from current main.
Current-main diagnostics passed typecheck, the four routing cases, and the original lending suite (61 tests).

- The Robinhood transfer panel's unchecked partial-network lookup was a BUILD-ARB type regression; optional lookup fixes it without changing a transfer policy.
- The new Arbitrum swap profile intercepted existing BUILD-009 and liquidity engineering graphs. Restoring their graph-level route priority
  fixes all four browser cases; their MOCKED financial refusal boundaries remain asserted.
- The Phase 7B keyboard projection advertised the mandatory lending health-check link as removable. Both mandatory links are now protected
  and tested through canonical DISCONNECT; generic authoring connections remain supported.
- Shared channel/Robinhood expectations and generated OpenAPI now match the implemented catalog/network contract. Refusal tests still require
  failure and its exact code. The API document is committed exactly as generated.
- Canvas regressions now settle insertion auto-fit, compare exact persisted drag coordinates and unchanged canonical IR/revision/viewport,
  require real connectable handles and canonical dependencies, and reject cycles. The drag gesture keeps both handles reachable.
  Assertions that assumed financial links were unavailable were updated to the already-approved Phase 7B authoring behavior.
- The execution-result browser fixture encoded Supply-before-Swap only by array order. Its explicit canonical dependency now matches that
  recorded sequence; all partial/declined/attention/recovered assertions remain. This is a browser-only fixture change.
- Three existing screenshot baselines were individually inspected and updated only for the approved toolbar; no unrelated visual changes.
- The stricter account-risk mock added for Arbitrum had also changed the existing Base/Ethereum fixture. Its new semantics are scoped to the
  new revision-pinned profile; the legacy fixture behavior is preserved. The pending financial reconciler change was removed.
  Base composition service/compiler/reconciler are byte-identical to current main.
- The guarded CI script now runs the six Phase 7B Canvas tests in their passive-wallet, financial-gates-off profile.

**Independent pre-existing limitation:** using current-main service/compiler/reconciler and the unchanged original zero-collateral test,
a temporary stricter account-data fixture reproduces LENDING_REVIEW_REQUIRED after first Supply. The existing reconciler rejects the
legitimate account LTV/liquidation-threshold transition from zero (LENDING_POSITION_CONFIGURATION_MISMATCH). The main-source files were
checked byte-for-byte against origin/main and the diagnostic fixture restored afterward. Its 1 failure / 60 filtered skips is diagnostic
evidence, not a passing gate. No financial reconciliation guard was weakened or changed to hide this limitation.

## Final toolbar

Correction was already committed in `0924cb2`: space-between distribution only within the existing left action region.
1440 / 1536 / 1920: **PASS**. Existing action order is preserved; every action is visible on one row, including disabled Privacy.
No clipping, overlap or horizontal page scroll; residual whitespace is reduced without stretched buttons.
Editor-control geometry is unchanged when comparing distributed and former left-packed action layouts.
No Phase 8 typography, icon, color or Canvas layout redesign was introduced.

## Local CI-equivalent gates

| Gate | Result |
| --- | --- |
| Official toolchain bootstrap | PASS; archive digests verified, Node 24.21.0 / pnpm 11.22.0; tested executables byte-match the verified archives |
| Frozen install | PASS, --frozen-lockfile --ignore-scripts, ten workspace projects |
| pnpm check | PASS: typecheck, lint, production build, 11 schema exports, unit/contract suite |
| Unit/contract suite | 3,999 passed / 2 profile-dependent skips; 349 passed / 2 skipped files (351 total) |
| Final affected typecheck/lint | PASS after the browser-only fixture and guarded-profile additions |
| PostgreSQL | 337 passed / 53 files; isolated databases on the existing loopback container, PostgreSQL 18.6 and exact CI image digest |
| Anvil compatibility | 4 passed / 10 owner-account cases skipped |
| Standard fork suite | 31 passed / 29 profile/owner-input cases skipped, 5 passed / 8 skipped files |
| Offline F1 | PASS, five fresh-process rehearsals; 50 provider-equivalent requests each |
| Closed transcript validation | PASS: Base 286 provider requests / 37 local replies; liquidity 207 / 22; composition 122 / 30 |
| Closed composition fork | 3 passed / 3 files, serial execution against digest-pinned official artifacts on loopback |
| Composition provenance browser | 1 passed |
| Registry dependency integrity/release age/license | PASS: 265 entries; existing exact source-map-js@1.2.2 age waiver and 16 reviewed license exceptions unchanged |
| Dependency audit | PASS, --audit-level low; no known vulnerabilities |
| CycloneDX SBOM | PASS, 1.6; 265 registry components, ten separately verified manifests/importers; ephemeral file removed |
| Governance-lite | PASS; 19 governance self-tests + 22 current CI self-tests |
| Additional CI checks | PASS: guarded-script ESLint, screenshot-diff self-test, required linter exports/frozen profiles |
| Whitespace | PASS for the working diff and complete main-to-branch diff |

The full pnpm check ran after the integration repairs. The subsequent changes are confined to a browser-only fixture and the guarded
browser invocation; full typecheck/lint and the affected browser profiles ran afterward. Final certification documentation changes no code.
Completed Anvil/fork/offline/dependency/audit logs were reused after checking that their manifests, verifier/tool scripts, compiler/executor/
reconciler and fork inputs were unchanged from recovered HEAD. SBOM and exact toolchain identity were checked again.

Standard Anvil cases overlap the standard fork batch. The closed composition cases are conditional cases from the fork suite.
The two standard unit skips require separate smoke profiles. None of these skipped cases is described as passed.

## Guarded product browser profiles

All **29 profiles PASS**, zero skips. Exact per-profile counts follow. These are 249 test executions across the profiles;
shared specs run under distinct profiles, so this is not a claim of 249 distinct tests.
The already-completed 76-test default profile was retained when the next profile's fixture was corrected; only remaining profiles resumed.
The temporary resumption driver stayed under /tmp and did not alter CI or suppress a test in the repository.

| Profile | Passed |
| --- | --- |
| default-product | 76 |
| review-execute-recovery-components | 39 |
| workflow-acceptance | 5 |
| swap-read-acceptance | 2 |
| execution-continuity | 6 |
| automations | 2 |
| canvas-automation-ux | 18 |
| chat-automations | 8 |
| delegated-execution | 3 |
| supply-provenance | 5 |
| unsafe-lending-simulations | 2 |
| copilot | 13 |
| lending-provenance | 1 |
| jupiter-provenance | 1 |
| devnet-provenance | 1 |
| orca-liquidity-provenance | 1 |
| transfer-provenance | 2 |
| robinhood-mainnet-authoring | 4 |
| arbitrum-authoring-certification | 18 |
| workflow-ux-authoring | 11 |
| canvas-workflow-ux | 6 |
| base-mainnet-authoring | 4 |
| uniswap-provenance | 2 |
| router-provenance | 1 |
| journey-provenance | 1 |
| cloud-provenance | 1 |
| synthetic-fork-provenance | 2 |
| cow-loopback | 9 |
| card-provider-loopback | 5 |

Additional current CI browser invocations: MCP route presentation **11**; developer journey **1**; MCP in-chat plus route presentation **21**;
channel signing **6**; WhatsApp/Telegram approval **2**. Route presentation overlaps its standalone run.
The full Phase 7B/7A/Copilot confirmation batch passed **23** tests and overlaps the product profiles; it is not added to their total.
Core lending/Arbitrum/keyboard confirmation passed **137** tests and overlaps the full unit suite.

## Final diff and boundaries

All changed-file paths and the complete diff were reviewed, with focused review of execution gates, nonce/recovery, financial validation,
canonical graph operations and replaced test expectations. No test was deleted, disabled or weakened for a green gate.
All .github workflow definitions, dependency manifests/lock/settings and production configuration are unchanged.
No .env, credentials, secrets, temporary logs/results or accidental screenshots are included. The three intentional PNGs are existing
regression baselines. Tracked Python caches were removed in the earlier build and ignored; none was introduced by Phase 8.
No unexpected migration, unrelated UX work, production environment mutation, wallet-authority change or real-money transaction occurred.
Mainnet execution opt-ins remain default-off; MOCKED/read-only evidence grants no real-funds authority.

Known limitations remain: unsupported arbitrary financial DAGs fail closed; the Arbitrum Aave runtime is the registered USDC reserve with
bounded operations (no extra reserves, full/max/all Repay/Withdraw or mainnet lending composition); public owner-wallet mainnet execution
was not demonstrated; L2 inclusion is not L1 finality; the independent zero-collateral Base composition issue above persists.
Owner-input-only fork cases and unset smoke-profile unit cases retain their existing CI exclusions.

Local evidence stays under /tmp/flofi-p8-*; GitHub workflow conclusions for the final pushed SHA and merged PR are the remote authority.
