# BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001

Branch `claude/serene-cannon-inz1zd`. Base `52b87cf` (PR #251 merge, verified against fetched `origin/main`).

**Status: corrective hotfix for CTO approval.** Nothing is merged, deployed or configured. No real funds and no production credentials were used.
Production was inspected read-only (logs and deployment metadata only, §1.4). Every incident is either fixed with a regression test, or listed
in §2 and §6 as not reproduced, with what is missing. Scope was frozen on 2026-11-25 by the owner (emergency hotfix, no new workstreams).

### 0. CTO decisions of 2026-11-25 and how they are applied

| Decision | Implementation | Commit |
| --- | --- | --- |
| Manual slippage: default 1%, maximum 5% for supported Swap and Bridge profiles, respecting protocol restrictions | 1% authoring default (unchanged policy), Uniswap direct-swap profile default 0.5% → 1%. 5%: direct Uniswap swaps (Base, Arbitrum One, Ethereum, Robinhood Chain), Jupiter, Orca Devnet swap, mainnet Cross-chain Router, universal router. Kept at 3% (protocol/runtime restrictions): testnet Router, Solana compositions, batched groups (they fall back to per-step), liquidity, legacy direct Across and BUILD-009 LI.FI. Authoring, linter, compiler, runtime and Review use the same limits | `8739626` |
| Auto slippage from trusted route information | Jupiter RTSE (`slippageBps=rtse`, a documented value of `/swap/v2/build`), accepted only when the decoded swap instruction carries the same value, 1–3%. Relay: an executable quote's `details.slippageTolerance.total` (documented, bps), ≤ 5%. Auto writes the concrete number into the draft (never a stored "auto" mode) and expires with its quote (30 s / quote expiry). No trusted signal exists for Uniswap direct swaps, the Router's LI.FI/Across routes or Mayan: those offer Manual only | `8739626` |
| Warn above 3% | Form and Review warning "Above 3%, the price can move substantially against you…" (PT/EN). The linter's ELEVATED_SLIPPAGE starts above 3% (`ELEVATED_SLIPPAGE_WARNING_BPS`), so 1–3% never marks a card "Needs attention" | `8739626` |
| Restore the approved Execute UX (#232) | No Execute redesign. Execute keeps one primary action in its footer slot (the approved "Autorizar fluxo" layout): a step that needs another wallet shows that wallet action in the same slot instead of #251's extra secondary button beside it | `907d86c` |
| Keep #251's contextual wallet connection | "Connect an EVM/Solana wallet" still opens the wallet choice for the step's ecosystem; Build and Simulate keep #251's layout. The FloFi Wallet bridge guard (§2, #9) reuses the existing "Use another wallet" state | `907d86c` |
| No mandatory Canvas navigation or unnecessary confirmations | A chat change that would remove steps is applied or discarded in the chat ("Apply it" / "Discard it"), bound to that exact proposal; it no longer requires opening the Canvas | `3f40bf2` |

USD equivalents (brief §8, requested by the CTO): amount cards without a token-to-token quote show a USD estimate from the verified Chainlink source
(ETH/WETH, SOL, issuer-canonical USDC/USDT only), and bridge quotes value both sides; PT formatting (`US$ 1.234,03`); stale or slow prices show
"USD price unavailable" (`c1a268e`).

## 1. Forensic audit

### 1.1 Access actually available

| Source the brief asks for | Available in this session | Consequence |
| --- | --- | --- |
| Git history, PRs #248–#251 | Yes (local history, GitHub API) | Audited below |
| Vercel and Railway deployed revisions and logs | **Yes, read-only** (this session: Vercel and Railway connectors) | §1.4. Vercel function logs keep 1 h (Hobby plan): chat, server actions, batch reports and Google linking of 11:00–12:20 local are gone; CDN request records (24 h) and Railway API/worker logs remain |
| Sanitized execution records, provider responses | **No** (the production database was not queried) | Run ids are listed in §1.4 for the owner's read-only lookup |
| Jira | **Not updated** (the Atlassian connector needs the owner's browser authorization; parked by the owner) | Jira text in §8 |
| CircleCI | Through the PR's checks | §4 |

Root causes are stated as **reproduced in code** (with a failing test on `main`), **observed in production logs**, or **inferred from the code
path**. Only incident 9 is tied to production evidence; none is tied to the tester's wallet, which appears in no retained log.

### 1.4 Production evidence (read-only, 2026-11-25)

- **Timezone: UTC-3.** 11:00–12:20 UTC had almost no product traffic (the API had none). 14:00–15:20 UTC had 6,578 Vercel requests (4,586 from
  Brazil), 3,904 API and 1,361 worker log lines.
- **Revision during the incidents: `52b87cf` (PR #251, this branch's base) on Vercel, flofi-api and flofi-worker** (Vercel alias moved at
  13:59:09 UTC; Railway from ~13:36 UTC). It still serves now.
- The tester wallet `0x11F4…7A3` appears in no retained log (logs carry no wallets). Every link below to an incident is inferred from timing,
  route and session (country + user agent).
- **Bridges (incident 9), observed:** five bridge runs (`xroute-480a…` Ethereum→Arbitrum 15:00:36, `xuni-0547…` 15:08:37 after Base→Robinhood
  discovery, `xuni-8706…` 15:11:14 and `xuni-b2c5…` 15:11:24 after Base→Arbitrum discovery, `xroute-8035…` Ethereum→Base 15:12:59 UTC) each hit
  `walletFailure` ~1 s after hand-off, right after a FloFi Wallet (managed EVM) pending-nonce read, with no `report` afterwards (most likely
  nothing was submitted). Relay was EXECUTABLE on every pair. Code: the Router and universal-router stores never bind a FloFi Wallet signing
  context and `SIGNING_FLOWS` has no bridge flow, so FloFi Wallet refuses with `FLOFI_WALLET_FLOW_NOT_SUPPORTED`.
- **Swaps (incidents 2/8), observed but not attributable:** Jupiter simulate refused `JUPITER_SETUP_UNEXPECTED` (14:36:56, 14:42:40) and preview
  refused `JUPITER_LOOKUP_TABLE_INVALID` (14:44:56, 14:51:35); two Base swaps refused `INSUFFICIENT_INPUT` (14:42:15, 14:43:35); one
  `QUOTE_EXPIRED_REVIEW_REQUIRED` then succeeded. No provider name or transaction hash is logged.
- **Batch refusal (incident 6):** the wallet's refusal code is stored only in the run record, not in logs. Candidates still waiting at 21:05 UTC
  in OWNER_SIGNS_GROUP: `wfr_zsdjflayy237bil2jeapuu4tfl` (14:25:36), `wfr_dnp6b6xoq7mnpscxwkndp3o7it` (14:32:14).
- **Google linking (incident 7):** sign-in-methods GET+POST → 307 to `/login` → onboarding wallets (14:45–14:46 UTC); 13× `BETA_WALLET_NOT_LINKED`
  (403) on `/v1/workflows/list` between 14:35 and 14:52 UTC. No server error.
- **MCP:** every `/api/mcp` request of the day was 401 (no authenticated tool call reached production).
- Not in the report, recorded for the owner: `work.claim_failed: deadlock detected` ×3 (worker, 15:01–15:03 UTC); bridges still awaiting
  delivery at 21:00 UTC (`wfr_vdodf36skf6ixk63dx6rzohadt` since 14:12, `wfr_2jcodncsj646l7fltxid22izcl` since 14:04,
  `xuni-752c…` `UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE` since 14:56); nonce conflicts on `xuni-3794…` and `xroute-a096…` 18:53–20:57 UTC.
  None was changed; observe with `reconcile-history` without `--apply`.
- **Owner's read-only follow-up:** a SELECT on `execution_runs` / `workflow_runs` for the ids above gives the owner wallet and the stored
  `walletFailure` diagnostic (the batch refusal code). Relay deprecated `/quote/v2` on 2026-11-25 (retirement 2027-02-23): migration to
  `/quote/v3` is a separate item.

### 1.2 PRs #248–#251

| PR | Build | Execute / Workspace presentation changes |
| --- | --- | --- |
| #248 | UNIVERSAL-CHANNELS-001 | None (channels, MCP account tools) |
| #249 | BETA-UX-INTELLIGENCE-001 | Header: "Setting up your wallet…" state and a **copy button** beside the wallet address (WS01/WS02, an owner brief; merged by the owner) |
| #250 | MAINNET-BRIDGE-RECONCILIATION-003 | None visible (Relay binding, Live Quote latency) |
| #251 | MULTICHAIN-WALLET-RESOLUTION-001 | Only in multichain / missing-step-wallet states: a secondary "Connect an EVM/Solana wallet" beside the stage CTA (`stepWalletAction`), an in-chat "Connect a Solana wallet" action for a bridge destination, no "Switch to <network>" CTA before Review for universal/catalog EVM steps, and mixed EVM+Solana workflows use the per-step path instead of the grouped "Authorize workflow" |

### 1.3 Execute UX against the approved baseline

The last explicitly approved Execute baseline is the owner's UX guidelines of 21-11-2026, merged in PR #232 (`1dae170`, evidence in
`apps/reference-dapp/e2e/visual-evidence/ux-guidelines-21-11-2026/`). The same evidence spec (`e2e/ux-refinement-evidence.spec.ts`, PT, 1815×866 and 390 px,
MOCKED loopback) was rendered on this branch.

![Approved 21-11 Execute (top) and this branch (bottom), same scenario](assets/beta-critical-recovery-001/execute-valid-approved-vs-branch.jpg)

Result: header row, stepper, Canvas, the "Confira sua operação" Review panel, its rows, "Detalhes técnicos", the footer and "Autorizar fluxo" match the
approved render on desktop and mobile. The only visible delta is #249's header copy icon, which came from an owner brief.
More captures: `branch-execute-valid.jpg`, `branch-execute-expired.jpg`, `branch-execute-valid-mobile.jpg`, `branch-simulate-result.jpg`.

**No Execute visual change was made in this build**, and no screenshot baseline was regenerated. The #251 additions in multichain states have **no approved
reference**. Per the brief, they were not redesigned. **CTO decision requested**: keep #251's contextual wallet actions (they serve §5 of the brief, "a
simple, contextual way to prove and associate their wallets") or specify the presentation for those states.

## 2. Incidents and corrections

| # | Incident | Root cause | Component | Introducing change | Correction | Regression evidence | Real-user acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | "Levar 1 USDC da Ethereum para a Base e emprestar na Aave." asks for an amount | A raw COMPOSITION plans each step on its own. A Supply with no amount after a same-asset bridge is asked for its amount. Only the GOAL planner marked it funded | `domain/copilot-conversation.ts` `authorSequence` | Pre-existing (not #251) | `bindDependentSteps`: the Supply is funded by the bridge, and its cap is the user's own 1 USDC. The runtime binds min(cap, reconciled delivery) | `beta-critical-recovery.test.ts` (2 cases, fail on `main`): proposal plus `fundedBy: 0` on Base USDC | **Not run** (needs owner wallet) |
| 2 | "Quero trocar Solana por USDC na Solana" then "0.001" refused | "Solana" in a coin position was not read as SOL (the rule existed only for "ethereum"). The interpreter's `Solana` was refused ("Swaps na Solana aceitam SOL…"), and its `SOL` was not grounded ("não encontrou o token SOL") | `domain/copilot-authoring.ts` | Pre-existing | `SOLANA_AS_COIN` mirrors `ETHEREUM_AS_COIN`. One word never grounds both asset and network. The follow-up amount is kept exactly (0.001) | 4 cases fail on `main`, pass here (PT, EN, three spellings) | **Not run** |
| 2b | Same sentence through ChatGPT/Claude MCP | Strategy engine looked up `Solana`/`sol` verbatim (`SOLANA_MINT_UNSUPPORTED`). A universal asset named "Solana" could resolve by display name to a verified SPL token | `engine/strategy-engine.ts`, `domain/universal-bridge-authoring.ts` | Pre-existing | Native coin name → native SOL. Symbols are normalized to the runtime keys | `strategy-engine.test.ts` (4 cases) | **Not run** |
| 3 | "Converta todo o USDC que tenho em ETH." | Relative amounts had no path: FloFi asked "o valor, a rede" with no options | Conversation engine + balance shortcuts | Pre-existing (feature gap) | `relative-amount.ts` reads ALL/half/N% deterministically. Network and token are asked first. The structured amount question carries `relative`, and the existing consented balance shortcut answers it once from a fresh read (native fee reserve, rounded down, nothing for a zero balance) | `beta-critical-recovery.test.ts` (fails on `main`), `relative-amount.test.ts` (19 cases) | **Not run** |
| 4 | "Troque 1 USDC por ETH e depois troque o ETH recebido por USDC." refused | A composition naming no network fell into the legacy test-network Supply→Borrow→Swap composition → "não conseguiu construir esta sequência" | `copilot-conversation.ts` | Pre-existing | In the public product such a request goes to sequence authoring: it asks the network, then the cap of the dependent swap (`dependentCap`, PT/EN). The second swap is funded by the first (`fundedBy: 0`) | Fails on `main`, passes here | **Not run** |
| 5 | Raw `ROUTER_SLIPPAGE_OUT_OF_RANGE` shown | Router and universal bridge forms put the thrown code into their alert | `components/router-panel.tsx`, `universal-bridge-panel.tsx`, `jupiter-panel.tsx` | Pre-existing | `slippageRangeMessage`: the action's actual range in the approved, translated wording (now "from 0.01% to 5%" on mainnet, 3% on the testnet Router). The chat's Router rejection names both ranges | `slippage-range-message.test.ts`, `router-authoring.test.ts` | **Not run** |
| 6 | Wallet refused the batch | A batch refused **before sending** only offered "try again", which repeats the same refused batch. The earlier client-only fallback was reverted (duplicate-spend risk) | `workflow-runs/service.ts`, `user-funded/decline-proof.ts` | Pre-existing | **Server-proven fallback:** the originating browser reports the exact refused preparation; the server holds the group, and only after its validity + settle margin proves on chain (safe head, preparation block hash still canonical, nonce and logs unchanged) that nothing executed, then moves the same run's current group to per-step owner confirmations in one locked transition (earlier steps must be reconciled). 5750 (owner declined the upgrade) stays the owner's decision. Nothing is retried or signed automatically | `user-funded-due-refusal.pg.test.ts`, `decline-proof.test.ts`, `editor-workflow-run.wallet-batch.test.ts`, `editor-single-card.spec.ts` (atomicity refusal → reload → chain check) | **Not run**. The production refusal code is in the run record only (§1.4) |
| 7 | Google could not be linked to a wallet account | Two dead ends: an account without a Privy link was offered no way to add a method. Google already opening another (empty, Google-first) account ended on "Nothing was linked, merged or moved" | `components/account/sign-in-methods.tsx` | Pre-existing | "Confirm it's you" (Privy sign-in with a method the account holds, which creates the link), and the existing checked path to bring an empty account's sign-in here. No ownership or merge logic changed | `sign-in-methods.test.tsx` | **Not run**. The production account state is unknown |
| 8 | "Failed swap" (unspecified) | **Not established.** Production shows Jupiter verifier refusals (`JUPITER_SETUP_UNEXPECTED`: a setup instruction outside the owner-bound allowlist, e.g. a Token-2022 account; `JUPITER_LOOKUP_TABLE_INVALID`: more than 4 lookup tables) and Base `INSUFFICIENT_INPUT`; none is attributable without the run record and Jupiter's response | `reference-compiler/src/jupiter.ts:96-160` | — | No verifier bound was loosened without the response that tripped it. An on-chain Jupiter/Devnet revert is now shown as such ("The swap failed on chain. Only the network fee was charged.") instead of a generic refusal | `simulation-presentation.test.ts` | Open (needs the run record) |
| 9 | Bridges Base→Robinhood, Base→Arbitrum, Ethereum→Arbitrum, Ethereum→Base→Aave | **Observed in production (§1.4):** FloFi Wallet cannot sign Router or universal bridges (`SIGNING_FLOWS`), and the person learned it only at the wallet request, after Simulate and Review. Ethereum→Base→Aave authoring was also broken by incident 1 | `components/app-shell.tsx`, `domain/flofi-wallet-bridge.ts` | Pre-existing (FloFi Wallet scope) | Before Simulate, a bridge on its own flow with FloFi Wallet as the signer shows the existing "this wallet cannot authorize it" state, in the chat too: "FloFi Wallet can’t sign bridges yet. Use MetaMask or another EVM wallet for this bridge." with "Use another wallet". Grouped runs (Circle-paid groups are FloFi Wallet-signable) and running bridges are untouched. **FloFi Wallet signing for bridges is not added** (new signing surface: CTO decision) | `flofi-wallet-bridge.test.ts` (9 cases) | **Not run** |
| 10 | "Base" hard-coded in unrelated messages | **Inferred:** `RouterForm` fell back to the environment's Base → Arbitrum pair and its labels when an existing card's draft networks were not a certified pair (bridge review). Production hint: `crosschain-router-ethereum-to-base/info` ×121 | `components/router-panel.tsx`, `state/router-store.tsx` | Pre-existing | An existing card never falls back to another pair or its labels; an uncertified draft pair blocks Review with "Choose matching networks" in every layout; a recovered record with an unknown pair keeps no network | `router-panel.test.tsx`, `router-store.test.tsx` | Needs the exact message from the report to confirm |

## 3. Safety properties kept

- No authorization or execution without the owner's wallet. Auto slippage, the relative amount and the in-chat proposal answer only write a
  draft value or apply an authoring change, before Simulate and Review.
- Slippage: every limit is an exact integer in the canonical node and the Review; Auto never stores a mode and never exceeds the protocol's
  limit; batches and compositions keep 3% (a wider step runs per step instead).
- Batch fallback: no client-only path. A browser report alone changes nothing financial; the switch to per-step needs independent chain
  evidence after the batch can no longer execute, and all earlier steps reconciled. A late wallet answer is handled as "answered after stop".
- Dependent steps never count funds twice; a bridge funds the next step only from its validated command (asset, network) and never when it
  has another recipient.
- The FloFi Wallet guard only refuses earlier (fail-closed); it never hides a running execution.
- No schema validation was weakened beyond the CTO's slippage decision. No migration, environment variable or automatic retry was added.

## 4. Validation (local, MOCKED / loopback; not certification)

Pinned toolchain: Node 24.21.0, pnpm 11.22.0. PostgreSQL suites on a disposable PostgreSQL 18.6 (same version as CI) on loopback.

- **`pnpm check`** on `3f40bf2` (typecheck, lint, build, schema drift, unit tests): **passed**. 790 files, 10,264 tests passed, 2 skipped
  (pre-existing skips). On the final tree (`7f64de5` + this ledger) the unit suite passed again: 790 files, 10,265 tests, 2 skipped.
- PostgreSQL suites of the changed paths: `user-funded-due-refusal.pg` and `user-funded-run.pg` (19 tests, final tree), `developer/engine.pg`.
  All passed. The full PostgreSQL stage runs in CircleCI.
- `python3 scripts/governance_lite.py` PASS (3,656 files); its unittest suite 21/21; `agent_guard.py check` PASS.
- Browser specs changed or added (`contextual-proposals`, `editor-single-card` atomicity refusal, `workflow-ux-execution` slippage choices,
  `release-financial-provenance` Jupiter Auto, `swap-authoring`): **not run locally**; they run in CircleCI's browser profiles.
- Tests that were changed because a CTO decision changed the expected behaviour (not to make CI green): 2% examples that expected the old
  "elevated slippage" warning now use 4% (`editor-overview.test.ts`, `build-correction.test.tsx`); 3.01% limits that expected a refusal now
  use 5.01% (`solana-swap.test.ts`, swap/router/Jupiter authoring tests).

**Specialist reviews (read-only):**

| Specialist | Scope | Result | Disposition |
| --- | --- | --- | --- |
| flofi-security | `8739626`, `954dbf8`, `c1a268e`, `907d86c` | 4 findings, highest medium. No path found by which a forged, replayed or late report, a second tab or a lying wallet reaches per-step while the batch can land (assuming an honest RPC) | Fixed: proof throttle (M1), refused batch kept as evidence (L2). Recorded: a late batch answer after the fallback is refused and recorded but does not halt the owner steps (L3; each step still needs its own Review and signature); an unprovable proof (incoming spam transfer, > 20,000 blocks, no `safe` tag) leaves only "End" (L4, fails closed) |
| flofi-wallet-execution | `954dbf8`, `907d86c`, Auto slippage | 6 findings, highest medium. Anchored proof, locking, older builds, 5750, cross-tab ownership and reload found sound | Fixed: later bridge in a step-by-step workflow (M1, partly: grouped runs paying fees in ETH are not covered), proof throttle (L3). Recorded: liveness of an unprovable fallback (M2, fail-closed); `OWNER_DECIDES` on a RUNNING run for MCP/channel renderers (L4); wording (L5); other flows FloFi Wallet cannot sign (supply, liquidity) still fail at the wallet (L6) |
| flofi-swap | `8739626` | 4 findings, highest medium. Minimum-output math at 5%, Auto trust and catalog/runtime/linter consistency found sound | Fixed: Solana groups and batched Router bridges keep 3% (M1), stale comment. Recorded: Jupiter verifier bounds (M2, §2 #8, no blind loosening); forms show 5% where a composed/CoW/fork step is capped at 3% (L3, fails closed); wording (L4) |

The specialists reviewed the commits before `7f64de5` (the fixes above); `agent_guard.py review` therefore reports them as not covering the
final HEAD. flofi-chat, flofi-workflow, flofi-mcp, flofi-frontend-ux, flofi-bridge, flofi-security and flofi-wallet-execution reviewed the
earlier commits of this branch in the previous session (below). Other selected specialists were not run: the owner froze the scope to
the hotfix on 2026-11-25.

**Earlier commits of this branch (previous session, up to `0c6d546`):** flofi-security (5 findings, highest high) and flofi-wallet-execution
(6, highest high) found the duplicate-spend risk of the client-only step-by-step offer → reverted (replaced by `954dbf8`); "50% of my USDC"
read as 5% and over-broad "all" readings → fixed. flofi-chat (13, highest high) and flofi-workflow (4, highest high): a step described as
"funded by the previous step" was never checked against the runtime's funding → every such step must carry the runtime's `fundedBy`, or
FloFi refuses (`dependentUnfunded`). flofi-mcp (3, low): Solana mainnet aliases canonical in published strategies. flofi-frontend-ux (6,
medium): the relative amount became one highlighted button with its exact figure; shortfall copy names the reason. flofi-bridge (3, medium):
the Router "Base" fallback (fixed in `907d86c`) and a Robinhood USDG delivery refused by the funding check (fixed in `907d86c`). Suites then:
domain and state 193 files / 2,992 tests; Copilot, router and universal bridge 23 files / 787 tests; `ux-refinement-evidence.spec.ts`
(Execute visual baseline of #232) passed.

Real-user acceptance (hosted wallets, ChatGPT, Claude, Telegram journeys): **not performed.** Loopback mocks are not acceptance.

## 5. Incident recovery, release and rollback

**Incident recovery (read-only, owner):** for each run in §1.4, read its record (owner wallet, stored `walletFailure`, attempts). Use
`reconcile-history` **without** `--apply` to observe bridges still awaiting delivery. A bridge already submitted is observed and reconciled,
never resubmitted. Any `--apply` needs separate CTO authorization.

**Release plan (after CTO approval):** one SHA to all three services. Vercel (UI, chat, Build estimate, wallet flows) **and** Railway
`flofi-api` / `flofi-worker` (the workflow-run service, decline proof and the preview `SLIPPAGE` purpose run server-side). No migration and
no environment variable change. Deploy the API and worker first (old web clients never send the new report or purpose), then promote Vercel.
Then the owner's journeys with their own wallet: the four NL requests, a Router and a universal bridge with MetaMask and with FloFi Wallet
(expect the early guidance), a refused batch → wait → "Confirm the batch steps separately", Manual 2.5%/5% and Auto on a Jupiter swap and a
Relay bridge, a Google link on a wallet-first account.

**Rollback:** redeploy the previous deployments (`52b87cf`) on Vercel and Railway. No data or schema change needs reverting; runs recorded
with `WALLET_BATCH_REFUSAL_RECORDED` stay held (fail-closed) on the old code until resumed or expired.

## 6. Not done in this build (honest scope)

| Item | Status | Reason / next step |
| --- | --- | --- |
| Incident 8 "failed swap" | Not established | Needs the run record and Jupiter's response; verifier bounds were not loosened blind (§1.4) |
| Incident 10 "Base" message | Candidate fixed | Needs the exact message to confirm |
| FloFi Wallet signing for bridges | Not added | New signing surface (server re-derivation of Router/Relay transactions): CTO decision. Bridges now say early that another wallet is needed |
| Relative amount ("todo o USDC") | Kept as one in-chat button with the exact figure | Auto-sending was reverted after chat, security and frontend-ux review (duplicate send with two panels, no provenance). One click, no extra dialog; Simulate and Review still follow. CTO may ask for auto-apply |
| Auto slippage for Uniswap direct swaps, the Router's LI.FI/Across routes, Mayan | Not offered | No trusted per-route signal; Manual 1–5% |
| Relay `/quote/v2` → `/quote/v3` | Not migrated | Deprecated 2026-11-25, retires 2027-02-23 |
| Specialist reviews beyond security, wallet-execution and swap | Not run in this session | Scope frozen by the owner; see §4 |
| Jira | Not updated | Connector needs the owner's OAuth; parked by the owner. Text in §8 |
| Real-user acceptance | Not performed | Owner journeys in §5 |

## 7. Handoff

1. Owner read-only lookups of §1.4 run ids (batch refusal code, failed swap response, stuck bridges).
2. CTO decisions: FloFi Wallet signing for bridges; relative amount button vs auto-apply.
3. CircleCI certification and the Vercel Preview are on the PR; merge and deploy only with CTO approval.

## 8. Jira update (ready to paste)

> BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 — corrective PR for CTO approval (not merged, not deployed). Incidents fixed with regression tests:
> chat amount after a same-asset bridge (1), "Solana" as SOL (2, also MCP), relative amounts (3), ETH → USDC two-swap sequence (4), raw slippage
> code (5), refused batch → server-proven per-step fallback (6), Google linking dead ends (7), FloFi Wallet refused bridges after Review →
> early guidance (9, observed in production logs), Router falling back to Base → Arbitrum labels (10, candidate). CTO decisions applied:
> slippage 1% default / 5% max / Auto (Jupiter RTSE, Relay) / warning above 3%; approved Execute UX with #251's wallet function; no mandatory
> Canvas step for destructive chat edits; USD equivalents. Open: failed swap (8) needs the run record; FloFi Wallet bridge signing is a CTO
> decision. Release: Vercel + Railway API/worker, same SHA, no migration.
