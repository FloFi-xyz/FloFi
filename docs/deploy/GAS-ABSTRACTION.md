# Token-paid network fees: enabling, costs, validation and rollback

BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 ([ADR-0010](../adr/ADR-0010-token-paid-network-fees.md)). Every mechanism is **off** until its switch is
set. Steps marked **[OWNER]** create an account, may cost money, move real funds or change production; none was performed during engineering, and
no credential, contract address, payment address or balance below was invented.

## 0. What changes for users

| Network | When the wallet holds enough native gas | When it does not |
| --- | --- | --- |
| Ethereum, Base, Arbitrum One | unchanged: the wallet pays in ETH | workflow runs (Editor *Review whole workflow*, `/approve`) can pay the network fee in **USDC through Circle Paymaster**, for an account that is an EIP-7702 smart account on the right EntryPoint (§2.1); two signatures: a USDC permit, then the operation |
| Solana | unchanged: the wallet pays in SOL | Jupiter swaps, SPL transfers and Solana workflow steps can pay the fee in **USDC or USDT to Pimlico**, whose hosted Kora fee payer fronts the SOL; one signature |
| Robinhood Chain | unchanged: Uniswap v3, the wallet pays in ETH | ERC-20 swaps can run through the **0x Gasless API**: 0x's relayer sends the trade and the fee is taken from the swap; one or two signatures (an optional gasless approval, then the trade) |

Nothing is ever free: the Review shows what the owner pays, in which token, and to whom. FloFi pays no gas by default. ADR-0009's FloFi-paid
sponsorship ([GAS-SPONSORSHIP.md](GAS-SPONSORSHIP.md)) is a separate feature and stays off.

## 1. Costs: what is free, what can cost money

| Item | Who pays | Notes |
| --- | --- | --- |
| Circle Paymaster | **the user**, in USDC: the gas cost plus Circle's published surcharge (10 % of the gas cost) | permissionless: no Circle account, key or deposit |
| ERC-4337 bundler (Circle path) | **[OWNER]** the operator's bundler plan, if any (e.g. Pimlico, Alchemy) | a service fee, not gas: the EntryPoint repays the bundler from Circle's deposit |
| Pimlico Solana (Kora) | **the user**, in USDC/USDT, for the SOL fee and any token-account rent | **[OWNER]** Pimlico API credits: the free plan has no mainnet; pay-as-you-go needs a card (about 1,202 credits per token-paid transaction; $1 per 100,000 credits after the included 10M credits/month) |
| Pimlico residual | **[OWNER]** the operator's Pimlico balance | if a transaction that passed simulation fails on chain, its SOL fee (about 5,000–10,000 lamports plus the capped priority fee) is charged to the operator; the user's token payment reverts with it |
| 0x Gasless | **the user**: 0x's gas fee and 0x's own fee are taken from the swap | **[OWNER]** 0x dashboard plan; **never** enable 0x's app-level sponsorship (FloFi refuses any quote without a positive gas fee) |

## 2. Configuration (server-only; names are final, values are the operator's)

### 2.1 Circle Paymaster — Vercel web tier **and** Railway `flofi-worker`

| Variable | Value |
| --- | --- |
| `FLOFI_CIRCLE_USDC_GAS` | `enabled` |
| `FLOFI_CIRCLE_USDC_GAS_CHAINS` | optional subset of `eip155:1,eip155:8453,eip155:42161` (default: all three) |
| `FLOFI_USER_FUNDED_EXECUTION`, `FLOFI_USER_FUNDED_CHAINS`, `FLOFI_USER_FUNDED_RPC_<chainId>` | existing ([USER-FUNDED-EXECUTION.md](USER-FUNDED-EXECUTION.md) §4) |
| `FLOFI_BUNDLER_RPC_<chainId>` | **[OWNER]** an ERC-4337 bundler URL that serves EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (Base, Arbitrum One) and/or v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` (Ethereum, Base, Arbitrum One), e.g. `https://api.pimlico.io/v2/<chainId>/rpc?apikey=…` — **secret** |
| `FLOFI_AUTOMATION_PRICE_SOURCE`, `FLOFI_AUTOMATION_CHAINLINK_RPC_URL`, `FLOFI_AUTOMATION_CHAINLINK_FEEDS` | existing deployment price source with an `ETH=` feed: the ETH/USD price that sizes the USDC permit cap |

Circle's paymaster and USDC addresses are pinned in code and verified on chain at first use. Accounts that can use it: an EOA delegated with
EIP-7702 to MetaMask's `EIP7702StatelessDeleGator` v1.3.0 (EntryPoint v0.7: Base, Arbitrum One) or to `Simple7702Account` v0.8 (EntryPoint v0.8:
Ethereum, Base, Arbitrum One). FloFi never creates or changes a delegation.

