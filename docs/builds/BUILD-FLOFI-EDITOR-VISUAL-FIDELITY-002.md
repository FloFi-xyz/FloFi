# BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 — Simulate/Execute fidelity, structured Technical details, post-merge red of PR #225

Branch `claude/relaxed-hawking-h10dgx` from `origin/main` **`dc09621b`** (PR #225 merge). Source: *FloFi — Prompt técnico definitivo* (PDF of
20-11-2026, 12 pages, references A1–A6 embedded; the separate asset ZIP was not provided, so A1 1815×866 and A4 1774×887 were extracted at original
resolution from the PDF, and A2/A3/A5/A6 exist in it only at 1536 px).

Presentation, test and CI-fix build: no financial engine, quote/simulation algorithm, wallet, signing, submission, approval, nonce, slippage, fee or gas
logic, protocol, route, network, schema/migration, API, Admin FinOps/Health, infrastructure, dependency, AI provider or Developer API change. No
transaction was signed or sent; every browser run used the MOCKED loopback harnesses.

Status vocabulary: NOT STARTED · IN PROGRESS · IMPLEMENTED · PARTIAL · BLOCKED · TECHNICALLY TESTED · VISUALLY REVIEWED · ACCEPTED BY PRODUCT (the FloFi
product team only — never claimed here).

## 1. Workstream C — post-merge red on `main` `dc09621` (PR #225)

| | |
| --- | --- |
| Failing job | `certification-browser-2` (workflow `d92c9043`, job `4b4a8ae8`), profile `default-product-1` |
| Failing test | `e2e/brand-ux-001.spec.ts:74` "on a touch screen › touch controls, proposal and wallet dismissal at 320px" |
| Assertion | `brand-ux-001.spec.ts:136` `expect(.review-panel-approved).toBeFocused()` → *Received: inactive*; the locator resolved to `data-review-state="blocked"`. The trace rerun passed (intermittent). |
| Classification | Product regression (focus lost by the owner), exposed by timing — not an environment problem, not a screenshot. |
| Root cause | `ReviewSummaryPanel` renders its waiting/result/expired layouts as its own `<section>` and its blocker layout as `BlockerPanel`'s `<section>`. Since PR #224 the panel shows the waiting layout while a runtime's availability is being checked and switches to the blocker when availability is known to be false. The phone "Review" shortcut (`MobileBuildNavigation`) focuses the panel; when the availability answer arrived after that, the switch replaced the focused element and focus fell to `<body>`. PR #225 moved the availability reads into one batched server action (`publicSwapAvailability`), changing when the answer arrives and widening the window. |
| Why certification missed it | The race depends on the order of the availability response and the test's tap; PR #224's and PR #225's own certification runs happened to receive the answer before the tap. |
| Fix | `usePanelFocus` (`review-summary-panel.tsx`): every root layout of the panel carries the panel's root props; when the panel held focus and a layout switch removed the focused element, focus returns to the new root. Focus the owner moved elsewhere is never pulled back. PR #225's batched read is untouched. Commit `70f8e6f`. |
| Regression | `simulate-panel-disclosure.spec.ts` (profile `review-execute-recovery-components`): the real panel focused exactly as the shortcut does, then *checking → unavailable* (new harness state) → blocked → pending → ready; fails on `dc09621`, passes here. `brand-ux-001.spec.ts` 75/75 repeated runs locally. |

## 2. Diagnosis (PDF §2, Q1–Q6)

