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
  PostgreSQL (0031 certificate, end-to-end purge, cloud flows), MOCKED browser profiles (see §12.4). Authorization in browser specs is performed
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
- **Activation follows the existing owner-execution gates (owner decision before deployment).** No new gate or variable was added (the build
  may not change gates or environment variables). Position operations use the same owner-execution switch as minting on that network
  (`GRYLOO_<NETWORK>_OWNER_EXECUTION` / the Orca mainnet switch): a deployment where that switch is already on offers collect, withdrawal, exit and
  close with real funds as soon as this build is deployed, with no public-network evidence yet (§10). Owner wallet authorization, owner-only
  recipients and explicit close still apply. The owner should acknowledge this, or keep the switch off until a first supervised operation.
- A restored workflow that mixes a position step with other steps (not producible in the Editor) fails closed at the runtimes rather than being
  refused when loaded.
- A collect-only (or empty-position close) request left uncertain whose nonce is never spent keeps the position claimed until the owner's wallet
  spends that nonce (it may still execute); a lapsed PREPARED attempt, or an uncertain request that can no longer change liquidity, releases it.
- A non-revert RPC error (other than a transport failure) at begin/hand-off reads as "position not found" and clears the authorization (fails closed).
- Discovery: empty positions are not listed (closing an empty Uniswap NFT or refunding an empty Orca position is not offered from the Dashboard);
  Orca manageability does not pre-check the pool's emitting reward slot (Simulate refuses with `ORCA_POOL_REWARDS_UNSUPPORTED`). The Dashboard scan
  cache is invalidated after Uniswap operations only (Orca waits for the 30 s cache); the chat keeps its own position facts for 20 s.
- Existing, not introduced here: in open beta mode liquidity runs (mint and position) have no run-ownership binding beyond the owner argument.
- PT-BR text outside this build's components (execution timeline "Carteira confirmation…", "Orca Whirlpool s", "Your Workflow" heading) is unchanged.
- Data privacy: PostgreSQL 18 evidence comes from CI (local runs used 16.15); hosted Neon and LGPD/GDPR acceptance remain separate; the existing
  0016 tombstone and owner-history events keep wallet and run id permanently (now also for position runs); `admin_run_facts` keeps derived run
  facts for every format (unchanged by 0016 and 0031).

## 12. Reviews, gates, certification and rollout

### 12.1 Specialist reviews (read-only specialists; at most three at once; main ran every requested search and test)

| Domain | Head reviewed | Result | Disposition |
| --- | --- | --- | --- |
| flofi-workflow | 0057babe | F1–F6 | F1–F6 fixed or accepted (§5, §8) |
| flofi-liquidity | 0057babe | #1–#7 | all fixed (§8) |
| flofi-security | 0057babe | stopped to respect the three-agent cap | superseded by the final review at 7242e124 |
| flofi-data-privacy | 4e8ceb4b | 8 findings | #1, #2, #4–#8 fixed; #3 documented (§11, data privacy) |
| flofi-security (final) | 7242e124 | P2, P3, P3 | P2 owner-execution gate → owner decision (§11, §12.5); P3 lapsed PREPARED fixed; P3 Orca binding wording fixed |
| flofi-workflow (final) | 7242e124 | P2, P3 ×3 | P2 retired previous fixed; P3 EXIT:keep fixed; P3 lapsed PREPARED fixed; P3 restored mixed workflow → follow-up (§11) |
| flofi-liquidity (final) | 7242e124 | P2 ×2, P3 ×6 | P2-1, P2-2, P3-1, P3-3, P3-4, P3-5 fixed; P3-2, P3-6 follow-ups (§11) |
| flofi-frontend-ux (final) | bddd4546 | 6 × P3 | #1 floor wording and #5 generic PT template fixed; #2, #3, #4, #6 follow-ups (§12.3) |
| flofi-chat (final) | bddd4546 | P1, P2 ×2, P3 ×2 | all fixed with tests (button label read as the portion; ordinal; token ids to the model; help topic; Aave withdraw) |
| flofi-wallet-execution (final) | bddd4546 | P2, P3 ×4 | P2-1 same-block expiry fixed (race test fails without the fix); P3-1 envelope nonce and P3-4 server never-sent guard fixed; P3-2 documented; P3-3 follow-up |
| flofi-liquidity (delta) | eeec8aac | no blocker; 4 follow-ups | F1 (mint path, pre-existing) fixed by parity with a race test; F3 wording fixed; F2, F4 follow-ups |
| flofi-infrastructure-ci | eeec8aac | no blocker; 2 low | unmeasured timings dropped (median rule); inherited Orca journal cleared by the runner |
| flofi-protocol-integrations | eeec8aac | no blocker; 4 low | doc comment corrected; availability items follow-ups (all fail closed) |
| flofi-wallet-execution (delta) | f275a904 | PASS | relayed-submission and block-hash hardening, mint envelope nonce → follow-ups |
| flofi-chat (delta) | f275a904 | PASS | Orca short ids redacted (0d820527); count wording, range-filtered ordinal, "liquidez" + token amount, regex export → follow-ups (export fixed) |

