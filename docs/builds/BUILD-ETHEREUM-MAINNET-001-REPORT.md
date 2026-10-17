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

## Phase 1 checkpoint

Commit `63c3852`: identity, catalog, wallet switching and environment counterpart registration. Focused command:
`pnpm exec vitest run packages/action-registry/test/ethereum-mainnet.test.ts packages/action-registry/test/base-network.test.ts packages/action-registry/test/arbitrum-network.test.ts apps/reference-dapp/src/wallet/evm-networks.test.ts --maxWorkers=2`
— **4 files / 50 tests passed**, MOCKED; `/tmp/ethereum-phase1-tests.log`.

## Phase 2 checkpoint

Shared catalog runtime and cloud flow registration; Ethereum swap (`ets-`) and native/ERC-20 transfer (`ett-`) namespaces, exact simulation/Review, durable nonce and recovery, deployment-wide gates, and state recovery pointers. No wallet allowlist. Chain 1 uses L1 accounting; transfer evidence now describes L1 correctly instead of inheriting the historical catalog L2 wording. Existing chain evidence wording is preserved.

`pnpm exec vitest run apps/reference-dapp/src/server/ethereum-runtime.test.ts apps/reference-dapp/src/server/arbitrum-runtime.test.ts apps/reference-dapp/src/server/ethereum-lending.test.ts apps/reference-dapp/src/server/base-swap.test.ts --maxWorkers=2`
— **4 files / 114 tests passed**, MOCKED; `/tmp/ethereum-phases23.log`. The Ethereum swap/transfer suite alone passes **48 tests**. Initial runs exposed missing profile registration and package-build prerequisites, resolved before this checkpoint.

Read-only discovery: Ethereum safe block 26208660; 413 chain-1 source records, all contracts have code. FLUX at `0x720cd16b011b987da3518fbf38c3071d4f0d1495` declares 18 decimals but returns 8 and is excluded. Both LIT identities are excluded as ambiguous. Numeric-leading symbols are accepted on Ethereum without changing Base/Arbitrum provider inclusion policies. The eligible catalog therefore contains **410 ERC-20s plus native ETH**. No upstream source bytes are committed. See `BUILD-ETHEREUM-MAINNET-001-READONLY.json` for source hashes, runtime pins, reserve state and real read-only quotes at all four standard tiers. This snapshot is not executable authority; runtime revalidates.

Fee audit finding: current `main` implements **no FloFi fee collection or ledger** (explicit in `src/app/admin/page.tsx`, platform fee observability). The intended model is 0.1% per complete workflow; network/protocol costs remain separate. This build preserves that state and adds no per-operation fees. Complete fee execution/accounting/reconciliation cannot be certified from an absent baseline implementation and remains a production blocker; no pricing exception or alternative charging model is introduced.


## Account recovery checkpoint (2026-10-17)

Current phase: 5 — integration completion and regression certification. Phases 1 and 2 are committed; recovered phases 3 and 4 are under review and remain preserved.

- Recovered HEAD `ca94c82`, on the original branch/worktree, two commits ahead and zero behind freshly fetched `origin/main` (`50bb7b824aeaef0ab43fe93114552ac9aaaff668`). No staged changes; 49 modified files and eight untracked implementation/test files. No reset, clean, branch replacement or new worktree was performed.
- Host process inspection found no active test/build workers or editing subprocesses. File timestamps remained stable during inspection. Original app-server/CLI processes alone do not establish ongoing edits. A recovery archive of all 57 changed/untracked files and an unstaged patch are retained in `/tmp/ethereum-handoff-recovered.tar.gz` and `/tmp/ethereum-handoff-recovered.diff`.
- Recovered phase 3: Ethereum USDC Aave profile, shared four-operation lending lifecycle, fresh supply-cap accounting including treasury accrual, Ethereum catalog liquidity and isolated namespaces (`etaave-`, `etlp-`).
- Recovered phase 4: six Ethereum Router directions, shared authoring, English/Portuguese Copilot replay cases, channel/strategy/MCP discovery, wallet stores and readiness. Review found unfinished MCP bridge flow mapping/projection and execution-switch registration; these are being completed before certification.
- Recovered evidence: production compilation/typecheck/lint/schema checks succeeded in `/tmp/ethereum-check-initial-escalated.log`, but its unit stage failed: 37 failed / 4,487 passed / two skipped (18 failing files). This is not a passing full check. Subsequent focused fixes were present on disk.
- Recovered Ethereum guarded authoring browser profile: 18/18 passed (`/tmp/ethereum-browser-authoring-final.log`), MOCKED. PostgreSQL: 443 passed / three skipped (`/tmp/ethereum-postgres-final.log`). Fork selection: 31 passed / 29 skipped (`/tmp/ethereum-fork-final.log`); skipped suites are not certified. Existing offline rehearsal completed five synthetic passes (`/tmp/ethereum-offline-final.json`), MOCKED.
- Fresh recovery focused run: Ethereum lending, liquidity, Router and cross-surface certification plus channel strategy passed; nine failures remain in three legacy expectation/MCP registry files (`/tmp/ethereum-recovery-focused.log`, 120 passed).
- `cloudbuild.yaml` inspected: manual sequential full backup certification on E2_STANDARD_2 with disposable PostgreSQL, using `scripts/gcp-ci-full.sh`; up to three hours, no deploy. No billable cloud build has been started.

