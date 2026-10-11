# BUILD-RH-002 — Robinhood Chain as a first-class network: plan

Baseline `60d3d801e7eba8d123412c286bf8c493aa529865` (main after PR #79). Branch `claude/build-rh-002-network-integration`.
Inputs: [discovery](BUILD-RH-002-NETWORK-INTEGRATION-DISCOVERY.md), BUILD-RH-001 and RH-DEMO-001.

## 1. Execution discovery gate

| Capability | Gate | Evidence (discovery §§) | Built |
| --- | --- | --- | --- |
| SWAP | **SUPPORTED** | Canonical Uniswap v3 (`deployments.json`, labs-supported). Router/quoter `factory()`/`WETH9()` relationships hold. Pools are proven by local CREATE2. QuoterV2 answers live. 95/194 Stock Tokens have a live USDG pool | yes |
| POOL / LIQUIDITY | **SUPPORTED** | The same canonical v3 factory and NonfungiblePositionManager (`factory()`/`WETH9()` verified). Existing pools have in-range liquidity | yes |
| BRIDGE IN/OUT | **SUPPORTED** (USDC ↔ USDG) | Across routes Base, Arbitrum and Ethereum USDC → Robinhood USDG, and back. Live quote. Robinhood SpokePool reports chain 0x1237, WETH and is not paused. LI.FI quotes both directions through Across | Base ↔ Robinhood and Arbitrum ↔ Robinhood |
| TRANSFER | **SUPPORTED** | Native ETH plus canonical ERC-20s (USDG, WETH, Stock Tokens are standard ERC-20s) | yes |

The following are bounded and documented rather than built:

- **Ethereum mainnet:** BLOCKED by an existing product rule. FloFi refuses Ethereum mainnet as an execution network (BUILD-ETHEREUM-001). Opening it is a separate owner decision.
- **Native-ETH bridging:** BLOCKED. The router's canonical route is ERC-20 approve plus deposit with `value = 0`.
- **Lending:** out of scope.

## 2. Architecture

### 2.1 Generic asset registry (`packages/action-registry/src/asset-registry.ts`)

`CanonicalAsset` records:

- network: chain, CAIP-2 and chain ID
- id: CAIP-19 (`eip155:4663/erc20:0x…`, `…/slip44:60` for native)
- symbol, name, kind (`NATIVE`/`ERC20`) and asset type (`NATIVE`, `WRAPPED_NATIVE`, `STABLECOIN`, `STOCK_TOKEN`)
- address, decimals and logo URL
- source/provenance (provider, URL, official id)
- status
- an optional `stock` block: official uid, ISIN, current multiplier, pending multiplier and effective time, trading capabilities

An `AssetProvider` turns an official source into a validated, frozen `AssetCatalog`. The catalog offers lookup by id, address and symbol, `search`, and `featured`. Duplicate ids, addresses or symbols fail closed.

Providers:

- **`robinhoodStockTokenProvider`:** parses the official `GET api.robinhood.com/rhj/assets`. It accepts the documented and the live `tradingCapabilities` shapes. It refuses any asset that is not on 4663, has a bad checksum, does not have 18 decimals, has a malformed multiplier, has a pending multiplier without a time, or has a status other than active.
- **Static providers for each network's base assets:**
  - Robinhood: ETH, WETH, USDG from the official Token Contracts page.
  - Base and Arbitrum: ETH, USDC, WETH from the existing pinned constants.

  These prove the abstraction serves Base and Arbitrum without building their full catalogs.

The Canvas, Chat/MCP, the visual renderer and every capability read assets only through the registry.

### 2.2 Stock Token identity and multiplier

- **IR identity:** a Stock Token is bound by chain, address and decimals (as every ERC-20) **plus** an `IDENTIFIER` input carrying the official uid (`asset-in-official-id` / `asset-out-official-id`). A contract or registry change cannot silently keep the old meaning.
- **Simulate checks:** the official registry must still map the uid to the same address, symbol and decimals, with status active. On chain, `uid()` must equal the uid and `decimals()` must be 18.
- **Multiplier binding:** `uiMultiplier()`, `newUIMultiplier()` and `effectiveAt()` are read and bound into the quote/manifest and shown in Review as underlying shares. A pending change that takes effect before the Review expires fails closed (`STOCK_MULTIPLIER_CHANGE_PENDING`).
- **Re-check at Execute:** a changed multiplier invalidates the Review (`STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED`).
- **Prices:** REST `/prices` are never used as token value.
- **Eligibility:** every Stock Token acquisition shows the jurisdiction notice in Review.

### 2.3 Network

`ROBINHOOD_CHAIN_MAINNET` becomes a switch target in the shared wallet table. The network is added only from official EIP-3085 parameters after a 4902 response.

Capability rows are added for `eip155:4663` / `MAINNET`, all with `evidenceMaturity: null`:

- `asset.swap.exact-input` / `uniswap.v3`
- `asset.liquidity.concentrated` / `uniswap.v3`
- `asset.transfer` / `evm.native-transfer` and `evm.token-transfer`
- `asset.bridge` / `flofi.router` (source chain)

A router row is also added for Arbitrum One (42161) as a source.

Gates follow the existing mainnet convention. They are separate from the RH-DEMO-001 testnet gates (`GRYLOO_ROBINHOOD_TESTNET`, `GRYLOO_ROBINHOOD_HARNESS`), which are unchanged:

- `GRYLOO_ROBINHOOD_MAINNET=live`: the official catalog, quotes, simulation and Review on Robinhood Chain. In-process server actions additionally need `NODE_ENV=development`; hosted deployments use the cloud flows.
- `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`: additionally allows `begin`. The owner's wallet signs and sends.
- `GRYLOO_ROBINHOOD_MAINNET_HARNESS=MOCKED_LOOPBACK_ONLY`: loopback tests. It always wins over `live`.
- `GRYLOO_ROBINHOOD_JOURNAL`: local file storage (`mainnet-transfer`, `liquidity`, `router-<route>` subdirectories). The swap uses the public swap service's own journal.
- Optional HTTPS overrides: `GRYLOO_ROBINHOOD_RPC_URL`, plus the existing `GRYLOO_BASE_RPC_URL` and `GRYLOO_ARBITRUM_RPC_URL`.

No production variable is set by this build.

### 2.4 Capabilities: reuse, not new engines

- **Swap:** the existing public Uniswap swap service gains a registry-backed profile kind for Robinhood mainnet.
  - Pairs come from the catalog.
  - The pool is derived locally (CREATE2) for each fee tier, checked for code, and quoted with QuoterV2. The best output wins and pool plus fee are bound.
  - Everything else is the same code path: durable PREPARED, one swap attempt, delegated read-back, receipt/balance reconciliation, Evidence Bundle.
- **Transfer:** the RH-DEMO transfer engine is generalized:
  - asset: native ETH or a registry ERC-20, through `transfer(recipient, amount)`
  - recipient: connected owner or an explicit address
  - profile: Robinhood mainnet

  The existing self-transfer node and Review stay byte-identical, so RH-DEMO evidence and hashes keep their continuity. The reconciler adds the ERC-20 `Transfer` log and the token balance delta.
- **Bridge:** router pairs Base ↔ Robinhood and Arbitrum ↔ Robinhood (USDC ↔ USDG) on the existing `flofi.router`.
  - Profile token fields are generalized from `usdc` to `token`, `symbol` and `decimals`, with an `l1DataFee` flag on the source side.
  - Each bridge moves 1–100, the release cap of Base → Arbitrum.
  - Across's `internalizedSwap` (the stablecoin conversion) becomes its own Review fee line. LI.FI does not itemize the conversion, so its route fails closed and AUTO falls back to Across.
  - Each route is its own flow and storage. Review and visuals show both assets explicitly.
- **Liquidity:** the existing Uniswap public-liquidity service gains Robinhood Chain:
  - The pool is the node's own pair and a standard fee tier: the CREATE2 pool of the pinned factory, confirmed by `getPool` and the pool's own token0/token1/fee/tickSpacing.
  - Both tokens must resolve in the freshly validated official catalog. Stock Tokens go through the same on-chain identity and multiplier check as swaps (a shared helper), with the multiplier bound into Review.
  - Runs are `rhlp-` in their own flow (`robinhood-liquidity`).

### 2.5 Composition

Multichain workflows use the existing MCP step-list contract (`version: 2`), not new IR edges:

- An ordered list of single-action steps, for example "bridge 100 USDC from Base into Robinhood → buy TSLA with USDG → transfer AAPL".
- Each step keeps its own isolated canonical IR and `semanticWorkflowHash`. The workflow hash covers the ordered step hashes. One step is exactly the v1 strategy.
- FloFi's authoring rules keep every publicly executable capability alone in its workflow. A cross-chain resource edge from a bridge fill into a swap input would need an orchestrator that waits for settlement, which does not exist.

The execution plan is therefore honestly `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED`. Each step is reviewed, signed and reconciled through its own flow. The shared visual draws the sequence with its real-funds and not-executable warnings.

### 2.6 Canvas, Chat/MCP, visuals

- **Canvas:** the existing Stocks card becomes canonical.
  - It authors `asset.swap.exact-input` on Robinhood: pay USDG, receive the chosen Stock Token.
  - Its asset picker keeps AAPL/TSLA/NVDA/MSFT/AMZN as featured shortcuts and gains a search input over the full validated catalog, with loading, empty and unavailable states. Results are rendered incrementally.
  - Robinhood joins the existing Swap, Pool, Transfer and Bridge network selectors.
- **Chat/MCP:** "Bridge 100 USDC from Base to Robinhood", "Swap 50 USDG for TSLA on Robinhood", "Transfer 3 AAPL on Robinhood" and "Add liquidity 100 USDG and 0.4 TSLA on Robinhood" are exact chat grammar.
  - The MCP strategy contract gains the `robinhood` network, USDG bridges, catalog symbols, a fee tier and full range, and a `transfer` action.
  - Every Robinhood example composes byte-identically to its chat sentence (parity tests).
  - Stock Token symbols resolve only in the validated official catalog, which MCP and the in-app chat load before composing, and only where the deployment enables Robinhood Chain. The handoff is unchanged.
- **Visuals:** the shared renderer resolves Robinhood chain labels and asset symbols from the registry. There is no new renderer.

## 3. Evidence ceilings

| Evidence | Claim |
| --- | --- |
| Discovery reads | `PUBLIC_READ_ONLY` |
| Unit and browser tests | `MOCKED` (loopback) |
| Optional local Anvil fork of Robinhood mainnet | `MOCKED`. A live fork is not a closed replay |
| `TESTNET_EXECUTED` | Not applicable. Stock Tokens and the venues exist only on mainnet |
| `MAINNET_EXECUTED` | Never by this build. Only owner-signed acceptance later |

## 4. Tests

The new focused suites cover everything the brief lists:

- identity, wallet and the registry
- the full catalog (not limited to five), featured five and non-featured search
- malformed, duplicate and ambiguous refusal
- decimals and multiplier parsing, multiplier invalidation
- swap, bridge mapping, liquidity and transfer
- multistep IR, hash continuity, recovery and reconciliation
- visuals and EN/PT
- Copilot/MCP parity
- no transaction from tests

Existing Base, Arbitrum and Solana suites run unchanged.

Gates: `pnpm check`, PostgreSQL suites, the guarded browser product profiles, Governance-Lite and its self-tests, dependency integrity, and `git diff --check`.
