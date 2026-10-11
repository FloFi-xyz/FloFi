# BUILD-RH-002: Robinhood Chain network integration, discovery

Status: **final, 2026-10-11.**

- Baseline: `60d3d801e7eba8d123412c286bf8c493aa529865`. Branch: `claude/build-rh-002-network-integration`.
- Method: every read was a public HTTPS GET or a read-only JSON-RPC call (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`,
  `eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_estimateGas`, `eth_simulateV1`, `eth_getTransactionReceipt`).
- Nothing was signed, sent or broadcast. No key exists for this build.
- Evidence level of every finding below: **`PUBLIC_READ_ONLY`**.

## 1. Network

- **RPC.** `https://rpc.mainnet.chain.robinhood.com` returns `eth_chainId = 0x1237` (4663). It is an Arbitrum Orbit (Nitro) chain:
  - Receipts carry `gasUsedForL1` and **no `l1Fee`**. The network cost is `gasUsed × effectiveGasPrice`.
  - `eth_maxPriorityFeePerGas` returns 0.
  - The `safe` and `finalized` block tags are served.
  - `eth_simulateV1` is supported. Its gas agreed with `eth_estimateGas` within about 1,000 gas on the probed calls.
- **Official contracts** (unchanged since BUILD-RH-001):
  - Protocol Contracts page: L2 WETH `0x0Bd7…AD73`, L2 Gateway Router `0x1E32…1B89`, Multicall `0x2cAC…DaD1`, Permit2 `0x0000…8BA3`.
  - Token Contracts page: WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (18 decimals) and USDG
    `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals).
  - The page states that a token with a matching ticker but a different address is **not** a Robinhood Stock Token.
- **Runtime code pins (SHA-256):** USDG `c85d18dc…f6db`, WETH `eb5a5f69…60a7`. Full values are in
  `packages/action-registry/src/uniswap-v3-robinhood.ts`.

## 2. Official Stock Token registry

Source: `GET https://api.robinhood.com/rhj/assets`, documented at https://docs.robinhood.com/chain/stock-token-apis.

- **194 assets.**
  - All are `ASSET_STATUS_ACTIVE`, each with exactly one deployment on chain 4663, and `tokenDecimals = 18`.
  - No duplicate ids, symbols or contract addresses.
  - `currentMultiplier` is an 18-dp decimal string: 49 assets are above 1.0, 145 are exactly 1.0, none are below. No multiplier change is pending.
- **Capture.** The response is committed as the deterministic test capture
  `packages/action-registry/test/fixtures/robinhood-rhj-assets-2026-10-11.json`
  (SHA-256 `f8c058b28cd8697494ff1c40574014492953fc4594b622601dcf66e6fc1944df`). The product reads the live registry only; the capture
  feeds tests and the loopback browser harness.
- **`tradingCapabilities` shape.** The documented and live shapes differ:
  - The docs describe underlier flags.
  - The live data is sessions (`market`/`extended`/`overnight`) × `whole`/`fractional`, with `TRADING_STATUS_*` values. 191 assets
    are fully tradable; WYFI, SLS and XNDU have fractional trading `UNTRADABLE`.
  - The parser accepts both shapes and fails closed on anything else.
- **Checksums.** Every address passes EIP-55. The LLY address is legitimately all-lowercase under EIP-55.
- **Featured five.** Shortcuts only; every one of them is also in the 194:

  | Symbol | Address | Multiplier |
  | --- | --- | --- |
  | AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 1.000566080061092436 |
  | TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 1.000000000000000000 |
  | NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 1.000775159164630595 |
  | MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 1.000412952576205964 |
  | AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 1.000000000000000000 |

- **Contracts.** Every Stock Token is the same 283-byte ERC-1967 **beacon proxy**:
  - runtime SHA-256 `399ec4bc5b43db03486ceae11f9a6fc5c126427f8f8e10c90fed0c773f4325c6`
  - beacon `0xe10b6f6b275de231345c20d14ab812db62151b00`
  - beacon slot `0xa3f0…3d50`
  - `uid()` (`0xf514ce36`) returns the registry id. `uiMultiplier()` (`0xa60bf13d`), `newUIMultiplier()` (`0xdc767007`) and
    `effectiveAt()` (`0x97a4064f`) expose the current multiplier and any scheduled change.
  - Transfers also emit `TransferWithScaledUI` (`0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802`).
- **Multiplier semantics** (Building with Stock Tokens):
  - Underlying shares = raw amount × `uiMultiplier()` / 1e18. Raw balances never rebase.
  - REST `/prices` excludes the multiplier, and FloFi never uses it as value.
  - `GET /rhj/corporate-actions` works.
- **Jurisdiction.** Stock Tokens are not offered to US persons and are restricted in several jurisdictions. Review shows the issuer's
  notice.

## 3. Swap and liquidity venue: Uniswap v3

- **Deployments.** `https://developers.uniswap.org/deployments.json` (v1.0.0, generated 2026-09-22, `Uniswap/contracts@a677c0d`) lists
  49 `labs-supported`, `active` records for chain 4663:
  - Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
  - SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`
  - QuoterV2 `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`
  - NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`
- **Code pins.** Runtime SHA-256 of each was read at block 85,478,379 and pinned (factory `6c410516…`, router `a84426d2…`, quoter
  `cbe79270…`, NPM `79320124…`).
- **Deployment relationships.** Router, quoter and NPM each report `factory()` = the factory and `WETH9()` = the official WETH.
- **Pool identity.** The canonical v3 init-code hash `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` reproduces
  the factory's own `getPool` answers by local CREATE2 derivation:
  - TSLA/USDG 0.3% `0xf4acdaee…`
  - USDG/WETH 0.01% `0x52e65b17…`

  A v3 pool's runtime code embeds its own immutables, so pools are proven by CREATE2 from the pinned factory and confirmed by
  `getPool`, `token0`/`token1`/`fee`/`tickSpacing`. No single pool code pin is used.
- **Pool census.** All 194 Stock Tokens were checked against USDG and WETH at fees 100/500/3000/10000, plus USDG/WETH:
  - 438 pools exist; 203 have in-range liquidity.
  - **95 of 194** tokens have a live USDG pool; 64 of them hold at least 1,000 USDG.
  - USDG/WETH 0.01% holds about 6.27M USDG and about 5,532 WETH.
  - All five featured tokens have live USDG pools.
- **Sample quote.** QuoterV2 answered live: 100 USDG → 0.2603 TSLA at 0.3%.
- **Result:** SWAP and POOL/LIQUIDITY are **SUPPORTED** on the canonical venue. A pair without a live pool at the chosen tier fails
  closed at Simulate.

## 4. Bridge: Across, through FloFi's Cross-chain Router

- **Routes.** `app.across.to` serves Base, Arbitrum and Ethereum **USDC ↔ Robinhood USDG**, plus WETH and native ETH routes.
- **Robinhood SpokePool** `0xD29C85F15DF544bA632C9E25829fd29d767d7978`:
  - a 225-byte ERC-1967 proxy, SHA-256 `10efc5eecc7c3f396d1ffe6d0e562751b603af26122eb44fc3fdfe135dbe9d04`, implementation
    `0x1771c470…`
  - reports chain id `0x1237` and the official WETH as wrapped native
  - deposits and fills are not paused
  - `depositQuoteTimeBuffer` 3600 and `fillDeadlineBuffer` 21600
- **Swap API.** The Across Swap API answers each direction with the **source** SpokePool as `swapTx.to` and allowance spender
  (selector `0xad5425c6`, already decoded by the router codec):

  | Direction (10 units) | Output | Itemized fees |
  | --- | --- | --- |
  | Base USDC → Robinhood USDG | 9.986552 USDG, fill ≈ 1 s | relayer capital 1,000, destination gas 7,453, LP 0, `internalizedSwap` 4,995 (0.05% stablecoin conversion) |
  | Robinhood USDG → Base USDC | 9.990574 USDC | `internalizedSwap` 4,997 |

  The WETH route has no `internalizedSwap`.
- **LI.FI.** LI.FI lists chain 4663 and quotes through `across`:
  - Robinhood Diamond `0xB477751B76CF82d00a686A1232f5fCD772414Af3` (`f944e98f…`).
  - Fee forwarder `0xf4bffe4d…7cf1` (`8e1f9e10…`, the same code as on Base).
  - Arbitrum Diamond `0x1231DEB6…` (`72211202…`); Arbitrum fee forwarder `0xce40449b…` (`8e1f9e10…`).
  - **LI.FI does not itemize the USDC→USDG conversion.** For 10 USDC its fee lines sum to 33,467 units while input − output = 38,450;
    the unexplained 4,983 is the conversion. FloFi's normalizer therefore refuses the LI.FI route (`LIFI_FEES_INCONSISTENT`, fail
    closed) and the AUTO policy falls back to Across direct.
- **Result:** BRIDGE IN/OUT is **SUPPORTED** for Base ↔ Robinhood and Arbitrum ↔ Robinhood (USDC ↔ USDG).

## 5. Transfer

Native ETH (`evm.native-transfer`) and canonical ERC-20 `transfer(recipient, amount)` (USDG, WETH, Stock Tokens). Stock Token
transfers emit both `Transfer` and `TransferWithScaledUI`; the reconciler reads `Transfer` and the raw balance delta.
**SUPPORTED.**

## 6. Bounded, not built

| Item | Gate | Reason |
| --- | --- | --- |
| Ethereum mainnet routes | **BLOCKED** | FloFi refuses Ethereum mainnet as an execution network (BUILD-ETHEREUM-001). Opening it is an owner decision. |
| Native-ETH bridging | **BLOCKED** | The router's canonical route is ERC-20 approve + deposit with `value = 0`. |
| WETH bridge routes | not built | Same router path as USDC; left out to keep this build to the USDC ↔ USDG pairs that were reviewed end to end. |
| Lending (Morpho, borrow, supply, repay) | out of scope | Excluded by the brief. |