Next steps: finish MCP flow parity and update obsolete unsupported-network expectations while keeping malformed-policy and identity rejection coverage; regenerate the Developer OpenAPI artifact; add security checks for changing Aave cap state; run affected tests, then normal local CI gates; commit logical phases and prepare the owner-review PR. Production configuration remains untouched. Required configuration and final capability/evidence limits will be recorded below.


## Phases 3 and 4 completed after recovery

Recovered protocol and product changes were retained. Review completed the following missing seams:

- MCP: correct Ethereum bridge flow selection for all six directions, backend ephemeral preview registration, safe simulation projection for Ethereum swap/lending/liquidity/Router, and execution-switch discovery. Thirteen Ethereum execution plans are tested against independent deployment and mainnet handoff policies. Previews expose no calldata or signing authority.
- Lending: supply-cap consumption includes scaled total supply and accrued treasury supply at the current liquidity index; both Simulate and financial preflight enforce the cap. New tests cover treasury consumption and a different depositor consuming headroom after Review, without modifying the owner's position. Failed preflight prepares no wallet transaction.
- Automations: existing confirmation-mode ETH buy/sell routes now include Ethereum USDC/WETH. Schedule/price-trigger inputs, saved-workflow binding, Canvas labels and English/Portuguese Copilot grounding share the same strategy/hash. Saved workflow changes to decimals, chain or protocols refuse binding. No automatic mainnet signing was added: Ethereum inherits `MAINNET_DELEGATION_DISABLED` in both production and mocked delegation modes, as Base does.
- Product: retain the original Router picker order, append Ethereum options, report the actual Ethereum deployment gate, and give network-specific unavailable/catalog/storage messages on existing shared panels. Existing networks' IR/hash, rejection checks, layout and engines remain intact.
- Limits: the recovered Ethereum Router rows had bounds wider than the existing Router. They now inherit the existing 100-token ceiling, 0.1-USDC floor for Base/Arbitrum pairs and 1-token floor for Robinhood pairs; providers still enforce live liquidity/minimums. No new wallet allowlist or owner-address restriction exists.
- Certification expectations: exact network/flow lists now include Ethereum; malformed mainnet policy still refuses Ethereum Sepolia. The generated Developer OpenAPI artifact now includes the same Ethereum schemas as the server. No tests were removed or skipped to achieve a pass.