### 2.2 Pimlico hosted Kora — Railway `flofi-api` (Jupiter, transfers) **and** Vercel + `flofi-worker` (Solana workflow groups)

| Variable | Value |
| --- | --- |
| `FLOFI_KORA_TOKEN_GAS` | `enabled` |
| `FLOFI_PIMLICO_KORA_RPC_URL` | **[OWNER]** `https://solana.pimlico.io/v1/mainnet/rpc?apikey=<key>` — **secret**; any other host or a devnet path disables Kora |
| `FLOFI_KORA_SIGNER` | the fee payer the endpoint answers `getPayerSigner.signer_address` with (pinned; any other answer is refused) |
| `FLOFI_KORA_PAYMENT_ADDRESS` | `getPayerSigner.payment_address` (pinned) |
| `FLOFI_KORA_FEE_TOKENS` | optional `USDC`, `USDT` or `USDC,USDT` (default both) |

Read the two pins once, from a trusted shell (the key stays in your shell, never in Git or chat):
`curl -sS -X POST "$FLOFI_PIMLICO_KORA_RPC_URL" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getPayerSigner","params":{}}'`.

### 2.3 0x Gasless — Railway `flofi-api` and `flofi-worker`

| Variable | Value |
| --- | --- |
| `FLOFI_ZEROX_GASLESS` | `enabled` |
| `FLOFI_ZEROX_API_KEY` | **[OWNER]** a 0x dashboard API key with **Gasless enabled** for the app — **secret** |
| `FLOFI_ZEROX_API_URL` | leave unset (`https://api.0x.org`) |

Robinhood swaps also need the existing gates (`GRYLOO_ROBINHOOD_MAINNET=live`, `GRYLOO_ROBINHOOD_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`).
Stock Tokens are tradable through 0x only if 0x enabled tokenized-equity access for the API key **[OWNER]**; otherwise 0x refuses them and FloFi
says so before anything is signed.

## 3. Enable, one network at a time

1. Set the variables of one mechanism on the tiers above and redeploy.
2. Check readiness: the switches report `ENABLED` or their closed code (never a URL, key or pin).
3. Run §5's validation with a small amount before announcing the network.

## 4. Disable without breaking normal execution

Unset the switch (`FLOFI_CIRCLE_USDC_GAS`, `FLOFI_KORA_TOKEN_GAS`, `FLOFI_ZEROX_GASLESS`) and redeploy. New Reviews are native-only immediately;
a wallet with enough ETH/SOL is unaffected in every case. An operation already submitted keeps being observed and reconciled. A Review prepared
with a token mechanism and not yet signed is refused at authorization (`GAS_MECHANISM_CHANGED_REVIEW_REQUIRED`) and asks for a new Review.

## 5. Validate in production with small amounts **[OWNER]**

Each check is an explicit owner action through the reviewed wallet flow; none is automated.

1. **Native unchanged** (every network): with a wallet that holds a little ETH/SOL, run a small swap; the Review shows the native fee as before.
2. **Base or Arbitrum, Circle**: an account upgraded to the MetaMask smart account, holding about 2 USDC and no ETH; in the Editor run a 1 USDC
   transfer to yourself with *Review whole workflow*; the Review shows the USDC fee ceiling and two signatures; after it lands, the run shows
   *Network fee paid: X USDC* and the explorer's `UserOperationEvent` names Circle's paymaster.
3. **Ethereum, Circle v0.8**: only with an account delegated to `Simple7702Account` v0.8; a MetaMask smart account is shown the closed reason
   instead.
4. **Solana, Kora**: a wallet with 0 SOL and about 2 USDC; swap 1 USDC → SOL on Jupiter; the Review shows *Network fee: X USDC (paid to
   Pimlico)*; the explorer shows Pimlico's fee payer and the USDC transfer to the payment address.
5. **Robinhood Chain, 0x**: a wallet with 0 ETH and about 5 USDG; swap 2 USDG → WETH; the Review shows *Network fee (included in the swap)*;
   the run reconciles from the Settler's transaction with the wallet's ETH unchanged.

## 6. Monitoring and security signals

- `TOKEN_GAS_RELAYER_NOT_PINNED`, `KORA_SIGNER_MISMATCH`, `CIRCLE_PAYMASTER_UNVERIFIED`, `ZEROX_SETTLER_MISMATCH`, `ZEROX_SPONSORED_QUOTE_REFUSED`:
  a provider answered with something other than what is pinned — investigate before re-enabling.
- Pimlico: `pimlico solana txs --type sponsored` must stay empty (a sponsored transaction means a payment-less transaction reached Pimlico,
  which FloFi refuses to send).
- 0x: the dashboard's sponsorship setting must stay off.
