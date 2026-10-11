# BUILD-ARB-001 — incremental plan

Baseline: `4df974f6ae6ae1d22b86f220db6281294cd20035` (BASE-001 / PR #81).
Branch: `codex/build-arb-001-network-ux`.
Inputs: [discovery and capability matrix](BUILD-ARB-001-DISCOVERY.md), [read verification](BUILD-ARB-001-READ-VERIFICATION.json),
[persistent handoff](BUILD-ARB-001-HANDOFF.md), BASE-001 shared architecture and existing Router.

The owner authorizes **Phase 1 only**. Every phase requires focused checks, an updated handoff and a commit.
Do not start later phases automatically. Full CI belongs at the end of BUILD-ARB-001; no PR or push in this checkpoint.

## Phase 1 — core architecture

- Register canonical `ARBITRUM_ONE` metadata and consume it in existing Router, pinned catalog, wallet table and network registry.
  Keep wallet switching behavior and existing routes unchanged.
- Extract Base's pure curated token-list parser into one chain-bound provider factory. Base preserves its interface and behavior.
  Register Arbitrum's profile over the same curated source, existing ETH/USDC/WETH pins and logo model; exclude the verified FLUX
  decimals mismatch by address. No testnet catalog changes and no arbitrary endpoint/token acceptance.
- Register verified protocol capability discovery with explicit runtime availability. Do not add executable capability rows,
  runtime profiles, canonical financial examples or Copilot capability lists for unbuilt actions.
- Reuse shared catalog registration, resolvers, name ambiguity, loader seams, vocabulary and presentation. Revalidate the actual
  canonical assets at registration; catalog discovery alone must not imply financial action support.
- Prove identity/chain binding, validation/exclusions, ambiguity, logos/fallback, metadata-free IR/hash, registry-derived capability
  wording, runtime refusals and Base/Robinhood continuity with focused unit tests and scoped typechecks.
- Persist evidence and exact resumption instructions; commit `BUILD-ARB-001 phase 1: register Arbitrum core architecture`.

Phase 1 deliberately leaves Arbitrum's live catalog loader unwired. Pure providers and loader seams are callable with server-validated
bytes, and tests use the FloFi-authored fixture. Existing pins/Router continue working without enabling other actions.

## Recommended later phases — proposals only

1. **Phase 2: shared Arbitrum catalog runtime and transfers.** Add a chain-bound read-only catalog/network runtime profile under the
   existing generic catalog infrastructure, then native/ERC-20 transfer profiles on the shared engine. Verify Nitro fee accounting,
   fresh code/decimals, Simulate/Review, connected-user wallet authorization, recovery and exact reconciliation. Register authoring
   capabilities only after those paths exist. Do not enable any Production gate.
2. **Phase 3: Uniswap swap and liquidity profiles.** Bind current deployed identities and runtime code pins to shared services;
   verify factory/WETH relationships, CREATE2 pools, tier selection, quotes, approvals, range accounting and lifecycle. Use the same
   SemanticWorkflow, Canvas/Chat/Copilot/MCP abstractions. Regress existing Router directions.
3. **Phase 4: Aave native USDC reserve.** Add a one-reserve Arbitrum profile for id 12 after fresh deployment, reserve, cap, liquidity
   and ABI verification; test supply/borrow/repay/withdraw lifecycle. Do not infer multi-reserve or composition support.
4. **Final phase: end-to-end integration and full CI.** Confirm registry parity across all surfaces, existing Base/Robinhood behavior,
   execution gates, recovery/reconciliation and hash continuity; run the full required CI only here. Delivery/PR remains owner-directed.

The owner may reorder or narrow these phases and will supply any future UX changes explicitly.

## Invariants for every later phase

- A network/profile/catalog registration is not execution permission. The connected user signs their own transactions; no project
  wallet, private-key custody, autonomous AI signing, new allowlist or automated real-money transaction.
- No Production, Railway, Vercel, Neon or secret changes without a separate owner instruction.
- Reuse the existing Router. Do not create an Arbitrum Canvas/Copilot/asset picker/workflow path or another bridge engine.
- No UI redesign or new interaction model; only inherited generic presentation until the owner supplies UX instructions.
- Symbols and names are metadata. Validate chain/address/decimals and never infer a token or logo from a symbol across networks.
- Discovery evidence is PUBLIC_READ_ONLY; local tests are MOCKED. Neither proves owner execution or public certification.
- Update the handoff before each phase-ending commit. Do not repeat finished discovery/refactors without a concrete new reason.
