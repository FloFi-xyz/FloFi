# FloFi for Developers

FloFi Web supports owner-authorized mainnet workflows on Base, Arbitrum One, Ethereum, Solana and Robinhood Chain. The
[supported networks guide](https://flofi.xyz/docs/supported-networks) covers registered swaps, bridges, transfers, Aave V3
lending and Uniswap V3 and Orca liquidity. Route, wallet and deployment policy determine which operations, fee options and
step groupings are available.

Use FloFi from a third-party server to discover deployment capabilities, create and preview a strategy, and give the user a
link to review it in FloFi. Live mainnet integration requires explicit production activation. The user proves wallet ownership,
reviews a fresh simulation and Strategy Manifest for each live step, and signs in FloFi. Your app sees execution status and
reconciled evidence with the user's consent.

| Surface | Availability |
| --- | --- |
| Developer guides and OpenAPI | Public on [FloFi](https://flofi.xyz/developers). |
| Developer API discovery | Use an active project key from the deployment to call `GET /capabilities`. |
| Developer Console | Create and manage account-owned projects on an enabled deployment. Local engineering supports sandbox key issuance. Production key issuance requires live activation. |
| TypeScript SDK | Build a versioned tarball from the repository and install it in your backend. Registry publication is pending. |
| Strategy creation, validation, preview and handoff with test funds | Local engineering sandbox with enabled flows and the required API scopes. The MOCKED browser journey reaches Review with signing blocked. |
| Approval status and signed webhooks | API with the corresponding scopes. The operator must configure and verify a scheduler for live delivery. |
| Shared execution status and evidence | Requires an eligible approval, the user's sharing consent and, for evidence, a reconciled run. |
| MCP and Telegram | ChatGPT and Claude use configured MCP connectors with FloFi OAuth and beta access. The official Telegram bot uses channel-specific policy. Eligible handoffs lead to FloFi for wallet authorization. See [MCP integrations](https://flofi.xyz/docs/mcp-integrations). |
| Mainnet strategies and live keys | Requires explicit production activation, an account-owned project and deployment eligibility for each step. |
| Other deferred API features | See [v1 scope](API.md#not-in-v1-yet). |

Contact your deployment's operator for availability. Store every key in your backend's secret store.

| Document | What it covers |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | The local sandbox walkthrough and gated mainnet integration with the TypeScript SDK |
| [API.md](API.md) | Endpoints, conventions, scopes, errors, limits, idempotency |
| [WEBHOOKS.md](WEBHOOKS.md) | Events, signatures, verification, retries, rotation |
| [openapi.json](openapi.json) | OpenAPI 3.1, generated from the server's own schemas |
| [`packages/developer-sdk`](../../packages/developer-sdk/README.md) | The thin TypeScript client (Apache-2.0, zero dependencies) |
| [deploy/DEVELOPER.md](../deploy/DEVELOPER.md) | For the deployment's operator: enabling, keys, scheduler, runbook |

## What your API key can and cannot do

| Your server can on an eligible deployment | Only the end user can, in FloFi, with their own wallet |
| --- | --- |
| discover capabilities per action and network | prove which wallet they are |
| store immutable strategies (FloFi's StrategySpec) | load a proposal into their FloFi workflow |
| validate and simulate them (read-only previews) | run the authoritative fresh simulation |
| create an approval and get its FloFi link | review the Strategy Manifest and approve it |
| follow the approval's state | sign each transaction |
| read runs and evidence **the user chose to share** | decide whether your app may see the outcome (off by default) |

The key is a **server-side credential with zero financial authority**. It is not a wallet, never a wallet session, and nothing it
can call signs, submits or approves anything. FloFi refuses requests from browsers (`BROWSER_ORIGIN_FORBIDDEN`): never ship a key
to a web page or a mobile app.

## One engine, one execution truth

The Developer API is a surface over the same FloFi platform as the FloFi app and the MCP gateway: the same composition, canonical
IR and workflow hash, Strategy Review, capability facts, simulation preview and approval handoff. A strategy created through the
API has exactly the workflow hash FloFi's own chat or MCP would compute. Evidence is copied from FloFi's Evidence Bundles (MOCKED,
TESTNET_EXECUTED, …) and never upgraded.

## Environments

The public FloFi product is mainnet-only. Sandbox credentials can discover capabilities and use test-network strategies on a
local engineering deployment. Public deployments refuse test-network strategies with `400 INVALID_STRATEGY`
(`TEST_NETWORK_NOT_AVAILABLE`). Live keys work only on a production deployment with explicit live activation. With live
access disabled, those keys receive `403 FORBIDDEN` (`LIVE_MODE_DISABLED`).

The [local walkthrough](QUICKSTART.md) uses a MOCKED bridge and reaches Review with signing blocked. The
[mainnet integration](QUICKSTART.md#mainnet-integration) describes the live path once the release conditions are met.
