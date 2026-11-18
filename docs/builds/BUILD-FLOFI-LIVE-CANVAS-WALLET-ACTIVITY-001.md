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
| Base | Alchemy Transfers API | yes | yes | **not listed** | — | Partial ("ETH moved by contracts (internal transfers) is not listed") |
| Arbitrum One | Alchemy Transfers API | yes | yes | **not listed** | — | Partial (same note) |
| Robinhood Chain | none configured | — | — | — | — | Not supported ("not available on this network yet") |
| Solana | deployment Solana RPC (`GRYLOO_SOLANA_RPC_URL` or the pinned public RPC) | yes | yes (wallet + up to 6 token accounts of verified mints) | — | yes (base units) | Covered; Partial beyond 6 token accounts ("only the first 6 token accounts of this wallet are read…") or when a transaction cannot be read ("some transactions could not be read right now…") |

A network the deployment does not enable is OFF; a failed or slow network is UNAVAILABLE on its own ("could not be loaded right now. This does
not mean there is none."). No network is ever presented as an empty history when it could not be read.

### Integrity

- Only verified catalog assets are named (symbol and decimals from FloFi's catalogs, never from the provider); other tokens and decimal mismatches
  are counted as hidden (spam protection). Each hidden movement carries a token-free key (chain, transaction, direction, log position or ordinal),
  so a movement read again on a later page is counted once.
- A transaction that both sends and receives the wallet's assets (swap, liquidity, bridge leg) is one **Contract interaction**, never two transfers —
  also when the other side is an unverified (hidden) token: the page carries the direction of each hidden movement (`hiddenMoves`, never the token),
  so selling a memecoin for USDC is never shown as "Received USDC"; mint/burn and self-transfers are labeled; sender/recipient only where the chain
  data names it.
- **FloFi workflow** is shown only when a loaded FloFi execution record carries the same transaction; in All those movements are left to the
  workflow record (deduplicated), in Received/Sent they are listed and marked. The panel says exactly that ("A transaction FloFi matches to a
  workflow record above is shown with that record"), never that every FloFi transaction is.
- Bounded: 20 transfers per network and direction per page (Alchemy `maxCount`), 10 signatures per Solana address, 12 Solana transactions per
  page (failed transactions are never fetched), a 10 s budget per network — its deployment-gate read included — that aborts the remaining
  reads, in-flight request joining (a read is joined until it settles, however long its networks take), a 30 s per-wallet cache (5 s while a
  network is unavailable), at most 12 uncached reads per wallet per minute and 90 Alchemy activity calls per minute
  per server instance (so History can never take the shared key's throughput from the bridge read failover). One paced Solana client per endpoint
  is shared by all reads. EVM transfers are "Confirmed" (included in a block); Solana uses the cluster's `confirmed`/`finalized` status.
- The continuation travels in a header (`x-flofi-cursor`), never in a URL, and is bound to its wallet by a server-keyed MAC: it names no wallet in
  clear and cannot be forged to drive provider reads.
- No silent gaps: incoming and outgoing (and each Solana address) are read as separate streams, so a page is complete only strictly after the
  newest of the oldest times read on streams with more history (`completeAfter`); rows at or before it wait for the next page ("N older
  movements appear when more activity is loaded"), since movements of one block or second can straddle a page. A Solana signature without a
  block time takes the nearest newer one; an address whose signatures carry none holds the whole page back. Legs of one transaction that arrive on different pages are re-classified together (a swap is never two transfers). A
  Solana address continues after the last signature of the contiguous run of its list a page shows, so a page cut through a same-slot pair
  never skips a signature. Coverage across pages: a later read clears a network's "could not be loaded" note (and a later failure shows it), but
  a partial-coverage note of any page listed stays, in its own words per code (internal transfers, token-account limit, unreadable
  transaction). Retry repeats exactly the request that failed (a failed refresh re-reads the newest, never the next page). A refusal meaning
  FloFi no longer reads this wallet for this browser — not verified here (`ACTIVITY_SIGN_IN_REQUIRED`), session ended, another account, access
  revoked, wallet not linked (`BETA_*` except the retryable access check) — clears what was loaded and names the reason.
- Solana Token-2022 mints whose display amount differs from their base amount (Scaled UI Amount, interest-bearing) are counted as hidden instead of
  shown with a base-unit amount; a transaction the node cannot return marks Solana PARTIAL.

### Limitations and what would remove them

- **Robinhood Chain**: no indexed history source is configured. Options needing owner approval: the public Blockscout API of
  `robinhoodchain.blockscout.com` (free, no key; a new external dependency) or an Alchemy/indexer plan that serves chain 4663. A bounded RPC log
  scan is not used: it cannot see native transfers and a useful window would be unbounded.
- **Internal native transfers on Base/Arbitrum One**: the Alchemy Transfers API lists `internal` on Ethereum only; covering them needs a trace
  provider (`debug_traceTransaction`/`trace_filter` capable plan) — a cost decision.
- **Provider cost**: each History open reads at most 6 Alchemy calls (2 per EVM network, ~150 compute units each on Alchemy's pricing); cached 30 s.
- **Solana**: incoming transfers into token accounts beyond the first 6 verified-mint accounts are not listed (reported as Partial); scaled or
  interest-bearing Token-2022 movements are hidden (counted); receipts into token accounts the wallet has since closed are not found; on the default
  public RPC a page needs ~20 sequential paced calls and may exceed the 10 s budget (shown as unavailable, never empty) — a dedicated RPC
  (`GRYLOO_SOLANA_RPC_URL`, already supported) avoids it.
- **Network gates**: a network the deployment deliberately does not enable (or refuses, e.g. test networks) is OFF and not listed; a gate read
  the runtime cannot answer (failure or time budget) is UNAVAILABLE ("could not be loaded right now"), never OFF. Solana, gated by two flows, is
  enabled when either answers enabled, and unknown only when none does and one could not answer. The portfolio keeps its own
  fail-closed gate semantics unchanged (`defaultMode` only gained an optional reader).
- **NFTs** (ERC-721/1155) are not part of wallet activity.
- **Origin deduplication** is as complete as the loaded execution records' attempts. The History list reads attempts only for runs whose summary
  cannot say what landed (Issue #149: unsettled, declined, failed); a completed (reconciled) run's summary carries no transaction hashes, so its
  transfers appear in the activity without a FloFi mark (never mislabeled, never claimed). Matching them needs the run summaries to carry their
  hashes (a backend read-model change) or an attempts read per listed run (more requests per History open); neither is part of this build.
- External bridges/swaps of other apps are labeled from chain data only (a one-way receipt from a relayer reads as "Received from …").

## C. Loading performance

### Automations

Root cause: the page called `automationsAvailability()` and then `automationOverview()` — two **Server Actions in sequence**, and Next.js dispatches
a page's Server Actions one at a time per client, so both waited behind every action already queued on the page (the ~60 availability checks of a
page load, previews, observations). The overview was also requested twice on open when the wallet was already proven (the `proof.proven` effect
fired on mount), and a temporary availability failure was shown as the permanent "Coming soon" state.

Fix: one same-origin GET (`/api/automations/overview`) runs availability and the owner-scoped overview **in parallel** (same `withFlightAccess`
and `automationOperation` owner verification), concurrent readers share it, refreshes read the overview only, the duplicate read is gone, stale
responses are ignored, existing data stays during same-owner refreshes, and a temporary failure shows "temporarily unavailable" with Retry.
Mutations remain Server Actions. A deployment without automations is never asked for the owner's overview where availability needs no request
(the runtime's own configuration answers first); the proposals notice on the other pages asks availability alone (`scope=availability`, no
wallet sent) until automations are served, then the overview alone — the base's polling, over GET.

### My Account (Settings)

Root cause: the presence read (`accountPresence()`) was a Server Action — queued behind the page's other actions — even though the product
layout already verifies the same session at render (for the chat scope). Fix: `currentAccountBootstrap()` returns both from that one verified
read; the page seeds the shared presence once (fresh for 30 s), so My Account is shown at the first open; the fallback read is a GET
(`/api/account/presence`). Never assumed signed in (unknown → the existing placeholder and read), never persisted, forgotten on a session change.

### Measurements

`e2e/loading-performance.spec.ts` (manual measurement, same spec on both builds): local production builds of `407c383` and this branch, the
`automations` browser profile environment (embedded PostgreSQL, fixture prices, loopback reads), same 4-vCPU machine, 5 samples each, reload of
`/app/automations` with a proven wallet, then the Settings menu opened on `/app/workflows`.

| Measure | Base `407c383` | This branch |
| --- | --- | --- |
| Automations: "Create an automation" visible (median, range) | 1,623 ms (1,556–2,117) | 1,485 ms (1,173–1,558) |
| Automations: page structure visible (median) | 121 ms | 129 ms |
| Automation reads per open | 2 Server Actions, queued | 2 GETs: availability before the wallet is known, then the owner's overview (≤ 1 owner read, asserted) |
| Server Actions queued on the page before useful content (median) | 61 | 48 |
| My Account row resolved after opening Settings (median, range) | 913 ms (887–1,400) | 114 ms (103–142) |
| Presence reads when Settings opens | the presence Server Action | none (seeded from the layout's verified bootstrap) |

On this loopback profile the automation reads themselves are fast, so most of the remaining Automations time is the page's own start-up; the
reads no longer wait behind the page's Server Action queue. A deployment with a slower API benefits more (the reads run in parallel and outside
the queue). Earlier runs during the build gave the same picture (base 2,027 / 2,049 ms, branch 1,520 / 1,522 ms for Automations; My Account
896–906 ms → 108–116 ms).

## Screenshots

From the loopback acceptance harness (fixtures; no public chain, nothing signed), in
[`BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001/`](BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001/):

- Before: `canvas-before-timeline.png` — Execute replaced the Canvas with the timeline (the fallback still used when no Canvas execution covers a run).
- After: `canvas-progress-0-light.png` … `canvas-progress-3-light.png` (and `canvas-progress-3-dark.png`) — the same three cards, waiting → in
  progress → completed one by one; `canvas-failed.png`; `canvas-mobile.png`.
- History: `history-all-light.png`, `history-received-light.png`, `history-sent-dark.png`, `history-received-pt.png`, `history-received-mobile-dark.png`.
