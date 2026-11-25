# BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001

Branch `claude/serene-cannon-inz1zd`. Base `52b87cf` (PR #251 merge, verified against fetched `origin/main`).

**Status: ready for CTO review. Partial delivery.** Nothing is merged, deployed or configured. No real funds and no production credentials were used. This
build fixes the incidents that could be reproduced from the repository, with regression tests that fail on `main` and pass here. Several workstreams of the
brief are **not done** and are listed in §6 with the reason. Do not treat this PR as closing the beta incident list.

## 1. Forensic audit

### 1.1 Access actually available

| Source the brief asks for | Available in this session | Consequence |
| --- | --- | --- |
| Git history, PRs #248–#251 | Yes (local history, GitHub API) | Audited below |
| Vercel and Railway deployed revisions and logs | **No** (no Vercel/Railway credentials or CLI in this container) | The production revision during each incident is **not established** |
| Sanitized execution records, provider responses | **No** (no production database access) | Execution incidents are diagnosed from code paths only |
| Jira | **No** (the Atlassian connector needs authorization) | Jira workstreams were **not** linked or updated |
| CircleCI | **No** API access from here | Certification is tracked on the PR by its own checks |

Root causes below are therefore stated as **reproduced in code** (with a failing test on `main`) or **inferred from the code path**. None is confirmed against
production logs. The owner should run the read-only production checks in §5 before calling any incident resolved.

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
| 5 | Raw `ROUTER_SLIPPAGE_OUT_OF_RANGE` shown | Router and universal bridge forms put the thrown code into their alert | `components/router-panel.tsx`, `universal-bridge-panel.tsx` | Pre-existing | `slippageRangeMessage`: the action's actual range in the approved, translated wording ("from 0.01% to 3%"). The chat's Router rejection names the range | `slippage-range-message.test.ts` | **Not run** |
| 6 | Wallet refused the batch | A batch refused **before sending** (EIP-5792 5700/5710/5740/5750/5760, 4100, 4200 → `WALLET_BATCH_NOT_SENT`) only offers "try again", which repeats the same refused batch | `components/editor-workflow-run.tsx`, `workflow-runs` | Pre-existing | **Not corrected.** A client-side "Confirm each step separately" was implemented and then **reverted** after flofi-security and flofi-wallet-execution review: it could follow an earlier group that already executed (duplicate spend), stayed hidden while the prepared group counts as in flight (~12 min), was lost on reload, and would label the ended run "may have executed". A correct fix needs a server-recorded, proven not-sent report so the run can continue step by step from its last reconciled step | — | **Open**. The production refusal code is unknown (§1.1) |
| 7 | Google could not be linked to a wallet account | Two dead ends: an account without a Privy link was offered no way to add a method. Google already opening another (empty, Google-first) account ended on "Nothing was linked, merged or moved" | `components/account/sign-in-methods.tsx` | Pre-existing | "Confirm it's you" (Privy sign-in with a method the account holds, which creates the link), and the existing checked path to bring an empty account's sign-in here. No ownership or merge logic changed | `sign-in-methods.test.tsx` | **Not run**. The production account state is unknown |
| 8 | "Failed swap" (unspecified) | **Not established**: no execution record or provider response was available | — | — | None | — | Open |
| 9 | Bridges Base→Robinhood, Base→Arbitrum, Ethereum→Arbitrum, Ethereum→Base→Aave | **Not established** without the attempt records. The route registry offers all four pairs. Ethereum→Base→Aave authoring was broken by incident 1 | — | — | Only the authoring part (incident 1) | — | Open |
| 10 | "Base" hard-coded in unrelated messages | **Not reproduced**: no public-product message naming Base for another route was found (the remaining Base strings are engineering/test-network panels or Base-specific copy) | — | — | None | — | Needs the exact message from the report |

## 3. Safety properties kept

- No authorization or execution without the owner's wallet. The relative-amount answer only writes an amount, through the same path as a typed one, before
  Simulate and Review.
- Dependent steps never count funds twice. A cap is the user's own number. The runtime spends min(cap, what the earlier step actually delivered, reconciled).
- No automatic retry or mode switch was added.
- No schema validation was weakened. Slippage limits are unchanged (see §6).

## 4. Validation (local, MOCKED / loopback; not certification)

Each run was against the branch after its commit:

- New and changed suites: `beta-critical-recovery` 12, `relative-amount` 19, `slippage-range-message` 5, `strategy-engine` new 4,
  `components/account` 20 — all passed.
- Domain and state suites: 193 files, 2,992 tests passed. Copilot, router and universal bridge suites: 23 files, 787 tests passed.
- `agent_guard.py check` PASS, `governance_lite.py` PASS.
- Specialist review (read-only): flofi-security (5 findings, highest high) and flofi-wallet-execution (6, highest high) both found the duplicate-spend risk
  in the step-by-step offer → reverted (incident 6). flofi-security also found "50% of my USDC" read as 5% and over-broad "all" readings → fixed: whole
  percentages kept, a relative amount must name the token being asked about, the automatic answer needs a fresh read (≤30 s) and a balance no earlier step
  touches. The EIP-5792 5750/5760 comment was corrected. Other specialists: see the PR.
- Toolchain: the full `pnpm check` gate runs on the pinned Node 24.21.0 (checksum-verified) and pnpm 11.22.0; earlier focused runs used Node 24.22.3. Local PostgreSQL is 16 (CI uses 18).
- Visual: `ux-refinement-evidence.spec.ts` passed on this branch (local PostgreSQL 16 instead of CI's 18; verified headless shell 1243, Anvil 1.8.3).
- `pnpm check`, specialist reviews, CircleCI and Vercel Preview: see the PR. They are recorded there, not here, so this file never claims a result it does
  not hold.

Real-user acceptance (hosted wallets, ChatGPT, Claude, Telegram journeys): **not performed.** Loopback mocks are not acceptance.

## 5. Incident recovery, release and rollback

**Incident recovery (read-only, owner):** for each reported attempt, look up the run in Railway's execution records by its correlation id. Use
`reconcile-history` **without** `--apply` to observe its settlement. A bridge already submitted is observed and reconciled, never resubmitted. Any
`--apply` needs separate CTO authorization.

**Release plan:** this build changes only the Vercel client and shared domain code. No migration, environment variable or Railway API contract changed. One
Vercel deploy of the reviewed SHA after CTO approval. Then the four NL journeys, a Google link on a wallet-first test account, and a refused-batch journey
should be run by the owner with their own wallet.

**Rollback:** redeploy the previous Vercel production deployment (`52b87cf`). No data or schema change needs reverting.

## 6. Not done in this build (honest scope)

| Brief section | Status | Reason / next step |
| --- | --- | --- |
| §7 Manual 250/500 bps, Auto slippage, elevated-slippage warning | **Not done** | 300 bps is the reviewed maximum in every swap, bridge and liquidity profile, validator, linter and compiler (`workflow-contracts`, `action-registry`). Widening it is a financial-safety policy change. It needs an explicit CTO decision on which protocols get 500 bps, plus swap, bridge and security review. Auto slippage needs a trusted route signal that does not exist yet |
| §8 USD equivalents under every amount | Not done | Needs its own design check against the approved card contract |
| §6 Live validation of every mainnet route | Not done | Needs production read access and route records |
| §4 Capability-aware single confirmation; safe fallback after a refused batch | Not done | See incident 6. Needs a server-side not-sent report and resume-from-step; no client-only shortcut is safe |
| §5 Google-first onboarding, invite redemption, account recovery audit | Partly | Only the linking dead ends were fixed |
| §10 Full PT/EN audit of Web, MCP and Telegram | Partly | Every string added here has PT. No full audit was run |
| Relative amounts on Telegram/MCP | Not done | Telegram has no balance shortcut UI. The question is asked and the user types the amount |
| Jira | Not done | Connector not authorized in this session |
| Multichain-state UX of #251 | **CTO decision** | See §1.3 |
