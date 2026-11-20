# BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 — UX/UI refinement, simplified execution history, post-merge CI fix

Branch `claude/relaxed-hawking-h10dgx` from `origin/main` **`0ea35d58`** (PR #223 merge, 19 Nov 2026 22:30 UTC). Presentation, test and CI-fix build:
no financial engine, simulation algorithm, gating, wallet, signing, execution, reconciliation, fee, provider/routing, schema/migration, API contract,
environment, dependency or deployment-configuration change. No transaction was signed, sent or broadcast; every browser run used the MOCKED
loopback harnesses.

Status vocabulary (PDF §14): **Implemented technically** · **Validated visually** (against the references, by comparison captures) ·
**Validated functionally** (automated evidence named) · **Accepted by product** (the FloFi product team only — never claimed here).

## 1. Baseline and sources

| Item | Finding |
| --- | --- |
| Baseline | `main` `0ea35d58` = PR #223 (`fix(ci): PostgreSQL suite hooks 120 s`), after PR #222 (BUILD-FLOFI-UX-POLISH-001), #221 (liquidity lifecycle), #219 (BUILD-FLOFI-UX-EDITOR-FINOPS-001). |
| Post-merge certification on `main` | `0ea35d58`: **red** — `certification-browser-3`, profile `swap-read-acceptance` (CircleCI run `81174640`). `46e41fe5` (PR #222): red — `certification-checks` PostgreSQL hook timeout, fixed by PR #223 (its checks job passed on `0ea35d58`). |
| Open PRs | #182, #140, #137, #102, #55, #54, #52 — all stale (Oct–early Nov) and unrelated to the Editor, history or the failing spec. |
| Working tree | Clean at start; one dedicated branch in this session's isolated cloud container (its own clone; nothing shared with another checkout). |
| Product specification | `FloFi_Orientacao_Refinamento_Visual_UX_UI_Alrimar_19-11-2026.pdf`, 21 pages, read in full; the six embedded images extracted at original resolution (p16 A-Criar 1919×906, p17 **B-Criar** 1815×866, p18 A-Simular 1909×903, p19 **B-Simular** 1815×866, p20 A-Executar 1919×907, p21 **B-Executar, expired review** 1774×887). |
| Design system | The repository's own tokens (`globals.css`: `--ink #041B3D`, `--primary #2343D9`, `--soft #F5F8FB`, `--blue-soft`, `--warning-surface/-text`), Outfit and IBM Plex Mono. The claude.ai Design System artifact link supplied with the request could not be read from this session; the repository tokens (which the PDF itself asks to prioritise) were used. |

## 2. Workstream C — the outstanding post-merge red (root cause and fix)

**Failure.** `e2e/acceptance-swap-read.spec.ts` (Ethereum Sepolia): after "Simulate workflow", `Simulation Summary › Expected result` was
"not found". The failure screenshot shows a valid result ("Simulation valid for 0:51") with **Technical details collapsed**. The diagnostic rerun
passed; the same test had flaked on 2026-11-17 (CircleCI flaky-test list), i.e. before PR #222.

**Root cause (reproduced).** Until the public swap runtime's availability answered (`availabilityKnown === false`, `available === false`),
`projectSimulation` stopped with "Simulation is not available…", so the Simulate panel rendered its **blocker** layout (`BlockerPanel`). The spec
opened that layout's Technical details; when availability arrived the panel switched to its waiting layout — a different element tree — and the
uncontrolled `<details>` was re-created closed. Proven locally by delaying only the availability server actions: the panel started as
`review-panel-blocked` with the details open, exactly the transient CI hit under load. It was a real product defect too: an owner saw "not
available" for a runtime that was merely still being checked, and lost the disclosure they had opened.

**Fix (smallest correct).**
1. `domain/simulation-presentation.ts` — `availabilityKnown === false` projects **"Checking whether simulation is available on this network…"**
   (attention, no warning), never `blocked`. A known "not available" answer and any recorded refusal (`source.state.error`) still block exactly as
   before. The Simulate control stays closed meanwhile: `simulationDisabled` (app-shell) is unchanged; its reason is now the checking sentence.
2. `components/review-summary-panel.tsx` — the panel owns the Technical details open state (controlled `<details>`), so it survives the
   blocker, waiting, result and expired layouts.
3. Regression: `e2e/simulate-panel-disclosure.spec.ts` drives the real panel through checking → blocked → waiting → result with props replaced in
   place. **It fails on the baseline and passes with the fix.** Unit tests for the projection and the reason. The original spec is unchanged and
   passes (`swap-read-acceptance` profile).

No retry, skip or weakened assertion was added.

## 3. Workstream A — approved Editor refinement (PDF §§02–11)

| PDF requirement | Before (A, baseline) | Implementation (files) | Status |
| --- | --- | --- | --- |
| §05 Global nav "Operar · Painel · Meus Workflows"; stages inside the Editor | Already implemented (PR #219) | Unchanged | Kept |
| §05 Creation tools in ONE compact area, Create only | Icon-only vertical rail (the BUILD-FLOFI-BUILDER-UX-002 desktop default) | **Docked row of named tools under the Editor header is the default on every width** (`domain/canvas-layout.ts`, `workflow-canvas.tsx`); the rail stays one "···" choice away and an owner's choice is remembered. Intentional change, tests updated (`build-correction.test.tsx`, `e2e/canvas-ux.spec.ts`). | Implemented |
| §05 Step count and state discreetly | State as a filled pill | Dot + words beside the step count (`ux-refinement.css`) | Implemented |
| §05 Canvas with adequate space; selection tools never clipped | Canvas 100svh−300; fitted cards' Duplicate/Delete toolbar clipped by the header | Canvas and Assistant one height on every stage (100vh−210/220); fit padding leaves room above cards (`workflow-canvas.tsx`) | Implemented |
| §06 Simulate: title with discreet blue mark, short subtitle | Present (PR #219) | Larger round mark, 19 px title (`ux-refinement.css`) | Implemented |
| §06 Compact operations card: icon, name, values, discreet network | Present, but chips showed chain numbers ("Base (8453)") and amounts in mono | Network **names** only (`networkName`, `operation-summary.tsx`); chain identifiers moved to Technical details; plain amounts; soft chips | Implemented |
| §06 "O que a simulação faz?" card | Present | Softer, borderless surface | Implemented |
| §06 ONE clear primary CTA "Simular fluxo" | Present | Pill CTA with a play mark (CSS mask, label/handler unchanged) | Implemented |
| §06 Technical details collapsed | Plain text disclosure; absent on the whole-workflow path before a result | One bordered row ("<>" + chevron), collapsed, on every Simulate state; whole-workflow path now has it before a result (`simulation-context-panel.tsx`, `WorkflowTechnicalFacts`) | Implemented |
| §06 No creation toolbar in Simulate; no two primaries; nothing stale as valid | Already true | Unchanged; asserted in `editor-stages-review.spec.ts` | Kept / tested |
| §07 Expired: soft-orange notice "Sua revisão expirou." + support text, not alarm red | Present, round "!" and amber body text | Warning triangle, title in the warning color, body in ink (`ExpiredReviewAlert`) | Implemented |
| §07 "Resumo da operação": white card, numbered circles with a subtle connection | List inside the panel card, grey circles, amounts in mono on separate lines | One white card (summary + rows + technical details), light-blue numbered circles joined by a hairline, **sentences of what was configured** ("Trocar 3 USDC por WETH na rede Base.") (`StepSentence`), recipient shortened with the full value in title/assistive text and in Technical details | Implemented |
| §07 Fee / permission "need refresh", wallet requests only when counted | Badges present | Badges carry an ⓘ with the reason (tooltip + sr-only); wallet-request row only when the Review counted it (unchanged rule) | Implemented |
| §07 Technical details at the end of the card | Missing on the whole-workflow expired view | Collapsed row with the configured workflow's facts and "the previous review expired at HH:MM; its values are no longer current and are not shown" | Implemented |
| §07 Only "Atualizar revisão"; never authorize an expired review | Already true | Unchanged gating; asserted (`one primary visible`, no Authorize) | Kept / tested |
| §07 Other execution states keep their own truth | — | Valid Review keeps "Você está autorizando"; its steps adopt the same numbered card style only | Implemented |
| §08 Assistant same place/size on every stage; no duplicated panel info | Heights differed between Create and Simulate/Execute; expired note in warning colors | Same height rule on every stage; the stage note reads like the Assistant's other messages | Implemented |
| §§09–11 Spacing/proportions; tokens; no new elements to fill space | — | Tokens only (`ux-refinement.css`, light and dark); no new components besides the receipt | Implemented |

## 4. Workstream B — execution history as a receipt

`components/dashboard/run-detail-view.tsx` now opens on `components/dashboard/execution-receipt.tsx` (projection `domain/execution-receipt.ts`,
unit-tested). Everything the record showed before is kept, under **one** collapsed "Technical details": run ID, workflow reference, execution
wallet (full, copy), recorded status / result / environment / issue, exact ISO timestamps, recovery and reconciliation, the step timeline with
planned vs actual values, approval and execution transaction hashes (copy + explorer), the evidence section (archive integrity — explicitly
distinct from execution status — environment, limitations) and the existing technical details. Duplicates removed: the separate "Run summary",
"Execution follow-up" and "Archive reference" blocks (their facts are in the receipt or Technical details once).

| Receipt line | Source (persisted record only) | Rule |
| --- | --- | --- |
| Title "Swap — Concluído" | one step: its action; several: the workflow name; status = `projectDashboardRun().status` | The status vocabulary is unchanged (Completed, Partially completed, Failed, Unresolved, In progress, Transaction not submitted, Not started) |
| Date "19 nov. 2026 · 10:26 UTC" | `run.updatedAt` (else `createdAt`) | UTC; the exact instant in Technical details |
| Você enviou / depositou | evidence `Executed input`, `Sent`, `Actual transferred`, `Actual supplied` | Observed only; otherwise "Valor configurado" (the owner's amount, never called sent) |
| Você recebeu / pegou emprestado / O destinatário recebeu / Reembolsado | evidence `Actual received`, `Actual borrowed`, `Recipient received`, `Verified refund` | Observed only; a completed swap-like step with no observation says "Não registrado neste histórico" — never zero, never the quote |
| Other results (liquidity, position NFT, orderbook reports) | evidence labels as recorded | Kept with their own label (a provider report is never "received") |
| Rede, Protocolo, Destinatário | lifecycle step network/provider; a send's configured recipient (new optional `LifecycleStep.recipient`, display only) | Bridges read "Base → Arbitrum One" |
| Taxa de rede | evidence `knownCosts` per network; a fee taken out of a swap (0x) listed separately | Never summed across networks or assets; none recorded → "Não registrado neste histórico" |
| Taxa FloFi | — | **Not shown**: no execution record stores a charged FloFi fee (only the Review discloses it). Nothing is fabricated. |
| Carteira | evidence wallet, else `run.ownerAccount` | Shortened, full value copied |
| Etapas concluídas | `completed` of `total` | Omitted when the plan is unavailable |
| Ver transação | the step's last non-approval transaction with an explorer | Omitted for local/mocked chains and orders (copy stays in Technical details) |
| Several steps | ordered list: action · network · own status, its own sent/received, its own link | Nothing aggregated across steps |
| What happened / needs action | `view.message` + `view.attention` (unchanged projections) | Shown for anything but a clean completion; saved records keep "does not retry or continue" |

Readable amounts (`readableAmount`): locale separators (PT `0,000003724947756 ETH`, `1.234.567,5 USDC`), at most 12 significant decimals, **cut
(never rounded)** and marked "…", the full value in the tooltip and in Technical details; a non-zero amount can never display as zero. Data:
no schema, API, record, evidence or reconciliation change; historical records render without migration (legacy summary-only records included).

## 5. Financial and security preservation

(see §9)

## 6. Independent specialist reviews (read-only `.claude/agents/flofi-*`, advisory) and dispositions

Selection from `agent_guard.py impact --base origin/main` (17 domains touched through shared modules; at most three at once): flofi-security,
flofi-workflow, flofi-frontend-ux (batch 1); flofi-wallet-execution, flofi-infrastructure-ci (batch 2). Domains not reviewed (automations, bridge,
channels, chat, data-privacy, developers, lending, liquidity, mcp, protocol-integrations, swap, transfer-payments): reached only through the shared
presentation modules reviewed by flofi-workflow/flofi-security; no runtime, API, channel or persistence code changed. Every finding was verified
against the code before acting.

| Reviewer | Finding (severity) | Disposition |
| --- | --- | --- |
| security + workflow | The new "checking availability" projection returned before a recorded run's verdict/binding/expiry checks; a recovered router/universal Review could read approvable while availability was unknown (medium) | **Fixed** (`367364b`): checking applies only when nothing is recorded; `projectReview` also treats it as not approvable (defence in depth); regression tests. |
| workflow | A bridge destination's observed amount was labelled "You received" although it goes to the reviewed recipient (medium) | **Fixed**: "Delivered" ("Entregue"); test. |
| workflow | Expired/cancelled/refunded steps read "Failed" (low) | **Fixed**: own words; test. |
| workflow | A send to the connected owner showed the symbolic `CONNECTED_OWNER` (low) | **Fixed**: the owner's wallet ("Sua carteira" in summaries); test. |
| workflow | The expired branch could reuse the Review's technical block (low) | **Fixed**: configured facts only. |
| workflow | Wallet-request count of an expired Review may change after refresh (low) | **Kept** (pre-existing BUILD-FLOFI-UX-EDITOR-FINOPS-001 rule; the reference shows the count; the row appears only when the Review counted it). |
| wallet-execution | Local/mocked provenance no longer visible on the receipt (medium) | **Fixed** (`e2c3a23`): provenance line on the receipt; tests. |
| wallet-execution | Saved record notice could say "current execution record"; one-step bridge linked the provider's fill; fee row with nothing submitted (low) | **Fixed**; tests. |
| frontend-ux | Local disclaimer hidden (major) | **Fixed** (as above). |
| frontend-ux | Broad parameterized PT keys became catalog fallback patterns (could rewrite unrelated strings / workflow names) (medium) | **Fixed** (`5072b4c`): exact-lookup-only catalog; workflow names never translated. |
| frontend-ux | Status / expired rows may overflow at 320 px; ARIA names on `<small>`/`<dl>`; copy failure announcement; per-step copy names; bridge direction for screen readers; badge reason separator; ISO timestamps; title punctuation (minor/low) | **Fixed**. |
| frontend-ux | Decimal separators: PT receipt "0,0243" vs Technical details "0.0243" (low) | **Partly**: only "<number> <unit>" values are reformatted; the receipt follows the approved PT example, Technical details keep the recorded values verbatim (deliberate). |
| frontend-ux | Grouped vs single-step disclosure persistence differ after a result (low) | **Kept**: the grouped result is a different panel (the whole-workflow Review) with its own disclosure; documented. |
| infrastructure-ci | First certification will fail on screenshots; fail-fast shards can hide later profiles (medium) | **Mitigated**: every affected profile run locally before the PR; non-screenshot failures fixed (`canvas-ux`, `canvas-cta`, theme spec); screenshot baselines regenerated from CircleCI's own candidate renders (CI.md §5). |
| infrastructure-ci | New suites unregistered; rail ARIA assertion dropped; disclosure spec clock/harness timing; evidence env not cleared (low) | **Fixed** (`5072b4c`). |