**Q1 — Sources of truth.** Global header and stage indicator: `app-shell.tsx`, `editor-chrome.tsx` (`EditorStepper`). Canvas: `workflow-canvas.tsx`
(Create), `simulate-workflow-canvas.tsx` (Simulate/Execute, docked panel `.canvas-review-dock`). Simulate panel: `ReviewSummaryPanel` stage `simulate`
(`review-summary-panel.tsx`), grouped workflows `SimulationContextPanel`; summary `OperationSummary`. Execute: `EditorWorkflowRunPanel`
(`editor-workflow-run.tsx`, whole-workflow Review, wallet request, run progress), `ReviewSummaryPanel` stage `execute` (single step). CTA owners: the
Simulate panel's `simulation-panel-action` (Simulate) and the footer `EditorWorkflowRunPrimaryAction` (Review operation / Authorize workflow / Refresh
review). Assistant: `copilot`. Disclosures: `details.review-panel-technical`. State projections: `projectSimulation`, `projectReview`,
`reviewBlockView`, `walletRequestView`. Tokens: `globals.css` (`--ink` #041B3D-family navy, `--primary` #2343D9, `--page` #F5F8FB, warning surfaces).

**Q2 — Financial effects (untouched).** Quotes/simulation: `public-testnet-action`, `editor-workflow-execution-action` (`reviewEditorWorkflow`);
authorization/signing/submission: `authorizeEditorWorkflow`, `prepare/permit/authorizeUserFundedGroup`, `sendWalletBatch`, `signCirclePaidGroup`,
`signSolanaGroup`; reconciliation: `loadStatus`, `followBatch`, `reportUserFundedBatch`. None is modified; the build only changes rendering.

**Q3 — State differentiation (already distinct, preserved).** Awaiting simulation `data-review-state="pending"`; checking availability (PR #224, not a
blocker); valid simulation `ready`; failed `blocked` (BlockerPanel); expired simulation/Review `expired` (C2 card); valid Review `ready` + footer
Authorize; wallet request pending `data-run-phase="wallet"` (own block "Confirm in your wallet"); confirming/submitted/confirmed/uncertain from the run
(`GROUP_STATE`, `stateText`, `stepWords`); receipts and history (PR #224).

**Q4 — Required before signing (visible outside the disclosure).** Steps with amounts, assets, networks and recipient; minimum received; network fee
cap; token permission; wallet requests (and setup/signatures); validity; native-fee notes; who pays the fee. Optional detail (now grouped under
Technical details): how each group runs, calls/approvals, Circle facts, run state words, per-step planned/expected values, wallet-ask breakdown,
switch/sign-in note, on-chain deadline note, quote times.

**Q5 — Dependencies.** Every authorized item is presentation-only. The "Token" label needs no backend change (the catalog loader already exists; only
the Simulate/Execute views did not call it). Nothing required a canonical-state change, so nothing is blocked.

**Q6 — Test plan.** Same-viewport captures 1815×866 (A1), 1774×887 (A4), 1440×900 and 390×844, PT, MOCKED Base harness (`e2e/ux-refinement-evidence.spec.ts`,
local only); regressions in `editor-stages-review.spec.ts` (EN and PT), `simulate-panel-disclosure.spec.ts`; affected profiles (§6).

**Already delivered by PR #224 (not rebuilt):** global header and stage indicator; Simulate initial layout (A1 hierarchy: mark, title, subtitle,
icon summary with network names, "O que a simulação faz?", one pill CTA with play mark, collapsed Technical details); Simulate result/expired/failed
states with "Simular novamente"; expired Review (A4: soft-orange notice, numbered summary, refresh badges, counted wallet requests, collapsed details,
one "Atualizar revisão"); disclosure state across layouts; execution receipts.

## 3. Changes by workstream

**A — fidelity.**
- Valid Review heading "Você está autorizando" → **"Revise antes de autorizar"** (EXE-01, PDF §5A), in `editor-workflow-run.tsx` and
  `review-summary-panel.tsx`; the wallet request keeps its own block "Confirme na sua carteira" only while the wallet holds it; gates and handlers
  unchanged.
- **Token identity** (PDF §4, AAVE as "Token"): Simulate/Execute now load the same server-validated catalogs as Create
  (`useWorkflowNetworkCatalogs`, `asset-catalog-store.ts`), and re-render when one registers. A token the official catalog does not list stays the
  neutral unidentified label (never guessed). Commit `695af57`.

**B — Technical details** (TEC-01/TEC-02, PDF §6). Commit `5b26b26`.
- Grouped content: **Operações · Valores e limites · Taxas e permissões · Solicitações à carteira · Identificadores e evidências**, only when they hold
  data; one fact per row; same translation keys and conditions; recipient shortened with Copy (full value in tooltip).
- Bounded, focusable scroll region per disclosure (`TechnicalBody`); revealed inside the panel when opened; collapsed by default.
- Desktop Editor: the docked panel scrolls inside the frame. With details open the page stays exactly 1815×866, 1774×887 and 1440×900 (before:
  ≈1,780 px); the Canvas never re-centres, the footer action never moves, and three-step Reviews fit too.

## 4. Product acceptance matrix (PDF §12)

| ID | Baseline (dc09621) | Already implemented? | Changes / files | Tests | Screenshots | Remaining deviation · risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GLOBAL-01 / P1 | Header "Operar · Painel · Meus Workflows" | Yes (PR #219/#224) | None | `editor-stages-review` (areas, Operate current) | 01, 04, 05 | None · low | TECHNICALLY TESTED · VISUALLY REVIEWED |
| GLOBAL-02 / P1 | Internal stepper; Canvas consistent | Yes | Docked panel bounded on desktop (`editor-fidelity.css`) | no-page-scroll assertions (Create, Simulate 2/3 steps, Execute) | 01–08 | Stepper markers are numbers, not A1's check circles (A4 uses numbers) · low | TECHNICALLY TESTED · VISUALLY REVIEWED |
| SIM-01 / P1 | Compact icon summary with networks | Yes | Token catalogs loaded on Simulate/Execute (`asset-catalog-store.ts`, `simulate-workflow-canvas.tsx`, `operation-summary.tsx`) | `workflow-catalog-chains.test.ts`; existing summary tests | 01 | Summary omits A1's "~expected" amount (an expired estimate must never read as current; PR #224 decision) · low | TECHNICALLY TESTED · VISUALLY REVIEWED (AAVE on Arbitrum not reproducible in the MOCKED Base harness — see §5) |
| SIM-02 / P1 | One CTA per state | Yes | None | `editor-stages-review` (one Simulate, one primary) | 01, 02 | None · low | TECHNICALLY TESTED · VISUALLY REVIEWED |
| SIM-03 / P1 | Pre/valid/failed/expired distinct | Yes | Focus kept across layouts (Workstream C) | `simulate-panel-disclosure` (checking/unavailable/blocked/pending/ready) | 02 | None · low | TECHNICALLY TESTED |
| EXE-01 / P1 | "Você está autorizando" before any wallet request | Partial | "Revise antes de autorizar" | unit + `editor-wallet-batch`, `editor-stages-review` | 05 | None · low | TECHNICALLY TESTED · VISUALLY REVIEWED |
| EXE-02 / P0 | Expired Review blocks authorization | Yes (PR #224) | None | `editor-stages-review` (no Authorize; one primary "Atualizar revisão") | 04 | None · low | TECHNICALLY TESTED · VISUALLY REVIEWED |
| TEC-01 / P1 | Long text column; page grows (A3/A6 reproduced) | No | `technical-body.tsx`, `editor-workflow-run.tsx`, `review-summary-panel.tsx`, `simulation-context-panel.tsx`, `editor-fidelity.css` | `editor-stages-review` (groups, bounded body, no action on toggle, page = viewport, CTA in view); unit | 03, 06, 07 | Nested scroll (panel + body) on desktop · low | TECHNICALLY TESTED · VISUALLY REVIEWED |
| TEC-02 / P0 | Material rows visible above details | Yes | Same facts/keys regrouped; nothing removed | unit (row values), `editor-stages-review` (fee, permission, wallet requests visible) | 05, 06 | None · low | TECHNICALLY TESTED |
| QA-01 / P1 | — | — | Comparison sheets (this folder) | — | 01–08 | A2/A3/A5/A6 only at 1536 px in the PDF; references use Arbitrum/AAVE, captures the MOCKED Base harness (USDC/WETH) | VISUALLY REVIEWED |
| QA-02 / P0 | — | — | §6 | §6 | — | §5 | TECHNICALLY TESTED (CircleCI on the PR head is the authority) |

No item is **ACCEPTED BY PRODUCT**; that decision belongs to the FloFi product team.

## 5. Remaining deviations and limitations

- Stepper markers are numbers (A1 shows check/empty circles; A4 numbers) — one accessible pattern for all stages (unchanged from PR #224).
- The Simulate summary does not repeat the Canvas estimate "~0.000893108 AAVE" of A1: a live estimate can expire; it is shown in the result instead.
- AAVE on Arbitrum cannot be reproduced in the MOCKED Base harness; the fix is covered by unit tests and by the existing resolution path; a live
  check on Arbitrum with the official catalog is recommended (owner, read-only).
- Technical details on desktop scroll inside a panel that itself scrolls (nested), by design to keep the page and the footer action fixed.

## 6. Specialist reviews (read-only `.claude/agents/flofi-*`, advisory) and dispositions

The reviewers could not read the git-ignored review packet and reviewed the current source; each finding was verified against the code.

| Reviewer | Finding (severity) | Disposition |
| --- | --- | --- |
| frontend-ux, wallet-execution | The recipient in the Review's Technical details (and inline in the run view) was shortened to 6+4 characters (major / low) | **Fixed**: the full address is shown (wrapping monospace) with its Copy control. |
| frontend-ux, workflow, wallet-execution | The reveal-on-open used `scrollIntoView` (could scroll the page) on every `toggle`, including a controlled `<details>` re-created open (medium / low) | **Fixed**: only the owner's click on the summary reveals it, scrolling only the nearest scrolling panel; the page is never scrolled. |
| wallet-execution | An expired, non-grouped Review still showed "Review valid until …" in green (low, pre-existing) | **Fixed**: no validity line on an expired Review. |
| frontend-ux | Nested scroll areas with `overscroll-behavior: contain` could trap scrolling on phones (medium) | **Fixed**: the technical body no longer contains overscroll. |
| frontend-ux | The bounded desktop dock can hold rows below its fold while Authorize stays visible (medium) | **Mitigated**: a bottom fade marks more content; before, the page scrolled the same rows below the fold while the sticky footer stayed visible (not a regression). |
| frontend-ux | Each group was a landmark (low) | **Fixed**: groups are `role="group"` named by their heading. |
| frontend-ux | The grouping also shapes the live run view (low) | **Kept, intended**: the same facts, grouped the same way while a run is in progress. |
| workflow | `catalogs` memo dependency not read inside the memo (low) | **Fixed**: read explicitly. |
| workflow | Bridge nodes decoded per network on every render (low) | **Fixed**: chain list memoized on the steps. |
| wallet-execution, frontend-ux | Raw `g.network` in a group label; "Prices" alone under "Identifiers and evidence" (low/cosmetic) | **Kept**: the label is the pre-existing value; the grouping follows the PDF's taxonomy. |

## 7. Validation

See the pull request for the CircleCI certification of the exact head and the post-merge run.
