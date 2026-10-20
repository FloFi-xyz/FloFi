**Current certification result — 2026-10-19T22:44:47.598687Z. FAILURE.** [Cloud Build adf668d1-bbf1-4f21-94f4-d655ec4a4307](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/adf668d1-bbf1-4f21-94f4-d655ec4a4307?project=celtic-volt-418819): PostgreSQL **445 passed / 3 existing skips / zero failures**, units **4,760 passed / 2 existing skips**, security/governance/build/forks and six critical browser profiles passed. The first extended profile failed on the prompt focus-before-hydration race. That test now waits for enablement and passed locally with the full **113/113 default-product** profile. The other 37 extended profiles, composition and final ledger were not reached remotely. One additional authorized attempt was consumed; no further paid submission. [Exact result, local fix and blockers](BUILD-SOLANA-TRANSFER-UX-001-CLOUD-RETRY.md). Earlier checkpoints below are historical.

# BUILD-SOLANA-TRANSFER-UX-001 Google Cloud Build result

**FAILURE. One authorized attempt submitted; no retry.** [Build 1b85bb9b-41ca-4b0c-9096-5a45abbc318f](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/1b85bb9b-41ca-4b0c-9096-5a45abbc318f?project=celtic-volt-418819), project `celtic-volt-418819`, region `europe-west1`. Started 2026-10-19 01:40:12 UTC, finished 02:14:13 UTC (34m 01s). Step `full-certification` exited 1, failure type `USER_BUILD_STEP`.

## Exact source and effective configuration

Submitted the existing WSL worktree directly with `gcloud builds submit . --config=cloudbuild.yaml --project=celtic-volt-418819 --region=europe-west1 --service-account=projects/celtic-volt-418819/serviceAccounts/flofi-ci-runner@celtic-volt-418819.iam.gserviceaccount.com`, explicit snapshot/branch substitutions, the private CI source staging bucket, and `--async --quiet --format=json`. No GitHub push, PR or trigger run. The existing `flofi-ci-manual` trigger still points at its old branch and was not changed or invoked.

Source identity is **SHA-256 `3326ec102e2b37459d2967168189d2809093846f472e94739bf773367ccedf9c`**, covering 2,501 files / 115,038,287 bytes plus the manifest. All intended modified and untracked source/test files were included. The SDK's effective upload inventory matched the manifest exactly. Secret screening and an isolated archive rehearsal passed; the remote worker verified every source byte, file mode and inventory before installing dependencies. Base HEAD `616598fe3cce44dc6d48444753d6b70886873c1d` is provenance only, not the dirty snapshot's identity. The worker initialized a local temporary Git repository from the uploaded archive for governance; no old revision was fetched.

Source archive: `gs://flofi-ci-source-547158547199-europe-west1/build-solana-transfer-ux-001/1792373959.261557-fe22eafc82204656b76123878a5cfd08.tgz`, generation `1792374011371016`. [Machine-readable effective build and results](BUILD-SOLANA-TRANSFER-UX-001-CLOUD-BUILD.json). This report and the final handoff/state updates were written after the build and are not part of its tested snapshot. The source manifest is retained unchanged.

The effective build used the dedicated `flofi-ci-runner@celtic-volt-418819.iam.gserviceaccount.com`, `E2_STANDARD_2`, a 10,800-second timeout and `CLOUD_LOGGING_ONLY`. No secrets or deployment steps. The already certified full runner was adapted to validate the uploaded dirty archive; its test stages were retained. `.circleci/config.yml`, browser sharding/profile plan and CI architecture tests remained byte-identical to their pre-submission state.

## Certification results

| Gate | Result |
| --- | --- |
| Uploaded snapshot verification | PASS, exact hash above |
| Governance self-tests / CI self-tests | PASS, 19 / 45 |
| Governance scan / whitespace | PASS, 2,098 text files |
| Frozen dependencies / registry integrity, license and age checks | PASS, 265 locked versions checked |
| Security dependency audit / SBOM | PASS, no known vulnerabilities; ephemeral CycloneDX generated |
| TypeScript / lint | PASS, 16/16 tasks / PASS |
| Application production build / schema exports | PASS, 9/9 tasks / 11 verified |
| Unit and contract tests | PASS, 4,760 passed / 2 skipped (3 PNG tests separately, then 4,757 passed / 2 skipped) |
| Full disposable PostgreSQL suite | FAIL, 443 passed / 2 failed / 3 skipped; 68 files passed / 1 failed / 1 skipped |
| New durable Solana transfer journey | PASS, 2/2 within the PostgreSQL suite |
| Anvil/fork, 44 browser profiles, composition, strict final ledger | NOT REACHED after PostgreSQL failure |

Historical local 44/44 browser profiles (372 tests) and composition 1/1 remain preserved evidence. This failed remote attempt does not recertify them or establish a new browser regression.

## Exact failures and their limits

Both observed failures are in `apps/reference-dapp/src/channels/whatsapp/journey.pg.test.ts`:

1. **Router bridge journey, line 112.** Expects the loaded notice to continue with `Nothing is signed yet`; received `Loading it does not authorize or submit a transaction. Check FloFi for the current workflow status.` The new wording deliberately avoids making a claim about a delayed notice's current signing state. This assertion is stale. It fails before this journey's execution and reconciliation assertions; those later assertions are therefore untested in this run.
2. **Five-step lending composition journey, line 182.** Expects the reconciled text to end at the shortened bundle hash. Received the same `MOCKED` reconciliation line plus the owner-scoped `Receipt: http://127.0.0.1:3100/app/dashboard/runs/...` line. The journey reached `COMPLETED` with `RECONCILED` evidence before this assertion. Its exact message contract is stale after the intended receipt addition; later assertions did not run.

The router's later exact receipt-text and no-run-id-in-chat assertions also conflict with the intended scoped receipt URL and need deliberate migration. Retain the guarantees about owner consent, receipt access control, zero pre-authorization sends, exact send counts, deduplication and secret/transaction-data privacy. Do not weaken these assertions or label the whole journey certified based solely on these two message mismatches. No implementation or test assertion was changed after the failed build.

## Safety, cost and approvals

Billing was enabled and the existing billing account was open. Build-create, source bucket access and runner `actAs` permissions were verified. A private, uniform-access, public-access-prevented CI-only staging bucket was created in `europe-west1`, with `roles/storage.objectViewer` granted to the dedicated runner on that bucket only. No production IAM or database changes. The build used pinned disposable PostgreSQL on the Cloud Build Docker network, no production environment files, keys or secret injection, and synthetic/loopback chain transports. No real funds, public transaction broadcasts, Vercel/Railway deployment, merge or production change.

At the verified [Cloud Build rate](https://cloud.google.com/build/pricing) of USD 0.006/minute for this worker, the three-hour maximum was USD 1.08 (approximately EUR 0.96 at the checked exchange rate), plus marginal source/log storage. This attempt's approximately 34 minutes implies **about EUR 0.18–0.19 compute**, not a final invoice, within the owner's EUR 5 allowance. No paid API or budget configuration was enabled or changed. The optional Budget API was disabled, so its configured budget could not be read; this does not represent a newly enforced spending cap.

**Owner approval still required:** any second paid certification attempt; any push/PR and verified Vercel branch exclusion or truly isolated Preview configuration before that push; A9 rollout/runtime/policy opt-ins; merge, deployment, production changes, or funded/live-chain sessions. No further approval was needed for this completed attempt. Real MCP hosts/extensions, live LI.FI, live chain certification and the documented legacy positive execution/recovery gaps remain outside this result.
