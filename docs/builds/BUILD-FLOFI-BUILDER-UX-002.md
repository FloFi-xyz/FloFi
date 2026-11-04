# BUILD-FLOFI-BUILDER-UX-002 — Canvas step cards, operation summary, flow placement and quiet links

Owner request: bring the Create (Builder) Canvas closer to the approved builder reference (`builder-visual-brief-2026-10-11`:
`REFERENCIA_APROVADA.png`, `INSTRUCOES_PARA_ALRIMAR.md`) and the new landing's visual language: compact step cards that summarise the real
operation, a new step that takes its place in the flow, links only where the workflow really depends, cleaner edges and handles, a discreet
selection. Presentation and view-model only: no engine, IR, command, store, adapter, Manifest, API, persistence, wallet or execution change.
No production change, migration, environment variable, deploy or merge. Branch `claude/tender-hamilton-wp23gi`; one PR.

## What changed

**Compact step card** (`components/composer-card.tsx`, `app/globals.css` — the appended `BUILD-FLOFI-BUILDER-UX-002` block, Build Canvas
only). Same component, controls, classes and bindings; what is new is presentation:
- Top row: the action icon becomes a small FloFi-blue tile beside the unchanged `N. Action` title (the step number and action stay one
  text, as every suite reads them).
- A one-line **flow** under the protocol · network row (`.composer-operation`), from the values the card shows: `USDC → WETH`,
  `USDC · Base → Arbitrum`, `USDC → USDG · Base → Robinhood Chain`, `USDC → Aave V3` (Supply/Repay), `Aave V3 → USDC` (Borrow/Withdraw),
  `USDC → 0x3333…3333` (Send, only once its To field holds a valid recipient; "Your connected wallet" for owner-only sends). It never
  repeats an amount, so it cannot disagree with a draft in the value boxes. Liquidity cards have none (an earlier owner cleanup removed
  `USDC / WETH` from them; their two value boxes name both assets).
- **Summary rows** (`.composer-params`, a `dl`) like the reference's "Slippage (máx) 0,50%": `Max slippage` (FloFi's shared
  `formatSlippage`, e.g. `1% (100 bps)`) and `Fee tier` (`0.05%`), read only from the canonical step; hidden while a network, pair or route
  draft on that card could change them. Drafts that are not steps yet have none.
- Card: 236 px, 14 px radius, lighter border and shadow; hover tints the border; selection is a 1 px FloFi-blue border plus 1 px ring
  (no glow); the invalid red border is re-asserted. Value boxes are slightly tighter. Reduced motion: no transition.
- Handles: 9 px, `--edge-line` grey, FloFi blue when the card is hovered or selected or a link is being drawn — except an input the
  workflow refuses, which keeps BUILD-FIX-UX-001's red drop-target cue. Their hit area (19 px, growing on hover and with zoom-out) is
  unchanged. The invalid red border also holds on hover.

**View-model** (`domain/canvas-card-summary.ts`, new): `canvasCardFlow(summary, recipient)` and `canvasCardParams(node)`.
Slippage comes from the step's `MAXIMUM_SLIPPAGE_BPS` constraint or, for Router / universal bridge / Jupiter steps, from their encoded
fields, formatted by `formatSlippage`. The fee tier is the canonical `fee-tier` input (millionths: `500` → `0.05%`). A bridge whose output
asset is not chosen yet shows its route only.
A value the step does not hold is left out — nothing is quoted, estimated or inferred, and no status is added.

**Truthful links** (`components/workflow-canvas.tsx`). Edges are still exactly `composerConnections(workflow)`: the workflow's own
dependencies and resource edges. Adding a step never dispatches `CONNECT`: that command adds a dependency (or binds an output), which is
authoring and would change execution order, so a link appears automatically only when the step really consumes another — compositions the
engine already links (Solana swap → position, lending, bridge → swap), or a link the owner draws. Independent steps (including the steps
of an `ADD_SEQUENCE`, which the engine defines as independent) stay unlinked; their order is the step number. Presentation: bezier curves
(`type: 'default'`) at 1.5 px with a small arrow; a link that only orders two steps is labelled `Then` (`Depois`) instead of
"After previous step", which did not fit between cards and was clipped (its accessible name is "Then: after the previous step"); value
links keep their label. Edge labels now go through the PT/EN catalog (they were English-only). A label is kept on every link: it is also
the link's click target, and without it a level link has a zero-height box.

**Flow placement** (`domain/canvas-layout.ts` `flowCanvasPositions`, used by the Build and Simulate canvases and by the history commit that
pins positions). A stored position is kept. A step without one — a step the chat or a proposal just applied — goes to the right of the step
it depends on (a linked pair reads left to right; a chain continues on the next row after the third column), otherwise to the next free
reading-order slot; it never lands on a card the owner placed or on the card being set up. Reading-order slots are 320 × 300 px apart (were
270 × 190, which overlapped cards from the fourth step on and left no room for a link); the lending composition's column uses the same
300 px row (was 230, now shorter than its cards). The toolbar's free-slot check uses the same clearance. Layout only: a position never
creates or implies a dependency. Because an unplaced card is placed relative to the others, `editor-history.ts` pins every shown card
exactly where it is drawn (`shownCanvasPositions`, the same function as the render) whenever the layout changes — a commit (including the
step the chat just added), a move, a duplicate, starting or cancelling a setup — so no card the owner did not touch ever moves.

