# BUILD-FLOFI-UNIVERSAL-E2E-001 — Universal transaction execution and production certification

Branch `codex/build-flofi-universal-e2e-001` from `origin/main` `78ea792` (the commit `flofi.xyz` serves, checked read-only on
2026-10-23). Nothing was merged, deployed, migrated, configured or activated. **No transaction was signed or sent by this build**, and no
production secret or setting was read or changed.

Companion files (all generated or verified, none hand-kept):

| File | What it is |
| --- | --- |
| [CERTIFICATION-MATRIX.json](BUILD-FLOFI-UNIVERSAL-E2E-001-CERTIFICATION-MATRIX.json) | The network × action × protocol × channel matrix, generated from code by `apps/reference-dapp/src/engine/certification-matrix.ts`. A unit test fails if it drifts from code or omits a capability. |
| [EXECUTION-LEDGER.json](BUILD-FLOFI-UNIVERSAL-E2E-001-EXECUTION-LEDGER.json) | Every owner-signed public execution the repository records, with its transaction identifiers. |
| [LIVE-VERIFICATION.json](BUILD-FLOFI-UNIVERSAL-E2E-001-LIVE-VERIFICATION.json) | Read-only re-verification of every ledger transaction on public RPCs (`scripts/verify-live-evidence.mjs`). |
| [PRODUCTION-SNAPSHOT.json](BUILD-FLOFI-UNIVERSAL-E2E-001-PRODUCTION-SNAPSHOT.json) | Production's own capability report (FloFi Production MCP `get_capabilities`) and `/api/flofi/readiness`, read-only. |
| [READINESS.md](BUILD-FLOFI-UNIVERSAL-E2E-001-READINESS.md) | The customer-facing E2E readiness report. |

## 1. Summary

- **The incident is explained and fixed in general.** A Base Sepolia workflow showed a Solana Mainnet authorization manifest because
  the web app attached a run *recovered from the browser* to *any* current workflow (§4). The fix binds the runtime, the Review and the
  wallet namespace to the current workflow for every network, action and entry point. It fails closed.
- **A second broken path was found and fixed:** Arbitrum One and Ethereum `add_liquidity` were handed off by production MCP, but no
  web runtime served them (§5).
- **Certification matrix (71 rows):** 11 `LIVE_CERTIFIED`, 51 `IMPLEMENTED_UNCERTIFIED`, 9 `NOT_IMPLEMENTED` and 0 `BROKEN` on this
  branch. On `main` there are 2 `BROKEN` rows (§3, §5).
- **Every `LIVE_CERTIFIED` row is a testnet or devnet execution.** Each is historical (made at an earlier commit) and was re-verified
  read-only here: 10 executions, 17 transactions, all `VERIFIED` (§7). **No mainnet execution has ever been recorded for any network.**
  So none of the 40 implemented real-funds rows is certified.
- **No independent customer has executed anything.** Every recorded execution was signed by one of the owner's own three wallets (§7).
  The product cannot yet be called demonstrably usable by independent customers (§10, B2). The remaining step is owner-run live
  certification with explicit spending limits (§8).

## 2. Capability inventory (code + production, read-only 2026-10-23)

**Production.** `flofi.xyz` serves `78ea7928` (branch `main`), with a remote runtime, a live Copilot and session configured. Production
MCP reports 58 action × network rows. All 58 are implemented in code and set to `live` by the deployment. Three are refused for agent
surfaces by the owner's rollout policy (`AGENT_ROLLOUT_NOT_APPROVED`):

- Solana Mainnet `add_liquidity`;
- Ethereum Sepolia native transfer;
- Robinhood Chain Testnet native transfer.

The registry records demonstrated evidence for only 3 rows. Local-only runtimes are off in production: the Across mocked demo, CoW,
the LI.FI mocked bridge and the local fork modes.

**Networks (10).**

| Class | Networks |
| --- | --- |
| Mainnet, real funds | Base 8453, Arbitrum One 42161, Ethereum 1, Robinhood Chain 4663, Solana mainnet-beta |
| Testnet / devnet, test funds | Base Sepolia 84532, Ethereum Sepolia 11155111, Arbitrum Sepolia 421614 (bridge destination only), Robinhood Chain Testnet 46630, Solana Devnet |

**Actions and protocols.**

| Action | Protocol and networks |
| --- | --- |
| swap | Uniswap v3 (Base Sepolia, Ethereum Sepolia, Base, Arbitrum One, Ethereum, Robinhood Chain); Jupiter (Solana); Orca Whirlpools (Solana Devnet) |
| transfer | EVM native and ERC-20 (Ethereum Sepolia, Robinhood Chain Testnet, Base, Arbitrum One, Ethereum, Robinhood Chain); Solana system and SPL transfers (Solana, Solana Devnet) |
| bridge | FloFi Router over LI.FI or direct Across: 11 mainnet routes among Base, Arbitrum One, Ethereum and Robinhood Chain, plus Base Sepolia → Arbitrum Sepolia |
| supply, borrow, repay, withdraw | Aave v3 (Base Sepolia, Ethereum Sepolia, Base, Arbitrum One, Ethereum) |
| add_liquidity | Uniswap v3 positions (Base Sepolia, Ethereum Sepolia, Base, Arbitrum One, Ethereum, Robinhood Chain); Orca Whirlpools (Solana, Solana Devnet) |
| remove liquidity | Orca decrease/exit in the Canvas only (Solana, Solana Devnet). Not implemented on any EVM network |
| lending composition | Supply → borrow → swap on Base Sepolia (one composite flow) |
| Solana composition | Swap → Orca position on Solana Devnet (a bound composition, Canvas) |
| sequences | Up to 8 steps, one approval, confirm-each-step (BUILD-CHAT-E2E-001; off unless `FLOFI_WORKFLOW_RUNS=enabled`) |

**Entry points (channels).** Every channel shares one strategy engine and one workflow hash: the Canvas (Build), the in-app Copilot,
MCP (ChatGPT and Claude), Telegram, WhatsApp, the Developer API and Automations (confirm each time). None of them has financial
authority. Execution always happens in FloFi with the owner's own wallet, on the Canvas or on the `/approve` signing surface.

