# BUILD-FLOFI-MAINNET-PRODUCT-001: FloFi as a Mainnet-only product

**Owner decision.** FloFi is a Mainnet-only product for every public user. This supersedes earlier choices that kept Solana Devnet as a
default or preserved it in the public product.

**Acceptance criterion.** A normal FloFi user never has to understand or select Testnet/Devnet. The public product runs on supported
mainnets with real data, real wallets and real financial execution.

This build is a branch from `main` `cbf340e`. Nothing was deployed, merged, configured or signed, and no transaction was sent.

## 1. Audit: public Testnet/Devnet entry points on `main` `cbf340e`

The audit covered `main`. Every entry point a public user, an MCP client, a channel or the Developer API could reach is listed below,
with what this build does with it.

| # | Surface | Entry point on `main` | Where | This build |
|---|---|---|---|---|
| 1 | Header | Mainnet/Testnet selector; it moved the wallet to the other environment | `top-bar.tsx`, `header-environment.tsx` | **Removed.** No selector exists. |
| 2 | Canvas | Network pickers followed the wallet's environment, so a wallet on a test network offered only test networks | `crypto-action-picker.ts` `cryptoNetworks`, `workflow-canvas.tsx` environment effects, `router-panel.tsx` | Public: the authoring environment is always Mainnet (`authoringEnvironment`). |
| 3 | Canvas | Lending (Supply → Borrow → Swap) card | `workflow-canvas.tsx` toolbar | Hidden publicly: it exists on Base Sepolia only. |
| 4 | Canvas | Defaults for new cards (Bridge Base Sepolia → Arbitrum Sepolia, Supply/Withdraw on Base Sepolia, Send on Robinhood Testnet) | `canvas-authoring.ts`, `canvas-action-setup.ts` | Public: a new card takes a mainnet selection. It prefers the network the connected EVM wallet is already on. The editor also refuses any test-network edit (#6). |
| 5 | Canvas | Saved, recovered or handed-off test-network workflows could be simulated and reviewed | `app-shell.tsx`, `workflow-store.tsx` | Opened as they were and never re-networked. Simulation, Review and execution are blocked, and the owner can explicitly choose "Rebuild on <mainnet>" (§4). |
| 6 | Chat (exact grammar) | "… on Base Sepolia / Solana Devnet" authored test-network steps | `commands.ts` via `copilot-panel.tsx` | Refused with an explanation, never mapped to a mainnet. |
| 7 | Copilot | Model network ids, capability text, clarification options, examples ("Put 1 USDC into Aave on Base Sepolia") | `copilot-capabilities.ts`, `authoring-capabilities.ts`, `copilot-messages.ts`, `copilot-conversation.ts`, `copilot-ai.tsx` | Public copy names mainnets only. A test-network request is refused deterministically. |
| 8 | Wallet | Solana connected on Devnet by default ("testnet-first"); silent restore moved sessions between clusters; "Switch to <test network>" was offered | `wallet-connection.ts`, `jupiter-store.tsx` | Solana connects and restores on mainnet-beta. No test network is ever offered as a switch target. |
| 9 | `/approve` | Test-network proposals loaded, were claimed and were signed; the Solana proof defaulted to Devnet | `approval-handoff.tsx`, `platform/approvals.ts` | Refused server-side and explained (§4). Proofs use mainnet-beta. |
| 10 | MCP | Strategy schema enums and descriptions, `get_supported_networks/assets/capabilities`, instructions, the lending-composition note | `mcp/tools.ts`, `engine/strategy-spec.ts`, `engine/capability-catalog.ts` | The public schema offers mainnets only. Discovery lists mainnets only, and the instructions say so. |
| 11 | Developer API | OpenAPI enums and the strategy request schema; test-network strategies | `developer/openapi.ts`, `developer/schemas.ts` | The document shows mainnets only. The platform refuses test-network strategies (see §8 for the sandbox). |
| 12 | Channels (Telegram, WhatsApp) | Test-network proposals; help and grammar examples on Base Sepolia | `channels/core/strategy.ts`, `channels/core/copy.ts` | Refused through the shared platform, with EN/PT copy. Examples name Base. |
| 13 | Approval handoffs | Creating, viewing, previewing, claiming, resuming and applying test-network proposals | `platform/approvals.ts` `requestApproval`, `verifyHandoff` | Refused (`TEST_NETWORK_NOT_AVAILABLE`). The status stays readable. |
| 14 | Workflow runs | The next step of a run on a test network | `workflow-runs/service.ts` | Refused. |
| 15 | Automations | Routes on Base Sepolia, Ethereum Sepolia and Solana Devnet; new drafts defaulted to Base Sepolia | `automations/assets.ts`, `service.ts`, `binding.ts`, `automations-workspace.tsx` | Mainnet routes only; a new draft starts on the first route this deployment runs. "Automate this workflow" refuses a test-network Canvas workflow instead of prefilling a mainnet route. A test-network automation proposes nothing more. |
| 16 | Delegated execution | Credentials and delegated automations, offered on test networks only | `delegated-automations.tsx`, `delegation-credentials.tsx`, `delegation/config.ts` | Off in the public product: mainnet delegation is disabled in code and production custody does not exist. |
| 17 | Execution (web) | Every server action of the 10 test-network flows | `server/flow-runtime.ts` `cloudFlow`/`cloudPreview` | New operations refused; history kept (§3). |
| 18 | Execution (API) | The same flows on the Railway API | `backend/app.ts` `callFlow`/`previewFlow` | New operations refused when the flow runs live; history kept. |
| 19 | Public docs | Networks table (Base Sepolia, Ethereum Sepolia, Robinhood Testnet, Solana Devnet, Arbitrum Sepolia) and the "starting point" on Base Sepolia | `components/docs/content.ts` | Mainnets, with honest evidence, plus a "Test networks: not available" row. |

**Unchanged by design.**
- The engine (it still composes test networks for CI and certification) and the registries.
- The test-network services and their tests.
- The recorded evidence, ledger and certification matrix.
- Admin analytics, which still classifies historical test-network activity.

## 2. Design: one network scope, enforced at every boundary

`domain/network-scope.ts` is the one policy, with two scopes. There is no user-facing switch between them.

- **`PUBLIC_MAINNET`: the product.** Authoring, discovery, simulation, Review and execution exist on mainnets only.
- **`ENGINEERING`: isolated CI, QA and engineering certification.** It requires a local server that sets
  `FLOFI_NETWORK_SCOPE=ENGINEERING_TESTNETS`. A hosted deployment ignores the variable: Vercel production, preview and development,
  Railway, and any `FLOFI_DEPLOYMENT=hosted` server are always Mainnet-only. A test pins this rule against `isHostedDeployment`.

**How the scope reaches each layer.**
- **Browser:** the product layout hands the server's scope to the workspace once (`setActiveNetworkScope`). A browser that was never told
  is Mainnet-only.
- **Server:** each surface reads its deployment environment (`server/network-scope.ts`).

**Enforcement points.** Several layers refuse independently, so a client defect cannot reach a test network.
1. **The editor.** A proposal or Canvas command that adds a test-network step is refused (`introducedTestNetworks`). Simulation of a
   test-network workflow is disabled (`workflowAllowed`).
2. **The shared platform.** `composeWorkflowOrRefuse` and `validateStrategy` refuse test networks for MCP, the Developer API and channels.
   So do `requestApproval`, `verifyHandoff` and the workflow-run step loader.
3. **The execution boundary** (`server/test-network-flows.ts`). This covers the 10 test-network flows: `robinhood-transfer`,
   `aave-supply`, `base-sepolia-swap`, `solana-devnet-swap`, `orca-liquidity`, `uniswap-liquidity`, `crosschain-router-testnet`,
   `lending-composition`, `solana-devnet-composition` and `solana-devnet-transfer`.
   - **Kept:** reading a run, observing and reconciling an attempt that already exists, recording a wallet result the wallet already
     produced, and invalidating an authorization.
   - **Refused** (`TEST_NETWORK_NOT_AVAILABLE`): every method that could start or advance a new authorization or signature. That is
     simulate, quote refresh, Review, begin, handoff and submit.
   - **Where:** both the web runtime (every server action) and the API (live flows) apply it. The MOCKED loopback harness can only run on
     a non-hosted server, and it stays available to the engine suites.
4. **Automations and delegation.** `bindStrategy`/`verifyBinding` refuse test networks. Delegated execution is reported as not enabled.

**Learning evaluation exception.** The Copilot learning evaluation (`learning/evaluation.ts`) is a regression corpus of the deterministic
engine, and its curated cases are written on test networks. It therefore always runs in the engineering scope (`withNetworkScope`),
including when an admin evaluates a knowledge document in production. It authors, discovers and executes nothing.

## 3. Capability matrix

`docs/builds/BUILD-FLOFI-MAINNET-PRODUCT-001-CAPABILITY-MATRIX.json` is generated from code by `engine/mainnet-product-matrix.ts`. It is
derived from the certification matrix, so flows, web runtimes, channels and statuses cannot drift. A drift test regenerates it with
`FLOFI_WRITE_MAINNET_MATRIX=1`.

| Group | Rows | Status |
|---|---|---|
| Mainnet rows offered by the public product (Base, Arbitrum One, Ethereum, Solana, Robinhood Chain) | 45 | 40 `IMPLEMENTED_UNCERTIFIED`, 5 `NOT_IMPLEMENTED` (removing Uniswap liquidity on the EVM networks; the EVM → Solana bridge) |
| Per-step operations (sequences), on mainnet steps only | 2 | unchanged |
| Retired test-network rows | 24 | `TEST_NETWORK_NOT_AVAILABLE`; history read-only |

**No mainnet row is `LIVE_CERTIFIED`.** Every recorded public execution was on a test network, and that evidence never certifies a
mainnet row (enforced by a test).

The matrix records code support. Whether a deployment runs a row is that deployment's own enablement and handoff policy, which MCP
`get_capabilities` reports live. This build changes neither.

## 4. Migration behavior: nothing is silently moved to real funds

| Legacy object | Behavior |
|---|---|
| Saved workflow / recovered draft on a test network | Opens exactly as saved, with a notice (EN/PT) naming its network and the mainnet of its family. Simulation, Review and execution are disabled. **"Rebuild on <mainnet>"** is the owner's explicit re-authoring: each step becomes a draft on its family's mainnet with the same amount, which the owner checks and applies; then a fresh simulation and Review on real funds follow. Nothing is re-networked by opening or reloading. |
| `/approve` link to a test-network proposal | Never loaded or claimed. The page says it was prepared for <network>, that nothing was loaded or authorized, and asks the owner to request a new proposal on <mainnet> from the client, or to build it in FloFi. |
| Pending MCP / Developer / channel handoff on a test network | `verifyHandoff` refuses it, so it cannot be claimed or applied. The requester's status read still works. |
| Multi-step run with a test-network step | The step is never loaded for signing. |
| Automation bound to a test network | Proposes nothing more and shows "attention" (re-bind on a mainnet). |
| "Automate this workflow" on a test-network Canvas workflow | Refused with an explanation (EN/PT). It is never prefilled onto a mainnet route; the owner rebuilds the workflow on its mainnet first. |
| In-flight test-network attempt | It can still be observed and reconciled, and a wallet result can still be recorded. No new signature, begin, handoff or submission. |
| Receipts, evidence, dashboard runs | Unchanged and readable. |
| Recovered test-network run pointers | Restored for reading. The server refuses any new operation. |
| Solana wallet on Devnet | Restored and connected on mainnet-beta. FloFi never moves a wallet to a test network. |

## 5. Wallet reconnection fixes A–F (diagnosed in this build's previous step)

| Fix | Root cause | Correction | Test |
|---|---|---|---|
| A | MetaMask's provider emits `accountsChanged` for the account it just granted *before* `eth_requestAccounts` resolves, so FloFi discarded every first-connect / unlock result. | Accept the result when only account events arrived and they named the same account. A network change or another account still drops it. | `wallet-synchronization.test.tsx` |
| B | A wallet-side drop (lock, unconnected account, wallet disconnect, extension reload) was recorded as the owner's Disconnect, which disabled silent restore for good; nothing re-adopted the account. | Only FloFi's Disconnect records it. While no session exists, the remembered wallet reporting accounts triggers a **silent** reconnect. A report arriving during an attempt is retried, never lost. | `solana-session-continuity.test.tsx` |
| C | A restored Solana session was moved to mainnet on non-Solana workflows (and Devnet was the explicit default). | Mainnet-beta only in the public product. A wallet is never moved to Devnet. | same |
| D | Each sign-in check read the session only once, so the shell asked for a second signature after `/approve`. | A sign-in event makes every other check of that namespace re-read the session (no signature). | `wallet-proof.test.ts` |
| E | The Solana proof reopened the wallet chooser when the session was on the other cluster. | The same wallet and account are asked for the cluster first. | same |
| F | Generic texts and raw codes. | Plain messages for decline, a pending wallet request (-32002), unauthorized, disconnected, wrong network, busy, ambiguous wallet and missing sign-in support. | `wallet-errors`, proof and synchronization tests |

All security bindings are unchanged:
- Reconnection is silent only.
- An explicit Disconnect is never undone.
- No address is stored.
- Review invalidation and the authority epoch are as before.
- A re-registered provider object gets a new identity.

## 6. Tests and the certification boundary

**Automated (this build).**
- **Unit and PostgreSQL suites**, in the engineering scope (`vitest.config.ts`), plus new public-scope tests:
  - `network-scope`, `test-network-flows`, `platform/mainnet-only`, `mcp/mainnet-only`, `mainnet-canvas`, `copilot-mainnet` and
    `mainnet-product-matrix`;
  - the wallet tests above.
- **Browser suites:** all existing profiles run the engineering scope (`e2e/app-origin.ts` `e2eNetworkScopeEnv`).
  - The `solana-mainnet-network` profile now runs the app **exactly as deployed** (`FLOFI_E2E_NETWORK_SCOPE=PUBLIC_MAINNET`). It checks:
    no selector; Solana on mainnet-beta; the Canvas offers mainnets only; a test network named in chat is refused; Orca Mainnet liquidity
    keeps real-funds wording and MOCKED evidence cannot authorize.
  - This is an intentional change to the pinned profile inventory (`scripts/test_ci_optimization.py`).
  - Specs that run a server handler inside the Playwright process (the WhatsApp fixture turns) get the same scope as the app server
    (`playwright.config.ts`).
  - **Golden screenshots:** ten baselines in `base-observation`, `mock-artifact-chain`, `swap-authoring` and `visual-shell` were
    regenerated because the header no longer has the network selector. In each, the changed pixels are the selector's area of the header
    (x 983–1107, y 20–68), plus at most four anti-aliasing pixels elsewhere that differ by six colour levels or less. Two runs without
    updating then passed (23/23 each).

**Results on the final tree** (disposable loopback PostgreSQL, no public provider, wallet or chain):
- **Unit:** 4,862 tests passed; 2 existing harness-gated files skipped.
- **PostgreSQL:** 474 tests passed; the existing certificate-gated schema-compatibility file skipped.
- **Browser:** all 45 CI profiles pass, 376 tests.
- **Other gates:** typecheck, lint, schema drift, governance-lite and the CI-script tests pass.
- **Dependency audit:** red on `fast-uri` (§7).

**Not certified by any of the above.** These are MOCKED or loopback results. They prove neither real-wallet compatibility nor mainnet
execution. Owner-run certification, without CI and with explicit spending limits:
1. **MetaMask:**
   - first connect, connect while locked, unlock, and the -32002 pending request;
   - account and network switches across Base, Arbitrum One, Ethereum and Robinhood Chain;
   - reload and Disconnect;
   - `/approve` sign-in once.
2. **Phantom (mainnet-beta):** lock and unlock, switching to an unconnected account and back, Connected Apps → Disconnect, an extension
   update, reload, and whether a Solana disconnect also disconnects Phantom's EVM side.
3. **Both installed:** MetaMask + Phantom (including Phantom's "default wallet"), Rabby, and MetaMask's own Solana support.
4. **Execution, per network and action:** one small real-funds execution, then reconciliation, then evidence. Only after that may the
   ledger and matrix move a row to `LIVE_CERTIFIED`.
5. **Mobile:** `/approve` inside the wallet apps' browsers.

## 7. Rollout and rollback

**Rollout.**
- **No database migration, no environment or flag change.** Production must not set `FLOFI_NETWORK_SCOPE`, and it is ignored there
  anyway.
- **Railway API:** `flofi-api` auto-deploys `main` on merge. It then refuses new test-network operations (live flows).
- **Web:** `flofi.xyz` changes only when promoted. Until then, the currently promoted build still shows test-network UI, whose new
  operations the API now refuses (fail closed). Promote the web build promptly after the API.
- **Railway worker:** `flofi-worker` is deployed manually. Its automation proposals are also refused by the API at handoff time.
  Redeploy it to apply the binding refusal inside the worker too.
- **Vercel previews** are hosted, so they are Mainnet-only too. Engineering QA that needs test networks runs locally with the engineering
  scope.

**Rollback.**
- **Web:** `vercel rollback <previous dpl id>` swaps the domain alias back.
- **API and worker:** redeploy the previous Railway deployment.
- **Nothing to unwind:** no data shape changed. Runs created on mainnets keep working on the previous build. Test-network runs created
  before rollout were only read meanwhile.

**Merge order.**
- CircleCI's dependency audit fails on every branch until the `fast-uri` 3.1.9 update lands. That is the separate
  `codex/security-fast-uri-3.1.9` branch, eligible after 2026-10-26 23:05 UTC.
- This PR's `certification-checks` job therefore stops at the audit until it is rebased on that fix. The suites were run locally (see
  the PR).

## 8. Owner decisions surfaced by this build

1. **Developer API.** This release issues sandbox credentials only, and a sandbox key has every mainnet off. In a Mainnet-only product it
   can discover capabilities but cannot create strategies or approvals. Production developer credentials are a separate decision and
   build. The OpenAPI document now says so.
2. **Delegated execution** (passkey Credentials, delegated automations) is off in the public product. It exists only on test networks,
   mainnet delegation is disabled in code, and production custody does not exist.
3. **No longer offered:** the Base Sepolia lending composition, the Solana Devnet swap → Orca composition, and chat position management
   (Devnet Orca only). No mainnet equivalent exists. None was invented.
4. **Arbitrum One and Ethereum `add_liquidity`** become reachable on `flofi.xyz` with the promotion of `cbf340e` or later (see the earlier
   promotion assessment). They are real funds and have never been executed.
5. **Not in CI:** browser specs outside the CI profiles that still drive the removed header selector. Examples are
   `wallet-environment.spec.ts`, `workflow-save-environment.spec.ts`, `header-controls.spec.ts` and `crypto-action-picker.spec.ts`. They
   were already outside CI and are kept for history, not deleted. They need rewriting before they are used again.
