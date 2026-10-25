# BUILD-FLOFI-MAINNET-PRODUCT-001: final release GO/NO-GO and production sequence

PR #118. Production facts below were read on 2026-10-24 between 22:15 and 23:00 UTC. All reads were read-only:
- Vercel and Railway deployment listings and worker logs;
- the public readiness endpoint;
- production MCP `get_capabilities`;
- unauthenticated GETs of the channel webhooks.

Nothing was merged, promoted, deployed, configured or signed, and no transaction was sent.

## 1. Verdict

| Decision | Verdict | Why |
|---|---|---|
| Merge PR #118 | **Conditional** | B1 is addressed by owner-authorized PR #119 (`fast-uri@3.1.9` + temporary exact release-age waiver). Merge #119 first when its CI is green, then this PR once rebased CI is green. |
| The code of PR #118 | **Ready for review** | CI ran every browser profile and all pass: CircleCI 45/45 profiles, 376 tests, none failed, skipped or flaky. Locally, unit, PostgreSQL, browser and every other gate pass. No known regression remains. |
| Production release | **Conditional GO** | GO once B1–B3 are cleared, following §4 step by step with the owner's approval at each production step. |
| Telling the public that real funds work | **Only after §5** | FloFi has never executed a mainnet operation (0 of 45 mainnet rows live-certified). The owner-run acceptance in §5 is the first real-funds evidence. |

## 2. Blockers

| # | Blocker | Owner of the action | Cleared when |
|---|---|---|---|
| **B1** | CircleCI Dependency audit on `main` fails on `fast-uri@3.1.8` (four GHSAs). **PR #119** pins official `fast-uri@3.1.9` and adds a temporary exact owner release-age waiver (Colosseum precedent). Audit/integrity/licence gates stay on; advisories are fixed, not suppressed. Remove the waive after **2026-10-26T23:05:26Z**. | Owner merges #119 | #119 CI is green (done locally/CI); owner merges it to `main`. |
| **B2** | Because the job stops at the audit, CI has **not yet run the unit and PostgreSQL suites** on this PR. They pass locally (§3). | Claude (rebase); CI | #118 is rebased on the merged fix, and CI's `certification-checks` passes through the audit, unit and PostgreSQL steps. |
| **B3** | Owner approval of each production step: merge, the web promotion, the worker deploy, and the owner-chosen §5 acceptance amounts (test budget only — not a product rule). | Owner | §4 |

`git merge-tree` confirms that the fix and #118 change no common file, so the rebase is conflict-free.

