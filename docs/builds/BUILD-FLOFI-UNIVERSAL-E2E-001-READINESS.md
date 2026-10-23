# FloFi end-to-end readiness — customer view (2026-10-23)

This is the plain-language companion to the [BUILD-FLOFI-UNIVERSAL-E2E-001 report](BUILD-FLOFI-UNIVERSAL-E2E-001-REPORT.md). It states
what a customer can rely on today, what has been proven on public blockchains, and what has not. It is based on the release `flofi.xyz`
served on 2026-10-23 (`78ea792`). The corrections in this build are not live until the owner merges and promotes them.

## What FloFi does today

You can do the following without an administrator and without giving FloFi your keys:

1. Open `flofi.xyz`, or describe what you want in ChatGPT or Claude (through the FloFi MCP connector), Telegram, or FloFi's own chat.
2. Connect your own wallet:
   - an EVM browser wallet such as MetaMask, or a wallet's in-app browser;
   - a Solana Wallet Standard wallet such as Phantom.
3. Build a workflow: swaps, transfers, bridges, Aave lending (supply, borrow, repay, withdraw), liquidity positions, and the lending
   composition. The full list per network is in the report's matrix.
4. See a fresh simulation with real quotes and balances, then review the exact network, wallet, tokens, amounts, slippage, fees and
   limits.
5. Approve in your own wallet. FloFi never signs for you, and every transaction needs your wallet's confirmation.
6. Follow the status, see the transaction links, get the reconciled result and its evidence, and resume safely after a reload.

A conversation never needs the Canvas. A chat request opens a short FloFi signing page where you review and approve.

## What has been proven on public blockchains

Every transaction in this table was signed by the owner's own test wallets. All of them were re-checked on the public chains on
2026-10-23.

| Network | Proven operations |
| --- | --- |
| Base Sepolia (test funds) | Uniswap swap; Aave supply, borrow, repay and withdraw; Uniswap liquidity position |
| Solana Devnet (test funds) | Orca swap; Orca position open, partial removal and exit; swap → position in one workflow (with Phantom) |
| Robinhood Chain Testnet (test funds) | Native transfer |

These runs were made on earlier releases. The owner plans to repeat them on the corrected release.

## What is not yet proven

- **Mainnet with real funds: nothing yet.** Base, Arbitrum One, Ethereum, Robinhood Chain and Solana mainnet operations are built and
  switched on. No real-funds transaction through FloFi has been recorded and verified yet. Until it has, treat mainnet use as
  unverified.
- **Ethereum Sepolia, the Base Sepolia → Arbitrum Sepolia bridge, the lending composition and Solana Devnet transfers** are built, but
  have not been run on their public networks.
- **Independent customers:** so far only the owner's wallets have executed transactions. A first run by an outside wallet is planned.

## Known limits

- **Workflows of several steps:** you confirm each step in your wallet, in order. A step that should spend exactly what an earlier step
  received is not supported yet. Whether multi-step workflows are switched on in production must be confirmed by the owner.
- **One approval for a whole workflow** (delegated execution) is not available in production.
- **Liquidity removal:**
  - On Solana, removing liquidity is available on the FloFi Canvas only.
  - Removing a Uniswap position is not available on any EVM network.
- **Pending owner approval:** chat, MCP and Telegram cannot create Solana mainnet liquidity positions or testnet native transfers. The
  Canvas can.
- **Mobile:** there is no WalletConnect. Use a wallet's in-app browser.
- **WhatsApp** is not available. It awaits a policy clearance.
- **No EVM ↔ Solana bridge.**

## Fixed in this build (pending release)

- **A request on one network could show the review of another workflow.** A Base Sepolia request could show the authorization details
  of an earlier Solana Mainnet simulation from the same browser. It could not be approved, but it was wrong and blocked the request.
  FloFi now shows and accepts only the review of the exact request, on its own network and with the matching wallet.
- **Arbitrum One and Ethereum liquidity requests from chat or MCP could not be simulated** in FloFi. They now reach the correct flow.
