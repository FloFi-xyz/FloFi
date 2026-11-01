# BUILD-FLOFI-CI-ARCHITECTURE-001 — autonomous dependency security and faster certification

- Status: implemented on branch `claude/sleepy-noether-9g1cxy`; PR open for owner review (not merged, nothing deployed).
- Owner decision: [DEC-0057](../DECISIONS.md) (supersedes the seven-day release age of ADR-0002 / B001-DEPENDENCY-001).
- Scope: CI, governance and supply-chain tooling only. No file under `apps/` or `packages/` changed; no product
  behaviour, schema, wallet, execution, transaction limit or user workflow changed.

## 1. Baseline

| Item | Value |
| --- | --- |
| Base main SHA | `3769eff273e30181cf4d22f8cf820b84f59ca67c` (merge of PR #150) |
| Open PRs at start | #150 merged 2026-11-01T22:24Z (base includes it); #143, #145–#148 merged; older open PRs (#140, #137, #102, #55, #54, #52) untouched |
| Registry packages | 505 (computed from `pnpm-lock.yaml`; 476 names, 10 workspace importers) |
| Licenses | MIT 359, Apache-2.0 72, ISC 27, MPL-2.0 12, LGPL-3.0-or-later 10, BSD-3-Clause 7, BSD-2-Clause 6, Apache-2.0 AND LGPL-3.0-or-later 3, BlueOak-1.0.0 3, 0BSD 2, Apache-2.0 AND LGPL-3.0-or-later AND MIT 1, CC-BY-4.0 1, Unlicense 1, none declared 1 |
| Registry signatures | 505/505 verify against npm's pinned keys; 238 carry npm provenance attestations; 1 install hook (`fsevents@2.3.3`, darwin-only optional) |
| Toolchain | Node 24.21.0, pnpm 11.22.0, Anvil 1.8.3, headless shell 1243 (unchanged) |

## 2. Original architecture and the friction it caused

- `minimumReleaseAge: 10080` plus an exact waiver list kept in three places (`pnpm-workspace.yaml`,
  `APPROVED_AGE_WAIVERS` in `scripts/governance_lite.py`, `docs/security/COLOSSEUM-DEPENDENCY-AGE-WAIVER.json`), each
  waiver bound to integrity, publication and eligibility times. A security fix younger than seven days needed an owner
  waiver (PR #143's minimatch fix, fast-uri, source-map-js).
- `scripts/bootstrap-ci.py --verify-dependencies` (~700 lines): a hardcoded `REGISTRY_PACKAGE_COUNT = 505`, a SHA-256
  of the whole `packages:`/`snapshots:` lockfile text, per-build dicts of exact direct pins (BUILD-002, 003D, CLOUD-001,
  MCP-001, AUTH-WALLETS-001, PRIVY-UX-001), exact importer-text checks, a regex parse of a table in
  `docs/builds/BUILD-001-PLAN.md`, and per-identity license exceptions in code. Any legitimate dependency change failed
  CI until the count, the graph hash and several inventories were edited by hand.
- The CycloneDX validator was pasted twice (GitHub Actions inline, `.circleci/scripts/ci-sbom.sh`) with a fixed count
  of 505, ten hardcoded workspace manifests and a hardcoded exception set.

**Root cause:** the gate encoded *the expected graph* instead of *the rules a graph must satisfy*, so every legitimate
change looked like drift; and time was used as a proxy for trust.

## 3. Removed release-age controls

- `pnpm-workspace.yaml`: `minimumReleaseAge: 10080` and `minimumReleaseAgeExclude` removed; **`minimumReleaseAge: 0` is
  set explicitly**. Verified in the pnpm 11.22.0 source and behaviour: with the key absent pnpm applies a built-in
  default of `24 * 60` minutes (`pnpm install --frozen-lockfile` then prints "Lockfile passes supply-chain policies"
  and rejects younger versions). Deleting the line would have left a hidden 24-hour gate.
- Removed `APPROVED_AGE_WAIVERS`, `LEGACY_AGE_WAIVERS`, `dependency_age_waivers`, `dependency_release_age_allowed`,
  the waiver schema, and the release-age check and cutoff in the dependency verifier.
- Deleted `docs/security/COLOSSEUM-DEPENDENCY-AGE-WAIVER.json` (in Git history). `DEPENDENCY-AGE-POLICY.md` is kept as
  a marked, retired historical record listing the four former waivers and their advisories.
- Governance now *refuses* a release-age gate: any `minimumReleaseAge` other than exactly `0`, an absent line (hidden
  default), `minimumReleaseAgeExclude`/`Strict`/`IgnoreMissingTime`, or `.npmrc` release-age settings fail
  `governance_lite.py`; the policy's `release_age.minimum_minutes` must be `0`.
- Publication time remains a recorded risk signal (`recently-published`, 72 h) that only widens the bounded content
  scan. Test `test_r_publication_age_never_changes_the_decision` shows 1-minute, 8-day and 900-day releases decide
  identically.

## 4. Automatic dependency risk policy

One policy file, [`docs/security/dependency-policy.json`](../security/dependency-policy.json) (version 1.0.0), one
engine, `scripts/dependency_security.py` (standard library plus Node's crypto for signatures), one developer guide,
[`docs/security/DEPENDENCY-SECURITY.md`](../security/DEPENDENCY-SECURITY.md).

The engine parses `pnpm-lock.yaml` (a strict YAML-subset parser, verified identical to PyYAML on the repository's
lockfile and workspace file), fetches one fresh full registry document per name (no cache), verifies npm registry
signatures, runs `pnpm audit --json` against the policy registry, and evaluates every locked identity.

### PASS / REVIEW_REQUIRED / BLOCK

| Decision | Codes | Can an exception resolve it? |
| --- | --- | --- |
| **BLOCK** | `integrity-mismatch`, `integrity-missing`, `registry-signature-invalid` (incl. a key past expiry), `vulnerability` (≥ low), `license-prohibited` (GPL/AGPL/SSPL/BUSL/Elastic/CC-BY-NC/UNLICENSED), `source-substitution` (tarball/git/file/link sources, non-npm tarball host, `.npmrc`/workspace registry, scoped registries), `metadata-inconsistent` (unpublished release, name/version mismatch, lockfile packages/snapshots/importers inconsistent), `malicious-indicator` (npm `0.0.1-security` placeholder, compromise/malware deprecation notice, download-and-execute install hook), `dependency-confusion` (`@defi-workflow-engine/` or a workspace name on the registry), `policy-bypass` (advisory ignores, lifecycle scripts enabled, build allowances), `non-exact-direct-specifier`, `workspace-constraint` | **No** (`policy_errors` rejects such records) |
| **REVIEW_REQUIRED** | `license-review` (weak copyleft, attribution, custom, unknown SPDX, `WITH` exceptions), `license-missing`, `install-script-introduced` (hook absent in the prior release, or in a first release), `provenance-regression` (prior release had npm provenance; this one has none *and* a different publisher), `typosquat-suspect` (one edit from a protected/direct name *and* not established: < 10 versions and < 365 days), `suspicious-capabilities` (credential access + network/subprocess in a package that also has a registry trigger), `registry-signature-missing`, `alias-substitution` | Yes, one record |
| **PASS** | Everything else. Recorded signals that never decide alone: recent publication, publisher change (21 in today's graph, mostly moves to GitHub Actions trusted publishing), first release (6 benign today), provenance dropped without publisher change, unchanged install hooks, network/environment use | — |

Calibration against the real graph (505 packages): no false REVIEW/BLOCK; the capability scan inspected the 33 packages
with a registry trigger and found no credential-access pattern.

### Exceptions (one canonical record each)

Six existing reviewed exceptions were migrated from code into the policy, preserving their protections:

| id | resolves | binding |
| --- | --- | --- |
| `sharp-libvips-lgpl` (10 packages) | license-review | exact license `LGPL-3.0-or-later`; parents `sharp` / `@img/sharp-<platform>`; optional-only; platform-restricted |
| `sharp-win32-lgpl` (3) | license-review | `Apache-2.0 AND LGPL-3.0-or-later`; parent `sharp`; optional; platform-restricted |
| `sharp-wasm32-lgpl` (1) | license-review | exact expression; parents the two wasm32 sharp packages; optional |
| `caniuse-lite-cc-by` | license-review | `CC-BY-4.0`; parent `next` |
| `lightningcss-mpl` (12) | license-review | `MPL-2.0`; parents `vite` / `lightningcss` |
| `privy-api-base-undeclared` | license-missing | exact `@privy-io/api-base@1.12.0` + sha512 integrity; parents the two Privy SDK packages |

License exceptions are name-scoped and bound to the exact license expression and role (parents, optional, platform):
a routine Next.js or sharp bump with the same license and role passes; a license change, a new dependent, or loss of
optional/platform restriction returns to REVIEW and the CI output names which binding broke. Every other exception is
bound to an exact `name@version` and its sha512 integrity. 0BSD, BlueOak-1.0.0 and Unlicense, previously four
exact-identity exceptions each reviewed as "OSI-approved permissive", are now in the permissive category (with MIT-0,
CC0-1.0 and Zlib) — see §17 owner decisions.

### Evidence

`$RUNNER_TEMP/flofi-dependency-evidence.json` (CircleCI artifact `dependency-security/`, Actions artifact
`flofi-dependency-evidence-<run>`): policy version and SHA-256, CI revision, lockfile SHA-256 and computed counts,
baseline availability, release-age setting, summary (decisions, change classes, licenses, advisories, signatures,
attestations, install hooks, exceptions used/unused) and, per package: identity, source, integrity, change class
(added/upgraded/downgraded/unchanged against the merge base when Git history has it; decisions never depend on it),
license, advisories with paths, registry signature result and key, provenance attestation presence, install hooks,
prior release, dependents, signals, capability scan, findings with remediation, the resolving exception, decision.
URLs are reduced to `<url>` in errors; no environment or credentials are recorded. Exit status: 0 PASS, 2 REVIEW,
3 BLOCK, 1 evidence could not be produced (fail closed).

### Avoiding approval laundering

- Mandatory controls are code-defined BLOCK codes; the policy cannot downgrade them and exceptions cannot name them.
- `governance_lite.py` (Governance job, every push/PR) validates the policy with the same `policy_errors`: registry,
  sha512, release age 0, required signatures with pinned keys, advisory threshold `low`, permissive-only allowed list,
  GPL/AGPL/SSPL/UNLICENSED prohibited, typosquat and scan thresholds, exact exception identities, Owner approval.
- Workspace advisory ignores, build allowances and custom registries fail governance and the engine.
- The evidence records `changed_in_revision` and CI prints a NOTICE when a PR changes the policy, so the owner sees it.
- Self-tests cannot make PR-controlled code tamper-proof: a PR could edit the engine itself. Owner review of the diff
  and owner-managed branch protection remain the backstop (as stated in `docs/SCOPE_GUARD.md`).

## 5. Centralized verification and SBOM consolidation

- `scripts/ci-sbom.sh` is the only SBOM gate; CircleCI, GitHub Actions and Cloud Build (`scripts/gcp-ci-full.sh`)
  call it. `.circleci/scripts/ci-sbom.sh` and the 120-line inline Actions copy were removed.
- `scripts/sbom_verify.py` derives everything: components must equal the lockfile's registry identities (no missing,
  duplicate or unknown component), each `bom-ref`/`purl` matches its identity, each distribution reference is on
  registry.npmjs.org with a SHA-512 equal to the lockfile integrity, licenses come from the dependency evidence, the
  root component equals `package.json`, workspace importers equal the manifests found through `pnpm-workspace.yaml`
  globs, and the graph is checked against what pnpm 11.22.0 actually writes (verified on the real SBOM: it emits a
  spanning set of edges, each component's edges once): every edge must be a lockfile edge, root edges must equal the
  importers' direct registry dependencies, every component must be reachable. The SBOM is removed on success or
  failure.
- It accepts only dependency evidence that is a PASS for this revision, this lockfile and this policy, covering
  exactly the locked packages.

## 6. CI cache and artifact decisions

| Option | Decision | Evidence / reason |
| --- | --- | --- |
| Tool-archive cache key | **Changed.** CircleCI: `v2-{{ arch }}` + checksums of the three bootstrap scripts and `ci_archive_cache.py`, with a `v2-{{ arch }}-` prefix fallback. Actions: dropped `pnpm-lock.yaml`, `.npmrc`, `pnpm-workspace.yaml` from the key. | Previously keyed only on `bootstrap-ci.py`, which changed with every dependency edit (it held the inventories), so caches were invalidated by unrelated changes. Every archive is SHA-256/SHA-512 verified before parsing (`verified_archive`); a stale or poisoned restore can only cost a download. |
| pnpm store cache | Not adopted | Frozen install measured 12–23 s per job (base run 12.3/12.8/15.2 s). Restoring a multi-hundred-MB store costs about the same; pnpm still verifies store content. No measurable gain. |
| Next.js build cache (`.next/cache`) | Not adopted | CircleCI caches are shared across branches; a PR could seed compiled modules that a later main build would reuse — a trust escalation into the build that browser certification tests. |
| Shared production build artifact | Not adopted | Builds run in parallel inside each job (119–152 s). A build job before the browser jobs would add its spin-up, install, build and workspace transfer (≥ 160 s) to the critical path. Each job builds the same revision itself. |
| Build in `certification-checks` | Added | Needed for browser shard 3; +~130 s on the shortest job, off the critical path. |
| Starting certification jobs before governance | Not adopted | Would save ~50 s but would spend ~65 large-runner minutes on every governance failure. |
| More Playwright workers / more runners | Not adopted | `workers: 1` stays; no new runner. |

## 7. Playwright distribution

The extended profiles moved from two shards to three, balanced on the mean per-profile seconds of three successful
CircleCI certifications (main b8126a6, PR #150 final head, main 3769eff), by greedy assignment plus pairwise
improvement:

| Job | Fixed work (mean) | Extended shard (mean) | Projected job |
| --- | ---: | ---: | ---: |
| certification-browser-1 | 492 s (setup, build, critical 296 s) | shard 1: 16 profiles, 860 s | ~1352 s |
| certification-browser-2 | 201 s (setup, build, composition) | shard 2: 16 profiles, 1152 s (execution-continuity ~555 s) | ~1352 s |
| certification-checks | 1016 s (checks, unit, PostgreSQL, fork, + build) | shard 3: 11 profiles, 337 s | ~1352 s |

Critical regressions still run first in browser job 1 and right after the build in Actions; each shard runs shortest
first. Every profile still runs exactly once per provider (`BrowserPlan`, `CiParity` tests; the runner refuses a plan
that drops or repeats a profile). Shard 3's PostgreSQL-backed profiles share the checks container's server with the
`.pg.test.ts` suites; both create uniquely named throwaway databases (`flofi_test_<random>`,
`flofi_e2e_<time>_<pid>`) and drop them, and only transaction-scoped advisory locks are used.

## 8. Ledger integrity

`scripts/ci-observe.py` records the revision (`FLOFI_CI_REVISION` / `CIRCLE_SHA1` / `GITHUB_SHA` / `git rev-parse HEAD`)
in every stage record and `scripts/guarded-release-browser.mjs` in every browser report; `verify` rejects records of
another revision and fails when the revision is unknown. The dependency stage is `Dependency security policy` in
`REQUIRED_STAGES`.

## 9. Before / after performance

See §16 for the measured after values.

## 10. Security regression results (Tests A–R)

`scripts/test_ci_dependency_security.py` (27 tests, synthetic registry and a disposable P-256 key; no network) plus
additions to `test_ci_optimization.py`, `test_governance_lite.py`, `test_ci_gcp_orchestration.py`:

| Test | Where | Result |
| --- | --- | --- |
| A recent safe dependency | `test_a_recent_safe_dependency_passes_without_waiver_or_approval` | PASS, no policy edit |
| B graph expansion | `test_b_graph_expansion_updates_the_computed_inventory` (+ SBOM) | 4 → 8 computed, PASS |
| C security patch | `test_c_recent_security_patch_passes_while_the_vulnerable_release_blocks` | vulnerable BLOCK, 1-hour-old fix PASS |
| D transitive update | `test_d_ordinary_transitive_update_needs_no_inventory_edit` | PASS, change classes recorded |
| E repeated package | `test_e_unchanged_and_excepted_packages_need_no_repeated_approval` | PASS twice; excepted package upgrade PASS |
| F integrity | `test_f_integrity_mismatch_and_altered_content_block` | BLOCK (mismatch, invalid signature, sha1) |
| G vulnerability | `test_g_disallowed_vulnerabilities_block_and_cannot_be_excepted` | BLOCK low→critical; exception rejected |
| H license | `test_h_license_policy`, `test_h_license_exception_is_bound_to_license_role_and_parents` | GPL/AGPL/UNLICENSED BLOCK; OR/AND semantics; bindings enforced |
| I supply chain | `test_i_suspicious_supply_chain_behavior`, `test_i_typosquat_and_dependency_confusion`, `test_i_capability_scan_flags_credential_exfiltration_shapes` | REVIEW/BLOCK as specified; signals alone PASS |
| J source substitution | `test_j_unauthorized_source_substitution_blocks` | BLOCK for 10 substitution shapes; 404 → BLOCK |
| K policy bypass | `test_k_policy_bypass_fails`; governance `test_dependency_policy_cannot_weaken_itself`, `test_shared_sbom_gate_cannot_be_disabled`, `test_workspace_advisory_ignores_and_build_allowances_fail` | BLOCK / governance failure |
| L invalid evidence | `test_l_invalid_evidence_never_certifies`, `test_l_sbom_refuses_missing_foreign_or_non_pass_evidence` | evidence error / SBOM refusal |
| M SBOM parity | `test_m_one_canonical_sbom_validator_in_every_ci_provider`, `SbomGate` | one validator; corruptions fail |
| N missing stages | `CertificationLedger.test_missing_failed_or_incomplete_stage_fails` | FAIL |
| O browser profiles | `test_missing_repeated_failed_or_unplanned_profiles_fail`, `test_a_plan_that_drops_or_repeats_a_profile_refuses_to_run` | FAIL |
| P cache poisoning | `ArchiveCache.*`, `test_p_caches_hold_only_digest_verified_raw_archives` | poisoned/FIFO/symlink entries rejected; caches hold raw archives only |
| Q artifact isolation | `test_q_records_of_another_revision_never_certify_this_one`, `test_q_browser_report_of_another_revision_is_rejected` | FAIL |
| R no release age | `NoReleaseAgeGate.*`, `test_no_release_age_gate_or_waiver_mechanism`, `test_r_publication_age_never_changes_the_decision` | refused in every form |

Also verified against the live npm registry (disposable worktrees, nothing pushed):

- Real graph at the base: 505/505 PASS, 505/505 signatures verified, all six migrated exceptions used, 21 s.
- Adding `ox@1.8.12` (published 2026-10-27T02:06Z, under 7 days old): old main's frozen config fails with
  `ERR_PNPM_NO_MATURE_MATCHING_VERSION`; this branch resolves it, 9 resolved packages change, the computed inventory is
  514, all PASS, SBOM gate PASS — no governance file edited.
- Same worktree with one character of `ox@1.8.12`'s lockfile integrity altered: BLOCK `integrity-mismatch` +
  `registry-signature-invalid` (exit 3). `.npmrc` pointed at a mirror: BLOCK `source-substitution` (exit 3). The SBOM
  gate then refuses the non-PASS evidence.
- A recorded real npm signature (`minimatch@11.0.3`, current key; `wrappy@1.0.2`, expired legacy key) verifies against
  the pinned keys; the same signature over a different version does not.

## 11. Known limitations

- Registry signatures and integrity prove an archive is what npm published, not that its code is benign.
- npm provenance attestations are recorded present/absent; the Sigstore bundle is not verified (no verifier in the
  standard library).
- The capability scan is bounded (JavaScript only, 4 MiB/file, 32 MiB/package, only packages with a registry trigger)
  and describes risk; it proves nothing about safety. Non-installed platform packages are not scanned.
- `pnpm audit` reflects advisories known at run time; a later advisory fails the next run of any branch.
- Typosquat detection is distance-1 against direct dependencies and a short protected list.
- Change classification needs the merge base in Git history (CircleCI usually; Actions' depth-1 checkout does not); it
  is reporting only and never changes a decision.
- The policy can be changed by a PR like any file; governance refuses weakening shapes, owner review covers the rest.
- Shard balance is based on three runs; profile times drift (the base run was ~10% slower than the others).

## 12. Maintenance

- Adding/updating a dependency: commit `package.json` + `pnpm-lock.yaml`. Nothing else.
- A REVIEW finding: follow the printed `resolve:` line; if acceptable, add one exception record (see the guide).
- npm key rotation: add the new public key from `https://registry.npmjs.org/-/npm/v1/keys` to the policy.
- Exceptions listed as unused in the CI log can be removed.
- Shards: when a profile's time changes materially, re-balance `shards` in `scripts/guarded-release-browser.mjs` from
  the "Browser profile timings" table each job prints.

## 13. Specialist review

See §17.

## 14–16. CI evidence and measured results

Filled in from the PR's CI runs below.

## 17. Review, owner decisions

Filled in below.
