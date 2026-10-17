# BUILD-ETHEREUM-MAINNET-001

Status: implementation in progress. No production configuration, deployment, signature or public transaction is authorized by this build.

## Discovery baseline (2026-10-17)

- Branch/worktree: `codex/build-ethereum-mainnet-001`, `/home/asus/projects/flofi-ethereum`. Already provisioned, clean, exactly at freshly fetched `origin/main` **50bb7b824aeaef0ab43fe93114552ac9aaaff668**. The separate `main` worktree remains untouched; no other worktree is modified.
- Remote: `https://github.com/alrimarleskovar/FloFi.git`. References: merged Base (#81), Arbitrum (#82), Ethereum Sepolia (#61), their implementation reports and profiles.
- Instructions: `CLAUDE.md`, `docs/SCOPE_GUARD.md`, `docs/EVIDENCE_LEVELS.md`, `apps/reference-dapp/AGENTS.md`. Normal named-branch → PR → owner review; preserve tests, toolchain, evidence boundaries and wallet authorization. Next server directive documentation inspected before app changes.
- CI: `.github/workflows/contracts.yml`, `governance.yml`, `.circleci/config.yml`, `scripts/guarded-release-browser.mjs`. Required local equivalents include `pnpm check`, PostgreSQL, Anvil/fork, guarded browser profiles, dependency and governance checks. Toolchain Node 24.21.0 / pnpm 11.22.0; frozen offline install completed without lifecycle scripts.

## Architecture and unsupported seams

- Identity: `ethereum-sepolia.ts` defines Mainnet as non-executable; `domain/network-registry.ts` keeps it in NAMED_ONLY; `wallet/evm-networks.ts` refuses switching. Sepolia is a separate chain/profile and must remain so.
- Catalog: shared `uniswap-token-list.ts`, `token-list-networks.ts`, `asset-registry.ts`, `asset-logo-rules.ts`, `domain/asset-catalogs.ts`, `server/network-catalog.ts`, `authoring-catalogs.ts`. The validated Uniswap source already carries chain 1. Runtime input only; no redistribution of upstream list bytes. No existing safe custom-token import UX was found. Search and execution must preserve chain/address/decimals and reject ambiguity.
- Swap: `workflow-contracts/catalog-swap.ts`, registry swap profiles, linter, `server/public-testnet-service.ts` implement route discovery, quote, exact approval, simulation, Review, wallet preparation, journal, recovery and reconciliation.
- Transfer: `native-transfer.ts`, shared transfer compiler/service/reconciler distinguish native value from ERC-20 calldata; profile controls recipients and settlement. Ethereum uses L1 gas accounting, never Base's OP Stack `l1Fee` or Arbitrum's Nitro policy.
- Liquidity: shared `uniswap-v3-catalog.ts`, `uniswap-catalog-networks.ts`, liquidity compiler/service/reconciler. Current public catalog engine supports initialized-pool mint, not every position-management operation.
- Lending: `aave-v3-testnet.ts` is the shared profile registry despite its historical filename. Current engine supports one reserve per chain, Supply/Borrow/partial Repay/partial Withdraw with reserve configuration, caps, collateral, health and risk checks. Add verified Ethereum USDC within these semantics; catalog tokens are not automatically Aave reserves.
- Runtime: `evm-catalog-runtime.ts` and `catalog-networks.ts` centralize chain-bound RPC, deployment-wide gates and namespaces. `backend/flows.ts` registers explicit flow names. No developer-wallet allowlist belongs in the Ethereum profile.
- Product: network identity feeds Canvas/action pickers, environment counterparts, deterministic chat and Copilot; explicit `engine/strategy-spec.ts`, examples/capability catalogs and channel copy need Ethereum registration. Copilot currently explicitly says Ethereum Mainnet is never used; replace that assumption while retaining explicit real-funds grounding and Sepolia separation.
- Router: existing Across/LI.FI profiles are chain/pair/token/code-pin bound. Ethereum routes require fresh source/deployment checks and new profiles of that same engine; no new protocol is authorized. Unverified paths remain unsupported.
- Fee audit: preserve existing complete-workflow 0.1% semantics and separate gas/protocol fees. Any missing collection/reconciliation coverage must be reported, never fixed with per-operation charges.
- Existing tests deliberately assert Mainnet unsupported in registry, wallet, compiler/linter, authoring and Copilot. Update their now-obsolete network assumptions while preserving wrong-chain, wrong-asset and wrong-environment rejection coverage.

## Implementation phases

1. Core: canonical identity, native ETH and pinned USDC/WETH, chain-1 validated catalog and logos, registry/wallet/environment; focused identity/catalog/security tests.
2. Swap/transfer: verified deployment pins, generic runtime/cloud flows, simulation/review/preparation, journal recovery/reconciliation and negative tests.
3. Liquidity/lending: verified Uniswap v3 and Aave V3 Ethereum profiles, risk and gas semantics, lifecycle tests.
4. Product: shared Canvas/Copilot EN/PT/chat/MCP/channel/strategy surfaces, supported automations and verified Router paths; fee compatibility audit; preserve layout and existing hashes.
5. Certification: full relevant local CI equivalents and guarded browser profiles; record commands/results and honest evidence class. PR for owner review only; no merge/deploy/gate activation.

## Evidence and handoff

All new test evidence remains MOCKED unless explicitly classified PUBLIC_READ_ONLY. No MAINNET_EXECUTED evidence exists. Protocol source and on-chain verification, per-phase commits, exact commands, results, remaining limits and owner-wallet certification steps will be appended here.
