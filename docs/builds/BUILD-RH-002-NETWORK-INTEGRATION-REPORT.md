# BUILD-RH-002: Robinhood Chain as a first-class FloFi network, report

Status: **implementation complete, ready for owner review.** Never merged by this build.

- Baseline `60d3d801e7eba8d123412c286bf8c493aa529865`; branch `claude/build-rh-002-network-integration`.
- Inputs: [plan](BUILD-RH-002-NETWORK-INTEGRATION-PLAN.md) and [discovery](BUILD-RH-002-NETWORK-INTEGRATION-DISCOVERY.md).
- Evidence ceiling: discovery is **`PUBLIC_READ_ONLY`**; every test, unit or browser, is **`MOCKED`**.
- No transaction was signed, sent or broadcast. No production or deployment variable was set or changed.

## 1. What changed

| Commit | Scope |
| --- | --- |
| `fa6c2c0` | Generic asset registry, the official Stock Token catalog provider, Robinhood Chain mainnet as a wallet switch target, capability rows |
| `1b2f5eb` | Catalog swaps (USDG / WETH / any Stock Token) on the shared Uniswap swap service |
| `69a94ca` | The existing Stocks card made canonical: featured shortcuts plus search over the full catalog; Robinhood in the Canvas swap picker |
| `65a8c35` | Transfers on the shared transfer engine: native ETH, USDG, WETH and Stock Tokens, to the owner or an explicit recipient |
| `8c20eee` | Bridge in and out: Base/Arbitrum USDC ⇄ Robinhood USDG on the canonical Cross-chain Router |
| `07c8890` | Liquidity on any catalog pair at a standard fee tier; chat sentences; step/visual presentation |
| `e2ce3f2` | MCP strategy contract and multichain composition |
| `1f71d2e` | Browser authoring profile, recovery tests, docs |
| `99502b2` | `@noble/hashes` recorded in the BUILD-007 action-registry dependency pin (owner review) |
| `d979007` | Component acceptance harness: catalog-store stub; `StockFacts` as a store-free component |

The final commit adds this report; its SHA is the PR head.

## 2. Network proof

- **Chain identity.** Robinhood Chain mainnet `eip155:4663` (`0x1237`) is one canonical network record (`ROBINHOOD_CHAIN_MAINNET`). Every read client is chain-bound: a provider answering any other `eth_chainId` is refused before any economic read.
- **Wallet.** The shared wallet table makes 4663 a switch target, adding it with the official EIP-3085 parameters only after a 4902 response. Before this build it was recognized-only.
- **Capabilities.** Rows for `eip155:4663 / MAINNET`, each with `evidenceMaturity: null`:
  - `asset.swap.exact-input` / `uniswap.v3`
  - `asset.liquidity.concentrated` / `uniswap.v3`
  - `asset.transfer` / `evm.native-transfer` and `evm.token-transfer`
  - `asset.bridge` / `flofi.router`, plus Arbitrum One as a router source
- **Fees.** Nitro receipts carry no `l1Fee` (`gasUsedForL1` instead), so the L1 data fee is zero by construction and a receipt that claims one is rejected.
- **Gates.** None is set by this build:

  | Variable | Effect |
  | --- | --- |
  | `GRYLOO_ROBINHOOD_MAINNET=live` | The official catalog, quotes, simulation and Review |
  | `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` | Additionally allows owner execution |
  | `GRYLOO_ROBINHOOD_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY` | Tests only; always wins over `live` |

## 3. Registry architecture

`packages/action-registry/src/asset-registry.ts` holds the network-agnostic model:

- `CanonicalAsset`: network, CAIP-19 id, symbol, name, kind, asset class, address, decimals, logo, provenance, status, and an optional `stock` block (official uid, ISIN, multiplier, pending multiplier, trading capabilities).
- Validated, frozen `AssetCatalog`s with lookup by id, address and symbol, plus search and featured.
- `createAssetRegistry` merges catalogs. A duplicate id, address or symbol fails closed.

Providers:

- **`parseRobinhoodStockTokenRegistry`** reads the official `GET api.robinhood.com/rhj/assets`. It accepts both documented `tradingCapabilities` shapes and refuses:
  - an asset that is off chain 4663
  - a bad EIP-55 checksum, or decimals other than 18
  - a malformed multiplier, or a pending multiplier without its time
  - a status other than active
- **Static code-pinned base assets** for Robinhood (ETH, WETH, USDG), Base and Arbitrum (ETH, USDC, WETH). Base and Arbitrum prove the abstraction serves other networks without building their catalogs.

The live registry is read server-side only: a pinned HTTPS URL, no redirects, size-capped, a 30 s cache, fail-closed. There is no recorded fallback.

