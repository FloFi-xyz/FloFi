# BUILD-RH-002 — Robinhood Chain network integration: discovery (DRAFT, in progress)

Status: **partial draft, 2026-10-11.** Baseline `60d3d801e7eba8d123412c286bf8c493aa529865`, branch
`claude/build-rh-002-network-integration`. Every read below was a public GET or a read-only JSON-RPC call
(`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_call`). Nothing was signed or sent. Evidence level for
all findings: `PUBLIC_READ_ONLY`.

## 1. Network (revalidated)

- Mainnet RPC `https://rpc.mainnet.chain.robinhood.com` returned `eth_chainId = 0x1237` (4663), head ≈ 0x51831ae.
- The official Protocol Contracts page is unchanged from BUILD-RH-001: L2 WETH `0x0Bd7…AD73`, L2 Gateway Router
  `0x1E32…1B89`, L2 Multicall `0x2cAC…DaD1`, Permit2 `0x0000…8BA3`.
- The official Token Contracts page lists WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` and USDG
  `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. It also says that a token with a matching ticker but a different
  address is **not** a Robinhood Stock Token. On-chain reads: USDG has 6 decimals, symbol `USDG`. WETH has 18.

## 2. Stock Token registry (official)

Source: `GET https://api.robinhood.com/rhj/assets`, documented at https://docs.robinhood.com/chain/stock-token-apis.

- **194 assets**, all `ASSET_STATUS_ACTIVE`, each with exactly one deployment on chain 4663.
- There are no duplicate symbols, ids or contract addresses. Every asset has `tokenDecimals = 18`.
  `currentMultiplier` is an 18-dp decimal string; 49 assets are above 1.0, 145 are exactly 1.0, none are below.
  There are no pending multipliers right now.
- Live fields: `id`, `tokenSymbol`, `tokenName`, `deployments[]` (`contractAddress`, `chainId`, `networkName`,
  `itnEnabled`, `atomicEnabled`), `currentMultiplier`, `pendingMultiplier`, `status`, `logoUrl` (cdn.robinhood.com),
  `tradingCapabilities`, `tokenDecimals`, `isin`.
- Documented but absent at this moment: `pendingMultiplierEffectiveTime` (RFC-3339, present only while a change is
  pending).
- **The documented and live `tradingCapabilities` shapes differ.** The docs describe `fractionalTradability`,
  `allDayTradability` and `extendedHoursFractionalTradability`. The live data has `market`/`extended`/`overnight` ×
  `whole`/`fractional` with `TRADING_STATUS_*` values: 191 assets are fully tradable and 3 have fractional
  UNTRADABLE. The parser must accept both shapes and fail closed on anything else.
- Featured five (official addresses):

  | Symbol | Address | Multiplier |
  | --- | --- | --- |
  | AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 1.000566080061092436 |
  | TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 1.000000000000000000 |
  | NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 1.000775159164630595 |
  | MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 1.000412952576205964 |
  | AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 1.000000000000000000 |

- Multiplier semantics (Building with Stock Tokens): underlying shares = raw amount × `uiMultiplier()` / 1e18. Raw
  balances never rebase. `newUIMultiplier()` and `effectiveAt()` expose a pending change. The Chainlink feed already
  includes the multiplier, and REST `/prices` does **not**. Docs: "Onchain swaps remain unaffected" by the multiplier.
- `GET /rhj/corporate-actions` works (1 h cache). For example, it shows in-progress cash dividends for MU, INTU and GE.
- Jurisdiction: Stock Tokens may not be offered to US persons and are restricted in Canada, the UK, Switzerland and
  other jurisdictions.

## 3. Swap / liquidity venue: Uniswap v3 (canonical)

- `https://developers.uniswap.org/deployments.json` (v1.0.0, generated 2026-09-22, `Uniswap/contracts@a677c0d`) has
  49 records for chain 4663, `labs-supported`, `active`. v3: Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`,
  NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, QuoterV2
  `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`, SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`. v4 and
  UniversalRouter records are also present.
- I queried `getPool` on the canonical factory for every official Stock Token against USDG and WETH at fees
  100/500/3000/10000, plus USDG/WETH. The results:
  - 438 pools exist and 203 have active in-range liquidity.
  - 95 of the 194 tokens have a live USDG pool. 64 of them hold at least 1,000 USDG on the USDG side.
  - USDG/WETH 0.01% `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` holds ≈ 6.27M USDG and ≈ 5,532 WETH.
  - All five featured tokens have live USDG pools. Examples: TSLA/USDG 0.3% `0xf4acdaeeb7022862a763c9b1b885e11191c889e3`
    (≈ 236 TSLA / ≈ 329,944 USDG), AAPL/USDG 0.05%, NVDA/USDG 0.05%, MSFT/USDG 0.3% and AMZN/USDG 0.3%.
- Preliminary result: **SWAP and POOL/LIQUIDITY look SUPPORTABLE** through the canonical Uniswap v3 factory, with pools
  resolved by `getPool`. They are not permissionless lookalikes. Still to verify: QuoterV2 quotes, code pins, and
  router `WETH9()`/`factory()` relationships.

## 4. Bridge: Across (mainnet)

- `app.across.to/api/available-routes` has 38 routes into 4663 and 39 out of it, including:
  - Base, Arbitrum and Ethereum **USDC → Robinhood USDG** (and USDG → USDC on the way out)
  - WETH → WETH, and ETH → ETH (native)
- `suggested-fees` for 10 USDC Base → Robinhood USDG was live: output 9.986637 USDG, fill ≈ 1 s, min deposit ≈ 0.5
  USDC. Origin SpokePool `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64` (the Base pool already pinned in the router).
  **Robinhood SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978`.**
- Preliminary result: **BRIDGE IN/OUT looks SUPPORTABLE** for the cross-asset USDC ↔ USDG and ETH/WETH routes.
  `RouterProfile` currently hard-codes `usdc` on both sides and must be generalized to source and destination assets.
  Still to verify: SpokePool code pin on 4663 and LI.FI quote.

## 5. Transfer

The existing `evm.native-transfer` profile pattern (RH-DEMO-001 on testnet, TESTNET_EXECUTED) covers native ETH. ERC-20
and Stock Token transfers need a canonical ERC-20 transfer path. Not yet investigated.

## Not yet done

LI.FI checks, Across SpokePool code pin, QuoterV2 sample quotes, ERC-20 transfer design, plan, implementation, tests,
report, PR.
