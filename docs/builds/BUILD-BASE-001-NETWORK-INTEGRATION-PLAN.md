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
  - Logos are dropped.
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
- **Copilot.** No new free-form authority. Exact grammar only.
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
