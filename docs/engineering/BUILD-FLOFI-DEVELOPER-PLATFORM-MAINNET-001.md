# FloFi Developer Platform mainnet implementation

## Baseline audit

The inspection began on `ec152f67` (main after PR #233). The public page and references introduced there can describe the integration, but the existing API requires an operator-issued sandbox credential and the site has no account-owned developer projects.

| Existing component | Reuse and gap |
| --- | --- |
| Developer HTTP v1 and OpenAPI | Keep the closed schemas, scoped bearer, per-project fixed windows, structured errors and server-only boundary. Live credentials are refused before authentication. An idempotency receipt currently completes after the resource write and needs atomicity before live traffic. |
| Developer PostgreSQL store | Migration 0007 already provides the project, key digest, strategy, approval binding, events, webhook and usage tables. Add ownership by verified FloFi account and reuse the existing records. |
| StrategySpec, registry and engine | Use the shared composer, registry, canonical workflow hash and runtime gates. A production proposal must be mainnet, using the execution paths currently enabled for its specific operations, networks and wallet. |
| Simulation | Keep the existing read-only engine port. Single-step preview cannot describe a dependent sequence. The platform has a per-step preview with explicit unresolved outputs. |
| Hosted approval | Reuse `/approve`, the fragment-link scheme, expiry, wallet claim, fresh financial review and wallet submission/reconciliation. The project is an external requester. The browser approval surface and backend both enforce Flight access. |
| Results | Expose only outcomes bound to the exact handoff and shared by its wallet claimant. The legacy single-step wallet/hash/time search can associate matching activity from two projects. Sequential runs already have durable handoff IDs; per-step observation also needs exact attribution. |
| Webhooks | Reuse derived signing secrets, bounded retry and leases. Existing dispatch is opportunistic or operator-scheduled. Live onboarding requires scheduled delivery independent of project traffic and suppression of queued execution outcomes after sharing is withdrawn. |
| SDK and MCP | Extend the current server client and generated contract. MCP shares composition and approval primitives. Its separately allowlisted embedded wallet surface is not the general developer integration surface. |
| Accounts and Admin | Use the host-bound, server-verified FloFi account session for project management and existing administrative audit. Project authentication and account sessions are distinct from end-user wallet authority. |
| Vercel, Railway and Neon | Vercel serves the application and owns the developer/approval routes. Railway provides the remote financial runtime when configured. Neon holds shared PostgreSQL state. The shipped schema is 28 and production can be ahead under the exact-byte 29–33 certificate. Confirm production access mode, runtime availability and scheduling at release. |

## Acceptance by delivery

- **A** verifies account ownership and isolation, project lifecycle, scoped credential issuance and atomic rotation, audit, and upgrade compatibility. The management surface uses existing FloFi authentication.
- **B** requires release-gated production credentials, registry-derived capability discovery, previews, exact hosted approvals and consented results. A fixture mainnet-shaped external journey must prove the account, API and wallet boundaries independently of live funds.
- **C** requires an installable SDK, tested examples, docs consistent with the API, a server-side playground, and a project-scoped dashboard of measured activity. A registry publication and public activation each require their own confirmed release.

No evidence from the platform build can stand in for a production rollout or a wallet owner's real transaction.
