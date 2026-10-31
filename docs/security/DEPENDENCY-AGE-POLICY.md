# Dependency release-age policy

Owner decision, 2026-10-31 (PR #143): the seven-day minimum release age must not, on its own, block a reviewed security fix or a
reviewed dependency of an owner-requested product capability. It stays a supply-chain control for everything else.

## What does not change

- `minimumReleaseAge: 10080` (seven days) in `pnpm-workspace.yaml`, enforced by pnpm at install time (also on frozen installs) and by
  `scripts/bootstrap-ci.py --verify-dependencies` in CircleCI. It is never lowered, disabled or replaced by a range or glob.
- `pnpm audit`, `strictPeerDependencies`, `autoInstallPeers: false`, `ignore-scripts`, the frozen lockfile, the registry count and
  baseline hash, the licence allowlist with exact identity exceptions, registry integrity checks and SBOM generation.
- A waiver removes only the age condition for one exact `name@version`. Every other check still applies to it.

## When an exception is allowed

| Category | Allowed for | Required evidence |
| --- | --- | --- |
| `security-fix` | The exact version that fixes an advisory reported by the Dependency audit, or a new runtime dependency of that fix (`required_by`) | GHSA identifiers; the fix is the upstream maintainer's release |
| `reviewed-dependency` | A dependency an owner-requested capability needs, after the review below | The review document (`review`) |

Not allowed: convenience upgrades, ranges, globs, `latest`, a package nobody reviewed, a version the lockfile does not resolve, or a
waiver used to hide an advisory, an unsupported licence or a broken integration.

## Review before adding one

1. Resolve the exact tree (`pnpm install`) and the lockfile diff; nothing else may change.
2. Publisher: the registry's `_npmUser` is the package's established maintainer, and the tarball carries the npm registry signature.
3. Tarball: `npm pack` it into an empty directory and read it. Check for install scripts, network, filesystem, `child_process`,
   `eval`/`new Function` and environment reads. The SHA-512 must equal the lockfile `integrity`.
4. Licence: the allowlist or an exact identity exception with its reason (`scripts/bootstrap-ci.py`).
5. Advisories: `pnpm audit` must stay clean.

## How an exception is recorded (three places, same order, exact identity)

1. `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Quote a scoped identity: `- '@scope/name@1.2.3'`.
2. `APPROVED_AGE_WAIVERS` in `scripts/governance_lite.py`.
3. `docs/security/COLOSSEUM-DEPENDENCY-AGE-WAIVER.json`, identical to (2).

Fields: `package`, `version`, `category`, `reason`, `approved_by: "Owner"`, `temporary: true`, `approved_at`, `approval` (the owner
decision it rests on), `published_at` (registry time), `eligible_at` (exactly `published_at` + 7 days), `integrity` (the reviewed
tarball), `review` (this file or a build record), `removal_condition`, plus `advisories` (required for `security-fix`) and `required_by`.
The two legacy entries (`source-map-js@1.2.2`, `fast-uri@3.1.9`) predate these fields and stay exactly as approved.

What the gates check:

- `python3 scripts/governance_lite.py` checks the three places agree, the schema, `eligible_at`, and that the review document exists.
- `--verify-dependencies` checks each waived identity is in the lockfile with exactly the recorded `integrity`. It also checks the
  registry reports exactly the recorded `published_at`.
- A waiver that has passed `eligible_at` is listed in the CI log as removable. It is then removed in a later change, never silently.

The owner reviews every waiver in the pull request that adds it. Agents may prepare one under this policy and must say so in the PR.
They never merge it.

## Current exceptions added under this policy

### minimatch@11.0.3 and @isaacs/nonrecursive-glob-match@1.0.3 (`security-fix`, GHSA-g3hv-75wg-m249)

- **Why:**
  - `minimatch < 11.0.1` lets a crafted glob amplify brace expansion.
  - `pnpm audit` fails on `main` because of it, through ESLint's three consumers (`eslint@10.10.0`, `@eslint/config-array@0.23.5`,
    `@typescript-eslint/typescript-estree@8.70.0`).
  - Exact overrides move them to `minimatch@11.0.3`, which adds the author's `@isaacs/nonrecursive-glob-match@1.0.3`.
- **Publisher and signature:**
  - Both are published by `isaacs`, minimatch's long-standing maintainer.
  - Both carry the npm registry signature (key `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`).
  - Repository: `github.com/isaacs/minimatch`.
- **Tarballs:**
  - The SHA-512 of each equals the lockfile and registry `integrity`.
  - No install scripts.
  - Neither package uses network, filesystem, `child_process`, `eval` or `new Function`. The only environment read is minimatch's
    `__MINIMATCH_TESTING_PLATFORM__` test switch.
- **Licence:** BlueOak-1.0.0 (OSI-approved). Exact identity exception in `scripts/bootstrap-ci.py`.
- **Behaviour:** ESLint lints the same 1,834 files with 0 problems on both versions; `pnpm audit` reports no vulnerabilities.
- **Published:**
  - `minimatch@11.0.3`: 2026-10-28T20:00:34.713Z, eligible 2026-11-04T20:00:34.713Z.
  - `@isaacs/nonrecursive-glob-match@1.0.3`: 2026-10-28T19:50:48.349Z, eligible 2026-11-04T19:50:48.349Z.
- **Version-exact:** pnpm 11.22.0 rejects the lockfile when either identity in `minimumReleaseAgeExclude` is changed to another version.
