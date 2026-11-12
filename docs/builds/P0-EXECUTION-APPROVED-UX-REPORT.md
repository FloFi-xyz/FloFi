# P0 — Real workflow execution and the approved FloFi App UX (report)

Plan: [P0-EXECUTION-APPROVED-UX-PLAN.md](P0-EXECUTION-APPROVED-UX-PLAN.md). Base `origin/main` `009975a` (PR #175). Branch
`claude/peaceful-galileo-7r9j2j`. **No transaction was signed or sent by this build, no Flight grant, wallet binding or session was created,
no database migration was added, `DEFAULT_LANGUAGE` is unchanged and the staged Railway patch (`FLOFI_BETA_ACCESS`) was inspected and not
applied.** Evidence levels follow [EVIDENCE_LEVELS.md](../EVIDENCE_LEVELS.md): everything below is unit, PostgreSQL or loopback-browser
evidence unless it says otherwise; none of it proves a public mainnet execution.

## Root causes (Track A)

1. **"Simulation failed" was a Flight refusal.** The API refused the owner's flow calls with `BETA_WALLET_NOT_LINKED`: the wallet connected in
   the browser was not linked/boarded for the signed-in FloFi account (a wallet connected but not saved to the account, linked after boarding, or
   held by another account). The API's policy is correct and unchanged; the defect was that the web tier checked only the session's login wallet
   and the refusal reached the UI as an unclassified error, which Next production additionally redacts when thrown from a Server Action.
2. **The certified Router bridge card always said "estimate only".** Its Canvas estimate is read through universal discovery restricted to
   LI.FI/Across, which labels those answers `LIVE_QUOTE`; only Relay answers are ever `EXECUTABLE` there. The certified Cross-chain Router flow
   (BUILD-ROUTER-001/BUILD-BASE-001) does execute exactly these Across routes through the owner's wallet, so the label contradicted the runtime.
3. **The swap output → bridge input dependency was already typed** (`domain/workflow-sequence.ts`: the bridge spends
   `min(authored cap, reconciled delivery − already allocated)` of the exact asset). No change was needed; it is covered by the existing
   sequence and PostgreSQL run suites (`confirm-run.pg`, `universal-runs.pg`).
4. **Blockers had no numbers or next action in the UI language.** A native-fee shortfall was known server-side with its exact numbers but
   reached the owner as a sentence without them, and "explain" while blocked was routed to the model, which once answered "There is no pending
   proposal".

## What changed

### Track A

| Area | Change | Files |
|---|---|---|
| Flight refusals | Every `BETA_*` code maps to what happened, that FloFi stopped **before quoting, simulating or sending anything** (session codes say anything already sent stays tracked — never "nothing was sent"), and the next action (Credentials, Board, Sign in, retry). Shared by the simulation status, build estimate, Editor run, run action and assistant. | `domain/flight-refusal.ts`, `domain/simulation-presentation.ts`, `domain/build-estimate.ts`, `components/editor-workflow-run.tsx`, `components/editor-run-action.tsx` |
| Identity consistency | `flightWalletRefusal(owner)` checks the **same owner wallet** the API will check, against the signed-in session's own Flight principal, and returns the code as a value (open mode: no check; unknown errors: `BETA_UNAVAILABLE`, fail-closed). Used by the whole-workflow Review and as a pre-simulation check from the Simulate action. It creates no grant, binding or session. | `server/flight-access.ts`, `app/flight-wallet-action.ts`, `app/editor-workflow-execution-action.ts`, `components/app-shell.tsx` |
| Bridge executability | A certified-Router Bridge card is labelled executable (simulation and Review still required) only when the node is a Router node, the pair's Router flow reports owner execution on this deployment (`info.executionEnabled`, cached only on success for 60 s), and the candidate is an Across route (Across direct, or LI.FI bridging through Across). Execution still goes only through the existing certified Router flow, which re-gates server-side. | `server/router-capability.ts`, `server/bridge-build-estimate.ts`, `server/build-estimate.ts` |
| Bridge failures | Liquidity unavailable, below the provider minimum and no executable route are named in plain words. | `domain/simulation-presentation.ts` |
| Fee evidence | `USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE` carries the server's own `NativeFeeShortfall` (balance, max fee, native spend, required, shortfall in wei) to the owner's own Review; the UI rounds what is missing **up** and the balance **down**. | `user-funded/groups.ts`, `editor/workflow-execution.ts`, `domain/approved-ux.ts` |

### Track B (boards 03–15, handoff board 16)

- **Navigation (03/03b):** no Dashboard | Chat | Editor tabs; the Create → Simulate → Execute stepper sits in the top bar (current filled,
  reachable outlined, closed muted — never a check mark); wallet identity with its network; the drawer lists New workflow, Editor, Dashboard,
  Library (Your workflows, Automations), Access (Credentials, Agents, Passkeys) with non-clickable status tags, Log out and Terms · Privacy;
  Disconnect stays only on the compact `/approve` header.
- **Chat entry (03):** one primary action (Create workflow), template chips that select the first placeholder, no secondary links.
- **Create (04) / Choose network (05):** canvas tool rail, contextual step toolbar, More options menu, significant amounts, "Max price
  difference"; network answers as a list of network buttons tagged "Your wallet"; the footer says "Choose the network in the chat to simulate".
- **Simulate + Review (06):** from 1200 px the Review panel opens beside the canvas (what is authorized, minimum received, network fee at most,
  token permission, Technical details collapsed); below 1200 px it is collapsed under the canvas. It has no authorize control: the footer keeps
  the one lifecycle button and shows a ticking validity countdown (attention under 15 s).
- **Blocked (07):** the blocker replaces the Review panel: "Not enough ETH on {network} for the network fee", You have / The fee can reach /
  Missing, at least (server numbers), Copy address; Flight blockers link to Credentials / Board / Sign in; raw codes only in Technical details.
  "Explain" while blocked is answered with that blocker, in the interface language.
- **Confirm in wallet (08):** while the wallet holds a request the run panel shows "EXECUTION · REQUEST n OF m" (no total when the Review only
  knows a lower bound), "Confirm in your wallet" and the prepared calls in plain words; editing the canvas pauses during execution.
- **Pages (10–15):** Dashboard, Your workflows, Automations, Credentials, Agents and Passkeys follow the boards (one Coming soon / empty state
  where a capability is not enabled, Advanced settings and Danger zone collapsed, no controls that do nothing).
- **Card settings (04/16):** "Adjust" on a swap or bridge card opens settings that take the limit as "Max price difference (%)" (the command
  still carries exact basis points; a percent with no whole basis point is refused, never rounded); the settings name the network without its
  chain id and state the review's checks in plain words. The top bar's wallet chip and network-switch strip say "Base", not "Base (8453)".
  The chat's automation proposal card shows its limits in percent.
- **Tokens and language:** light and dark values from board 16 §5 as CSS variables; PT-BR throughout (no Portugal forms, "fluxo" for
  workflow, "passo" for steps); the assistant answers in the active interface language.
- **Preserved (18.1):** automatic canvas card connections (typed bindings), Review binding, authorization, execution groups, server refusals,
  recovery and reconciliation are unchanged.

## Mandatory regression: Arbitrum One Swap 0.001 WETH → USDC, then Bridge 2 USDC Arbitrum One → Base

| Stage | Status | Evidence |
|---|---|---|
| Flight access of the connected wallet | Refused early and named when the wallet is not linked/boarded; linked wallets proceed unchanged | unit (`flight-access.test.ts`, `flight-refusal.test.ts`) |
| Swap simulation (Uniswap V3, Arbitrum One) | Unchanged runtime | existing suites |
| Bridge card label | Executable only when the Router flow reports owner execution and the route is Across | unit (`bridge-build-estimate.test.ts`) |
| Bridge amount | `min(2 USDC, reconciled swap delivery)` | existing `workflow-sequence` / `confirm-run.pg` / `universal-runs.pg` |
| Wallet interactions | Stated by the Review before authorization (`counts`: prompts, signatures, transactions, batched calls, switches; "at least" when a step's own flow may ask again). Not measured on mainnet. | Review projection |
| Provider limits | At diagnosis time Across answered live for 2 USDC Arbitrum → Base (≈ 1.996276 USDC expected); minimums and liquidity are read per quote and now named when they block. | API discovery logs (read-only) |
| Public mainnet execution | **Not performed.** It requires the owner's own wallet action; no receipt or reconciliation exists from this build. | — |

## Validation

See the PR for the final CircleCI certification. Local results on this branch:

- Unit (Vitest, all workspaces except PostgreSQL/fork/live/remote): 597 files, 7 276 tests passed, 2 skipped (pre-existing).
- Focused re-runs after the PT-BR sweep and Board 08: passed.
- PostgreSQL suites (server, workflow runs, user-funded, backend): 42 files passed; `backend/developer-admin.pg.test.ts` timed out at
  Vitest's 5 s default while browser profiles shared the 4 CPUs (no backend file changed on this branch; CircleCI is the authority).
- Typecheck, ESLint, production build, schema drift (11 exports), governance-lite (+21 unit tests): passed.
- §18.1: `domain/p0-swap-bridge-connections.test.ts` asserts, for the reported Arbitrum Swap → Bridge, the typed dependency on the exact
  Arbitrum USDC, the visible connection, `min(2 USDC, reconciled delivery)`, no orphan after deletion, Undo under a newer revision (a prior
  Review is never reused) and that moving cards never changes order or funding.
- Browser (loopback, pinned headless shell 1243, local): the e2e helpers and ~100 specs were migrated to the new navigation without skipping or
  deleting a test; profiles run locally include canvas-corrections, review-execute-recovery-components, copilot, universal-bridge,
  approve-authorize-journeys, execution-continuity (`workflow-ux-execution` 6/6 after the preflight fix), workflow-acceptance, automations,
  the Arbitrum/Ethereum/Base/Robinhood authoring certifications, mcp-in-chat, channel-signing, auth-wallets, flight and chat-automations. The
  default-product screenshot baselines are CircleCI's own renders of this branch, each inspected before it was adopted: this sandbox's
  headless shell renders fonts differently, so a baseline made here cannot match CircleCI pixel-exactly. The comparisons stay pixel-exact
  (`maxDiffPixels: 0`). `build009` needs the public LI.FI host, which this sandbox cannot reach; CircleCI runs it.

## Specialist reviews (read-only, advisory; CircleCI remains the certification authority)

Six reviewers ran in two batches of three (`flofi-security`, `flofi-workflow`, `flofi-bridge`; then `flofi-frontend-ux`, `flofi-chat`,
`flofi-wallet-execution`). None reported a blocker. Every finding was checked against the code; the dispositions:

| Reviewer | Finding | Disposition |
|---|---|---|
| bridge | HIGH: the browser's `estimateMatchesNode` rejected the new certified-Router estimate (the card would lose its amount) | Fixed: one shared `certifiedRouterRoute` predicate; accepted only for a Router node's Across route; tests assert both acceptance and refusal of a forged label |
| bridge | LOW: card provider vs the Router's AUTO order; cache staleness; regex breadth | Fixed order (AUTO: LI.FI first) and narrowed codes to bridge providers; the ≤ 60 s positive cache is accepted (execution re-gates server-side) |
| workflow | MEDIUM: Board 08 call list could describe the wrong group; canvas lock could outlive a run; edits still reachable during execution | Fixed: run group + prepared counts, no guessed group; lock from the run's own state; graph `inert`, keyboard/connect/rebuild guarded |
| workflow | LOW: fee overstated when the request also sends ETH | Fixed: fee ceiling shown apart from the native amount sent |
| security | LOW: Flight copy implied nothing was sent; preflight could mask a run's own state | Fixed: "this request was not quoted, simulated or sent"; never masks a record, recovery or live run |
| wallet-execution | MEDIUM: preflight checked the whole workflow's wallet kind, not the step's signer; a refusal could be swallowed | Fixed: the step's own signer by chain family; a run-safe notice when the run keeps its own words |
| wallet-execution | LOW: following an earlier run locked the Canvas; confirm-update after HALTED; header wording; gating before hand-out | Fixed |
| frontend-ux | HIGH: countdown re-announced every second; "Nothing was sent" after an earlier step ran | Fixed: announced only on meaning change; footer reads every sign of a run, restore or executed step |
| frontend-ux | MEDIUM/LOW: entry button with existing steps, mobile Review shortcut, entry focus, dark border contrast, Send enabled when empty, PT-PT leftovers, touch targets, stepper semantics, copy status, blocked Review collapsed, two network detectors, header height | Fixed |
| chat | MEDIUM: explain reply said "Nothing was sent" after a request landed; "reply in Portuguese" promised but overridden | Fixed: `aboutNextRequest` after a start; the statement points to Settings › Language |
| chat | LOW: explain hid open-question buttons / cancelled auto-continue; PT "fluxo" phrasings; options matched in one language | Fixed |

A second round covered the remaining domains the owner listed, and an adversarial verification pass (independent skeptics per area, each
claimed defect re-checked) covered the two review-fix commits:

| Source | Finding | Disposition |
|---|---|---|
| verification | HIGH: a Flight refusal was still silent on the `/approve` signing surface | Fixed: the notice renders on every shell that calls `simulateAgain` |
| verification | MEDIUM: a simulation-only record suppressed the refusal; a resumable HALTED run unlocked the Canvas; chat edits bypassed the lock; Aave liquidity codes fell to "balance too low"; `STALE_CHAIN_HEAD` read as "expired" | Fixed, each with a test |
| e2e migration | Product bug: Simulate stayed enabled while Flight was being asked (a second click could start a second simulation) | Fixed: the preflight locks the control; `workflow-ux-execution` 6/6 |
| mcp | LOW: the preflight checked fewer wallets than the flow boundary; the `/approve` notice had no action link; "session ended" for a first visit | Fixed |
| data-privacy | LOW: a learned language observation without independent evidence when the interface language governs | Fixed: not observed then |
| infrastructure-ci | LOW: `router-capability` untested; cancel signal ignored; cache keyed by network only | Fixed: own suite, signal passed, keyed by runtime and API |
| infrastructure-ci | Question: does the Router `info` read carry a beta identity? | Yes: `/api/build-estimate` runs inside `withFlightAccess` |
| infrastructure-ci | Risk: pixel-exact baselines regenerated outside the CircleCI image | Regenerated with the pinned headless shell 1243 and re-run pixel-exact locally; CircleCI is the authority |

No reviewer found a blocker or an unresolved P0/P1 security or financial-integrity issue; the MCP contract, schemas and approval payloads are
unchanged (the fee evidence never reaches MCP, channels or run views).

Accepted and left as documented limits: rail buttons' accessible names ("Add swap") differ from their visible labels in PT (WCAG 2.5.3; e2e
selectors depend on them); the graph is removed from the accessibility tree while execution pauses editing (the Execute section lists every
step); the chat may still apply an edit during execution (the server binds the reviewed workflow hash, so no wallet impact); a learning note
"first below" can disagree with the wallet-first network order; the drawer is not modal for the page behind it.

## Remaining issues

- Fee-shortfall **numbers** reach the blocker panel for whole-workflow (user-funded) Reviews; the single-step catalog path still states the
  shortfall without numbers (it needs the flow's own evidence carried through the backend result).
- The chat keeps its explicit conversational confirmation ("Do you confirm this workflow?") as an alternative path to the same wallet flow;
  the footer is the only "Authorize in wallet" control.
- Basis points still appear in some advanced forms the main Editor path does not open: Uniswap/Orca liquidity, the Jupiter (Solana) swap,
  the Aave lending composition editor, the legacy Base → Optimism bridge and delegated automation limits. Each sits in its own settings form; the
  swap and bridge cards' "Adjust" path is in percent.
- Board 05's optional "a similar step exists" question and post-choice confirmation chips are not implemented.
- Real-mainnet execution of the regression workflow remains unverified until the owner runs it with their own wallet.
- Owner design confirmations (implemented per the boards, reversing earlier choices): a quoted amount shows 6 significant digits with the exact
  value in its title (UX-FIX-003 showed it exactly); the chat field is 16 px only on touch pointers; the portfolio filter field is 40 px next to
  a 36 px Refresh pill.
- A few historical e2e specs that no CI profile runs (canvas-navigator, workflow-composer, build-layout, stage-workspace-layout,
  shell-navigation-refinement, workflow-save-environment, dashboard-foundation, shell-cleanup) still describe parts of the previous shell; they
  certify nothing today and can be rewritten or retired in a follow-up.
