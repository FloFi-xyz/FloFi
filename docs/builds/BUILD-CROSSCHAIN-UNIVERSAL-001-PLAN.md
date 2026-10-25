# BUILD-CROSSCHAIN-UNIVERSAL-001 — Universal Cross-chain Router: plan

Base: `main` `fbc683b` (PR #120 merged). Branch `claude/build-crosschain-universal-001`. One build, one PR.

## 1. Audit of the current Router

| Area | Current state (`fbc683b`) |
| --- | --- |
| Intent | `asset.bridge` node, adapter `flofi.router` 1.0.0 (`workflow-contracts/src/router.ts`). Closed construction over a fixed pair table (`router-pairs.ts`): 12 EVM mainnet pairs, USDC/USDG only, plus one testnet pair. |
| Providers | LI.FI (`allowBridges=across`, LI.FI Diamond) and Across direct (SpokePool `deposit`). Both normalized into `flofi.route.v1`; calldata decoded independently and compared with every API field (`router-providers.ts`). |
| Execution | One service per pair profile (`router-service.ts`, `router-runtime.ts`), its own flow and journal namespace per pair. `eth_simulateV1` of the exact calls, pinned runtime code hashes, `FundsDeposited`/`FilledRelay` reconciliation, owner+nonce and deposit-identity claims (HOTFIX #120: no wallet-wide block). |
| Ecosystems | EVM only. Solana has its own engines (Jupiter, Orca, transfers) with a dependency-free v0 codec (`reference-compiler/src/solana.ts`), server-side broadcast of wallet-signed bytes, Lighthouse guard verification and message/signature claims (`solana-transaction-claim.ts`). |
| Channels | Strategy spec `bridge` (`engine/strategy-spec.ts`) allows EVM sources only; MCP `previewPlan` maps a bridge to one per-pair flow. |
| Fees | No FloFi fee is collected or recorded on `main` (BUILD-CHAT-E2E-001 §6, ADMIN docs). LI.FI's own fee is disclosed as an `INTEGRATOR` line. |

The existing per-pair Router stays exactly as it is (certified EVM behaviour, saved workflows, run logs, flows). The universal router is additive.

## 2. Provider investigation (read-only, 2026-10-25)

All probes used random addresses and public HTTP APIs only; no key, no signature, no transaction.

| Provider | Our five networks | Finding |
| --- | --- | --- |
| **Relay** (`api.relay.link`) | Solana, Base, Arbitrum, Ethereum, Robinhood (`/chains`) | Quotes for every directed pair, same-asset and cross-asset (USDC→SOL, SOL→ETH). Source step is a direct Depository deposit: EVM `depositErc20(depositor, token, amount, id)` / `depositNative(depositor, id)` on `0x4cd00e387622c35bddb9b4c962c136462338bc31` (same address on all four EVM chains); Solana `deposit_token` / `deposit_native` on program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`. The quote carries `protocol.v2.orderData` + `orderId`; **`orderId` is the EIP-712 `hashStruct` of the normalized order** (settlement-sdk `getOrderId`). FloFi's dependency-free reimplementation reproduced four live orderIds exactly. The deposit's `id` is that orderId, so the on-chain deposit is cryptographically bound to the order's recipient, destination currency, minimum output, refunds and deadline. |
| **LI.FI** (`li.quest`) | All five (`/chains`; Robinhood key `out`, Diamond `0xb477…4af3`) | `/advanced/routes` returned routes for all 20 pairs through ~12 bridges (relaydepository, mayan, mayanMCTP, mayanFastMCTP, across, near, layerswap, lifiIntents, glacis, chainflip, polymer, symbiosis). Every route carries LI.FI's own fee (`LIFI Fixed Fee`, 0.25% observed). |
| **Mayan** (`price-api.mayan.finance`, `sia.mayan.finance/v6/init`) | Solana, Ethereum, Base, Arbitrum (origin and destination active). **No Robinhood Chain.** | Live quotes (e.g. Solana USDC → Base USDC: FAST_MCTP and MCTP). Mayan transaction construction is SDK-side (no hosted transaction builder). |
| **Across** (`app.across.to`) | Base, Arbitrum, Ethereum, Robinhood. **No Solana routes** in `available-routes`. | EVM↔EVM: USDC, USDT, WETH, ETH, WBTC, USDC→USDG. Existing certified Router covers the USDC/USDG pairs. |

## 3. Architecture

```
strategy spec / Canvas form / Copilot / MCP / Telegram
        │  (structured intent, never addresses of contracts or calldata)
        ▼
workflow-contracts: universal-router.ts      ← networks, addresses, `flofi.router.universal` node, `flofi.universal-route.v1`
        ▼
server/universal-router/
   discovery.ts   → asks every provider for the pair; classifies each candidate:
                    SUPPORTED_BY_PROVIDER · LIVE_QUOTE · EXECUTABLE · TEMPORARILY_UNAVAILABLE · NO_ROUTE
   relay.ts       → quote → verify order hash, deposit tx, tokens, fees, deadline → canonical route (EXECUTABLE)
   lifi.ts        → discovery + quotes (all bridges); EXECUTABLE only where FloFi verifies the bridge
   mayan.ts       → discovery + quotes
   across.ts      → discovery + quotes; legacy USDC/USDG pairs execute on the existing certified Router
   service.ts     → simulate (EVM eth_simulateV1 / Solana simulateTransaction) → Review commitment → authorize →
                    begin (same-provider re-quote, compare, no fallback) → wallet → report/submit → observe → reconcile → evidence
        ▼
backend flow `crosschain-universal` (cloud parity, ownership, workers) · server actions · Canvas panel · channels
```

### Verification model (no third-party payload is trusted)

- **EVM source.** FloFi encodes the approval (`approve(depository, amount)`, only when allowance is short) and the deposit itself from the
  verified fields and requires the provider's calldata to equal FloFi's encoding byte for byte. Target = pinned Depository (runtime code
  hash verified at Review and again before every wallet request). Native deposits carry `value == amount`, token deposits `value == 0`.
- **Solana source.** FloFi derives every account (depository PDA, vault PDA, owner ATA, vault ATA, token program) and builds the deposit
  instruction itself; Relay's instruction must match byte for byte. FloFi compiles the v0 message (compute budget + deposit), binds its
  hash, verifies the wallet's signed bytes (reviewed message, or reviewed message + verified Phantom Lighthouse assertions — HOTFIX #120),
  claims message and signature identities, and broadcasts once.
- **Order.** `orderId == hashStruct(orderData)`; exactly one input (source chain, source token, exact amount); exactly one output payment on
  the destination chain to the reviewed recipient in the reviewed destination token; `minimumAmount ≥ expected × (1 − slippage)`; no
  destination calls; no order fees (FloFi charges none; no app fee is requested); refunds only to the owner (source chain) or the reviewed
  recipient (destination chain); deadline in the future.
- **Simulation.** EVM: `eth_simulateV1` of the exact call sequence from the owner; exactly one `RelayErc20Deposit`/`RelayNativeDeposit` with the
  orderId and amount, and an owner debit of exactly the amount. Solana: `simulateTransaction` with the owner's accounts returned; the owner's
  token (or lamport) debit equals the amount (plus fee/rent for SOL).
- **Settlement.** Provider status is a hint. The referenced destination transaction must be final/safe, after the source deposit, credit the
  reviewed recipient with ≥ minimum of the reviewed token (ERC-20 `Transfer`, native value transfer, or Solana pre/post balances), and is
  claimed exclusively by one run (two identical bridges can never reconcile against one fill). Refunds are verified the same way on the
  source chain to the owner.

### Concurrency and idempotency

Per-attempt identity only, never owner-wide: EVM attempts bind the pending nonce and the deposit identity (orderId); Solana attempts claim
the reviewed message hash and the owner signature. Any number of independent bridges, including identical ones, may be in flight; each has
its own quote, orderId, Review and wallet signature. Duplicate clicks/retries hit the same run's attempt and are observation-only.

## 4. Fee audit (0.1% per complete workflow)

`main` has no FloFi fee mechanism, chargeable basis or ledger. This build does **not** invent one: Relay is called without `appFees` and any
order fee is refused; Mayan referrer fee is not set; LI.FI's own 0.25% fee is a third-party fee, itemized and labelled as LI.FI's. Every
provider fee line is shown; the net minimum received is the order's guaranteed minimum. The run records exactly one terminal outcome per
workflow (`RECONCILED`, `REFUNDED`, `FAILED`, `DIVERGENT`) for a future fee ledger. Owner decisions remain open (see report).

## 5. Scope boundaries stated honestly

- Executable in this build: Relay routes whose source step is a direct Depository deposit (all 20 pairs where Relay quotes), and the existing
  certified Router pairs (USDC/USDG via Across / LI.FI→Across).
- Discovered and quoted but not executable: LI.FI routes over bridges FloFi cannot verify independently, Mayan routes (no verified
  transaction builder), Across routes outside the certified pairs. Each shows its specific reason; nothing is hidden or faked.
- Swap → Bridge → Swap: cross-asset delivery through the provider order (the solver delivers the destination asset with a bound minimum), and
  FloFi step-list composition where the bridge's reconciled delivered amount funds the next step.

## 6. Tests

Unit (contracts, Relay verification with recorded live fixtures, negative cases N), service tests on deterministic EVM + Solana doubles
(A–M), channel parity (O), PostgreSQL flow tests, browser profile for the Canvas panel, governance; CircleCI certification. A read-only live
matrix script produces the 20-pair matrix.
