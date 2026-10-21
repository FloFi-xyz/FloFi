# BUILD-SOLANA-TRANSFER-UX-001 — release (2026-10-20)

**Current continuation boundary (2026-10-21):** Google Cloud Build is cancelled. The owner directed completion through GitHub and the
existing CircleCI certification only: fix the CoW stage click, commit, open the PR once Preview isolation is verified, and certify on CircleCI.
No merge, production deployment, production database change or funded transaction. See [section 8](#8-github-and-circleci-certification-2026-10-21).
Sections 5–7 and the release authorization below are historical.

Owner instruction of 2026-10-20: finish the build, certify it once more on the existing Google Cloud Build setup, isolate the Vercel
Preview from the production database, open the PR, obtain the required GitHub checks and merge. This record supersedes the HOLD
statements in the [handoff](BUILD-SOLANA-TRANSFER-UX-001-HANDOFF.md) and [audit](BUILD-SOLANA-TRANSFER-UX-001-AUDIT.md).

## 1. Last failure: `canvas-automation-ux` lending parity

Cloud Build `bb114c46-593a-4d9e-92ec-c686427c1b9a` failed only `canvas-automation-ux.spec.ts` "Canvas parity without Advanced
action setup: lending": 30-second test deadline, `openProposalReview` waiting for `Review proposed change:` that never appeared.
Every other stage and the other 44 browser profiles passed.

**Cause: a test race, not a product defect.** The test clicked "Add Supply → Borrow → Swap" immediately after `goto('/app')`.
Supply/Borrow/Repay and the lending composition bind the connected owner as beneficiary (`canvasAddCommand` →
`AUTHOR_LENDING { owner }`). The injected wallet is recognized by the store's passive reconnect (`eth_accounts`/`eth_chainId`
after hydration). On a slow 2-vCPU worker the click can land first; the Canvas then refuses honestly ("Connect your wallet to set
the beneficiary before adding this action.") and creates no proposal, so the Review button never exists.

A throwaway diagnostic spec (not committed) proved it deterministically: with `eth_accounts` delayed 4 s, the click shows exactly
that refusal and no Review button; waiting for the connected wallet first yields the proposal. `lending-composition.spec.ts`
already waits for the wallet before the same click.

**Fix (tests only, no assertion weakened):** `canvas-automation-ux.spec.ts` parity tests and the `canvas-cta.spec.ts` Supply
lifecycle test (same latent race) wait for `.build009-wallet-info` to carry the connected owner before adding an owner-bound action.
Product code is unchanged; the refusal remains the correct fail-closed behavior.

Verification: the complete guarded profile `canvas-automation-ux` passed **5/5 fresh invocations, 18/18 tests each** with CPU
affinity `0,1` inherited by browser, app and harnesses (32.2–33.5 s each).

## 2. A9 agent rollout stays gated

The audit's A9 scope (Orca liquidity on Solana mainnet-beta and native ETH self-transfers on Ethereum Sepolia / Robinhood Chain
Testnet, newly reachable through the Copilot, MCP, channels and the Developer API) had no owner approval. A read-only check of the
deployed configuration (keys and non-secret mode flags only) showed the existing runtime flags those flows use are already on in
production (`GRYLOO_ORCA_MAINNET=live`, `GRYLOO_ORCA_MAINNET_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`,
`GRYLOO_ETHEREUM_SEPOLIA_TRANSFER=live`, `GRYLOO_ROBINHOOD_TESTNET=live` on Railway; the Canvas uses them under earlier approvals).
Runtime and policy opt-ins therefore did **not** gate A9; merging would have released it.

`src/domain/agent-rollout.ts` now gates it in code:

- `policyGate` refuses any handoff whose plan contains a pending capability with `AGENT_ROLLOUT_NOT_APPROVED`. All agent surfaces
  (MCP `request_user_approval`, Telegram/WhatsApp channels, Developer API sandbox) reach execution only through this gate.
- The Copilot's networks per action, its in-app capability answer and its model instructions exclude pending rollouts, so it
  proposes none of them ("Orca" alone again means Solana Devnet, as on `main`).
- `AGENT_ROLLOUT_APPROVED` is empty. No environment variable can release it; approval is a reviewed change to that constant. Tests
  pass the approval explicitly to keep the preserved implementation covered, and assert the default refusal.
- The Canvas keeps its own, separately approved controls for the same actions.

