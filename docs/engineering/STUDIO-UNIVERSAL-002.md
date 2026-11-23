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
