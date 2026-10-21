**Latest authorized certification — 2026-10-19T23:46:23.971272Z: FAILURE.** [Cloud Build `609a0156-d8b5-4afc-bac7-82ca65715638`](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/609a0156-d8b5-4afc-bac7-82ca65715638?project=celtic-volt-418819) passed units **4,760 / 2 existing skips**, complete PostgreSQL **445 / 3 existing skips / zero failures**, security/governance/build and forks. The first critical browser profile exhausted its 30-second overall journey deadline. Only that journey now has a 60-second total budget; all assertions and 10-second assertion limits remain. Its corrected guarded profile passed locally **1/1 on two CPU cores**. The other 44 profiles, composition and final ledger were not reached remotely. One newly authorized attempt consumed; no additional submission. GREEN was not achieved, so PR preparation was not performed. [Exact result and local fix](BUILD-SOLANA-TRANSFER-UX-001-CLOUD-FINAL-ATTEMPT.md). Earlier checkpoints below are historical.

**Current certification result — 2026-10-19T22:44:47.598687Z. FAILURE.** [Cloud Build adf668d1-bbf1-4f21-94f4-d655ec4a4307](https://console.cloud.google.com/cloud-build/builds;region=europe-west1/adf668d1-bbf1-4f21-94f4-d655ec4a4307?project=celtic-volt-418819): PostgreSQL **445 passed / 3 existing skips / zero failures**, units **4,760 passed / 2 existing skips**, security/governance/build/forks and six critical browser profiles passed. The first extended profile failed on the prompt focus-before-hydration race. That test now waits for enablement and passed locally with the full **113/113 default-product** profile. The other 37 extended profiles, composition and final ledger were not reached remotely. One additional authorized attempt was consumed; no further paid submission. [Exact result, local fix and blockers](BUILD-SOLANA-TRANSFER-UX-001-CLOUD-RETRY.md). Earlier checkpoints below are historical.

# BUILD-SOLANA-TRANSFER-UX-001 certification — Cloud Build failed

**Google Cloud Build checkpoint — 2026-10-19 02:14 UTC. FAILURE, one authorized attempt consumed.** [Cloud Build result](BUILD-SOLANA-TRANSFER-UX-001-CLOUD-BUILD.md): `1b85bb9b-41ca-4b0c-9096-5a45abbc318f`, direct current-worktree upload, dedicated CI runner, exact source SHA-256 `3326ec102e2b37459d2967168189d2809093846f472e94739bf773367ccedf9c`. No old trigger, push, PR, merge or deployment. Remote units **4,760 passed / 2 skipped**; governance **19**, CI tests **45**, security audit, TypeScript, lint, production build and schemas passed. Full disposable PostgreSQL: **443 passed / 2 failed / 3 skipped**. Both observed failures are stale WhatsApp journey message assertions (loaded notice at line 112, receipt suffix at line 182); later assertions were not all reached. The new durable Solana transfer journey passed **2/2**. Fork, browser/composition and final certification ledger were **not reached**. Incoming local **44/44** browser results remain preserved historical evidence.

**Final blockers and approval boundary.** Migrate the WhatsApp journey expectations while preserving privacy, owner consent, deduplication, no-send-before-authorization and scoped receipt assertions; then obtain explicit approval for any second paid certification attempt. Vercel exclusion or genuinely isolated Preview configuration still needs owner approval before any push; A9 external rollout/runtime/policy opt-ins, push/PR, merge, deployment, production changes and funded/live-chain sessions remain separate approvals. This completed direct-source GCP attempt bypassed the Preview integration without changing Vercel. The optimized CircleCI architecture is unchanged. Approximately EUR 0.18–0.19 compute is estimated for the 34-minute attempt; final invoiced cost was not read.

**Snapshot boundary.** The result report and these handoff/state updates were written after the build. Implementation/test source and the archived manifest remain unchanged. Earlier checkpoint statements below about zero Cloud Build attempts or prohibiting all remote CI are historical and superseded by the explicit one-attempt GCP authorization and result above.

---

Historical pre-Cloud-Build checkpoint retained below:

**Current owner-requested checkpoint, 2026-10-19. No push, PR, CI, deployment, Vercel change or production access is authorized in this turn.** The earlier conditional one-attempt authorization remains unspent. This document is a handoff, not permission to proceed.

| Remaining requirement | Exact disposition / approval |
| --- | --- |
| Vercel Preview database boundary | **Blocking.** Shared Production/Preview `DATABASE_URL` metadata confirmed; no override for this branch. A tenant is insufficient. Owner must approve exact branch exclusion (preferred) or genuinely separate database/runtime provisioning and branch configuration; verify before any future push. [Reviewable procedure](BUILD-SOLANA-TRANSFER-UX-001-PREVIEW-ISOLATION.md). No Vercel setting/file changed. |
| A9 rollout | Implementation retained as the owner requested. Capability reporting now checks each testnet transfer's actual runtime network configuration; older runtimes fail closed. Orca requires runtime + execution opt-in + policy, reports `NONE_DEMONSTRATED`. Owner release/configuration approval remains; retaining code for review needs no extra approval. |
| CircleCI budget and trigger/context safety | Authenticated current billing balance/ceiling and project settings remain unverified. Owner/account evidence required before any future attempt; no CircleCI token or settings changed. Optimized governance + three large jobs + small fan-in, sharding and profile ledger remain unchanged in this continuation. |
| Product lifecycle truth | Fixed: read-only preparation cannot announce financial execution, and a summary evidence flag alone cannot produce a receipt. Successful independently reconciled evidence is required; MOCKED remains MOCKED. |
| Legacy coverage | [Sixteen-spec classification](BUILD-SOLANA-TRANSFER-UX-001-LEGACY-TESTS.md) records stale contracts, retained diagnostics and genuine browser coverage gaps. Dashboard's obsolete `/` assertion was corrected to `/app`; preservation/no-signature assertions remain. Do not call the legacy success/recovery matrix certified or delete its financial assertions solely because the labels changed. |
| Remaining certification evidence | Full PostgreSQL/fork gates, live LI.FI `build009`, protocol-specific positive browser gaps, actual Claude/ChatGPT hosts and wallet extensions, live RPC/Mainnet/Devnet execution remain unverified. Provisioning/deployment/funded sessions require separate owner approval. |

Local evidence added: production build, TypeScript, lint, **4,760 passed / 2 skipped** units, **59/59** focused lifecycle/gate checks, **21/21** durable PostgreSQL tests, **27/27** affected browser checks in four profiles and **dashboard-foundation 5/5**. CI architecture **41/41**, governance **19/19**, scan, schemas and whitespace pass. A new disposable pinned loopback container and in-memory chains were used; the container was removed afterward. The Solana journey explicitly verifies zero sends/no receipt after simulation and no receipt during unknown submission. Existing MCP router receipt expectation now includes the exact scoped receipt URL. Incoming 44/44 and composition 1/1 remain preserved historical results, not a newly issued full certificate.

The following earlier plan remains useful for commands and remaining coverage, but its outdated statements about no local composition/durable/full-app checks or accepting a shared-database Preview are superseded above.

---

**Preflight status, 2026-10-19 (supersedes the blockers below where stated).**

| Precondition | Status |
| --- | --- |
| Full-app browser journeys migrated (audit A3) | **Cleared locally.** Incoming 44/44 profiles and composition 1/1 passed; `build009.spec.ts` (live LI.FI quote) was excluded. Current focused reruns and remaining gaps are documented above. |
| Current CircleCI credit balance (A4) | **Unverified.** No CircleCI credential exists in this environment and the public API exposes no billing. Read the authenticated organization Plan Overview before authorizing. Size reference: the last `main` certification used 11.5 + 16.4 + 19.6 `large` job minutes plus `small` governance/fan-in; this branch adds about 1.5 browser minutes (new `approve-authorize-journeys` profile in shard 2). |
| Trigger safety (A5) | Historical pipeline history suggested PR-triggered CircleCI, but current trigger settings remain unverified. The current shared-database Vercel Preview is **prohibited**; owner-approved exclusion/isolation must precede any future push. Railway's preceding read-only audit found `main`-only deployment with PR environments off; reverify before remote actions. |
| Scope decision (audit A9) | **Owner confirmation needed**: Solana-mainnet Orca liquidity and testnet self-transfers exposed to Copilot/MCP/Developer API. |

No attempt is permitted in this turn. Only after explicit future instruction and cleared safety/budget/isolation prerequisites may the one-attempt plan be used. Never accept the shared production-database Preview, duplicate a pipeline or use `[skip ci]` as a database isolation control.

The owner authorized preparation for PR and **one** controlled CircleCI attempt on 2026-10-18, conditional on passing audit and verified CI safety/budget. That authorization is acknowledged and has not been consumed. No remote CI, deployment, provisioning, push, PR or public transaction has been started; current local disposable database tests are described above. Browser migration A3 is resolved. Current owner instructions prohibit remote action, and billing/trigger safety, Preview isolation and A9 rollout remain unresolved.

The checked-in CircleCI workflow automatically runs governance, three large certification jobs and a small ledger fan-in. Its name `manual-backup-certification` is not a manual trigger guard. Required checks are `ci/circleci: governance` and `ci/circleci: certification`. Both GitHub Actions workflows are disabled remotely; keep them disabled to avoid duplicate work. The new offline browser suite is registered exactly once in `scripts/guarded-release-browser.mjs`'s critical tier and is required by the shared ledger; no separate manual pipeline is needed. The PostgreSQL gate automatically includes the transfer handoff journey.

Before push/PR, verify an authenticated current CircleCI organization billing balance, project trigger rules, absence of production credentials in the intended jobs, and no automatic Vercel/Railway deployment for this branch/PR. Historical credit consumption and Insights estimates do not establish remaining billing credits. No available CircleCI integration/credential was found in this session. The baseline commit has Vercel and Railway deployment statuses; no assumption is made about branch/PR exclusions. Do not change production or integration settings to work around these prerequisites. If any prerequisite fails or cannot be verified, stop and report it. Never use another paid provider as a fallback.

Use an isolated external runner at this worktree's final reviewed commit, Node 24.21.0 and pnpm 11.22.0. Use no production secrets, production database, real wallet keys or public RPC credentials. Provision a disposable PostgreSQL service on loopback inside that runner; set `TEST_DATABASE_URL` to that service only. The existing test harness refuses non-loopback hosts, creates random test databases, migrates them and drops them afterward. Do not point it at an existing Preview database or a forwarded production service. Limit Vitest to one worker for these journeys, with no retries. No paid job is approved by the existence of this file.

Build packages in dependency order (no application deployment):

```sh
pnpm exec turbo run build --filter='./packages/*' --concurrency=1
```

Then certify the actual durable backend and MCP protocol using in-memory chains and disposable test keys:

```sh
pnpm exec vitest run \
  apps/reference-dapp/src/mcp/handoff/solana-transfer-journey.pg.test.ts \
  apps/reference-dapp/src/mcp/handoff/handoff.pg.test.ts \
  apps/reference-dapp/src/mcp/handoff/journey.pg.test.ts \
  apps/reference-dapp/backend/solana-cloud.pg.test.ts \
  apps/reference-dapp/backend/solana-composition-cloud.pg.test.ts \
  --maxWorkers=1 --testTimeout=120000
```

The new transfer journey creates a proposal, verifies/claims/applies it for the owner, simulates and reviews, requests an exact wallet signature, handles a lost submission response, restarts the runtime between requests, independently reconciles, and checks the assistant's shared verified receipt. Its transport cannot reach a public chain. Confirm wrong-owner access, status-sharing revocation, namespace/tenant boundaries, lease expiry and duplicate submit behavior with the existing cloud/handoff suites before accepting the build.

The latest local checkpoint also adds an in-workflow network-switch action. Certify switching from the wrong network on every registered switchable EVM network and both Solana clusters, preserving the intended account/provider and requiring fresh Review after authority changes. Rejecting the switch must leave the proposal recoverable without signing or submitting. Verify that Mainnet proposals always disclose real funds even while the wallet is on a testnet, Mainnet USDC is never labeled devUSDC, and expected outputs/minimum received values match the exact reviewed transaction. Unregister a Wallet Standard provider before and during signing, then re-register the same name: the old session must never release signed bytes or revive its Review. Arbitrum Sepolia remains a destination-only path in the current registry; do not infer a newly implemented signing operation there.

Next, run a complete Next application browser journey in an explicitly isolated test deployment with only mocked chain transports: Claude/ChatGPT-shaped MCP requests → `/approve` → wallet proof → automatic preparation → one Authorize action → mandatory wallet prompt → pending/finalized receipt → status read in the originating conversation. Repeat with optional Canvas, EN/PT and mobile/desktop widths, provider/account/chain switches, rejected signatures, expired reviews, altered transactions, disconnected saved wallets, uncertain submissions and page reloads. Cover every registered network's implemented operations using the matrix in the handoff report. The existing component browser suite is a narrower check and does not replace this journey.

Real client and extension interoperability requires a separate supervised browser session with the intended Claude/ChatGPT/MCP clients and Solflare/Phantom/EVM wallet versions. Verify their actual negotiated capabilities; do not assume extension access inside an MCP host or completion callbacks. Approval links and explicit status reads are the supported fallback. Mainnet read-only account/fee/simulation certification may be proposed separately; this plan authorizes no broadcast, fund movement, automatic signing or Mainnet expenditure.

Archive exact commands, commit, environment provenance, test reports, client/wallet versions and sanitized evidence. If these pass, request owner approval to push and open a PR containing the existing work plus continuation changes. Merge, deployment, production flags/database changes and any funded on-chain test remain separate approvals.
