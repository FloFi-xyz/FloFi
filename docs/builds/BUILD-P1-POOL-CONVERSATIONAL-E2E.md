# BUILD-P1 — Pool conversational E2E reliability (Orca Whirlpools, Uniswap v3)

**Status:** ready for owner review. Branch `claude/festive-bell-43awox`, based on `main` at `d49f80a` (PR #204 merged). Nothing is merged,
deployed or configured. Production was not read or changed (no service, variable, database, migration, Neon/Railway/Vercel setting), and no
transaction was signed or submitted: every test uses scripted interpreter answers, MOCKED in-process chains or the MOCKED loopback harnesses.

Evidence levels used below: **CODE** = reproduced deterministically against the real conversation engine before the fix (the tests failed on
`d49f80a`) and passing after it; **MOCKED** = the real services on MOCKED chains/loopback harnesses; **LIVE-MODEL** = a real interpreter
(not run: see §9); **MAINNET** = real reconciled transactions (none).

## 1. Root causes (CODE)

| Incident | Root cause | Where |
| --- | --- | --- |
| A — "1usdc" → "lower" → *"Flofi still cannot prepare this request…"* | **1. No structured slot for a range answer.** `answerDraftField` filled only network/asset/time; every range answer went to the interpreter. When the interpreter asked its own question (`CLARIFICATION_REQUIRED`, "Is 1 … the lower or upper price?"), the value `1` existed only in its prose — the draft could not hold a bound without a side. | `copilot-draft.ts`, `copilot-conversation.ts` (`CLARIFICATION_REQUIRED`) |
| A | **2. The clarification budget counted progress as failure.** `question()` stops at 3 clarifications; the budget reset only in the local `answeredDraft` path and only for amount/asset/network/recipient. Deposits and range slots never counted, and a model turn never reset it. Replay: request → deposits answered (FloFi repeated the *same* question) → "1usdc" → "lower": even a perfect interpretation (`PRICE`, lower `1`) produced the refusal at turn 4. | `copilot-conversation.ts` `question`, `answeredDraft`, `finishTurn` |
| A — `devUSDC` in the public product | (a) `publicText` treated Devnet/Sepolia wording as test-network text but not the token `devUSDC`, so a model question naming it was shown; (b) the public interpreter prompt still contained Solana Devnet/devUSDC examples; (c) FloFi's own Orca question for a fee tier or `FULL` on Solana mainnet used the Devnet pool's quote (`COPILOT_POOLS.ORCA.quote` = devUSDC). | `network-scope.ts`, `server/copilot-service.ts`, `copilot-authoring.ts` |
| B — "±10%" / "10% range" → *"The AI returned an answer that Flofi could not validate"* | **3. Schema/parser mismatch.** The output schema described `lower`/`upper` as free text "exactly as written"; the parser accepts digits only. A model copying `±10%` or `10%` was rejected server-side as `COPILOT_INTENT_INVALID` — on both observed answers. | `copilot-intent.ts` (schema + `parseActionV2`), `server/copilot-service.ts` |
| B (latent, found while reproducing) | **4. A valid percentage became the full range silently.** `planCatalogLiquidity` had no `PERCENT` branch: the sentence carried no range, so Base/Arbitrum/Ethereum/Robinhood positions were authored at the full range without saying so. | `copilot-authoring.ts` |
| A + B | **5. No verified price path for mainnet pools in chat.** The chat only ever read the Devnet Orca price; Orca mainnet percent was rejected (`COPILOT_POOL_PRICE_UNAVAILABLE`); the catalog pool price action existed (`catalogLiquidityPrice`) but nothing in chat used it. | `components/copilot-ai.tsx`, `copilot-authoring.ts` |

The frontend uses the current V2 contracts (no legacy path); the defects were in the shared engine. Chat ↔ Canvas ↔ workflow interference was not a
factor: the Canvas range control (`priceBoundsAround`) is now also what the chat uses for Orca.

## 2. What changed

| File | Change |
| --- | --- |
| `apps/reference-dapp/src/domain/copilot-range-dialogue.ts` (new) | FloFi's own deterministic reading (EN/PT) of short range answers — `lower`, `inferior`, `1usdc`, `180`, `$180`, `upper 180`, `make the lower 120`, `±10%`, `10% range`, `faixa de 10%`, `10 percent around current price`, `full range`, `faixa completa`, `150 to 180`, `ticks -600 to 600`, unit choices — and how each answer changes **only** the range slots. A value in another token than the pool's price unit (`0.1 SOL`) is not a range answer. |
| `copilot-conversation.ts` | `rangeTurn`: while the open liquidity request waits for its range, a short answer is applied locally (no model call); a value with no side is held and FloFi asks "lower or upper?" with buttons; a side with no value asks for that value. Progress-based budget (`filledSlot`: a slot going empty→filled reopens it, on local *and* model turns; monotonic, so it cannot loop). A failed interpretation keeps the open question and reminds it. A single missing deposit answers with a bare amount, refusing an amount in another token. Pool reads (`verified.pools`, `poolReads`) reach single positions and sequence steps. Closed codes on replies. |
| `copilot-draft.ts` | The range merges as one group (a different kind of range replaces the open one only when the latest words state it); `draftSlots` for the budget. |
| `copilot-authoring.ts` | Specific range questions (missing range, missing percentage, the other bound), deposits asked one token at a time, full range refused for Orca with the reason, ordered and spacing-aligned bounds, Orca mainnet percentage from the verified **mainnet** read, catalog `PERCENT`/`PRICE`/`TICK` → ticks, effective range + read slot/block + where the current price sits, explicit refusals for a missing pool, an unreadable or stale price and an invalid conversion. |
| `domain/pool-range.ts` (new) | Pool identities, reads with freshness (120 s) and identity check, the person's price direction, and the deterministic conversions (pure). |
| `packages/reference-compiler/src/uniswap-public-liquidity.ts` | Additive: `uniswapBandAroundSqrtPriceIn`, `uniswapAlignPriceRange`, `uniswapPriceAtSqrt/AtTick` with a price orientation. Existing functions unchanged (the new ones delegate to them for the original orientation). |
| `copilot-intent.ts`, `copilot-intent-v2.ts` | Only a `PERCENT` bound written with `%`/`±` is read as its digits (`±10%` → `10`); every other value stays strict; descriptions now say digits only. |
| `copilot-messages.ts` | EN/PT copy for the dialogue; public percentage refusal reworded. |
| `components/copilot-ai.tsx` | `readPool`: when FloFi asks for a pool price, the web chat reads it through the existing read-only, access-gated server actions (`solanaMainnetLiquidityPrice`, `catalogLiquidityPrice`) and answers the same message again once. The Devnet price is read only in engineering scope. |
| `network-scope.ts`, `server/copilot-service.ts`, `server/copilot-capabilities.ts` | `devUSDC` is test-network wording in the public product; the public prompt has no Devnet/devUSDC examples and states the range forms; capability text lists the ranges FloFi now supports. |
| Tests, fixtures, CI plan | See §6. One browser profile added (`copilot-pool-dialogue`, shard 3) and mirrored in `scripts/test_ci_optimization.py`. `docs/engineering/coverage.json` maps the new files and suites. |

No migration, table, environment variable, execution gate, fee policy, amount limit, slippage default, approval logic, signer or executor changed.

## 3. Context continuity

The open request is FloFi's structured draft (protocol, network, deposits, fee tier, range kind and bounds), plus — only while the range is open —
`rangeHold`: a value whose side FloFi asked about, or the side whose value it asked for. Each answer changes exactly one slot group; nothing else in
the request is touched. An answer the reader does not recognise goes to the interpreter exactly as before, and the model's answer is merged
field by field (range as a group). The existing invalidation still applies to every turn: a changed wallet, workflow or pending proposal ends the
request (`COPILOT_CONTEXT_CHANGED`), a new request never inherits the closed one, and `no` drops it. `yes` never chooses a side or approves.

## 4. Percentage → prices → ticks

- **Orca SOL/USDC (Solana mainnet-beta):** FloFi reads the mainnet whirlpool (`readOrcaLiquidityPrice`, verified cluster and pool), computes
  `priceBoundsAround(price, −p, +p)` — the Canvas range control's own function — and authors `from L to U USDC per SOL`; the exact grammar aligns
  the bounds outward to the pool's tick spacing (`orcaAlignPriceRange`). The effective prices of the aligned ticks are shown.
- **Uniswap v3 on Base, Arbitrum One, Ethereum, Robinhood Chain:** FloFi resolves the pool from the catalog (pair + fee tier → CREATE2 pool,
  token order, tick spacing), reads its `slot0` through the existing service (which verifies factory, pool, tokens and decimals), and computes
  ±p% **in the direction the person reads the price** — the other token in a US-dollar stablecoin (USDC per WETH), otherwise pool order. Where that
  is token1 per token0 (WETH is token0 on Base and Arbitrum One), the band is computed in that direction (not the inverted band). Ticks are aligned
  outward (`floor` for the lower, `ceil` for the upper, then the spacing), bounded by the usable tick range, and the IR stores those ticks.
  Explicit prices use the same direction and alignment. The proposal states the effective range, the block it was read at and where the
  current price sits (inside, or above/below with the only token the position would hold).
- **Not available:** a percentage on the Uniswap test pools (prices or ticks) and full range on Orca (FloFi says so). Asymmetric percentages
  (`-5% to +10%`) go to the interpreter and are asked as prices.

## 5. Mainnet-only (CODE + MOCKED browser)

The public pool dialogue never names a test network or test token: `copilot-pool-dialogue.test.ts` and `e2e/copilot-pool-dialogue.spec.ts`
(served with `FLOFI_E2E_NETWORK_SCOPE=PUBLIC_MAINNET`) assert no `devUSDC`/`Devnet`/`Sepolia` in any reply, note or button; `copilot-prompt-scope.test.ts`
asserts the public prompt carries no Devnet example and that a model question naming devUSDC is replaced. Test networks remain for engineering and
CI only; historical runs are untouched; no existing workflow is re-networked.

## 6. Tests by layer

| Layer | Suites | Result |
| --- | --- | --- |
| Reproduction (failed on `d49f80a`, pass now) | `copilot-pool-dialogue.repro.test.ts` (incident A sequence; incident B `±10%` and `10% range`; silent full range) | see PR |
| Dialogue | `copilot-range-dialogue.test.ts` (reader EN/PT, slot changes), `copilot-pool-dialogue.test.ts` (separate messages, explicit change, new request, wallet/network change, price unavailable/stale/missing pool, malformed and invented model values, yes, public wording, Chat → IR → MCP parity) | see PR |
| Compiler | `uniswap-price-orientation.test.ts` | see PR |
| Integration (MOCKED chain, real services) | `server/copilot-pool-integration.test.ts`: chat → IR → Uniswap service Simulate → Review → owner-wallet handoff; exact approvals; zero sends | see PR |
| Browser (MOCKED loopback, replay interpreter, public scope) | `e2e/copilot-pool-dialogue.spec.ts` (3 tests) | see PR |
| Regression | full unit suite, `copilot-eval` corpus (C10 intentionally updated: the second turn is now local), related browser profiles, PostgreSQL suite | see PR |

## 7. Observability

Replies now carry closed codes that the existing content-free turn record (`flofi.copilot.turn`) already aggregates — no new table, migration or
variable: `COPILOT_RANGE_REQUIRED`, `COPILOT_RANGE_BOUND_REQUIRED`, `COPILOT_RANGE_SIDE_REQUIRED`, `COPILOT_RANGE_PERCENT_REQUIRED`,
`COPILOT_RANGE_UNSUPPORTED`, `COPILOT_RANGE_ORDER_INVALID`, `COPILOT_RANGE_TICKS_INVALID`, `COPILOT_RANGE_CONVERSION_INVALID`,
`COPILOT_RANGE_OUT_OF_RANGE`, `COPILOT_DEPOSIT_REQUIRED`, `COPILOT_POOL_PRICE_REQUIRED`, `COPILOT_POOL_PRICE_UNAVAILABLE`, `COPILOT_POOL_NOT_FOUND`,
`COPILOT_CONTEXT_CHANGED`, `COPILOT_CLARIFICATION_LIMIT`, and the interpreter's failure code (`COPILOT_INTENT_INVALID`, …) on failed turns. Records
hold codes and counters only — never text, values, assets, networks, amounts, addresses or transcripts.

## 8. Classification

| | Status |
| --- | --- |
| Implemented | Structured range dialogue (EN/PT); Orca mainnet percentage; Uniswap catalog percentage and price ranges; public wording; codes. |
| Validated by tests | Unit, dialogue, compiler, MOCKED integration through Simulate/Review/handoff, MOCKED browser in the public scope. |
| Validated in a public environment, read-only | Not done in this build (no production or Preview read was made by this session). |
| Pending real mainnet execution | Orca and Uniswap positions authored by conversation are **not** financially certified on mainnet: no real transaction was made or reconciled. |

## 9. Remaining risks and limitations

- A real interpreter was not run (no authorized environment/budget in this session): scripted answers prove FloFi's handling, not that a live
  model will always classify every phrasing. The local reader removes the model from the common short answers, which narrows that risk.
- Channels (Telegram/WhatsApp) cannot read pool prices: a percentage there is explained as unverifiable (prices or ticks still work).
- MCP `compose_strategy` keeps its `price`/`tick`/`full` range contract (no percentage): the chat resolves a percentage to ticks, which MCP expresses
  with the same IR and hash (tested).
- A pool price moves between the proposal and Review; the proposal states the read block/slot and the ticks are fixed, while Simulate/Review read the
  pool again and show the position state before any signature.
