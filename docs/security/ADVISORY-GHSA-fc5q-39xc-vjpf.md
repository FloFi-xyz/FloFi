# GHSA-fc5q-39xc-vjpf (picomatch ReDoS): exposure assessment and containment

Status: **CONTAINED (development/CI only) under DEC-0058**, record in
[`dependency-policy.json`](dependency-policy.json) `contained_advisories`. Assessed 2026-11-17 on `main` 944fe57 and
BUILD-FLOFI-CI-ARCHITECTURE-002 (same `pnpm-lock.yaml`). Every certification re-proves the containment (section 4);
when picomatch publishes a fix that tinyglobby, vite, vitest or fdir accept, certification BLOCKs until the update.

## 1. The advisory

| Field | Value |
| --- | --- |
| Identifiers | GHSA-fc5q-39xc-vjpf, CVE-2026-112366, npm advisory 1247710 |
| Package / range | `picomatch` `<=4.0.7` (every published version); npm lists `>=4.0.8` as patched, but no 4.0.8 exists (`latest` = 4.0.7, 2026-08-24) |
| Weakness | CWE-1333 ReDoS: `analyzeRepeatedExtglob` (`lib/parse.js`) lets single-branch repeated extglobs (`+(*)`, `+(*a)`, `*(*a)`, `+(a*)`) through, and the compiled regex backtracks exponentially |
| Severity | high, CVSS 4.0 8.7 (`AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H`): availability only |
| Upstream | fix proposal micromatch/picomatch#194 is open (since 2026-08-13); `master` has had no commits since 2026-08-27 and has no fix and no version bump |
| Timeline | published 2026-10-19, GitHub-reviewed 2026-11-17. `main`'s certification at 16:30 UTC on 2026-11-17 still passed the policy and `pnpm audit` with this lockfile; npm's audit feed reported the advisory later that day, so every new pipeline, `main` included, now stops at the dependency policy |

**Precondition: the attacker must supply the glob pattern.** Measured with the installed 4.0.7 (Node 22, one core): the
pattern `+(*)` against 26 characters takes more than 10 s, `+(*a)` 2.9 s; the repository's ordinary globs (`**/*.ts`,
`src/**/*.{ts,tsx}`) stay under 0.1 ms on the same input. A fixed, benign pattern cannot be turned into a slow one
by the string it is matched against.

## 2. Where picomatch is, and who supplies its patterns

### 2.1 The npm package (what `pnpm audit` sees)

All 26 lockfile paths end at three root **devDependencies**. No workspace package or app depends on them at run time.

