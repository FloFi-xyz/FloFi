# BUILD-SOLANA-TRANSFER-UX-001 authorized certification follow-up

The owner authorized one additional direct-source Google Cloud certification attempt within the existing EUR 5 project allowance. No further paid attempt is authorized. The previous failed build remains recorded in `BUILD-SOLANA-TRANSFER-UX-001-CLOUD-BUILD.md` and its JSON.

## Local fix and required gates

Before submission, the only source/test change in this turn was `apps/reference-dapp/src/channels/whatsapp/journey.pg.test.ts`. The loaded notice now matches the exact conservative lifecycle message: loading grants no transaction authority. The reconciled messages require the exact evidence hash and owner-scoped dashboard receipt URL. Added checks cover zero sends during preparation, no successful receipt before observation/reconciliation, wrong-owner run reads, owner reads, absence of URL credentials/query/fragment/approval secrets, MOCKED labeling, deduplication, and chat/log privacy. The run ID is permitted only within the intended receipt link. Existing owner consent and exact wallet send counts remain enforced.

The receipt implementation is legitimate and unchanged: `sharedRuns` requires an owner-scoped independent evidence read, successful reconciliation, a completed run, no pending observation or error, and an evidence bundle/environment. Status sharing remains revocable. The dashboard requires the matching signed wallet principal; its link grants no read or signing authority.

Local validation on pinned disposable PostgreSQL 18.6, bound only to `127.0.0.1:7096`, with uniquely created/dropped test databases and synthetic chain transports:

- Both failed WhatsApp journeys: 2/2 passed.
- Complete PostgreSQL suite: 445 passed, 3 existing skips, zero failures; 69 files passed, 1 existing skipped file.
- Focused lifecycle/evidence/dashboard access-control checks: 59/59 passed.
- TypeScript: 16/16 tasks passed. Changed-file ESLint passed.
- CI self-tests: 45/45; governance self-tests: 19/19; governance scan and whitespace passed.

Logs: `/tmp/flofi-transfer-cert-{whatsapp,postgres,focused,typecheck,eslint,ci,governance-tests,governance}-20261019.log`. Comparison against the failed build's manifest confirmed that all product implementation, browser suites, security tooling, configuration and full certification stages remain byte-identical; only the stated test and build-report updates differ.

## Budget and isolation preflight

