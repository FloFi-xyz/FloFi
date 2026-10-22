# BUILD-CHAT-E2E-001 dependency security correction

The owner authorized this separate correction on 22 October 2026 after CircleCI
pipeline 62 rejected the inherited dependency graph. The baseline is remote
`main` at `7a844d24252d5f3c53a2e9b3dda0b226bd02ecdb`. The branch is
`codex/build-chat-e2e-001-deps`; its Draft PR targets `main`.

## Fixed advisories

Next.js 16.4.1 fixes the three advisories against 16.3.8:

- [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw): critical image optimization RCE.
- [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr): critical cached typed-array RCE.
- [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r): high Server Actions denial of service.

Vitest 5.0.3 requires @vitest/mocker 5.0.3, which fixes:

- [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8): moderate manual mock code injection.
- [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp): moderate Windows mock redirect traversal.

The GitHub Reviewed advisories identify these patched versions. Fresh full npm
metadata verifies the version identities, SRI, licenses and publication times.

## Reviewed dependency graph

| Package | Version change | Published UTC |
|---|---|---|
| `@next/env` | `16.3.8` → `16.4.1` | 2026-10-14T17:29:56.519Z |
| `@next/swc-darwin-arm64` | `16.3.8` → `16.4.1` | 2026-10-14T17:28:49.343Z |
| `@next/swc-darwin-x64` | `16.3.8` → `16.4.1` | 2026-10-14T17:28:11.640Z |
| `@next/swc-linux-arm64-gnu` | `16.3.8` → `16.4.1` | 2026-10-14T17:35:55.845Z |
| `@next/swc-linux-arm64-musl` | `16.3.8` → `16.4.1` | 2026-10-14T17:30:50.610Z |
| `@next/swc-linux-x64-gnu` | `16.3.8` → `16.4.1` | 2026-10-14T17:29:05.782Z |
| `@next/swc-linux-x64-musl` | `16.3.8` → `16.4.1` | 2026-10-14T17:29:20.557Z |
| `@next/swc-win32-arm64-msvc` | `16.3.8` → `16.4.1` | 2026-10-14T17:33:35.290Z |
| `@next/swc-win32-x64-msvc` | `16.3.8` → `16.4.1` | 2026-10-14T17:29:09.511Z |
| `@vitest/mocker` | `5.0.0` → `5.0.3` | 2026-09-30T11:29:00.625Z |
| `@vitest/spy` | `5.0.0` → `5.0.3` | 2026-09-30T11:30:17.823Z |
| `next` | `16.3.8` → `16.4.1` | 2026-10-14T17:43:55.246Z |
| `vitest` | `5.0.0` → `5.0.3` | 2026-09-30T11:30:42.429Z |
| `why-is-node-running` | `2.3.0` → `3.2.1` | 2024-10-29T17:08:48.344Z |

All 14 replacement identities are MIT. The Next.js and matching `@next/*`
versions are exact. The existing Next.js → sharp 0.35.5 override follows the new
Next.js identity; sharp, its platform packages, libvips, license obligations and
all 16 previously reviewed license exceptions stay fixed.

Vitest requires `why-is-node-running@3.2.1` exactly; this removes `siginfo@2.0.0`
and `stackback@0.0.2`. Its Node engine `>=20.11` accepts the existing Node 24.21.0.
Vitest's existing Node and Vite peer ranges accept the unchanged Node, Vite 8.3.3
and @types/node 24.13.4 pins. Next.js accepts the unchanged React/React DOM 19.3.0,
Playwright 1.63.0 and Node pins. Strict peer resolution succeeds.

The graph contains **263** registry identities, down from 265. The other **249**
package records, versions and integrities are byte-identical to the baseline.
There are no new package names. The reviewed `packages` / `snapshots` graph
SHA-256 is `7ee7f5d8ecc21d5c3e3544a41292c8525fbd1fa90a92284729e95969807e3d6d`.
The gate continues to reject any different graph. Its exact Next.js route and
inventory compatibility assertions now describe this reviewed graph.

[Machine-readable review](BUILD-CHAT-E2E-001-DEPENDENCY-SECURITY.json) records each
changed SRI, engine, peer range and platform, the complete license totals, removed
identities, audit result and full registry review digest. The BUILD-001 direct
Vitest SRI and publication record are updated because CI reads that table.

## Validation and policy

Preparation used a lockfile-only, lifecycle-disabled pnpm resolution, without
installing packages. The unchanged dependency verification gate checked fresh
registry metadata for all 263 identities across 257 package names. All SRI,
license, route, platform, optional-status, direct-pin and age checks passed.
Every replacement exceeds the seven-day minimum release age. The existing exact
source-map-js age waiver is unchanged; no new waiver or exception is introduced.

A lockfile advisory query returned zero vulnerabilities at every severity.
The two focused Python dependency-policy tests passed in 0.100 seconds, including
rejection of invalid integrity, license, age, platform and missing identities.
These are preparation checks. CircleCI must independently pass governance,
fresh dependency verification, audit, SBOM, typecheck, lint, schema checks,
unit/contract, disposable PostgreSQL, fork, both browser jobs and the final ledger
on the exact commit. No local application build, browser, fork or PostgreSQL
certification was run.

## Release order and migration identity

The review order is dependency correction → Release A → Release B. After this
correction passes CircleCI, Release A is rebuilt on this branch and PR #113 targets
this corrected baseline so its functional diff remains certificate-only. Release B
is rebuilt only after Release A passes and targets the Release A branch.

Original endpoints remain traceable:

- Release A: `8fee11cef4897cd725846acadc9d4c3e58ece225`.
- Release B: `11d6079d18531d562958f1fc864e557b606a45bf`.

This correction changes no migration or application behavior beyond dependency
patches. Release A's 0015 certificate fixture and Release B's shipped migration
must retain identity `15 / workflow_runs` and SHA-256
`5dfefcf7465d874da5880ae5a082f7f47e28ede51adfdef46dbbe3e3f7ba945f`.

Publishing requires a verified Vercel Preview exclusion for the exact dependency
branch and the existing exclusions for both releases. GitHub Actions must remain
disabled. Production promotion, database migration, Railway changes, production
environment changes, workflow enablement and merging remain unauthorized. The
Admin health compatibility correction remains separate from all three changes.
