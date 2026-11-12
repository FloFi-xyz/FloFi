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
| `CopilotPanel` (`reviewInPanel`) | While the block is open, a chat message carrying a Review shows its text only (no second Review card, notes or authorize chips). Conversation state is untouched. |
| `approved-ux.css` | Block styles (tokens only, both themes, no shadow, 18 px radius, 44 px targets); the block sits beside the cards from a 960 px Canvas frame for workflows of up to two steps (the 1440 px layout); more steps keep the 1180 px rule. |
| i18n | PT-BR for the new lines (`pt-workflow-execution.ts`). |

Not changed: `useEditorWorkflowRun`, Review/authorization/execution groups, batching (`wallet_sendCalls`), minimums, quotes, validity, recovery,
server services, refusal codes, the Canvas graph, the stepper, navigation, the Simulate tab, Execute with a run.

## Not done without touching logic (owner decision)

- The assistant's own message text after a simulation ("Simulei sem mover nada. Confira a revisão ao lado e autorize quando estiver pronto.")
  comes from the copilot flows; changing it is copilot logic, so only the duplicated Review card, notes and chips are hidden.
- On the step-by-step path the footer action is the per-step lifecycle action (it opens Simulate for step 1); a single "Autorizar na carteira"
  for that path would need the execution flow to change.
- Amounts keep the app-wide decimal point (e.g. `0.0003`); localized decimal commas are an app-wide formatting change.
- The amber "wallet changed" line reuses the existing message ("A carteira mudou. Simule e revise novamente este fluxo com a carteira
  conectada."), shared with other surfaces and specs.

## Evidence

Unit: `editor-workflow-run.review-block.test.tsx`, `domain/review-block.test.ts`, the existing panel/bridge/footer tests. Browser (MOCKED
loopback): `editor-wallet-batch` (ONE `wallet_sendCalls`, reconciled, never resent — now through the footer action) and the profiles listed in
the PR. Before/after screenshots (1440 px, PT and EN, light and dark): [evidence](evidence/p0-review-block-board-06/).