- WhatsApp is policy-blocked (fixture only).
- The Developer API accepts sandbox keys only, which means test funds only.
- Agent surfaces (Copilot, MCP, channels, Developer API) obey the agent-rollout policy.

**Wallet mechanisms.**

| Purpose | Mechanism |
| --- | --- |
| EVM wallets | Injected EIP-1193 wallets, discovered with EIP-6963 plus the injected fallback. MetaMask EIP-7702 / Delegation Framework redemptions appear in the evidence |
| Solana wallets | Wallet Standard (e.g. Phantom) |
| Wallet proof | EIP-4361 (SIWE) and Sign-In With Solana for sessions and `/approve` claims |
| Delegated Credentials | Passkeys (WebAuthn) |

There is no WalletConnect: a user needs a browser-extension wallet or a wallet's in-app browser.

**Deployment flags and policies.**

- Per-flow modes, from readiness and MCP.
- Agent rollout: `AGENT_ROLLOUT_APPROVED = []`.
- Requester mainnet handoff policy, from MCP `enabledByPolicy`.
- `FLOFI_WORKFLOW_RUNS` (sequences). It could not be read without creating a handoff, so this build did not read it.
- Delegated signing: no signer provider exists in production, so it is refused with `DELEGATED_SIGNER_UNAVAILABLE`.

The Railway owner-execution gates for Orca mainnet, Ethereum Sepolia transfer and Robinhood testnet are recorded in the
BUILD-SOLANA-TRANSFER-UX-001 release record. They were not re-read here.

## 3. Certification matrix

Classification rules (from `certification-matrix.ts`):

| Status | Requires |
| --- | --- |
| `LIVE_CERTIFIED` | A ledger execution whose every transaction re-verified read-only (chain id, status 1, canonical block, recorded block or slot, owner involvement or signature) |
| `IMPLEMENTED_UNCERTIFIED` | Code implements owner-wallet execution and a web runtime serves it |
| `BROKEN` | Implemented and handed off, but nothing serves it |
| `NOT_IMPLEMENTED` | No implementation |

Documentation, unit tests, mocked browser tests and successful deployments never raise a row.

The "Production deployment" column comes from the read-only production snapshot. "Chat/MCP/Telegram" means authoring plus approval
handoff. Every row's execution is the owner's wallet on the Canvas or on `/approve`.