| Root devDependency | Path to `picomatch@4.0.7` | Pattern source |
| --- | --- | --- |
| `typescript-eslint` 8.70.0 | `@typescript-eslint/typescript-estree` → `tinyglobby` 0.2.17 → (`fdir` 6.5.0 →) `picomatch` | parser `project` globs only; `eslint.config.mjs` uses the non-typed `recommended` rules and sets no `project`, so this path compiles no pattern |
| `vitest` 5.0.3 (+ `@vitest/mocker`) | direct, and via `tinyglobby` / `vite` | `include`/`exclude` and CLI filters in `package.json` scripts (`**/*.fork.test.ts`...) |
| `vite` 8.3.3 (vitest's required peer) | direct, and via `tinyglobby` | vitest's internal transforms; no `import.meta.glob` in the repository, no Vite dev server anywhere |

- `pnpm audit --prod --audit-level low`: **No known vulnerabilities found**. `pnpm audit --dev`: this one advisory.
- None of these packages' files appears in the 99 function traces (`.next/**/*.nft.json`) or in the build artifact
  (`packages/*/dist`, `apps/*/.next`).
- No committed configuration uses extglob syntax (`+(`, `*(`, `@(`, `!(`, `?(`).
- Who could plant a crafted pattern: only someone who can change repository files. A pull request author already
  controls code that CI executes (the tests themselves), on disposable runners. The advisory gives them nothing new;
  the worst case is a timeout of their own job.

### 2.2 Copies the lockfile audit cannot see

| Copy | Version | Where it runs | Reachable with a crafted pattern? |
| --- | --- | --- | --- |
| `next/dist/compiled/picomatch` (Next.js 16.4.6, minified, no version field) | older than 4.0.4 (no `analyzeRepeatedExtglob` at all); same behaviour as 4.0.7 on the PoC patterns, measured | **production**: listed in `next-server.js.nft.json`; used by the image optimizer (`match-remote-pattern`, `match-local-pattern`) and at build time (middleware matchers, file tracing) | **No.** Patterns come only from `next.config.ts` at build time. FloFi sets `images.unoptimized: true`, `domains: []`, `remotePatterns: []`; the runtime config's only local pattern is Next's default `**`. A request supplies the URL, never the pattern |
| `playwright` 1.63.0 `lib/matchers/expect.js` (bundled) | older picomatch, inlined | browser tests only (dev/CI) | patterns come from committed test code only |

A picomatch 4.0.8 release would clear `pnpm audit` but would not touch either of these copies; Next.js and Playwright
must update their own vendored code. Version-based lockfile audits do not cover vendored code at all.

### 2.3 Verdict

No production exposure: the npm package is absent from every production graph and artifact, and the one copy that
ships in production compiles only fixed, build-time patterns. In development and CI, exploitation needs write access
to the repository, which already implies code execution in CI. Real risk: **negligible**. The audit block is correct
under the current policy and is not a false positive about the version.

## 3. Options evaluated

| Option | Result | Why |
| --- | --- | --- |
| Upgrade picomatch | impossible | no release outside `<=4.0.7`; upstream has no fix merged |
| Upgrade the consumers to versions without picomatch | impossible | every `vite` (including 8.4.0-beta.1 of 2026-11-16), `vitest` (5.1.0) and `tinyglobby` (0.2.17) release requires `picomatch ^4`; `typescript-estree` 8.73.0 still requires `tinyglobby` |
| Eliminate the consumers | rejected | means replacing the unit-test runner (Vitest/Vite) and typed linting (typescript-eslint): a tooling migration that would put test coverage and lint gates at risk to remove a dev-only, unreachable issue |
| Override `picomatch` to a fork (`npm:` alias) | rejected | unvetted third-party code in the toolchain; `alias-substitution` (REVIEW); renaming the package makes the audit stop matching the advisory, which hides it instead of fixing it |
| Vendor a fixed copy (`link:`/`file:` override) | rejected | `source-substitution`, a mandatory BLOCK |
| pnpm patch of 4.0.7 (`patchedDependencies`, precedent: `@streamparser/json`, `@xyflow/system`) | feasible, does not unblock | auditable and reversible, but `pnpm audit` and the policy match by version, so 4.0.7 + patch still BLOCKs. The patch would be a self-written fix to a regex compiler whose upstream fix is unreviewed, and this session could not run picomatch's own test suite (executing a downloaded repository's tests was not permitted). Useful only as defence in depth for an exposed copy, which FloFi does not have |
| `auditConfig.ignoreGhsas` / raising the audit level / skipping `pnpm audit` | forbidden | `policy-bypass` BLOCK in the engine, generic, and excluded by the owner |
| Wait for picomatch ≥ 4.0.8 | safe, no ETA | the upstream fix has been open for three months; `master` has been idle since 2026-08-27 |

There was no definitive fix inside DEC-0057, under which certification stayed blocked for every branch, `main`
included, until upstream published one. The owner chose an exposure-based policy instead (DEC-0058, section 4).

## 4. Decision and what each certification re-proves

The owner approved DEC-0058 on 2026-11-17 without expiry, approval dates or renewals: the record stays valid while the
evidence stays the same, and any change the engine cannot re-prove BLOCKs again.

| Check | Where | Result today |
| --- | --- | --- |
| Record matches GHSA-fc5q-39xc-vjpf, `picomatch@4.0.7`, its lockfile sha512 | `dependency_security.py verify` | matches |
| Not reachable from any importer's `dependencies`/`optionalDependencies` | same, from the lockfile | 352 of 505 releases are production; picomatch is not |
| Not imported by production code (the backend image installs devDependencies) | same, import graph from 153 entry points | 1,280 modules; no import of picomatch, tinyglobby, fdir, vite, vitest or typescript-eslint |
| Severity not critical | advisory feed | high |
| Dependents within `fdir`, `tinyglobby`, `vite`, `vitest` | lockfile | exactly these |
| No compatible official fix | registry: picomatch releases vs `>=4.0.8`, each dependent's range, and the dependents' accepted updates | none published (latest 4.0.7) |
| Absent from the production build | `function_traces.py` after `pnpm build` | absent from 2,270 traced files, 1,125 server source maps and the `.next/node_modules` links |
| Production graph clean | `pnpm audit --prod --audit-level low` | no known vulnerabilities |

Live run (2026-11-17): `Dependency security decision: CONTAINED`, 504 PASS + 1 CONTAINED of 505 releases, 505 registry
signatures verified; the SBOM gate accepts the evidence and names the contained advisory.

Not covered by these checks, and unchanged by them: the vendored copies in Next.js (production, unreachable: section
2.2) and Playwright (tests). No lockfile audit sees them; they follow Next.js and Playwright updates.

## 5. When it ends

- picomatch publishes 4.0.8 (or any release fixing the advisory) that a dependent accepts: certification BLOCKs with
  "a compatible official fix exists ... update"; `pnpm update picomatch` (or the dependents' updates) clears it, and the
  record becomes inert ("not in use"), to remove when convenient.
- picomatch reaches a production dependency or production code imports a package that brings it, gains a dependent
  outside the assessed four, changes archive, is re-rated critical, or ships in the build: certification BLOCKs, and
  this assessment is redone for the new exposure.
