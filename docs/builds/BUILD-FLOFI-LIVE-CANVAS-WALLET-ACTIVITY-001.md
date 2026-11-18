# BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001

Three frontend/read-path workstreams on top of `origin/main` 407c383 (PR #212). Nothing in the workflow engine, compiler, executor, transaction
construction, calldata, adapters, quotes/routing/slippage, signing, wallet approvals, submission, reconciliation, canonical execution states,
Smart Account execution, gas sponsorship, fee collection, automation scheduling/triggers/policies, or authentication/authorization requirements
was changed. No new provider, paid subscription, mandatory environment variable, infrastructure service or database migration was added.

## A. Live Canvas — the existing Canvas is the execution view

### Before

- Execute replaced the Canvas with a text timeline (`ExecutionTimeline`) as soon as a single-runtime run was live.
- A whole-workflow run (Review once / Authorize once) kept the Canvas in Execute, but its cards never showed progress.
- A step-by-step workflow showed a "next step" panel instead of the Canvas between steps.

### After

- `src/domain/canvas-execution.ts` (pure, presentation only) projects the records the Editor already follows onto the Canvas's own node ids:
  - **one runtime**: the lifecycle's steps are the workflow's composer nodes (`step.id === nodeId`), phased by the shared `lifecycleStepPhase` /
    `stepReconciled` (the same functions Execute, the Assistant and the Dashboard use);
  - **step by step**: completed sequence steps (reconciled records) are done; only the current step's own lifecycle colors its card;
  - **whole-workflow run**: run step *i* is the *i*-th node of `sequenceOrder`, the order `editor/workflow-strategy.ts` builds the run's strategy
    from, accepted only for the exact workflow id **and revision** the run was authorized for (`authorizedFor`, from the Editor's stored record)
    and the same step count.
- Visual states (never new domain states): waiting (neutral) · active (blue, subtle pulse) · in your wallet (blue + wallet icon) · in progress
  (blue + progress icon; submitted, confirmed at source, awaiting/observed destination delivery) · completed (green + check, only
  `RECONCILED`/`COMPLETED`) · needs attention (amber; unknown outcome, a declined/expired/not-submitted request) · failed (red).
- Connections take their dependency's record: green once the source step is reconciled, blue (animated) while the step it unlocks is in flight,
  red/amber when the source failed / its outcome is unknown; never from position or order.
- The same cards (same nodes, positions, sizes, links, icons, content) are colored; a badge sits over the card's top edge and a 1px ring is drawn
  with `box-shadow`, so geometry never changes. `prefers-reduced-motion` turns every animation off. While a workflow executes, cards stop asking
  for live quotes (no request is added by the visualization).
- Execute keeps the Canvas while the run is live; the step timeline (hashes, receipts, evidence, errors) moves into **Execution details**, collapsed
  while the run progresses and open once a result exists or something needs attention. Status, recovery controls, warnings and uncertain
  outcomes stay visible outside it. The Build Canvas shows the same states while editing is paused.
- A record that is not the Canvas workflow's (another workflow or revision, a detached run, a saved run without its plan) colors nothing and Execute
  falls back to the timeline. Chat-only flows are unchanged; the Canvas is never opened automatically.

## B. History — received and sent wallet activity

`/app/workflows` (the History) gains **All · Workflows · Received · Sent**. Workflows is the existing list unchanged; All adds the wallet activity
under it; Received/Sent show the activity filtered by direction. The activity loads from its own same-origin GET route
(`/api/dashboard/activity`) — restricted to a wallet this browser proved or the signed-in account holds (`historyPrincipals`) — so a slow or failing
provider never delays FloFi's own records.

### Network coverage

| Network | Source (already configured) | Native | ERC-20 / SPL | Internal native (in contracts) | Token-2022 | Status shown |
| --- | --- | --- | --- | --- | --- | --- |
| Ethereum | Alchemy Transfers API (`GRYLOO_ALCHEMY_API_KEY`) | yes | yes | yes | — | Covered |
| Base | Alchemy Transfers API | yes | yes | **not listed** | — | Partial ("transfers made inside contracts are not listed") |
| Arbitrum One | Alchemy Transfers API | yes | yes | **not listed** | — | Partial |
| Robinhood Chain | none configured | — | — | — | — | Not supported ("not available on this network yet") |
| Solana | deployment Solana RPC (`GRYLOO_SOLANA_RPC_URL` or the pinned public RPC) | yes | yes (wallet + up to 6 token accounts of verified mints) | — | yes (base units) | Covered; Partial beyond 6 token accounts |

A network the deployment does not enable is OFF; a failed or slow network is UNAVAILABLE on its own ("could not be loaded right now. This does
not mean there is none."). No network is ever presented as an empty history when it could not be read.

### Integrity

- Only verified catalog assets are named (symbol and decimals from FloFi's catalogs, never from the provider); other tokens and decimal mismatches
  are counted as hidden (spam protection).
- A transaction that both sends and receives the wallet's assets (swap, liquidity, bridge leg) is one **Contract interaction**, never two transfers;
  mint/burn and self-transfers are labeled; sender/recipient only where the chain data names it.
- **FloFi workflow** is shown only when a loaded FloFi execution record carries the same transaction; in All those movements are left to the
  workflow record (deduplicated), in Received/Sent they are listed and marked.
- Bounded: 20 transfers per network and direction per page (Alchemy `maxCount`), 10 signatures per Solana address, 12 Solana transactions per
  page, a 10 s budget with each network isolated, an opaque wallet-bound cursor, in-flight request joining and a 30 s per-wallet cache (5 s while a
  network is unavailable). EVM transfers are "Confirmed" (included in a block); Solana uses the cluster's `confirmed`/`finalized` status.

### Limitations and what would remove them

- **Robinhood Chain**: no indexed history source is configured. Options needing owner approval: the public Blockscout API of
  `robinhoodchain.blockscout.com` (free, no key; a new external dependency) or an Alchemy/indexer plan that serves chain 4663. A bounded RPC log
  scan is not used: it cannot see native transfers and a useful window would be unbounded.
- **Internal native transfers on Base/Arbitrum One**: the Alchemy Transfers API lists `internal` on Ethereum only; covering them needs a trace
  provider (`debug_traceTransaction`/`trace_filter` capable plan) — a cost decision.
- **Provider cost**: each History open reads at most 6 Alchemy calls (2 per EVM network, ~150 compute units each on Alchemy's pricing); cached 30 s.
- **Solana**: incoming transfers into token accounts beyond the first 6 verified-mint accounts are not listed (reported as Partial); Token-2022
  amounts are base units of the mint's decimals (Scaled UI Amount display rules are not applied in activity).
- **Origin deduplication** is as complete as the loaded execution records' attempts (records whose attempts were not read are not matched; the
  transfer then appears without a FloFi mark — never mislabeled).
- External bridges/swaps of other apps are labeled from chain data only (a one-way receipt from a relayer reads as "Received from …").

## C. Loading performance

### Automations

Root cause: the page called `automationsAvailability()` and then `automationOverview()` — two **Server Actions in sequence**, and Next.js dispatches
a page's Server Actions one at a time per client, so both waited behind every action already queued on the page (the ~60 availability checks of a
page load, previews, observations). The overview was also requested twice on open when the wallet was already proven (the `proof.proven` effect
fired on mount), and a temporary availability failure was shown as the permanent "Coming soon" state.

Fix: one same-origin GET (`/api/automations/overview`) runs availability and the owner-scoped overview **in parallel** (same `withFlightAccess`
and `automationOperation` owner verification), concurrent readers share it (workspace and proposals notice), refreshes read the overview only,
the duplicate read is gone, stale responses are ignored, existing data stays during same-owner refreshes, and a temporary failure shows
"temporarily unavailable" with Retry. Mutations remain Server Actions.

### My Account (Settings)

Root cause: the presence read (`accountPresence()`) was a Server Action — queued behind the page's other actions — even though the product
layout already verifies the same session at render (for the chat scope). Fix: `currentAccountBootstrap()` returns both from that one verified
read; the page seeds the shared presence once (fresh for 30 s), so My Account is shown at the first open; the fallback read is a GET
(`/api/account/presence`). Never assumed signed in (unknown → the existing placeholder and read), never persisted, forgotten on a session change.

### Measurements

See the PR description (local production builds of the base and this branch, same machine and profile).