| Status | Action | Network | Funds | Protocol | Flow | Web runtime (Canvas, /approve) | Chat/MCP/Telegram | Production deployment | Live evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMPLEMENTED_UNCERTIFIED | bridge | Base Sepolia → Arbitrum Sepolia | test | flofi.router | `crosschain-router-testnet` | router | yes | `crosschain-router-testnet` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Base → Arbitrum One | real | flofi.router | `crosschain-router` | router | yes | `crosschain-router` live | — |
| IMPLEMENTED_UNCERTIFIED | swap | Base | real | uniswap.v3 | `base-swap` | public | yes | `base-swap` live | — |
| **LIVE_CERTIFIED** | swap | Base Sepolia | test | uniswap.v3 | `base-sepolia-swap` | public | yes | `base-sepolia-swap` live | BUILD-011D-2-base-sepolia-swap |
| IMPLEMENTED_UNCERTIFIED | swap | Ethereum Sepolia | test | uniswap.v3 | `base-sepolia-swap` | public | yes | `base-sepolia-swap` live | — |
| IMPLEMENTED_UNCERTIFIED | swap | Solana | real | jupiter.swap-v2 | `jupiter-swap` | solana-swap | yes | `jupiter-swap` live | — |
| **LIVE_CERTIFIED** | swap | Solana Devnet | test | orca.whirlpools-devnet | `solana-devnet-swap` | solana-swap | yes | `solana-devnet-swap` live | BUILD-DEMO-001-solana-devnet-swap |
| IMPLEMENTED_UNCERTIFIED | transfer | Solana | real | solana.spl-transfer | `solana-transfer` | solana-transfer | yes | `solana-transfer` live | — |
| IMPLEMENTED_UNCERTIFIED | transfer | Solana Devnet | test | solana.system-transfer | `solana-devnet-transfer` | solana-transfer | yes | `solana-devnet-transfer` live | — |
| IMPLEMENTED_UNCERTIFIED | transfer | Ethereum Sepolia | test | evm.native-transfer | `robinhood-transfer` | transfer | rollout pending | `robinhood-transfer` live; policy `AGENT_ROLLOUT_NOT_APPROVED` | — |
| **LIVE_CERTIFIED** | transfer | Robinhood Chain Testnet | test | evm.native-transfer | `robinhood-transfer` | transfer | rollout pending | `robinhood-transfer` live; policy `AGENT_ROLLOUT_NOT_APPROVED` | RH-DEMO-001-robinhood-testnet-transfer |
| **LIVE_CERTIFIED** | supply | Base Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | BUILD-012A-base-sepolia-aave-supply |
| IMPLEMENTED_UNCERTIFIED | supply | Ethereum Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | — |
| **LIVE_CERTIFIED** | borrow | Base Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | BUILD-012B-base-sepolia-aave-borrow |
| IMPLEMENTED_UNCERTIFIED | borrow | Ethereum Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | — |
| **LIVE_CERTIFIED** | repay | Base Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | BUILD-012C-base-sepolia-aave-repay |
| IMPLEMENTED_UNCERTIFIED | repay | Ethereum Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | — |
| **LIVE_CERTIFIED** | withdraw | Base Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | BUILD-012D-base-sepolia-aave-withdraw |
| IMPLEMENTED_UNCERTIFIED | withdraw | Ethereum Sepolia | test | aave-v3 | `aave-supply` | supply | yes | `aave-supply` live | — |
| **LIVE_CERTIFIED** | add_liquidity | Base Sepolia | test | uniswap.v3 | `uniswap-liquidity` | uniswap-pool | yes | `uniswap-liquidity` live | BUILD-UNISWAP-LIQUIDITY-PUBLIC-base-sepolia-position |
| IMPLEMENTED_UNCERTIFIED | add_liquidity | Ethereum Sepolia | test | uniswap.v3 | `uniswap-liquidity` | uniswap-pool | yes | `uniswap-liquidity` live | — |
| **LIVE_CERTIFIED** | add_liquidity | Solana Devnet | test | orca.whirlpools-devnet-liquidity | `orca-liquidity` | solana-pool | yes | `orca-liquidity` live | BUILD-015-solana-devnet-orca-position |
| IMPLEMENTED_UNCERTIFIED | add_liquidity | Solana | real | orca.whirlpools-mainnet-liquidity | `orca-liquidity-mainnet` | solana-pool | rollout pending | `orca-liquidity-mainnet` live; policy `AGENT_ROLLOUT_NOT_APPROVED` | — |
| IMPLEMENTED_UNCERTIFIED | lending_composition | Base Sepolia | test | aave-v3, uniswap.v3 | `lending-composition` | lending | yes | `lending-composition` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Base → Robinhood Chain | real | flofi.router | `crosschain-router-base-to-robinhood` | router | yes | `crosschain-router-base-to-robinhood` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Robinhood Chain → Base | real | flofi.router | `crosschain-router-robinhood-to-base` | router | yes | `crosschain-router-robinhood-to-base` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Arbitrum One → Robinhood Chain | real | flofi.router | `crosschain-router-arbitrum-to-robinhood` | router | yes | `crosschain-router-arbitrum-to-robinhood` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Robinhood Chain → Arbitrum One | real | flofi.router | `crosschain-router-robinhood-to-arbitrum` | router | yes | `crosschain-router-robinhood-to-arbitrum` live | — |
| IMPLEMENTED_UNCERTIFIED | swap | Robinhood Chain | real | uniswap.v3 | `robinhood-swap` | public | yes | `robinhood-swap` live | — |
| IMPLEMENTED_UNCERTIFIED | add_liquidity | Robinhood Chain | real | uniswap.v3 | `robinhood-liquidity` | uniswap-pool | yes | `robinhood-liquidity` live | — |
| IMPLEMENTED_UNCERTIFIED | transfer | Robinhood Chain | real | evm.token-transfer | `robinhood-mainnet-transfer` | transfer | yes | `robinhood-mainnet-transfer` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Arbitrum One → Base | real | flofi.router | `crosschain-router-arbitrum-to-base` | router | yes | `crosschain-router-arbitrum-to-base` live | — |
| IMPLEMENTED_UNCERTIFIED | add_liquidity | Base | real | uniswap.v3 | `base-liquidity` | uniswap-pool | yes | `base-liquidity` live | — |
| IMPLEMENTED_UNCERTIFIED | transfer | Base | real | evm.token-transfer | `base-mainnet-transfer` | transfer | yes | `base-mainnet-transfer` live | — |
| IMPLEMENTED_UNCERTIFIED | supply | Base | real | aave-v3 | `base-aave` | supply | yes | `base-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | borrow | Base | real | aave-v3 | `base-aave` | supply | yes | `base-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | repay | Base | real | aave-v3 | `base-aave` | supply | yes | `base-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | withdraw | Base | real | aave-v3 | `base-aave` | supply | yes | `base-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | supply | Arbitrum One | real | aave-v3 | `arbitrum-aave` | supply | yes | `arbitrum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | borrow | Arbitrum One | real | aave-v3 | `arbitrum-aave` | supply | yes | `arbitrum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | repay | Arbitrum One | real | aave-v3 | `arbitrum-aave` | supply | yes | `arbitrum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | withdraw | Arbitrum One | real | aave-v3 | `arbitrum-aave` | supply | yes | `arbitrum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | swap | Arbitrum One | real | uniswap.v3 | `arbitrum-swap` | public | yes | `arbitrum-swap` live | — |
| IMPLEMENTED_UNCERTIFIED | transfer | Arbitrum One | real | evm.token-transfer | `arbitrum-mainnet-transfer` | transfer | yes | `arbitrum-mainnet-transfer` live | — |
| IMPLEMENTED_UNCERTIFIED | add_liquidity | Arbitrum One | real | uniswap.v3 | `arbitrum-liquidity` | uniswap-pool | yes | `arbitrum-liquidity` live | — |
| IMPLEMENTED_UNCERTIFIED | supply | Ethereum | real | aave-v3 | `ethereum-aave` | supply | yes | `ethereum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | borrow | Ethereum | real | aave-v3 | `ethereum-aave` | supply | yes | `ethereum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | repay | Ethereum | real | aave-v3 | `ethereum-aave` | supply | yes | `ethereum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | withdraw | Ethereum | real | aave-v3 | `ethereum-aave` | supply | yes | `ethereum-aave` live | — |
| IMPLEMENTED_UNCERTIFIED | swap | Ethereum | real | uniswap.v3 | `ethereum-swap` | public | yes | `ethereum-swap` live | — |
| IMPLEMENTED_UNCERTIFIED | transfer | Ethereum | real | evm.token-transfer | `ethereum-mainnet-transfer` | transfer | yes | `ethereum-mainnet-transfer` live | — |
| IMPLEMENTED_UNCERTIFIED | add_liquidity | Ethereum | real | uniswap.v3 | `ethereum-liquidity` | uniswap-pool | yes | `ethereum-liquidity` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Ethereum → Base | real | flofi.router | `crosschain-router-ethereum-to-base` | router | yes | `crosschain-router-ethereum-to-base` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Base → Ethereum | real | flofi.router | `crosschain-router-base-to-ethereum` | router | yes | `crosschain-router-base-to-ethereum` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Ethereum → Arbitrum One | real | flofi.router | `crosschain-router-ethereum-to-arbitrum` | router | yes | `crosschain-router-ethereum-to-arbitrum` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Arbitrum One → Ethereum | real | flofi.router | `crosschain-router-arbitrum-to-ethereum` | router | yes | `crosschain-router-arbitrum-to-ethereum` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Ethereum → Robinhood Chain | real | flofi.router | `crosschain-router-ethereum-to-robinhood` | router | yes | `crosschain-router-ethereum-to-robinhood` live | — |
| IMPLEMENTED_UNCERTIFIED | bridge | Robinhood Chain → Ethereum | real | flofi.router | `crosschain-router-robinhood-to-ethereum` | router | yes | `crosschain-router-robinhood-to-ethereum` live | — |
| **LIVE_CERTIFIED** | remove_liquidity | Solana Devnet | test | orca.whirlpools-devnet-liquidity | `orca-liquidity` | solana-pool | no | — | BUILD-015-solana-devnet-orca-position |
| IMPLEMENTED_UNCERTIFIED | remove_liquidity | Solana | real | orca.whirlpools-mainnet-liquidity | `orca-liquidity-mainnet` | solana-pool | rollout pending | — | — |
| NOT_IMPLEMENTED | remove_liquidity | Base Sepolia | test | uniswap.v3 | — | — | no | — | — |
| NOT_IMPLEMENTED | remove_liquidity | Ethereum Sepolia | test | uniswap.v3 | — | — | no | — | — |
| NOT_IMPLEMENTED | remove_liquidity | Base | real | uniswap.v3 | — | — | no | — | — |
| NOT_IMPLEMENTED | remove_liquidity | Arbitrum One | real | uniswap.v3 | — | — | no | — | — |
| NOT_IMPLEMENTED | remove_liquidity | Ethereum | real | uniswap.v3 | — | — | no | — | — |
| NOT_IMPLEMENTED | remove_liquidity | Robinhood Chain | real | uniswap.v3 | — | — | no | — | — |
| **LIVE_CERTIFIED** | swap_then_add_liquidity | Solana Devnet | test | orca.whirlpools-devnet, orca.whirlpools-devnet-liquidity | `solana-composition` | solana-composition | no | — | P0-solana-devnet-swap-to-orca-position |
| IMPLEMENTED_UNCERTIFIED | sequence | any (per step) | test | per step | `workflow-run` | per step | yes | — | — |
| NOT_IMPLEMENTED | sequence_bound_amounts | any (per step) | test | per step | — | — | no | — | — |
| NOT_IMPLEMENTED | sequence_delegated | base-sepolia, ethereum-sepolia (Uniswap swaps only) | test | uniswap.v3 | — | — | no | — | — |
| NOT_IMPLEMENTED | bridge | any EVM network → Solana | real | — | — | — | no | — | — |

Every `LIVE_CERTIFIED` row is historical: it proves the path at the commit named in the ledger, not on this release (see §8 for
re-certification). The two sequence rows that are `NOT_IMPLEMENTED` are capabilities a customer could expect but that production cannot
provide (§10).

## 4. Incident root-cause analysis: Base Sepolia workflow, Solana Mainnet manifest

**Reproduction (deterministic).**

1. In one browser, the owner simulates a Solana swap. The Jupiter store saves a pointer (`gryloo:build014:jupiter`) to its run in
   `localStorage`.
2. Later, on the same browser, the owner opens a Base Sepolia swap proposal on `/approve` (from ChatGPT, Claude, Telegram or the
   Developer API). The same happens on the Canvas, in the visit's first draft.
3. On mount, the Jupiter store restores its run from the pointer and marks it `recovered`.
4. `AppShell` computed `solanaPath = … || (recoveryShell && jupiter.recovered && jupiter.record)`. `recoveryShell` is true until the owner
   creates a new workflow, and a proposal is loaded into the visit's first draft. The Solana check comes before the public swap check,
   so the **Base Sepolia workflow was routed to the Solana runtime**.
5. `useReviewAuthorization('solana-swap')` attached the Jupiter run's Review. The signing surface then showed that Review beside the Base
   Sepolia actions: "Network: Mainnet · Real funds", the Solana token mints, "Allowed providers: Jupiter", "Allowed networks: Solana",
   spend limits and the residual recipient.
6. The automatic preparation called `jupiter.simulate()` for the Base Sepolia workflow, on the Jupiter (mainnet) runtime. It either
   failed with `JUPITER_SOLANA_WALLET_SELECTION_REQUIRED`, asking for a Solana wallet for an EVM request, or the Jupiter service
   refused the workflow. Either way the request could not proceed.

**Safety impact.**

- No wrong transaction could be signed. The Jupiter service re-asserts the reviewed workflow at `review` and at `begin`
  (`assertReview(record.review, workflow, …)`), so approval for the foreign workflow was refused server-side.
- The failure was presentation and availability: a wrong manifest was shown and the correct runtime was never reached. That is still a
  P0 trust defect, because the owner is asked to review authority that is not the request's.

**Scope (the general defect).**

- Five recovering stores attached their recovered run to any current workflow:
  - Aave supply/borrow/repay/withdraw (including the Base, Arbitrum and Ethereum mainnets);
  - the Solana composition;
  - Orca liquidity;
  - the Jupiter/Orca swap;
  - public-swap recovery.
- The others (router, EVM transfer, Solana transfer, Uniswap position, lending) were already limited to the untouched draft.
- The Aave runtime is checked before almost every other path. A recovered Aave run therefore claimed Solana, Uniswap-position and swap
  workflows too. Every network boundary was exposed: EVM ↔ Solana, mainnet ↔ testnet, different wallets, previous ↔ current workflows,
  and every entry point that lands on `/approve` or the Canvas.

**Second contamination vector.**

- The Review projection showed a *retired* Review's tokens, limits and network under "Review required again".
- This happened whenever the current workflow was not the run's own: a new workflow in the same visit, an edit, a restored proposal, or
  step N+1 of a sequence while step N's run was still held.

**Third vector.**

- `walletKind` became `solana` for an EVM workflow when the only connected wallet was a Solana session.
- The EVM Review was then bound to a Solana account.

**Why it shipped.**

- Each store's own `retired` flag was correct, but the routing ignored it.
- No test combined a recovered run with a *different* current workflow.
- The browser suites run each flow in a fresh browser profile, so they never carry a pointer across flows.

**Correction (commit `6cad214`).**

| Change | Where | Effect |
| --- | --- | --- |
| Runtime selection | `domain/runtime-selection.ts` (new, pure), used by `AppShell` | A recovered run attaches only to the untouched draft, or to exactly its own reviewed workflow. The order of runtimes is unchanged |
| Review binding | `review-presentation.ts` `workflowBoundAuthorization`, applied once in `AppShell` for every surface | A retired Review, or one whose network none of the workflow's actions uses, is dropped: no key, manifest, tokens, limits or approvals, so nothing can be approved. Local fork runtimes (chain 31337) keep their Review. The Solana composition position keeps its bound workflow |
| Wallet namespace | `capability-store.tsx` | An EVM workflow is reviewed against the EVM wallet, never against a Solana session |

**Regression tests.**

- `runtime-selection.test.ts` covers every composed capability example × each of the 10 recovering stores × every other example,
  with and without the Base catalog. That spans every network boundary, mainnet/testnet/devnet and EVM/Solana. It also checks that
  recovery still works on the untouched draft and never into a workflow created afresh.
- `review-presentation.test.ts` covers the incident manifest and every other network boundary, plus retired, recovery, bound-position
  and fork cases.
- `signing-surface.test.tsx` reproduces the incident as rendered HTML, then shows it fixed.
- `capability-store.test.tsx` checks the EVM namespace on 6 chains.
- The new tests fail on the previous logic: 15 selector tests and 6 namespace tests fail when the guard is removed.

## 5. Other broken paths

| Defect | Severity | Cause | Status |
| --- | --- | --- | --- |
| Arbitrum One and Ethereum `add_liquidity` reach no owner-wallet runtime on the Canvas or `/approve`. Production MCP hands them off (`arbitrum-liquidity`, `ethereum-liquidity`: live) | High (`BROKEN`) | `AppShell` kept a hand-written list of position chains (84532, 11155111, 4663, 8453), last edited in BUILD-BASE-001. BUILD-ARB-001 and BUILD-ETHEREUM-MAINNET-001 added the `arlp-` and `etlp-` runs but not the list, so these workflows fell through to the local-fork liquidity runtime, which is unavailable on deployments | Fixed: the list now comes from `uniswapLiquidityProfile` and `uniswapCatalogDeployment` |
| Cross-workflow Review presentation | P0 | §4 | Fixed |
| EVM workflow bound to a Solana session | Medium | §4 | Fixed |

## 6. Lifecycle identity audit (Intent → Status)

| Phase | Identity binding (workflow, network, assets, amounts, recipients, wallet) | After this build |
| --- | --- | --- |
| Intent → Compose | One engine (`src/platform`, StrategySpec → IR, one semantic hash) for the Canvas, Copilot, MCP, Telegram and the Developer API. Channel Core parity fails closed (`CHANNEL_STRATEGY_PARITY_FAILED`) | Unchanged, correct |
| Validate | Linter and registry on the composed IR; the requester policy for every network of every step | Unchanged |
| Simulate | **The runtime is now chosen from this workflow's own actions and networks** (was: possibly a recovered run's) | Fixed |
| Review | **Only this workflow's own Review is presented or approvable.** The manifest hash is bound to the workflow and revision; the network must be the workflow's | Fixed |
| Authorize | Accept-Review → wallet request, locked on the Review key; the wallet-change latch is kept on the raw key | Unchanged, fails closed |
| Sign | The exact reviewed bytes or calls. Solana refuses wallet-modified bytes (P0 compute-budget rule) | Unchanged |
| Submit | Server-side `begin` re-asserts the reviewed workflow and owner; owner lease; durable before signing | Unchanged |
| Reconcile → Evidence → Status | Per-flow reconcilers and frozen v1 bundles. Workflow runs advance a step only after the previous one reconciled; an uncertain step is `ATTENTION`, never resubmitted | Unchanged; verified by the existing PostgreSQL suites in CI |

## 7. Real on-chain evidence matrix

Re-verified read-only on 2026-10-23 with `scripts/verify-live-evidence.mjs`.

- **EVM checks:** the chain id, receipt status 1, inclusion in the canonical block, the recorded block, and the owner as sender or as a
  log topic (relayed EIP-7702 redemptions).
- **Solana checks:** finalized without error, the recorded slot, and the owner's signature.

The ledger also identifies each FloFi run and its evidence bundle.

| Execution | Action · network | Protocol · flow | Owner wallet | Transactions (block / slot) | Class | Re-verified |
| --- | --- | --- | --- | --- | --- | --- |
| `BUILD-011D-2-base-sepolia-swap` (BUILD-011D-2 (main 205055605d96f36e024a0bbc770453113e4f7b40 lineage)) | swap · base-sepolia (eip155:84532) | uniswap.v3 · `base-sepolia-swap` | `0x8ef12e4e…e41b3b` | approval [`0xa3ca25b0…`](https://sepolia.basescan.org/tx/0xa3ca25b0b5b6e573d3d61b0ee40eda9e9338a6534ceef3678932cd5ce2f7edd0) (47474130)<br>swap [`0xb5dd3f4b…`](https://sepolia.basescan.org/tx/0xb5dd3f4bb4d2f5a101ff5da371636fde917894eb03ef3c5f1ac0e71605799ff8) (47476344) | TESTNET_EXECUTED | **VERIFIED** |
| `BUILD-012A-base-sepolia-aave-supply` (BUILD-012A) | supply · base-sepolia (eip155:84532) | aave-v3 · `aave-supply` | `0x8ef12e4e…e41b3b` | approval [`0x628d8532…`](https://sepolia.basescan.org/tx/0x628d8532caa0ca157b90d93f12ab82b7695692c776d8d8756f97a1aec17ef0a3) (47546186)<br>supply [`0x717f81f6…`](https://sepolia.basescan.org/tx/0x717f81f6c360d7f62c64a13d258a513cf003e76ae3c2c1318dd00d3115cf5f0a) (47548275) | TESTNET_EXECUTED | **VERIFIED** |
| `BUILD-012B-base-sepolia-aave-borrow` (BUILD-012B) | borrow · base-sepolia (eip155:84532) | aave-v3 · `aave-supply` | `0x8ef12e4e…e41b3b` | borrow [`0x37a56482…`](https://sepolia.basescan.org/tx/0x37a5648235efc91f32d3f1400ccc5529b27e34c7e46dd7547bde493e8667f7f4) (47555223) | TESTNET_EXECUTED | **VERIFIED** |
| `BUILD-012C-base-sepolia-aave-repay` (BUILD-012C (PR #43)) | repay · base-sepolia (eip155:84532) | aave-v3 · `aave-supply` | `0x8ef12e4e…e41b3b` | approval [`0x4c3455ad…`](https://sepolia.basescan.org/tx/0x4c3455adbe6d5e391f5eea9ed5090e10ab77cbf5787fcf5f89d621e8e8232e88) (47562191)<br>repay [`0x426af294…`](https://sepolia.basescan.org/tx/0x426af294483363d23cd9363c24ac7941cc5661f5f2b5a4b55aa03b3750b5ee8f) (47565177) | TESTNET_EXECUTED | **VERIFIED** |
| `BUILD-012D-base-sepolia-aave-withdraw` (BUILD-012D (main 70ce37efae08018c642ddcc912913c07cabcb770 lineage)) | withdraw · base-sepolia (eip155:84532) | aave-v3 · `aave-supply` | `0x8ef12e4e…e41b3b` | withdraw [`0xd62dc935…`](https://sepolia.basescan.org/tx/0xd62dc935a1897f549a9cd7e131c8847953d97d7b8b8acdbf4d0d602adbeac372) (47570537) | TESTNET_EXECUTED | **VERIFIED** |
| `RH-DEMO-001-robinhood-testnet-transfer` (RH-DEMO-001 (PR #47 lineage, main 7003856)) | transfer · robinhood-testnet (eip155:46630) | evm.native-transfer · `robinhood-transfer` | `0x8ef12e4e…e41b3b` | transfer [`0xdadc1fd5…`](https://explorer.testnet.chain.robinhood.com/tx/0xdadc1fd5fd23e9bad85171cf2255c1e26df121ce3c8e2c35b121274436f4a498) (127567253) | TESTNET_EXECUTED | **VERIFIED** |
| `BUILD-UNISWAP-LIQUIDITY-PUBLIC-base-sepolia-position` (BUILD-UNISWAP-LIQUIDITY-PUBLIC (run unilp-ff982993a669f8a4f86a8d7b4c6c6369)) | add_liquidity · base-sepolia (eip155:84532) | uniswap.v3 · `uniswap-liquidity` | `0x8ef12e4e…e41b3b` | approval [`0x292f12ee…`](https://sepolia.basescan.org/tx/0x292f12eea493fbcd20cd284a8bfdf74ec14a28dbfca8958a5e00f8dbf36fc35d) (47647737)<br>mint [`0x158e125d…`](https://sepolia.basescan.org/tx/0x158e125d6bfb4df04a87d743e25d5c5ca4b2eef634cd27319439b1fae6f283d2) (47647747) | TESTNET_EXECUTED | **VERIFIED** |
| `BUILD-DEMO-001-solana-devnet-swap` (BUILD-DEMO-001 (PR #42 lineage, main 148f79c)) | swap · solana-devnet (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1) | orca.whirlpools-devnet · `solana-devnet-swap` | `6Mc7hRBcjo…KuMYQR` | swap [`5Aoo6QX3b7…`](https://explorer.solana.com/tx/5Aoo6QX3b7rh3wAX5fxY8ybx7R7k1VgrT95QhuAf5HNF2zNiaCVAoTZtus3HbdwtZthSY9BiMKWiJRVQc67dLCbB?cluster=devnet) (506389990) | DEVNET_EXECUTED | **VERIFIED** |
| `BUILD-015-solana-devnet-orca-position` (BUILD-015 (PR #44)) | add_liquidity · solana-devnet (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1) | orca.whirlpools-devnet-liquidity · `orca-liquidity` | `6Mc7hRBcjo…KuMYQR` | open [`4NmXs8NoB6…`](https://explorer.solana.com/tx/4NmXs8NoB6KW8jzPesDRZqDcQ26QS4crkF13jN9kNkbPxUf4W8FDitGy3ywaNKBaVTUQM9HcLYLpvJQhvW8LaLJJ?cluster=devnet) (506426965)<br>decrease-partial [`5HQGjFbb1j…`](https://explorer.solana.com/tx/5HQGjFbb1jbwNCEvm2fZM3oKZVQvqQ879Q1vDLumCGJF8RDX5t8KaEmFaXnRhNvvP73uiwzrEKwg88EA3r3oNHPa?cluster=devnet) (506427731)<br>exit [`8MAvfVGXXo…`](https://explorer.solana.com/tx/8MAvfVGXXo6mMcfkuikKnHmTfQ6S37Y5oPh6F7sdVJSNeNSgFZyFsGp1WpoonHHrAPLRWKzaQtq2zgCu1hzfZTV?cluster=devnet) (506428344) | DEVNET_EXECUTED | **VERIFIED** |
| `P0-solana-devnet-swap-to-orca-position` (FIX-SOLANA-WALLET-REFUSAL-P0 (PR #93, merged 9d2f4b9); run solcomp-895069b4c454a3ea9afa633c740c8826) | swap_then_add_liquidity · solana-devnet (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1) | orca.whirlpools-devnet + orca.whirlpools-devnet-liquidity · `solana-composition` | `6NTyfs83wz…VbhaRy` | swap [`3ojh2zrxqW…`](https://explorer.solana.com/tx/3ojh2zrxqWLjyvqSwXJ7EhuaRYr56bjisTLMzHQYoNB6cpd2nYuuz2fvzcFR2biaaiPC7bRYMj88DVBLrWTj3t57?cluster=devnet) (510782908)<br>position [`GFfk88a4as…`](https://explorer.solana.com/tx/GFfk88a4aswnNLCNB7sqe3NMM3qbr9T9UyD6JHYtZxEPcP9gbQsvHKHB8hxD5jFp775W8M7FQmptemV4aygMohn?cluster=devnet) (510789352) | DEVNET_EXECUTED | **VERIFIED** |

All recorded executions use three owner wallets: EVM `0x8ef12e4e…5e41b3b`, and Solana `6Mc7hRBc…KuMYQR` and `6NTyfs83…haRy`. There is
**no** mainnet execution, no Ethereum Sepolia, Arbitrum Sepolia or bridge execution, and no execution by an independent customer
wallet.

## 8. Live public-network certification plan (owner-run, never CI)

These runs involve real funds. **They require the owner's explicit authorization and spending limits before each batch.** No CI job and
no agent submits them: the owner signs every transaction in their own wallet through the reviewed flow.

**Proposed limits** (the owner sets the final values):

| Funds class | Per execution | Ceiling |
| --- | --- | --- |
| Test funds | No financial ceiling; use faucet amounts | — |
| Real funds on an L2 or Solana | ≤ 5 USD notional plus gas | — |
| Real funds on Ethereum L1 | ≤ 10 USD notional plus gas | — |
| Real funds, all batches | — | 150 USD total, gas included |

Bridge minimums follow the Router floors: 0.1 USDC on Base/Arbitrum pairs, 1 token on Robinhood pairs.

**Ordered batches.**

| Batch | Rows | Why first |
| --- | --- | --- |
| T1, testnet re-certification on this release | Base Sepolia swap, Aave ×4, Uniswap position; Solana Devnet swap, transfer, Orca position and composition; Robinhood Testnet transfer | Proves the fixed routing on the current code, and covers the never-executed Solana Devnet transfer |
| T2, never-executed testnet rows | Ethereum Sepolia swap, transfer, Aave ×4 and position; Base Sepolia → Arbitrum Sepolia bridge; lending composition | Each has an implemented, live flow and no evidence |
| T3, first mainnet per family | Base swap and transfer; Solana swap (Jupiter) and transfer; Arbitrum swap; Robinhood swap | The cheapest real-funds proof per network |
| T4, mainnet protocols | Aave supply → withdraw on Base, Arbitrum and Ethereum (borrow and repay only with explicit health-factor limits); Uniswap positions on Base, Arbitrum, Ethereum and Robinhood; Orca mainnet position (after the agent-rollout decision) | — |
| T5, bridges | One route per direction family (Base ↔ Arbitrum, Base ↔ Robinhood, Ethereum ↔ Base) | — |
| T6, sequences | One confirm-each-step two-step workflow from MCP and one from Telegram | Only if `FLOFI_WORKFLOW_RUNS` is enabled in production |
| P, permissionless | One T1 or T3 row by a wallet the team neither prepared nor hard-coded, through `flofi.xyz` | The `PERMISSIONLESS_EXECUTED` journey status |

**Each run must leave:**

- the chain id and network;
- the signing wallet;
- every transaction hash or signature, with its explorer link;
- the confirmed receipt (status, block or slot);
- the reconciled balances or position (the flow's reconciler);
- the FloFi run id and evidence bundle hash;
- the terminal status.

**Promotion procedure.** Add one entry to the execution ledger with the run's identifiers, then run:

```
node scripts/verify-live-evidence.mjs docs/builds/BUILD-FLOFI-UNIVERSAL-E2E-001-EXECUTION-LEDGER.json docs/builds/BUILD-FLOFI-UNIVERSAL-E2E-001-LIVE-VERIFICATION.json
FLOFI_WRITE_CERTIFICATION_MATRIX=1 pnpm vitest run apps/reference-dapp/src/engine/certification-matrix.test.ts
```

The matrix test promotes a row only from a verified entry. It refuses `LIVE_CERTIFIED` on a real-funds row without a `MAINNET_EXECUTED`
entry. Mainnet RPCs (Base, Arbitrum, Ethereum, Robinhood, Solana) must be added to the verifier's endpoint table when the first mainnet
entry exists.

## 9. Validation results

**Local (WSL, 2026-10-23):**

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | Passed. Unit suite: 410 files, **4,820 passed**, 2 skipped (pre-existing), 0 failed |
| New and changed suites | runtime selection 25, Review guard 29, signing surface 66, capability store 10, certification matrix 5: all passed |
| `governance_lite.py`, its unittests, `test_ci_*.py`, `git diff --check` | Passed |
| Read-only live evidence verification | 10/10 executions, 17/17 transactions `VERIFIED` |
| Database-free guarded browser profiles | **30 of 30 passed, 309 tests, 0 failed** (CI's own runner, `node scripts/guarded-release-browser.mjs profile <name>`): `solana-wallet-refusal`, `review-execute-recovery-components`, `jupiter-provenance`, `devnet-provenance`, `orca-liquidity-provenance`, `solana-composition-provenance`, `lending-provenance`, `supply-provenance`, `transfer-provenance`, `uniswap-provenance`, `router-provenance`, `journey-provenance`, `solana-transfer-ux`, `solana-mainnet-network`, `canvas-automation-ux`, `unsafe-lending-simulations`, `canvas-corrections`, `copilot`, `copilot-solana`, `robinhood-mainnet-authoring`, `ethereum-authoring-certification`, `arbitrum-authoring-certification`, `workflow-ux-authoring`, `canvas-workflow-ux`, `base-mainnet-authoring`, `synthetic-fork-provenance`, `cow-loopback`, `card-provider-loopback`, `mcp-routes-oauth-disabled`, `default-product`. `composition-provenance` belongs to the composition phase (pinned downloads) and was left to CI |
| PostgreSQL suites and the 15 database-backed browser profiles | **Not run locally.** No PostgreSQL server was available: Docker Desktop was not running and its WSL integration is missing. They run in CircleCI `certification` |

**Remote CI (CircleCI).** Pushing the branch and opening the PR runs the required checks on the PR head: `ci/circleci: governance`, and
`ci/circleci: certification` with its PostgreSQL, fork, browser shards and fan-in. That run covers the PostgreSQL suites and the
database-backed browser profiles this machine could not run. Its outcome is recorded on the PR, not in this file, so that recording it
does not start another run. Green CI alone is not certification: it is MOCKED/loopback evidence, never public execution.

## 10. Outstanding blockers

| # | Severity | Blocker | Exact cause | Required correction |
| --- | --- | --- | --- | --- |
| B1 | Critical (product) | No real-funds row is certified (40 implemented rows) | No owner-signed mainnet execution has ever been made | Owner-run batches T3–T5 under explicit limits (§8) |
| B2 | Critical (product) | Not demonstrated with independent customers | Every execution was signed by the owner's own wallets | Permissionless journey P (§8) on `flofi.xyz` |
| B0 | High (CI) | CircleCI `Dependency audit` fails on every branch, `main` included | GHSA-mrhx-c7xc-m3w5 (high) against `zod < 4.6.6`, a dependency of the MCP SDK; found by this PR's first pipeline (job 250) | PR #117 (`zod` 4.6.6 by exact override, graph pin updated; [security note](BUILD-FLOFI-UNIVERSAL-E2E-001-DEPENDENCY-SECURITY.md)). This branch is stacked on it: merge #117 first |
| B3 | High | The fixes in this PR are not in production | `flofi.xyz` serves `78ea792` | Owner review, merge, promotion (§11) |
| B4 | High | Never-executed testnet paths: Ethereum Sepolia (7 rows), the Base Sepolia → Arbitrum Sepolia bridge, the lending composition, the Solana Devnet transfer | No public run was made | Batches T1 and T2 |
| B5 | High | One-authorization (delegated) workflows are unavailable in production | No KMS/HSM signer provider (`DELEGATED_SIGNER_UNAVAILABLE`); templates exist only for Uniswap swaps on two testnets | A reviewed custody design. Out of scope here (no custody change allowed) |
| B6 | Medium | Sequences that spend a previous step's received amount cannot run in confirm mode | `DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED`: owner-signed flows expose no canonical received amount | Expose the reconciled `received` per flow, then allow `amountFrom` in confirm mode |
| B7 | Medium | Sequence availability in production is unknown | `FLOFI_WORKFLOW_RUNS` is not readable without creating a handoff | The owner confirms the setting on web and worker |
| B8 | Medium | No EVM liquidity removal | The public Uniswap engine mints only; decrease/collect exist only in the local-fork engine | A new reviewed flow |
| B9 | Medium | Agent surfaces cannot author Solana Mainnet positions or testnet native transfers | `AGENT_ROLLOUT_APPROVED = []` (owner decision) | Owner decision |
| B10 | Medium | Mobile users outside a wallet's in-app browser cannot connect | No WalletConnect integration | A product decision |
| B11 | Medium | Wallets that alter Solana transactions are refused | The exact-byte rule (P0): Phantom inserts compute-budget instructions where a flow sets no price; Devnet flows carry a reviewed price, mainnet Orca liquidity keeps `0` (owner decision) | Verify with Phantom in T3 and T4 |
| B12 | Low | WhatsApp unavailable | Policy D1 | Written policy clearance |
| B13 | Low | No EVM ↔ Solana bridge | No route implemented | New build |
| B14 | Infra | Vercel Previews share Production `DATABASE_URL` (verified 2026-10-22, not re-read here) | One env entry targets both | Owner: give Preview its own database |

## 11. Production rollout and rollback

This PR changes only client and domain code: the routing and Review presentation, the wallet namespace, a test-only matrix generator,
the docs and a read-only script.

- There is no migration, no backend behavior change, and no environment or flag change.
- Railway API and worker builds from `main` are functionally unchanged.

**Rollout (owner actions):**

1. Review and merge the PR after the required checks (`ci/circleci: governance`, `ci/circleci: certification`) are green.
2. Vercel builds the production deployment of the merge commit. Custom domains are not auto-assigned, so the owner promotes it to
   `flofi.xyz`.
3. Verify read-only: `https://flofi.xyz/api/flofi/readiness` reports the merge commit, and the Railway deployments are healthy.
4. Run the incident check on `flofi.xyz` in one browser:
   1. Simulate a Solana swap (read-only).
   2. Open a Base Sepolia `/approve` proposal.
   3. Expect the Base Sepolia network, the EVM wallet and no Solana field. The fresh simulation must use the Base Sepolia runtime.
