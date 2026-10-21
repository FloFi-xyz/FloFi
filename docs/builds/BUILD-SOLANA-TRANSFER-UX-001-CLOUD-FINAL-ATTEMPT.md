# Authorized full certification attempt — FAILURE

[Cloud Build `609a0156-d8b5-4afc-bac7-82ca65715638`](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/609a0156-d8b5-4afc-bac7-82ca65715638?project=celtic-volt-418819) finished **FAILURE** at 2026-10-19T23:46:23.971272Z after 36.43 minutes. This consumed exactly the one newly authorized attempt. No further submission was made.

Source snapshot: `e5ec97df6a3d7595a0eeb6f2d82fa2e84fc04d6520c7ead5d952220160d0b9f0`; 2505 files; current complete worktree submitted directly. Existing E2_STANDARD_2 default pool, dedicated runner and isolated configuration unchanged.

| Gate | Exact result |
| --- | --- |
| Source identity, toolchain, dependencies, audit/SBOM, governance, TypeScript, lint, production build, schema | PASS |
| Unit and contract tests | 4,760 passed; 2 existing skips |
| Complete disposable PostgreSQL | 445 passed; 3 existing skips; zero failures |
| Corrected WhatsApp journeys | 2/2 passed |
| Forks, five offline rehearsals and transcripts | PASS |
| Critical browser profiles | copilot-learning failed; other 5 not run |
| Extended browser profiles | All 38 not run |
| Composition and final certification ledger | Not reached |

The failing test was `e2e/copilot-learning-memory.spec.ts:51`. Its **30-second overall test deadline** expired at line 140 waiting for consent-off. The diagnostic rerun expired at the same total deadline earlier, at line 136 navigating to Privacy. The failure was not an exhausted 10-second assertion deadline.

The unmodified journey passed locally with tracing on two CPU cores: **1/1**, 18.6 seconds in the test, with consent-off in 0.8 seconds and all erasure assertions passing. The local correction assigns **60 seconds total only to this multi-wallet, multi-session durable journey**. Every assertion and its 10-second deadline, zero retries, isolation, erasure and no-signing checks are retained. The corrected guarded profile passed **1/1** on two CPU cores with disposable PostgreSQL; targeted ESLint and whitespace checks passed. Product code is unchanged.

This correction is **after the submitted snapshot** and has not passed remote certification. `cloudbuild-source-manifest.json` is retained as the exact submitted manifest. Earlier 113/113 default-product evidence is preserved; this remote build did not reach it.

Free-tier eligibility was verified against [Google pricing](https://cloud.google.com/build/pricing). Recorded usage before submission was 199.60 minutes; sibling projects had Cloud Build disabled and their historical usage could not be read. No unavoidable extra compute charge was identified. If the free allowance is unavailable, this build's compute estimate is **US$0.218573**; this is not an invoice. No credits purchased, upgrades, service enablement or billing changes.

Outstanding: complete remote browser/composition/ledger certification and fresh authorization before any additional attempt. The GREEN condition for PR preparation was not met; no commit, push, PR, merge or deployment occurred. No production database, real funds or public broadcasts were used.
