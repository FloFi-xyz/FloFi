# BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 — Mainnet liquidity position management

Base: `origin/main` b1de6c16 (PR #218, incl. PRs #206–#217). Branch `feat/liquidity-lifecycle-001`. No production record, configuration,
environment variable, gate, fee policy, migration or signing authority was changed; no transaction was signed, sent or broadcast.

## 1. Gaps found at b1de6c16 (re-verified) and root causes

| Area | Finding | Root cause |
| --- | --- | --- |
| Orca public Simulate | A chat-staged withdrawal simulated an **OPEN** deposit (`components/app-shell.tsx:436` used `solanaReview?.operation ?? 'OPEN'` and never read `stagedPosition`). | The operation lived only in client state (`stagedPosition`) that the public Simulate path ignored. |
| Orca store | Network defaulted to Solana Devnet; a mainnet wallet had no owner without an authored OPEN node; positions refreshed only with one. | Store scoping predated mainnet position management. |
| Orca chat | Position discovery and authoring were Devnet-only (`copilot-ai.tsx` Devnet actions, `resolvePosition` refused other networks, public copy "not available on mainnets"). | The Devnet engineering dialogue was never generalized. |
| Orca engine | No collect-only operation; the mock credited un-checkpointed fees on `collect_fees_v2` (the real program does not). Positions FloFi did not open were refused (`ORCA_POSITION_UNKNOWN`). | Collect without `update_fees_and_rewards` cannot pay fresh fees; the registry was the only position source. |
| Uniswap engine | The public service executed APPROVE/MINT only; no decrease, collect or burn; `settle` reconciled any non-MINT step as an approval; the continuation logic counted any non-MINT confirmed step as an approval. | The public runtime was built for minting; BUILD-006 lifecycle code is local-fork only (31337, anvil RPCs, mint minimums reused for withdrawals, fixed collect bounds, 180 s deadline). |
| Discovery | Dashboard scans existed (Uniswap 4 networks, Orca registered pool) but carried no identity, range, collectable amounts or manageability. | Built for display only. |
| Surfaces | Certification matrix rows overclaimed Orca (Canvas) and declared Uniswap remove-liquidity not implemented. | No public position path existed. |

## 2. Design (one canonical runtime per protocol; no parallel engine)

- **Identity.** `domain/liquidity-positions.ts`: `LiquidityPositionRef` binds protocol, CAIP-2 chain, network, manager (NonfungiblePositionManager or
  the Whirlpools program), verified pool, position id (token id or mint) and the owner verified on chain. Keys include chain and manager, so the
  same token id on two networks is two positions.
- **Canonical workflow.** The position's isolated `asset.liquidity.concentrated` node (its exact pair, fee tier and ticks; maxima descriptive) is the
  position's identity in the IR; the operation (COLLECT / DECREASE + bps / EXIT [+ close]) travels in the staged choice, the runtime request and the
  Review, and is bound by the Review commitment (the existing Orca precedent). Authored by `MANAGE_LIQUIDITY_POSITION` (`domain/commands.ts`,
  `domain/editor.ts`), which refuses to drop other financial steps.
- **Uniswap v3.** `server/uniswap-position-service.ts` is a second run kind inside the existing Uniswap liquidity service: same instance, storage port,
  run namespace (`balp-`/`arlp-`/`etlp-`/`rhlp-`), verified pool runtime (code pins, CREATE2 pool, catalog token identities, Stock Tokens),
  fee policy (one extracted `feeEnvelope`), owner-nonce reservation (shared with mint runs), handoff, observation and PR #218 confirmation depth.
  Cloud flows keep their method names and dispatch by run kind, so Flight recovery, beta owner binding and workers apply unchanged.
- **One atomic wallet request per operation.** Collect alone; decrease + collect; decrease + collect + burn (close) — wrapped in the manager's own
  `multicall`, so a withdrawal lands whole or not at all (no partial execution exists to resume).
- **Orca.** The existing engine gains COLLECT (`update_fees_and_rewards` when liquidity > 0, then `collect_fees_v2`) and manages positions the owner
  holds on the verified pool after on-chain verification (Token-2022 associated account, exactly 1, no delegate). EXIT keeps its verified semantics:
  remove all, collect, close the position (NFT closed, rent refunded).

## 3. Protocol correctness (Uniswap v3)

- `decreaseLiquidity` only credits `tokensOwed`; `collect` with uint128-max bounds pays everything owed **including fees accrued after the Review**
  (it pokes the pool first). FloFi never reviews a fixed collect bound; the Review states a lower bound and the exact principal minimums.
- Portions are integer basis points of the selected position's liquidity (`floor(L × bps / 10 000)`), never of a wallet balance.
- Minimums come from a fresh two-pass `eth_simulateV1` (probe → minimums at the reviewed slippage → exact request), cross-checked against
  independent SqrtPriceMath; the decrease carries its own deadline (block time + the profile's deadline).
- `burn` is only ever the last call after a full decrease and a max collect, and only when the owner explicitly asked to close; the manager itself
  reverts "Not cleared" otherwise, which reverts the whole multicall.
- Owed tokens are reported apart from principal and never called yield (they can include principal withdrawn earlier without collecting).
- Recipient is always the owner; tokens are returned as the pool's own ERC-20s (WETH stays WETH; nothing is swapped or unwrapped).
- Selectors and event topics are re-derived by keccak at module load (`UNISWAP_SELECTOR_PIN_INVALID` / `UNISWAP_TOPIC_PIN_INVALID`).

## 4. Execution safety

Fresh Review before every authorization; Review expiry checked on authorization (10 s hand-off margin), before the nonce reservation and again at the
durable hand-off; materiality re-checked at begin and hand-off (owner, pool code, exact liquidity and range, simulated principal within half the
slippage, owed tokens and fees may only grow); one CONFIRMED attempt per run; a per-position claim refuses another run of the same position while one
may still execute or awaits reconciliation; owner nonce reserved across mint and position runs; proven pre-submission refusals only cancel; unknown
outcomes are observed, never resent; reconciliation only at the network's confirmation depth from receipt events (DecreaseLiquidity and the pool
Burn of exactly the reviewed liquidity at or above the minimums, one Collect to the owner with pool → owner transfers, nothing leaving the owner,
read-back of the remaining position or proof of burn, owner balance deltas); divergent effects freeze the run (`RECONCILIATION_REQUIRED`).

<!-- Sections 5–12 are completed at integration. -->
