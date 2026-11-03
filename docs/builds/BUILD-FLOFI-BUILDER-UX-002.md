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
