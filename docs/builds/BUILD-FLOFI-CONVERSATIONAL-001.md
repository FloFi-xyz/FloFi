# BUILD-FLOFI-CONVERSATIONAL-001 — Conversational workflow authoring, review and execution

Branch `claude/build-flofi-conversational-001`, based on `main` 9e71c10 (PR #133). Implementation, not a plan. Engineering evidence is local and
MOCKED (closed replay, loopback harnesses, scripted test wallets); nothing here was quoted from a public provider, signed by an owner wallet or
sent to a public network, and no production system was touched.

## What changed for the user

The FloFi chat can now carry the whole supported journey — BUILD → SIMULATE → REVIEW → AUTHORIZE → EXECUTE → RECONCILE — without the stage tabs.
The Canvas and the stage tabs are unchanged and stay fully usable.

```
You:    Swap 10 USDC to WETH on Base.
FloFi:  Swap added to your workflow: 10 USDC · USDC → WETH · Base · Uniswap.
        Would you like to add another action or review your workflow?     [Add another action] [Review workflow] [Undo]
You:    Review workflow
FloFi:  Simulating your workflow with current provider data. Nothing is signed or sent.
FloFi:  Here is the review of your workflow. Amounts are estimates from this simulation, not executed results.
        ┌ 1. Swap · 10 USDC · USDC → WETH · Base · Uniswap V3 — quoted output, minimum received, max slippage, price impact
        │ fees (network, provider, FloFi; "Not provided by this simulation" where the record has none), spend limits, recipients,
        │ token approvals, wallet, network, quote validity, risks and warnings
        └ Estimates from this simulation, not executed results. Your wallet shows every request before you sign it.
        Do you confirm this workflow?                                     [Yes, I confirm] [No]
You:    Yes, I confirm
FloFi:  Workflow confirmed (revision 1, wallet 0x1234…abcd). Nothing has been signed or sent.
        · Your wallet will ask you to confirm each request separately: Approve USDC, Swap.
        Would you like to execute this workflow now?                      [Yes, execute] [Not now]
You:    Yes, execute
FloFi:  Opening the reviewed wallet request. Confirm or reject it in your wallet; FloFi never signs for you.
        (live execution card from the durable record: each request, its state, hash/explorer link, received amounts, known costs)
FloFi:  The previous wallet request is confirmed. The next reviewed request needs its own confirmation in your wallet. Continue?   [Continue] [Not now]
FloFi:  Execution completed. All workflow steps are confirmed in the current execution record.   [Create new workflow]
```

Before this build, the same request produced a proposal chip on the Canvas that had to be opened and accepted with ✓ (or dismissed with ✗),
and simulation and execution required the Simulate and Execute tabs. Portuguese (PT-BR) works the same way ("Revisar workflow", "Sim, confirmo",
"Sim, executar", "Agora não").

## Requirements → implementation

| Req | Implementation |
| --- | --- |
| R1 Remove bottom Advanced Settings | The bottom inspector (`ArtifactInspector` in `app-shell.tsx`, its disclosure, state and CSS) is gone. Each card's existing settings control (now labelled "Settings", accessible name "Action settings", `aria-haspopup="dialog"`, `aria-expanded`) opens **that card's** settings in a dialog anchored to the card (`ActionSettingsPopover`, `artifact-inspector.tsx`). It hosts the same forms and commands as before (amount, slippage, lock, remove, tokens/networks, bridge, recipients, liquidity ranges, lending, Stocks), so no parameter became unreachable. It closes with Escape, its close button or a click elsewhere. While closed it stays mounted **hidden** for the selected card only, because the cards' own Review buttons (`Review Supply change`, pool review) submit those forms by id — exactly as the collapsed inspector body did. Review keeps every financial detail and permission disclosure. |
| R2 Direct card creation | `useFlofiConversation` (`state/flofi-conversation.ts`) commits a validated chat command through the new `commitChatCommand` of the workflow store: the same `editorReducer`, base-revision guard, test-network refusal, undoable history entry and staged-position handling as `applyProposal`, with no ✓/✗. The exact grammar and the Copilot engine still produce the command (the model's output is only ever an untrusted intent validated by `copilotIntentToCommand`, `COPILOT_V2_COMMANDS`, `commandIsValid` and the editor preview). FloFi's confirmation is read from the **stored** workflow once it lands (`describeChatChange`), never from the model's words; the Copilot's interpretation note ("Interpreted as …", carried fields, WETH-not-ETH, catalog resolution) is kept. Missing fields keep the Copilot's existing targeted questions and draft; nothing is committed until every required field is valid. A change that would also drop a step the owner did not name (a composition replacing the workflow, a removal that takes linked steps) is **not** committed from chat: it stays the existing Canvas proposal and FloFi says why. Proposals from the Canvas, automations, MCP, Telegram/WhatsApp handoffs and `/approve` are unchanged; on `/approve` (and `/mcp/approve`) the chat keeps its previous proposal behaviour and has no lifecycle controls. |
| R3 Conversational composition | After each commit FloFi asks "Would you like to add another action or review your workflow?" (options Add another action / Review workflow / Undo; free text works too). Further actions are appended; the editor's dependency rules decide connections (e.g. Solana swap → position funding), never the chat. Corrections ("change it to 2", "set node-002 amount 3"), removals and **Undo** (only while the chat's change is still the latest history entry) keep unrelated steps. Unsupported actions, networks, tokens and pairs keep the engine's refusals; a workflow the runtime cannot simulate as one route is explained ("I can't start the review yet: …"), never routed. |
| R4 Simulate and review in chat | "Review workflow", "Revisar workflow", "Let's review", "simulate" (deterministic phrases, no model) run the **selected runtime's existing simulation** (`simulateAgain`, the Canvas CTA's), without changing tabs. When that runtime already holds an approvable Review it is presented as is. A wrong wallet network offers the shell's existing "Switch to …" wallet request; a missing wallet offers Connect. The Review card is built only from `projectSimulation` and `projectReview` (steps, expected output, minimum, slippage, price impact, fees, limits, approvals, warnings, wallet, network, expiry, planned wallet requests from the record); fees the simulation does not itemize are labelled "Not provided by this simulation". The workflow confirmation binds a `ReviewBinding`: workflow id, revision and semantic hash, runtime, Review authority key, Strategy Manifest hash, wallet, chain and quote expiry (`conversation-lifecycle.ts`). Any change retires it, proactively and again at the answer. |
| R5 Execute in chat | Only a separate explicit "yes" to "Would you like to execute this workflow now?", while the binding still holds and the Canvas lifecycle projection still offers Authorize at that moment, calls the **existing** `useExecutionControls().authorize()` — the same single owner action as the Canvas "Authorize in wallet" button (Review acceptance, then exactly the next wallet request, each half gated at its own boundary). The wallet's own confirmation is mandatory; FloFi never signs and a chat message is never treated as a signature. Multi-request runs (approval then swap) ask again before each next request (`controls.request(true)`, the existing continuation gate). Progress is a live card re-read from the durable execution projection on every render (states, hashes and explorer links, actual received amounts, known costs) plus one message per phase from the record's own labels. Uncertain runs offer only the observation-only Check status (`controls.checkStatus`); nothing is resubmitted. |
| R6 Persistent chat across stages | Conversation state moved from `CopilotPanel` into `useFlofiConversation`, owned by `AppShellContent` (above the stage switch), so Build, Simulate, Execute and Review (inside Simulate) share one conversation and its open question. On Simulate and Execute the chat is a complementary column beside `<main>` (below it under 1280px; a "Copilot" shortcut in the mobile stage navigation). A different wallet owner or a new workflow starts a new conversation; late async answers of an earlier session are dropped. Nothing new is persisted: after a reload, an unresolved run is announced from its durable record ("FloFi restored this workflow's execution from its saved record…"). Learning semantics are unchanged in consent and storage; a committed chat command counts as an applied proposal (canvas corrections are still observed as corrections). |
| R7 Invariants | No change to migrations, fee collection, provider routes, network scope, slippage policy (default 100 bps), amount limits, IR/Manifest identity, signing, nonce/fencing, recovery, reconciliation, evidence, saved workflows, developer API/SDK/MCP, channels or dependencies. The PR #132 UX is not reintroduced. |
| R8 State machine | `conversationPhase` maps to AUTHORING, AWAITING_MISSING_FIELDS, READY_TO_REVIEW, SIMULATING, REVIEW_AVAILABLE, AWAITING_WORKFLOW_CONFIRMATION, WORKFLOW_CONFIRMED, AWAITING_EXECUTION_CONFIRMATION, AWAITING_WALLET, EXECUTING, RECONCILING, COMPLETED, PARTIAL, FAILED, UNCERTAIN — derived from FloFi's open question and the existing records (execution first), exposed as `data-conversation-phase`. Answers are classified deterministically per open question (`classifyAnswer`): hedges, edits or another question's words are UNCLEAR and change nothing; suggested-answer buttons appear only on FloFi's latest message, so an older "Yes, execute" can never answer a newer question. |

