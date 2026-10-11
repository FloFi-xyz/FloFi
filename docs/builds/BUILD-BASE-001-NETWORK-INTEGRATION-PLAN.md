# BUILD-BASE-001 — Base as a first-class network: plan

Baseline `9ef339354ac2292281093609ad5ac3c6aaf73c0c` (main after PR #80). Branch `claude/build-base-001-network-integration`.
Inputs: [discovery](BUILD-BASE-001-NETWORK-INTEGRATION-DISCOVERY.md) and the BUILD-RH-002 architecture
([plan](BUILD-RH-002-NETWORK-INTEGRATION-PLAN.md), [report](BUILD-RH-002-NETWORK-INTEGRATION-REPORT.md)).

## 1. Execution discovery gate

| Capability | Gate | Built here |
| --- | --- | --- |
| Asset catalog | **SUPPORTED**: pinned ETH/USDC/WETH plus the live Uniswap Labs Default Token List (159 Base entries) | yes |
| Swap | **SUPPORTED**: Uniswap v3 (factory, SwapRouter02, QuoterV2 verified; CREATE2 pools) | yes |
| Bridge OUT | **SUPPORTED**: Base → Arbitrum (ROUTER-001) and Base → Robinhood (RH-002) | unchanged |
| Bridge IN | **SUPPORTED**: Robinhood → Base (RH-002) and **Arbitrum → Base** | Arbitrum → Base |
| Transfer | **SUPPORTED**: native ETH and catalog ERC-20s; receipts carry the OP Stack `l1Fee` | yes |
| Pool / liquidity | **SUPPORTED**: Uniswap v3 NonfungiblePositionManager (verified) | yes |
| Supply / Borrow / Repay / Withdraw | **SUPPORTED**: Aave v3.7, USDC reserve id 4 | yes (USDC) |

Bounded and documented, not built:

- **Lending composition on mainnet:** UNSUPPORTED. It stays Base Sepolia only.
- **More Aave reserves:** the engine binds one reserve per network.
- **Native-ETH and WETH bridging:** BLOCKED or not built, as before.
- **Ethereum mainnet:** BLOCKED.

## 2. Architecture: one more network on the RH-002 model

```
Network record → AssetProvider → validated catalog → asset registry → Canvas / Chat / MCP → canonical IR
             → capability registry row → the existing flow (swap / transfer / liquidity / lending / router) → recover / reconcile → evidence
```

No Base-specific engine, IR, page or MCP path is created. Every capability below is a **profile** of an engine that already exists.

### 2.1 Network (`packages/action-registry/src/base-chain.ts`)

- `BASE_MAINNET` holds: name, chain `eip155:8453`, id 8453, hex `0x2105`, environment `MAINNET`, RPC, explorer, the official source and
  EIP-3085 parameters.
- The shared wallet table keeps Base switchable. It gains the official add-chain parameters, used only after `4902`.
- Every Base read client is chain-bound to 8453. A provider answering another `eth_chainId` is refused before any economic read.

### 2.2 Asset registry

- **Asset model.** `AssetClass` gains `TOKEN`, a generic list ERC-20. The catalog symbol grammar accepts lower-case letters (`cbBTC`,
  `USDbC`, `wstETH`). Symbols stay unique **case-insensitively** inside a catalog, so resolution is never ambiguous.
- **Provider.** `uniswapTokenListProvider` (`base-token-list.ts`) parses the official list bytes into the Base catalog: pinned
  ETH/USDC/WETH merged with every Base list entry that passes the discovery §2.3 policy.
  - A malformed Base record, a duplicate, or a collision with a pinned asset under another identity fails the whole catalog closed.
  - Out-of-grammar symbols are counted (`officialRecords` vs `activeRecords`) and excluded.
  - A `logoURI` is kept only under reviewed image prefixes, as presentation metadata (§8.1).
- **Pinned assets.** ETH, USDC and WETH are pinned because the Router, Aave and the BUILD-002 reference swap bind their exact identity.
- **Authoring catalogs** (`domain/asset-catalogs.ts`) become a per-network registry of official catalogs: Robinhood and Base. Before
  the Base list is loaded, or when it fails, only the pinned assets resolve. Anything else fails closed (`ASSET_CATALOG_UNAVAILABLE`);
  there is never a recorded fallback.
- **Server loader** (`server/base-mainnet.ts`): pinned HTTPS URL, no redirects, size cap, timeout, short cache, fail closed. The same
  shape as the Robinhood loader.
- **Shared store.** The browser store and the MCP `prepareStrategyCatalogs` load the catalog of whichever official-catalog network a
  surface needs.

### 2.3 Swap (shared owner-wallet Uniswap swap service)

- **Profile.** A second `CATALOG` profile, `BASE_MAINNET_SWAP`: the pinned factory, router, quoter, WETH and USDC with code pins, the
  four standard tiers, `l1DataFee: true` and its own run namespace `bas-`.
- **Hash continuity.** The Base **USDC ⇄ WETH** pair keeps its BUILD-002 declaration. The authoring path is unchanged (`createSwapNode`),
  so its IR and hash stay byte-identical.
  - `isCatalogSwapNode` excludes that reference pair, so the linter keeps validating it with the reference registry exactly as before.
  - Every other Base catalog pair is a canonical catalog swap node: the same action, ports and chain + address + decimals identity.
  - Bounds on Base: USDC and WETH keep their reference maxima as input; any other asset uses the catalog maximum.
- **Quote.** The service accepts both shapes on Base and reads them into the same fields. Then the RH-002 catalog quote path runs:
  - official-catalog identity re-checked;
  - `decimals()` on chain;
  - code pins for the pinned tokens; code presence for list tokens;
  - every tier's CREATE2 pool checked for factory/token/fee identity and in-range liquidity;
  - QuoterV2, with the best tier bound.

  Then the same `PREPARED → approval → refresh → Review → swap → receipt + balance reconciliation → Evidence` lifecycle.
- **Recovery and gates.** An uncertain wallet result is observation-only. `begin` needs the Base owner-execution gate.
- **Routing.** In the app, a non-reference Base pair always goes to this service. The reference pair goes there when the connected
  wallet is on mainnet; otherwise its BUILD-002 observation and fork paths are unchanged.

### 2.4 Transfer (shared transfer engine)

- **Profile.** `BASE_MAINNET_TRANSFER`: native ETH or a catalog ERC-20, to the owner or an explicit recipient, real funds, `bat-`.
- **OP Stack fee.** The engine gains a profile-scoped L1 data fee:
  - Review binds an L1-fee upper bound from the GasPriceOracle predeploy (`getL1FeeUpperBound`), included in the fee budget.
  - The reconciler accounts `gasUsed × effectiveGasPrice + l1Fee`, and refuses a receipt that omits `l1Fee` on this profile.
  - Profiles without `l1DataFee` are byte-identical to before.
- **Stock Tokens.** The Stock Token multiplier logic stays Robinhood-only. A Base token has no official id.

### 2.5 Bridge (Cross-chain Router)

- **Route.** `CROSSCHAIN_ROUTER_ARBITRUM_BASE` (Arbitrum USDC → Base USDC) is built by the same route builder as the RH-002 routes,
  from the existing Arbitrum and Base sides and pins.
  - It is its own router network (`arbitrum-to-base`), cloud flow and storage.
  - Its gates are the Router's own (`GRYLOO_ROUTER=live`, `GRYLOO_ROUTER_OWNER_EXECUTION`): it is the reverse of the Router's Base ↔ Arbitrum
    deployment, not a Robinhood route.
- **Unchanged routes.** Base → Arbitrum and the four Robinhood routes are not touched.

### 2.6 Liquidity (shared Uniswap liquidity service)

- **Shared pool builder.** `robinhoodLiquidityPool` is generalized into `catalogLiquidityPool(deployment, …)`. Robinhood keeps
  byte-identical profiles.
- **Base pools.** Base pools are the CREATE2 pool of the pinned factory for (pair, tier), confirmed by `getPool` and the pool's
  token0/token1/fee/tickSpacing.
  - Both tokens must be catalog ERC-20s re-verified at Simulate. Pool order and tick spacing are enforced.
  - Approvals are exact. The owner is the NFT recipient.
  - The L1 fee is bounded through the GasPriceOracle, like Base Sepolia.
- **Runs.** Runs are `balp-`. The BUILD-006 fork-only `asset.liquidity.uniswap-v3` node and its flows are untouched.

### 2.7 Lending (shared Aave engine)

- **Profile.** `AAVE_V3_BASE` (USDC reserve id 4, aToken, variable-debt token, Pool, Provider, Oracle, `l1DataFee: true`) joins
  `AAVE_V3_LENDING_PROFILES`. Profiles are still chosen by the authored or reviewed chain, never by symbol.
- **Service.** The service, executor and reconciler gain a `PUBLIC_MAINNET` provenance (`MAINNET_EXECUTED` evidence only for a real
  owner-signed run), a `baave-` run namespace and the owner-execution gate on `begin`.
- **Safety rules.** Health factor, collateral and debt rules, freshness re-checks and the approval lifecycle are unchanged.

### 2.8 Authoring surfaces

- **Canvas.** No new page or card. Base gains catalog profiles in the existing Swap, Pool and Transfer pickers, and joins the existing
  lending selectors and the Bridge pickers (Arbitrum → Base).
  - The RH-002 Stocks search is extracted into one shared asset-search component.
  - The existing token picker uses it for every official-catalog network (bounded results, loading, empty and unavailable states).
  - The Stocks card keeps its own markup.
- **Chat (exact grammar)**, for example:
  - "Swap 100 USDC for cbBTC on Base"
  - "Transfer 0.01 ETH on Base to 0x…"
  - "Add liquidity 100 USDC and 0.04 WETH on Base [fee 0.05%]"
  - "Supply 100 USDC to Aave on Base", plus Borrow, Repay and Withdraw
  - "Bridge 100 USDC from Arbitrum to Base"

  The existing sentences keep their commands and IR.
- **MCP.** The strategy contract widens:
  - `base` for swap catalog symbols, transfer, `add_liquidity` (fee tier) and lending;
  - `arbitrum-one → base` for bridges.

  Each Base example composes byte-identically to its chat sentence. Discovery tools read the same registries.
- **Copilot.** No new free-form authority: every proposal is an exact-grammar sentence. Names, symbols and capabilities come from the shared registries (§8.2).
- **Visual.** The shared renderer resolves Base labels and assets from the registry. EN/PT strings are added.

### 2.9 Composition

Multichain workflows use the existing step-list contract (`version: 2`):

- Base USDC → Robinhood USDG → TSLA
- Robinhood USDG → Base USDC → supply

Each step keeps its own IR and hash. The plan stays `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED`.

## 3. Trust boundaries and fail-closed conditions

- **Authority.** The connected owner's wallet signs and sends every transaction. The server only reads, simulates, prepares, stores,
  observes and reconciles. AI/MCP/chat compose proposals only.
- **Fail closed** on any of:
  - wrong chain id
  - unknown or changed catalog identity
  - `decimals()` mismatch
  - code missing or pin mismatch
  - no live pool
  - stale quote, changed pool or tier
  - stale nonce, balance or allowance
  - changed reserve state or health factor
  - route or recipient change
  - expired Review
  - wrong workflow revision
- **No retries.** An ambiguous submission is observed, never retried.
- **Durable ordering.** The attempt is persisted before the wallet is called.

## 4. Real-funds gates (documented, none set)

| Variable | Effect |
| --- | --- |
| `GRYLOO_BASE_MAINNET=live` | Base catalog, quotes, simulation and Review for swap, transfer, liquidity and Aave. In-process server actions additionally need `NODE_ENV=development`; hosted deployments use cloud flows |
| `GRYLOO_BASE_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` | Deployment-wide real-funds owner execution: any connected user signs with their own wallet. No wallet allowlist |
| `GRYLOO_BASE_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY` | Loopback MOCKED harness (tests). Always wins over `live` |
| `GRYLOO_BASE_JOURNAL` | Local file journals for the in-process flows |
| `GRYLOO_BASE_RPC_URL` | Existing optional HTTPS override, reused |
| `GRYLOO_ROUTER`, `GRYLOO_ROUTER_OWNER_EXECUTION` | Existing Router gates, now also for Arbitrum → Base |

## 5. Evidence ceilings

| Source | Level |
| --- | --- |
| Discovery | `PUBLIC_READ_ONLY` |
| Unit, PostgreSQL and browser tests | `MOCKED` |
| `MAINNET_EXECUTED` | Never by this build; only for a real owner-signed, reconciled run after the owner enables the gates |

Capability rows carry `evidenceMaturity: null`.

## 6. Tests

Focused suites cover:

- Base identity and wallet
- the catalog provider (full Base fixture, a non-featured asset, search by symbol and name, duplicates, checksum, wrong chain, decimals,
  malformed and out-of-grammar entries, no fallback)
- swap (reference-pair hash continuity, catalog pair, missing pool, wrong identity, decimals mismatch, stale quote, Review invalidation,
  approve → refresh → review → swap → reconcile, uncertain result)
- transfer (ETH, ERC-20, explicit recipient, self, wrong chain, wrong token, L1-fee budget and reconciliation, uncertain result)
- liquidity (pool order, tier, missing pool, approvals, mint, uncertain approval, reconcile)
- the Arbitrum → Base router (fees, route change, ambiguous source, destination reconciliation, refund)
- Aave (supply, borrow, repay, withdraw lifecycles; reserve identity; health factor; stale state; mainnet provenance)
- authoring parity (Canvas = Chat = MCP; stable hashes)
- visual (EN/PT)
- regressions for Robinhood, Base Sepolia, Ethereum Sepolia, Arbitrum and Solana

A guarded browser profile (`base-mainnet-authoring`) proves:

- Base in the existing pickers;
- search in the existing picker;
- a non-featured asset (cbBTC) selected onto the card.

It uses the loopback catalog harness.

## 7. UX statement

No redesign. The existing cards, pickers and selectors gain Base options, the shared asset search and labels. Landing, navigation, branding,
typography, the lifecycle and every other surface are unchanged.

## 8. Owner addendum (2026-10-11): generic visual identity and Copilot parity

The owner approved two more requirements during implementation. The detailed requirements arrived with the continuation handoff and
supersede the first interpretation, which showed no remote logo and resolved Copilot tokens by symbol only. Everything below is shared,
network-agnostic infrastructure, so Base, Robinhood Chain and any future network inherit it.

### 8.1 Network and token visual identity (existing Canvas and pickers only)

- **Networks.** One app-level network registry (`domain/network-registry.ts`) keyed by CAIP-2 chain. It holds the name, aliases, environment,
  local reviewed mark, official-catalog flag, and the Copilot vocabulary (identifier, family, how a message names the network). Network
  icons are always local reviewed files under `public/brand`.
- **Tokens.** `CanonicalAsset.logoUrl` is rendered through the one icon resolver (`domain/asset-identity.ts`) the Canvas cards, asset
  search and picker chips already use:
  1. a reviewed local mark for a code-pinned asset (by chain + address);
  2. else the asset's provider logo, when that provider's rule accepts it for this exact asset;
  3. else a deterministic monogram generated locally from chain + address + symbol.
- **Logo rules** (`packages/action-registry/src/asset-logos.ts`), declared by each provider for its own network:
  - Robinhood Stock Tokens: the issuer's CDN path of the asset's own address (`https://cdn.robinhood.com/ncw_assets/logos/<address>.png`).
  - Base list tokens: the list's `logoURI` under six reviewed image prefixes (CoinGecko's two image CDNs, the Superchain token-list data,
    Trust Wallet's asset repository, CoinMarketCap's coin images, Basescan's token images). The URL must be normalized HTTPS: no
    credentials, port, fragment, dot segments or encoded separators, and at most a numeric cache-buster query.
  - Any other value is dropped to null at parse time; it never fails the catalog. `trustedAssetLogo` re-checks the rule at render.
  - A logo is never inferred from a symbol, so the same or a similar symbol on another chain never shares an image.
- **Rendering.** A provider logo is always an `<img>` (an SVG is never inlined), sent without a referrer. A missing, broken or blocked
  image falls back to the monogram. Showing one means the viewer's browser loads that image from the provider's host.
- **No IR effect.** Presentation metadata never enters the IR, a hash, a Manifest, a Review or execution (tested).

### 8.2 Natural-language Copilot parity

Natural language → intent extraction (the model) → shared network resolver (registry `mention`) → shared asset resolver → shared
capability truth → canonical exact-grammar sentence → `parseLocalCommand` → SemanticWorkflow IR.

- **Asset resolver** (`resolveAssetReference`): within the named network's validated catalog only:
  - the symbol, in any case;
  - else the whole display or catalog name of exactly one asset ("Tesla" is TSLA on Robinhood Chain, nothing on Base).
  - Several holders of a name are asked about. An unknown token is refused. An unloaded catalog fails closed.
  - The reply names the canonical asset whenever a name was used.
- **Intent.** The V2 token field carries the symbol or the name as written. The model is no longer told to report OTHER for a named
  company. That was the Robinhood USDG → Stock Token natural-language regression.
- **Capability truth** (`domain/authoring-capabilities.ts`): MCP's canonical examples (one per supported action × network, which MCP
  discovery composes through the real reducer) over the network registry. Tests bind it to the Aave and Router registries and to the
  Canvas pickers.
- **Generated, not written:**
  - the Copilot planners' networks per action;
  - the in-app capability answer (EN/PT);
  - the lending, router and composition refusals;
  - the model instructions' network rule and "What Flofi supports" (`server/copilot-capabilities.ts`).
- **Unchanged authority.** Real funds must be named. The proposal is the exact grammar's command. Nothing executes without the owner's
  Review and wallet signature. CopilotIntent V1 stays frozen.

### 8.3 Server runtime registry

The catalog-network runtime (`server/catalog-networks.ts`) binds each catalog network's gates, read clients, catalog loader, run
namespaces, journals and cloud flow names once. The cloud flows and the in-process server actions look networks up there instead of
branching per network.