AI review is advisory; CircleCI is the certification authority.

### 12.2 Domains not reviewed, and why

- flofi-bridge, flofi-automations, flofi-payments-billing, flofi-transfer-payments: no change in their paths. The new composition restriction
  applies only to a node carrying the `position-management` marker; `liquidity-positions.test.ts` proves swap, bridge, deposit and lending
  workflows compose exactly as before.
- flofi-mcp, flofi-channels, flofi-developers: no capability was added. Non-web surfaces answer that position management is web-only; the
  certification matrix keeps `mcp`, `telegram` and `developerApi` false. flofi-security and flofi-chat verified this, and `channels/boundaries.test.ts`
  is green.
- flofi-admin-analytics: the only change is the default-off, trace-free `liquidity.lifecycle` line, covered by the flofi-data-privacy review.
- flofi-swap, flofi-lending: no material change. The Aave-withdraw routing correction is covered by the flofi-chat review and its tests.

### 12.3 Follow-ups from the final reviews (non-blocking; none moves funds without the owner's wallet)

- Editor: "Adjust" on a managed withdrawal card opens a dialog with no slippage field; "Start a new workflow" after `HAS_OTHER_STEPS` can fail
  silently if staging then fails; the Dashboard offers prepare actions for a linked wallet that is not connected (the runtime refuses, but the
  sentence names the wrong cause); PT-BR wording nits (gender of "Fechada", two terms for rent, raw ISO deadline, "Collect fees" for a Uniswap
  collect that may include principal).
- Chat: "Only N positions match" counts eligible positions after an unresolved ordinal; an ordinal after a range-filtered list counts the
  unfiltered list; "retira 10 USDC da minha liquidez" is read as an Aave Withdraw (the behaviour before this build; the owner reviews it).
- Execution: relayed (EIP-7702) submissions are not covered by the same-block nonce rule, so a request whose receipt arrives between the receipt
  read and the head read can still read as expired (the behaviour before this build); query the count by block hash (EIP-1898); NOT_FOUND is
  judged at the unconfirmed head; the mint envelope check does not bind the nonce; a lapsed position PREPARED attempt blocks a mint's nonce
  until observed (fails closed); a FloFi Wallet (embedded) session sees "rejected" rather than "not supported"; Orca has no per-position claim
  (two separately authorized withdrawals of one position can both land).
- Discovery: Orca reads only the verified SOL/USDC Whirlpool, so a wallet holding positions on other Whirlpools reads as having none there; the
  catalog read and the per-position static collect share the 12 s budget (a large wallet may show UNAVAILABLE); queued reads continue after the
  deadline; degraded manageability is cached for 30 s with the reason `POOL_NOT_VERIFIED`.
- CI: refresh the two new profile timings with `scripts/ci_timings.py` after the first certification.

### 12.4 Gates at the tested commit

