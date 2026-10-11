# BUILD-ARB-001 Handoff

BASELINE: `4df974f6ae6ae1d22b86f220db6281294cd20035` (BUILD-BASE-001 / PR #81)
CURRENT HEAD: Phase 3 checkpoint, the commit containing this handoff. Resolve its exact SHA with `git log -1 --format=%H -- docs/builds/BUILD-ARB-001-HANDOFF.md`; parent is `861bb606dd073b3d83720cc8b1ee9cd254b9d063`.
CURRENT PHASE: Phase 3 complete — stop here. Branch: `codex/build-arb-001-network-ux`.
PHASE 2 STATUS: Recovered, completed and verified with focused checks. Mainnet deployment/owner-execution gates default off and were not configured by this build.

## Final Phase 3 checkpoint

COMPLETED:
- Read all three required build documents and inspected pwd/status/branch/HEAD/log/unstaged and staged diffs. Preserved another session's seven modified files and two untracked tests, and recorded their exact state below before further implementation. No previous phase was restarted.
- Both canonical native USDC routes: Base → Arbitrum One and Arbitrum One → Base. Base USDC `eip155:8453 / 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` and Arbitrum USDC `eip155:42161 / 0xaf88d065e77c8cc2239327c5edb3a432268e5831` remain separate assets with six decimals. No symbol-only routing, native ETH/WETH bridge or catalog/network expansion.
- Reused canonical `asset.bridge` IR, Router profiles/capabilities, provider normalization/codecs, compiler/artifact chain, owner Review, browser wallet boundary, source submission, existing append-only storage/leases/cloud worker projection, chain observation, Recover/Reconcile and Evidence. No new engine/provider/flow/gate or operator signer.
- Direct Across and LI.FI (Across protocol only) complete both mocked lifecycles. AUTO remains LI.FI first then direct Across only during discovery when the first quote is unavailable/refused; named providers never fall back. Selected-provider revalidation after Review never substitutes another route. Chain/address/amount/fees/spender/expiry mismatches fail closed; material changes clear authorization and require a fresh quote/Review.
- Review binds source/destination chains/assets, amount, owner/recipient/refund address, provider, route commitment, fees, output bounds, exact approvals/calls, expiry, gas/price/budget and observed nonce/state/implementations. Source deposit id/hash and destination proof are stored durably for reconciliation. Approval is exact-input USDC to the verified Diamond or source SpokePool. Connected owner wallet is the only submission point; server/worker read transports cannot sign/send.
- Shared fee fixes preserve the reviewed max price, re-estimate the exact current call before preparation and handoff, enforce per-call Base L1 bounds and check direct receipt nonce, offered gas/max fee/priority, gas used and paid fees. Policy/Manifest/Quote gas budgets include total source-chain fee bounds; provider USDC fees remain separate from native ETH gas.
- Arbitrum-specific code is confined to the existing service's Nitro fee branch. It combines source sequence simulation with NodeInterface posting-gas estimates and a 150% gas margin, then verifies standard total-gas estimates at preparation/handoff. Uses 2× `eth_gasPrice`, zero priority and `gasUsed × effectiveGasPrice` receipts. No OP Stack GasPriceOracle or extra `l1Fee` applies. The [official NodeInterface ABI](https://raw.githubusercontent.com/OffchainLabs/nitro-contracts/main/src/node-interface/NodeInterface.sol) and [gas documentation](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees) were checked; selector independently computed as `0x77d488a2`. Malformed posting estimates fail closed. No live transaction or runtime availability proof is inferred from these sources.
- Recovery: PREPARED → AUTHORIZED → SOURCE_SUBMITTED → SOURCE_CONFIRMED → IN_FLIGHT → DESTINATION_OBSERVED → RECONCILED, with UNKNOWN attempt state, RECOVERY_REQUIRED, FAILED, RECONCILIATION_REQUIRED/DIVERGENT and REFUNDED branches. Workers only observe; PREPARED stays outside automatic observation while browser handoff is open.
- Source recovery now scans bounded windows with durable safe-block cursors and timestamp-based eligibility, without Base's block interval or a 4,000-block lifetime cap. Proven absence requires complete scanning and safe-head expiry. Ambiguous submission cannot resend in this run or another owner run; a restarted service finds the original effect, including relayed owner-wallet effects beyond 4,000 quarter-second blocks.
- Destination scanning uses safe blocks. Provider outages stay recoverable, delayed delivery stays pending, and refund recovery continues checking fill proofs. `DESTINATION_OBSERVED` is persisted before evidence reads, preserving restart recovery. Wrong asset/recipient, duplicate fill and out-of-bounds amounts become DIVERGENT without success evidence; another origin's fill never proves delivery. Both directions reconcile idempotently only after source/destination safe-head checks.
- Four owner-supplied 100 USDC EN/PT requests pass Canvas builder / deterministic Chat parsing the exact original text / deterministic intent-provider Copilot / actual MCP gateway IR and hash parity. Added shared closed-grammar Move and manda/traga aliases with existing canonical pair checks; no Copilot prompt/list/layout or Canvas change. Natural-language engine handling is also tested directly so deterministic shortcuts cannot hide it. Four existing Copilot corpus probes now say “Please move” to preserve their required model, clarification, adversarial and race checks after Move becomes an exact command; their assertions remain intact.

VALIDATION:
- Final Router/authoring/Copilot suite: **14 files / 365 tests passed**. Focused Base/Robinhood/Arbitrum Phase 2 regressions: **14 files / 245 tests passed**. Total **28 files / 610 tests**, no skips. Both directions also recover from evidence-read interruption after durable destination observation. All financial lifecycle evidence is **MOCKED**; no MAINNET_EXECUTED certification.
- Strict TypeScript passes for the Router runtime/core/authoring graph, including dependency declarations. The broader server-action graph passes strict source checking with `--skipLibCheck`. Unfiltered broader declaration checking still reaches existing Next bundled webpack/React-server/URLPattern declaration errors, as in Phase 2. Repository configuration and dependencies were not changed to hide this issue; final CI remains separately authorized.
- ESLint passes all twelve changed TypeScript files. Governance-lite passes and all **19** self-tests pass. `git diff --check` passes. Package dependency builds pass strict checking; no full app build or full CI.
- During iteration, additional adversarial tests failed for unsafe source cursor advancement, over-bound destination output and the Base per-call fee budget. Fixed shared runtime behavior; corrected the fee test's injected value to exceed the actual per-call fixture bound. A readonly authoring-test type mismatch and unused local were corrected. Governance self-tests initially used an incompatible module invocation; the script's direct invocation passes. No test removed/skipped/weakened.

CHANGED FILES (complete Phase 3 scope):
- Runtime/shared contracts/compiler: `apps/reference-dapp/src/server/router-service.ts`, `apps/reference-dapp/src/server/router-runtime.ts`, `packages/reference-compiler/src/crosschain-router.ts`, `packages/workflow-contracts/src/router.ts`.
- Authored tests/harness: `apps/reference-dapp/e2e/router-harness.ts`, `apps/reference-dapp/src/server/router-service.test.ts`, `apps/reference-dapp/src/server/router-arbitrum-certification.test.ts` (new), `apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts` (new).
- Shared authoring/affected model probes (assertions preserved): `apps/reference-dapp/src/domain/router-authoring.ts`, `apps/reference-dapp/src/domain/router-authoring.test.ts`, `apps/reference-dapp/src/domain/copilot-eval.corpus.ts`, `apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts`. The Robinhood Move probe also uses “Please move” to retain natural-language intent coverage.
- Docs: this handoff and `docs/builds/BUILD-ARB-001-PLAN.md`.

DEPLOYMENT / LIMITS:
- Existing `GRYLOO_ROUTER=live` and `GRYLOO_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` gates cover both mainnet directions. Neither enabled/configured; no new variable or Arbitrum bridge gate. Object-injected test configurations do not change any deployment.
- UX changes: NONE. Production changes: NONE. Real-money transactions: NONE. Push / PR: NONE. Full pnpm check / browser / fork / PostgreSQL / live-model / public execution: NOT RUN, outside this phase.
- No temporary/generated file is added to the repository; new certification test directories self-clean under /tmp. Ignored dependency build artifacts are retained for package imports.
- No outstanding Phase 3 implementation/test failure. The existing broader Next declaration issue remains for final CI. MOCKED parity does not prove live-model behavior or public owner execution.
- Phase 4 blockers: separate owner authorization and fresh Pool/Liquidity deployment/pool verification are required. No Phase 4 implementation has started.
- NEXT EXACT ACTION: stop at the Phase 3 commit. Do not push/open a PR or execute Phase 4. Recommended next authorized scope: shared Pool/Liquidity. At resumption read the build docs and inspect pwd/status/branch/HEAD/log/diffs, preserving any intervening work.

## Reproducible Phase 3 focused validation

Dependency exports only (no full app build):

```sh
pnpm --filter @defi-workflow-engine/reference-linter... build
pnpm --filter @defi-workflow-engine/reference-compiler build
pnpm --filter @defi-workflow-engine/reference-executor build
pnpm --filter @defi-workflow-engine/reference-reconciler build
pnpm --filter @defi-workflow-engine/cloud-runtime build
```

Router/authoring/Copilot certification (**365 tests**):

```sh
pnpm exec vitest run \
  packages/workflow-contracts/test/router.test.ts \
  packages/action-registry/test/crosschain-router.test.ts \
  packages/reference-compiler/test/crosschain-router.test.ts \
  packages/reference-linter/test/crosschain-router.test.ts \
  apps/reference-dapp/src/server/router-providers.test.ts \
  apps/reference-dapp/src/server/router-service.test.ts \
  apps/reference-dapp/src/server/router-runtime.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-base.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-certification.test.ts \
  apps/reference-dapp/src/server/router-robinhood.test.ts \
  apps/reference-dapp/src/server/router-testnet.test.ts \
  apps/reference-dapp/src/domain/router-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts \
  apps/reference-dapp/src/domain/copilot-eval.test.ts --maxWorkers=4
```

Focused regressions (**245 tests**):

```sh
pnpm exec vitest run \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/base-network.test.ts \
  packages/action-registry/test/robinhood-chain.test.ts \
  packages/action-registry/test/execution-capabilities.test.ts \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/server/base-mainnet.test.ts \
  apps/reference-dapp/src/server/robinhood-swap.test.ts \
  apps/reference-dapp/src/server/robinhood-transfer-service.test.ts \
  apps/reference-dapp/src/state/review-authorization.test.ts \
  apps/reference-dapp/src/state/execution-start.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  apps/reference-dapp/src/domain/execution-recovery.test.ts --maxWorkers=4
```

Strict runtime/core/authoring TypeScript (declarations checked):

```sh
pnpm exec tsc --noEmit --strict --target ES2024 --module ESNext \
  --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule \
  --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/server/router-service.ts \
  apps/reference-dapp/src/server/router-runtime.ts \
  apps/reference-dapp/src/server/router-service.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-certification.test.ts \
  apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts \
  apps/reference-dapp/src/domain/router-authoring.test.ts \
  apps/reference-dapp/src/domain/copilot-eval.test.ts
```

The same command with `--skipLibCheck` and `apps/reference-dapp/src/app/router-action.ts` additionally checks the broader server-action source graph. Omitting `--skipLibCheck` on that broader graph exposes the existing bundled declaration errors described above.

```sh
pnpm exec eslint \
  apps/reference-dapp/e2e/router-harness.ts \
  apps/reference-dapp/src/server/router-runtime.ts \
  apps/reference-dapp/src/server/router-service.ts \
  apps/reference-dapp/src/server/router-service.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-certification.test.ts \
  apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts \
  apps/reference-dapp/src/domain/router-authoring.ts \
  apps/reference-dapp/src/domain/router-authoring.test.ts \
  apps/reference-dapp/src/domain/copilot-eval.corpus.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  packages/reference-compiler/src/crosschain-router.ts \
  packages/workflow-contracts/src/router.ts
python3 scripts/governance_lite.py
python3 scripts/test_governance_lite.py
git diff --check
```

## Archived Phase 3 starting trace (before implementation; superseded by final checkpoint)

Starting state: clean, expected branch and exact Phase 2 HEAD verified. Required ARB discovery/plan/handoff, BASE network integration report, ENVIRONMENT.md and repository instructions read.

ALREADY PRESENT:
- `workflow-contracts/router-pairs.ts` + `router.ts`: both exact chain/address-bound USDC pairs, canonical `asset.bridge` IR, provider preference, route commitments/comparison and cross-chain phases.
- `action-registry/crosschain-router.ts`: Base → Arbitrum and BUILD-BASE-001 Arbitrum → Base profiles, contract pins, shared capability authority; no new pair is needed.
- Shared `domain/router-authoring.ts`, editor, strategy engine/examples, registry-driven Copilot and MCP composition already author both routes. Existing Router store/action and backend flow enforce signed-in owner ownership and the connected wallet boundary.
- `server/router-providers.ts`: LI.FI Across-only calldata decoder + direct Across decoder, canonical fee/amount/recipient/refund/spender validation, no provider signing. AUTO prefers LI.FI then Across when an allowed quote is unavailable/refused during discovery. Explicit provider allows no fallback. Begin revalidates the selected provider only, never switches after Review.
- `server/router-service.ts`: exact approval + deposit sequence simulation, compiled route-bound artifacts/Manifest, owner Review, append-only durable storage/leases, nonce/deposit guards, source receipt/deposit identity, independent destination FilledRelay + token Transfer proof, safe-head finality, refund recovery and MOCKED/public evidence separation.
- `server/router-runtime.ts`, `app/router-action.ts`, `state/router-store.tsx`, `backend/flows.ts`: independent source/destination RPC methods, cloud/local route namespaces and existing Router gates. Workers observe only and never submit.

PHASE 3 MUST ADD / AUDIT GAPS:
- Explicit two-direction lifecycle, negative identity/provider/fees/spender, restart/ambiguity/delay/divergence/idempotence and actual MCP/Canvas/Chat/EN/PT Copilot parity coverage; reuse existing tests/harness.
- Source transaction fees currently budget from eth_simulateV1 gasUsed. Nitro posting gas needs an explicit reviewed bound and standard exact-call re-estimation at preparation/handoff; do not copy Base's OP Stack oracle. Base's L1 bound must also be in the Manifest gas budget and checked before handoff.
- Begin currently recomputes offered gas price without enforcing the reviewed ceiling; receipt offered/paid bounds need verification. These are shared Router correctness fixes.
- Source deposit discovery currently assumes two-second blocks/caps the scan; verify time-bounded recovery on Arbitrum's faster chain. Destination RECOVERY_REQUIRED currently stops checking for fill proofs; audit delayed observation and safe-head deadline handling.
- PREPARED attempts can be explicitly observed/cancelled before wallet handoff, but workers do not automatically observe them. Preserve the durable handoff rule; do not introduce a worker race with an open browser preparation.

CONTINUATION CHECKPOINT (2026-10-11, before further implementation):
- Exact HEAD remains `861bb606dd073b3d83720cc8b1ee9cd254b9d063`, branch `codex/build-arb-001-network-ux`; index empty. Another session already started Phase 3. All existing edits are preserved.
- Seven tracked dirty files: `apps/reference-dapp/e2e/router-harness.ts`, `apps/reference-dapp/src/server/router-runtime.ts`, `apps/reference-dapp/src/server/router-service.test.ts`, `apps/reference-dapp/src/server/router-service.ts`, this handoff, `packages/reference-compiler/src/crosschain-router.ts`, `packages/workflow-contracts/src/router.ts`.
- Two untracked authored tests: `apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts`, `apps/reference-dapp/src/server/router-arbitrum-certification.test.ts`.
- Existing edits add Nitro posting-gas Review bounds, exact-call fee preflights, Manifest total gas budget, receipt bounds, timestamp-based durable source scanning, safe-head absence/destination scanning and late destination proof recovery. Existing tests cover two-direction lifecycle and four authoring requests. These changes are under audit, not yet certified by this continuation.
- Before Phase 3, Base → Arbitrum shipped in BUILD-ROUTER-001. BUILD-BASE-001 added the reverse canonical pair/profile, runtime namespace/cloud flow and registry-derived authoring under the same gates. No new pair/provider/engine is required.

IN PROGRESS: Audit preserved Phase 3 code/tests and run focused validation.
REMAINING: Correct demonstrated gaps, focused checks, final handoff/plan and Phase 3 commit. No later-phase work.
TESTS PASSED: current branch/HEAD/status/diffs inspected; implementation checks pending in this continuation.
TESTS FAILING: none established yet; prior session test results are not inferred.

PROVIDER / ROUTE POLICY: Existing AUTO = [lifi, across], Across protocol only; named-provider policies are single-provider. Both exact USDC addresses stay distinct by chain. No ETH/WETH/arbitrary-token or additional-network expansion.
RECOVERY MODEL: PREPARED → AUTHORIZED → SOURCE_SUBMITTED → SOURCE_CONFIRMED → IN_FLIGHT → DESTINATION_OBSERVED → RECONCILED, with RECONCILIATION_REQUIRED/DIVERGENT, RECOVERY_REQUIRED, REFUNDED and FAILED branches. Source submission alone is never success; provider statuses are hints only.
DEPLOYMENT GATES: `GRYLOO_ROUTER=live` and `GRYLOO_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED` cover both mainnet directions. Neither configured/enabled. No Arbitrum bridge-specific gate.
OWNER-APPROVED UX CHANGES: none yet.
DO NOT REDO: profiles, engine, provider UX, Phase 1/2 catalog/swap/transfer work. No Pool/Aave/UX/testnet expansion/full CI/push/PR/Production changes or real-money transaction.
NEXT EXACT ACTION: Complete the Nitro/source fee and delayed-recovery audit, add focused failing tests for confirmed gaps, then implement narrow shared Router fixes.

## Archived final Phase 2 checkpoint

COMPLETED:
- Recovered all 41 dirty tracked files and six untracked build files without reset/clean/stash/discard/checkout/rebase/revert or recreation. Preserved the implementation and wrote the recovery checkpoint below before continuing.
- Live Arbitrum catalog runtime on the shared chain-bound provider/parser/loader. Exact chain/address/decimals, deterministic duplicate rejection, FLUX exclusion, generic trusted logos and fail-closed provider expiry/failure. Base catalog fixtures/regressions pass. No downloaded list snapshot committed.
- Arbitrum swap-only Uniswap profile through the shared quote/execution service; exact owner/chain/nonce/call/gas/budget Review, stale-state invalidation, exact-input approvals and fresh Review before the swap. Deadline calldata now reuses the existing compiler ABI encoder.
- Native ETH and direct ERC-20 transfers through the existing compiler, owner-wallet coordinator, durable stores and reconciler. Token transfers use transfer(recipient, amount) without approval; native sends use value plus empty calldata. Existing recipient authoring retained.
- Nitro fee verification: official docs checked during recovery confirm posting cost inside standard gas estimates. Arbitrum uses receipt gasUsed × effectiveGasPrice with no OP Stack oracle/separate l1Fee. Exact-call gas is bounded at Review and re-estimated before preparation/handoff. Public verification facts remain in PHASE-2-READ-VERIFICATION.json; mocked tests are not mainnet execution.
- Owner-bound swap preparation and recovery in existing browser stores/server actions, cloud flow registration and worker projection. PREPARED/UNKNOWN recovery discovers the nonce transaction; no blind resend. A successful receipt with unfinished balance reads stays under observation. Proven mismatches persist as divergence and cannot revive Review or look reconciled.
- A proven wallet rejection permits only an explicit identical transaction in the same run, after fresh nonce/preflight checks; another run cannot take that reservation. Transfers retain their established proven-refusal recovery flow.
- Canvas builders, deterministic Chat, deterministic EN/PT Copilot intent provider, channel conversion and actual MCP gateway compose parity. Capability wording derives from registries; no hand-written Copilot list.
- Focused Base/Robinhood, catalog, compiler/contracts, lifecycle, browser-store and cloud startup regressions. No redesign, Transfer To field, saved wallet, picker/modal/card/layout change, new Bridge/Pool/Aave runtime, testnet expansion, Production change, push or PR.

PARTIAL:
- None within the authorized Phase 2 implementation.

NOT STARTED:
- Owner mainnet execution or MAINNET_EXECUTED certification, live-model Copilot acceptance, browser/fork/PostgreSQL acceptance matrix and full CI. These evidence/validation levels are not claimed here.
- Later Bridge, Pool/Liquidity, Aave/Lending, UX and deployment phases require separate owner scope. Do not continue them automatically.

FILES TOUCHED:
- The classified table below contains every Phase 2 file, including recovered and continuation work.

UNCOMMITTED FILES:
- None after the phase-ending commit; verify `git status --short` at resumption. The table represents the committed build work, not permission to discard later changes.

TESTS ALREADY PRESENT:
- Reused the recovered Arbitrum runtime/authoring/core/catalog suites; extended existing lifecycle/Review/browser tests only for confirmed gaps. Added no duplicate swap/transfer engine or harness gate.

TESTS PASSED:
- Node 24.21.0 / pnpm 11.22.0. Dependency exports rebuilt: reference-linter... (contracts + registry + linter), compiler, executor, reconciler, cloud-runtime; strict package builds passed.
- Final focused Vitest: **30 files / 673 tests passed**. Backend plain-Node startup: **1 file / 2 tests passed** outside the sandbox. Total **675 focused Vitest tests**, no skips. After the final test-only type annotation, the affected browser-store suite passed again (7 tests).
- Strict scoped TypeScript for the runtime/core/authoring and server-action graph passed with dependency declarations checked. The larger hook-test graph also passed strict source checking with `--skipLibCheck` (see limitations below).
- ESLint passed on all **55 changed TypeScript files**; final type-only test adjustment linted again. Governance-lite passed, its **19** self-tests passed, and `git diff --check` passed.

TESTS FAILING:
- No remaining implementation or focused Vitest failure.
- Unfiltered hook-graph declaration checking reaches existing Next bundled declaration problems (URLPatternInput/URLPatternOptions; without next-env also webpack/React server declarations). Source-only strict checking passed with `--skipLibCheck`; repository configuration/dependencies were not changed or weakened. Reassess declaration checks during the separately authorized final CI phase.
- Sandbox-only backend startup failures were diagnosed as empty nested-process stdout, reproduced with console.log(123), and resolved by running that focused suite outside the sandbox. No test was skipped or weakened.

TESTS NOT YET RUN:
- Full CI, complete Next build, browser, fork/Anvil, PostgreSQL/cloud remote, public financial execution and live-model suites, intentionally outside this phase.

ARCHITECTURAL DECISIONS:
- `eip155:42161` / chainId 42161 is MAINNET / REAL_FUNDS. The existing Base/Robinhood architecture is shared; Arbitrum supplies only profiles and narrow generic options.
- `GRYLOO_ARBITRUM_MAINNET=live` enables catalog/read simulation/Review; owner-wallet preparation additionally requires `GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`. Neither was configured or enabled by this build. Router gates are independent; no Arbitrum harness bypass. Hosted execution uses existing durable cloud storage.
- No signer/key/custody in server RPC; connected owner wallet remains the only submission boundary. All automated lifecycles are MOCKED.
- Direct token transfers have no approval. Native contract recipients bind/revalidate code and reconcile the exact owner debit; receive/fallback effects are possible, and retained recipient balance is not claimed.
- Nitro needs no separate fee adapter: posting gas is already included in estimate/receipt handling. Review bounds remain observations, not a future fee guarantee. L2 receipt inclusion is not L1 finality.
- Strict owner-bound swap Review is a generic profile option enabled for Arbitrum. Existing Base/Robinhood quote paths remain under their current profiles and have focused regression coverage.

DISCOVERIES / IMPORTANT FACTS:
- The recovered handoff was stale while the plan already described substantial implementation. Code/tests, not the old text, established the recovery point.
- Continuation fixed hashless browser recovery, same-run rejection nonce reuse, final-preflight nonce drift, owner binding, persisted divergence and the receipt-before-balance-read crash window.
- The existing ABI module already encoded the deadline multicall. Reused it instead of retaining a duplicate recovered encoder.
- Shared workflow hashes and public-read contract/source facts are in PLAN.md and PHASE-2-READ-VERIFICATION.json. Fixtures are independently authored, not upstream list snapshots.

OWNER-APPROVED UX CHANGES:
- none yet

DO NOT REDO:
- Do not discard or restart recovered Phase 2. Do not duplicate the parser/provider, runtime engines, durable services or tests.
- Do not rerun full discovery or public deployment verification without a concrete discrepancy. Run focused affected checks after actual changes; full CI belongs to the final authorized phase.
- Do not enable gates, touch Production variables, sign/send real funds automatically, push/open a PR or start later phases from this checkpoint.
- Do not add the Transfer To field, saved wallets or any layout/picker/modal/card redesign. All new behavior here is shared runtime/lifecycle correctness.

NEXT EXACT ACTION:
- Stop at the Phase 2 commit. At the next owner-authorized phase, run pwd/status/branch/HEAD/log/diffs, inspect any new dirty/untracked files, and read this handoff plus DISCOVERY.md and PLAN.md. Await explicit next-phase scope; the plan proposes Bridge next but grants no authorization.

| Classification | Phase 2 file |
| --- | --- |
| TEST-ONLY | `apps/reference-dapp/backend/entrypoint.test.ts` |
| COMPLETE | `apps/reference-dapp/backend/flows.ts` |
| COMPLETE | `apps/reference-dapp/backend/preview.ts` |
| COMPLETE | `apps/reference-dapp/src/app/public-testnet-action.ts` |
| COMPLETE | `apps/reference-dapp/src/app/uniswap-liquidity-action.ts` |
| COMPLETE | `apps/reference-dapp/src/channels/core/strategy.ts` |
| TEST-ONLY | `apps/reference-dapp/src/domain/arbitrum-authoring.test.ts` |
| TEST-ONLY | `apps/reference-dapp/src/domain/arbitrum-core.test.ts` |
| TEST-ONLY | `apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/catalog-swap-authoring.ts` |
| TEST-ONLY | `apps/reference-dapp/src/domain/copilot-eval.corpus.ts` |
| TEST-ONLY | `apps/reference-dapp/src/domain/crypto-action-picker.test.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/crypto-action-picker.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/execution-lifecycle.ts` |
| TEST-ONLY | `apps/reference-dapp/src/domain/execution-recovery.test.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/execution-recovery.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/public-testnet-swap.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/robinhood-transfer-authoring.ts` |
| COMPLETE | `apps/reference-dapp/src/domain/simulation-presentation.ts` |
| COMPLETE | `apps/reference-dapp/src/engine/capability-catalog.ts` |
| COMPLETE | `apps/reference-dapp/src/engine/strategy-examples.ts` |
| COMPLETE | `apps/reference-dapp/src/engine/strategy-spec.ts` |
| COMPLETE | `apps/reference-dapp/src/mcp/simulation.ts` |
| COMPLETE | `apps/reference-dapp/src/mcp/tools.ts` |
| COMPLETE | `apps/reference-dapp/src/server/arbitrum-mainnet.ts` |
| TEST-ONLY | `apps/reference-dapp/src/server/arbitrum-runtime.test.ts` |
| COMPLETE | `apps/reference-dapp/src/server/authoring-catalogs.ts` |
| COMPLETE | `apps/reference-dapp/src/server/base-mainnet.ts` |
| COMPLETE | `apps/reference-dapp/src/server/catalog-networks.ts` |
| COMPLETE | `apps/reference-dapp/src/server/evm-catalog-runtime.ts` |
| COMPLETE | `apps/reference-dapp/src/server/public-testnet-service.ts` |
| TEST-ONLY | `apps/reference-dapp/src/server/robinhood-mainnet.test-harness.ts` |
| TEST-ONLY | `apps/reference-dapp/src/server/robinhood-swap.test.ts` |
| COMPLETE | `apps/reference-dapp/src/server/robinhood-transfer-service.ts` |
| COMPLETE | `apps/reference-dapp/src/state/asset-catalog-store.ts` |
| TEST-ONLY | `apps/reference-dapp/src/state/execution-start.test.ts` |
| COMPLETE | `apps/reference-dapp/src/state/execution-start.ts` |
| TEST-ONLY | `apps/reference-dapp/src/state/public-testnet-store.test.tsx` |
| COMPLETE | `apps/reference-dapp/src/state/public-testnet-store.tsx` |
| TEST-ONLY | `apps/reference-dapp/src/state/review-authorization.test.ts` |
| COMPLETE | `apps/reference-dapp/src/state/review-authorization.ts` |
| COMPLETE | `apps/reference-dapp/src/state/robinhood-transfer-store.tsx` |
| DOC/HANDOFF | `docs/builds/BUILD-ARB-001-HANDOFF.md` |
| DOC/HANDOFF | `docs/builds/BUILD-ARB-001-PHASE-2-READ-VERIFICATION.json` |
| DOC/HANDOFF | `docs/builds/BUILD-ARB-001-PLAN.md` |
| COMPLETE | `packages/action-registry/src/arbitrum-chain.ts` |
| COMPLETE | `packages/action-registry/src/capability-discovery.ts` |
| COMPLETE | `packages/action-registry/src/execution-capabilities.ts` |
| COMPLETE | `packages/action-registry/src/index.ts` |
| COMPLETE | `packages/action-registry/src/native-transfer.ts` |
| COMPLETE | `packages/action-registry/src/uniswap-v3-arbitrum.ts` |
| TEST-ONLY | `packages/action-registry/test/arbitrum-network.test.ts` |
| COMPLETE | `packages/reference-compiler/src/native-transfer.ts` |
| COMPLETE | `packages/reference-executor/src/native-transfer.ts` |
| COMPLETE | `packages/reference-linter/src/catalog-swap.ts` |
| COMPLETE | `packages/reference-reconciler/src/native-transfer.ts` |
| COMPLETE | `packages/workflow-contracts/src/catalog-swap.ts` |
| TEST-ONLY | `packages/workflow-contracts/test/catalog-swap.test.ts` |

TEMPORARY / GENERATED: None tracked or newly added. Ignored dependency artifacts are retained.

## Reproducible focused validation

Dependency builds (no full app build):

```sh
pnpm --filter @defi-workflow-engine/reference-linter... build
pnpm --filter @defi-workflow-engine/reference-compiler build
pnpm --filter @defi-workflow-engine/reference-executor build
pnpm --filter @defi-workflow-engine/reference-reconciler build
pnpm --filter @defi-workflow-engine/cloud-runtime build
```

Final 30-file focused Vitest run:

```sh
pnpm exec vitest run \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/base-network.test.ts \
  packages/action-registry/test/robinhood-chain.test.ts \
  packages/action-registry/test/asset-logos.test.ts \
  packages/action-registry/test/asset-registry.test.ts \
  packages/action-registry/test/execution-capabilities.test.ts \
  packages/workflow-contracts/test/catalog-swap.test.ts \
  packages/workflow-contracts/test/native-transfer.test.ts \
  packages/reference-linter/test/native-transfer.test.ts \
  packages/reference-reconciler/test/native-transfer.test.ts \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/server/base-mainnet.test.ts \
  apps/reference-dapp/src/server/robinhood-swap.test.ts \
  apps/reference-dapp/src/server/robinhood-transfer-mainnet.test.ts \
  apps/reference-dapp/src/server/robinhood-transfer-service.test.ts \
  apps/reference-dapp/src/server/public-testnet-service.test.ts \
  apps/reference-dapp/src/state/public-testnet-store.test.tsx \
  apps/reference-dapp/src/state/review-authorization.test.ts \
  apps/reference-dapp/src/state/execution-start.test.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/crypto-action-picker.test.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  apps/reference-dapp/src/domain/copilot-eval.test.ts \
  apps/reference-dapp/src/domain/execution-lifecycle.test.ts \
  apps/reference-dapp/src/domain/execution-recovery.test.ts \
  apps/reference-dapp/src/domain/simulation-presentation.test.ts \
  apps/reference-dapp/src/engine/capability-catalog.test.ts \
  apps/reference-dapp/src/mcp/simulation.test.ts \
  apps/reference-dapp/backend/preview.test.ts --maxWorkers=2
pnpm exec vitest run apps/reference-dapp/backend/entrypoint.test.ts --maxWorkers=1
```

The entrypoint command requires working nested-process stdout (the recovery sandbox did not provide it).
Core strict declaration check used:

```sh
pnpm exec tsc --noEmit --target ES2024 --lib ES2024,DOM,DOM.Iterable \
  --module ESNext --moduleResolution Bundler --jsx react-jsx --strict \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop \
  --resolveJsonModule --allowImportingTsExtensions --types node \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/state/public-testnet-store.tsx \
  apps/reference-dapp/src/app/public-testnet-action.ts \
  apps/reference-dapp/src/app/uniswap-liquidity-action.ts \
  apps/reference-dapp/src/state/robinhood-transfer-store.tsx \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/workflow-contracts/test/catalog-swap.test.ts
```

The hook-test check used those same flags plus `--skipLibCheck` and additionally:
`src/state/public-testnet-store.test.tsx`, `src/state/review-authorization.test.ts`,
`src/state/execution-start.test.ts` and `src/domain/execution-recovery.test.ts` under `apps/reference-dapp`.
No typecheck configuration file changed. ESLint received every changed/new `.ts`/`.tsx` path compared with Phase 1.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/governance_lite.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p test_governance_lite.py
git diff --check
```

## Archived recovery checkpoint (before final fixes/checks)

COMPLETED:
- Reconstructed pwd, status, branch, HEAD, recent history, working/staged diffs and all six untracked files without resetting, cleaning, stashing or replacing build work. Staged diff is empty.
- Recovered shared `createEvmCatalogRuntime`, Base wrapper extraction, Arbitrum live loader/gates and server/cloud catalog-network registration.
- Recovered swap-only Uniswap deployment/profile, native/token transfer profile, namespaces, authoring maps, strategy contract, examples and MCP/channel wiring. No liquidity/Aave profile is activated.
- Recovered public read evidence at block 513943961 and existing focused catalog/runtime/authoring tests; no downloaded token-list snapshot.

PARTIAL:
- Shared owner-bound swap Review, permanent nonce reservations, PREPARED/UNKNOWN nonce recovery and receipt bounds exist; audit callers, immutable history and retries before declaring complete.
- Transfers include exact direct ERC-20 calls, catalog/code/decimals revalidation, Nitro re-estimation and recipient-code commitments; verify compiler/service/reconciler lifecycle and existing Base/Robinhood behavior.
- Canvas/Chat/Copilot/MCP parity tests exist; execution through browser stores/server actions and cloud workers still needs focused validation.
- All Phase 2 test, strict typecheck and lint results are unknown in this recovery session. Do not infer passes from the plan.

NOT STARTED:
- Final Phase 2 checkpoint commit.
- Later phases: Bridge, Pool/Liquidity, Aave/Lending, UX, testnet expansion, full CI, PR/push and Production configuration. These remain outside this phase.

FILES TOUCHED / UNCOMMITTED FILES (recovery classification; COMPLETE means implementation present, validation still pending):

| Classification | Files |
| --- | --- |
| COMPLETE | `apps/reference-dapp/backend/flows.ts`; `backend/preview.ts` |
| COMPLETE | `apps/reference-dapp/src/app/public-testnet-action.ts`; `src/app/uniswap-liquidity-action.ts` (unsupported-network guard only) |
| COMPLETE | `apps/reference-dapp/src/channels/core/strategy.ts`; `src/domain/catalog-swap-authoring.ts`; `src/domain/crypto-action-picker.ts`; `src/domain/public-testnet-swap.ts`; `src/domain/robinhood-transfer-authoring.ts` |
| COMPLETE | `apps/reference-dapp/src/engine/capability-catalog.ts`; `src/engine/strategy-examples.ts`; `src/engine/strategy-spec.ts`; `src/mcp/simulation.ts`; `src/mcp/tools.ts` |
| COMPLETE | `apps/reference-dapp/src/server/authoring-catalogs.ts`; `src/server/base-mainnet.ts`; `src/server/catalog-networks.ts`; **new** `src/server/arbitrum-mainnet.ts`; **new** `src/server/evm-catalog-runtime.ts` |
| COMPLETE | `apps/reference-dapp/src/state/asset-catalog-store.ts`; `src/state/robinhood-transfer-store.tsx` |
| COMPLETE | `packages/action-registry/src/arbitrum-chain.ts`; `src/capability-discovery.ts`; `src/execution-capabilities.ts`; `src/index.ts`; `src/native-transfer.ts`; **new** `src/uniswap-v3-arbitrum.ts` |
| COMPLETE | `packages/reference-executor/src/native-transfer.ts`; `packages/reference-linter/src/catalog-swap.ts`; `packages/workflow-contracts/src/catalog-swap.ts` |
| PARTIAL | `apps/reference-dapp/src/server/public-testnet-service.ts`; `src/server/robinhood-transfer-service.ts`; `src/state/public-testnet-store.tsx`; `packages/reference-compiler/src/native-transfer.ts`; `packages/reference-reconciler/src/native-transfer.ts` |
| TEST-ONLY | **new** `apps/reference-dapp/src/domain/arbitrum-authoring.test.ts`; **new** `src/server/arbitrum-runtime.test.ts`; `src/domain/arbitrum-core.test.ts`; `src/domain/catalog-copilot-parity.test.ts`; `src/domain/copilot-eval.corpus.ts`; `src/domain/crypto-action-picker.test.ts`; `src/server/robinhood-mainnet.test-harness.ts`; `src/server/robinhood-swap.test.ts` |
| TEST-ONLY | `packages/action-registry/test/arbitrum-network.test.ts`; `packages/workflow-contracts/test/catalog-swap.test.ts` |
| DOC/HANDOFF | `docs/builds/BUILD-ARB-001-PLAN.md`; **new** `BUILD-ARB-001-PHASE-2-READ-VERIFICATION.json`; `BUILD-ARB-001-HANDOFF.md` (updated during recovery) |
| TEMPORARY / GENERATED | None in the recovered Git status. Existing ignored dependency artifacts are retained. |

TESTS ALREADY PRESENT:
- `arbitrum-runtime.test.ts`: loader failure/expiry/identity/FLUX, gates/read-only RPC, quote/deployment checks, owner Review, stale state, exact approvals, Nitro bounds, restart/UNKNOWN recovery, nonce collision, native/ERC-20 lifecycle and recipient validation.
- `arbitrum-authoring.test.ts`: Canvas builders, deterministic Chat, deterministic EN/PT Copilot intent provider, channel conversion and actual MCP gateway compose parity; amounts/decimals and capability scope.
- Phase 1 `arbitrum-network.test.ts`, `arbitrum-core.test.ts` plus adjusted Base/Robinhood/catalog tests above.

TESTS PASSED:
- Recovery inspection commands and pinned toolchain checks (Node 24.21.0 / pnpm 11.22.0).
- Phase 1 results are archived below; prior Phase 2 results cannot be reconstructed from durable records and are not claimed.

TESTS FAILING:
- None established yet; recovered tests have not run in this recovery session.

TESTS NOT YET RUN:
- Rebuild changed workspace package exports in dependency order, recovered focused Arbitrum suites, focused Base/Robinhood/runtime/cloud/parity regressions, scoped strict TypeScript, changed-file ESLint and diff check.
- Full CI, live/fork/browser/PostgreSQL suites intentionally outside this checkpoint.

ARCHITECTURAL DECISIONS:
- Continue the existing shared catalog, Uniswap swap, transfer compiler/executor/reconciler and durable storage/lease engines. No parallel Arbitrum financial engine.
- Arbitrum is `eip155:42161`, MAINNET / REAL_FUNDS. `GRYLOO_ARBITRUM_MAINNET=live` enables reads; owner preparation additionally needs `GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`. No Production variables set; no Arbitrum harness bypass.
- Strict owner-bound swap Review is a generic profile option currently enabled for Arbitrum; preserve existing Base/Robinhood semantics. Direct token transfers have no approval.
- Nitro posting cost is included in `eth_estimateGas` and receipt `gasUsed × effectiveGasPrice`; no Base OP Stack oracle or additional `l1Fee` term. Recheck official documentation during the fee audit.

DISCOVERIES / IMPORTANT FACTS:
- HEAD equals Phase 1; there are zero later commits, 41 modified tracked files and six untracked build files before this handoff edit.
- The old handoff was stale. The recovered plan contains extensive Phase 2 claims but no reproducible final test results; code and checks are authoritative.
- All six untracked files are relevant implementation, authored tests or public read evidence. No temporary file or token-list snapshot was found.
- Contract native recipients are handled by a narrow profile option and recipient code commitment, with exact value-only call/owner debit reconciliation. This needs validation, not a recipient UX redesign.

OWNER-APPROVED UX CHANGES:
- none yet

DO NOT REDO:
- Preserve the dirty recovery work. Do not reset/clean/stash/checkout/rebase/revert, recreate branch/worktree, duplicate existing services/tests or restart Phase 2.
- Do not repeat Phase 1 discovery/parser work or Phase 2 public deployment verification without a concrete new discrepancy.
- Do not implement Transfer "To", saved wallets, picker/modal/card/layout changes, new Bridge/Pool/Aave runtimes, testnet expansion, full CI, PR/push or Production variables. No automated real-money transaction.

NEXT EXACT ACTION:
- Build `reference-linter...` dependencies, then compiler → executor/reconciler → cloud-runtime exports; run the existing Arbitrum runtime/authoring/core and catalog tests. Record actual failures, then audit/fix only identified Phase 2 lifecycle or parity gaps and run relevant Base/Robinhood regressions. Update this checkpoint before the phase-ending commit.

## Archived Phase 1 checkpoint (historical; instructions to stop are superseded by Phase 2 authorization)

COMPLETED:
- Verified clean starting state, requested branch and exact baseline. Read CLAUDE.md, BASE-001 discovery/plan/report and docs/deploy/ENVIRONMENT.md. Root AGENTS.md is absent; read app AGENTS.md and installed Next.js guidance.
- Fresh official-source and public read-only verification. Arbitrum block 513935282, chainId 42161. Verified protocol deployment code/relationships, Uniswap pool/quote, Aave native USDC reserve and both Across USDC routes between Base and Arbitrum.
- Canonical ARBITRUM_ONE profile reused by existing Router, pinned asset catalog, wallet table and shared network registry. Existing reviewed Arbitrum icon reused; no wallet behavior change.
- Extracted Base's parser into one chain-bound Uniswap token-list provider factory and registered Base/Arbitrum profiles. Live source: 204 Arbitrum records; 1INCH excluded by existing symbol grammar, FLUX excluded by address for verified decimals mismatch; 203 final assets including native ETH. Existing three pins preserved.
- Shared catalog registration now validates actual assets; shared resolvers, names, logo model and injected loader seams recognize Arbitrum. No live Arbitrum server loader wired yet.
- Registered ten protocol discovery rows separately from runtime authority. Existing Router is the only Arbitrum MAINNET runtime row; no new financial actions, runtime profiles, canonical examples or Copilot prompts activated.
- Fixed generic collective catalog capability wording so bridge-only catalog recognition cannot claim swaps/transfers/liquidity.
- Focused tests/typechecks/lint passed; full Base catalog output matches baseline on both live bytes and the authored fixture.
- Removed the two accidentally tracked Python bytecode files already present at baseline and added focused ignore rules.

IN PROGRESS:
- None. Phase 1 checkpoint only. No Phase 2 work started.

REMAINING:
- Later owner-authorized phases: live catalog/network runtime profile; native/ERC-20 transfers; Uniswap swaps/liquidity; Aave USDC lending; lifecycle, recovery/reconciliation and cross-surface acceptance.
- Fresh runtime code/state validation and Nitro fee verification before activating any new capability. Full CI only at the end of BUILD-ARB-001.
- No new UX work is approved. No PR, push or Production/deployment changes in this phase.

FILES TOUCHED:
- .gitignore
- packages/action-registry/src/arbitrum-chain.ts (new)
- packages/action-registry/src/arbitrum-token-list.ts (new)
- packages/action-registry/src/uniswap-token-list.ts (new shared parser)
- packages/action-registry/src/token-list-networks.ts (new shared profile registry)
- packages/action-registry/src/capability-discovery.ts (new generic protocol discovery data, not execution authority)
- packages/action-registry/src/base-token-list.ts
- packages/action-registry/src/asset-registry.ts
- packages/action-registry/src/asset-logo-rules.ts
- packages/action-registry/src/crosschain-router.ts
- packages/action-registry/src/index.ts
- packages/action-registry/test/arbitrum-network.test.ts (new)
- packages/action-registry/test/asset-logos.test.ts
- packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json (new FloFi-authored fixture)
- apps/reference-dapp/src/domain/arbitrum-core.test.ts (new)
- apps/reference-dapp/src/domain/asset-catalogs.ts
- apps/reference-dapp/src/domain/authoring-capabilities.ts
- apps/reference-dapp/src/domain/network-registry.ts
- apps/reference-dapp/src/platform/catalogs.ts
- apps/reference-dapp/src/wallet/evm-networks.ts
- docs/builds/BUILD-ARB-001-DISCOVERY.md (new)
- docs/builds/BUILD-ARB-001-PLAN.md (new)
- docs/builds/BUILD-ARB-001-READ-VERIFICATION.json (new; public read evidence only, no upstream list bytes)
- docs/builds/BUILD-ARB-001-HANDOFF.md (this file)
- scripts/__pycache__/governance_lite.cpython-314.pyc (deleted generated junk from baseline)
- scripts/__pycache__/test_governance_lite.cpython-314.pyc (deleted generated junk from baseline)

TESTS PASSED:
- Pinned Node 24.21.0 / pnpm 11.22.0. `pnpm install --frozen-lockfile --offline` restored dependencies from local cache without lockfile changes. A fresh checkout needs the dependency builds below before app tests; no Next.js build required.

```sh
pnpm --filter @defi-workflow-engine/reference-linter... build
pnpm --filter @defi-workflow-engine/reference-compiler build
pnpm exec vitest run \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/base-network.test.ts \
  packages/action-registry/test/asset-logos.test.ts \
  packages/action-registry/test/asset-registry.test.ts \
  packages/action-registry/test/robinhood-chain.test.ts \
  packages/action-registry/test/execution-capabilities.test.ts \
  packages/action-registry/test/crosschain-router.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.test.ts \
  apps/reference-dapp/src/domain/asset-identity.test.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  apps/reference-dapp/src/domain/router-authoring.test.ts \
  apps/reference-dapp/src/engine/capability-catalog.test.ts \
  apps/reference-dapp/src/wallet/evm-networks.test.ts --maxWorkers=2
pnpm exec tsc --noEmit --target ES2024 --lib ES2024,DOM,DOM.Iterable \
  --module ESNext --moduleResolution Bundler --jsx react-jsx --strict \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop \
  --resolveJsonModule --allowImportingTsExtensions --types node \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/asset-logos.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 scripts/governance_lite.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p test_governance_lite.py
git diff --check
```

- Final focused Vitest result: **14 files, 188 tests passed**, no skips. Scoped TypeScript check passed; dependency package builds also passed strict TypeScript checks.
- `pnpm exec eslint` on all 18 changed TypeScript files: passed. Governance safety check and its **19** focused self-tests: passed.
- Additional read-only baseline comparison: transpiled the baseline Base parser under /tmp, parsed the same live source and FloFi fixture through old/new parsers and compared the entire serialized catalogs: identical. Arbitrum parser over the live source returned 203 assets and excluded FLUX.
- No full pnpm check, browser/PostgreSQL/fork/Anvil suite, deployment, transaction, PR or push was run.

TESTS FAILING:
- None outstanding. Initial app checks needed the unbuilt local reference-compiler artifact; one new test's fixture path was corrected. Final checks above all pass.

ARCHITECTURAL DECISIONS:
- Reuse shared Network/Asset/Capability registries, canonical authoring and the existing Router. No Arbitrum Canvas/Copilot/picker/workflow engine.
- Protocol discovery SUPPORTED is separate from FloFi runtime availability. Only existing Router authoring/runtime is offered on Arbitrum; other actions are refused. The protocol discovery registry holds metadata and never grants execution flags.
- Uniswap's existing curated endpoint already includes Arbitrum; use one profile-driven parser. Exact addresses are authoritative, decimals validated; no arbitrary endpoint or symbol-based identity/logo lookup. Known Arbitrum FLUX decimals mismatch is excluded, Base behavior preserved.
- Generic catalog registration now validates actual assets because createAssetRegistry only checked duplicate networks. Collective Copilot catalog wording requires actual swap/transfer/liquidity capabilities, not a bridge row.
- Catalog/network presentation metadata never enters IR/hash/Manifest/Review/execution/reconciliation. Existing local icon and fallback behavior only.
- GPL upstream bytes remain runtime-only. Persist only public verification facts and a small independently authored fixture. Exact evidence/source hashes are in READ-VERIFICATION.json.
- No Production/gate/secret changes, new allowlist, operator wallet or autonomous signing. Future execution uses the connected user's own wallet.

OWNER-APPROVED UX CHANGES:
- none yet

DO NOT REDO:
- Do not rerun full discovery or repeat the shared parser refactor without a concrete new reason. Refresh protocol state when building runtime profiles.
- Do not duplicate Arbitrum identities, the asset catalog engine or the Router. Base ↔ Arbitrum already exists both ways.
- Do not add executable capability rows or Copilot promises ahead of runtime implementation.
- Do not change Base/Robinhood behavior, testnet catalogs or UX outside explicit future scope.
- Do not enable gates, change hosting/secrets, sign/send real-money transactions, run full CI, push or open a PR for Phase 1.

NEXT EXACT ACTION:
- Stop at this commit. Await the owner's Phase 2 instruction. On resumption run pwd, git status --short, git branch --show-current and git rev-parse HEAD; read this file plus DISCOVERY.md and PLAN.md. Recommended next scope is shared Arbitrum catalog/network runtime and transfer profiles, including fresh Nitro fee and owner-wallet lifecycle verification; do not execute that scope without the next phase instruction.