New Solana transfers (this build's scope) remain gated by their own runtime flag (`GRYLOO_SOLANA_TRANSFER`, unset in production),
owner-execution switch and policy.

## 3. Vercel Preview isolation

Read-only project metadata (`flofi`, root `apps/reference-dapp`, no Ignored Build Step, no deploy hooks) still shows one
`DATABASE_URL` targeting Production **and** Preview, with no branch override. `apps/reference-dapp/vercel.json` now adds
`git.deploymentEnabled: { "claude/build-solana-transfer-ux-001": false }`: Git pushes of this exact branch create no deployment,
so no Preview of this branch can reach the production database. Every other branch, including `main`, keeps its current
behavior (validated against Vercel's published schema). No project setting, environment variable or production configuration
was changed.

## 4. Certification, CI and merge

Recorded after the run in section 5.

## 5. Results

The existing [Cloud Build `ea0d6a31-857e-4826-aba1-4bead15a5eb7`](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/ea0d6a31-857e-4826-aba1-4bead15a5eb7?project=547158547199)
finished **FAILURE** at `2026-10-20T03:42:42.223978Z` (started `02:16:02.239330658Z`). Its source snapshot SHA-256 is
`f99b514f966fa0925e5e5a507ea15aca404dace6bbb513b19229d9086037b2ad`. The final metadata and complete console log were retrieved
in this continuation, without submitting a build. The run reached every stage: **17/18 stages passed**, **43/45 browser profiles passed**
(including composition), units **4,760 passed / 2 skipped**, and PostgreSQL **445 passed / 3 skipped**. Typecheck, lint, schemas,
governance, dependency checks, build and forks passed. The browser stage and final certification ledger correctly stayed failed.

The two failing browser tests and their local corrections:

- `canvas-automation-ux`: `canvas-cta.spec.ts`, “Build CTA floats inside the wider canvas without colliding with existing controls”.
  It exhausted 30 seconds waiting for a `.flow-card` after clicking Add Supply before passive wallet reconnect. The inherited fix waits
  for the connected owner's wallet indicator first; it is preserved, along with the same inherited fix in the Copilot stale-answer test.
- `mcp-in-chat`: `mcp-route-presentation.spec.ts`, “a superseded approval lookup cannot expose the workspace”. The “Opening your approval”
  heading is server-rendered, so seeing it did not establish that the client had started the valid lookup or installed its fragment listener.
  The test now waits until its route handler intercepts the valid lookup, keeps that request blocked, changes the fragment in the same
  document, then releases the stale response and retains the workspace-isolation assertions.

The temporary `__stressStart`/three-second `eth_accounts` delay was removed from `supply-fixtures.ts`, restoring that file to HEAD.
Product code, assertions, timeouts, retries, CI orchestration and the submitted source manifest were unchanged by this continuation.

Local verification uses the inherited production build, one browser worker, CPU affinity `0,1`, synthetic loopback services and the
existing disposable PostgreSQL on `127.0.0.1:29434`. The affected guarded profiles passed: **canvas-automation-ux 18/18** (36.62 s)
and **mcp-in-chat 21/21** (74.98 s). The inherited changed Copilot test passed **1/1** (11.3 s): **40/40 affected browser tests passed**.
An initial anchored Copilot title filter selected no tests; the corrected filter selected exactly one test. Its initial log is retained.
Targeted ESLint and `git diff --check` pass. No full unit, PostgreSQL, fork or unrelated browser suite was rerun.

Evidence directory: `/tmp/flofi-solana-transfer-ux-001-continuation-20261020/`. It contains `cloud-build.json`, `cloud-build.log`,
`cloud-evidence-summary.json` (metadata/log SHA-256 plus all 45 profile and 18 stage results), the local test logs and the inherited
patch/browser artifacts saved before reruns. The remote build has no published artifact objects; its console log supplies failure
stacks and screenshot/error-context paths, but those paths are not separately retrieved screenshots.

Basic sandbox commands now succeed. Google evidence retrieval and browser execution needed escalation for the Google/pnpm caches
and local services; AWS credentials were not accessed or modified. All inherited changes are preserved apart from the requested removal
of stress instrumentation. No commit, new Cloud Build, push, PR or deployment occurred. The original Cloud result remains **FAILURE**;
these targeted local passes do not replace full remote certification.

## 6. Authorized certification, 2026-10-21

[Cloud Build `0a03e03c-9885-48ec-ac10-6ea2d28d4c20`](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/0a03e03c-9885-48ec-ac10-6ea2d28d4c20?project=celtic-volt-418819)
finished **FAILURE** at `2026-10-20T23:56:09.556350Z` (started `23:54:12.593990437Z`, 116.96 s). This consumed the single authorized
attempt; no other build was submitted. The complete worktree went directly to the existing private staging bucket with the unchanged
`cloudbuild.yaml`, dedicated `flofi-ci-runner`, default-pool `E2_STANDARD_2` and 10,800-second limit: snapshot SHA-256
`b2ce3eb62f49d4621e8286f318f4c33cbba3de2e32a99eb5c2454f5f2fc31b46`, 2,513 files, base HEAD `1dc54b7`. Before submission the gcloud upload
inventory matched the regenerated manifest exactly and an isolated archive rehearsal passed the worker's verifier and governance preamble.
`cloudbuild-source-manifest.json` is retained as that submitted manifest.

Remotely passed: pinned disposable PostgreSQL, exact source verification, governance self-tests 19, CI self-tests 54, governance-lite,
whitespace, toolchain bootstrap/identity (Node 24.21.0, pnpm 11.22.0), frozen install and dependency integrity/license/age (265).
**Dependency audit failed** (`pnpm audit --audit-level low`: 3 high, 3 moderate), so the fail-fast prerequisites stopped the run. SBOM, build,
typecheck, lint, schemas, units, PostgreSQL, forks, all 45 browser profiles, composition and the ledger were **not reached**. These
advisories were published on 2026-10-20 between 18:30 and 20:08 UTC, after the `ea0d6a31` audit passed:

- `@modelcontextprotocol/server` 2.2.0 (fixed in 2.3.0): GHSA-jm63-cq47-j5jp (shared transport/server instance), GHSA-46jr-4wx8-v453
  (tool-input validation memory) and GHSA-rvq5-wwqv-78pq (bearer audience).
- `vite` 8.3.0 (fixed in 8.3.3), bundled `launch-editor`: GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv and GHSA-r825-w8mm-5pxw.

**Local repair, following the Next.js 16.3.8 security-patch procedure:**

- Exact pins `@modelcontextprotocol/server` 2.3.0 and `vite` 8.3.3. 8.3.4 would require `postcss` 8.5.29 and break the existing
  `source-map-js` override key.
- The regenerated lockfile replaces 20 identities and keeps all 265: MCP server/core 2.3.0, `vite`, `rolldown` 1.2.13 with its 15
  platform bindings, and `@oxc-project/types` 0.153.0.
- `bootstrap-ci.py` updates the MCP direct pin, its license comment and the lockfile hash (`63b1d131…a7d688`). The BUILD-001 approved-pin
  row now records `vite` 8.3.3 with a dated supersession note. `docs/deploy/MCP.md` and `docs/STATUS.md` name the current SDK.
- No waiver, override, exception, test or assertion changed. Every new version predates the seven-day cutoff; `source-map-js` 1.2.2
  remains the only age waiver.
- **Owner review:** from 2.3.0 the MCP SDK manifests declare Apache-2.0 instead of MIT. It is within the allowed license set, so the
  inventory changes to Apache-2.0 36 / MIT 173 and the 16 reviewed exceptions remain unchanged.
- The gateway already creates one server per request through the `createMcpHandler` factory, bounds bodies to 64 KiB, authenticates first
  and binds OAuth tokens to its resource. It does not use the SDK bearer helpers. The new opt-in `maxToolInputElements` is not set.

Local verification on Node 24.21.0 / pnpm 11.22.0: dependency audit **no known vulnerabilities**; frozen install; dependency verifier
**265** (same waiver and exception sets); SBOM 265; governance 19, CI 54, governance-lite and whitespace; typecheck 16/16; lint; schemas 11;
production build 9/9. Units **4,760 passed / 2 existing skips**. Complete disposable PostgreSQL **445 passed / 3 existing skips**. MCP
unit and PostgreSQL files 17, **152/152** on the resolved SDK 2.3.0. MCP-gateway browser profiles on the new build pass **44/44**:
`mcp-routes-oauth-disabled` 11, `developer-journey` 1, `mcp-in-chat` 21, `channel-signing` 6, `channel-approve` 3 and
`approve-authorize-journeys` 2. `canvas-automation-ux` passes **18/18**. Browser runs used one worker, CPU affinity `0,1` and loopback
PostgreSQL. The other 38 browser profiles, composition and Anvil/offline forks were not rerun locally.

Compute was 1.95 minutes (USD 0.0117 at USD 0.006/minute), inside the 2,500 free monthly build-minutes; about 410 minutes were used
this month, and the sibling projects have Cloud Build disabled. Evidence: `/tmp/flofi-solana-transfer-ux-001-final-cert-20261021/`.
No commit, push, PR, merge, deployment, production database, secret or real-funds transaction occurred. FULL GREEN remote certification
remains outstanding and needs a fresh authorization to submit this repaired tree.

## 7. Final authorized certification, 2026-10-21

[Cloud Build `6cae710b-14b0-45d4-b0a4-ec125ebb9e8c`](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/6cae710b-14b0-45d4-b0a4-ec125ebb9e8c?project=celtic-volt-418819)
finished **FAILURE** at `2026-10-21T01:59:48.801576Z` (started `00:32:28.371778840Z`, 87.34 minutes). This consumed the one additional
authorization; no other build was submitted. It used the same configuration and runner. The source was snapshot
`105163e0549915f7eb67fdb179dd1d113ebedb7307a1e5f7479353d23e52af1c` (2,513 files, base HEAD `1dc54b7`), with the section 6 dependency repair.
Before submission, the local dependency audit was clean, the upload inventory matched the manifest and the archive rehearsal passed.
`cloudbuild-source-manifest.json` is retained as this submitted manifest.

Every stage passed except the guarded browser suites and therefore the strict ledger:

- Source verification, governance self-tests 19, CI self-tests 54, governance-lite, toolchain, frozen install, dependency integrity 265,
  **dependency audit (no known vulnerabilities)**, SBOM, production build and bootstraps.
- Browser profiles **44/45**: critical 6/6, extended shard 1 19/19, extended shard 2 18/19, composition 1/1 with its three fork tests.
  Previously failing `canvas-automation-ux` (18) and `mcp-in-chat` (21) passed.
- Typecheck, lint, schemas; units **4,760 / 2 existing skips**; PostgreSQL **445 / 3 existing skips**; Anvil and offline forks.

**Exact failure:** profile `cow-loopback`, 8/9. `e2e/cow-intent.spec.ts:60`, “CoW option is keyboard reachable and review fits a narrow
viewport”, exceeded its 30-second test timeout (35.0 s with teardown). The pending step was `authorCowSwap` → `stage(page, 'Build')`
at `cow-fixtures.ts:17`. The click on the already selected Build stage button (`aria-current="page"`) stayed at “waiting for element
to be visible, enabled and stable” until the page closed. No server or page error was logged.

The cause is **not established**. The same test took 4.1 s in `ea0d6a31`; its spec, fixture and the CoW path are unchanged since. The
Build stage button is never disabled, and no CSS rule hides, animates or transitions the stage tabs at narrow widths. Locally, with one
worker and the current production build, the profile passed 3/3 with this test at about 2 s. The single test passed 25/25 on CPUs `0,1`
and 15/15 on one CPU. Cloud publishes no browser artifacts and disables trace reruns, so the remote error context was not retrievable.
No test or product change was made: a change without an established cause would be speculative.

Compute: 87.34 minutes (USD 0.524 at USD 0.006/minute), about 498 of the 2,500 free monthly build-minutes. Evidence:
`/tmp/flofi-solana-transfer-ux-001-final-cert2-20261021/`. No commit, push, PR, merge, deployment, production database, secret or
real-funds transaction occurred. FULL GREEN is not achieved; any further attempt needs fresh owner authorization.

## 8. GitHub and CircleCI certification, 2026-10-21

**CoW stage helper.** `stage()` in `e2e/cow-fixtures.ts` now reads the stage button's `aria-current` and clicks only when the requested
stage is not current. It then asserts that the requested stage is current. Selecting the current stage is a product no-op: `setTab`
sets the same section and navigates only from the dashboard or a secondary route, and `aria-current="page"` excludes both. The redundant click was the step that stalled in
`6cae710b`. That stall is not reproduced: the previous helper passed 63/63 local attempts, including 8× CPU throttling and two busy loops
on the same two cores. The change removes the redundant actionability wait and verifies every stage navigation, which the helper did not do
before. Only `cow-intent.spec.ts` and `cow-recovery.spec.ts` import it.

New helper: `cow-loopback` passed 5/5 guarded runs (45/45 tests). The narrow-viewport journey passed 8/8 with 8× CPU throttling and
12/12 under the same two-core contention (one worker, CPU affinity `0,1`). ESLint, app TypeScript (including e2e), governance 19, CI 54,
governance-lite and whitespace pass. The temporary stress spec used for this was deleted.

**Publication safety, verified read-only before any push.**

- Vercel `flofi` reads `apps/reference-dapp/vercel.json` (Root Directory `apps/reference-dapp`). Every commit of this branch sets
  `git.deploymentEnabled["claude/build-solana-transfer-ux-001"] = false`, which per Vercel's Git configuration documentation stops deployments for its commits.
  There is no ignored-build-step command and there are no deploy hooks. `DATABASE_URL` targets Production and Preview without a branch
  scope, so this exclusion is what keeps the branch away from the production database.
- Railway `enthusiastic-illumination`: PR environments are off (`prDeploys: false`). `flofi-api` and `flofi-worker` each deploy only
  from `main`.

**CircleCI.** The existing `manual-backup-certification` workflow runs governance, the three certification jobs and the ledger fan-in.
`main` requires `ci/circleci: governance` and `ci/circleci: certification`. The existing config already keeps JUnit, screenshots,
error context and diagnostic traces as artifacts. The CircleCI result is recorded on the pull request rather than in a later commit,
so the required statuses stay on the certified head.

**CircleCI pipeline 59** (head `f9acdb5`, [PR #112](https://github.com/alrimarleskovar/FloFi/pull/112)): `governance` and
`certification-checks` passed, covering dependency integrity, the audit, SBOM, typecheck, lint, schemas, units, PostgreSQL and forks.
Each browser job failed one test, and the automatic diagnostic rerun passed both times. Fail-fast left the profiles after each failure
unrun. `cow-loopback` passed with the new helper.

- `default-product`: `brand-ux-001.spec.ts:72` measured horizontal overflow once, immediately after the client-side navigation to `/app`
  at 375 px. The teardown screenshot shows a fitting layout. 18 local frame-sampled runs at 320, 375 and 390 px, including with web fonts
  blocked, never overflowed. The check now polls the same `scrollWidth <= innerWidth` condition until the layout settles; a persistent
  overflow still fails.
- `mcp-in-chat`: the superseded approval lookup stayed on "Opening your approval" after the test set `#incomplete`. The gate removes the
  secret through Next's patched `history.replaceState`, which dispatches a router transition. When it commits, Next writes its canonical
  URL without a fragment. If that commit lands between a fragment change and its `hashchange` handler, the handler reads an empty
  fragment and reloads the stored secret. The same race could show a user the previous proposal instead of a newly opened link in the
  same tab. The gate now reads the fragment from the `hashchange` event's `newURL`; the initial load and `popstate` still read the address
  bar. Under 8× CPU throttling the unchanged gate failed this journey 9/10 times and the fixed gate passed 10/10.

On the rebuilt app, every browser profile that opens `/approve` or the MCP gateway passed (44/44), and so did `cow-loopback` (9/9) and
`brand-ux-001.spec.ts` (15/15). ESLint, TypeScript, governance 19, CI 54, governance-lite and whitespace pass. The temporary stress and
diagnostic specs were deleted.

**Continuation preflight, 2026-10-21 09:03 UTC.** The actual local and remote branch head is `f9acdb50068ec1c6c2e9c925afa1824cc7ad41c7`;
`main` and PR #112's base remain `616598fe3cce44dc6d48444753d6b70886873c1d`. All implementation and the CoW helper are already committed.
The only inherited pending files are the two fixes above and these release/handoff records. Their browser logs and stress evidence remain
in `/tmp/flofi-solana-transfer-ux-001-cow-fix-20261021/`; the historical final-cert2 directory also exists. No temporary diagnostic spec
is present in the tracked or untracked source inventory. Targeted ESLint, app TypeScript and whitespace checks pass again.

Authenticated Vercel metadata again confirms Root Directory `apps/reference-dapp`, production branch `main`, no ignore command and no deploy
hooks. The database variable still targets both Production and Preview; its value was not decrypted, printed or used. The branch exclusion
remains present, and the deployments API returns no deployment for this branch. Sanitized preflight evidence is
`/tmp/flofi-transfer-release-review-20261021/publication-preflight.json`. No production settings or database were changed.

The existing failed CircleCI pipeline 59 is the only branch pipeline before this continuation's push. Required certification will run on
the consolidated head, with no manual duplicate trigger. An authenticated CircleCI credit balance is unavailable in this session; no
CircleCI credential is configured in the environment or standard CLI location. Pipeline admission and concrete job results remain the
release gate. Final results will be recorded on PR #112 so the required statuses remain attached to the certified commit. Merge and
deployment still require explicit owner authorization; real-wallet, external MCP-host interoperability and production validation remain
outstanding even after CI passes.
