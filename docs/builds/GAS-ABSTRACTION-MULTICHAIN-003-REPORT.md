# BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 — Token-paid network fees on FloFi's five networks

Branch `claude/laughing-mccarthy-gdvf0m`, base `origin/main` @ `d439d72` (includes PR #190). Architecture:
[ADR-0010](../adr/ADR-0010-token-paid-network-fees.md). Runbook: [GAS-ABSTRACTION.md](../deploy/GAS-ABSTRACTION.md).

**Evidence level.** Every result below is **unit / PostgreSQL / browser on deterministic loopback doubles** (a bundler and EntryPoint double with
Circle paymaster semantics, a Pimlico Kora JSON-RPC double, a 0x Gasless API double, the existing MOCKED chain harnesses). No provider, bundler,
wallet or mainnet was contacted; **no transaction was signed or sent and no funds moved**. Nothing here is mainnet certification: each mechanism
needs the owner's small-value acceptance (runbook §5) once its credentials exist. Provider documentation hosts were not reachable from the build
sandbox; provider facts come from the providers' published sources (npm packages, GitHub sources, the 0x OpenAPI spec) and are tagged by
evidence level in the ADR.

## 1. What was built

| Mechanism | Networks | Where it runs | Owner pays | Signatures |
| --- | --- | --- | --- | --- |
| `NATIVE_WALLET_GAS` (default) | all five | every flow, unchanged | ETH / SOL | as before |
| `CIRCLE_USDC_PAYMASTER` | Ethereum, Base, Arbitrum One | workflow runs (Editor *Review whole workflow*, `/approve`) | USDC: gas + Circle's surcharge, capped by a permit | 2 (permit, operation); FloFi Wallet first use 3 (upgrade, permit, operation) |
| `PIMLICO_KORA_SPL_FEE` | Solana | Jupiter swap, SPL/Token-2022 transfer (card and workflow owner steps), Solana sign-all workflow groups | USDC or USDT, the exact quote, to Pimlico's payment address | 1 |
| `ZEROX_GASLESS_SWAP` | Robinhood Chain | ERC-20 swaps through `robinhood-swap` (card, workflow owner steps) | the swap's own tokens (0x gas fee + 0x fee) | 1 (trade) or 2 (gasless approval, trade) |

Selection (ADR-0010 §2): native whenever it covers the worst-case fee; the chain's token mechanism only when native is short **and** the mechanism
proves itself eligible; otherwise native with every reason. Bound at Review; re-checked at authorization (`GAS_MECHANISM_CHANGED_REVIEW_REQUIRED`).
S1 second narrowing: a non-owner native payer only with a pinned-relayer `tokenFee` claim and a positive owner-paid amount. FloFi never pays.

## 2. Real compatibility matrix

### 2.1 Network × wallet

| Network | MetaMask | Other injected EVM (Rabby, …) | Coinbase Smart Wallet | FloFi Wallet (Privy) | Phantom / Solflare |
| --- | --- | --- | --- | --- | --- |
| **Base** | ETH; **Circle v0.7** when the account is already a MetaMask smart account (2 signatures) | ETH; Circle only if delegated to `Simple7702Account` v0.8 | ETH (EntryPoint v0.6: `CIRCLE_ACCOUNT_UNSUPPORTED`) | ETH; **Circle v0.8** after an explicit EIP-7702 upgrade (3 then 2 signatures) | — |
| **Arbitrum One** | same as Base | same as Base | same as Base | same as Base | — |
| **Ethereum** | **ETH only** (`CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED`: DeleGator is v0.7, Circle on Ethereum is v0.8 only; evidence in ADR-0010 §3) | ETH; Circle v0.8 if delegated to `Simple7702Account` | ETH | ETH; **Circle v0.8** after the explicit upgrade | — |
| **Robinhood Chain** | ETH (Uniswap v3); **0x Gasless** for ERC-20 swaps from a plain EOA (a 7702-delegated MetaMask account: `ZEROX_OWNER_NOT_EOA`) | ETH; 0x Gasless (EOA) | ETH; `ZEROX_OWNER_NOT_EOA` | ETH; **0x Gasless** (bound typed-data signing) | — |
| **Solana** | — | — | — | SOL; **Kora** USDC/USDT (owner signs slot 1) | SOL; **Kora** USDC/USDT (sign-only of the owner's slot) |

Every "ETH/SOL" cell is the unchanged traditional path. A plain MetaMask EOA that was never upgraded is `CIRCLE_SMART_ACCOUNT_REQUIRED` on Base and
Arbitrum (the MetaMask upgrade itself is a type-4 transaction paid in ETH). Wallet behaviour marked here was verified against the wallets'
published sources and the doubles, **not** live: Phantom/Solflare partial signing with a foreign fee payer, Privy's EIP-7702 signing and each
wallet's typed-data prompts need the owner's live acceptance.

### 2.2 Operation × mechanism

| Operation | Circle | Kora | 0x Gasless |
| --- | --- | --- | --- |
| Swap | in a workflow group | Jupiter (USDC↔SOL with Kora-paid wSOL rent, USDC↔USDT) | ERC-20 → ERC-20 / native; selling native ETH: `ZEROX_GASLESS_NATIVE_SELL_UNSUPPORTED` |
| Transfer | in a group | SPL and Token-2022, recipient ATA rent paid through the fee; native SOL: `KORA_OPERATION_UNSUPPORTED` | not a swap: native |
| Aave supply / borrow / withdraw / repay | in a group (whole-batch simulation) | — | native |
| Bridge source | Across deposit inside a group (delivery verified from the operation's own logs) | Relay Solana deposit: `KORA_OPERATION_UNSUPPORTED` | native |
| Liquidity (Orca, Uniswap) | native | native | native |
| Multistep workflow | yes; later native-only steps are named before the first signature | yes (one Kora payment per transaction) | owner steps; a short-ETH Robinhood batch halts into step mode |

### 2.3 Classification required by the owner

| Category | Items |
| --- | --- |
| **Implemented and tested (loopback)** | all rows above: selection policy, S1 claim, Circle v0.7/v0.8 (MetaMask DeleGator, Simple7702, FloFi Wallet upgrade), Kora flows and groups, 0x Gasless flow and FloFi Wallet typed data, reconciliation, recovery, PT/EN UX |
| **Implemented, depends on a credential** | Circle: a bundler URL serving EntryPoint v0.7 and v0.8 (`FLOFI_BUNDLER_RPC_<chainId>`) and the Chainlink ETH/USD price source; Kora: a Pimlico pay-as-you-go API key; 0x: an API key with Gasless enabled |
| **Implemented, not certified on mainnet** | every mechanism (no live provider, wallet or chain was used) |
| **Not supported by the provider / wallet** | Circle on EntryPoint v0.6 (Coinbase Smart Wallet); Circle for MetaMask on Ethereum; Circle on Robinhood Chain; 0x selling native ETH, non-permit tokens without a Permit2 allowance, Stock Tokens without 0x's tokenized-equity opt-in, ERC-1271/7702 owners; Kora native SOL transfers, Relay deposits, Orca liquidity (3 signers) |

## 3. Configuration and operational costs

| Mechanism | Variables (tier) | Free | Costs money (who pays) |
| --- | --- | --- | --- |
| Circle | `FLOFI_CIRCLE_USDC_GAS=enabled`, optional `FLOFI_CIRCLE_USDC_GAS_CHAINS`; existing `FLOFI_USER_FUNDED_*`, `FLOFI_BUNDLER_RPC_<id>` (secret), `FLOFI_AUTOMATION_PRICE_SOURCE=chainlink` + feeds (Vercel web + `flofi-worker`) | Circle paymaster (permissionless, no account) | user: gas + 10 % surcharge in USDC; operator: the bundler plan (service fee, not gas) |
| Kora | `FLOFI_KORA_TOKEN_GAS=enabled`, `FLOFI_PIMLICO_KORA_RPC_URL` (secret), `FLOFI_KORA_SIGNER`, `FLOFI_KORA_PAYMENT_ADDRESS`, optional `FLOFI_KORA_FEE_TOKENS` (Railway `flofi-api` + `flofi-worker`, Vercel for groups) | — (Pimlico's free plan has no mainnet) | user: SOL fee + any token-account rent, in USDC/USDT; operator: Pimlico credits (~1,202 per transaction; $1 per 100,000 after the included 10M/month) and the SOL fee of a transaction that passed simulation but failed on chain |
| 0x | `FLOFI_ZEROX_GASLESS=enabled`, `FLOFI_ZEROX_API_KEY` (secret) (Railway `flofi-api` + `flofi-worker`) | the API on 0x's plan limits | user: 0x gas fee + 0x fee, inside the swap; operator: the 0x plan; 0x sponsorship must stay **off** (FloFi refuses a quote without a positive gas fee) |

## 4. Review and its fixes

Nine read-only specialists reviewed the merged build (security, wallet-execution, workflow, swap, bridge, protocol-integrations, frontend-ux,
chat, liquidity). Every P1 was verified with a failing regression test and fixed; P2/P3 were fixed or are listed below.

| Finding | Severity | Resolution |
| --- | --- | --- |
| Kora: an unclear answer (5xx, -32603, 429, a refused retry after a lost call) recorded "never sent" although the transaction could land | P1 (4 reviewers) | definitive only for Kora's own pre-signing error to the first call; otherwise unknown → recovery by owner signature until expiry |
| Kora groups rewrote the written-once `submission` (PostgreSQL trigger 0023) | P1 | progress stored beside the submission; new PostgreSQL suite `kora-gas-run.pg` |
| Kora group stuck after a transient RPC error | P1 | transient errors wait; saves allowed while uncertain |
| Circle group with an Across bridge never reconciled its delivery | P1 (2 reviewers) | the operation's own logs are its receipt; run test reaches DELIVERED |
| Editor stuck when the Circle cap rose between Review and Authorize | P1 | confirmed in place (`CIRCLE_FEE_CAP_ROSE_CONFIRM`); *End and review again* for a real mechanism change |
| Circle: resend after the calls' deadline (USDC charged for a revert); bundler EntryPoint unchecked; wallet type not passed in runs; plans claimed one interaction | P2 | deadline guard (`CIRCLE_OPERATION_DEADLINE_PASSED`), EntryPoint check before the permit, wallet type carried, honest plans |
| Kora recovery unbounded; mechanism not re-checked for groups; Relay refusal mapping | P2/P3 | bounded slot window, re-check at authorization, precise mapping |
| 0x: native-coverage loop; minimum not compared with FloFi's quote; Settler revert shape; VIP first actions refused; unbounded body; step-mode stuck run | P2/P3 | reference floor (`ZEROX_QUOTE_WORSE_THAN_REFERENCE`), FloFi-quote coverage, production revert shape, `METATXN_*` allowlist with exact permit words, incremental cap, permanent refusal + Resume as owner steps |
| Chat/lifecycle: silent after an abandoned gasless attempt; non-final 0x failure shown final (double-swap risk); signature count | P2/P3 | chat reports it; non-final → uncertain and observed, simulate blocked while unsettled; count from the reviewed fee |
| UX: Kora worded as Circle in the Editor; Circle permit not visible as a permission; signature stages; Canvas hid the 0x Permit2 approval; Pimlico not named; cancel needs ETH | P2/P3 | all fixed with tests |
| Later native-only steps (liquidity, bridges, Relay) after a token-paid step | P2 (2 reviewers) | named before the first signature in the Editor Review and `/approve` |

## 5. Validation

Results are recorded on the final PR head in the PR description and updated here before review; intermediate runs on the merged build
(before the round-2 fixes): unit suite with no failure, PostgreSQL 767 passed / 1 environment-only failure (`forward-compatibility.pg`: PostgreSQL
16 locally vs 18.6 in CI, untouched by this build), nine affected browser profiles 77/77 passed, typecheck, lint, governance-lite and
`agent_guard check` passed.