Protocol identities were checked against the [Uniswap deployment registry](https://developers.uniswap.org/deployments.json) and [Aave DAO address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Ethereum.sol). Mainnet observations remain in [the protocol/token read-only artifact](BUILD-ETHEREUM-MAINNET-001-READONLY.json). Recovered Across quotes and Ethereum Router/Aave-implementation reads are preserved in [the supplementary read-only artifact](BUILD-ETHEREUM-MAINNET-001-ROUTER-READONLY.json), originally collected from `https://app.across.to/api/swap/approval` and the public Ethereum RPC, not by executing its returned transactions. Provider quotes demonstrate availability at that time, not future settlement or LI.FI coverage of every pair.

## Capability matrix and preserved boundaries

| Capability | Ethereum implementation | Boundary |
| --- | --- | --- |
| Network/wallet/environment | Chain 1 / `eip155:1`, Ethereum ↔ Sepolia counterpart, existing wallet selector and identity mark | Sepolia approvals, assets and signatures do not become mainnet authority |
| Catalog | Native ETH plus all eligible chain-1 Uniswap list ERC-20s; observed snapshot: 410 ERC-20s | Runtime source loading, strict identities; FLUX decimals mismatch and ambiguous LIT excluded; membership is neither liquidity nor safety |
| Swap | Shared exact-input Uniswap v3 catalog engine, verified factory/SwapRouter02/QuoterV2 and four fee tiers | ERC-20 pairs only, a canonical liquid pool/quote required; native ETH wrapping is not implemented by this engine |
| Transfer | Native ETH and eligible catalog ERC-20s, connected owner or explicit recipient | Exact native value/ERC-20 calldata, L1 gas, simulation/Review, nonce and receipt reconciliation |
| Liquidity | Shared Uniswap v3 initialized-pool position mint, four registered tiers, eligible ERC-20 pairs | No pool creation, native wrapping, position increase/decrease/collect/close, or other unsupported shared-engine operations |
| Aave V3 | Verified USDC reserve: Supply, variable-rate Borrow, partial Repay, partial Withdraw | Existing owner-beneficiary and one-reserve risk semantics, active/cap/collateral/health checks; no universal catalog-token Aave support or native gateway |
| Router | Ethereum ↔ Base USDC, Ethereum ↔ Arbitrum USDC, Ethereum USDC ↔ Robinhood USDG | Existing Across/LI.FI Router; provider availability, fixed asset identities, caps, code pins, exact deposit and destination-fill verification |
| Canvas/Copilot/chat/MCP/developer/channels | Shared authoring and exact IR/hash; English/Portuguese; shared handoff/saved-workflow/Dashboard paths | Existing execution-plan limits apply; arbitrary multi-step owner execution is not newly implemented |
| Automation | Existing confirmation-mode schedules and price proposals; USDC/WETH route and saved single swaps | Explicit mainnet handoff policy, fresh owner simulation/Review/signing for each occurrence; mainnet delegation stays unsupported |
| Fees | Intended 0.1% per completed workflow, with gas/protocol fees separate | Baseline has no collection/ledger implementation. No per-operation charge was added; full fee certification remains unresolved |

## Required deployment configuration (documentation only; nothing enabled)

Use the existing durable cloud backend and wallet-session/tenant/evidence configuration. `API_BASE_URL` selects the existing remote web-to-backend path; the embedded alternative uses `DATABASE_URL` and `FLOFI_RUNTIME=embedded` under its existing hosting rules. No Vercel, Railway or Neon setting was changed.

- `GRYLOO_ETHEREUM_MAINNET=live`: enables Ethereum reads, quote/simulation and Review. Default is off.
- `GRYLOO_ETHEREUM_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`: separately permits preparation of owner-wallet transactions for any eligible connected wallet. It does not sign or submit. No hardcoded developer wallet is required.
- `GRYLOO_ETHEREUM_RPC_URL`: optional server-only HTTPS chain-1 provider override. Use a production provider with every read/simulation method required by the selected engine (`eth_simulateV1` where used). Chain checks and fail-closed provider behavior remain mandatory.
- `GRYLOO_ETHEREUM_JOURNAL`: absolute writable directory only for the existing local-development file-storage path. Hosted execution uses the existing durable backend/storage configuration; it does not depend on a local filesystem journal.
- Ethereum Router paths additionally need `GRYLOO_ROUTER=live`, and wallet preparation also needs `GRYLOO_ROUTER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`. Existing destination/source RPC overrides are `GRYLOO_BASE_RPC_URL`, `GRYLOO_ARBITRUM_RPC_URL`, `GRYLOO_ROBINHOOD_RPC_URL` as applicable.
- MCP handoffs: include `ethereum` in `FLOFI_MCP_HANDOFF_MAINNET_NETWORKS`, plus each other mainnet named by the workflow, only after owner authorization. Default mainnet policy remains empty.
- Confirmation-mode automations: existing automation service/secret/price-source configuration plus `ethereum` in `FLOFI_AUTOMATION_HANDOFF_MAINNET_NETWORKS`, only after owner authorization. No credential, signing grant or delegation is created by a network flag.

Namespaces/flows: swap `ets-` / `ethereum-swap`; transfer `ett-` / `ethereum-mainnet-transfer`; liquidity `etlp-` / `ethereum-liquidity`; lending `etaave-` / `ethereum-aave`; Router has one existing durable Router namespace per `crosschain-router-<direction>` flow. Canonical registry and backend flow definitions remain the source of truth for storage and recovery.

## Certification in progress

- Fresh dependency integrity/license/release-age verification: 265 locked registry versions passed; npm audit: no known vulnerabilities. Ephemeral CycloneDX SBOM: 265 components, ten workspace manifests/importers checked separately, SHA-256 `d57a9b5b190154f7dc58598c236dcced44c0dc2e89ce465bc51cf3cf294b5af5`; the SBOM was deleted by the existing gate.
- Governance: 19 governance self-tests, 41 CI self-tests, current-tree gate and whitespace checks passed.
- Targeted PostgreSQL after automation/preview changes: 11 files / 80 tests passed, no skipped tests. Recovered full PostgreSQL evidence remains separately identified above.
- Normal Anvil compatibility selection: four passed / ten owner-secret cases skipped; normal offline fork selection: 31 passed / 29 skipped. These are the repository's existing CI selections; skipped owner-secret or live-source cases are not passes. Neither suite proves Ethereum mainnet execution.
- Full-check attempt stopped on a TypeScript mismatch between the new confirmation-mode route and the delegated-input schema. The shared input schema was aligned and the existing mainnet delegation refusal retained; 74 targeted delegation/automation tests then passed. A subsequent 52-case Copilot/automation/delegation run also passed.
- `pnpm check` and final relevant browser profiles are being completed. Their definitive results and implementation commit will be appended before delivery.

Remaining production boundaries: owner review/merge and authorized production configuration; absent baseline 0.1% fee collection/ledger; no owner-signed Ethereum mainnet execution evidence. Cloud certification was inspected but not started. No deployment, merge, configuration activation or real-funds transaction is part of this delivery.
