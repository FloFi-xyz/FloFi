# FIX-BRIDGE-CATALOG-CANCEL-001

Baseline: `a837ce5d3116ea4c140f4cef7e9d71ba350a10db` (PR #124). Reused the existing clean worktree and `codex/fix-bridge-catalog-workflow-cancel-001`; fetched and confirmed remote main at that commit before editing. Other worktrees were inspected and left untouched.

## Root causes and corrections

The visual Bridge card received no token-selection model, so `composer-card.tsx` fell back to its current stablecoin. Its Canvas network switch selected the Universal Router only for Solana pairs. The inspector's broader EVM search did not reach these controls.

The existing card now offers independent source/destination catalog searches, the existing token logos/selection indicators and network icons, with Tokens and Networks beside each other. Search stays at the top of a bounded, scrolling token column. All five mainnets are offered. EVM uses the existing official catalogs and `AssetSearch`, with metadata reads independent of swap execution gates. No EVM integration was rebuilt.

The preserved follow-up restores the established Base-first EVM fallback when a source change makes the destination invalid, while keeping Solana independently selectable. The broader authoring regressions also exposed identical build-quote requests restarting when catalog updates recreated an equivalent workflow object. The quote hook now stabilizes its snapshot by serialized contents; changed assets, amounts, networks, nodes or wallets still invalidate it, and the existing freshness and stale-response checks remain intact. A regression test reproduced the unwanted abort before the fix and passes afterward. The typing test controls its debounce clock without changing product timing.

`universalCanvasPair` preserves each exact certified legacy asset route. Other valid mainnet network/asset pairs author Universal Router nodes. Changes to an existing legacy adapter require a visible proposal; applying it creates a new workflow revision/hash and requires fresh simulation/financial Review. Existing workflows, signatures, execution journals and previously authorized runs are not migrated. Existing Universal Router edits retain that adapter, including when selecting a stablecoin again.

Selected catalog tokens carry address/mint and decimals, scoped to their source or destination chain. Canonical asset references remain explicit when a node is reopened, including after metadata reload. On-chain contract/mint checks and the existing simulation/Review are unchanged. Catalog membership supplies no liquidity, price or route claim.

Solana had only SOL/USDC/USDT shortcuts. The new public read-only loader uses Jupiter's [verified tag endpoint](https://developers.jup.ag/docs/tokens/token-information), with a fixed HTTPS URL, no redirects, streamed size limit, timeout, coalesced reads and five-minute cache without stale fallback. Only verified, non-suspicious records with valid mint/program/decimals are projected; incomplete/unrepresentable display metadata is excluded with a displayed count. Selections use mint@decimals, so duplicate tickers never choose an identity. Provider images are restricted to Jupiter's HTTPS image proxy and fall back to local marks. Safe mint extensions, owning program and decimals are rechecked on chain at simulation. The old three-token search ceiling and its UI claim were removed.

Live loading additionally found duplicate LCX and U tickers in Ethereum's official list. The existing reviewed ambiguity policy now excludes both identities for each ticker, alongside LIT. Unknown duplicates still fail closed. The existing FLUX decimals exclusion remains.

The workflow panel exposed End workflow only for HALTED. Cancellation also exempted HALTED from its in-flight guard and checked steps separately from the run transition. End workflow now appears for eligible PENDING, RUNNING and HALTED runs. Cancellation locks the run and its steps, checks the expected run version, skips only PENDING/READY/BLOCKED steps and records the event atomically. Step loading takes the same run lock and cannot load cancelled work. AWAITING_OWNER, UNCERTAIN and DELEGATED steps forbid cancellation even in HALTED. Reconciled/failed step outcomes, transactions, evidence and bound amounts remain unchanged. All bound wallet proofs are required. Delegated authorization uses a separately labelled revocation action and continues observing submitted work; revocation is not reported as transaction cancellation.

## Evidence and validation

- Initial implementation (`af91f4e`): `pnpm check` passed, 5,043 tests passed, 2 existing conditional skips; 11 schema exports checked. TypeScript, lint and production build passed; 64 focused tests and the full Canvas profile (8/8) passed after the layout/proposal follow-up.
- Recovery follow-up: production build with TypeScript passed; 23 focused quote tests passed, including the new identical-snapshot regression. All 63 tests passed across the Robinhood (4), Base (4), Arbitrum (18), Ethereum (18), workflow UX (11) and Canvas (8) authoring profiles. Local checks ran serially with one build worker, bounded Node heaps and a memory guard. Completed catalog/route and PostgreSQL work was retained rather than repeated. Exact-head CircleCI results are linked in the PR.
- Full PostgreSQL suite: 485 passed, 3 existing conditional skips, 78 suites passed; disposable loopback databases only. Includes eligible states, wallet mismatch/missing proofs, concurrent cancels, cancellation versus loading, HALTED in-flight refusal and preserved partial completion. Existing confirm/delegated workflows passed.
- Governance-lite and 56 CI orchestration self-tests passed.
- Live metadata: [catalogs-mainnet.json](catalogs-mainnet.json). Ethereum **477**, Base **195**, Arbitrum One **225**, Robinhood Chain **198**, Solana **4,038** validated assets at the recorded observation time. Payload SHA-256/source provenance and canonical Arbitrum WETH → Robinhood ETH references are included. These are real sources, not fixture asset counts.
- Read-only discovery: [routes-mainnet.json](routes-mainnet.json), the existing 40-case stablecoin/native mainnet matrix. All 40 cases had an EXECUTABLE discovery candidate at observation time; provider-level classifications and reasons remain in the artifact. This is neither funded-wallet simulation nor execution certification.
- The additional selected **Arbitrum WETH → Robinhood ETH** case returned **LIVE_QUOTE**, not executable: Relay's order failed the existing payment verifier; LI.FI lacks an execution verifier for those quoted paths; Mayan has no Robinhood route. Exact provider responses/classifications are in the catalog evidence. Nothing was authorized, signed or submitted.
- Playwright includes side-by-side geometry, bounded picker height, logos, selection indicators, network-specific search on all five networks, canonical WETH identity, passive-wallet assertions and catalog membership not implying execution. CI browser fixtures are labelled MOCKED; live catalog and route evidence above is separate.
- Regression coverage: #121 Universal Router/provider honesty, fee obligations and bound sequential workflows; #122 trusted MCP/OAuth/approval origins; #123 embedded chat signing and optional Canvas; #124 empty canvas, network selection, 100 bps defaults and product layout. Full unit/PostgreSQL checks cover these; relevant guarded Playwright profiles and exact-head CircleCI status are linked from the PR.

## Screenshots

Before screenshots come from an isolated production build of the baseline. After screenshots use the corrected production app. The images below use actual catalog metadata for the after captures (no fixture token/quote responses); the passive wallet permits account/network reads only.

| Picker | Before | After |
| --- | --- | --- |
| Arbitrum source | [Before](before-source.png) | [After](after-source.png) |
| Robinhood destination | [Before](before-destination.png) | [After](after-destination.png) |

## Limits and release boundary

- A valid catalog entry does not guarantee liquidity, an executable transaction shape or support for every mint extension. Discovery retains EXECUTABLE, LIVE_QUOTE, NO_ROUTE, supported-without-quote and provider-unavailable classifications. Financial Review always re-quotes/revalidates for the real owner.
- Metadata providers can fail or rate limit. The picker exposes loading/unavailable/retry rather than substituting an old or imaginary catalog. Jupiter entries missing safe display metadata and reviewed Ethereum ambiguities are intentionally excluded.
- An already loaded AWAITING_OWNER step is conservatively treated as potentially in flight, even before FloFi observes a submission. End workflow stays unavailable until the existing observation/reconciliation path establishes a safe state.
- Full end-to-end acceptance with an independent real ChatGPT account and funded wallets was not performed; it would require financial signatures forbidden by this task. Chat remains the primary execution path; Canvas is optional.
- No merge, manual deployment/promotion, production environment change or real financial authorization/signature/submission was performed. The existing Vercel Preview passed for `af91f4e` and requires Vercel SSO. Following the resumed instruction not to deploy, automatic Vercel deployments are disabled for this fix branch only; the corrected follow-up is not Preview-deployed. Production settings are unchanged. CircleCI certification continues through the existing PR integration; deployment remains reserved for owner approval.
- The 100 bps default slippage and 0.1% fee model are unchanged. PT/EN is preserved. `pnpm-workspace.yaml`, dependency release-age exceptions (including `fast-uri@3.1.9`), lockfile and dependency versions are unchanged.
