# BUILD-FLOFI-CHAT-EDITOR-UX-001 — Dashboard | Chat | Editor

**Status:** ready for owner review, stacked on BUILD-FLOFI-E2E-RELIABILITY-001. Branch `claude/flofi-chat-editor-ux-001`; its PR targets
`claude/festive-keller-om54li` (Build 1) so the diff holds only this build's navigation changes. By owner decision (2026-11-02) it was
developed in parallel, before Build 1 merged; after Build 1 merges, this branch is synchronized and retargeted to `main` and the final CI
runs there. Nothing is merged, deployed or configured; no wallet or funds were touched.

## 1. Scope (owner's)

- The app navigation is **Dashboard | Chat | Editor**: “0 Build” → **Chat**, “1 Build” → **Editor**; the standalone “2 Simulate” and
  “3 Execute” tabs are removed; no stage numbering.
- The Editor is the existing “1 Build” interface, unchanged: the same Canvas (`WorkflowCanvas`), side chat (`CopilotPanel`), toolbar,
  settings and lifecycle button.
- Chat and Editor keep access to real simulation, review, wallet authorization, execution, reconciliation and recovery through the shared
  lifecycle: no store, panel, gate or execution logic is forked or changed.
- Deep links, in-progress workflows and execution records are preserved.

## 2. Implementation

| File | Change |
| --- | --- |
| `src/components/top-bar.tsx` | Dashboard, **Chat** (the former Build entry, shown exactly where “0 Build” was), **Editor**. Stage numbers, `data-build-stage` and the “Build 0” label removed. Editor is the current item on the Canvas, simulation and execution sections; selecting it opens the Canvas, as Build did. |
| `src/components/summary-bar.tsx` | Optional `sections` prop: footer buttons **View simulation** / **View execution** (navigation only: `setTab('Simulate' / 'Execute')`); a section's own button is hidden while it is shown; disabled under the same rule that disabled the old tabs (`authoringIncomplete`). |
| `src/components/app-shell.tsx` | Passes `sections`; the Chat page's main landmark is labelled “Chat”. |
| `src/app/globals.css` | Stage-number rules removed; secondary footer-button styling. |
| `src/i18n/pt-chat-editor.ts` (new), `pt.ts`, `pt-build-entry.ts` | PT entries (Chat, Editor, Seções do editor, Ver simulação, Ver execução); the dead “Build 0” entry removed. |
| Unit tests | `product-shell.test.tsx`, `summary-bar.test.tsx` (footer buttons). |
| e2e | Helpers in `e2e/build-entry-navigation.ts` (`openEditorSection`, `expectEditorSection`, `editorSectionAction`, `editorTab`, `chatTab`, …) and 85 specs/fixtures follow the new navigation. |
| `docs/engineering/coverage.json`, `COVERAGE.md` | The new catalog file mapped (`agent_guard check`). |

The Simulate and Execute sections are the existing `SimulateWorkspace` (with its embedded Review) and `ExecuteWorkspace`; the Canvas button
still moves into them (simulate → simulation, authorize/continue → execution), the side chat still drives the lifecycle in place, and recovery
and status checks are the existing controls. The Review and explicit wallet-confirmation gates are unchanged; the footer buttons only navigate.

## 3. Deep links and persistence

| Old target | New |
| --- | --- |
| “0 Build” tab | Chat tab (same section value) |
| “1 Build” tab, drawer “Build Workflow”, every `setTab('Build')` (Back/Return to Build, Dashboard “Build workflow”, reopened workflow, automation proposal, Create new workflow) | Editor, Canvas |
| “2 Simulate” tab | Editor simulation/Review section (footer “View simulation”); the Canvas Simulate button, `/approve` auto-prepare and “Back to Simulate” land there unchanged |
| “3 Execute” tab | Editor execution section (footer “View execution”); authorize/continue and the Dashboard's “Open current execution” / “View result in Execute” land there unchanged |
| `/app`, `/app/dashboard[/runs/:id]`, `/app/workflows`, `/approve?view=canvas`, `/__engineering` | unchanged |

The selected section was always in-memory React state (never a URL, query, hash or storage key), so no stored link or record changes. Drafts,
runs, localStorage keys and execution records are untouched; a recovered or live run still leaves Chat for the Editor, as it left “0 Build”
for “1 Build”.

## 4. Tests

Intentional test changes (no assertion, threshold or screenshot tolerance was relaxed; nothing skipped): clicks on the old tabs use
`openEditorSection`; `aria-current` checks on old tabs assert the Editor is current and the section's own region is visible; “Build 0” checks
use Chat; stage-number checks now assert that none exist (badge-colour assertions removed with the badges); `canvas-cta` asserts the footer
holds exactly the section buttons and no lifecycle button; `supply.spec` expects 0 Execute buttons (the old count of 1 was the nav tab).

Local (Node v24.21.0, pnpm 11.22.0; loopback only): typecheck, lint, `schemas:check`, build — pass; `pnpm test` 6,349 passed, 2 skipped by
their own environment conditions; governance-lite, its unittests, `test_ci_agent_guard`, `agent_guard.py check` — pass. Guarded browser
profiles: every product profile passed (e.g. review-execute-recovery-components 39, execution-continuity 34, mcp-in-chat 26, canvas-automation-ux
18, auth-wallets 15, …; cow-loopback 9 with `GRYLOO_COW_RUNTIME` set as in CI) **except `default-product`: 99 passed, 9 failed** — 7 screenshot
mismatches from the changed header/footer and 2 build009 tests that need the live LI.FI quote (`ENOTFOUND li.quest`, as on the base).
`composition-provenance` was not run (needs official artifact downloads and the Mode B harness; its only change is one navigation line).

**Screenshot baselines (CI blocker until regenerated in the CI image):** visual-shell (build, simulate, execute), swap-authoring
(chat-committed, review-blocked), mock-artifact-chain (simulate-current, simulate-invalidated, simulate-expired), base-observation
(observation-recorded, observation-expired). The base commit's own baselines do not match in this sandbox and there is no Docker daemon for
`cimg/node:24.21.0-browsers`, so no locally rendered baseline was committed; they are regenerated from the CI rendering environment and the
diffs inspected (header nav and footer only) before committing.

## 5. Open questions for the owner (left unchanged, out of the stated scope)

1. Labels that still name the old stages: “Back to Build”, “Return to Build”, “Back to Simulate”, “Create a workflow in Build”, “View result in
   Execute”, “Configure the action amount in Build first”, the drawer's “Build Workflow” — rename to Editor wording?
2. The navigation's accessible name is still “Workflow stages” / “Etapas do fluxo”.
3. Footer “View simulation” / “View execution” are always shown (disabled while a Canvas amount is unapplied) — or only when a simulation/run exists?
4. Should Chat itself show review/execution status, rather than handing off to the Editor's side chat as now?
5. PT keeps the English words “Chat” and “Editor”.

Evidence level: MOCKED / loopback only; no public-network execution.