## Files

- New: `src/domain/conversation-lifecycle.ts` (+ test), `src/domain/conversation-copy.ts`, `src/state/flofi-conversation.ts` (+ test),
  `src/components/conversation-cards.tsx`, `src/i18n/pt-conversation.ts`, `e2e/conversational-workflow.spec.ts`.
- Changed: `app-shell.tsx`, `copilot-panel.tsx` (presentation only), `copilot-ai.tsx` (`direct` mode, `committed`, `clear`), `artifact-inspector.tsx`
  (card-anchored settings), `composer-card.tsx`, `workflow-canvas.tsx`, `mobile-build-navigation.tsx`, `stocks-settings.tsx`, `workflow-store.tsx`
  (`commitChatCommand`, `undoChatCommit`), `globals.css`, `i18n/pt.ts`, `i18n/pt-product.ts`.
- `scripts/guarded-release-browser.mjs`: the new spec runs in the existing `execution-continuity` profile (same harness, no new profile);
  `scripts/test_ci_optimization.py` pins that profile's spec list accordingly.

## Tests

- Unit: `conversation-lifecycle.test.ts` (binding and every retirement cause, strict answers in EN/PT, lifecycle phrases, phase mapping incl.
  wallet-declined and uncertain runs, Review built only from the projections, change descriptions, unnamed-step protection, PT copy parity).
