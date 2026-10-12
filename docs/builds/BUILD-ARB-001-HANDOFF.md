# BUILD-ARB-001 Handoff

## Final Phase 6 checkpoint — 2026-10-12

- CURRENT HEAD: the Phase 6 commit containing this checkpoint; resolve its exact SHA with
  `git log -1 --format=%H -- docs/builds/BUILD-ARB-001-HANDOFF.md`.
  Exact recovered/start HEAD: `c82722ed5c57bd5fadf4d001ba81a89283233cef` (Phase 5, clean).
- CURRENT PHASE: **Phase 6 COMPLETE — final authoring / capability parity certification only; stop here**.
- Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
- COMPLETED: Phases 1–6. Every implemented capability independently certified on Canvas, deterministic Chat,
  direct EN/PT natural Copilot and actual MCP; normal product Copilot proposals applied to Canvas.
- IN PROGRESS: none. REMAINING: explicitly owner-defined UX phases, then separately authorized final integration/full CI.
  **BUILD-ARB-001 is not final.** No UX phase or full CI was started.
- TESTS PASSED: **36 distinct focused Vitest files / 965 tests**, no skips; **18 normal product browser cases**, no skips;
  independent archived-baseline hash probe (40 vectors); strict pure authoring TypeScript including dependency declarations;
  strict broader source graph with the prior `--skipLibCheck` declaration limit; ESLint on **30** code files;
  governance-lite / **19** self-tests; `git diff --check`. Registry dependency export and local app compile-only prerequisites pass.
- TESTS FAILING: none in final focused checks. Earlier iteration failures are described below; no assertion was dropped/weakened.
- OWNER-APPROVED UX CHANGES: **none yet**. New financial capabilities / UX / Production / real-money transactions / push / PR: **NONE**.
- Integration report: [BUILD-ARB-001-NETWORK-INTEGRATION-REPORT.md](BUILD-ARB-001-NETWORK-INTEGRATION-REPORT.md), begun but explicitly non-final.

### Capability certification matrix

Each PASS includes registry membership, Canvas reducer/builder, exact Chat, direct natural EN/PT intent handling,
actual authenticated MCP gateway composition, equal chain/assets/amounts/protocol/recipient meaning, stable hash and scope/refusal checks.
All ten also reach the actual normal product Copilot and Canvas in the scoped browser spec.

| Capability | Registry | Canvas | Chat | Copilot EN/PT | MCP compose | Canonical IR/hash |
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

### Authoring, assets, network and hash parity

- Reuse Network/Asset/Capability registries, canonical examples, typed commands/reducer and existing IR.
  Shared engine network/route labels now derive from registered identities/routes; no Arbitrum Copilot support list.
- Shared whole-name/symbol resolution now serves bounded Chat/MCP/Canvas references as well as Copilot.
  All supported symbols/cases/names bind exact chain/address/decimals. Examples: USDC / USD Coin, WETH / Wrapped Ether,
  ARB / Arbitrum and WBTC / Wrapped BTC. Asset-name ambiguity asks in Copilot and refuses composition elsewhere.
- Arbitrum / Arbitrum One / explicit ARB network or ARB rede → `eip155:42161`.
  Sepolia wording fails mainnet grounding even against a guessed intent; ARB in asset context supplies no network.
  A network alias or chain name cannot ground an ARB token the user did not request; an asset named Arbitrum cannot select its chain alone.
- MCP discovery reads the loaded validated catalog, including native ETH (null token address, Transfer only),
  with pinned assets alone when a catalog is unavailable. Catalog membership grants no bridge/lending eligibility.
  MCP composition is implemented; MCP itself never executes. Transfer simulation requires the owner browser;
  deployment/cloud/policy enablement remains separate and is honestly reported.
- At a common initial workflow identity: identical full canonical IR/raw hash on all four surfaces for all ten capabilities.
  Authoring source, interpretation notes, logos and brand metadata change no financial semantics.
- **Product hash exception:** normal `/app` creates a durable workspace UUID; standalone MCP uses `workflow-local`.
  The workflow ID is hash-bound. Browser tests preserve the initial UUID, compare all nodes/edges/revision/schema,
  then verify the complete hash at that same ID and explicitly assert the raw standalone hash differs.
  No hash algorithm/production identity was rewritten; no dynamic quote/hash equality was manufactured.
- **Base/Robinhood continuity:** all **33** canonical examples at Base HEAD `4df974f6ae6ae1d22b86f220db6281294cd20035`
  plus **7** additional Robinhood Stock Token scenarios retain independently rebuilt hashes (**40** vectors).
  Archived app and four archived package dependencies were built in isolated /tmp directories with locked third-party dependencies.
  Provenance/source-tree hashes and vectors: `src/domain/arbitrum-hash-baseline.fixture.json`.
  Published Base reference hash remains `0x747634a76aa445ec993325bbb638f4d5b5103d59267314b54d30db1bc79e3d49`.

### Unsupported cases and normal Copilot UI

- PASS: ETH/WETH/ARB/USDC.e Base ⇄ Arbitrum bridges; unsupported Aave reserves; full/max/all Repay/Withdraw;
  mainnet lending composition; unsupported fee tier; aliases naming one duplicate pool asset; foreign/excluded/unavailable tokens.
- Existing partial-only Aave policy is shared registry metadata, used by generated capability text and deterministic full/max refusal.
  The model cannot turn a full request into a numeric partial proposal. Live debt/balance/HF validation remains the existing runtime's job.
- Missing pool PASS: existing read preflight refuses absent code before simulation/Review/wallet calls. Pure authoring can only
  derive an expected CREATE2 address; it cannot certify current existence. No fallback pool/tier or new financial capability.
- Incomplete EN/PT liquidity requests ask for both maximum deposits; explicit unsupported fees cannot silently become the default.
  Normal Copilot refusal/clarification text contains no implementation error codes.
- Scoped Chromium 1243 on **normal `/app`**, production compiled source, real server action / committed V2 replay / passive wallet:
  **18 PASS**. Ten EN capability proposals explicitly applied to Canvas, three PT requests, four refusals/clarifications,
  one generic network-picker/assets/mark case. Model replay is interpretation only; registry support remains deterministic authority.
- Browser sentences: “Please Swap 10 USDC for WETH on Arbitrum”; “Please Send 5 USDC on Arbitrum to 0x333…333”;
  “Please Send 0.01 ETH on Arbitrum to 0x333…333”; both 100-USDC bridge directions; 10-USDC/0.005-WETH liquidity at 0.05%;
  Supply 100, Borrow 20, Repay 10, Withdraw 50 USDC. PT: “Por favor, troca 10 USDC por WETH na Arbitrum”;
  “Por favor, mande 0.01 ETH na Arbitrum para 0x333…333”; “Por favor, quero colocar 100 USDC no Aave da Arbitrum”.
  Exact full sentences/actions are in `arbitrum-certification.cases.ts` and committed replay.
- Browser guard clean; logos answered by closed local replay. Wallet methods are **eth_accounts / eth_chainId only**.
  No live model, quote, approval, sign or send in browser acceptance. Financial service regression evidence stays MOCKED.
  Existing cosmetic liquidity-provider preview buttons leave authored protocol/IR unchanged; no component or layout edit.

### Gates, scope and iteration findings

- Arbitrum: reuse `GRYLOO_ARBITRUM_MAINNET=live` and `GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`.
  Router: reuse `GRYLOO_ROUTER=live` and `GRYLOO_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`.
  **All remain OFF / not enabled or set by this build**; current-process checks are false and MCP deployment reports disabled.
- Aave profile/reserve/risk, exact approval model, Nitro fees, connected owner wallet and durable recovery from Phases 2–5 remain intact.
  No new reserve/protocol/financial operation, financial gate, signer, custody, wallet allowlist or risk model.
- Updated stale test-only support tables/corpus to append already completed liquidity/lending/transfers. Retained every prior example,
  every safety assertion and existing refusal codes where applicable. Schema now accepts bounded whole asset references;
  unsupported bridge assets refuse through canonical route validation, while malformed/address/injected inputs still fail schema.
- Initial browser mismatch was the legitimate workspace UUID; final tests retain that ID rather than force raw standalone equality.
  Initial badge assertions wrongly expected visible network text in every card; final tests inspect existing accessible badges.
  PT tests now wait for hydration/readiness before the existing read-only workflow probe. No product fix/UX change was needed.