**PT/EN**: `i18n/pt-builder-canvas.ts` (new keys only: `Fee tier`, `Then`, its accessible name, the lending link labels and the lending
Swap's flow line). `Max slippage` and `Your connected wallet` reuse existing translations; other flow lines are assets, networks and
protocols and stay as they are (unit-tested).

## Reused, not changed

`composerSummary`, `composerConnections`, `composerNodeState` and `composerActions` (domain/composer-presentation.ts); every card
handler and editor (`amountEditor`, `actionSelection`, `networkSelection`, `tokenSelection`, `recipient`, `supplyProposal`,
`poolProposal`, `onOpenSettings`); the CONNECT / DISCONNECT rules (`checkConnection`); undo/redo history, drag (`moveCanvasNodes`),
marquee and keyboard selection; `InsertionViewport` fitting; the Settings dialog; Simulate's read-only inspection card.

## Validation

See the PR description for the exact commands and results of this branch (unit tests, typecheck, lint, build, schema check,
governance, agent guard, browser profiles) and the before/after evidence in
`apps/reference-dapp/e2e/visual-evidence/build-flofi-builder-ux-002/`.

## Specialist reviews

flofi-workflow and flofi-frontend-ux (read-only) reviewed the change; the other 17 domains were not invoked (no wallet, authorization,
adapter, API or channel code changed). Every finding was verified and fixed: an unplaced card could move when another card was duplicated,
moved or set up (now pinned, with unit tests); the toolbar's smaller overlap check; the blue handle rule hiding the red invalid-target cue;
stale rows during a draft; an empty bridge destination read as a same-asset bridge; the shared slippage formatter; the PT lending flow line;
the invalid border on hover; the "Then" label's accessible name; long linked chains. Browser runs also caught two regressions from the taller
cards, both fixed: the lending column spacing, and an "Amount locked" tag (dropped — the lock is shown in Settings) growing a card under the
zoom control after its insertion fit.

## Differences from the reference that remain (real reasons)

- **Status per card** ("Pronto / Requer atenção / Aguardando"): not added. The existing card status is shown only where the owner must act;
  `build-correction.test.tsx` and `composer-product-cleanup` deliberately keep quiet Swap/Bridge cards free of status chips. No new status
  vocabulary was invented.
- **Header "…" menu**: the card's existing Settings control stays in the footer (suites pin its text and position).
- **Navy titles**: titles stay FloFi blue — several suites use the title colour as the reference blue.
- **"Início" / "Verificar" / "Adicionar ação" pseudo-cards, fees, price impact, estimated outputs as rows**: illustration or data the
  workflow does not hold at Create time; the value boxes keep the live estimate exactly as before.
- **Vertical tool rail, workflow header, FloFi side panel and bottom bar** of the brief: outside this build's scope (Canvas cards and links).
- **Mobile**: positions are stored per workflow, not per viewport, so a 390 px Canvas still fits the same row (as before this build).

## Part 2 — the owner-approved Editor brief (seven priorities and the stepper)

Owner decision (2026-11-04): complete the Builder in this PR — not only cards and links — with the brief's seven priorities and a
Create → Simulate → Execute stepper inside the Editor, using the approved Artifact's tokens (palette #041B3D / #2343D9 / #4B5B73 / #D9E2EC /
#F5F8FB / #C9D2F8, Outfit with IBM Plex Mono labels, numbered circles, pill radii). Statuses must be discreet and technically true; "Configured"
never means approved, simulated or executable. Presentation and view-model only: no engine, IR, command, store, adapter, Manifest, API,
persistence, wallet or execution change. No deploy, no merge.

| # | Brief priority | What the Editor does now |
| --- | --- | --- |
| 1 | Canvas protagonist, compact FloFi panel, functional bottom bar | The Canvas fills the window (`clamp(560px, 100svh − 330px, 980px)` on desktop; the previous 820 px on phones); the FloFi panel is 320 px (was 340) with a compact head; the bottom bar is sticky and functional (priority 7). |
| 2 | Header: editable name, networks, real state | The Canvas head holds the existing rename/save/automate controls (the untouched default name is shown in the interface language; renaming still edits the name itself and an unchanged field renames nothing), one chip per network the steps use (a bridge names both sides), and the workflow's real state: No steps yet, Draft (unapplied changes), Needs attention (a review finding, a step that could not be reviewed, or a refused edit) or Configured. |
| 3 | Toolbar reorganized, PT overflow fixed, existing vertical rail | On desktop the existing floating rail is the default home of the 11 step actions; the utilities (duplicate, undo, redo, delete, dock) have their own small toolbar at the Canvas's top right. The docked row (an owner's remembered choice, and the phone default with 44 px targets) wraps instead of overflowing — UX-008 now checks it in English and Portuguese at 1440/1536/1920 px. |
| 4 | Compact cards, numbered circles, discreet true status | The step number sits in a blue circle (the title's text stays "N. Action" for assistive technology and the suites); one small status pill at the card's foot: Draft (an unapplied edit or the card being set up), Configured, or Needs attention (the review's blocking finding or warning, in plain words; or "could not be reviewed"). `canvasCardStatus` reads only `composerNodeState` and the Canvas drafts; simulation and quote requirements never count. Configured says "Simulation, Review and your signature come next." |
| 5 | Links, handles and zoom coherent with the engine | Links are still exactly `composerConnections` (nothing dispatches CONNECT); their "Then" and value labels now read the same in Simulate (`canvas-edge-style.ts`). The zoom control gains − / + bounded by the engine's own 0.35–1.4 range and sits bottom right; fitting keeps cards clear of the rail. |
| 6 | FloFi panel: dynamic summary, access to the step needing attention | A "Workflow summary" above the unchanged conversation and composer: every step with its status (the card being set up included), the networks, the state, and the first step that needs attention with "Show step", which selects the card, brings it into view and moves focus to it (`CanvasFocus`; nothing is edited). |
| 7 | Bottom bar: count, real notices, Simulate CTA, no duplicate | The footer states the count; one live notice ("N steps need attention" + Show step, a refused edit, "N changes not applied yet", or "No step warnings" — said only while Simulate is open); and hosts the existing Canvas lifecycle control (`simulateAction`, same handlers and gates) moved from the Canvas corner — rendered once, wrapper still `.canvas-primary-action`. |
| — | Stepper Create → Simulate → Execute | Inside the Editor, on all three sections, with the same `setTab` targets and refusal as the former footer "View simulation / View execution" (they moved, they are not duplicated). Only the current step is highlighted; an earlier step is never shown as done. Dashboard / Chat / Editor is unchanged. |

Files: `domain/editor-overview.ts` (+ tests), `components/editor-stepper.tsx` (+ tests), `components/editor-overview-panel.tsx`,
`components/canvas-edge-style.ts`, `app/editor.css` (new; imported by the product layout — the Review theme test forbids literal colours after
its marker in `globals.css`, so the Editor's token block lives in its own file; dark mode maps the tokens to the approved graphite palette),
and edits to `app-shell.tsx`, `summary-bar.tsx`, `workflow-canvas.tsx`, `composer-card.tsx`, `canvas-navigator.tsx`, `copilot-panel.tsx`,
`workflow-name.tsx`, `simulate-workflow-canvas.tsx`, `domain/canvas-layout.ts` and `i18n/pt-builder-canvas.ts`.

Tests replaced because the approved decision supersedes them (each keeps or strengthens its intent): `canvas-cta` (the CTA is in the footer,
once; the Canvas takes the space; pulse and reduced motion unchanged), `canvas-workflow-ux` UX-008 (rail + docked row in EN and PT instead of
the single top row that overflowed in PT), `canvas-ux` toolbar tests (rail by default), `build-correction` (one status pill instead of none; no
Canvas-hosted CTA), `summary-bar` (stepper replaces the footer's section buttons), the `editorSectionAction` helper (stepper). New:
`e2e/editor-redesign.spec.ts` (in `default-product`), `editor-overview.test.ts`, `editor-stepper.test.tsx`.

Specialist reviews (read-only): flofi-workflow, flofi-frontend-ux, flofi-infrastructure-ci. Fixed: a workflow whose review failed read as
"Draft / not applied" (now Needs attention, "could not be reviewed", and `reviewError` counts as a refused edit); copy that asserted a
simulation state; "No warnings" beside a closed Simulate; engine slippage messages shown with internal names (plain words now, PT/EN);
several live regions announcing the same change (the footer is the one live region); untranslated node labels focused by Show step; a
rename on an unchanged field; CTA styles reaching other lifecycle buttons; touch targets on coarse pointers; a rail flash on phones; Simulate
links without labels; the overview computed off the Editor; unregistered suites in the coverage map; toolbar test helpers that did not wait.
Not changed (documented): the stepper explains a closed step through `title`, exactly as the former footer buttons did.

Pixel baselines are intentionally not regenerated in this commit: the owner validates the visual first, and they must be rendered in the CI
image. Affected: `visual-shell` (build/simulate/execute), `swap-authoring` (chat-committed, review-blocked), `base-observation`
(observation-recorded) and `mock-artifact-chain` (two). Evidence: `apps/reference-dapp/e2e/visual-evidence/build-flofi-builder-ux-002/part-2/`.