- Hook integration: `flofi-conversation.test.ts` runs the real editor reducer, Review projection and Canvas lifecycle projection with test doubles
  for stores, wallet and controls: direct commit with no proposal; second action keeps the first; Review → workflow confirmation → separate
  execution confirmation → exactly one `authorize()`; unclear/negative answers; wallet change and quote expiry retire the confirmation; a
  correction retires the Review; editor refusals; Mainnet-only refusal of a test network; Copilot commits; approval context unchanged.
- Browser (`conversational-workflow.spec.ts`, execution-continuity harness: real UI/API/durable runtime, synthetic loopback RPC, scripted
  wallet, MOCKED): full journey to reconciliation with two wallet requests; correction, second action, unsupported pair, Undo, wallet decline
  reported as not submitted; owner change restarts the conversation and a stale "yes" executes nothing; reload during an unresolved run is
  followed read-only with no duplicate submission; PT-BR at 1440 and 390 px with no horizontal overflow.
- Existing specs that encoded "chat → proposal → explicit Apply" or the bottom inspector were updated to the new behaviour, keeping their
  invariants: chat vs Canvas hash equality, revision accounting, the stale-proposal and lock guards (now exercised through the remaining chat
  proposal, a workflow-replacing composition), learning evidence, Copilot interpretation notes and refusals. Golden screenshots that show the
  Build, Simulate and Execute layouts were regenerated; `swap-authoring` `proposal.png` became `chat-committed.png`.

## Validation (local, MOCKED/loopback, final tree)

- `pnpm check` passes: typecheck, lint, build, schema drift and 449 test files / 5,443 tests (2 skipped by design).
- `pnpm test:postgres` on a disposable pinned PostgreSQL (`postgres:18.6-bookworm@sha256:3725f4e2…`, loopback): 81 files / 513 tests pass
  (1 file, 3 tests skipped by design).
- `python3 scripts/governance_lite.py` passes; `test_governance_lite.py` 19/19 and the CI plan tests (`test_ci_*.py`) 64/64 pass;
  `git diff --check` is clean.
- Browser: all 48 guarded product profiles pass with CI's settings (`node scripts/guarded-release-browser.mjs profile <name>` for each), the new
  conversational spec 6/6 inside `execution-continuity`. The separate `composition` phase (pinned BUILD-007 downloads) was not run locally;
  its spec only switched to the chat-commit fixture.
- Golden screenshots regenerated, reviewed and re-run without updating: `visual-shell` build/simulate/execute, `mock-artifact-chain`
  simulate-current/expired/invalidated, `base-observation` observation-recorded/expired, `swap-authoring` review-blocked and the new
  `chat-committed` (replacing `proposal`).
- Non-CI specs `workflow-composer`, `composer-product-cleanup`, `card-numeric-entry`, `build-layout` were updated for the card-anchored settings;
  they are not in the guarded plan and still fail on unrelated stale expectations (fonts, USD estimates, toolbar geometry, wallet header text).
- No public provider, RPC, wallet, transaction or production system was used.

## Limitations and follow-ups

- The chat never signs, approves or submits by itself; each wallet request still needs the owner's wallet confirmation, and a workflow that the
  existing runtimes cannot simulate as one route (e.g. two independent swaps) is refused with the runtime's reason, as on the Canvas.
- Fees a runtime's simulation does not itemize (often network cost before the wallet estimates it, provider fees outside routes, the FloFi fee
  outside the universal route) are shown as "Not provided by this simulation", not computed.
- A chat change that would drop an unnamed step stays a Canvas proposal (✓/✗) by design. The centred empty-Canvas proposal placement (UX-006)
  is no longer reachable from chat (chat requests commit); it remains for other proposal sources.
- An account switch starts a new conversation (owner isolation); a WALLET_CHANGED retirement message is therefore seen only when the binding's
  wallet changes without an owner change (e.g. the wallet-change flag), and is covered by unit tests.
- Browser evidence is MOCKED/loopback only; it proves the UI and lifecycle wiring, not public execution or certification.