- Sandbox font retrieval and local loopback binding required outside-sandbox reruns; read-only Google fonts and local server only.
  App compile-only bundle is a browser prerequisite, not final full-build/CI acceptance. Broader Next bundled declaration limits
  remain for final integration; source checks retain the previously documented `--skipLibCheck` there only.
- No full pnpm check, full browser/PostgreSQL/fork/Anvil/live-model matrix, Production mutation, push or PR.

### Reproducible focused commands

Repository root. Dependency exports only: `pnpm --filter @defi-workflow-engine/action-registry build`.
Archived baseline probe additionally builds only its four dependency packages under /tmp; it changes no worktree/branch/dependency lockfile.

### Authoring batch: 18 files / 524 tests

```sh
pnpm exec vitest run \
  apps/reference-dapp/src/engine/capability-catalog.test.ts \
  apps/reference-dapp/src/engine/strategy-engine.test.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts \
  apps/reference-dapp/src/domain/arbitrum-certification.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/arbitrum-lending-parity.test.ts \
  apps/reference-dapp/src/domain/arbitrum-liquidity-parity.test.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.test.ts \
  apps/reference-dapp/src/domain/canvas-transfer.test.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  apps/reference-dapp/src/domain/copilot-authoring.test.ts \
  apps/reference-dapp/src/domain/copilot-conversation.test.ts \
  apps/reference-dapp/src/domain/copilot-eval.test.ts \
  apps/reference-dapp/src/domain/crypto-action-picker.test.ts \
  apps/reference-dapp/src/domain/robinhood-authoring.test.ts \
  apps/reference-dapp/src/domain/router-authoring.test.ts \
  apps/reference-dapp/src/mcp/gateway.test.ts --maxWorkers=4
```

### Runtime batch: 12 files / 327 tests

```sh
pnpm exec vitest run \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/base-network.test.ts \
  packages/action-registry/test/execution-capabilities.test.ts \
  packages/reference-compiler/test/repay.test.ts \
  packages/reference-compiler/test/withdraw.test.ts \
  apps/reference-dapp/src/server/arbitrum-lending.test.ts \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/server/base-lending.test.ts \
  apps/reference-dapp/src/server/base-mainnet.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-base.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-certification.test.ts --maxWorkers=4
```

### Additional batch: 6 files / 114 tests

```sh
pnpm exec vitest run \
  packages/action-registry/test/asset-registry.test.ts \
  packages/action-registry/test/robinhood-chain.test.ts \
  apps/reference-dapp/src/channels/boundaries.test.ts \
  apps/reference-dapp/src/domain/asset-identity.test.ts \
  apps/reference-dapp/src/server/copilot-service-v2.test.ts \
  apps/reference-dapp/src/channels/core/strategy.test.ts --maxWorkers=4
```

### Strict scoped TypeScript

Pure authoring graph, including dependency declarations:

```sh
pnpm exec tsc --noEmit --strict --target ES2024 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/domain/asset-catalogs.ts \
  apps/reference-dapp/src/domain/network-registry.ts \
  apps/reference-dapp/src/domain/crypto-action-picker.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.ts \
  apps/reference-dapp/src/domain/copilot-authoring.ts \
  apps/reference-dapp/src/engine/strategy-engine.ts \
  apps/reference-dapp/src/engine/capability-catalog.ts \
  apps/reference-dapp/src/engine/strategy-spec.ts
```

Broader strict source graph (existing declaration limitation):

```sh
pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2024 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/domain/arbitrum-certification.test.ts \
  apps/reference-dapp/e2e/arbitrum-authoring-certification.spec.ts \
  apps/reference-dapp/playwright.arbitrum-authoring.config.ts \
  apps/reference-dapp/src/engine/strategy-engine.test.ts \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/channels/core/strategy.test.ts
```

### Scoped browser (18 tests, no retries/skips)

Compile-only local prerequisite (read-only fonts may require network access):

```sh
NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm --filter @defi-workflow-engine/reference-dapp exec next build --experimental-build-mode compile
NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 BUILD002_BROWSER_CACHE=/home/asus/.cache/ms-playwright/chromium_headless_shell-1243 FLOFI_E2E_APP_PORT=3116 pnpm --filter @defi-workflow-engine/reference-dapp exec playwright test --config playwright.arbitrum-authoring.config.ts
```

The config rejects enabled financial mainnet gates, serves loopback only, uses committed Copilot replay and the passive wallet.
It starts no fork/Anvil/financial harness or database. The later guarded browser runner includes this one profile;
that full runner was **not** executed here. This phase ran only the spec above.

### Scoped lint, governance and whitespace

```sh
pnpm exec eslint \
  apps/reference-dapp/e2e/arbitrum-authoring-certification.spec.ts \
  apps/reference-dapp/playwright.arbitrum-authoring.config.ts \
  apps/reference-dapp/src/channels/core/strategy.test.ts \
  apps/reference-dapp/src/domain/arbitrum-certification.cases.ts \
  apps/reference-dapp/src/domain/arbitrum-certification.test.ts \
  apps/reference-dapp/src/domain/asset-catalogs.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.test.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.ts \
  apps/reference-dapp/src/domain/canvas-transfer.test.ts \
  apps/reference-dapp/src/domain/commands.ts \
  apps/reference-dapp/src/domain/copilot-authoring.ts \
  apps/reference-dapp/src/domain/copilot-conversation.test.ts \
  apps/reference-dapp/src/domain/copilot-eval.corpus.ts \
  apps/reference-dapp/src/domain/copilot-messages.ts \
  apps/reference-dapp/src/domain/crypto-action-picker.test.ts \
  apps/reference-dapp/src/domain/crypto-action-picker.ts \
  apps/reference-dapp/src/domain/network-registry.ts \
  apps/reference-dapp/src/domain/robinhood-liquidity-authoring.ts \
  apps/reference-dapp/src/domain/robinhood-transfer-authoring.ts \
  apps/reference-dapp/src/domain/router-authoring.ts \
  apps/reference-dapp/src/domain/supply-authoring.ts \
  apps/reference-dapp/src/engine/capability-catalog.ts \
  apps/reference-dapp/src/engine/strategy-engine.test.ts \
  apps/reference-dapp/src/engine/strategy-engine.ts \
  apps/reference-dapp/src/engine/strategy-spec.ts \
  apps/reference-dapp/src/mcp/tools.ts \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/server/copilot-capabilities.ts \
  packages/action-registry/src/aave-v3-testnet.ts \
  scripts/guarded-release-browser.mjs
python3 scripts/governance_lite.py
python3 scripts/test_governance_lite.py
git diff --check
```

### Files touched

- `apps/reference-dapp/e2e/arbitrum-authoring-certification.spec.ts`
- `apps/reference-dapp/e2e/copilot/replay-v2.json`
- `apps/reference-dapp/playwright.arbitrum-authoring.config.ts`
- `apps/reference-dapp/src/channels/core/strategy.test.ts`
- `apps/reference-dapp/src/domain/arbitrum-certification.cases.ts`
- `apps/reference-dapp/src/domain/arbitrum-certification.test.ts`
- `apps/reference-dapp/src/domain/arbitrum-hash-baseline.fixture.json`
- `apps/reference-dapp/src/domain/asset-catalogs.ts`
- `apps/reference-dapp/src/domain/authoring-capabilities.test.ts`
- `apps/reference-dapp/src/domain/authoring-capabilities.ts`
- `apps/reference-dapp/src/domain/canvas-transfer.test.ts`
- `apps/reference-dapp/src/domain/commands.ts`
- `apps/reference-dapp/src/domain/copilot-authoring.ts`
- `apps/reference-dapp/src/domain/copilot-conversation.test.ts`
- `apps/reference-dapp/src/domain/copilot-eval.corpus.ts`
- `apps/reference-dapp/src/domain/copilot-messages.ts`
- `apps/reference-dapp/src/domain/crypto-action-picker.test.ts`
- `apps/reference-dapp/src/domain/crypto-action-picker.ts`
- `apps/reference-dapp/src/domain/network-registry.ts`
- `apps/reference-dapp/src/domain/robinhood-liquidity-authoring.ts`
- `apps/reference-dapp/src/domain/robinhood-transfer-authoring.ts`
- `apps/reference-dapp/src/domain/router-authoring.ts`
- `apps/reference-dapp/src/domain/supply-authoring.ts`
- `apps/reference-dapp/src/engine/capability-catalog.ts`
- `apps/reference-dapp/src/engine/strategy-engine.test.ts`
- `apps/reference-dapp/src/engine/strategy-engine.ts`
- `apps/reference-dapp/src/engine/strategy-spec.ts`
- `apps/reference-dapp/src/mcp/tools.ts`
- `apps/reference-dapp/src/server/arbitrum-liquidity.test.ts`
- `apps/reference-dapp/src/server/copilot-capabilities.ts`
- `docs/builds/BUILD-ARB-001-HANDOFF.md`
- `docs/builds/BUILD-ARB-001-NETWORK-INTEGRATION-REPORT.md`
- `docs/builds/BUILD-ARB-001-PLAN.md`
- `packages/action-registry/src/aave-v3-testnet.ts`
- `scripts/guarded-release-browser.mjs`

