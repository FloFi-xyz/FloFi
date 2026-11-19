# BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 — Mainnet liquidity position management

Started from `origin/main` b1de6c16 (PR #218, incl. PRs #206–#217); integrated by merge (no rebase) with `origin/main` 27c054f1, which adds PR #220
(BUILD-FLOFI-AGENT-HARNESS-COMPATIBILITY-001) and PR #219 (BUILD-FLOFI-UX-EDITOR-FINOPS-001). Branch `feat/liquidity-lifecycle-001`. No production record, configuration,
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

## 5. Canonical workflow binding (reviewer finding F1)

The operation is part of the canonical workflow, not only of client state: a position-management node is the position's own
`asset.liquidity.concentrated` node plus one IDENTIFIER input `position-management` (`COLLECT:<id>`, `DECREASE:<id>:<bps>`, `EXIT:<id>:close|keep`;
`packages/workflow-contracts/src/liquidity.ts`), the precedent of the bound-maximum input. Consequences: any change of operation, portion, close or
position is a new revision and workflow hash, so a Review of another choice can never be authorized; the strict deposit reader refuses a marked node,
so a reloaded or chat-authored position workflow is never simulated, compiled or executed as a deposit (`UNISWAP_LIQUIDITY_WORKFLOW_MANAGES_POSITION`,
`ORCA_LIQUIDITY_WORKFLOW_MANAGES_POSITION`); the Uniswap position runtime requires request == marker (`UNISWAP_POSITION_REQUEST_MISMATCH`), Orca
refuses OPEN and any mismatching request on a marked workflow. No schema change (the value fits the existing identifier pattern). A position
operation stays its workflow's only financial step; that rule applies only to marked nodes — swap, bridge, deposit and composition workflows are
unchanged (`liquidity-positions.test.ts`).

## 6. Operations delivered, per protocol and network

| Protocol / network | Collect fees | Partial withdrawal | Exit (keep) | Exit + close | Positions FloFi did not open |
| --- | --- | --- | --- | --- | --- |
| Uniswap v3 — Base, Arbitrum One, Ethereum, Robinhood Chain | yes (fresh owed + fees via the pool poke; uint128-max collect) | any 1–9999 bps of the position's liquidity, integer floor, fresh minimums | yes (NFT kept) | only on the owner's explicit request (burn last, same atomic multicall) | yes (owner verified on chain) |
| Uniswap v3 — Base Sepolia, Ethereum Sepolia | no — refused (`UNISWAP_POSITION_NETWORK_UNSUPPORTED`); testnets keep mint only | no | no | no | — |
| Orca Whirlpools — Solana mainnet, verified SOL/USDC pool | yes (`update_fees_and_rewards` checkpoint + `collect_fees_v2`) | yes (any share) | — (an Orca exit always closes) | yes (remove all, collect, close; rent refunded) | yes (Token-2022 own ATA, amount 1, no delegate) |

Refused fail-closed: positions owing rewards or on an emitting reward slot (Orca), a partial withdrawal whose checkpoint would leave a reward owed,
legacy or delegated position tokens, other pools, an operator who is not the owner, nothing to collect, an empty position for a decrease.
Users choose their amounts; no cap was added.

## 7. Discovery and inspection coverage

| Source | FloFi scope | Not covered |
| --- | --- | --- |
| Uniswap v3 (4 catalog mainnets) | every position the wallet holds on the network's verified NonfungiblePositionManager (opened by FloFi or elsewhere), up to 20 per network (beyond: PARTIAL); identity, range/state, price, principal, recorded owed tokens, collectable now (static `collect` call from the owner; unavailable ≠ 0), manageability (catalog tokens and verified pool only) | positions on other managers/forks, staked or wrapped NFTs, pools outside the catalog (shown, not manageable) |
| Orca Whirlpools (Solana mainnet) | position certificates the wallet holds (SPL Token and Token-2022) on the verified pool, up to 40 (beyond: PARTIAL); range/state, principal, fees owed; collectable shown as unavailable (no checkpoint read) | bundled positions, other pools, delegated/legacy tokens (shown as not manageable) |

Both scans bind each view to network, protocol, manager, pool, position id and the owner verified at the observed block or slot, and never derive
PnL or APY. Discovery outcomes are content-free telemetry only (§10 of the privacy policy).

## 8. Engine changes after review (flofi-liquidity, flofi-workflow)

- Position claim held under one lease across claim, owner-nonce reservation and the PREPARED save; an uncertain attempt whose nonce another transaction
  consumed is never concluded as not executed but stops blocking the position once it cannot change liquidity (collect-only, or past its on-chain
  deadline); re-observation appends nothing.
- `ownerOf` transport failures (`PUBLIC_RPC_UNAVAILABLE`) are retried and never clear an authorization or count as a burn proof.
- A later same-block transaction touching the position (manager `eth_getLogs`), or other owner transactions in the block, reconcile from the run's own
  receipt with `reconciliationScope: TRANSACTION`; an unexplained difference stays DIVERGENT.
- Run-log validator parity with the mint log (network binding, attempt chain, collect recipient = owner); exact first-key run-kind detection.
- Orca: a registered position that stops verifying is listed UNMANAGEABLE with its reason and blocks nothing else; the reward rule now also covers a
  partial withdrawal (simulation only; settled transactions are never re-judged).
- Owner-history purge: migration 0031 prepared and certified, **not applied** ([§23](../deploy/SCHEMA-COMPATIBILITY.md#23-certificate-0031_position_history_purge),
  [rollout](../deploy/RELEASE-POSITION-PURGE-0031.md)); 0016 unchanged.

## 9. Surfaces

| Surface | Position management | Notes |
| --- | --- | --- |
| Web Chat (EN/PT-BR) | yes — list, inspect, collect, partial withdrawal, exit, close; short answers; clarifying questions | authors MANAGE_LIQUIDITY_POSITION; never authorizes or signs |
| Editor / Canvas (PR #219 stages) | yes — Create names the operation, Simulate presents position results, Execute C1/C2 position Review, one footer action | the engineering Uniswap position panel is read-only |
| Dashboard | discovery + capability-driven actions that only prepare and open Operate | never executes |
| `/approve` | no | not offered |
| MCP, Telegram, WhatsApp, Developer API | **no** — not offered, answered honestly by the assistant; certification matrix rows `false` | no new tool, schema or route; the MCP `help` topic list gains an informational `LIQUIDITY_POSITIONS` entry (platform guide text only) |

FinOps: content-free outcomes (positions discovered, inspection unavailable, collection/withdrawal/exit prepared, simulation rejected, wallet
hand-off failed, reconciled, reconciliation required; `PARTIAL_COMPLETION` reserved because every operation is one atomic transaction), behind the
existing default-off `FLOFI_JOURNEY_TELEMETRY`. No fee policy change: position operations carry no FloFi fee and collected proceeds are never
revenue. The Admin FinOps presentation of PR #219 is unchanged.

## 10. Evidence classes

- **Implemented:** everything in §5–§9.
- **Certified by local / MOCKED evidence:** unit suites (compiler, linter, contracts, services, stores, presentation, chat dialogue), disposable
  PostgreSQL (0031 certificate, end-to-end purge, cloud flows), MOCKED browser profiles (see §12). Authorization in browser specs is performed
  through the same runtime as the server actions, because the product never authorizes a MOCKED result (precedent:
  `e2e/uniswap-liquidity-continuation.spec.ts`).
- **Validated with live mainnet reads:** none in this build (no public RPC was used).
- **Financially certified:** none. No position-management transaction was signed, sent or observed on any public network.

## 11. Limitations and follow-ups (documented, not hidden)

- Production activation of 0031 needs the owner's decision and, before it, FinOps 0029/0030 (their own procedure).
- Orca "Refresh review" starts a new simulation of the same operation (the Orca service has no in-place refresh).
- Embedded (Privy) wallets do not sign liquidity flows (existing limitation, unchanged).
- Cloud-runtime (embedded PostgreSQL) browser coverage of the MOCKED Base position harness is not wired (`backend/flows.ts` passes no synthetic pins
  in harness mode); the in-process action path is covered.
- Model understanding is proven with the closed replay and deterministic resolution, not with a live model.
- Uniswap NFTs held by an approved operator (not the owner) and staked/wrapped NFTs are out of scope; Orca bundled positions likewise.
- `base-liquidity.test.ts` "16-attempt limit" can approach the default 5 s test timeout under heavy CPU contention (observed locally only).

<!-- §12 (reviews, gates, tested SHA, CI, rollout order and the no-transaction confirmation) is completed at certification. -->