The Canvas, chat, MCP and the visual resolve assets only through the registered catalog (`domain/asset-catalogs.ts`). Before the official catalog is loaded, or when it fails, no Stock Token resolves and authoring that needs one fails closed with `ASSET_CATALOG_UNAVAILABLE`.

## 4. Stock Token catalog

- **194 official Stock Tokens**, the full registry. The committed capture (`f8c058b2…44df`) feeds tests and the loopback browser harness.
- **Featured only.** AAPL, TSLA, NVDA, MSFT and AMZN are shortcuts (`ROBINHOOD_FEATURED_STOCKS`), resolved from the official catalog. They are never the catalog or a filter: every one of the 194 is reachable by search in the Canvas and by symbol in chat and MCP.
- **Non-featured proof (PLTR):**
  - quoted through the same swap service (`robinhood-swap.test.ts`)
  - authored on the same Stocks card (`robinhood-authoring.test.ts`)
  - pooled through the same liquidity service (`robinhood-liquidity.test.ts`)
  - found by Canvas search in the browser (`e2e/robinhood-stocks.spec.ts`): search "palantir", select PLTR, and the card receives PLTR
- **Identity.** A Stock Token is bound by chain, address and decimals **and** its official uid. At Simulate it must still be:
  - the official beacon proxy (code pin) on the official beacon
  - reporting the registry's `uid()`
  - showing an on-chain `uiMultiplier()` equal to the registry's
- **Multiplier.** It is bound into Review and shown as shares per token.
  - A change scheduled inside the Review window fails closed (`STOCK_MULTIPLIER_CHANGE_PENDING`).
  - A change after Review clears the authorization (`STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED`).
  - A chain/registry disagreement fails closed (`STOCK_MULTIPLIER_MISMATCH`).

## 5. Capabilities (all MOCKED)

| Capability | Result | Evidence in this build |
| --- | --- | --- |
| **Swap** (USDG ⇄ any Stock Token, WETH) | Canonical `asset.swap.exact-input` on Uniswap v3. Pools are derived locally (CREATE2) for every fee tier and quoted with QuoterV2; the best live tier is bound. Begin requires the real-funds opt-in. | `robinhood-swap.test.ts`: quote, non-featured, non-1.0 multiplier, multiplier invalidation, approve → refresh → review → swap → reconcile, uncertain result observation-only, `rhs-` namespace, no send path |
| **Bridge in/out** | Base USDC → Robinhood USDG, Robinhood USDG → Base USDC, Arbitrum USDC → Robinhood USDG, Robinhood USDG → Arbitrum USDC, all on `flofi.router` (underlying Across). 1–100 per bridge. Across's USDC→USDG conversion is its own Review fee line. LI.FI folds it into the output unitemized, so it is refused (`LIFI_FEES_INCONSISTENT`) and AUTO falls back to Across. | `router-robinhood.test.ts`: all four routes approval → deposit → fill → RECONCILED; route change clears authorization; the insufficient-token code; routes never cross; gates |
| **Pool / liquidity** | Any two catalog ERC-20s at 0.01/0.05/0.3/1%. The CREATE2 pool of the pinned factory is confirmed by `getPool`. Both identities come from the official catalog; Stock Token identity and multiplier are bound into Review. `rhlp-` runs. | `robinhood-liquidity.test.ts`: authoring (incl. PLTR), Review binding, approve → approve → mint → RECONCILED on 0x1237, multiplier change/pending, registry and pool failures, provenance boundaries |
| **Transfer** | Native ETH, USDG, WETH or a Stock Token, to the signer or an explicit recipient. The reconciler reads the `Transfer` log (and accepts `TransferWithScaledUI`) and the balance deltas. | `robinhood-transfer-mainnet.test.ts`: ETH, USDG, Stock Token, multiplier invalidation, registry/chain disagreement, wrong identity, opt-in required, uncertain result, divergent transaction |

## 6. Composition

The MCP step list carries multichain workflows, for example:

- `{ version: 2, steps: [bridge base → robinhood 100 USDC, swap robinhood USDG → TSLA, transfer robinhood AAPL] }`

Each step composes byte-identically to its chat sentence, with a stable per-step `semanticWorkflowHash`. The workflow hash covers the ordered steps, and one step equals the v1 strategy.

The execution plan is honestly `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED`. FloFi keeps every publicly executable capability isolated, and no orchestrator waits for a bridge fill before the next step. Each step is reviewed, signed and reconciled through its own flow.

Tests: `robinhood-composition.test.ts`, and the engine and channel parity tables, which now include 7 Robinhood examples.

## 7. Hash and Review continuity

