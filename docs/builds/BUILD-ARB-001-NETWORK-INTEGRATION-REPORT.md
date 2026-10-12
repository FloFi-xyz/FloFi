# BUILD-ARB-001 — Arbitrum One network integration report

> Phase 8 local certification is complete. See [Phase 8 certification](BUILD-ARB-001-PHASE-8-CERTIFICATION.md) for current results and corrected baseline classifications. The Phase 7 checkpoints below are historical; final GitHub checks and merge are tracked by the BUILD-ARB pull request.

Checkpoint: **Phase 7B COMPLETE — UX-008 / UX-009 / UX-010**, 2026-10-12. **BUILD-ARB-001 is not final**.
Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
Recovered clean Phase 7A parent: `04555b0f67cfcb70bb5c414196d23d41e04b3844`; Phase 6 parent: `ab5919842e036047047e614ebdb7176d06ba4aeb`.
CURRENT HEAD is the Phase 7B commit containing this report; use the [handoff](BUILD-ARB-001-HANDOFF.md) commit-resolution command.
COMPLETED: Phases 1–6, UX-001–007 and UX-008–010 implementation/validation/docs/local checkpoint.
REMAINING / NEXT EXACT ACTION: stop here. **Phase 8 — full repository validation / CI / PR only on explicit owner instruction.**
DO NOT REDO completed phases, the Phase 7A six-failure classification, or Phase 7B implementation. No push/PR/full CI in this checkpoint.

## Phase 7B Canvas checkpoint

| Item | Result | Evidence |
| --- | --- | --- |
| UX-008 | PASS | Same toolbar/order, compact intrinsic desktop flex sizing; all 15 labels and dock fit 1440/1536/1920px on one row. No overlap, clipping, horizontal scroll, hidden controls or scale transform. Shield + Privacy fully visible; existing unavailable state preserved. |
| UX-009 | PASS | Shared InsertionViewport, committed canonical IDs only, measured React Flow bounds, fitView padding 32px/90px and zoom bounds 0.35–1.1, 180ms. Preserve comfortable manual viewport; 1–5 cards visible, no proposal-only fit, no ordinary-edit/quote/connection/drag fit. |
| UX-010 | PASS within existing runtime capabilities | Existing canonical dependency DAG, real handles → CONNECT/DISCONNECT → SemanticWorkflow → derived arrows/numbers. Generic/repeated actions and network transitions; same persisted IR and stale Review guards, no separate graph/executor. |

The canonical model is **DAG**, with instance-ID dependencies and separately typed resourceEdges. New dependency authoring does not guess
asset-output references. Structural validation uses the existing schema; complete typed compositions keep their financial validator.
validateWorkflowDraft accepts dependency-only compositions of independently valid registered actions. Existing strict financial validator,
linter/compiler/Review/execution/recovery still decide what can run; no supported financial combinations or authorization rules expanded.
Unsupported arbitrary financial fixtures are explicitly tested to fail strict validation. Existing valid lending simulation/call plan node
order equals Canvas order; actual canonical dependency changes retire stale artifacts/Review. Next supported step still requires existing
success/reconciliation boundaries. Compiler/executor/reconciler source is unchanged; no frontend executor was added.

Instances remain distinct through add/edit/duplicate/save/reload. Bridge additions preserve financial siblings; ordinary edits keep edges.
Deterministic topological numbering is shared by visible Canvas actions and Copilot; hidden template scaffolding no longer offsets action
numbers. Mock-only templates remain protected. The Copilot corpus/replay and six browser journeys use the corresponding visible ordinals,
with explicit Apply, clarification, refusal and authority invariants preserved. Layout snapshots retain positions through reconnects;
dragging changes only layout and keeps IR/hash. No ordering from screen coordinates.

Self/unknown/invalid-handle/cyclic edits reject, duplicate relations are idempotent. DAG joins/branches reuse existing dependencies;
removing/reconnecting edges updates the same canonical IR, arrow and hash. Protected typed links remain protected. Disconnected authoring
is permitted; it cannot bypass existing financial validation. Save/validate/RESTORE_WORKFLOW unit round-trips reconstruct IDs, order,
numbering and edges; no separate edge persistence or PostgreSQL/browser durable-save claim. Chain/network composition is action-agnostic;
financial network/asset compatibility stays with existing validators/Simulate.