### Stop / next exact action

- DO NOT REDO Phases 1–6. Preserve intervening work; no reset/clean/stash/rebase/worktree recreation.
- No temp/generated junk is committed; task-owned /tmp baseline/reports and scoped browser outputs are removed after verification.
  The deliberate hash-vector fixture and model replay are retained. Existing ignored package exports remain for imports.
- BLOCKERS BEFORE UX PHASE: no outstanding Phase 6 implementation/focused-test blocker.
  Broader dependency declarations / full CI remain for the separately authorized final integration phase.
- NEXT EXACT ACTION: **stop at the local Phase 6 commit and wait for the owner's explicit UX scope**.
  OWNER-APPROVED UX CHANGES: **none yet**. Do not start UX, run full CI, enable gates, transact, push or open a PR automatically.


## Archived Phase 6 recovered starting state — 2026-10-12

- CURRENT HEAD: `c82722ed5c57bd5fadf4d001ba81a89283233cef`, exact expected Phase 5 commit.
- CURRENT PHASE: **Phase 6 IN PROGRESS — final authoring / capability parity certification only**, owner-authorized.
- Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
- Recovery: handoff, discovery, plan and Base integration report read first; pwd/status/branch/HEAD/log inspected.
  Worktree and index were clean; no intervening work to reconstruct. Phases 1–5 remain completed.
- Architecture: Network/Asset/Capability registries, canonical examples and shared authoring/reducer produce SemanticWorkflow IR.
  Existing profiles serve Swap, native/ERC-20 Transfer, both Base Router directions, liquidity mint and native-USDC Aave actions.
- Prior validation: Phase 5 recorded 43 focused Vitest files / 747 passing tests, scoped TypeScript/lint/governance and whitespace checks.
- IN PROGRESS: cross-surface certification matrix, registry/name/refusal audit, stable hash continuity and normal Copilot UI acceptance.
- REMAINING: focused certification/regression/browser tests, scoped checks, integration report, final handoff/plan and local Phase 6 commit.
- TESTS FAILING: none established. Existing broader Next dependency declaration limitation remains for final integration.
- OWNER-APPROVED UX CHANGES: **none yet**. No new financial capability, UX work, gate/configuration change, real-money transaction,
  full CI, push or PR is authorized. Do not redo Phases 1–5 or proceed automatically to UX work.
- NEXT EXACT ACTION: certify all ten implemented capabilities on Canvas, deterministic Chat, natural-language Copilot and actual MCP,
  including incomplete/unsupported requests and replay-driven normal product Copilot proposals applied to Canvas.

## Final Phase 5 checkpoint — 2026-10-12

- CURRENT HEAD: Phase 5 commit containing this checkpoint; resolve its exact SHA with
  `git log -1 --format=%H -- docs/builds/BUILD-ARB-001-HANDOFF.md`. Exact recovered/start HEAD:
  `212d1e447901bd4f11e2ff74235a3903e8b0fb44` (Phase 4, clean).
- CURRENT PHASE: **Phase 5 COMPLETE — Arbitrum Aave V3 lending only; stop here**.
- Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
- COMPLETED: Phases 1–5, including native USDC Supply, variable Borrow, partial Repay and partial Withdraw
  through the existing canonical lending architecture. No preceding phase was restarted.
- IN PROGRESS: none. REMAINING: separately authorized final authoring/capability parity certification;
  final integration/full CI remains outside Phase 5. No Phase 6 work performed.
- TESTS PASSED: **43 distinct focused Vitest files / 747 tests**, no skips; strict scoped runtime/registry
  TypeScript including dependency declarations; broader strict server-action/store/MCP graph with
  `--skipLibCheck`; ESLint on **33** changed/new code files; governance-lite and **19** self-tests;
  `git diff --check`. Registry/compiler/executor/reconciler/linter dependency builds pass.
- TESTS FAILING: none in final focused checks. No full CI/browser/PostgreSQL/fork/Anvil/live-model suite run.
- OWNER-APPROVED UX CHANGES: **none yet**. UX/Production/real-money transactions/push/PR: **NONE**.

### Aave deployment verification and reserve policy

