# BUILD-FLOFI-STUDIO-UNIVERSAL-002

## Base and audit

CircleCI certified main at `472dcfe0fc242f7da821bf566eda39dd40bb76cf`, the merge of PR #238. Optional schema 0035 stores immutable manifest versions, project ownership, mutable lifecycle state and append-only per-version events. Its verification code starts from two compiled RPC/checkpoint profiles. The console creates only a HyperEVM network draft or an Ethereum ERC-4626 vault draft. Its administrative CLI lists pending proposals.

| Boundary | Existing implementation and extension point |
| --- | --- |
| Network and adapter discovery | `domain/network-registry.ts` and protocol profiles are compiled. `engine/capability-catalog.ts` projects supported operations from canonical examples and the execution registry. Add tenant-scoped profiles through an explicit request context. |
| Studio drafts and identity | Keep project ownership and optimistic generation checks in `studio/integration-store.ts`. Preserve the v1 representation and its digests. Validate new integration packages through the Developer SDK. Read RPCs through the bounded pinned HTTPS transport. |
| StrategySpec, Chat and Canvas | Strategy schemas enumerate network IDs and operations. Chat resolves static aliases and Canvas uses fixed authoring commands. An exact package reference must survive authoring, serialization, hashes and subsequent reconstruction. |
| Developer API and MCP | OpenAPI and tools expose fixed authoring enums. Resolve authorized package references from the same catalog as the engine. Keep private catalog results request-scoped. |
| Wallet and execution | Execution profiles select chain, adapter version and authorization mode. Reuse the canonical compiler, simulation, review, explicit wallet approval, durable execution and receipt reconciliation. RPC self-consistency grants zero financial authority. |
| Certification | Reuse admin session/permission and audit boundaries. Independently confirm chain environment, provider, adapter and deployment. Record the exact manifest, evidence and approved capability digests. Resolve publication again at preparation and server-side wallet handoff. |

## Package and lifecycle design

Integration packages use [CAIP-2](https://standards.chainagnostic.org/CAIPs/caip-2) chain identifiers where applicable. A version records category, architecture, identity, deployment, endpoints, dependencies, requested capabilities and either a builtin adapter reference or an external source identity. Project ownership provides the author. Version digests cover normalized package bytes. Evidence carries its own source and observation time. A proposed RPC and checkpoint can demonstrate provider consistency. Mainnet classification requires independent evidence.

Proposals progress from draft through verification, testing and certification review. Review records the decision separately from publication. Scope, active project, capability and revocation checks apply to each lookup. Certified capabilities require a reviewed runtime adapter, and previously issued wallet payloads remain observable for reconciliation after revocation.

External adapters enter review as immutable commit and source digest references. An isolated build must bind results to the exact source, dependencies, toolchain, manifest, adapter artifact and test suite. Only trusted certification may attest build evidence. SDK code imported in FloFi production performs validation of bounded data.

The first vault execution candidate uses [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626). Its runtime must enforce the approved deployment, asset, recipient, limits, balance, allowance, fees and atomic exchange bounds. ERC-4626 read checks establish interface compatibility and inform a separate risk decision.

## Delivery dependencies

1. Package contract, SDK, proposal persistence and architecture-aware verification.
2. Developer Console onboarding, evidence and activity.
3. Administrative review, scoped publication, revocation and rollback.
4. Canonical engine and surface discovery, wallet gates and financial operation evidence.

Keep schema 0035 and existing network profiles byte-compatible. Gate any later additive migration explicitly. Keep public discovery mainnet-only. Certify each PR through CircleCI and leave merge, deployment and migration rollout to the owner.

## Delivery status

| Step | Pull request | What is implemented | Evidence level |
| --- | --- | --- | --- |
| 1. Package contract, SDK, verification | #239 | Versioned packages with CAIP-2 identities, architecture-aware read verifiers (EVM, ERC-4626 read, SVM, Cosmos), pinned external adapter intake with a bounded isolated compile/test harness. HyperEVM v1 and its evidence are unchanged. | Unit, PostgreSQL and fixture RPC suites; local four-case isolated adapter rehearsal. |
| 2. Developer Console onboarding | #240 | FloFi Studio navigation (Overview, My integrations, Create integration, Certification, Versions & activity, Documentation / SDK) and a guided creation flow in PT/EN. | Browser profile `developer-journey` with desktop, tablet and mobile captures. |
| 3. Certification and publication | stacked on #240 | Optional migration 0036, an independent operator review with RPC corroboration from a separate host, public or private publication, suspension, rollback and permanent revocation. A shared read-only catalog serves the Developer API, MCP and product shell. | PostgreSQL lifecycle suite; browser journey in the `admin-console` profile. |
| 4. Reference financial operation | stacked on step 3 | Bounded ERC-4626 deposit: declaration, read-only simulation into the canonical Review artifacts, fresh revalidation before the wallet request, durable attempt and independent receipt reconciliation. | Closed local Anvil chain with a fixture vault (fork suite). No public chain. |

Certified metadata grants no financial authority. The following items remain open and need explicit work and owner decisions:

- **Financial capability certification.** Migration 0036 allows only `network.read` and `vault.read`. Certifying an executable capability, such as `vault.deposit`, needs a further additive migration that binds the reviewed runtime profile (code hashes, limits, confirmations). It needs owner rollout.
- **Engine dispatch.** No backend flow, Chat or Canvas action, MCP tool or wallet handoff dispatches the ERC-4626 adapter yet. The compiler expects its profile from a trusted host. Resolving it from a Studio publication at preparation and at wallet handoff is not implemented.
- **Vault compatibility.** A plain ERC-4626 `deposit(uint256,address)` cannot enforce a minimum share output atomically. Execution therefore requires a vault exposing the bounded `deposit(uint256,address,uint256)`, or a separately reviewed router. The adapter also requires an exact pre-existing allowance and never generates an approval.
- **External adapters.** Trusted certification of submitted adapter code needs an isolated build worker and a signed attestation that binds the source, dependencies, toolchain, artifact and test suite. Neither exists yet.
- **Production.** Applying 0035 or 0036 to any shared database, and any mainnet transaction, remain owner actions.
