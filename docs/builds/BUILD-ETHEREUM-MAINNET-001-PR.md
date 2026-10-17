# Proposed pull request

Title: feat: add Ethereum Mainnet through shared FloFi engines

Base: `main`
Head: `codex/build-ethereum-mainnet-001`
Implementation commit: `38f0c45`

Ethereum was a named-only network. It is now a chain-1 catalog network throughout shared authoring, wallet selection and execution: Uniswap v3 swaps and initialized-pool position minting, native/ERC-20 transfers, verified Aave V3 USDC Supply/Borrow/partial Repay/partial Withdraw, and six provider-bound Router directions with Base, Arbitrum and Robinhood Chain.

Canvas, English/Portuguese Copilot, deterministic chat, MCP/developer interfaces, channel proposals, saved workflows and existing confirmation-mode automations use the same canonical strategies and workflow hashes. Ethereum-specific executable bytes, state and recovery remain in isolated namespaces under the existing engines. Exact simulation, Review, wallet signing, nonce recovery and receipt reconciliation are preserved. Deployment gates remain off, mainnet delegation remains disabled, and no wallet allowlist or per-operation platform fee is introduced.

Validation: `pnpm check` passed (4,545 unit tests, two existing profile-dependent skips); five relevant guarded browser profiles passed 60/60; affected PostgreSQL suites passed 80/80. Dependency integrity/license/age, audit, ephemeral SBOM, governance and normal offline Anvil/fork selections passed, with existing skipped cases reported separately. See the [build report](BUILD-ETHEREUM-MAINNET-001-REPORT.md) for definitive commands/results, skipped suites and evidence levels. Public observations cover deployment identities, catalog token code/decimals and live read-only quotes. Local lifecycle/browser evidence is MOCKED; no owner-signed Ethereum Mainnet execution is claimed. The [changed-file inventory](BUILD-ETHEREUM-MAINNET-001-FILES.txt) lists the complete branch diff from the original baseline.

Owner review boundaries: production configuration and deployment are unchanged. The inherited one-reserve lending, ERC-20 swap, mint-only liquidity, Router bounds and general multi-step execution limits remain explicit in the capability matrix. The current baseline has no implementation of FloFi's stated 0.1% completed-workflow fee collection/ledger; that remains a production release blocker. This PR preserves the intended fee model and adds no alternative charge. Merge, deployment, fee resolution and any future real-funds certification belong to the owner.

No PR has been pushed or opened by this delivery; this is the concrete proposal for owner review. Remote CI and billable Cloud Build were not started.
