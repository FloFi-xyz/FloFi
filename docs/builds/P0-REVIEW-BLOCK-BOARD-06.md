# P0 — Review block before authorization (board 06 "Simular e revisar")

Owner request (2026-11-12): redesign only the whole-workflow Review block the Editor shows before anything is authorized, after board 06 of the
"FloFi App · UX" canvas, so a person understands in five seconds what they authorize. Presentation only. Base: `origin/main` `d3f30a2`
(PR #186). Branch: `claude/peaceful-galileo-7r9j2j`. Nothing is signed or sent by this build; browser evidence is MOCKED loopback only.

## Where the block is

The block in the owner's screenshot ("Revise o fluxo inteiro", Grupo 1/Grupo 2, "Etapa 1 · Trocar · Base (8453) — Não iniciado", "Revisar
novamente", "Voltar à simulação", "Simular fluxo" on the Canvas, "Confirmar cada etapa · Etapa 1 de 2" caption, "Plano de execução") is the
**Execute** tab before authorization (the stepper highlights 3 · Executar), where `EditorWorkflowRunPanel` is docked in the Canvas frame. That
view had no footer bar. To keep exactly ONE primary action, in the footer, the Editor's existing footer (`SummaryBar`) is now also rendered on
Execute **only in that pre-authorization state** (chat-first workspace, a whole-workflow Review offered, no run, no live or continuing
execution). Every other Execute state is unchanged.

## What changed (presentation only)

| Where | Change |
|---|---|
| `domain/review-block.ts` (new) | Plain lines from the existing `EditorExecutionReview`: one per step (verb + amount + asset + network), the final minimum, the summed fee ceiling of the prepared requests, one token-permission sentence per prepared approval, the wallet-request count. Amounts keep at most 6 significant digits (a minimum rounds down, a spend or fee up); the full value is the tooltip. A value the Review does not know says so ("Quoted when …", "+ later requests"). |
| `EditorWorkflowRunPanel` | Before a run: REVIEW · "You are authorizing" · step lines · Minimum you receive / Network fee, at most / Token permission / Wallet requests · "Your wallet pays the network fees. FloFi never signs or sends for you." · collapsed "Technical details" holding everything it showed before. One amber line on top for an error, a refusal or expired prices. A native-fee shortfall shows the board 07 blocker only. With `actionsOutside` (chat-first) it renders no button before a run. |
| `EditorWorkflowRunPrimaryAction` (new export) | The Review's ONE primary for the footer: "Review whole workflow" → "Authorize workflow" (valid grouped Review) → "Review again" (expired or not groupable). Same handlers and disabled rules as the panel's own buttons. |
| `ExecuteWorkspace` (`reviewBlock`) | Pre-run: only the Review (plus one amber line when the step-by-step path's state needs attention); no per-step status list, no "Back to simulation"/"Return to the Canvas", no Canvas action or caption, no Canvas foot labels. |
| `app-shell.tsx` | Computes `reviewBlock`; renders the footer on Execute in that state with the Review's primary (whole-workflow path) or the existing lifecycle action without its "Confirm each step …" caption (step-by-step path); footer status = the Review's validity countdown or its refusal. |
| `SummaryBar` | Hosts the action and status line on Execute when the shell hands them over. |
| `CopilotPanel` (`reviewInPanel`) | While the grouped Review is open, a chat message carrying a Review shows no second Review card; its text, requote notes and answers stay. The step-by-step path keeps its per-step card (its chat confirmation is bound to it). Conversation state is untouched. |
| `approved-ux.css` | Block styles (tokens only, both themes, no shadow, 18 px radius, 44 px targets); the block sits beside the cards from a 960 px Canvas frame for workflows of up to two steps (the 1440 px layout); more steps keep the 1180 px rule. |
| i18n | PT-BR for the new lines (`pt-workflow-execution.ts`). |

Not changed: `useEditorWorkflowRun`, Review/authorization/execution groups, batching (`wallet_sendCalls`), minimums, quotes, validity, recovery,
server services, refusal codes, the Canvas graph, the stepper, navigation, the Simulate tab, Execute with a run.

## Specialist review (read-only) and dispositions

flofi-chat, flofi-wallet-execution and flofi-frontend-ux reviewed the working tree; none found a change to authorization, batching, wallet
requests or handlers. Applied: the chat card is hidden only on the grouped path and requote notes stay; "Review again" stays reachable as a
quiet control (beside the amber line, or under Technical details) whenever the footer does not offer it; the step-by-step path keeps the
panel's own Review control and its notices and says each step asks the wallet on its own; the fee row adds "at today's prices; your wallet
sets the final fee"; an approval the block cannot word is never shown as "No new token permission"; network switches and a one-time
smart-account upgrade are said in the wallet-requests row; a transfer recipient is shown in full; the footer words the Review ("Review valid
for m:ss", "Review expired, review again"); the refusal and an action error share the one amber line; heading h3; Aave PT phrasing aligned.

## Not done without touching logic, or left for the owner

- On the step-by-step path the chat can still ask "Do you confirm…" → "Yes, execute" for the current step (copilot flow logic): a second
  authorize path besides the footer's lifecycle action, as before this change.
- The ~10-minute on-chain deadline note and the Aave health factor are under "Technical details", as the request lists them there; the
  reviewers suggested surfacing them — owner decision.
- Focus moves to the document when the footer unmounts after Authorize starts the run (follow-up).
- PT uses "etapa" in the block and "passo" in the footer count (existing catalogs).
- The assistant's own message text after a simulation ("Simulei sem mover nada. Confira a revisão ao lado e autorize quando estiver pronto.")
  comes from the copilot flows; changing it is copilot logic, so only the duplicated Review card is hidden.
- On the step-by-step path the footer action is the per-step lifecycle action (it opens Simulate for step 1); a single "Autorizar na carteira"
  for that path would need the execution flow to change.
- Amounts keep the app-wide decimal point (e.g. `0.0003`); localized decimal commas are an app-wide formatting change.
- The amber "wallet changed" line reuses the existing message ("A carteira mudou. Simule e revise novamente este fluxo com a carteira
  conectada."), shared with other surfaces and specs.

## Evidence

Unit: `editor-workflow-run.review-block.test.tsx`, `domain/review-block.test.ts`, the existing panel/bridge/footer tests.

Local results at the PR head (Node 24.21.0, pnpm 11.22.0, the approved headless shell 1243 and anvil 1.8.3, disposable loopback PostgreSQL):

| Gate | Result |
|---|---|
| `pnpm check` (typecheck, lint, build, schema drift, unit) | PASS — 615 test files passed, 2 skipped; 7419 tests passed, 2 skipped |
| `python3 scripts/governance_lite.py` + `unittest discover -s scripts -p 'test_governance_lite.py'` | PASS (21 tests) |
| `git diff --check` against main | PASS after removing a blank line at the end of `review-block-test-harness.ts` (the cause of the governance failure on CircleCI at `23f76ad`) |
| Browser `editor-wallet-batch` (MOCKED) | PASS (1) — ONE `wallet_sendCalls` through the footer action, reconciled, never resent |
| Browser `approve-workflow-run` (MOCKED) | PASS (2) |
| Browser `review-execute-recovery-components` (MOCKED) | PASS (39) |
| Browser `execution-continuity` (MOCKED) | PASS (38) |
| Browser `default-product` | Not re-run locally; locally its `toHaveScreenshot` baselines (CircleCI renders from PR #186) differ by ~1 % in glyph rendering on screens this PR does not touch. CircleCI passed `default-product` with those baselines at `8aba719`; CircleCI on this PR is the authority. |

Before/after screenshots (1440 px, PT and EN, light and dark; MOCKED loopback): [evidence](evidence/p0-review-block-board-06/).