Read-only inspection of all 44 published Cloud Build locations (including global) found seven historical project builds, all E2_STANDARD_2, none active: 148.100492 minutes total. At [Google's published USD 0.006/minute rate](https://cloud.google.com/build/pricing), prior compute is at most USD 0.888603 before free-tier credits. Reserve EUR 2 per USD plus EUR 0.50 for source/log storage: EUR 2.722794 remains before the new attempt. Its unchanged 180-minute timeout limits compute to USD 1.08 (EUR 2.16 with that conservative conversion), leaving EUR 0.562794 after the maximum. This is a conservative usage-based estimate, not a final invoice or an enforced billing cap; the optional Billing Budgets API is unavailable and was not enabled.

Billing remains enabled, the billing account open, build-create permission and runner actAs verified. Dedicated runner `flofi-ci-runner@celtic-volt-418819.iam.gserviceaccount.com` has only logging.logWriter on the project and storage.objectViewer on the private source bucket. Bucket uniform access and public-access prevention remain enabled. `cloudbuild.yaml` and `scripts/gcp-ci-full.sh` are unchanged from the prior attempt: sequential full certification, pinned disposable PostgreSQL, synthetic/offline chain transports, no secrets injected, no deployment or production steps, E2_STANDARD_2 and 10,800-second timeout.

## Cloud result

**FAILURE. Complete green certification has not been achieved.** [Cloud Build adf668d1-bbf1-4f21-94f4-d655ec4a4307](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/adf668d1-bbf1-4f21-94f4-d655ec4a4307?project=celtic-volt-418819), project `celtic-volt-418819`, region `europe-west1`. Started 2026-10-19T21:53:17.468611418Z, finished 2026-10-19T22:44:47.598687Z (3090.13 seconds; 51m 30s). Failure type `USER_BUILD_STEP`; `full-certification` exited 1. One additional owner-authorized attempt consumed; no further paid submission. [Effective build, results and local fix](BUILD-SOLANA-TRANSFER-UX-001-CLOUD-RETRY.json).

Submitted the existing complete worktree directly, with the same isolated configuration and dedicated runner, only after the full local PostgreSQL suite passed. Snapshot SHA-256 **`f53a7b2ad733aea9a39cc44dc6a519ed22d365fdefb51314d689e82b1ccb2130`**: 2,504 source files / 115,068,074 bytes plus the manifest; exact SDK inventory and remote byte/mode/inventory verification passed. Source archive: `gs://flofi-ci-source-547158547199-europe-west1/build-solana-transfer-ux-001-retry/1792446732.852893-c8bfdfda52dc4b948baacc3c4d71880a.tgz`, generation `1792446796077927`. No trigger invocation, GitHub push/PR, Vercel/Railway deployment, production database access, public transaction broadcast, real funds or production changes.

| Remote gate | Exact result |
| --- | --- |
| Governance self-tests / CI self-tests / scan | PASS: 19 / 45 / 2,101 text files |
| Frozen dependencies / integrity-license-age / audit / SBOM | PASS; no known vulnerabilities |
| TypeScript / lint / production build / schemas | PASS |
| Unit and contract tests | PASS: 4,760 passed, 2 existing skips |
| Complete PostgreSQL suite | PASS: 445 passed, 3 existing skips; 69 files passed, 1 existing skipped file |
| Fixed WhatsApp journeys / Solana transfer journey | PASS: 2/2 each, within PostgreSQL |
| Anvil / fork commands / five offline rehearsals / transcript checks | PASS; owner-only fork cases remain the existing explicit skips |
| Six critical browser profiles | PASS: 60 tests, including Solana transfer UX 7/7 |
| First extended profile, default-product | FAIL: 112 passed, 1 failed |
| Other 37 extended profiles / composition / final ledger | NOT REACHED after the strict browser failure |

### Exact downstream failure and local fix

`apps/reference-dapp/e2e/interface-honesty.spec.ts:29`, test **provides semantic landmarks, labelled controls and keyboard access**, timed out after 10 seconds expecting `getByLabel('Describe your flow')` to be focused. The input was initially disabled in server HTML, then became enabled without receiving focus. `AppShell` deliberately disables interaction until its hydration effect runs; Playwright's `focus()` call does not wait for input enablement or retry it later. The automatic trace diagnostic passed, confirming the timing dependence, but correctly left the cloud profile and build FAILED.

Added an explicit `toBeEnabled()` readiness assertion before `focus()`. The existing visibility, focus, keyboard typing/Enter, proposal review, apply and workflow revision assertions are retained; no timeout increase, retry, skip, screenshot change or product change. This post-build fix passed **3/3 interface-honesty tests** and the **entire default-product profile, 113/113**, locally with the pinned browser and loopback-only synthetic chains. ESLint and TypeScript (16/16 tasks) passed. Local logs: `/tmp/flofi-transfer-cert-interface-honesty-20261019.log`, `/tmp/flofi-transfer-cert-default-product-20261019.log`, `/tmp/flofi-transfer-cert-final-typecheck-20261019.log`, `/tmp/flofi-transfer-cert-interface-eslint-20261019.log`.

The submitted manifest is retained unchanged. The readiness fix and final report updates are after the cloud run and are **not** part of its tested snapshot. Product code, prior unit/PostgreSQL/security/governance assertions, CI configuration and all other browser tests remain preserved. Historical 44/44 local product profiles and composition evidence remain historical; unrun remote stages are not counted as green.

### Actual attempt cost estimate and remaining blockers

This 51.50-minute attempt implies **USD 0.309013 compute** before free-tier credits, not a final invoice. Applying the preflight's conservative EUR 2 per USD and retaining its EUR 0.50 source/log reserve leaves **EUR 2.104768** of the EUR 5 project allowance on that usage-based estimate. No paid API, billing-budget or production configuration was enabled or changed.

**Outstanding blockers:** explicit owner authorization for any further paid Cloud Build attempt, followed by a complete green remote run of the fixed current worktree. Default-product must be re-certified, the other 37 extended profiles and composition must run, and the strict final ledger must pass. No further paid attempt has been submitted. The owner-authorized additional attempt ended FAILURE; it is not a complete green certificate.