Fresh [Aave DAO address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Arbitrum.sol),
[Aave proxy source](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/dependencies/openzeppelin/upgradeability/BaseUpgradeabilityProxy.sol),
[Pool interface](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/interfaces/IPool.sol),
[Supply/Borrow logic](https://github.com/aave-dao/aave-v3-origin/tree/main/src/contracts/protocol/libraries/logic), and
[TokenMath](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/helpers/TokenMath.sol)
were checked. Public reads at Arbitrum block **513958416** verify all used identities, code, provider/Pool/oracle relationships,
reserve id/configuration/decimals and token Pool/underlying relationships. Source hashes, observed reserve/cap/liquidity/index/rate
state, code hashes and the actual EIP-1967 Pool implementation slot are retained in
[Phase 5 read verification](BUILD-ARB-001-PHASE-5-READ-VERIFICATION.json). Evidence ceiling: **PUBLIC_READ_ONLY**.

| Contract | Address bound to `eip155:42161` |
| --- | --- |
| Pool | `0x794a61358d6845594f94dc1db02a252b5b4814ad` |
| PoolAddressesProvider | `0xa97684ead0e402dc232d5a977953df7ecbab3cdb` |
| Oracle | `0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7` |
| Pool implementation (revision 11) | `0xf05fd3cc911b4c5e36e53c00354f645e22922c9a` |
| Native USDC | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` |
| Native USDC aToken | `0x724dc807b04555b71ed48a6896b6f41593b8c637` |
| Native USDC variable-debt token | `0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6` |

- RESERVE POLICY: **native USDC only**, reserve id **12**, **6** decimals. Exclude USDC.e, WETH, ARB, other
  Aave-listed reserves, native wrapping, eMode, isolation and mixed-reserve account positions. Every Arbitrum
  lending action remains isolated under the existing canonical composition restrictions. Owner is the beneficiary/recipient.
- At the read block: active, unfrozen, unpaused, borrowing enabled; LTV **7500 bps**, liquidation threshold **7800 bps**,
  supply cap **250M**, borrow cap **225M**, no debt ceiling. About 179.059M USDC supplied, 159.900M variable debt,
  19.287M USDC liquidity. These are observations; runtime re-reads current relevant state and exact protocol calls.
- Runtime verifies chain before state, canonical reserve/address/decimals/id, Pool/provider/oracle, token relationships,
  code existence and the verified Pool implementation/revision. Upgrade/mismatch fails closed pending renewed verification.
- Protocol data provider `0x243aa95cac2a25651eda86e80bee66114413c43b` and UI Pool data provider
  `0x91e04cf78e53aebe609e8a7f2003e7eecd743f2b` have code and match the address book; **neither is used** by FloFi lending.
  Reads come directly from Pool, provider, oracle, underlying, aToken and variable-debt token.

### Shared runtime, health/risk, approvals and Review

- Reuse the existing Supply/Borrow/Repay/Withdraw SemanticWorkflow IR, linter/compiler, Review/Strategy Manifest,
  MODE_A owner authorization, Supply service, browser store, durable execution storage, workers, reconcilers and Evidence.
  Register one frozen profile, `araave-` namespace and `arbitrum-aave` instance of the existing cloud flow factory.
  Catalog runtime registrations choose chain/gates/RPC/journal/flow; no separate Canvas, Copilot or lending engine.
- SUPPLY: PASS. Exact positive native-unit amount, owner beneficiary, current balance, verified Pool, allowance,
  reserve configuration, supplied shares and relevant account risk bind Review. Exact read-only protocol call
  validates supply availability/caps. Fresh reads and exact call estimates run before preparation and wallet handoff.
  Empty-account Supply followed by Borrow against that same reserve is covered.
- BORROW: PASS. Existing variable mode **2** only. Require enabled nonzero eligible collateral, current one-reserve
  account/debt consistency, ordinary mode, active/unfrozen/unpaused borrow reserve, cap/liquidity/available capacity.
  Existing deterministic base-currency/threshold calculation requires **HF before and projected after ≥ 2.0**.
  No asset/amount/debt-mode/collateral substitution and no AI-derived risk authority.
- REPAY: PASS. Existing **partial variable-debt repayment only**: amount > 0 and strictly below current debt,
  with a nonzero scaled burn and positive remaining debt. Zero, full/max, and over-repay are refused rather than
  clamped or silently overpaid. Current debt/shares/index, reserve/owner and exact approval/call bind Review.
  Repay retains its existing ability to improve an account below HF 2.0; no new minimum HF is imposed on Repay.
- WITHDRAW: PASS. Existing **partial withdrawal only**, with positive remaining supplied shares. Owner recipient,
  supplied balance, current debt, remaining collateral, reserve availability/liquidity and deterministic projected
  HF are checked before Review/execution. **HF before and after ≥ 2.0** where debt exists (no debt uses uint256 max).
  Unsafe/full/over-withdraw is refused without relying solely on transaction revert.
- HEALTH / RISK POLICY: retain the existing integer model, conservative value/share rounding, **0.1%** bounded
  oracle/interest/account drift and ray tolerances. Fixed reserve/user configuration, material principal changes,
  supplied shares, wallet balance, relevant allowance and implementation changes invalidate stale Review.
  Borrow additionally binds exact debt shares and LTV/threshold. Review expires after **120 seconds**.
- APPROVAL MODEL: Supply/Repay approve **the exact finite amount** only to the verified Pool when allowance is
  insufficient. No unrelated/unlimited approval. Separate owner requests; confirmed approval is independently
  reconciled and its exact resulting allowance rechecked. Borrow/Withdraw create no approvals. Existing sufficient
  allowance is read and bound; fresh required approval is never silently introduced after Review.
- SIMULATE / REVIEW: PASS. Bind owner, chain, canonical asset/decimals, reserve/Pool/deployment identity, amount,
  debt mode, before/projected risk facts, allowance/spender/calls, gas/price/budget, workflow revision and expiry.
  Simulation stays read-only: the established proven single allowance-slot override supplies ephemeral allowance
  to exact `eth_call`/`eth_estimateGas`; no broad storage override or broadcast. Invalid/unsupported state refuses honestly.
- OWNER-WALLET EXECUTION: PASS in MOCKED lifecycle. Only the connected owner's Execute path invokes the wallet.
  Browser verifies full reviewed target/calldata/value/chain/owner/gas/price envelope before durable handoff.
  Mainnet service execution now defaults off unless explicitly enabled through the existing network owner gate.
  No project/operator/AI signer, custody, delegated authority or wallet allowlist was added. Arbitrum has no newly
  enabled EIP-7702 envelope pins; direct connected-wallet semantics are tested with the disposable signed fixture.

### Nitro fees and durable recovery/reconciliation

- ARBITRUM FEES: PASS. Reuse Phase 2/4 `arbitrum-fees.ts` **150% gas margin / 2× gas-price ceiling**.
  Here exact `eth_estimateGas`, including the proved allowance override when needed, already estimates total Nitro
  execution plus posting gas; the sequential-simulation NodeInterface supplement is unnecessary for this engine.
  Freeze whole-sequence budget in Review/Manifest; re-estimate the exact current call at begin/handoff and refuse
  over-bound gas/price. Legacy gasPrice carries no priority fee; zero priority is required on observed Nitro EIP-1559 calls.
  Receipt cost is **gasUsed × effectiveGasPrice**. An OP Stack `l1Fee` on Arbitrum is rejected. Base retains its existing
  separate L1 fee buffer/model, now checked by the shared paid-cost helper. No Base oracle path is used on Arbitrum.
- RECOVERY MODEL: reuse PREPARED → SUBMITTING → PENDING → CONFIRMED / RECONCILED; uncertainty becomes
  SUBMISSION_RESULT_UNKNOWN, failure receipt REVERTED, proven mismatch RECONCILIATION_REQUIRED / DIVERGENT.
  Durable owner nonce/economic intent remains reserved; workers observe only. No blind resend after ambiguity.
- Supply / Borrow / Repay / Withdraw: **PASS** for ambiguous submission, process restart, financial-state
  readback and idempotence. Receipts/events/owner/canonical reserve and historical account state must agree.
  Supply verifies scaled supplied-principal increase; Borrow verifies scaled debt increase and exact wallet credit;
  Repay verifies scaled debt reduction and exact wallet debit; Withdraw verifies scaled supplied-principal reduction,
  wallet credit, unchanged debt and safe remaining health. Successful receipts alone never establish success.
- Deployed floor/ceil token rules are independently represented in the MOCKED harness; odd-principal tests retain
  the existing engine's ray-rounding bounds. Wrong owner/reserve or inconsistent principal becomes sticky DIVERGENT,
  without successful evidence. Supply/Repay lost approval responses recover without approving again.
- Arbitrum nonce discovery persists **128-block per-pass** progress through the **safe** chain head, including
  inclusion beyond the old 128-block lifetime horizon. UNKNOWN with no hash/receipt remains under observation;
  scan exhaustion does not prove absence or authorize another transaction. Known receipts retain the established
  two-L2-confirmation policy; this does not claim Ethereum L1 finality.
- Evidence remains **MOCKED** for all financial tests. The public proof is read-only, with no MAINNET_EXECUTED evidence.
  Existing public Evidence machinery is reused; no real wallet execution/certification is claimed.

### Authoring parity, deployment gates and focused validation

- Canvas builders, deterministic Chat, direct natural-language Copilot intent engine (scripted EN/PT provider),
  canonical channel conversion and actual MCP `compose_strategy`: **PASS**, equal stable IR/hashes for all six owner
  requests: Supply 100, Deposit 100, Portuguese “quero colocar 100 USDC no Aave da Arbitrum”, Borrow 20, Repay 10,
  Withdraw 50. Profiles/Network/Asset/Capability registries supply identities and support truth; no prompt/list fork.
- Reuse **GRYLOO_ARBITRUM_MAINNET=live** and
  **GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED**. **Neither set/enabled**; current-process read shows
  both false. No lending owner gate, deployment change, Railway/Vercel/Neon access or secret change.
- Final validation: lending **20 files / 399 tests**, regressions/parity **18 files / 316 tests**, additional
  existing lending authoring **4 files / 30 tests**, backend imports **1 file / 2 tests**: **43 distinct files / 747 tests**.
  The supplementary command also reran the 11 registry Ethereum tests; they are counted only once.
- Regression PASS: Phase 2 Swap/Transfer, both Phase 3 Router directions, Phase 4 Liquidity, Base Aave and Base/Ethereum
  Sepolia lending. Old “unbuilt lending” expectations now assert the Phase 5 registrations without weakening unrelated checks.
- During iteration, corrected fixture-kind/unsafe-amount expectations, a fixture rounding helper typo, required backend
  `.ts` extensions and a pre-existing test asset-union narrowing. All final tests pass; none removed/skipped.
- The backend smoke rerun passed outside the sandbox: as recorded in Phase 4, sandboxed environment-cleared Node subprocesses
  suppress stdout. The rerun used local imports only, no network/database/deployment. Strict source checking of the broader
  Next graph uses `--skipLibCheck` for the previously recorded bundled dependency declaration limitations; repository
  configuration/dependencies were not weakened. Full CI remains separately authorized.

### Files touched

- `apps/reference-dapp/backend/entrypoint.test.ts`
- `apps/reference-dapp/backend/flows.ts`
- `apps/reference-dapp/backend/preview.ts`
- `apps/reference-dapp/e2e/supply-harness.mjs`
- `apps/reference-dapp/src/app/supply-action.ts`
- `apps/reference-dapp/src/channels/core/strategy.ts`
- `apps/reference-dapp/src/domain/arbitrum-authoring.test.ts`
- `apps/reference-dapp/src/domain/arbitrum-core.test.ts`
- `apps/reference-dapp/src/domain/arbitrum-lending-parity.test.ts`
- `apps/reference-dapp/src/domain/commands.ts`
- `apps/reference-dapp/src/domain/supply-authoring.ts`
- `apps/reference-dapp/src/engine/strategy-examples.ts`
- `apps/reference-dapp/src/engine/strategy-spec.ts`
- `apps/reference-dapp/src/mcp/simulation.ts`
- `apps/reference-dapp/src/server/arbitrum-lending.test.ts`
- `apps/reference-dapp/src/server/arbitrum-runtime.test.ts`
- `apps/reference-dapp/src/server/catalog-networks.ts`
- `apps/reference-dapp/src/server/supply-rpc.ts`
- `apps/reference-dapp/src/server/supply-service.ts`
- `apps/reference-dapp/src/state/supply-store.tsx`
- `docs/builds/BUILD-ARB-001-HANDOFF.md`
- `docs/builds/BUILD-ARB-001-PHASE-5-READ-VERIFICATION.json`
- `docs/builds/BUILD-ARB-001-PLAN.md`
- `packages/action-registry/src/aave-v3-testnet.ts`
- `packages/action-registry/src/capability-discovery.ts`
- `packages/action-registry/src/execution-capabilities.ts`
- `packages/action-registry/test/arbitrum-network.test.ts`
- `packages/action-registry/test/ethereum-sepolia.test.ts`
- `packages/reference-compiler/src/borrow.ts`
- `packages/reference-compiler/src/supply.ts`
- `packages/reference-compiler/test/ethereum-sepolia.test.ts`
- `packages/reference-executor/src/supply.ts`
- `packages/reference-reconciler/src/borrow.ts`
- `packages/reference-reconciler/src/repay.ts`
- `packages/reference-reconciler/src/supply.ts`
- `packages/reference-reconciler/src/withdraw.ts`

### Reproducible Phase 5 focused commands

Run from the repository root. Package dependency exports only (no app build or full CI):

```sh
pnpm --filter @defi-workflow-engine/reference-reconciler... build
pnpm --filter @defi-workflow-engine/reference-executor... build
pnpm --filter @defi-workflow-engine/reference-linter build
```

Lending batch: 20 files / 399 tests.

```sh
pnpm exec vitest run \
  packages/reference-compiler/test/borrow.test.ts \
  packages/reference-compiler/test/ethereum-sepolia.test.ts \
  packages/reference-compiler/test/repay.test.ts \
  packages/reference-compiler/test/supply.test.ts \
  packages/reference-compiler/test/withdraw.test.ts \
  packages/reference-executor/test/supply.test.ts \
  packages/reference-linter/test/ethereum-sepolia.test.ts \
  packages/reference-linter/test/supply.test.ts \
  packages/reference-reconciler/test/repay.test.ts \
  packages/reference-reconciler/test/supply.test.ts \
  packages/reference-reconciler/test/withdraw.test.ts \
  apps/reference-dapp/src/server/arbitrum-lending.test.ts \
  apps/reference-dapp/src/server/base-lending.test.ts \
  apps/reference-dapp/src/server/borrow-service.test.ts \
  apps/reference-dapp/src/server/ethereum-sepolia-lending.test.ts \
  apps/reference-dapp/src/server/lending-fee-budgets.test.ts \
  apps/reference-dapp/src/server/repay-service.test.ts \
  apps/reference-dapp/src/server/supply-rpc.test.ts \
  apps/reference-dapp/src/server/supply-service.test.ts \
  apps/reference-dapp/src/server/withdraw-service.test.ts --maxWorkers=4
```

Regression batch: 18 files / 316 tests.

```sh
pnpm exec vitest run \
  apps/reference-dapp/backend/preview.test.ts \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/ethereum-sepolia.test.ts \
  packages/action-registry/test/execution-capabilities.test.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/arbitrum-lending-parity.test.ts \
  apps/reference-dapp/src/domain/arbitrum-liquidity-parity.test.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.test.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  apps/reference-dapp/src/mcp/execution.test.ts \
  apps/reference-dapp/src/mcp/simulation.test.ts \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/server/base-mainnet.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-base.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-certification.test.ts --maxWorkers=4
```

Authoring batch: 5 files / 41 tests.

```sh
pnpm exec vitest run \
  packages/action-registry/test/ethereum-sepolia.test.ts \
  apps/reference-dapp/src/domain/borrow-authoring.test.ts \
  apps/reference-dapp/src/domain/repay-authoring.test.ts \
  apps/reference-dapp/src/domain/supply-authoring.test.ts \
  apps/reference-dapp/src/domain/withdraw-authoring.test.ts --maxWorkers=4
```

Backend imports (**2 tests**, local-only outside-sandbox rerun described above):

```sh
pnpm exec vitest run apps/reference-dapp/backend/entrypoint.test.ts --maxWorkers=1
```

Strict runtime/registry graph (dependency declarations checked):

```sh
pnpm exec tsc --noEmit --strict --target ES2024 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/server/supply-service.ts \
  apps/reference-dapp/src/domain/supply-authoring.ts \
  packages/reference-compiler/test/ethereum-sepolia.test.ts \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/ethereum-sepolia.test.ts
```

Broader strict source graph (existing dependency declaration limitation):

```sh
pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2024 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/server/arbitrum-lending.test.ts \
  apps/reference-dapp/src/domain/arbitrum-lending-parity.test.ts \
  apps/reference-dapp/src/state/supply-store.tsx \
  apps/reference-dapp/src/app/supply-action.ts \
  apps/reference-dapp/src/mcp/simulation.ts \
  apps/reference-dapp/backend/flows.ts \
  apps/reference-dapp/backend/preview.ts
```

Scoped lint (**33 files**):

```sh
pnpm exec eslint \
  apps/reference-dapp/backend/entrypoint.test.ts \
  apps/reference-dapp/backend/flows.ts \
  apps/reference-dapp/backend/preview.ts \
  apps/reference-dapp/e2e/supply-harness.mjs \
  apps/reference-dapp/src/app/supply-action.ts \
  apps/reference-dapp/src/channels/core/strategy.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/arbitrum-lending-parity.test.ts \
  apps/reference-dapp/src/domain/commands.ts \
  apps/reference-dapp/src/domain/supply-authoring.ts \
  apps/reference-dapp/src/engine/strategy-examples.ts \
  apps/reference-dapp/src/engine/strategy-spec.ts \
  apps/reference-dapp/src/mcp/simulation.ts \
  apps/reference-dapp/src/server/arbitrum-lending.test.ts \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/server/catalog-networks.ts \
  apps/reference-dapp/src/server/supply-rpc.ts \
  apps/reference-dapp/src/server/supply-service.ts \
  apps/reference-dapp/src/state/supply-store.tsx \
  packages/action-registry/src/aave-v3-testnet.ts \
  packages/action-registry/src/capability-discovery.ts \
  packages/action-registry/src/execution-capabilities.ts \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/ethereum-sepolia.test.ts \
  packages/reference-compiler/src/borrow.ts \
  packages/reference-compiler/src/supply.ts \
  packages/reference-compiler/test/ethereum-sepolia.test.ts \
  packages/reference-executor/src/supply.ts \
  packages/reference-reconciler/src/borrow.ts \
  packages/reference-reconciler/src/repay.ts \
  packages/reference-reconciler/src/supply.ts \
  packages/reference-reconciler/src/withdraw.ts
python3 scripts/governance_lite.py
python3 scripts/test_governance_lite.py
git diff --check
```

### Stop / next exact action

- DO NOT REDO Phases 1–5; preserve future intervening work. No reset/clean/stash/rebase/worktree recreation.
- No generated/temp junk is committed. Disposable scripts/downloads/results lived under /tmp; intentional read proof only
  is retained. Test directories self-clean; ignored dependency exports remain for package imports.
- BLOCKERS FOR PHASE 6: no outstanding Phase 5 implementation/focused-test blocker. Broader previously documented Next
  dependency declarations remain for final integration; public owner execution and live-model/browser acceptance are unclaimed.
- NEXT EXACT ACTION: stop after the Phase 5 commit. **Do not push/open PR, enable gates or execute Phase 6.**
  Recommended next separately authorized phase: **final authoring/capability parity certification**.

## Archived Phase 5 recovered starting state

### Phase 5 recovered starting state — 2026-10-12

- CURRENT HEAD: `212d1e447901bd4f11e2ff74235a3903e8b0fb44`, exact Phase 4 commit.
- CURRENT PHASE: **Phase 5 IN PROGRESS — Arbitrum Aave V3 lending only**, explicitly authorized by owner.
- Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
- Recovery: required handoff/discovery/plan read first; pwd/status/branch/HEAD/log/unstaged/staged diffs inspected.
  Worktree and index clean; no intervening work to reconstruct.
- COMPLETED: Phases 1–4. Phase 4 shared catalog liquidity mint, Nitro fees, owner Review, durable recovery and
  registry authoring are committed. Recorded validation: 29 files / 443 tests, scoped TypeScript/lint,
  governance-lite / 19 self-tests and whitespace checks; no outstanding focused failure.
- Architecture: reuse canonical Aave Supply/Borrow/Repay/Withdraw IR, one-reserve lending profiles,
  shared Simulate/Review/Manifest, connected owner-wallet execution, durable stores/reconciliation/Evidence.
  Arbitrum differences belong below that layer; reuse shared Nitro fees and Phase 2 network/owner gates.
- Phase 5 discovery: native USDC reserve id 12, 6 decimals, was verified active in Phase 1; Pool revision 11.
  This historical observation needs fresh official deployment and public read-only reserve/risk/ABI verification.
- IN PROGRESS: deployment verification and existing lending architecture audit.
- REMAINING: bounded profile/registrations, shared correctness fixes if demonstrated, focused tests,
  final handoff/plan and local Phase 5 commit. Do not begin Phase 6.
- FILES TOUCHED: this recovered checkpoint only. TESTS PASSED: recovery checks; Phase 5 tests pending.
- TESTS FAILING: none established. Broader existing Next dependency declaration limitation remains as recorded.
- RESERVE POLICY: start with native USDC only; no unverified expansion.
- DEPLOYMENT GATES: reuse `GRYLOO_ARBITRUM_MAINNET=live` and
  `GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`; do not enable/set either.
- OWNER-APPROVED UX CHANGES: **none yet**. Production/real-money transactions/push/PR: prohibited.
- DO NOT REDO: Phases 1–4; no reset/clean/stash/rebase/recreation/full CI.
- NEXT EXACT ACTION: freshly verify official Aave deployment sources and relevant on-chain identities/state,
  inspect shared lending runtime safety/fees/recovery, then implement Phase 5 within that architecture.

## Final Phase 4 checkpoint — 2026-10-12

- CURRENT HEAD: the Phase 4 commit containing this checkpoint; resolve its exact SHA with
  `git log -1 --format=%H -- docs/builds/BUILD-ARB-001-HANDOFF.md`. Exact parent/start:
  `ead7575819db7d5f1904db766cd093c10c68451e` (Phase 3, clean at reconstruction).
- CURRENT PHASE: **Phase 4 COMPLETE — Arbitrum Pool / Liquidity runtime only; stop here**.
- Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
- COMPLETED: Phase 1 core architecture, Phase 2 swap/transfer, Phase 3 Base ⇄ Arbitrum Router,
  Phase 4 existing Uniswap v3 catalog liquidity mint path. No previous phase was restarted.
- IN PROGRESS: none. REMAINING: separately authorized Phase 5 Aave Lending, then final integration/full CI.
- TESTS PASSED: **29 focused Vitest files / 443 tests**, no skips (200 liquidity/network/runtime regressions,
  241 Phase 2/3/authoring/MCP regressions, 2 backend-import smoke tests); strict scoped TypeScript,
  broader strict source graph with `--skipLibCheck`, ESLint on all **32** changed/new TypeScript files,
  governance-lite and **19** governance self-tests, `git diff --check`. Registry/linter/compiler dependency builds pass.
- TESTS FAILING: none in the final focused checks. Full CI was not run, as instructed.
- OWNER-APPROVED UX CHANGES: **none yet**. UX, Production configuration, deployment gate changes,
  real-money transactions, push and PR: **NONE**.

### Existing architecture versus Phase 4 additions

Before Phase 4, Base/Robinhood catalog liquidity and Base/Ethereum Sepolia fixed-profile liquidity already shared:
`asset.liquidity.concentrated` IR, address-sorted CREATE2 pools/amounts, range/tick math, linter/compiler,
sequential `eth_simulateV1`, exact NPM approvals, commitment-bound Review/Manifest, connected owner wallet,
append-only ExecutionStorage (file/PostgreSQL), durable handoff/nonce leases/discovery, receipt/NFT/amount
readback, workers, recovery and Evidence. The public canonical operation was one mint. Phase 2 supplied
Arbitrum catalog/wallet gates and Nitro fee policy; Phase 3 supplied the NodeInterface posting-gas reader.

Phase 4 added the verified Arbitrum catalog liquidity deployment/capability, `arlp-` run namespace and
registry-based registrations in the existing flow, server actions, browser recovery, authoring and MCP.
Shared refactors verify pool/factory/tier relationships even for price reads, freeze reviewed fee envelopes,
recheck material state/approvals/fees before wallet handoff, verify receipt fee bounds, and keep RPC outages
recoverable rather than classifying every UNISWAP error as divergence. The browser checks the full reviewed
transaction envelope. Phase 2/3 Nitro policy is now one shared helper used by swap, Router and liquidity.
No new liquidity engine, pool creation, increase/withdraw operation, native wrapping, testnet support,
operator signer, wallet allowlist, Aave implementation, component/layout/control change or Copilot prompt was added.

### Uniswap deployments and pool/range policy

Fresh authoritative sources: [Uniswap Arbitrum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments),
[deployment feed](https://developers.uniswap.org/deployments.json),
[factory rules](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Factory.sol).
Public read-only verification at **Arbitrum block 513952674**, with hashes and all observed pool state, is retained in
[Phase 4 read verification](BUILD-ARB-001-PHASE-4-READ-VERIFICATION.json). All identities are bound to `eip155:42161`:

| Contract | Address |
| --- | --- |
| Factory | `0x1f98431c8ad98523631ae4a59f267346ea31f984` |
| Position Manager | `0xc36442b4a4522e871399cd717abdd847ab11fe88` |
| SwapRouter02 (existing swap profile) | `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45` |
| QuoterV2 (existing swap profile) | `0x61ffe014ba17989e743c5f6cb21bf9697530b21e` |

- Factory/NPM code pins, factory/WETH relationships and chain are verified. Liquidity uses Factory/NPM/pool;
  router/quoter are unchanged Phase 2 identities. Wrong-chain/deployment responses fail closed.
- POOL POLICY: only catalog ERC-20 pairs whose actual initialized pool exists at the selected tier.
  CREATE2 is an expected address, not proof of existence. Runtime verifies code, factory `getPool`, pool.factory,
  token0/1, fee/spacing, canonical token identity/decimals and state before price or simulation.
  Missing pools/unsupported tiers are honestly refused, with no silent pool/tier fallback.
- USDC/WETH, USDC/ARB and WETH/ARB existed at all four observed tiers at that block. Runtime checks each request
  anew; no promise that every catalog pair/tier exists. USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831` (6),
  WETH `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` (18), ARB `0x912ce59144191c1204e64559fe8253a0e49e6548` (18).
- FEE-TIER / TICK POLICY: factory reads confirm **100→1, 500→10, 3000→60, 10000→200**.
  Selected tier is checked on chain. Shared math requires lower < upper, aligned ticks within protocol bounds
  ±887272, and fee-specific usable endpoints. No inherited incompatible testnet/default tick range.
- TOKEN ORDERING: contract addresses order token0/token1; amounts follow their asset address in both user orders.
  Arbitrum USDC/WETH has WETH as token0. Canonical compiler quote is token0 per token1 (WETH per USDC), with
  deterministic integer price/band-to-tick conversion tested in this orientation. Catalog authoring retains
  existing full/aligned tick ranges; no new price/band UX. WETH is represented honestly; native ETH is refused.

### Simulate, Review, approvals, fees and execution

- SIMULATE / REVIEW: PASS. Bind chain, owner/NFT recipient, canonical tokens, maximum/minimum amounts,
  verified Factory/NPM/pool/code, fee/spacing, aligned range, observed pool state, expected liquidity/usage,
  slippage, approvals, exact calls, zero value, gas/price/budget, expiry and mint deadline. Stale identity,
  changed approval requirement, material range/amount drift and over-bound estimates invalidate authorization.
  Pool/tier/spender/amount changes require a new Review; nothing is silently substituted after Review.
- APPROVAL MODEL: exact finite amount0/amount1 only to the verified NPM. Each approval/mint remains a separate
  owner-wallet request. The browser refreshes simulation/Review after confirmed approvals. Existing safe
  allowance handling and explicit owner approval remain; no unrelated approvals.
- OWNER-WALLET EXECUTION: PASS in MOCKED/local lifecycle. Only the connected user signs/submits; server read
  RPC allowlists contain no send/sign methods and cloud workers only observe. Browser checks chain, owner,
  spender/target, calldata, value, gas and fee ceilings against Review before invoking the wallet.
- ARBITRUM FEES: PASS. Reuse Phase 2 margin/price policy and Phase 3 NodeInterface reader via
  `arbitrum-fees.ts`; swap/Router semantics unchanged. Sequence execution gas plus posting-gas estimates form
  a conservative 150% Nitro gas ceiling before approvals exist, 2× `eth_gasPrice`, zero priority.
  Exact total `eth_estimateGas` must fit the frozen envelope at begin/handoff. Receipt actual cost is
  `gasUsed × effectiveGasPrice`; no OP Stack oracle or extra `l1Fee`. Base retains its own oracle/separate L1
  fee and now binds per-call allowances. [Arbitrum estimation semantics](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).
- DEPLOYMENT GATES: **GRYLOO_ARBITRUM_MAINNET=live**, **GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED**.
  Reused Phase 2 gates; no liquidity-specific gate. Neither was enabled/set. Current-process read confirmed
  network mode `off`, owner execution `false`; no Production configuration was accessed or changed.
- PUBLIC READ LIMIT: the official RPC accepted a zero-value `eth_simulateV1` factory view call, recorded in the
  read proof. This establishes read-method availability only. Financial tests/evidence remain **MOCKED**;
  no MAINNET_EXECUTED evidence, public owner mint, live-model or browser acceptance claim.

### Durable recovery/reconciliation and authoring parity

- RECOVERY MODEL: PREPARED → SUBMITTING → PENDING → CONFIRMED / RECONCILED; ambiguous boundary becomes
  SUBMISSION_RESULT_UNKNOWN, with CANCELLED/NOT_FOUND for proven absence, REVERTED for a failed receipt,
  and RECONCILIATION_REQUIRED / DIVERGENT for proven mismatches. Existing names are reused.
- Ambiguous submission: PASS. Observe nonce/receipt/position before any subsequent mint. Permanent owner/chain
  nonce leases block another run; UNKNOWN/lost hash/no returned result never authorizes blind resend.
- Restart and delayed receipt: PASS. `arlp-` browser pointer, persisted attempt/lease and worker observation
  recover the original effect; no hash and unavailable receipt remain pending. RPC/position/evidence timeouts
  retry safely without premature success or permanent financial divergence.
- Position reconciliation: PASS. Receipt success/chain/target/NPM, owner, pair/tier/ticks, NFT tokenId,
  actual usage, token transfers and paid fees must match Review. Wrong owner/token/tier/range/amount/NPM/
  chain/cost/offered gas/price/priority/nonce/approval spender becomes sticky DIVERGENT without success evidence. MOCKED journals cannot be
  recovered with PUBLIC_MAINNET provenance. Repeated recovery is idempotent and cannot mint again.
- AUTHORING PARITY: Canvas, deterministic Chat, shared EN/PT natural-language Copilot intent handling and
  actual MCP `compose_strategy` produce equal stable IR and hashes, including reversed user token order.
  The owner's three incomplete representative requests use ordinary shared clarification for deposit amounts/
  range; no amount or pool is invented. MCP preview/execution maps to the existing liquidity flow.
  Copilot tests use deterministic intent responses, not a live model. No Arbitrum-specific prompt/list.

### Focused validation and limits

Final focused checks: **14 files / 200 tests** for liquidity and network/Base/Robinhood regressions,
**14 files / 241 tests** for Arbitrum Phase 2/3, authoring and MCP regressions, and **1 file / 2 tests**
for backend imports. Total **29 files / 443 tests**, no skips. Base/Robinhood liquidity and existing Base/
Ethereum Sepolia liquidity pass, as do Arbitrum swap/transfer and both Phase 3 Router directions.

Strict runtime/authoring/wallet TypeScript checks dependency declarations too. Broader server-action/store/MCP
source checking uses `--skipLibCheck` for the already documented Next bundled webpack/React-server/URLPattern
issues. No repository configuration/dependency was weakened. Backend import smoke tests passed outside the
sandbox because the sandbox suppresses stdout from environment-cleared Node subprocesses (a trivial
console.log probe reproduced it); the rerun involved only local imports, no network/database/deployment.
An old registry expectation of Phase 2's supported capability set was updated to include liquidity;
existing assertions still distinguish discovery, implementation and demonstrated evidence.
No final implementation/test failure remains. Full CI/browser/fork/PostgreSQL matrices were not run.

### Files touched

- `apps/reference-dapp/backend/entrypoint.test.ts`
- `apps/reference-dapp/backend/flows.ts`
- `apps/reference-dapp/backend/preview.ts`
- `apps/reference-dapp/e2e/uniswap-liquidity-harness.ts`
- `apps/reference-dapp/src/domain/arbitrum-authoring.test.ts`
- `apps/reference-dapp/src/domain/arbitrum-core.test.ts`
- `apps/reference-dapp/src/domain/arbitrum-liquidity-parity.test.ts`
- `apps/reference-dapp/src/domain/authoring-capabilities.test.ts`
- `apps/reference-dapp/src/domain/commands.ts`
- `apps/reference-dapp/src/domain/crypto-action-picker.ts`
- `apps/reference-dapp/src/domain/robinhood-liquidity-authoring.ts`
- `apps/reference-dapp/src/engine/strategy-examples.ts`
- `apps/reference-dapp/src/engine/strategy-spec.ts`
- `apps/reference-dapp/src/mcp/execution.ts`
- `apps/reference-dapp/src/mcp/simulation.ts`
- `apps/reference-dapp/src/server/arbitrum-fees.ts`
- `apps/reference-dapp/src/server/arbitrum-liquidity.test.ts`
- `apps/reference-dapp/src/server/arbitrum-mainnet.ts`
- `apps/reference-dapp/src/server/arbitrum-runtime.test.ts`
- `apps/reference-dapp/src/server/catalog-networks.ts`
- `apps/reference-dapp/src/server/public-testnet-service.ts`
- `apps/reference-dapp/src/server/router-service.ts`
- `apps/reference-dapp/src/server/uniswap-liquidity-service.ts`
- `apps/reference-dapp/src/state/uniswap-liquidity-store.tsx`
- `apps/reference-dapp/src/wallet/uniswap-liquidity-eip1193.test.ts`
- `apps/reference-dapp/src/wallet/uniswap-liquidity-eip1193.ts`
- `docs/builds/BUILD-ARB-001-HANDOFF.md`
- `docs/builds/BUILD-ARB-001-PHASE-4-READ-VERIFICATION.json`
- `docs/builds/BUILD-ARB-001-PLAN.md`
- `packages/action-registry/src/capability-discovery.ts`
- `packages/action-registry/src/execution-capabilities.ts`
- `packages/action-registry/src/uniswap-catalog-networks.ts`
- `packages/action-registry/src/uniswap-v3-arbitrum.ts`
- `packages/action-registry/test/arbitrum-network.test.ts`
- `packages/reference-compiler/src/uniswap-public-liquidity.ts`

### Reproducible Phase 4 focused commands

Run from the repository root. Dependency exports only: registry/linter/compiler builds, no full app build.

```sh
pnpm --filter @defi-workflow-engine/reference-linter... build
pnpm --filter @defi-workflow-engine/reference-compiler build
pnpm --filter @defi-workflow-engine/action-registry build
```

Liquidity/network/Base/Robinhood certification (**200 tests**):

```sh
pnpm exec vitest run \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/domain/arbitrum-liquidity-parity.test.ts \
  apps/reference-dapp/src/wallet/uniswap-liquidity-eip1193.test.ts \
  apps/reference-dapp/src/server/uniswap-liquidity-service.test.ts \
  apps/reference-dapp/src/server/base-liquidity.test.ts \
  apps/reference-dapp/src/server/robinhood-liquidity.test.ts \
  apps/reference-dapp/src/server/ethereum-sepolia-liquidity.test.ts \
  packages/reference-compiler/test/uniswap-public-liquidity.test.ts \
  packages/reference-linter/test/uniswap-liquidity.test.ts \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/action-registry/test/execution-capabilities.test.ts \
  apps/reference-dapp/src/server/base-mainnet.test.ts \
  apps/reference-dapp/src/server/robinhood-swap.test.ts \
  apps/reference-dapp/src/server/robinhood-transfer-service.test.ts --maxWorkers=4
```

Phase 2/3/authoring/MCP regressions (**241 tests**):

```sh
pnpm exec vitest run \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-certification.test.ts \
  apps/reference-dapp/src/server/router-arbitrum-base.test.ts \
  apps/reference-dapp/src/server/router-service.test.ts \
  apps/reference-dapp/src/server/router-providers.test.ts \
  apps/reference-dapp/src/server/router-runtime.test.ts \
  apps/reference-dapp/src/domain/arbitrum-bridge-parity.test.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.test.ts \
  apps/reference-dapp/src/domain/catalog-copilot-parity.test.ts \
  apps/reference-dapp/src/mcp/execution.test.ts \
  apps/reference-dapp/src/mcp/simulation.test.ts \
  apps/reference-dapp/backend/preview.test.ts --maxWorkers=4
```

Local backend imports (**2 tests**, outside-sandbox local-only rerun described above):

```sh
pnpm exec vitest run apps/reference-dapp/backend/entrypoint.test.ts --maxWorkers=1
```

Strict runtime/authoring/wallet graph (dependency declarations checked):

```sh
pnpm exec tsc --noEmit --strict --target ES2024 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/domain/arbitrum-liquidity-parity.test.ts \
  apps/reference-dapp/src/wallet/uniswap-liquidity-eip1193.test.ts \
  apps/reference-dapp/src/server/router-service.ts \
  apps/reference-dapp/src/server/public-testnet-service.ts \
  packages/action-registry/test/arbitrum-network.test.ts
```

Broader strict source graph (existing dependency declaration limitation):

```sh
pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2024 --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --resolveJsonModule --allowImportingTsExtensions --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  apps/reference-dapp/src/state/uniswap-liquidity-store.tsx \
  apps/reference-dapp/src/app/uniswap-liquidity-action.ts \
  apps/reference-dapp/src/mcp/simulation.ts \
  apps/reference-dapp/src/mcp/execution.ts \
  apps/reference-dapp/backend/flows.ts \
  apps/reference-dapp/backend/preview.ts
```

Scoped lint (**32 files**), governance-lite and whitespace:

```sh
pnpm exec eslint \
  apps/reference-dapp/backend/entrypoint.test.ts \
  apps/reference-dapp/backend/flows.ts \
  apps/reference-dapp/backend/preview.ts \
  apps/reference-dapp/e2e/uniswap-liquidity-harness.ts \
  apps/reference-dapp/src/domain/arbitrum-authoring.test.ts \
  apps/reference-dapp/src/domain/arbitrum-core.test.ts \
  apps/reference-dapp/src/domain/arbitrum-liquidity-parity.test.ts \
  apps/reference-dapp/src/domain/authoring-capabilities.test.ts \
  apps/reference-dapp/src/domain/commands.ts \
  apps/reference-dapp/src/domain/crypto-action-picker.ts \
  apps/reference-dapp/src/domain/robinhood-liquidity-authoring.ts \
  apps/reference-dapp/src/engine/strategy-examples.ts \
  apps/reference-dapp/src/engine/strategy-spec.ts \
  apps/reference-dapp/src/mcp/execution.ts \
  apps/reference-dapp/src/mcp/simulation.ts \
  apps/reference-dapp/src/server/arbitrum-fees.ts \
  apps/reference-dapp/src/server/arbitrum-liquidity.test.ts \
  apps/reference-dapp/src/server/arbitrum-mainnet.ts \
  apps/reference-dapp/src/server/arbitrum-runtime.test.ts \
  apps/reference-dapp/src/server/catalog-networks.ts \
  apps/reference-dapp/src/server/public-testnet-service.ts \
  apps/reference-dapp/src/server/router-service.ts \
  apps/reference-dapp/src/server/uniswap-liquidity-service.ts \
  apps/reference-dapp/src/state/uniswap-liquidity-store.tsx \
  apps/reference-dapp/src/wallet/uniswap-liquidity-eip1193.test.ts \
  apps/reference-dapp/src/wallet/uniswap-liquidity-eip1193.ts \
  packages/action-registry/src/capability-discovery.ts \
  packages/action-registry/src/execution-capabilities.ts \
  packages/action-registry/src/uniswap-catalog-networks.ts \
  packages/action-registry/src/uniswap-v3-arbitrum.ts \
  packages/action-registry/test/arbitrum-network.test.ts \
  packages/reference-compiler/src/uniswap-public-liquidity.ts
```

```sh
python3 scripts/governance_lite.py
python3 scripts/test_governance_lite.py
git diff --check
```

### Stop / next action

- DO NOT REDO Phases 1–4. Preserve all valid intervening work; no reset/clean/stash/rebase.
- Temporary verification scripts/results remain outside the worktree and are removed after copying the intentional
  read proof. Test directories self-clean under /tmp; ignored dependency outputs are retained for package imports.
- BLOCKERS FOR PHASE 5: no outstanding Phase 4 implementation blocker. Phase 5 requires a new owner instruction
  and fresh Aave deployment/reserve/cap/liquidity/ABI verification. The broader dependency declaration issue is
  deferred to separately authorized final integration/CI; MOCKED tests do not certify public owner execution.
- NEXT EXACT ACTION: stop at the Phase 4 commit. Do not push/open a PR, enable gates or execute Phase 5.
  Recommended next authorized scope: **Aave Lending**, using the existing architecture after fresh verification.

## Archived Phase 4 starting checkpoint

### Phase 4 starting checkpoint — 2026-10-12

- CURRENT HEAD: `ead7575819db7d5f1904db766cd093c10c68451e` (Phase 3), verified clean.
- CURRENT PHASE: **Phase 4 IN PROGRESS — Arbitrum Pool / Liquidity only**.
- Branch/worktree: `codex/build-arb-001-network-ux`, `/home/asus/projects/flofi-arb`.
- COMPLETED: Phases 1–3. No other session's Phase 4 edits were present.
- FILES TOUCHED at reconstruction: none. This checkpoint is the first Phase 4 edit.
- EXISTING: `asset.liquidity.concentrated` IR, Uniswap catalog CREATE2 resolver, address-sorted amounts,
  full/aligned tick ranges and deterministic integer price/band math, fixed Base/Ethereum Sepolia profiles,
  Base/Robinhood catalog profiles, shared linter/compiler, sequential `eth_simulateV1`, exact Position Manager
  approvals, commitment-bound Review, owner-wallet execution, append-only execution storage, leases/nonce
  discovery, receipt/log/NFT/amount readback and evidence. Server actions, cloud `liquidityFlow`, run store and
  MCP consume that shared service; workers observe only. Base alone uses its OP Stack oracle and receipt `l1Fee`.
- NEEDED: freshly verified Arbitrum NPM/code pin and catalog liquidity profile; MAINNET capability;
  existing catalog runtime/flow/MCP/authoring registrations; an `arlp-` durable namespace; reuse of Phase 2
  Nitro fee semantics (posting included in gas, 150% gas margin, 2× price ceiling, receipt gasUsed × price),
  bound at Review and rechecked before wallet handoff; focused recovery/identity/range/parity regressions.
- AUDIT: shared liquidity currently budgets simulation gas and reprices at begin. Phase 4 must preserve
  reviewed gas/price ceilings and account for Nitro posting gas. Pool-price reads must verify factory/pool
  identity and enabled tick spacing before supplying authoring state. Existing recovery never blindly resends.
- DEPLOYMENT GATES: reuse `GRYLOO_ARBITRUM_MAINNET=live` and
  `GRYLOO_ARBITRUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`; neither enabled or changed.
- OWNER-APPROVED UX CHANGES: **none yet**. No components/layout/control changes planned.
- DO NOT REDO: Phases 1–3; do not implement Aave, expand testnets, run full CI, push or open a PR.
- NEXT EXACT ACTION: fresh authoritative deployment/factory reads, then shared registrations and focused
  fee/recovery certification. All automated execution remains MOCKED/local; public reads have no wallet.

## Archived Phase 3 checkpoint

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