- **Existing strategies.** Strategy contract engine version is unchanged (`flofi-engine-2`). Every pre-existing capability example composes to the same IR and hash (parity tables unchanged for them). Bridge normalization still emits `asset: 'USDC'` for the existing pairs.
- **Existing Reviews:**
  - The native self-transfer Review (RH-DEMO-001, Ethereum Sepolia) is byte-identical.
  - Router Base → Arbitrum and testnet runs keep their record format (`usdcBalance` is kept, now meaning the source token).
  - Uniswap testnet liquidity Reviews add no field, and the range description is the same text.
- **Robinhood runs.** Each is in its own namespace, and a log of one route, service or network never validates under another:
  - swap `rhs-`
  - transfer `rht-`
  - liquidity `rhlp-`
  - router storage per route

## 8. Visuals

The shared visual (`platform/workflow-visual.ts`), the same one used by MCP, Telegram and WhatsApp, now draws:

- `CATALOG_SWAP` (USDG → TSLA on Robinhood Chain)
- `CATALOG_LIQUIDITY` (both catalog assets; price bounds unless full range)
- Robinhood transfers
- bridges that deliver another asset (`100 USDC → USDG`, Base → Robinhood Chain)

A Robinhood workflow carries the `REAL_FUNDS` warning.

EN/PT: every new UI string has a Portuguese entry (`i18n/pt-robinhood.ts`), and the central catalog test passes.

## 9. Recovery

Recovery is the existing durable model unchanged: the server-held run is authoritative, an ambiguous wallet result is observation-only, it is never resent, and attempts are rediscovered by nonce. It is proven on the Robinhood profiles:

- **Router, Robinhood → Base.** An ambiguous submission is observed, refused a second attempt, then found when mined. An unfilled USDG deposit is reconciled as a verified refund on Robinhood Chain.
- **Liquidity.** An uncertain approval stays observation-only and is rediscovered by nonce.
- **Swap and transfer.** An uncertain wallet result never prepares a second attempt.
- **Browser stores.** They recover per-route router pointers and `rhlp-` liquidity pointers.

## 10. Blocked or not built

| Item | Status |
| --- | --- |
| Ethereum mainnet routes | **BLOCKED**: FloFi refuses Ethereum mainnet as an execution network (BUILD-ETHEREUM-001); an owner decision |
| Native-ETH bridging | **BLOCKED**: the router route is ERC-20 approve + deposit with `value = 0` |
| WETH bridge routes | not built: same router path; left out to keep this build to the reviewed USDC ⇄ USDG pairs |
| Sequential multi-step execution | not built: `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED` (unchanged FloFi boundary) |
| Copilot natural-language intents for Robinhood | not built: the exact chat grammar covers the Robinhood sentences; free-form AI interpretation does not yet |
| Telegram/WhatsApp proposing Robinhood actions | not enabled: channels map the commands with parity, but their Copilot authoring set is unchanged |
| Robinhood MOCKED chain in the browser | not built: the loopback harness serves the official registry only; service lifecycles are MOCKED in unit tests |
| Lending (Morpho, borrow, supply, repay) | out of scope |
| `MAINNET_EXECUTED` evidence | never by this build: only owner-signed acceptance after the owner enables the gates |

## 11. Evidence levels

| Source | Level |
| --- | --- |
| Discovery reads (registry, RPC, Uniswap, Across, LI.FI) | `PUBLIC_READ_ONLY` |
| Unit, PostgreSQL and browser suites | `MOCKED` (in-process chains; loopback registry) |
| `TESTNET_EXECUTED` | not applicable (Stock Tokens and venues exist on mainnet only) |
| `MAINNET_EXECUTED` | **none**. The code labels evidence `MAINNET_EXECUTED` only for PUBLIC_MAINNET provenance, which tests never use; MOCKED provenance never claims more |

## 12. Tests and gates

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | pass: 321 test files, 3,368 tests (2 skipped files are pre-existing) |
| PostgreSQL suites (`pnpm test:postgres`, disposable loopback PostgreSQL 18.6, digest-pinned) | pass: 53 files, 337 tests |
| `pnpm test:anvil`, `pnpm test:fork` (offline, Anvil 1.8.3 verified) | pass: 4 + 31 tests; owner-secret cases skipped exactly as in CI |
| Guarded browser `product` profiles (including the new `robinhood-mainnet-authoring`) | pass: 25 of 25 profiles |
| CI's MCP, developer and channel browser specs (`mcp-route-presentation`, `developer-journey`, `mcp-in-chat`, `channel-signing`, `whatsapp-approve`, `telegram-approve`) | pass: 41 tests |
| Guarded browser `composition` phase | not run locally (it needs the BUILD-007 pinned downloads); no composition-compiler code changed, and CI runs it on the PR |
| Governance-Lite (clean export) and its 19 self-tests | pass (1,746 text files) |
| Dependency integrity (`pnpm install --frozen-lockfile --offline`, `bootstrap-ci.py --verify-dependencies`, CycloneDX 1.6 SBOM check, `pnpm audit`) | pass: 265 locked versions, 265 SBOM components, no known vulnerabilities |
| `git diff --check` over the branch | pass |

