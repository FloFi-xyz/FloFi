# Dependency security

Owner decisions DEC-0057 (BUILD-FLOFI-CI-ARCHITECTURE-001, 2026-11-01) and DEC-0058 (exposure-based advisories,
BUILD-FLOFI-CI-ARCHITECTURE-002, 2026-11-17). Policy data: [`dependency-policy.json`](dependency-policy.json). Engine:
`scripts/dependency_security.py`.

## The normal workflow

1. Add or update a dependency with an exact version (`save-exact`) and commit `package.json` and `pnpm-lock.yaml`.
2. CI runs `python3 scripts/dependency_security.py verify`. For every locked registry package it decides **PASS**,
   **CONTAINED**, **REVIEW_REQUIRED** or **BLOCK** and writes machine-readable evidence.
3. If everything is PASS or CONTAINED, CI continues (exit 0). Nothing else to edit: no count, hash, allowlist, waiver or
   approval. CONTAINED needs nothing from anyone while each run keeps re-proving it ([below](#contained-advisories-dec-0058)).

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
| Advisories (`pnpm audit`, severity ≥ low) with affected paths, whole graph | `pnpm audit --json` | BLOCK (never excepted); a development/CI-only one with no compatible fix: CONTAINED by one record, see [below](#contained-advisories-dec-0058) |
| Advisories in the production graph | `pnpm audit --prod --audit-level low` (separate CI step) | fails the step; nothing can contain it |
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

## Contained advisories (DEC-0058)

An advisory is never excepted. It is **CONTAINED** (certification continues, and the evidence, the CI log and the SBOM
summary name it) only when one record in `contained_advisories` covers it and every condition below holds **on this
run**. Nothing is remembered between runs, so there is no expiry and nothing to renew while the evidence stays the
same:

| Condition, re-proved on every run | From | When it no longer holds |
| --- | --- | --- |
| The record names this GHSA, this exact `name@version` and the lockfile's sha512 `integrity` | policy + lockfile | BLOCK (another advisory or archive is a new risk) |
| Development/CI only: not reachable from any importer's `dependencies` or `optionalDependencies` (every importer counts, deployed or not) | lockfile graph | BLOCK, with the production path |
| Not imported by production code: the import graph walked from the production entry points (backend `main.ts` and `admin-cli.ts`, every module under the Next.js app directory, proxy/middleware, instrumentation, `next.config.ts`, workspace packages through `src/index.ts`; static, re-export, dynamic `import()` and `require()`, type-only imports excluded) imports no package whose locked dependencies include the release. The backend image installs devDependencies, so this, not the lockfile tier alone, proves it is never loaded there | repository source + lockfile | BLOCK, naming the importing file |
| Not critical | advisory feed | BLOCK |
| No new dependent beyond the assessed `dependents` (fewer is fine) | lockfile graph | BLOCK |
| No compatible official fix: no newer, stable, non-deprecated release inside the patched range and outside the vulnerable range that a dependent's published range (or, for a direct dependency, `^` of its own pin) accepts; and, one level up, no newer release of a dependent, within what its own dependents accept, that accepts such a fix or no longer depends on the package. A dist-tag range accepts only the release the tag points to | registry + advisory ranges | BLOCK: take the update; a fix in another major line that no dependent or dependent update accepts does not count |
| The assessment document exists | repository | BLOCK |
| Absent from the production build: no function trace, server source map or `.next/node_modules` link reaches the release; a server bundle without a source map, or a workspace package built with anything but `tsc` (a bundler could inline it unseen), fails closed | `scripts/function_traces.py`, after every `pnpm build` | the build step fails |

A new development/CI-only advisory BLOCKs and the CI log prints the exact record to add. The only human step is to
assess who supplies the vulnerable input, write the short assessment under `docs/` and commit the record. Production
or critical advisories print no record because they cannot be contained. A record whose release left the graph (after
an upgrade) is inert and listed as "not in use"; remove it when convenient.

```json
{"advisory": "GHSA-....-....-....", "identity": "name@1.2.3", "integrity": "sha512-...",
 "dependents": ["the", "assessed", "dependents"], "exposure": "who supplies the vulnerable input, and why it stays contained",
 "record": "docs/security/ADVISORY-GHSA-....-....-.....md"}
```

Fields are exactly these (no ranges, names-only form, expiry or approval date; `policy_errors` refuses anything else).
Records today: [GHSA-fc5q-39xc-vjpf](ADVISORY-GHSA-fc5q-39xc-vjpf.md) on `picomatch@4.0.7`.

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
resolved a finding, each package's exposure (`production` or `development`), contained advisories with their record, and
the decision. `scripts/sbom_verify.py` accepts only a PASS or CONTAINED evidence file for the same revision, lockfile and
policy.

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
- Containment proves where a release is installed and shipped, not how its callers use it: the record's exposure
  statement is a person's assessment, re-read only when a condition above changes. The production import walk follows
  literal specifiers only (an `import()` of a computed name is invisible to it); browser chunks carry no source map, so
  the build check covers them through the import walk and their server-rendered copies. Next.js and Playwright vendor their own copies of some libraries (picomatch among them),
  which no lockfile audit sees.
