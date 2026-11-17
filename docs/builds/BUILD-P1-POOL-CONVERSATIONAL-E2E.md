# BUILD-P1 — Pool conversational E2E reliability (Orca Whirlpools, Uniswap v3)

**Status:** ready for owner review. Branch `claude/festive-bell-43awox`, started on `main` at `d49f80a` (PR #204) and synchronized with `main` at
`c105e1d` (PR #205, BUILD-INFRA-API-FAILOVER-CERT-001) by a merge commit — no conflict; PR #205's API drain/shutdown behaviour, request-target guard and
required suites are untouched. Nothing is merged,
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

## 2a. Changes from the specialist reviews

Read-only reviews (flofi-chat, flofi-liquidity, flofi-security) found 0 critical/high, 4 medium (overlapping) and 13 low findings; each was checked
against the code and fixed with a regression test:

| Finding | Fix |
| --- | --- |
| A bare number answering another question (a deposit) could ground a percentage the model invented | A number without `%` grounds a percentage only when it answers FloFi's own percentage question (`answeredPercent`, set by the local reader). |
| A fee-tier answer ("0.05%") could be read as a ±0.05% range | The local reader runs only under FloFi's own range questions (by question code) or while it holds a range answer. |
| After a pool read, a local turn was answered against the context captured before the read | It is answered against the current context: a wallet, workflow or proposal change ends the request (`COPILOT_CONTEXT_CHANGED`). |
| Chat and Review read Base/Arbitrum prices in opposite directions | The note states that Review shows the same ticks and gives them in the pool's order too (e.g. WETH per USDC); the position note names the token held, without "above/below". |
| Local range loops could reset the question budget forever; the internal pool read could hit the limit | Progress is a slot never filled before in the request; FloFi's internal pool-read request neither counts nor is stopped. |
| A deposit maximum could also ground a price bound | A written number grounds one field only. |
| The Uniswap read was labelled with the requested pool, not the pool read | The service returns its verified pool; the web reader (`state/copilot-pool-reads.ts`) fails closed when it is missing or different. |
| Smaller | "at 10% around the price" is a range, not a fee; a range the interpreter dropped on a catalog pool is asked, never the full range; a malformed "ok" read is a failed read; "Try again" only where a read is possible; a unit named next to a side is kept; engineering-only Devnet/test-pool dead ends removed. |

### Second review wave (after the PR #205 sync)

flofi-workflow, flofi-infrastructure-ci, flofi-protocol-integrations, flofi-mcp and flofi-channels reviewed the integrated branch, five
read-only verifiers re-checked the first wave's fixes adversarially, and a completeness critic mapped every requirement to its tests. 1 high,
5 medium and ~20 low findings, all checked against the code; fixed with regression tests (`Wave-2 review regressions` in
`copilot-pool-dialogue.test.ts`, reader cases in `copilot-range-dialogue.test.ts`, `copilot-pool-reads.test.ts`, the integration and Channel Core suites):

| Finding | Fix |
| --- | --- |
| **High** — the Cloud Build orchestration test pinned 54 browser profiles; the new profile makes 55, so `governance` (and every certification job behind it) would fail | `scripts/test_ci_gcp_orchestration.py` pins 55 and names the new profile (intentional change, commented). |
| The fee tier's or slippage's "N%" could also ground the ±N% range band (and "at 1% around the price" could ground a 1% fee) | One written percentage grounds one field: fee/slippage percentages never ground a band, band percentages never ground a fee; "fee X%" always names the fee (the "at X%" range exception applies to "at" only). |
| One-sided percentages ("10% below", a lone lower "-10", "+10% above") became a symmetric band | They are asked as prices (`COPILOT_RANGE_PERCENT_ONE_SIDED`); "10% above and below" is still a band. |
| A model option's example the user clicked ("A percentage range (for example, ±10%)") grounded ±10% | Examples in a clicked option are the model's, not the user's: FloFi asks, and a bare number then answers its own percentage question. |
| Deposit maxima could ground tick bounds; a fee or slippage could ground price bounds | Every bound (price and tick) needs its own written number; percent readings and the slippage written in bps never ground a bound. |
| RANGE wording gaps let a dropped range become the full range; a model-reported FULL was never grounded | Wider range wording (from/to, X–Y, +-, within, either side, -N% to +N%, tick range, $ bounds, de X a Y, a bare non-fee "N%"); FULL is used only when the user asked for it (or carried). |
| Two-sided answers ignored side nouns ("lower tick 600 upper tick 900" became prices); a unit given with a held value was lost | Side nouns name the unit in every form; contradictions are not range answers; `rangeHold` keeps the unit. |
| The web chat's pool read had no deadline | 20 s (`POOL_READ_TIMEOUT_MS`), then `COPILOT_POOL_READ_TIMEOUT` with "Try again"; explicit ranges never wait on it for a proposal. |
| A request touching two pools could loop on "reading the price" | Each needed pool is read in turn for the same message (up to `POOL_READS_PER_TURN` = 3), in the web chat and the test harness. |
| A deposit answered to FloFi's own question did not count as progress | It does (slot rule), so the range dialogue after it never hits the question limit. |
| Pool-error classification | `ORCA_POOL_MISMATCH` is "pool not found" (Orca copy no longer offers another fee tier); integrity/configuration codes and an unbound read get no "Try again"; FloFi's own read failures keep their code in the reply (`COPILOT_POOL_READ_TIMEOUT`, `COPILOT_POOL_IDENTITY_MISSING`, `COPILOT_POOL_IDENTITY_CHANGED`, `COPILOT_POOL_READ_INVALID`). |
| A reported tick could disagree with the reported price | A Uniswap read is usable only with a price inside Uniswap's bounds and a tick that belongs to it (one tick of tolerance); Orca ticks are bounds-checked. |
| Channels were offered a percentage they can never compute; a side question could show empty units | The percentage is offered only where the surface reads pools; units come from the network the user named when the interpreter left it out (else the interpreter answers). |
| Smaller | One stablecoin list for orientation and "$"/"dollars"; a test token the user typed is not repeated in the public mismatch question; ETH answers a WETH deposit question; engineering-only Devnet read gets a deadline, an end-of-conversation check and implied-network detection; engineering copy corrected; `coverage.json` maps `copilot-prompt-scope` and `copilot-pool-integration` to their owning modules and makes the incident suites required. |

### Delta review of the wave-2 fixes (`abfa059`)

flofi-chat, flofi-security and flofi-liquidity reviewed the wave-2 delta on the clean `abfa059`; each finding was then reproduced against the real
engine with a temporary test, or traced by reading. 5 medium and ~10 low findings were confirmed (none critical or high); all are fixed with regression
tests (`Delta review regressions (abfa059)` in `copilot-pool-dialogue.test.ts`):

| Finding | Fix |
| --- | --- |
| A range band ("±5%") or a deposit amount ("500 USDC") could ground a slippage the interpreter reported (e.g. 500 bps instead of the 100 default) | Liquidity slippage is grounded only when written as bps or next to a slippage word (`groundedBps(…, strict)`; other actions unchanged). |
| A bare "full" ("my full 10 USDC") let a model-reported full range replace a written ±10% | The full range needs range wording ("full range", "faixa completa") or a bare "full" as the whole answer, and never alongside another range in the same message. |
| "max 10 USDC", "between 10 USDC and 0.004 ETH" and slippage phrasings asked a range question on the default full-range journey, again until the question limit | min/max name a bound only with a range noun; deposit amounts with their token are masked before range wording is read; slippage wording is wider; once FloFi has asked for the range, only the answer decides it. |
| One-sided questions could not be answered with the same percentage as a band; "10% below and 10% above" was one-sided; a bare number after it became a percentage | A band in the latest message answers it; both sides written are a band; a bare number is a percentage only under FloFi's own percentage questions. |
| The user's own "(exactly ±10%)" was stripped as a model example | Only "(for example …)", "(e.g. …)", "(por exemplo …)", "(ex. …)" are a model's example. |
| A slippage percentage could ground a fee tier; "slippage at 0.5%" read as a fee | Slippage percentages are masked before the fee is read. |
| Pool codes | An uninitialized (locked) Uniswap pool is "not found"; configuration and identity mismatches (`*_MISMATCH`, `*_NOT_CONFIGURED`, `UNISWAP_NETWORK_UNAVAILABLE`) get no "Try again". |
| Orca reads had no tick/price consistency check | The tick must belong to the price (±1 tick). |
| Engineering-only: a timed-out Devnet read could reuse an older price as "current" | A read that does not answer in time leaves no price for that turn. |

Not changed (owner decision): MCP `compose_strategy` still refuses a `price` range on catalog networks (the chat converts prices to ticks first;
both reach the same IR). Extending MCP is outside this build's scope.

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
  current price sits (inside, or outside with the only token the position would hold).
- **Not available:** a percentage on the Uniswap test pools (prices or ticks), a percentage on a surface that cannot read pools (channels), and full
  range on Orca (FloFi says so). Asymmetric or one-sided percentages (`-5% to +10%`, `10% below`) are asked as prices.

## 5. Mainnet-only (CODE + MOCKED browser)

The public pool dialogue never names a test network or test token: `copilot-pool-dialogue.test.ts` and `e2e/copilot-pool-dialogue.spec.ts`
(served with `FLOFI_E2E_NETWORK_SCOPE=PUBLIC_MAINNET`) assert no `devUSDC`/`Devnet`/`Sepolia` in any reply, note or button; `copilot-prompt-scope.test.ts`
asserts the public prompt carries no Devnet example and that a model question naming devUSDC is replaced. Test networks remain for engineering and
CI only; historical runs are untouched; no existing workflow is re-networked.

## 6. Tests by layer

| Layer | Suites | Result |
| --- | --- | --- |
| Reproduction (failed on `d49f80a` — verified in a clean worktree of `d49f80a`: 4/4 fail; pass now) | `copilot-pool-dialogue.repro.test.ts` (incident A sequence; incident B `±10%` and `10% range`; silent full range) | see PR |
| Dialogue | `copilot-range-dialogue.test.ts` (reader EN/PT, slot changes), `copilot-pool-dialogue.test.ts` (separate messages, explicit change, new request, wallet/network change, price unavailable/stale/missing pool, malformed and invented model values, yes, public wording, Chat → IR → MCP parity) | see PR |
| Compiler | `uniswap-price-orientation.test.ts` | see PR |
| Integration (MOCKED chain, real services) | `server/copilot-pool-integration.test.ts`: chat → IR → Uniswap (Arbitrum One) and Orca (mainnet-beta profile) services Simulate → Review → owner-wallet handoff; exact approvals; a price move after the proposal is re-read by Review with the chat's ticks, a move after Review requires a new Review; zero sends | see PR |
| Channel Core (JSON rehydration) | `channels/core/conversation-mainnet.test.ts`: "1usdc" → Lower → "180" proposes on a channel; a percentage there is explained without a retry | see PR |
| Browser (MOCKED loopback, replay interpreter, public scope) | `e2e/copilot-pool-dialogue.spec.ts` (3 tests) | see PR |
| Regression | full unit suite, `copilot-eval` corpus (C10 intentionally updated: the second turn is now local), related browser profiles, PostgreSQL suite | see PR |

## 7. Observability

Replies now carry closed codes that the existing content-free turn record (`flofi.copilot.turn`) already aggregates — no new table, migration or
variable: `COPILOT_RANGE_REQUIRED`, `COPILOT_RANGE_BOUND_REQUIRED`, `COPILOT_RANGE_SIDE_REQUIRED`, `COPILOT_RANGE_PERCENT_REQUIRED`,
`COPILOT_RANGE_UNSUPPORTED`, `COPILOT_RANGE_ORDER_INVALID`, `COPILOT_RANGE_TICKS_INVALID`, `COPILOT_RANGE_CONVERSION_INVALID`,
`COPILOT_RANGE_OUT_OF_RANGE`, `COPILOT_RANGE_PERCENT_ONE_SIDED`, `COPILOT_RANGE_PERCENT_NOT_FOUND`, `COPILOT_RANGE_NOT_FOUND`, `COPILOT_DEPOSIT_REQUIRED`,
`COPILOT_POOL_PRICE_REQUIRED`, `COPILOT_POOL_PRICE_UNAVAILABLE`, `COPILOT_POOL_READ_TIMEOUT`, `COPILOT_POOL_READ_INVALID`, `COPILOT_POOL_IDENTITY_MISSING`,
`COPILOT_POOL_IDENTITY_CHANGED`, `COPILOT_POOL_NOT_FOUND`,
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
- Deploy order: the web chat binds a Uniswap read to the pool the service reports (new `pool` field of the price read). Deploy the API (Railway)
  with or before the web (Vercel); until both run this build, a catalog percentage range is answered "could not verify" (fail closed, recorded as
  `COPILOT_POOL_IDENTITY_MISSING` so deploy skew is visible in the turn metrics).
- Chat and MCP differ on catalog price ranges: the chat converts a price range to outward-aligned ticks; MCP `compose_strategy` takes ticks or the
  full range there and refuses `price` (unchanged, fail closed). Both reach the same IR for the same ticks.
- The browser profile covers the Orca dialogue; the Uniswap catalog dialogue is covered by unit, Channel Core and MOCKED-service integration tests,
  not by a browser test.
- MCP `compose_strategy` keeps its `price`/`tick`/`full` range contract (no percentage): the chat resolves a percentage to ticks, which MCP expresses
  with the same IR and hash (tested).
- A pool price moves between the proposal and Review; the proposal states the read block/slot and the ticks are fixed, while Simulate/Review read the
  pool again and show the position state before any signature.