**Not blockers, but the owner must know them before release (pre-existing in production, not caused by #118):**
- **K1. Evidence archive failing in production (root cause confirmed 2026-10-24 ~23:45 UTC, read-only).**
  - `flofi-worker` still has 3 open `evidence.archive` items (`jupiter-afb4e4…`, `pub-4ba810e1…`, `pub-01a2ec0f…`), all `READY` with `EVIDENCE_STORE_READ_FAILED` (deliveries 56–160+); 0 `evidence.archived` successes in the available logs.
  - Store: Neon Object Storage (`*.storage.*.aws.neon.tech`), bucket `flofi-evidence`, region `us-east-2`, path-style (default). Endpoint/bucket/region are fine.
  - **Root cause:** on both `flofi-worker` and `flofi-api`, `OBJECT_STORE_ACCESS_KEY_ID` and `OBJECT_STORE_SECRET_ACCESS_KEY` are stored with literal surrounding `"` characters. Signed GETs then return **HTTP 403** / S3 `InvalidAccessKeyId`. The same keys with quotes stripped return **HTTP 404** / `NoSuchKey` for a missing object (the archive pre-check), and a probe PUT+GET with stripped keys returned **200** with a matching SHA-256. No production variable was changed.
  - **Correction (owner-approved and applied 2026-10-25):** re-set those two variables on **both** services to the same Neon key values **without** surrounding quotes. No credential rotation, no unrelated variables, no secrets printed or committed, no PR #118 product change.
  - **Railway side effect (confirmed before/after):** default `variable set` redeploys the service from its connected `main` branch. `flofi-api` stayed on `cbf340e`. `flofi-worker` moved from deployment `2f7aef24` (`78ea792`) to `9ddf9044` (`cbf340e`) — env reload plus catching the worker up to current `main` (still before #118). Not a Vercel promotion and not a merge of #118.
  - **Verified after the correction:**
    1. Missing object GET → **HTTP 404** `NoSuchKey`.
    2. Disposable PUT → **200**; GET → **200** with matching SHA-256.
    3. All three pending `evidence.archive` items are **DONE** with rows in `evidence_objects` (`store_id=s3`): `jupiter-afb4e4…`, `pub-4ba810e1…`, `pub-01a2ec0f…`. No new `EVIDENCE_STORE_READ_FAILED` after the worker came up on the fixed credentials (prior failures were backoff retries before the due time).
- **K2. In-flight workflow `wfr_w4xowbivml3ruqpa2ly4ndlndx` (rechecked live 2026-10-25; left unchanged).**
  - **Live state:** `RUNNING` / `CONFIRM_EACH_STEP` / `current_step` 1 of 2 / expires 2026-10-30T21:48:54Z / not expired. Base Sepolia only.
  - **Steps:** (0) `RECONCILED` — 2 txs on `eip155:84532`, evidence archived (`pub-4ba810e1…`); (1) `PENDING` — not claimed, no outcome, **0** transactions. No in-flight submit.
  - **Cancel capability vs UI:** `cancelRun()` / `cancelWorkflowRunHandoff` already allow `RUNNING` when no step is `AWAITING_OWNER` / `UNCERTAIN` / `DELEGATED`, with the owner's proven wallets. The public panel (`workflow-run-panel.tsx`) shows **End workflow** only for `HALTED`, so this run has **no accessible product UI path** today. No MCP/admin cancel; no SQL or agent cancel (wallet ownership must hold).
  - **Left unchanged** pending an owner decision on the proposed one-line UI exposure (below) or natural expiry.
  - **During Mainnet-only rollout (#118):** "Continue to step 2" is refused (`TEST_NETWORK_NOT_AVAILABLE`); nothing further is signed or submitted. Idle worker advances continue. At expiry the runner **HALTs** (`WORKFLOW_RUN_EXPIRED`) after step 0; **End workflow** then appears on today's UI. Step 0's txs and evidence stay either way.
  - **Proposed smallest UI fix (not applied):** show End workflow whenever cancel is legal — `PENDING`/`RUNNING`/`HALTED` and no in-flight step states — reusing `cancelWorkflowRunHandoff` (already wallet-gated). Web-only (Vercel); no API/worker/migration. Ship with #118 or a tiny follow-up; needs owner approval before coding.
  - Automations bound to test networks stop proposing and show "attention" after release — check those in the admin console before merging.
- **K3. The deployment state differs from the earlier assessment.** `flofi.xyz` was promoted to `cbf340e` on 2026-10-24 00:08:53 UTC (`dpl_BkHHTr3CdCeK8mfoarwE1RWDvrWw`). Arbitrum One and Ethereum `add_liquidity` (real funds, never executed) are therefore already reachable in production today.

## 3. Evidence for the verdict

**CI on PR #118** at `6c12ff3`, CircleCI workflow `9f7348d4`. That commit holds all product code. The release-review commit after it
changes only documentation, the out-of-CI specs (§7), their `testIgnore`, and the funds label of the matrix's sequence rows:
- `governance`: pass.
- `certification-checks`: **fail at Dependency audit only** (B1). Integrity, licence and release-age passed before it.
- `certification-browser-1`: pass. Critical tier 6/6 profiles (60 tests), then shard 1 19/19 profiles (205 tests).
- `certification-browser-2`: pass. Shard 2 20/20 profiles (111 tests).
- Vercel preview: pass.

**Local, on the same tree** (disposable loopback PostgreSQL; no public provider, wallet or chain):

| Gate | Result |
|---|---|
| Unit | 417 files, 4,862 tests passed; 2 existing harness-gated files skipped |
| PostgreSQL | 75 files, 474 tests passed; the existing certificate-gated `schema-compatibility` file skipped |
| Browser (all 45 CI profiles) | 45/45 PASS, 376 tests, none skipped, flaky or retried |
| Typecheck, lint, schema drift (11), governance-lite, 75 CI-script tests | pass |

**Production today** (what the release changes):

| Service | Serves | Deployment |
|---|---|---|
| Web `flofi.xyz` | `cbf340e` | `dpl_BkHHTr3CdCeK8mfoarwE1RWDvrWw` (Vercel; domain auto-assignment **off**) |
| API `flofi-api` | `cbf340e` | `c07a6934` (Railway; **auto-deploys every push to `main` without waiting for CI**) |
| Worker `flofi-worker` | `cbf340e` | `9ddf9044` (Railway; **manual deploys only**; caught up to `main` when K1 variables were corrected) |
| Telegram webhook | enabled and configured (an unauthenticated `GET` returns 405) | — |
| WhatsApp webhook | off (404) | — |
| Multi-step workflow runs | enabled (the worker processes `workflow-run.advance`) | — |

**Production mainnet capabilities that the release must preserve** (MCP `get_capabilities`, read-only):
- 39 real-funds rows are enabled by the deployment. **38** can be handed off from chat (MCP/Telegram); Orca Solana `add_liquidity` is Canvas-only by policy (`AGENT_ROLLOUT_NOT_APPROVED`).
- Code support for all 39 is unchanged in #118 (capability matrix, 40 implemented mainnet rows; the 40th is Orca Solana `remove_liquidity`, Canvas-only).
- After release, the same read must show these 39 rows and **no** test-funds row.

| Action | Mainnet rows |
|---|---|
| Swap | Base, Arbitrum One, Ethereum, Solana (Jupiter), Robinhood Chain |
| Bridge (12 directions) | Both ways between every pair of Base, Arbitrum One, Ethereum and Robinhood Chain |
| Transfer | Base, Arbitrum One, Ethereum, Solana, Robinhood Chain |
| Lending: supply, borrow, repay, withdraw (Aave) | Base, Arbitrum One, Ethereum |
| Add liquidity | Base, Arbitrum One, Ethereum, Robinhood Chain (Uniswap); Solana (Orca, Canvas-only) |

**Not executable, documented instead of claimed:**
- **Removing liquidity on EVM networks.** Positions added on Base, Arbitrum One, Ethereum or Robinhood Chain are closed in Uniswap's own interface, not in FloFi. Orca Solana removal is Canvas-only.
- **Bridges between an EVM network and Solana.**
- **Multi-step amount binding.** A later step cannot spend what an earlier step delivered; each step has a fixed amount.
- **Delegated execution.**
- **WhatsApp.**
- **Developer API creation.** The Developer API issues sandbox, test-funds-only keys, so it can discover but not create.
- **Chat-side simulation of transfers and Orca liquidity.** MCP cannot simulate them (`SIMULATION_REQUIRES_OWNER_BROWSER`); they are simulated on `/approve`.

## 4. Production release sequence

Each production step (marked **owner**) is approved and performed by the owner. Claude performs only repository steps and read-only
checks.

**Phase 0: before the merge (now → 2026-10-26)**
1. **Owner:** review PR #118 (the diff, the [build report](BUILD-FLOFI-MAINNET-PRODUCT-001-REPORT.md) and this document).
2. **Owner:** choose the §5 acceptance-test amounts manually (examples in §5). These never become product-wide amount caps.
3. **Owner:** fix K1 (re-set the two `OBJECT_STORE_*` credential variables on worker and API without surrounding quotes) or accept missing object-store archives for the release. Verification steps are under K1 above.
4. **Owner:** decide K2 for `wfr_w4xowbivml3ruqpa2ly4ndlndx`: sign Base Sepolia step 1 before merge, cancel (safe: nothing in flight), or leave until expiry / post-release HALT; also check test-network automations.

**Phase 1: dependency fix (after 2026-10-26 23:05:26 UTC)**
5. **Claude:**
   - local branch `codex/security-fast-uri-3.1.9` at `87446fa` is ready (not yet on origin; no PR). After the policy clears:
   - regenerate the lockfile with plain `pnpm install --lockfile-only`; it must be byte-identical to `87446fa`;
   - run a frozen install and the full gates;
   - push and open the PR.
6. **Owner:** merge it once CI is green. Effects:
   - `flofi-api` auto-deploys (a dependency patch only);
   - Vercel builds `main` but does not promote it.

**Phase 2: PR #118**
7. **Claude:** rebase #118 on the new `main`, run the local gates again, and force-push the PR branch. CI must then be fully green:
   - `governance`;
   - `certification-checks`, including the audit, unit and PostgreSQL steps;
   - both browser jobs;
   - the Vercel preview.
8. **Owner (optional, no signing):** open the Vercel preview, which is hosted and therefore Mainnet-only. Check that there is no network selector, that the pickers show mainnets only, and that both wallets connect.
9. **Owner:** merge #118 at the start of a release window, with about 20 minutes free. From that moment:
   - `flofi-api` auto-deploys and starts refusing new test-network operations;
   - the still-promoted `cbf340e` web build still shows test-network UI, whose new operations fail closed.
   - Keep the gap until step 11 short.

**Phase 3: coordinated production release (one window)**
10. **Read-only check:** the `flofi-api` deployment for the merge commit is `SUCCESS`, and `/readyz` returns `{"ok":true}`.
11. **Owner:** once the Vercel production build of the merge commit is Ready, run `vercel promote <dpl id>`. Then confirm that `https://flofi.xyz/api/flofi/readiness` reports `deployment.commit` = the merge commit.
12. **Owner:** in the Railway dashboard, deploy the merge commit to `flofi-worker` (it has no automatic trigger). This applies the automation and workflow-run refusals inside the worker too. The API already refuses at handoff.
13. **Read-only checks after the deploy:**
    - MCP `get_supported_networks` lists only Base, Arbitrum One, Ethereum, Solana and Robinhood Chain.
    - `get_capabilities` shows the 39 real-funds rows of §3 and no test-funds row.
    - The Telegram webhook still answers 405 to a GET.
    - The worker logs show `workflow-run.advance` ok and no new error code.

**Phase 4:** the owner-run acceptance in §5, then the owner's public GO.

## 5. Production acceptance checklist (owner-run, real wallets, real funds)

**Owner acceptance-test budget (manual; not a product restriction):**
The public product has **no** artificial transaction amount caps. End users choose their own amounts on every surface (Canvas, Chat, MCP, Telegram, APIs). Only blockchain/protocol constraints, balances, gas, liquidity, user slippage and wallet authorization apply. The figures below are only what the owner plans to spend while certifying §5; they must never be implemented as fixed USD caps, demo limits or silent amount truncation.

- Suggested first-batch test spend: about **US$5 equivalent** per operation, about **US$75** total including fees (owner may choose differently each time).
- **Ethereum L1** excluded from the first certification batch unless the owner separately approves gas for it.
- Use dedicated wallets. Every transaction needs the owner's explicit approval in the reviewed wallet flow.

No CI, agent or automation signs.

**A. Wallet connection and reconnection**

1. **MetaMask:**
   - first connect, connect while locked, unlock;
   - a second click while a request is pending (-32002) shows the plain explanation, not a code;
   - switch accounts and networks across Base, Arbitrum One, Ethereum and Robinhood Chain;
   - reload; explicit Disconnect stays disconnected after a reload;
   - `/approve` asks for sign-in once.
2. **Phantom (mainnet-beta):**
   - lock and unlock, then reconnect silently without being recorded as a FloFi Disconnect;
   - switch to an unconnected account and back;
   - Connected Apps → Disconnect;
   - reload;
   - check whether a Solana disconnect also disconnects Phantom's EVM side.
3. **Both installed:**
   - MetaMask with Phantom, including Phantom's "default wallet" setting;
   - Rabby;
   - MetaMask's own Solana support;
   - the EVM and Solana sessions stay independent.
4. **Mobile:** `/approve` inside the MetaMask and Phantom in-app browsers.

**B. Mainnet-only network and token selection**

5. The header has no network selector.
6. Canvas network pickers list only Base, Arbitrum One, Ethereum, Solana and Robinhood Chain. Token pickers list only mainnet tokens of the chosen network.
7. With a wallet on Sepolia, FloFi offers "Switch to <mainnet>" and never switches to a test network itself. Phantom is always used on mainnet-beta.
8. Chat (web Copilot, MCP, Telegram): "swap 5 USDC on Base Sepolia" is refused with an explanation and is **not** moved to Base.
9. A saved test-network workflow opens unchanged with "Rebuild on <mainnet>". An old test-network `/approve` link explains that nothing was loaded.
10. Review states that real funds leave the wallet and that the wallet pays the network fee.

**C. Conversational workflows without the Canvas**

11. **ChatGPT or Claude (MCP):**
    - compose a Base swap, validate it and simulate it;
    - `request_user_approval`;
    - open the `/approve` link and review;
    - sign in the wallet;
    - `get_execution_status` reaches a final state;
    - `get_evidence` returns the run.
12. **Telegram:** the same journey for a single step. Then do the D4 lending sequence as one multi-step workflow: one approval, then each step confirmed in the wallet in order, each after the previous one reconciled. Amounts are fixed per step: binding a step to an earlier step's output is not implemented.
13. **Orca Solana liquidity** is refused for chat handoff (Canvas-only by policy). Confirm that the refusal is plain.

**D. Real execution** (within the limits; one execution per engine; Base for EVM unless stated)

| # | Engine | Suggested execution |
|---|---|---|
| D1 | EVM swap (Uniswap) | Base: swap 5 USDC → ETH |
| D2 | Solana swap (Jupiter) | Swap 0.02 SOL → USDC |
| D3 | Bridge (router) | Base → Arbitrum One, 5 USDC. Arrival is reconciled on the destination chain. |
| D4 | Lending (Aave) | Base: supply 5 USDC → borrow 1 USDC → repay → withdraw, as one multi-step run or four single runs |
| D5 | EVM liquidity (Uniswap) | Base: a small position. Close it in Uniswap's interface: FloFi does not remove EVM liquidity. |
| D6 | Solana liquidity (Orca) | Canvas: add, then remove, a small position |
| D7 | Transfers | Base USDC and SOL to a second account of the owner |
| D8 | Optional | Arbitrum One and Robinhood Chain swaps; Ethereum only with the separate gas budget |

**E. Authorization, reconciliation and evidence** (for every D row)

14. The wallet prompt matches Review: chain, contract, amount and recipient. A changed or stale Review cannot be signed.
15. The transaction hash is recorded, and reconciliation reaches a final state with no manual step. Closing the tab and reopening it recovers the run.
16. The run's Evidence Bundle opens and names the on-chain transaction. Once K1 is fixed, an `evidence.archived` line appears in the worker logs.
17. Afterwards, Claude adds the executions to the execution ledger in a documentation-only PR. The read-only verifier (`scripts/verify-live-evidence.mjs`) and the matrix test then move exactly those rows to `LIVE_CERTIFIED`.

**F. Rollback drill and triggers**

18. Know the commands before the window (§6).
19. **Roll back on any of:**
    - a wallet that can no longer connect or reconnect;
    - a mainnet operation of §3 refused;
    - any test-network operation accepted;
    - a wallet prompt that differs from Review;
    - a run that does not reconcile.

## 6. Rollback

| Service | Rollback | Time |
|---|---|---|
| Web | `vercel promote dpl_BkHHTr3CdCeK8mfoarwE1RWDvrWw` (today's `cbf340e` production deployment). This is an alias swap. | about 1 minute |
| API | Railway → `flofi-api` → deployment `c07a6934` (`cbf340e`) → Rollback. Alternative: revert the merge commit on `main`, which auto-deploys the API (and Vercel builds a production deployment that must be promoted). | a few minutes |
| Worker | Railway → `flofi-worker` → previous success before the K1 redeploy was `2f7aef24` (`78ea792`); current is `9ddf9044` (`cbf340e`). Rollback only if needed. After #118, prefer keeping the merge-commit worker (refusals only). | a few minutes |

- **No data to unwind:** #118 has no migration and changes no stored shape.
- Mainnet runs created after the release remain valid, readable and reconcilable on `cbf340e`.
- Rolling back re-exposes the Testnet/Mainnet selector and test-network operations: that is today's production state.
- Never change `FLOFI_NETWORK_SCOPE` in production as a "fix": every hosted deployment ignores it by design.

## 7. Browser specs outside CI that used the removed selector

None of these 16 files is in a CI profile.
- **Baseline against `main` `cbf340e`:** the PR caused exactly 17 failures, each at a line that used the removed selector, and nothing
  else.
- **Updated (9 specs):** every test that passes on `main` passes here. The remaining 22 fail exactly as they do on `main` (pre-existing,
  unrelated).
- **Retired (7 specs):** kept in Git and excluded by `testIgnore`.

Details are in §8 of the [build report](BUILD-FLOFI-MAINNET-PRODUCT-001-REPORT.md#8-owner-decisions-surfaced-by-this-build).