5. Run batch T1 (§8) on the promoted release.

**Rollback:**

- In Vercel, promote the previous production deployment (`78ea792`) or revert the merge commit on `main`.
- No data migrates and no persisted state changes format. The browser recovery pointers stay valid in both directions, so a rollback
  needs no cleanup.

## 12. Deviations and limits of this build

- **An intentional test change, for review.** CircleCI's `certification-browser-1` failed once in `unsafe-lending-simulations`
  (`repay.spec.ts`, intermittent; CI's trace rerun passed). The failure screenshot shows "Connect your wallet to set the beneficiary":
  the test clicked Add Repay before the injected wallet's passive reconnect. This is the race BUILD-SOLANA-TRANSFER-UX-001 fixed in
  `canvas-automation-ux`, with the same correction: wait until the header shows the owner's wallet before adding the action. It is applied
  to the profile's two tests (Repay and Borrow). No assertion changed, and the profile passed 3 of 3 runs locally.
- The dependency fix is a separate PR (#117) because it is a different, security-gated change. This build is stacked on it.
- Real transactions were not submitted (release rules; owner authorization is required). The live certification is a plan (§8), not
  evidence.
- Remote CI covers the PostgreSQL and database-backed browser suites that could not run locally. Fork suites run in CircleCI as usual.
- No browser regression drives the incident through a real recovered journal. The incident is covered at the pure routing, Review
  projection and rendered signing-surface levels; the existing recovery browser profiles (P0 persisted composition, provenance
  boundaries) pass unchanged.
- No UX redesign. The only visible change: a Review that is not the current workflow's is no longer shown. Its status line stays
  "Review required again" until a fresh simulation.
