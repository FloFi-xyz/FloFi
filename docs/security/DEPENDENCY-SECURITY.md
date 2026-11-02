# Dependency security

Owner decision DEC-0057 (BUILD-FLOFI-CI-ARCHITECTURE-001, 2026-11-01). Policy data:
[`dependency-policy.json`](dependency-policy.json). Engine: `scripts/dependency_security.py`.

## The normal workflow

1. Add or update a dependency with an exact version (`save-exact`) and commit `package.json` and `pnpm-lock.yaml`.
2. CI runs `python3 scripts/dependency_security.py verify`. For every locked registry package it decides **PASS**,
   **REVIEW_REQUIRED** or **BLOCK** and writes machine-readable evidence.
3. If everything is PASS, CI continues. Nothing else to edit: no count, hash, allowlist, waiver or approval.

There is **no release-age restriction**. A legitimate package published five minutes ago is evaluated like any other.
`pnpm-workspace.yaml` sets `minimumReleaseAge: 0` explicitly because pnpm 11 otherwise applies a hidden 1440-minute
default. Publication time is only a risk signal that widens what the engine inspects.

PR merge approval is unchanged: the owner reviews and merges every PR.

## What is checked

| Control | Source of truth | Outcome on failure |
| --- | --- | --- |
| Frozen lockfile, lifecycle scripts disabled | `pnpm install --frozen-lockfile --ignore-scripts`; `ignoreScripts: true` in `pnpm-workspace.yaml` (pnpm 11 no longer reads `.npmrc` for it) | install fails / BLOCK |
| One lockfile, unweakened settings: no `audit`/`auditConfig`/`auditLevel`, `gitBranchLockfile`, `lockfileDir`, `useLockfile`/`lockfile: false`, `sharedWorkspaceLockfile: false`, `optional: false`, build allowances, extra `pnpm-lock*.yaml` | `pnpm-workspace.yaml` (parsed strictly: YAML tags, anchors, aliases, merge keys, directives and BOMs are refused) | BLOCK |
| Every lockfile edge is requested by the parent's published manifest (dependencies, optional or peer dependencies, after workspace `overrides`, `packageExtensions`, `peerDependencyRules`); direct versions equal their exact specifiers | lockfile + registry manifests (npm semver ranges) | BLOCK |
| Registry source (no tarball, git, file or custom registry; no scoped registries) | lockfile, `.npmrc`, workspace, registry `dist.tarball` | BLOCK |
| Lockfile integrity equals the registry's `dist.integrity` (sha512) | lockfile + live registry document | BLOCK |
| npm registry ECDSA signature over `name@version:integrity` by a pinned npm key | policy `registry_signatures.keys` | invalid: BLOCK; missing: REVIEW |
| Advisories (`pnpm audit`, severity ≥ low) with affected paths | `pnpm audit --json` | BLOCK (never excepted) |
| License (SPDX expression) | registry `license`; when none is declared, the installed archive's single standard LICENSE text (Apache-2.0, MIT, ISC) | prohibited (also non-SPDX "GPL", "GPLv3"...): BLOCK; weak copyleft, attribution, custom or unreadable: REVIEW |
| Exact direct versions, workspace-only links | importers, manifests | BLOCK |
| Internal scope on the public registry (dependency confusion) | `@defi-workflow-engine/` | BLOCK |
| npm security placeholder, compromise notice, download-and-execute install hook | registry document | BLOCK |
| Install hook introduced (absent in the prior release or in a first release) | registry history | REVIEW |
| Provenance regression: prior release had npm provenance, this one has none and a different publisher | registry history | REVIEW |
| Typosquat: one edit from a protected/direct name and not an established package | policy + registry history | REVIEW |
| Credential access combined with network/subprocess in a package with a registry trigger | bounded scan of the installed files | REVIEW |

Signals that are recorded but never decide on their own: recent publication, publisher change, first release, provenance
dropped, unchanged install hooks, network/environment capabilities. No decision depends on the current time: the
typosquat "established" test uses the package's own history (at least 10 versions *and* 365 days between its first
publication and the locked release), and "recently published" only widens the capability scan.

Measured on the real graph's registry histories (47,076 releases in the year to 2026-11-01): the provenance-regression
pattern (provenance dropped *and* a different publisher) occurred 25 times in 18 packages, mostly prereleases FloFi does
not lock; stable Next.js and Vite releases never triggered it.

## REVIEW_REQUIRED

CI prints the finding, the evidence and how to resolve it. If the concern is acceptable, add **one** record to
`exceptions` in `dependency-policy.json`:

- License review (`license-review`): name-scoped (`packages`) with the exact `license` expression and, where the role
  matters, `parents`, `optional` and `platform_restricted`. Later versions with the same license and role pass without a
  new approval; a license or role change returns to review.
- Anything else (`license-missing`, `install-script-introduced`, `alias-substitution`, ...): exact `identity`
  (`name@version`) plus its sha512 `integrity`, so the record covers only the reviewed archive.
- Required: `id`, `resolves`, `reason`, `approved_by: "Owner"`, `approved_at`, `record` (the review document).

BLOCK findings cannot be excepted (`policy_errors` rejects such records). Fix the cause instead.

## Changing the policy

Policy changes are ordinary PR changes reviewed by the owner. `scripts/governance_lite.py` (Governance job) refuses a
policy that reintroduces a release age, accepts copyleft as permissive, lowers the advisory threshold, makes registry
signatures optional, changes the registry, disables typosquat detection or excepts a mandatory control. When npm
rotates its registry key, add the new public key from `https://registry.npmjs.org/-/npm/v1/keys` to
`registry_signatures.keys`.

## Evidence

`$RUNNER_TEMP/flofi-dependency-evidence.json` (CircleCI keeps it as the `dependency-security/` artifact when the gate
passes; when it fails, the CI log lists every finding with its remedy. GitHub Actions uploads it in both cases as
`flofi-dependency-evidence-*` or with the failure artifacts): policy version and SHA-256, CI revision, lockfile SHA-256 and computed package count,
then per package: identity, source, integrity, change class against the merge base when git history has it, license,
advisories, registry signature and provenance attestation, install hooks, risk signals, findings, the exception that
resolved a finding, and the decision. `scripts/sbom_verify.py` accepts only a PASS evidence file for the same revision,
lockfile and policy.

## Assurance level, honestly

- Integrity and registry signatures prove the archive is what npm published under that name and version, not that its
  code is benign.
- npm provenance attestations are recorded as present or absent; CI does not verify the Sigstore bundle.
- The capability scan reads only packages with a registry trigger and only JavaScript files within fixed size bounds
  (oversize files are listed, never treated as clean). It describes risk; it does not prove safety.
- Lockfile edges are checked against the registry manifests' declared ranges; a `.pnpmfile.cjs` `readPackage` hook that
  rewrites manifests would surface as edges the published manifests do not request.
- A policy change is flagged in the CI log only where Git history provides the merge base (CircleCI); the PR diff is
  the authoritative signal everywhere.
- `pnpm audit` reflects advisories known to the registry at run time; a later advisory fails the next run.