New focused suites:

- `asset-registry.test.ts`
- `robinhood-swap.test.ts`
- `robinhood-authoring.test.ts`
- `robinhood-transfer-mainnet.test.ts`
- `router-robinhood.test.ts`
- `robinhood-liquidity.test.ts`
- `robinhood-chat.test.ts`
- `robinhood-composition.test.ts`
- `e2e/robinhood-stocks.spec.ts`

## 13. Intentional test changes

No test was deleted or skipped. These pre-existing tests changed because behaviour changed by design:

- **Robinhood mainnet is now a network, not recognized-only:**
  - `evm-networks.test.ts` (switchable)
  - `robinhood-chain.test.ts` (mainnet capability rows, no evidence)
  - `ethereum-sepolia.test.ts` (transfer profiles include Robinhood mainnet; the testnets are unchanged)
  - `crypto-action-picker.test.ts` (mainnet swap and pool networks include Robinhood Chain; the loop registers the committed catalog)
  - `canvas-transfer.test.ts` (transfer networks include Robinhood Chain)
- **Transfers accept explicit recipients and tokens:**
  - `workflow-contracts/native-transfer.test.ts`: an explicit lower-case recipient is a valid declaration, and the profile decides whether it is allowed.
  - `reference-linter/native-transfer.test.ts`: 4663 is now valid; Ethereum Mainnet `eip155:1` is the unsupported probe.
- **The Stocks card is canonical** (USDG → Stock Token swap) instead of an editing-only placeholder:
  - `build-correction.test.tsx`
  - `public-testnet-store.test.tsx` (mock of the new availability action)
  - `e2e/stocks-pool-authoring.spec.ts`:
    - the amount field names USDG
    - the panel has the required search box
    - the stock pill shares the card with the USDG badge
    - "configure one new action at a time" now applies to the Stocks draft
- **Router tokens are generalized** (`usdc` → `token`):
  - `crosschain-router.test.ts`
  - `router-service.test.ts`
  - `router-testnet.test.ts`
  - `journey-cloud.pg.test.ts`
  - `canvas-action-setup.test.ts` (Arbitrum is now a source and Base a destination)
- **New flows and network are listed:**
  - `entrypoint.test.ts`
  - `run-ownership.test.ts`
  - `gateway.test.ts` (8 networks)
  - `step-list.test.ts` (`transfer` is an action, so the unknown-action probe is `stake`)
  - the engine and channel parity tables (7 Robinhood sentences)
  - `docs/developer/openapi.json` regenerated
- **Component harness stubs:** `execute-product-workspace.spec.ts` and `ci-layout-diagnostic.spec.ts` bundle client components with Vite and stub every store that calls a Next server action. They now also alias the new `asset-catalog-store` to that stub (`useNetworkCatalog` idle, `ensureNetworkCatalog` no-op). The first full guarded run caught the missing alias (the bundle reached `pg`). `StockFacts` also moved to its own store-free component so the liquidity panel does not pull the public swap store.
- **Dependency pin:** `scripts/bootstrap-ci.py` BUILD-007 action-registry pin now includes `@noble/hashes` 2.4.0 (see the dependency note in the PR).

`e2e/stocks-pool-authoring.spec.ts` is not in any CI profile. Its tests 1, 2, 5 and 6 also fail at the baseline `60d3d80`: toolbox padding, timeouts, and a viewport ratio of 0.977 at baseline vs 0.900 now, because the panel holds the catalog search. They are reported, not skipped.

## 14. Confirmations

- **No production variable changed.** The new variables are documented in `docs/deploy/ENVIRONMENT.md` only.
- **No transaction or signature occurred.** No key exists. Tests use in-process chains and a loopback registry, and the only send path is the scripted test wallet.
- **No UX redesign.** The existing Stocks, Bridge, Pool and Transfer cards, pickers and panels gain Robinhood options, a search field, a fee-tier select and labels. Canvas, landing, Dashboard, navigation, branding and the execution lifecycle are unchanged.

## 15. Owner acceptance path (not done by this build)

1. Set `GRYLOO_ROBINHOOD_MAINNET=live` on a Preview to get the live catalog, quotes, simulation and Review: read-only, `PUBLIC_READ_ONLY` facts.
2. Optionally set `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` and have the owner execute one small reviewed action from their own wallet. That run, independently reconciled, is the first `MAINNET_EXECUTED` evidence.
