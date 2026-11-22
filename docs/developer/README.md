# FloFi for Developers

FloFi Web supports owner-authorized mainnet workflows on Base, Arbitrum One, Ethereum, Solana and Robinhood Chain. The
[supported networks guide](https://flofi.xyz/docs/supported-networks) covers registered swaps, bridges, transfers, Aave V3
lending and Uniswap V3 and Orca liquidity. Route, wallet and deployment policy determine which operations, fee options and
step groupings are available.

Use FloFi from a third-party server to discover deployment capabilities. In a local engineering sandbox, your server can also
create, validate and preview a strategy, then give the user a link to review it in FloFi. The user proves ownership, runs FloFi's
fresh simulation and reviews the Strategy Manifest. Any execution requires their wallet signature. Your app sees execution
status and reconciled evidence only with the user's consent.

| Surface | Availability |
| --- | --- |
| Developer guides and OpenAPI | Public on [FloFi](https://flofi.xyz/developers). |
| Developer API discovery | The public deployment exposes `GET /capabilities`. Use an operator-issued sandbox key from that deployment. |
| TypeScript SDK | Private workspace package. Use the repository source. No npm distribution. |
| Strategy creation, validation, preview and handoff with test funds | Local engineering sandbox with enabled flows and the required API scopes. The MOCKED browser journey reaches Review with signing blocked. |
| Approval status and signed webhooks | Operator-enabled API with the corresponding scopes. Dispatch depends on configured delivery, approval activity or the operator's scheduler. |
| Shared execution status and evidence | Requires an eligible approval, the user's sharing consent and, for evidence, a reconciled run. |
| MCP and Telegram | ChatGPT and Claude use configured MCP connectors with FloFi OAuth and beta access. The official Telegram bot uses channel-specific policy. Eligible handoffs lead to FloFi for wallet authorization. See [MCP integrations](https://flofi.xyz/docs/mcp-integrations). |
| Mainnet strategies through the Developer API, hosted test networks and live keys | Blocked by current policy. |
| Public SDK publishing, self-service keys and other deferred API features | See [v1 scope](API.md#not-in-v1-yet). |

Request sandbox access [via FloFi on X](https://x.com/FloFi_xyz) or contact your deployment's operator. Keys are issued by the
operator and belong in a server-side secret store.

| Document | What it covers |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | The ten-step integration with the TypeScript SDK |
| [API.md](API.md) | Endpoints, conventions, scopes, errors, limits, idempotency |
| [WEBHOOKS.md](WEBHOOKS.md) | Events, signatures, verification, retries, rotation |
| [openapi.json](openapi.json) | OpenAPI 3.1, generated from the server's own schemas |
| [`packages/developer-sdk`](../../packages/developer-sdk/README.md) | The thin TypeScript client (Apache-2.0, zero dependencies) |
| [deploy/DEVELOPER.md](../deploy/DEVELOPER.md) | For the deployment's operator: enabling, keys, scheduler, runbook |

## What your API key can and cannot do

| Your server can in an eligible sandbox | Only the end user can, in FloFi, with their own wallet |
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

The public FloFi product is mainnet-only. The Developer API accepts sandbox credentials only. It refuses a valid mainnet
strategy with `403 MAINNET_DISABLED` and live credentials with `403 FORBIDDEN` (`LIVE_MODE_DISABLED`). Public deployments refuse
test-network strategies with `400 INVALID_STRATEGY` (`TEST_NETWORK_NOT_AVAILABLE`). Those restrictions apply to hosted previews
as well as production. Capability discovery and other authorized project operations remain available where the API, key and data permit them.

The [Quickstart](QUICKSTART.md) uses non-hosted engineering mode and a local MOCKED bridge. Its preview is marked `MOCKED`.