Local gates (Node 24.21.0, pnpm 11.22.0, Anvil 1.8.3; CircleCI is the certification authority):

- `pnpm check` at 0d820527: typecheck (16/16), lint and build (9/9), schema drift (11 exports), unit and contract suites with 749 files
  passed and 2 skipped (both skips predate this build; none was added and no test was deleted), 9685 tests.
- `pnpm test:postgres` on disposable PostgreSQL 16.15: 136 of 137 files passed, 932 of 933 tests. These include the 0031 certificate and its
  reversal, the end-to-end position purge, and the cloud flows. The one failure is `forward-compatibility.pg.test.ts`, the 0015 check on a v14
  database: it expects the three NOT NULL constraint rows that PostgreSQL 18 models, while local PostgreSQL 16 records none. This build changes
  neither that test nor 0015. CircleCI runs PostgreSQL 18.
- MOCKED browser profiles on the 0d820527 production build:
  - `liquidity-position-management` 8/8 (Editor, Dashboard and the chat spec on closed replay);
  - `orca-position-management` 2/2, after ba89dafb aligned the spec with the Dashboard's current "Open (has liquidity)" label (it had failed
    deterministically on that text);
  - `copilot` 13/13 and `copilot-pool-dialogue` 3/3 (existing replay chat paths, after the chat fixes).
- `python3 scripts/governance_lite.py` passed. `python3 -m unittest discover -s scripts`: 353 tests OK.
- `python3 scripts/agent_guard.py check` PASS (19 domains, 185 modules). `impact`: no unmapped path. `agent_evolution.py`: advisory signals
  only, with no missing suite or owner.
- `agent_guard.py review` (hook-observed): it records a peak of four concurrent `flofi-*` reviewers against a limit of three. This happened once,
  early, when the first flofi-security review overlapped the next batch and was then stopped. Every later batch ran at three or fewer. It also
  records the implementation agents (general-purpose and workflow) as invoked outside the review plan.
- The CircleCI certification of the pull request's exact head is recorded on the pull request.

### 12.5 Rollout order

1. The owner reviews the pull request. It is merged only on the owner's authorization, after CircleCI certifies its exact head.
2. Deploying it changes no schema. `SHIPPED_MIGRATIONS` stays at 28, and the pre-deploy `migrate` applies nothing. 0031 is certified, not applied.
3. Owner-execution gate (owner decision, §11): position operations use the existing per-network owner-execution switch for minting. Where a
   switch is already on, collect, withdrawal, exit and close are offered with real funds as soon as this release is deployed, and no public-network
   evidence exists yet. Owner wallet authorization, owner-only recipients and explicit close still apply. To hold them back, keep the switch off
   until a first supervised operation. This build changes no switch.
4. First supervised operation per network, with the owner's own funds and signature: it is the first public-network evidence. Until it
   exists, the evidence class stays local or MOCKED (§10).
5. 0031 follows its own staged procedure ([RELEASE-POSITION-PURGE-0031.md](../deploy/RELEASE-POSITION-PURGE-0031.md)): FinOps 0029/0030 first, a
   rehearsal on a disposable Neon branch, then the owner's approval.

Rollback: before 0031, any earlier build can still serve the database, because the schema is unchanged. Position runs written by this release
are readable only by a build that knows the position format (`flofi.uniswap-position-run.v1`). An older worker still schedules a submitted,
pending or uncertain position run for observation, but it cannot load the run. That run therefore stays unreconciled, and nothing is sent: the
older build has no send path for it. Roll back only when no position run is in flight; otherwise redeploy forward, and the position run is then
reconciled from where it stopped. Never edit or delete a run to make an older build accept it.

### 12.6 Confirmation

No real-money transaction was signed, sent or broadcast. No production database was read or written. No migration was applied outside disposable
PostgreSQL. No environment variable, execution gate, fee policy, or Railway or Vercel configuration was changed. Browser and fork acceptance used
closed replay and loopback harnesses only.
