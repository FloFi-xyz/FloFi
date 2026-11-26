# BUILD-FLOFI-POST-257-HOTFIX-001

Base: certified `main` at `b2ffdb53` (PR #257). Scope: the five production incidents reported after PR #257, nothing else. No migration, no
new dependency, no production configuration change, no paid service, no deploy. Every production fact below was read, never changed.

## 1. Summary

| # | Incident | Root cause | Kind | Status in this PR |
|---|---|---|---|---|
| P0-1 | Phantom and Solflare login: "Could not log in with wallet." / "Unable to connect wallet." | The production Privy app has **Solana wallet login off** (`solana_wallet_auth: false`), while FloFi forced `walletChainType: 'ethereum-and-solana'`, so Privy listed both wallets' Solana side and then refused every SIWS sign-in | **Configuration** (Privy dashboard) **and software** (FloFi offered a login method the app refuses) | Software fixed. Phantom signs in through its EVM side until the owner enables Solana wallet login at Privy; Solflare needs that change |
| P0-2 | ChatGPT: "This host could not load the in-chat signing surface."; MetaMask opens without a signing request | (a) The quoted text exists only in the panel **before** PR #256 (commit `f6459e9` replaced it): the host showed a cached pre-#256 template, or the test predates the deploy. (b) A wallet deep link can only open FloFi's `/approve` page inside the wallet's browser; presenting a signing request directly in a mobile wallet needs a relay transport (WalletConnect) | Host cache / real-host evidence pending; **transport blocked on a licensing decision** | **Not fixed.** No transport added: see §4 (decision for the CTO) |
| P0-3 | MCP: 0.0003 ETH on Base → USDC on Arbitrum One became Swap + Bridge, a 10 USDC cap, then "destination asset unsupported" | The engine already composes this as ONE Universal Bridge step. MCP discovery said native ETH was transfer-only, listed EVM bridges only as USDC/USDG Router pairs, never described `outputAsset`, and advertised bound multi-step workflows; the host built swap + bridge and had to invent the second step's cap. A deployment/policy refusal was then worded as "network, asset or action not available" | **Software** (MCP schema exposure and discovery) | Fixed and covered by regression tests |
| P0-4 | Production configuration and single confirmation | `FLOFI_WORKFLOW_RUNS` **is** enabled (the Vercel listing the owner read is truncated: 70 of 170 entries omitted) | Configuration verified | Verified, see §3; single confirmation on a real MetaMask is real-host acceptance |
| P1-5 | MCP capability and conversational corrections | Five separate defects, each in §2.5 | **Software** | Fixed and covered by regression tests |

## 2. Incidents

### 2.1 P0-1 Phantom and Solflare login

Evidence:
- Production Privy app configuration, read with the public `GET https://auth.privy.io/api/v1/apps/<appId>` the SDK itself sends: `wallet_auth: true`,
  `solana_wallet_auth: false`, `allowed_domains: ["https://flofi.xyz"]`, `captcha_enabled: false`, `allowlist_enabled: false`.
- `@privy-io/react-auth` 3.51.0 derives the wallet families from that configuration only when the client does not set them
  (`walletChainType: appearance.walletChainType ?? derive(wallet_auth, solana_wallet_auth)`, `privy-context` chunk).
- FloFi set `appearance.walletChainType: 'ethereum-and-solana'` and `login({ walletChainType: 'ethereum-and-solana' })`, so Privy listed the
  detected Solana wallets (Phantom's Solana account, Solflare) and ran SIWS against an app that does not accept it. Privy maps every SIWS failure to
  `ERROR_WALLET_CONNECTION` ("Could not log in with wallet"); after the second failure its status screen shows "Unable to connect wallet". MetaMask,
  Google and email were unaffected (EVM wallet login and those methods are on).
- No FloFi server error was involved (Vercel runtime errors, 7 days: no sign-in failure group).

Fix (`apps/reference-dapp/src/accounts/privy-client.tsx`): no forced `walletChainType`; Privy derives it from the app's own settings, so a wallet family
the app does not accept is never offered. No other sign-in behaviour changes: MetaMask, Google, email, existing accounts, the returning-account
method rules and beta access are untouched.

Effect today (Solana wallet login still off): Phantom is offered through its EVM account and signs in; Solflare (Solana only) is not offered.
Once the owner enables Solana wallet login in the Privy dashboard, both are offered through Solana with no code change; FloFi's account service
already handles Solana identities.

Test: `privy-client.test.ts` pins the SDK's derivation rule (fails if an upgrade changes it), asserts FloFi sets no `walletChainType`, and runs the
SDK's own wallet filter for both settings (Solana off: no Solana-only wallet listed; Solana on: Phantom and Solflare listed).

Mobile: Phantom's and Solflare's in-app browsers inject the same wallet standards and follow the same rule. A plain mobile browser has no injected
wallet; FloFi does not ship WalletConnect (see §4), so no external wallet is offered there.

### 2.2 P0-2 In-chat signing and mobile wallet signing

Evidence:
- The reported sentence "This host could not load the in-chat signing surface." is not in the code deployed since PR #256 (`git log -S`: last present at
  `bba09dc~1`; PR #256 replaced it with "This chat could not load…", plus closed codes and `frameChain`/`notAllowed` diagnostics). All three panel URIs
  (`…-v2`, `…-v1`, legacy) serve the current panel. A host that still shows the old sentence is rendering its cached template: ChatGPT keeps a
  connector's tool descriptors until the connector is refreshed.
- The nested signing frame depends on the host honouring the widget's `frame_domains` and on every ancestor origin being listed in `/mcp/approve`'s
  `frame-ancestors`. Neither can be observed from this environment; the panel reports both when it fails.
- A MetaMask or Phantom deep link opens FloFi's `/approve` page in the wallet's own browser. That page still needs the wallet proof, the Review
  and Authorize, so the wallet opens without a signing request; when the wallet app is locked or cold-started, MetaMask may also open its home screen.
  Presenting the signing request directly in a mobile wallet, from ChatGPT, Claude or Telegram, needs a relay transport.

Not fixed in this PR. The transport needs the decision in §4 first; nothing was added that the CTO has not approved.

### 2.3 P0-3 Universal Bridge through MCP

Evidence: `composeStrategy({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'ETH', outputAsset: 'USDC', amount: '0.0003' })`
already yields one `ADD_UNIVERSAL_BRIDGE` (strategy-engine `isUniversalBridgeSpec`), and `plan_strategy` already plans it as one bridge. The split came
from what MCP showed the host: `get_supported_assets` tagged native ETH `transfer` only ("Native currencies have transfer support only"); every
EVM↔EVM example (and so every `get_capabilities` row) was a USDC/USDG certified Router pair; `outputAsset` had no description; and
`get_capabilities` advertised bindings ("its own amount is then a cap"). No code holds a 10 USDC cap: mainnet Router maxima are uint256; the
number was the host's invented cap for the bound bridge step.

Fix:
- `strategy-spec.ts`: `asset` and `outputAsset` describe the contract: the route converts in flight, one bridge step (a Universal Bridge card), never a
  swap step, never an invented amount, and what an omitted `outputAsset` means.
- `strategy-examples.ts`: the Universal Bridge for all 12 directed EVM mainnet pairs (native ETH → the destination's dollar stablecoin), so
  `get_capabilities`, the Developer API discovery and the committed matrices list it (12 rows each, `IMPLEMENTED_UNCERTIFIED`).
- `capability-catalog.ts`: native ETH lists `swap`, `bridge`, `transfer`; USDC, USDG, USDT and WETH list `bridge` on the four EVM mainnets. Other list
  tokens (Robinhood Stock Tokens included, whose issuer checks live on the swap path) are not advertised for bridges.
- `WorkflowBindingSchema.step`: a binding's cap must be an amount the person stated; a cross-chain change of asset is never a binding.
- `tools.ts`: the instructions, `compose_strategy` and `get_capabilities` say a cross-asset bridge is one step and bindings are only for sequences the
  person asked for, with caps the person stated.
- `conversation-state.ts`: a deployment or policy gate (`*_IN_DEPLOYMENT`, `*_BY_POLICY`) reads "FloFi supports this operation, but this FloFi
  deployment does not hand it off for signing right now", never "asset not available".

No Router rebuild and no substituted workflow: the engine, the Universal Router and the certified Router are unchanged.

### 2.4 P0-4 Production configuration (read-only)

See §3.

### 2.5 P1-5 MCP capability and conversational corrections

| Issue | Cause | Fix |
|---|---|---|
| Native ETH advertised as transfer-only | `capability-catalog.ts` tagged NATIVE assets `transfer` only although catalog swaps accept native ETH | Native ETH: `swap`, `bridge`, `transfer`; stale picker comment corrected |
| Repeated wallet-address requests | `plan_strategy`'s beneficiary was "exactly as the user gave it"; linked wallets reached tools only for `flofi.runs` calls; `EVM_WALLET_REQUIRED` fell to the generic "adjust the request" text; a pool-range need was reported as `field: 'beneficiary'` | For a supply goal without a beneficiary, `plan_strategy` uses the account's one linked EVM wallet (several: they are the `options`; `beneficiarySource: LINKED_WALLET` says so), loaded lazily and only when the grant holds `flofi.runs` (checked in the tool itself); the preview-subject codes say approval needs no address; the pool-range need reports `liquidity.range`. The instructions never let a linked wallet stand in for a recipient, beneficiary or simulation subject the person did not choose |
| Separate compose / validate / simulate commands | Instructions and `nextSteps` asked for compose → review → request (and validate, simulate) although `request_user_approval` already re-composes, re-checks the hash and refuses review blockers | Instructions and `nextSteps` (where the connection can request approvals): compose (or plan) → `request_user_approval`; review, validate and simulate are optional. `workflowHash` stays required |
| Generic `ROUTER_NO_EXECUTABLE_ROUTE` | `router-service.ts` collected each provider's refusal and threw the generic code; MCP worded it with the generic "could not complete this step" | The certified Router throws the first provider's definitive refusal (e.g. `LIFI_NO_ROUTE`, `LIFI_UNDERLYING_PROTOCOL_NOT_RECONCILABLE`), as the Universal Router already does, or `ROUTER_PROVIDER_UNAVAILABLE` for an outage (never a provider HTTP status); the generic code remains when neither applies. MCP says "no bridge route FloFi can verify and execute for this amount" or "temporarily unavailable, try again". The web Simulate text and the Router panel keep their no-route sentence for these codes (both routers). **Intentional change of the certified Router's refusal code** (route selection, simulation and recovery unchanged): owner approval requested |
| Inconsistent financial presentation by the host | `simulate_strategy` returned base units and asked the host to convert | `display.EN` / `display.PT` (new `mcp/financial-display.ts`) built with the shared six-significant-digit rule (`≈` only for an estimate, a minimum rounded down), a mocked preview labelled as such; the instructions say to quote it verbatim in the person's language. Exact facts unchanged; swap quotes and cross-chain routes for now |

Compact receipts, six-significant-digit formatting and automatic reconciliation are unchanged.

## 3. Production configuration (read 26-11-2026, nothing changed)

| Item | Where | Value / evidence |
|---|---|---|
| Deployed commit | `GET https://flofi.xyz/api/flofi/readiness` | `b2ffdb53…` on `main`, runtime `READY` |
| `FLOFI_WORKFLOW_RUNS` | same readiness report (`workflows.runs`, read from the web tier's own environment) | **ENABLED**. The variable exists; the Vercel env listing used for the earlier inspection is truncated (70 of 170 entries omitted), which is why it looked absent |
| `FLOFI_USER_FUNDED_EXECUTION` | Vercel production (plain) and readiness `workflows.userFunded` | `enabled`; readiness **ENABLED** |
| `FLOFI_USER_FUNDED_CHAINS` | Vercel production (plain) | `eip155:1, eip155:8453, eip155:42161, eip155:4663, solana:5eykt4Us… (mainnet)` (Arbitrum One included); `FLOFI_USER_FUNDED_RPC_42161` present |
| Editor runs | readiness `workflows.editorRuns` | ENABLED |
| Migrations | Neon production (previous BUILD) | 0032 and 0033 applied with certified checksums; schema 36. No migration here |
| `FLOFI_MCP_FRAME_ANCESTORS` | Vercel | Not determinable from the truncated listing. Not needed for the default ancestors (`chatgpt.com`, `web-sandbox.oaiusercontent.com`, Claude's per-server sandbox, `claude.ai`); set it only to an origin the panel reports in `notAllowed` |
| Privy production app | `auth.privy.io/api/v1/apps/<appId>` (public) | `solana_wallet_auth: false` (root cause of P0-1), `wallet_auth: true`, `allowed_domains: ["https://flofi.xyz"]` |

Single confirmation for an eligible USDC → WETH swap on Arbitrum One with MetaMask: every server-side condition of the one-step run (PR #256 WS03) holds in
production (MCP account requester, `arbitrum-swap` grouped flow, workflow runs and user-funded groups enabled on `eip155:42161`, single-step run schema).
Whether it is one wallet confirmation then depends on the owner's MetaMask answering `wallet_getCapabilities` with atomic batching on Arbitrum One;
otherwise the Review says STEP_BY_STEP (two confirmations). Only a real-host run can confirm it.

## 4. Decision for the CTO: the mobile wallet transport (P0-2)

Every `@walletconnect/*` package since 2.22.0 (20-08-2025; latest 2.26.0) is under the **WalletConnect Community License**, not Apache-2.0:
royalty-free only up to 500 monthly active users and 2.5 million relay calls, a paid commercial licence above; use must connect to Reown's gateway;
modifications are assigned to Reown; confidentiality terms. That conflicts with FloFi's AGPL-3.0-only distribution and is a paid service beyond
the thresholds. The last Apache-2.0 line is 2.21.x, which receives no fixes. A Reown project id (an account with Reown) is required either way.
MetaMask's own SDK carries the ConsenSys non-commercial licence (already rejected in `pnpm-workspace.yaml`).

Options:
1. **WalletConnect 2.21.x (Apache-2.0), pinned**, behind a `FLOFI_WALLETCONNECT_PROJECT_ID` gate (off when unset): the in-chat panel (ChatGPT,
   Claude) and a Telegram Mini App run the session; the wallet shows the batch or transaction itself; FloFi's existing claim, Review and
   reconciliation stay the authority. Needs: licence approval of an unmaintained line, a Reown project, the hosts' `connect_domains` review.
2. **Current WalletConnect under the Community License**: legal review of AGPL compatibility and the commercial thresholds first.
3. **No relay transport**: keep the deep link to the wallet browser and make that page open the Review directly (no navigation), accepting that
   the owner still acts on a FloFi page inside the wallet.

Recommendation: none yet. Option 1 reuses the existing EIP-1193 wallet path unchanged, but flofi-security advises against freezing a signing channel on
an unpatched line; option 2 needs legal review; option 3 keeps a FloFi page in the flow. The CTO decides; nothing is implemented until then.

## 5. Required production configuration (for CTO approval; none applied)

1. Privy dashboard, production app: enable **Solana** for external wallet login. Without it Solflare cannot sign in (P0-1).
2. ChatGPT: refresh (or reconnect) the FloFi connector so the host fetches the current tool descriptors and panel (P0-2 evidence).
3. `FLOFI_MCP_FRAME_ANCESTORS` (Vercel): only the exact origins a failing panel reports in Technical details → `notAllowed`.
4. WalletConnect: only after the §4 decision (`FLOFI_WALLETCONNECT_PROJECT_ID`, Reown account).

## 6. Validation

- New: `apps/reference-dapp/src/mcp/post-257-hotfix.test.ts` (the incident request composes and plans as one Universal Bridge with the same hash,
  no swap, no cap; schema and instructions; discovery; native ETH; one-call approval path; linked-wallet beneficiary; specific messages; display
  lines, including the 24-11 incident amounts).
- Updated: `privy-client.test.ts`; `strategy-engine.test.ts`, `channels/core/strategy.test.ts`, `domain/authoring-capabilities.test.ts` (the 12 new
  examples are byte-identical through the chat, the channels and the natural-language Copilot; that test now loads the same fixture catalogs as the
  Copilot bridge tests); `router-service.test.ts`, `router-arbitrum-certification.test.ts` (specific refusal codes); `arbitrum-certification.test.ts`
  and `runtime-selection.test.ts` (native ETH actions; the new rows run on the universal runtime); `parity.test.ts` (an explicit time budget for the
  larger enumeration, same checks).
- Local runs (Node 22 container; CI pins Node 24): focused suites and the whole unit suite; remaining local failures are live/fork/remote suites without
  network or Anvil and two CLI tests that need Node 24's type stripping. PostgreSQL suites for the MCP gateway, OAuth gateway, handoff and panel: pass.
- Regenerated: both capability matrices, the Developer API OpenAPI document (schema descriptions), `COVERAGE.md`.
- CircleCI certification: recorded on the PR.

## 7. Specialist reviews

flofi-security, flofi-mcp and flofi-bridge (read-only) reviewed the working tree. Findings and resolution:

| Reviewer | Finding | Resolution |
|---|---|---|
| security | Privy change can only narrow the offered wallets; server sign-in does not depend on the modal | No change needed |
| security (low) | `accountWallets` scope enforced only in the gateway | Checked again in `plan_strategy` (`flofi.runs`) |
| security, mcp (medium) | "Use linked wallets instead of asking for an address" was broader than the code (recipients, simulation subjects, consent gate) | Narrowed to the Aave supply beneficiary in `plan_strategy`; never a recipient, beneficiary or subject the person did not choose |
| security (low) | Provider HTTP statuses (401/403) could reach a person | Outages surface as `ROUTER_PROVIDER_UNAVAILABLE` |
| bridge (medium) | New Router codes fell to generic Simulate wording | Simulate text, build estimate and MCP map the definitive refusals to the no-route sentence (both routers) |
| bridge, mcp (medium) | `bridge` advertised for every list token, Stock Tokens included | Limited to native ETH, USDC, USDG, USDT and WETH |
| bridge (low) | Binding text still invited a cap | Binding `step` description updated |
| mcp (low) | Wallet read for every plan; no source marker; doc said FloFi never substitutes | Read only for a supply step; `beneficiarySource`; goal-strategy doc updated |
| mcp (low) | `nextSteps` named `request_user_approval` for connections that cannot request approvals | Conditional on `canRequestApproval` |
| mcp (low) | `display` EN only, unconditional note, no provenance | `display.EN`/`display.PT`, note only when present, mocked previews labelled |
| security | Do not pin WalletConnect 2.21.x (frozen signing channel) | Recorded in §4 for the CTO decision |

Not addressed (stated): a gateway-level PostgreSQL test of `accountWallets` (the rule is unit-tested through `goalBeneficiary`; the scope check is
one line in the tool).

## 8. Real-host acceptance (owner)

1. Sign-in: Phantom (desktop extension) signs in; after enabling Solana at Privy, Phantom (Solana) and Solflare sign in on desktop and in their
   mobile in-app browsers; MetaMask, Google and email unchanged.
2. ChatGPT, after refreshing the connector: "0.0003 ETH on Base to USDC on Arbitrum One" shows one Universal Bridge card with independent assets and
   no cap; a refusal names its real reason.
3. ChatGPT: "Swap 1 USDC to WETH on Arbitrum One", Authorize in chat with MetaMask: count the wallet confirmations; if the frame fails, send the
   panel's `code`, `frameChain` and `notAllowed`.
4. Mobile signing without FloFi navigation: blocked on §4.
