# BUILD-ARB-001 Handoff

BASELINE: 4df974f6ae6ae1d22b86f220db6281294cd20035 (BUILD-BASE-001 / PR #81)
CURRENT HEAD: Phase 1 checkpoint — the commit containing this file. Resolve its SHA with `git log -1 --format=%H -- docs/builds/BUILD-ARB-001-HANDOFF.md` (a commit cannot embed its own SHA).
CURRENT PHASE: Phase 1 complete; stop here. Branch: `codex/build-arb-001-network-ux`.

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
