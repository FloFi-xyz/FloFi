# BUILD-BASE-001: Base network integration, discovery

Status: **final, 2026-10-11.**

- Baseline: `9ef339354ac2292281093609ad5ac3c6aaf73c0c` (`main` after PR #80). Branch: `claude/build-base-001-network-integration`.
- Method: every read was a public HTTPS GET or a read-only JSON-RPC call (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`,
  `eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getTransactionReceipt`).
- Nothing was signed, sent or broadcast. No key exists for this build. No approval, faucet or production change.
- Evidence level of every finding below: **`PUBLIC_READ_ONLY`**.

## 1. Network

- **Official source:** <https://docs.base.org/get-started/connect-to-base> (the old `…/quickstart/connecting-to-base` path redirects
  there; Markdown SHA-256 `0536ed8e…4a1c`):

  | Field | Base Mainnet |
  | --- | --- |
  | Chain ID | `8453` (`0x2105`), CAIP-2 `eip155:8453` |
  | RPC | `https://mainnet.base.org` |
  | Transaction submission | `https://mainnet-sequencer.base.org` (send only; FloFi never sends) |
  | Currency | ETH (18 decimals) |
  | Explorer | `https://basescan.org` |

- **Chain.** `https://mainnet.base.org` returns `eth_chainId = 0x2105`. Head ≈ 52,469,000 at the time of these reads.
- **Fees (OP Stack).** Receipts carry `l1Fee` (and `l1GasUsed`, `l1BaseFeeScalar`, `daFootprintGasScalar`). The owner's network cost is
  `gasUsed × effectiveGasPrice + l1Fee`. Base fee 0.005 gwei; suggested priority fee 0.001 gwei.
- **GasPriceOracle predeploy** `0x420000000000000000000000000000000000000F`: code present (SHA-256 `5dcd6f46…a112`), `isEcotone()` and
  `isFjord()` both true. It is the L1-fee bound already used by FloFi's Base Sepolia flows.
- **Wallets.** Base is a well-known network; the wallet table already switches to `0x2105`. The official EIP-3085 parameters above are
  the only ones FloFi may add after a `4902` response.

## 2. Asset catalog source

### 2.1 Candidates

| Source | Base entries | Assessment |
| --- | --- | --- |
| **Uniswap Labs Default Token List** (`https://tokens.uniswap.org`, v22.26.0, 2026-10-08T17:54:32Z, 1,784 tokens, SHA-256 `aaf0c47f…296e`, ETag `QmXY4md6…jzm`) | **159** | Curated by Uniswap Labs for its own interface, which is FloFi's swap and liquidity venue on Base. No duplicate symbols or addresses among Base entries. Served `200 application/json`, `cache-control: no-store`, no redirect. |
| Superchain Token List (`static.optimism.io/optimism.tokenlist.json`, v10.0.1769) | 326 | Bridged-token registry. Duplicate symbols (`ARC`, `LIZ`, `PEPE`), emoji and non-ASCII symbols, and no `cbBTC` or `AERO`. Not used. |
| An official Base-published token list | — | None found. |

**Decision.** The Base catalog is:

- **Code-pinned protocol assets:** ETH (native), Circle USDC `0x8335…2913` (6 decimals) and the OP Stack WETH predeploy `0x4200…0006`
  (18 decimals). These are the assets FloFi already pins for Base (`BASE_BASE_ASSETS`, `baseAssetRegistry`). They are pinned
  because the Router, Aave and the existing Base reference swap depend on their exact identity.
- **Plus** every Base entry of the live Uniswap Labs Default Token List that passes FloFi's inclusion policy (§2.3).

### 2.2 On-chain verification of the 159 entries (block 52,468,999)

Every Base entry was read on chain (`eth_getCode`, `decimals()`, `symbol()`):

- All 159 have code.
- **Two entries carry the wrong decimals:**
  - FLUX `0xb008…dd44`: the list says 18; the chain says **8**.
  - WMTX `0x3e31…e98d`: the list says 18; the chain says **6**.

  Catalog membership alone is therefore never trusted for amounts. FloFi re-reads `decimals()` at Simulate and fails closed on any
  difference. This is part of the test matrix.
- Ten on-chain symbols differ from the list's only in case or suffix: `apxUSD`, `Basecat`, `cbDOGE`, `cbMEGA`, `DOVU[base]`, `FUN`, `JitoSOL`,
  `Mog`, `noice`, `uTAO`. Display uses the list symbol; identity is chain + address + decimals.
- Decimals distribution: 18 (140), 6 (9), 8 (8), 9 (1), 2 (1).

### 2.3 Inclusion policy

A Base entry is projected only if it satisfies all of the following:

- `chainId` is 8453.
- It has an EIP-55 checksummed address and integer decimals 0–36.
- Its symbol is 1–16 characters, starting with a letter, from `A–Z a–z 0–9 .`.
- It has a name of 1–160 characters with no control characters.

Entries on other chains are not Base assets and are ignored. Two cases fail the **whole** catalog closed, as for Robinhood:

- A malformed Base record (bad checksum, decimals, name or shape).
- A duplicate, or a symbol or address that collides with a pinned asset under a different identity.

Entries outside the FloFi symbol grammar (today only `1INCH`, which starts with a digit) are counted and excluded, never renamed.
`logoURI` values point at third-party hosts and are dropped. There is no recorded or stale fallback: when the live list is
unavailable, only the pinned ETH/USDC/WETH resolve and authoring that needs another asset fails closed (`ASSET_CATALOG_UNAVAILABLE`).

### 2.4 License

The Uniswap default token list repository is **GPL-3.0**. `docs/LICENSE_MAP.md` excludes unverified third-party material
(`EXCLUDED_UNLESS_VERIFIED`), and `packages/action-registry/**` is Apache-2.0. FloFi therefore:

- reads the list at runtime, server-side;
- never commits or redistributes its bytes;
- uses a FloFi-authored fixture for tests and the loopback harness: token-list *format*, Base assets whose address, symbol, name and
  decimals were read directly from chain, plus the two wrong-decimals cases above.

This is recorded as an owner decision.

## 3. Swap and liquidity venue: Uniswap v3

- **Deployments.** `https://developers.uniswap.org/deployments.json` (v1.0.0, generated 2026-09-22, `Uniswap/contracts@a677c0d`,
  SHA-256 `221f66d3…4070`) lists `labs-supported`, `active` v3 records for chain 8453:
  - UniswapV3Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`
  - SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`
  - QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
  - NonfungiblePositionManager `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`

  These are the same addresses FloFi already pins for Base (BUILD-002 observation, BUILD-006 fork liquidity).
- **Code pins (runtime SHA-256, block 52,468,924):**

  | Contract | SHA-256 | Repo pin |
  | --- | --- | --- |
  | factory | `8545609892cc8d7d608dd4420ee110ab98448730570824fb029228e33846d28c` | equal (BUILD-002) |
  | QuoterV2 | `a204e355059d9c809bfc026503d49b4ecf8655f482a76040dec4bcb4618047b4` | equal (BUILD-002) |
  | SwapRouter02 | `cdd0e7bce67f3b8cc4a3f517beaa9afa00ea25ee7b6c6ff14a60898228289ef6` | new |
  | NonfungiblePositionManager | `54aa74382a5aade77e59efffb53208ca5c3d3a679daa2853881381e04b25c48d` | new |
  | USDC (FiatToken proxy) | `98d785fcb1bf847f287adc2310759fd94cc13e754b974bc72131382e8266f607` | equal (BUILD-002, Router) |
  | WETH predeploy | `667c900c2c6da80d452501a9c6332e046384a0c438c3334ce6f71c86dd7b8735` | equal (BUILD-002) |

- **Relationships.** SwapRouter02, QuoterV2 and the Position Manager each report `factory()` = the factory and `WETH9()` = `0x4200…0006`.
- **Pool identity.** The canonical v3 init-code hash `0xe34f199b…8b54` (the one FloFi already uses on Robinhood Chain) reproduces the
  factory's own `getPool` answer by local CREATE2 derivation: USDC/WETH 0.05% = `0xd0b53d9277642d899df5c87a3966a349a798f224`.
  Fee tiers 100/500/3000/10000 are enabled with tick spacing 1/10/60/200.
- **Pool census (block 52,469,069).** Every list token was checked against USDC and WETH at the four tiers:
  - 1,268 combinations, 347 pools exist, 117 have in-range liquidity.
  - **62 of 159** tokens have a live USDC or WETH pool; 26 of them hold at least ≈ $1,000 on the quote side.
  - **Catalog membership ≠ liquidity:** the rest have no usable pool, and a swap or position on them fails closed at Simulate.
- **Sample quotes (QuoterV2, block 52,469,125):**

  | Input | Best tier | Output |
  | --- | --- | --- |
  | 100 USDC → WETH | 0.01% | 0.039994094921443844 WETH (0.05%: 0.039975…, 0.3%: 0.039828…) |
  | 0.01 WETH → cbBTC | 0.05% | 0.00030114 cbBTC (0.01% pool: 0.00002914, thin) |
  | 10 USDC → ZORA | 0.3% | 1,368.02 ZORA |

- **Representative non-featured asset: cbBTC.** Coinbase Wrapped BTC, `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`, 8 decimals:
  - in the list;
  - deep cbBTC/WETH 0.05% pool (≈ 5,675 WETH on the WETH side);
  - also an Aave reserve (§5), but lending stays USDC-only (§5).
- **Result:** SWAP and POOL/LIQUIDITY are **SUPPORTED** on the canonical venue.

## 4. Bridge: Across through FloFi's Cross-chain Router

- **Routes** (`app.across.to/api/available-routes`, 2026-10-11):
  - Base USDC → Arbitrum USDC (existing pair)
  - **Arbitrum USDC → Base USDC (new)**
  - Base USDC → Robinhood USDG and back (existing RH-002 pairs)

  Across also lists WETH/ETH routes and the Arbitrum USDC → Base USDbC variant.
- **SpokePools (block 52,469,385 on Base, 513,839,877 on Arbitrum):**

  | Pool | Address | Runtime SHA-256 | Implementation |
  | --- | --- | --- | --- |
  | Base | `0x09ae…ec64` | `3cc5e539…0545` (repo pin) | `0xf23c6c04…e6b0` |
  | Arbitrum | `0xe35e…5f2a` | `3cc5e539…0545` (repo pin) | `0xcfcda843…f8c9` |

  Each pool reports its own `chainId()`, deposits and fills are not paused, `depositQuoteTimeBuffer` 3600 and `fillDeadlineBuffer` 21600, and
  the wrapped native token is that chain's WETH.
- **Token and LI.FI pins:**
  - Base USDC `98d785fc…f607` and Arbitrum USDC `b46445c0…55c8`: both repo pins.
  - LI.FI: Base Diamond `a5f481fb…a296`, Arbitrum Diamond `72211202…c2e9`, fee forwarder `8e1f9e10…8981` on both chains, all repo pins.
- **Across Swap API**, Arbitrum → Base, 10 USDC:
  - `swapTx.to` and the approval spender are the Arbitrum SpokePool. Selector `0xad5425c6` is already decoded by the router codec.
  - Output 9.995581 USDC (fill ≈ 1 s).
  - Fees: relayer capital 1,000, destination gas, LP 0, and a `swapImpact` line of −17.
- **LI.FI** (`allowBridges=across`), Arbitrum → Base, 10 USDC:
  - Arbitrum Diamond `0x1231…4EaE` is both the approval address and `tx.to`.
  - Output 9.970587 USDC.
  - Fees: LI.FI fixed 25,000, relayer 997 and relayer gas 3,416. They sum to exactly input − output (29,413), so the existing normalizer
    can accept the route.
- **Result:** BRIDGE OUT is **SUPPORTED** and already shipped (Base → Arbitrum, Base → Robinhood). BRIDGE IN is **SUPPORTED**:
  Robinhood → Base already ships, and Arbitrum → Base is new in this build.

## 5. Lending: Aave V3 on Base

- **Source.** `aave-dao/aave-address-book` `src/AaveV3Base.sol` at `main` `b5da40f` (2026-10-11T00:31:49Z), SHA-256 `135e2f32…02ae`:

  | Contract | Address |
  | --- | --- |
  | PoolAddressesProvider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
  | Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
  | Oracle | `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` |
  | USDC aToken | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` |
  | USDC variable debt token | `0x59dca05b6c26dbd64b5381374aAaC5CD05644C28` |

- **On chain (block 52,469,150):**
  - `getPool()` = Pool, `getPriceOracle()` = Oracle, and Pool `ADDRESSES_PROVIDER()` = Provider.
  - The Pool proxy implementation is `0xA4Ab…dFdB`, the address book's `POOL_IMPL`.
  - **`POOL_REVISION` 11 = Aave v3.7** (`aave-v3-origin` v3.7.0 `PoolInstance`).
  - Base Sepolia, the engine's reference deployment, reports revision 10 = v3.6. The repo's older note that it is v3.4 is outdated.
  - v3.7 removes isolation mode, siloed borrowing, the price-oracle sentinel and `dropReserve`. Supply, borrow (variable), repay and
    withdraw accounting is unchanged. `getReserveData` still returns the 15-word legacy layout FloFi decodes.
- **USDC reserve** (the engine is one verified asset per network, as on Base Sepolia):
  - **id 4**, 6 decimals; aToken and variable-debt token match the address book and report this underlying and Pool.
  - Active, not frozen, not paused, borrowing enabled.
  - LTV 75%, liquidation threshold 78%, liquidation bonus 105%.
  - Supply cap 230M with ≈ 181.4M supplied; borrow cap 207M with ≈ 163.8M borrowed.
  - Normalized income ≥ 1e27; oracle price 0.9998 USD.
- **Other verified reserves (not built):**
  - WETH: id 0, LTV 80%.
  - cbBTC: id 6, 8 decimals, LTV 73%, active.

  FloFi's Aave engine binds exactly one reserve per network profile. Adding them is a separate generalization (an owner decision, §8).
- **Result:** SUPPLY, BORROW, REPAY and WITHDRAW are **SUPPORTED** for USDC on the existing engine semantics.

## 6. Transfer

- Native ETH is a plain value transfer to an EOA.
- Catalog ERC-20s use the standard `transfer(recipient, amount)` and emit `Transfer`.
- Base receipts carry `l1Fee`, so the transfer fee budget and reconciliation must include the OP Stack L1 data fee.
- **Result:** **SUPPORTED** (the engine gains the L1-fee term).

## 7. Capability matrix

| Capability | FloFi at baseline | Base mainnet venue | Verified | Decision |
| --- | --- | --- | --- | --- |
| Asset catalog | Pinned ETH/USDC/WETH (RH-002 static catalog) | Pinned assets + live Uniswap Labs Default Token List (159 Base entries) | yes (§2) | **SUPPORTED** |
| Swap | BUILD-002 read-only observation and fork (Mode A/B) on USDC/WETH; no mainnet execution row | Uniswap v3 SwapRouter02 + QuoterV2, CREATE2 pools | yes (§3) | **SUPPORTED** |
| Bridge OUT (Base → Arbitrum) | shipped (BUILD-ROUTER-001) | Across via `flofi.router` | yes (§4) | **SUPPORTED**, unchanged |
| Bridge OUT (Base → Robinhood) | shipped (RH-002) | Across | yes (§4) | **SUPPORTED**, unchanged |
| Bridge IN (Robinhood → Base) | shipped (RH-002) | Across | yes (§4) | **SUPPORTED**, unchanged |
| Bridge IN (Arbitrum → Base) | none | Across via `flofi.router` (LI.FI or direct) | yes (§4) | **SUPPORTED**, built |
| Transfer ETH | none | native transfer | yes (§6) | **SUPPORTED**, built |
| Transfer ERC-20 | none | catalog ERC-20 `transfer` | yes (§6) | **SUPPORTED**, built |
| Pool / liquidity | BUILD-006 fork-only USDC/WETH | Uniswap v3 NonfungiblePositionManager | yes (§3) | **SUPPORTED**, built (catalog pairs, standard tiers) |
| Supply / Borrow / Repay / Withdraw | Base Sepolia (USDC), Ethereum Sepolia (WBTC) | Aave V3.7, USDC reserve id 4 | yes (§5) | **SUPPORTED**, built (USDC) |
| Lending composition (supply → borrow → swap) | Base Sepolia only | — | component actions not demonstrated on mainnet | **UNSUPPORTED** in this build (not generalized) |
| Native-ETH bridging | — | Across native routes exist | the router's route is ERC-20 approve + deposit (`value = 0`) | **BLOCKED** by the existing router design |
| WETH bridge routes | — | Across lists them | not reviewed end to end | **UNSUPPORTED** (not built) |
| Ethereum mainnet routes | — | — | FloFi refuses Ethereum mainnet (BUILD-ETHEREUM-001) | **BLOCKED** (owner decision) |

## 8. Bounded, not built

- **More Aave reserves** (WETH, cbBTC verified active): the engine binds one reserve per network profile. Multi-reserve profiles need
  (chain, asset) profile selection across compiler, linter, executor and reconciler.
- **Lending composition on mainnet:** stays on Base Sepolia until its component actions are demonstrated.
- **Fee-on-transfer or rebasing list tokens:** the swap, transfer and liquidity reconcilers require exact balance deltas. Such a token
  reconciles as `DIVERGENT`, never as success. The catalog does not pre-screen for it.

## 9. No transaction statement

No transaction was signed, sent, simulated with a key or broadcast. No approval, faucet request, wallet connection, deployment-variable
change or production mutation occurred. The simulated owner in provider quotes is the public address `0x1111…1111`. Quoting
from an address needs no authority over it.
