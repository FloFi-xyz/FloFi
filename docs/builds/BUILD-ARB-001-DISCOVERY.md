# BUILD-ARB-001 — Arbitrum One discovery

Phase 1, verified **2026-10-11**. Baseline: `4df974f6ae6ae1d22b86f220db6281294cd20035` (BASE-001 / PR #81).
Branch: `codex/build-arb-001-network-ux`. Evidence ceiling: **PUBLIC_READ_ONLY**; focused tests are **MOCKED**.

Public HTTPS GETs and JSON-RPC reads only: `eth_chainId`, `eth_blockNumber`, `eth_getCode`, `eth_call`.
No wallet, key, signature, approval, transaction, deployment mutation or Production change.
The persistent [read verification](BUILD-ARB-001-READ-VERIFICATION.json) records source hashes, contract code hashes,
relationships, raw reserve/quote results and catalog counts; it contains no upstream token-list copy.

## Network identity

The [official network table](https://docs.arbitrum.io/chain-info) and
[Foundation wallet guide](https://support.arbitrum.io/hc/en-gb/articles/19479729907483-How-can-I-add-Arbitrum-network-to-my-wallet)
confirm Arbitrum One, chain **42161 / 0xa4b1**, RPC `https://arb1.arbitrum.io/rpc`, native **ETH**, explorer `https://arbiscan.io/`.
FloFi's CAIP-2 is `eip155:42161`; its classification is **MAINNET / REAL_FUNDS**.
The RPC returned `0xa4b1`; discovery reads used block **513935282 / 0x1ea207b2**.

The canonical package record is `ARBITRUM_ONE`. Existing Router and wallet identities now read it without changing their values.
The shared app network registry reuses it and the existing reviewed `/brand/crypto/arbitrum.png` mark.
Native ETH retains FloFi's existing `eip155:42161/slip44:60` catalog identity and `{ chainId, nativeId: 'ETH', decimals: 18 }` IR projection.
Arbitrum Sepolia remains a distinct testnet, with no catalog expansion.

## Curated asset source and trust model

BASE-001 already consumes the [Uniswap Labs Default Token List](https://github.com/Uniswap/default-token-list)
from [its official endpoint](https://tokens.uniswap.org). The fresh response is v**22.26.0**, timestamp **2026-10-08T17:54:32.750Z**,
1,784 total entries, **204** on Arbitrum One. Its exact SHA-256 is
`aaf0c47f30ec22cb70231143ad7e83539693eeb21b75466652d730f74b95296e`.
There are no duplicate addresses or case-insensitive symbols on Arbitrum in that response.
The existing source therefore serves both chains; copying Base's provider would create unnecessary parallel code.

FloFi's inclusion boundary is this reviewed curated endpoint plus existing code-pinned assets, not an arbitrary token endpoint,
user-supplied URL, symbol search service or unfiltered chain index. List membership does not certify a token's safety,
liquidity, transfer behavior or lending eligibility. The server fetching this source must enforce the canonical HTTPS endpoint,
response size/time limits and no redirect to an untrusted host, as BASE-001 does. Phase 1 registers the pure parser/provider and
shared loader seams; **it does not wire a live Arbitrum server loader or change deployment gates**.

The catalog consists of existing `ARBITRUM_BASE_ASSETS` plus the chain projection:

- Native ETH; Circle native USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831` (6 decimals), confirmed by
  [Circle's contract table](https://developers.circle.com/stablecoins/usdc-contract-addresses); WETH
  `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` (18), confirmed by
  [Uniswap's Arbitrum deployment page](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments).
- Only records with numeric chainId 42161 are projected. Foreign-chain entries never become Arbitrum assets.
  ERC-20 identity is chain + contract address, bound to validated decimals; symbol and name are metadata.
- Addresses must use exact EIP-55 encoding; decimals must be integers 0–36; names must be bounded and control-free.
  FloFi's existing symbol grammar remains unchanged. `1INCH` is counted and excluded, never renamed.
- Every one of the 204 contracts had code. **203** declared decimals matched `decimals()` at the discovery block.
  **FLUX** `0x63806c056fa458c548fb416b15e358a9d685710a` declares 18 but returns **8**; its exact address is excluded
  by the Arbitrum profile. We neither fix amounts silently nor change Base's historical FLUX policy.
- Malformed target-chain records, duplicate addresses, case-insensitive duplicate symbols and pinned identity collisions fail the
  entire projection closed, including duplicates involving excluded entries. Shared registration revalidates every asset's chain,
  chainId, decimals and uniqueness. Duplicate display names produce an ambiguous name result; no asset is chosen.
- Count at verification: **202 included ERC-20 records + native ETH = 203 catalog assets**.
  USDC and WETH are featured shortcuts, not a catalog limit. Native USDC and bridged **USDC.e** have distinct addresses.
- No stale/recorded source fallback. Without a successfully registered source, only the three existing pinned assets resolve;
  other references fail closed. Future runtime must re-read code and decimals at Simulate; today's read is not execution authority.
- Logos use BASE-001's existing `CanonicalAsset.logoUrl`, strict HTTPS PREFIXED validation and render-time provider/chain recheck.
  Only the existing reviewed common CoinGecko, Trust Wallet and CoinMarketCap prefixes are used for Arbitrum. Other hosts,
  malformed URLs and absent logos yield the existing monogram fallback. No URL is inferred from a symbol, no image is fetched by
  the parser, and pinned assets retain their existing local marks. No new logo-host policy is introduced.
- The upstream list is GPL-3.0. Its bytes are read at runtime only, never committed or redistributed. The small test fixture is
  FloFi-authored from selected public contract facts, exclusion cases and synthetic foreign records, with a URL reference only.

## Current deployments and read-only protocol proof

### Uniswap v3

The fresh [official deployment feed](https://developers.uniswap.org/deployments.json) records active Arbitrum deployments
(feed v1.0.0, generated 2026-09-22, `Uniswap/contracts@a677c0d4b5fb6e3357cf6d0f0315bcb135a1e1ee`):

| Role | Arbitrum address |
| --- | --- |
| Factory | `0x1f98431c8ad98523631ae4a59f267346ea31f984` |
| SwapRouter02 | `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45` |
| QuoterV2 | `0x61ffe014ba17989e743c5f6cb21bf9697530b21e` |
| NonfungiblePositionManager | `0xc36442b4a4522e871399cd717abdd847ab11fe88` |

All have code. Router, quoter and position manager report this factory and Arbitrum WETH.
The factory reports native USDC/WETH 0.05% pool `0xc6962004f452be9203591991d15f6b388e09e8d0`, with positive in-range liquidity.
A QuoterV2 read of 10 USDC returned **0.003958352828280883 WETH**. This is discovery evidence, not a durable executable quote.

### Aave V3

The [DAO address book](https://github.com/aave-dao/aave-address-book/blob/4250a79306a1de2a98aa3f60bb42fbfcfc612ec7/src/AaveV3Arbitrum.sol)
(file commit 2026-10-09) gives:

| Role | Arbitrum address |
| --- | --- |
| PoolAddressesProvider | `0xa97684ead0e402dc232d5a977953df7ecbab3cdb` |
| Pool | `0x794a61358d6845594f94dc1db02a252b5b4814ad` |
| Oracle | `0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7` |
| Native USDC aToken | `0x724dc807b04555b71ed48a6896b6f41593b8c637` |
| Native USDC variable debt token | `0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6` |

Code exists at each address. Provider/Pool/Oracle relationships and both tokens' underlying and Pool agree.
Pool revision is **11**; native USDC (`USDCn` in the address book) reserve id **12**, **6** decimals, is active,
unfrozen, unpaused and borrowing-enabled. Supply cap 250M versus about 179.09M supplied; borrow cap 225M versus about 159.79M debt;
available USDC about 19.43M; oracle read 0.99988371 USD. These are temporary states requiring fresh validation later.
The existing one-reserve Aave engine can be profiled for this reserve; no profile is activated in Phase 1.

### Router and transfers

The fresh [Across available-routes response](https://app.across.to/api/available-routes) includes native Circle USDC
Base → Arbitrum and Arbitrum → Base. Existing FloFi Router profiles already implement both directions (BASE-001 added the reverse).
Arbitrum SpokePool `0xe35e9842fceaca96570b734083f4a58e8f7c5f2a` reports chain 42161 with deposits/fills unpaused;
its runtime code hash and Base SpokePool `0x09aea4b2242abc8bb4bb78d537a67a245a7bec64` still match FloFi's existing pins.
No second bridge engine or new route is needed. Robinhood routes remain as shipped; they were not independently re-certified here.

Native ETH and [standard ERC-20 transfers](https://eips.ethereum.org/EIPS/eip-20) can reuse FloFi's shared transfer engine.
[Arbitrum fee documentation](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees) describes parent-data cost converted
into child-chain gas. Later profiles must verify Nitro receipt/budget semantics; do not copy Base's separate OP Stack `l1Fee` term.

## Capability matrix

**Classification scope:** SUPPORTED means verified protocol/network availability for the bounded scope below. It does **not** mean
new FloFi runtime availability. The separate runtime column is authoritative for what is implemented today. UNKNOWN / REQUIRES
VERIFICATION is used for facts not established; BLOCKED is used for a known design/policy barrier; UNSUPPORTED is outside the build.
Code records these discoveries in `capabilityDiscoveryRegistry`; authoring/runtime truth remains the existing canonical examples,
profile registries and `executionCapabilityRegistry`.

| Capability | Classification | Protocol / deployment evidence | Existing adapter to reuse | Still needed | FloFi Simulate / Review / runtime now |
| --- | --- | --- | --- | --- | --- |
| Swap | **SUPPORTED** | Uniswap v3 factory/router/quoter above; live pool and read-only quote | `uniswap.v3`, shared catalog swap service | Arbitrum deployment/code-pin profile, chain-bound client, fee semantics, runtime/lifecycle tests | **No** Arbitrum mainnet swap profile |
| Native ETH Transfer | **SUPPORTED** | Official ETH network identity above | `evm.native-transfer` | Arbitrum transfer profile, Nitro fees, lifecycle/recovery tests | **No** |
| ERC-20 Transfer | **SUPPORTED** | ERC-20 standard; verified pinned USDC/WETH and catalog code/decimals | `evm.token-transfer` | Transfer profile, fresh token validation, exact-delta reconciliation | **No** |
| Bridge IN | **SUPPORTED** | Across Base USDC → Arbitrum USDC; existing pools/pins above | `flofi.router`, `CROSSCHAIN_ROUTER_BASE_ARBITRUM`; direct Across or existing LI.FI path | Focused regression later; no new bridge engine | **Yes**, existing gated Router only; no execution performed |
| Bridge OUT | **SUPPORTED** | Across Arbitrum USDC → Base USDC; existing pools/pins above | `flofi.router`, `CROSSCHAIN_ROUTER_ARBITRUM_BASE` | Focused regression later; no new bridge engine | **Yes**, existing gated Router only; no execution performed |
| Pool / Liquidity | **SUPPORTED** | Uniswap v3 position manager/factory above, positive pool liquidity | Shared `catalogLiquidityPool` and concentrated-liquidity service | Arbitrum deployment profile, tier/CREATE2 checks, runtime lifecycle tests | **No** |
| Aave Supply | **SUPPORTED** | Pool/provider/oracle, native USDC reserve id 12 above | `aave-v3`, one-reserve lending engine | USDC profile, runtime checks, lifecycle tests | **No** |
| Aave Borrow | **SUPPORTED** | Same reserve, borrowing enabled and available liquidity above | `aave-v3` | Profile plus collateral/health/cap validation and lifecycle tests | **No** |
| Aave Repay | **SUPPORTED** | Same reserve and variable debt identity above | `aave-v3` | Profile plus debt/approval/reconciliation tests | **No** |
| Aave Withdraw | **SUPPORTED** | Same reserve/aToken identity and liquidity above | `aave-v3` | Profile plus withdrawal/health/reconciliation tests | **No** |

Native-ETH bridging is **BLOCKED** by the existing ERC-20 Router deposit design. Additional bridge token routes, other Aave reserves,
fee-on-transfer/rebasing assets and mainnet lending composition are **UNSUPPORTED** in this bounded build.
Full Arbitrum first-class runtime support therefore remains incomplete even though the Router already serves its routes.

## Shared architecture findings

Two narrow shared assumptions needed correction:

1. Base's parser hard-coded the target network and pins. It is extracted into `uniswap-token-list.ts`; Base keeps its public API,
   exact error prefixes, inclusion rules, logos and output order. Arbitrum contributes a profile with a reviewed FLUX exclusion.
2. `catalogCapabilityNetworks` treated any authored action (including bridges) as proof of catalog swap/transfer/liquidity support.
   It now requires those three actual capabilities before using that collective wording. No hand-written Copilot list is added.

Shared catalog registration previously called `createAssetRegistry`, which only checks duplicate networks, despite claiming to
revalidate assets. Registration now calls `createAssetCatalog` and checks catalog chainId/featured identities before accepting data.
The generic loader loop reads catalog identities from the network registry and accepts an injected Arbitrum loader for later phases.

Canvas action pickers, deterministic commands, natural-language proposals and MCP continue refusing unbuilt Arbitrum actions.
Existing bridge authoring continues using the Router. Catalog names, symbols, trusted logos and network vocabulary are shared;
none enters SemanticWorkflow IR, hashes, Manifest, Review, execution or reconciliation as authority.

## Phase 1 limits

No new runtime profile, environment variable, execution capability row, UI component, panel, layout or styling change.
No Production/Railway/Vercel/Neon change, secret, operator wallet or allowlist. User-wallet authorization remains unchanged.
No full CI, browser/PostgreSQL/fork/Anvil matrix, PR or push. Later phases need fresh state checks; discovery is not certification.