Action examples PASS: Bridge → Swap; Swap → Swap → Send; Bridge → Bridge → Bridge → Swap;
Supply → Borrow → Swap → Bridge → Send; Send → Swap; Send → Send; three Swaps; Repay → Send; Withdraw → Swap; Swap → Pool → Send.
New connection suite: 18 cases, including repeated independent parameters, reverse order, removal/reconnect, DAG validation, persistence,
layout/hash stability, supported simulation parity and stale Review. Existing 40 Base/Robinhood vectors, Arbitrum certification vectors,
Phase 2 Send hashes and canonical hash suite remain unchanged. Dependency edits naturally change semantic identity; layout does not.

TESTS PASSED: final browser **23/23** (6 Canvas, 6 Copilot, 11 Phase 7A authoring); core focused unit **455 tests**;
final numbering/Copilot/history/projection **8 files / 283 tests**, authoring/replay **6 files / 51 tests**, canonical **8/8**;
scoped ESLint and TypeScript **33 code files**, governance-lite/**19 self-tests**, diff-check. Counts overlap and are not summed.
Types use the existing skipLibCheck dependency-declaration limit; no full-app typecheck pass is claimed. An isolated compile-only Next
bundle supported local browser checks; all gates stayed off, wallet checks were passive and external requests closed by replay.
No full browser/database/fork matrix. Commands, logs, implementation detail and all changed paths are in the handoff.

TESTS FAILING: core batch **1/456**, lending-composition-service.test.ts:477 (initial zero collateral before Supply/Borrow).
Classification **PRE_EXISTING_BASELINE_BEHAVIOR**: exact case and old Phase 7A classifier probe reproduce it; service/test/harness/compiler/
executor/reconciler match Phase 7A. Supply enables collateral and changes account LTV/threshold from zero; unchanged reconciliation reports
LENDING_POSITION_CONFIGURATION_MISMATCH, clears authorization, and next begin fails LENDING_REVIEW_REQUIRED. No guard weakening/financial fix.
Full service file has 60 passes/1 failure; filtered probe skips are not passes. Record for Phase 8 along with the inherited Robinhood line-83
TS2532 and four engineering-profile timeouts described in the historical record below. Phase 8 also reviews approved toolbar/viewport
visual baselines; none changed in Phase 7B. Generic authoring is not evidence that every financial DAG has an executable runtime today.

Files changed: toolbar/card/Canvas, canonical editor/history/commands/presentation/readers/save/step projection, shared draft validation and
ordering helpers/classifier, focused tests/Copilot numbering fixtures/browser profile, three build docs. Exact inventory in handoff.
next-env.d.ts had generated .next-motion path noise only; restored to repository/Phase 6 bytes and excluded. No temporary results or probes,
secrets, dependencies, Production configuration or databases changed. UX-001–007 remain protected by focused browser/unit regressions.
UNAPPROVED UX CHANGES / PRODUCTION CHANGES / REAL-MONEY TRANSACTIONS: NONE. Gates off. FULL CI NOT RUN. No push/PR.

The following Phase 7A and network sections are historical evidence, scoped to their completed checkpoint.

## Phase 7A UX checkpoint

| Item | Result | Validated behavior |
| --- | --- | --- |
| UX-001 | PASS | Visible network-aware Send To, mixed-case EIP-55 validation, missing/invalid recipient blocks Review, restricted test networks show read-only connected wallet. Canvas, deterministic Chat, natural Copilot and MCP use the same canonical recipient. Copilot asks “Which wallet should I send it to?”; explicit own-wallet wording maps to CONNECTED_OWNER. |
| UX-002 | PASS | Existing Automate action is an accessible clock beside rename/save; old bottom-left control removed; handler/availability preserved. |
| UX-003 | PASS | Simulating workflow… and Waiting for wallet… stay locked CTA buttons; existing request locks and browser forced-click checks prevent duplicates. |
| UX-004 | PASS | Terminal completed/declined/cancelled/failed results offer Create new workflow; fresh UUID and clean Build/proposal/conversation/drafts, wallet preserved. Return to Build retains the workflow; unresolved runs keep recovery. |
| UX-005 | PASS | Send presentation only; transfer commands, asset.transfer, runtime identities and hashes unchanged. Both Phase 2 Send hashes and all 40 frozen historical vectors pass. |
| UX-006 | PASS | Existing confirmation centered on empty Canvas; no mutation before Apply; dismiss restores droplet; non-empty top-right behavior retained. |
| UX-007 | PASS | 200 ms debounce; cancellation and latest-response guards; immediate Calculating…; truthful Quote unavailable; shared read-only quote path on Base/Arbitrum/Robinhood under existing network gates. No automatic Simulate/Review/Execute. |

Quote requests use AbortController, cleared debounce/timeout timers and an active flag on cleanup. A per-hook generation ticket plus
workflowHash/node/chain/provider/expiry checks rejects stale or mismatched responses. The browser cache holds at most 32 exact
workflow-hash/node/owner snapshots and reuses only unexpired answers for that same snapshot, including amount/revision/network semantics.
Different amounts immediately clear the displayed answer. Server reuse concerns validated metadata/read clients only; quote outputs are
fresh reads. Simulate independently obtains authoritative data and Review; the estimate carries no financial authority.
The deterministic hook timeline (0 ms calculating, 200 ms request, 280 ms ready with 80 ms mocked latency) is MOCKED evidence only.

### Six default-product failures

Original focused default-product profile: 70 passed / 6 failed. The full profile was not rerun. Final exact affected visual cases: 2/2 PASS.
The four unchanged legacy timeout cases reproduce their pre-existing missing-control failure with read-only panel diagnostics;
they remain failures, with no skip, assertion removal, timeout increase or production-routing change.

| # | Test | Classification | Evidence / resolution |
| --- | --- | --- | --- |
| 1 | visual-shell.spec.ts:5, Build shell visual baseline | EXPECTED_OWNER_APPROVED_VISUAL_CHANGE | Toolbar Transfer → Send (UX-005), individually inspected build baseline updated; PASS. |
| 2 | swap-authoring.spec.ts:115, proposal and blocked review snapshots show unquoted unavailable state | EXPECTED_OWNER_APPROVED_VISUAL_CHANGE | Centered confirmation replaces empty droplet/top-right artifact (UX-006), Send (UX-005). After proposal passed, the same case reached review-blocked.png: approved Quote unavailable (UX-007), Send and resulting existing card measurement/scale. Separately inspected/updated; wait for settled unavailable state; PASS. |
| 3 | cross-chain-liquidity.spec.ts:5, cross-chain canvas and chat author the same graph while MOCKED simulation cannot authorize Execute | TEST_PROFILE_ROUTING_ISSUE (pre-existing Phase 6) | Generate MOCKED chained simulation is absent: owner-wallet Arbitrum swap panel takes precedence. Retained/deferred. |
| 4 | cross-chain-liquidity-recovery.spec.ts:6, a MOCKED destination failure scenario cannot manufacture production completion, recovery or Evidence | TEST_PROFILE_ROUTING_ISSUE (pre-existing Phase 6) | Deterministic outcome is absent on the same incorrectly expected engineering composition surface. Retained/deferred. |
| 5 | build009.spec.ts:4, BUILD-009 passive wallet restoration and read-only quote cannot grant production execution | TEST_PROFILE_ROUTING_ISSUE (pre-existing Phase 6) | Absent legacy LI.FI quote button; times out before requesting a quote. Retained/deferred. |
| 6 | build009.spec.ts:63, BUILD-009 switches back to Base and invalidates quote on chain/account/provider change | TEST_PROFILE_ROUTING_ISSUE (pre-existing Phase 6) | Same absent button after wallet switch, before BRIDGE_QUOTED assertion. Retained/deferred. |

Phase 6 comparison: `git show ab5919842e036047047e614ebdb7176d06ba4aeb:<file>` proves byte-identical graph builders,
public-testnet-swap classifier/profiles, legacy panels, LI.FI reader, three specs and browser config. AppShell's route predicates and
complete engineering Simulate panel order are identical. The Phase 7 fresh-draft recovery guard does not affect these newly authored graphs.
The actual pure builders/classifier were executed in a temporary 3/3 passing probe: both graphs contain asset.swap.exact-input on
Arbitrum with the legacy lifi protocol; Arbitrum's catalog profile has referencePair=null, so ownerWalletSwapServes returns true.
publicPath is evaluated before crossChainWorkflow and bridgeSwapWorkflow. All four browser diagnostics show Arbitrum One swap simulation,
the gate-off message and no legacy controls. This is source/probe equivalence, not a second complete baseline application build.
**Phase 7 regression: NO.**

BUILD-009 / LI.FI: the legacy reader uses live read-only li.quest/v1/tokens and /v1/quote after explicit quoteBridge invocation.
That external dependency remains for later engineering-profile alignment; it did not cause these four failures because the quote click
never occurs. Focused mocked LI.FI normalization and BUILD-009 lifecycle tests pass; no public-provider availability/execution claim.

Visual baselines updated individually: visual-shell/build-chromium-linux.png; swap-authoring/proposal-chromium-linux.png;
swap-authoring/review-blocked-chromium-linux.png. Expected/actual/diff inspected, no bulk update, no unrelated screenshots.
The blocked-review image's scale follows existing initial measurement; no UX-008/009/010 behavior was introduced.

### Validation, blockers and scope

TESTS PASSED: final 12 focused Vitest files / 224 tests; changed test fixtures rechecked (27 tests, then final 12-test fixture recheck);
3 temporary baseline routing probes; 2 visual cases / 3 snapshots; lint on 53 code files and corrected-file rechecks;
strict pure authoring TypeScript including dependency declarations; governance-lite / 19 self-tests; git diff --check.
Inherited browser passes retained without blind reruns: authoring 11, execution 3, execution-continuity 3, Arbitrum certification 18,
Base 4, Robinhood 4, Copilot 13, canvas-automation-ux 18, review-execute-recovery-components 39, delegated-execution 3.
All financial evidence is MOCKED; no new public reads or real-money execution. Prior compile-only bundle reused for final visual/diagnostic runs.

TESTS FAILING: four classified baseline engineering-profile timeouts; broader scoped TypeScript has the known
robinhood-transfer-panel.tsx:83:103 TS2532 under the existing --skipLibCheck declaration limit. Without that flag, pre-existing bundled
Next declaration errors remain. The component, native-transfer profile union and arbitrum-chain.ts match Phase 2
861bb606dd073b3d83720cc8b1ee9cd254b9d063 byte-for-byte; TransferNetwork/map type definitions match too. The widened string network key
exposes the unchecked lookup. Record for Phase 8; no unrelated product/type fix here. Phase 7 test-only props/fixture typing corrected.

Files changed: preserved Phase 7A recipient/authoring/history, Canvas/header/proposal/CTA/result, shared estimate hook/server, Send copy,
focused tests/replay/profile registration, three inspected baselines and the three build docs. The handoff lists all 61 paths and commands.
next-env.d.ts has no diff, matches Phase 6 and is excluded; all diagnostics/results remain under /tmp. No Production config, dependency,
lockfile, secret or database changes; disposable PostgreSQL was not needed for this final pass.
UNAPPROVED UX CHANGES / PRODUCTION CHANGES / REAL-MONEY TRANSACTIONS: NONE. Gates not enabled. Full CI NOT RUN. No push/PR.

The remaining sections preserve the Phase 6 network certification record; their claims are scoped to that phase.

## Architecture

Network Registry + chain-bound Asset Registry + Capability Registry / canonical examples
→ shared canonical authoring → SemanticWorkflow IR → existing Simulate / Review / owner-wallet lifecycle.

Canvas builders, deterministic Chat, V2 natural-language Copilot and actual MCP `compose_strategy` use this path.
The model interprets language; deterministic registry resolution decides support, identities, amounts and proposals.
The owner applies an authoring proposal separately from financial Review and wallet approval.
No Arbitrum-specific authoring product, financial engine or Copilot support list was created.

Phases 1–5 supplied the network/catalog profiles, Swap/Transfer, existing Router routes, Uniswap liquidity mint and Aave profile.
Phase 6 narrowly aligns whole-name/symbol resolution, generates engine network/route labels from registries, completes MCP asset
catalog discovery, tightens ARB/chain-name grounding and prevents full/max lending or explicit unsupported fees becoming defaults.
Existing support text additionally describes the existing partial-only Aave amount policy from shared registry metadata.

## Capability certification matrix

Each row independently covers the shared execution registry, Canvas reducer/builder, exact Chat, direct natural intent engine,
actual MCP gateway, stable identities/IR/hash and the normal product Copilot applied to Canvas. Tests are MOCKED.

| Capability | Registry | Canvas | Chat | Copilot EN/PT | MCP compose | Stable IR/hash |
| --- | --- | --- | --- | --- | --- | --- |
| Swap | PASS | PASS | PASS | PASS | PASS | PASS |
| Native ETH Transfer | PASS | PASS | PASS | PASS | PASS | PASS |
| ERC-20 Transfer | PASS | PASS | PASS | PASS | PASS | PASS |
| Bridge Base → Arbitrum | PASS | PASS | PASS | PASS | PASS | PASS |
| Bridge Arbitrum → Base | PASS | PASS | PASS | PASS | PASS | PASS |
| Pool / Liquidity | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Supply | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Borrow | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Repay | PASS | PASS | PASS | PASS | PASS | PASS |
| Aave Withdraw | PASS | PASS | PASS | PASS | PASS | PASS |

- Swap: catalog ERC-20s through the existing Uniswap path; quotes and real pool availability still require fresh reads.
- Transfer: native ETH or a validated catalog ERC-20; explicit recipient or connected owner, with no new recipient control.
- Both certified Router directions: native Circle USDC only. Other established Router routes are retained, without new certification claims.
- Liquidity: one existing initialized Uniswap v3 pool/mint at a registered fee tier; no pool creation or new liquidity operation.
- Aave: native USDC only, variable debt mode 2, ordinary one-reserve accounts; bounded partial Repay/Withdraw.
  Existing deterministic health-factor minimum 2.0, state freshness, allowances, fee bounds and recovery remain authoritative.
  Phase 6 adds no risk calculation, reserve, approval policy, execution path or signing authority.

## Network, assets and unsupported variants

Arbitrum / Arbitrum One / explicit “ARB network” or “ARB rede” → `eip155:42161`.
Arbitrum Sepolia and Sepolia wording never become mainnet, even when a model guesses ARBITRUM.
ARB in asset context supplies no network. A network alias cannot ground an ARB token the user did not request;
a token named “Arbitrum” needs asset context and an independently named network.

All four surfaces resolve case-insensitive symbols and unambiguous whole catalog names through the same chain-local resolver.
Tests include USDC / USD Coin, WETH / Wrapped Ether, ARB / Arbitrum and WBTC / Wrapped BTC, decimals and exact identities.
Chat and MCP accept bounded whole catalog references and normalize them before canonical authoring; structured network IDs stay closed.
Canvas uses its existing catalog search/selection. Ambiguous names ask in Copilot and refuse composition elsewhere.
Base USDC cannot become Arbitrum USDC. Foreign tokens, excluded FLUX and unavailable listed assets fail closed.
MCP asset discovery now reads the loaded catalog rather than a separate pinned-only support list; without a source, only pinned assets
remain. Native ETH has a null contract address and Transfer membership only. Catalog membership grants no bridge/lending eligibility.

Refusal certification: native ETH/WETH/ARB/USDC.e on the Base ⇄ Arbitrum bridge; additional Aave reserves; full/max/all
Repay/Withdraw; mainnet lending composition; unsupported tiers and duplicate references to one pool asset.
Incomplete EN/PT liquidity requests ask for deposit amounts. The model cannot drop an explicit unsupported fee and substitute the default.
A missing pool is refused by the existing read preflight before simulation/Review/wallet calls; a pure authored CREATE2 address
cannot prove live pool existence. No unsupported pool/tier is substituted.
Normal product refusals use existing deterministic explanatory copy, without internal error-code text.

## Semantic and historical hash continuity

With the same initial workflow identity, Canvas / Chat / direct Copilot / actual MCP produce equal complete IR and raw workflow hashes
for all ten capabilities. Authoring source, interpretation notes and logos enter no financial semantic field.

**Product workspace exception:** `/app` creates a durable workspace UUID; standalone MCP composition uses `workflow-local`.
`workflowId` participates in the canonical hash and Review identity. These raw hashes correctly differ.
Browser tests preserve the UUID read before the proposal, compare every financial node/edge/revision/schema field, and verify the
complete hash with that same workspace identity. No production hash algorithm or identity is normalized away for the test.
Dynamic quotes were not compared or manufactured: this phase certifies the authoring layer before live quoting.

The frozen [baseline vectors](../../apps/reference-dapp/src/domain/arbitrum-hash-baseline.fixture.json) were independently computed
from archived Base HEAD `4df974f6ae6ae1d22b86f220db6281294cd20035`, with its own archived workflow-contracts, action-registry,
reference-linter and reference-compiler rebuilt under `/tmp`; only installed locked third-party dependencies were reused.
**All 33 historical canonical examples and seven additional Robinhood Stock Token scenarios retain their hashes (40 vectors).**
The published Base reference swap hash remains `0x747634a76aa445ec993325bbb638f4d5b5103d59267314b54d30db1bc79e3d49`.
No previously registered example was removed or changed.

## Normal Copilot / Canvas acceptance

One scoped Chromium 1243 spec on normal `/app`, production compiled code, committed V2 replay and a passive wallet:
**18 passed / 0 failed / 0 skipped**. No server action was substituted.

- All ten English capability requests (“Please …”) produce a visible AI-labelled canonical proposal, preserve revision 0 until Apply,
  then put the exact financial meaning in Canvas. Asset badges show the existing Arbitrum identity.
- Portuguese: “Por favor, troca 10 USDC por WETH na Arbitrum”; “Por favor, mande 0.01 ETH na Arbitrum para 0x333…333”;
  “Por favor, quero colocar 100 USDC no Aave da Arbitrum”. Each reaches the same Canvas financial meaning.
- Unsupported Aave WETH, full Repay, incomplete liquidity and unsupported 0.02% fee leave no proposal and revision 0.
- The existing generic network picker offers Arbitrum One, its USDC/WETH shortcuts and reviewed local network mark.
- Wallet methods are account/chain reads only. Browser network guard is clean; provider logos use closed local replay.

Replay proves the normal product interpretation/proposal/apply boundary deterministically. No live-model quality or real-funds execution
is claimed. Existing cosmetic liquidity-provider preview buttons do not author a different protocol; no component/layout/control was edited.

## Evidence, fees and deployment gates

Financial certification/regressions: **MOCKED**. Existing public deployment proofs remain **PUBLIC_READ_ONLY**;
no new mainnet reads or MAINNET_EXECUTED evidence in Phase 6. Prior deployments/reserve observations are in the discovery/handoff
and Phase 4/5 read proofs; runtime still verifies current identity/state before Review.

Reuse the established Nitro fee abstraction from Phases 2–5. No Base OP Stack fee assumptions or new fee policy.
Durable owner-wallet execution, reconciliation, nonce reservation and observation-only ambiguous recovery are retained.
MCP composition is supported; MCP itself cannot execute. Transfer simulation requires the owner browser; cloud preview/deployment/policy
availability remains separate from authoring support and is reported as such.

| Gate | Required opt-in | Phase 6 state |
| --- | --- | --- |
| `GRYLOO_ARBITRUM_MAINNET` | `live` | OFF / not set by this build |
| `GRYLOO_ARBITRUM_OWNER_EXECUTION` | `MAINNET_OWNER_APPROVED` | OFF / not set by this build |
| `GRYLOO_ROUTER` | `live` | OFF / not set by this build |
| `GRYLOO_ROUTER_OWNER_EXECUTION` | `MAINNET_OWNER_APPROVED` | OFF / not set by this build |

No Production/service/secret configuration, push, PR, real-money transaction, operator signer or custody change.

## Phase 6 focused validation (historical checkpoint)

**36 distinct Vitest files / 965 passed tests, no skips**, including the 105-test certification suite; 18 scoped browser cases;
strict pure authoring TypeScript including dependency declarations; strict broader source checking with the previously recorded
Next dependency declaration `--skipLibCheck` limit; lint on 30 changed/new code files; governance-lite / 19 self-tests; whitespace checks.
Exact file lists and commands are in the [handoff](BUILD-ARB-001-HANDOFF.md).
The app's compile-only bundle was built solely for the scoped browser prerequisite, not as final full-build/CI acceptance.
Sandbox font retrieval and loopback binding required local outside-sandbox reruns; fonts are read-only public downloads.
Final focused tests fail: **NONE**. No test was deleted, skipped or weakened; stale tables/corpus append the already implemented capabilities.

Phase 6 stopped at its local commit; Phase 7A subsequently completed the seven approved UX items documented above.
Current remaining scope is Phase 7B (UX-008/009/010), then separately directed Phase 8 integration/final CI. Neither starts automatically.
