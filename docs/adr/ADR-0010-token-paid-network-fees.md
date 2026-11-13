# ADR-0010 — Token-paid network fees: Circle Paymaster, Pimlico Kora, 0x Gasless

Date: 2026-11-13. Status: proposed under the owner's BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 request (PR review pending). Amends
[ADR-0008](./ADR-0008-user-funded-execution.md) invariant S1 a second time (after [ADR-0009](./ADR-0009-network-fee-sponsorship.md)).

## 1. Context

A FloFi user who holds USDC, USDT or USDG but no ETH or SOL cannot execute anything today: every flow requires the owner wallet to pay the
network fee in the chain's native coin (S1). The owner decided that users should be able to pay that fee **in tokens**, on each of FloFi's five
networks, without FloFi becoming the financial sponsor of their transactions:

| Network | Chain | Mechanism | Economic payer |
| --- | --- | --- | --- |
| Ethereum | eip155:1 | Circle Paymaster, ERC-4337 EntryPoint v0.8 | the owner, in USDC |
| Base | eip155:8453 | Circle Paymaster, EntryPoint v0.7 or v0.8 | the owner, in USDC |
| Arbitrum One | eip155:42161 | Circle Paymaster, EntryPoint v0.7 or v0.8 | the owner, in USDC |
| Solana | solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp | Pimlico hosted Kora fee payer | the owner, in USDC or USDT |
| Robinhood Chain | eip155:4663 | 0x Gasless API v2 | the owner, the cost taken from the swap |

ADR-0009's FloFi-paid sponsorship stays exactly as it was: a separate, operator-only feature, **off** unless `FLOFI_GAS_SPONSORSHIP=enabled`,
and never chosen by the policy below.

## 2. Decision: one policy, four mechanisms

`apps/reference-dapp/src/gas-abstraction/mechanism.ts` names the mechanisms (`NATIVE_WALLET_GAS`, `CIRCLE_USDC_PAYMASTER`,
`PIMLICO_KORA_SPL_FEE`, `ZEROX_GASLESS_SWAP`) and the policy (`selectGasMechanism`), which is pure:

1. **Native first.** When the owner's native balance covers the worst-case fee (plus any native value the operation sends), the operation runs
   exactly as before. A coverage that is not known is never treated as short.
2. **Token-paid only when native is short and proven eligible.** Each mechanism's own module decides eligibility for exactly this operation
   (balances, wallet, account type, provider answer) and returns a closed reason when it is not.
3. **Otherwise native, with the precise reasons.** The existing shortfall evidence (`NativeFeeShortfall`, `INSUFFICIENT_*` codes) is kept and
   each alternative that was considered carries its closed code (e.g. `CIRCLE_SMART_ACCOUNT_REQUIRED`, `KORA_FEE_TOKEN_BALANCE_INSUFFICIENT`,
   `ZEROX_GASLESS_APPROVAL_UNAVAILABLE`), so the Review says what is missing instead of a dead end.
4. **Bound at Review, re-checked at authorization.** The chosen mechanism and its fee are part of what the owner reviews and signs; when the
   policy would now pick another mechanism (ETH arrived or left), nothing switches silently: `GAS_MECHANISM_CHANGED_REVIEW_REQUIRED`.

### S1, second narrowing (`user-funded/gas-payer.ts`)

A submission may name a non-owner native fee payer only with a `tokenFee` claim: the mechanism, the **pinned** relayer set, the relayer this
submission names, and a **positive** token amount the owner pays. The claim kind must be the mechanism's own (Circle → `EVM_USER_OPERATION`,
Kora → `SOLANA_TRANSACTION`, 0x → `EVM_GASLESS_INTENT`), a FloFi-controlled key is never a relayer, and the submission must name exactly that
relayer (Circle: `paymasterAndData` begins with the pinned paymaster and the sender is the owner; Kora: the fee payer is the pinned Kora signer;
0x: 0x's relayer sends the owner-signed trade). Without `tokenFee` the original rule is unchanged. `GasPaidFact.paidInToken` records what the
owner paid back, proven from the same transaction's logs; it is never combined with `sponsored`.

### Configuration (`gas-abstraction/config.ts`; runbook [GAS-ABSTRACTION.md](../deploy/GAS-ABSTRACTION.md))

Every mechanism is off unless its switch is `enabled` (`FLOFI_CIRCLE_USDC_GAS`, `FLOFI_KORA_TOKEN_GAS`, `FLOFI_ZEROX_GASLESS`). Provider hosts are
pinned (`solana.pimlico.io`, `api.0x.org`; loopback only for test harnesses). Contract addresses and mints are pinned in code from official
sources and re-verified on chain, never taken from the environment. Secrets (`FLOFI_PIMLICO_KORA_RPC_URL`, `FLOFI_ZEROX_API_KEY`, the bundler URL)
stay server-side; the browser only ever talks to FloFi's own origin.

## 3. Circle Paymaster (Ethereum, Base, Arbitrum One)

Circle's paymaster is permissionless: no Circle account or key. It fronts the native fee from its own EntryPoint deposit and, inside the same
user operation, takes USDC from the owner under an EIP-2612 permit; its `postOp` refunds what the actual gas did not use. Circle charges a
surcharge on the gas cost (published as 10 %); FloFi shows the worst case including it.

**Pinned contracts.** EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`. Circle
paymaster v0.7 `0x6C973eBe80dCD8660841D4356bf15c32460271C9` (Base, Arbitrum One only), v0.8 `0x0578cFB241215b77442a541325d6A4E6dFE700Ec`
(Ethereum, Base, Arbitrum One). Native USDC: Ethereum `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, permit domain name `USD Coin`, version `2`. Sources: Circle's published addresses page and
Circle-maintained viem guide (via search snippets and the guide's source), a Circle-authored npm middleware, `@circle-fin/app-kit`, and
`circlefin/stablecoin-evm`. Before use the runtime checks that the paymaster has code and `entryPoint()` returns the pinned EntryPoint, and that
USDC `name()`/`version()` equal the pinned domain; any mismatch refuses (`CIRCLE_PAYMASTER_UNVERIFIED`).

**Accounts (closed list; FloFi never creates or changes a delegation).** The owner's address and control never change:

| Owner account code | EntryPoint | Circle paymaster | Chains |
| --- | --- | --- | --- |
| EIP-7702 → MetaMask `EIP7702StatelessDeleGator` v1.3.0 `0x63c0…e32b` | v0.7 | `0x6C97…71C9` | Base, Arbitrum One |
| EIP-7702 → eth-infinitism `Simple7702Account` v0.8 `0xe6Ca…555B` | v0.8 | `0x0578…00Ec` | Ethereum, Base, Arbitrum One |
| none (plain EOA) | — | — | `CIRCLE_SMART_ACCOUNT_REQUIRED` |
| any other delegation or contract (e.g. Coinbase Smart Wallet: EntryPoint v0.6) | — | — | `CIRCLE_ACCOUNT_UNSUPPORTED` |
| MetaMask DeleGator on Ethereum | v0.7 | none on Ethereum | `CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED` |

**Transport.** A server-relayed ERC-4337 user operation of the owner's own account (the existing `EVM_USER_OPERATION` strategy, now also for a
group that is not delayed) through the operator's bundler (`FLOFI_BUNDLER_RPC_<chainId>`). EIP-5792 `paymasterService` cannot carry the owner's
permit (an ERC-7677 server cannot produce it) and MetaMask does not implement it, so wallet batches stay native.

**Two owner signatures, both typed data, no ETH needed:**
1. **USDC permit** (EIP-2612): `spender` = the pinned paymaster, `value` = the cap FloFi computed (never unlimited), `nonce` = `USDC.nonces(owner)`,
   `deadline` = 2^256−1 (required by the paymaster: ERC-4337 validation cannot read the block time). The cap is the operation's worst-case gas
   (all limits, paymaster limits included, × `maxFeePerGas`) priced in USDC from FloFi's verified price source, plus the surcharge and a disclosed
   margin. A permit **sets** the allowance; what is left of the cap after the operation stays approved to Circle's paymaster until the next
   permit overwrites it — disclosed in the Review.
2. **The user operation** (the account's own EIP-712 domain: `EIP7702StatelessDeleGator`/`1` for v0.7, `ERC4337`/`1` on the v0.8 EntryPoint for
   `Simple7702Account`). It commits to `paymasterAndData`, so it is asked only after the permit is signed and the bundler estimated the final
   operation with it.

**Reconciliation.** `UserOperationEvent` from the pinned EntryPoint with `sender` = owner and `paymaster` = the pinned Circle paymaster; the USDC
the owner paid = Σ USDC `Transfer(owner → paymaster)` − Σ `Transfer(paymaster → owner)` in that operation's receipt, excluded from the step legs;
`GasPaidFact { payer: paymaster, amount: actualGasCost, paidInToken: { mechanism, token: USDC, amount } }`.

**Not offered:** FloFi Wallet (an embedded EOA without a 7702 delegation), Coinbase Smart Wallet (EntryPoint v0.6), Robinhood Chain, delayed user
operations signed upfront (a permit could be overtaken by a later permit of the same owner), and single-step pages (they keep native gas; the
Editor's whole-workflow execution and `/approve` carry it).

## 4. Pimlico hosted Kora (Solana)

Pimlico's endpoint (`https://solana.pimlico.io/v1/mainnet/rpc?apikey=…`) speaks Kora's JSON-RPC subset: `getPayerSigner`, `getBlockhash`,
`getSupportedTokens`, `estimateTransactionFee`, `signAndSendTransaction`. The fee payer is Pimlico's key (static account 0); the owner signs as
signer 1. The transaction itself repays the fee: one SPL `TransferChecked` of the quoted USDC/USDT amount from the owner's token account to
the pinned payment address's associated token account. Accepted mainnet tokens: USDC `EPjF…Dt1v`, USDT `Es9v…nwNYB` (both 6 decimals).

**FloFi never lets the transaction reach Kora without the payment (K1).** Pimlico charges the API key's balance for any transaction without a
valid payment: before `signAndSendTransaction` FloFi verifies, on the exact bytes, that static key 0 is the pinned signer, the owner signed
everything else, exactly one payment `TransferChecked` to the pinned payment ATA carries the reviewed amount, and the signer key appears in no
other instruction except as `payer` of an associated-token-account creation (Kora then charges that rent in the token fee).

**Identity.** The transaction id is the fee payer's signature, unknown until Kora signs. FloFi records the owner's signature and the signed bytes
durably first, calls `signAndSendTransaction` with `respond_after: "signed"`, verifies the answer (same message, owner signature intact, pinned
signer), records the transaction id, and broadcasts the same fully signed bytes itself through its own RPC (the existing single-broadcaster
path). A lost answer is retried with the identical owner-signed bytes (ed25519 is deterministic: the same transaction, at most once), or
recovered by scanning the owner's recent signatures for the owner's slot-1 signature until the blockhash expires.

**Residual exposure (disclosed, bounded).** If a transaction that passed simulation fails on chain, its SOL fee is charged to the operator's
Pimlico balance (the owner's token payment reverts with it). FloFi bounds it with the priority-fee cap and the existing slippage limits;
Pimlico's API credits per transaction are an operator cost (a service fee, not gas).

## 5. 0x Gasless API v2 (Robinhood Chain)

`GET /gasless/quote`, `POST /gasless/submit`, `GET /gasless/status/{tradeHash}` on `https://api.0x.org` with `0x-api-key` and `0x-version: v2`
(server-side only). 0x's relayer sends the trade and recovers its gas from the trade (`fees.gasFee` in the sell or buy token). The owner signs the
trade (`settler_metatransaction`: Permit2 `PermitWitnessTransferFrom` for the MetaTxn Settler) and, when 0x offers it, a gasless approval
(EIP-2612 `permit` of Permit2 as spender) — one or two typed-data prompts, both shown.

**Before the owner signs** FloFi recomputes both EIP-712 digests and requires them to equal 0x's `hash`; checks the domain (Permit2 on 4663),
the sell token and amount, the spender = the genuine Settler read from 0x's registry on chain (`ownerOf(3)` / `prev(3)`), the deadline, the
recipient = owner, the buy token and a minimum output at least FloFi's slippage minimum; refuses a quote whose `fees.gasFee` is absent or zero
(FloFi must never be the sponsor) or whose approval is unlimited without being shown as such.

**Not gasless (precise reasons, shown before anything is signed):** selling native ETH (`ZEROX_GASLESS_NATIVE_SELL_UNSUPPORTED`), a token without
a gasless approval and without an existing Permit2 allowance (`ZEROX_GASLESS_APPROVAL_UNAVAILABLE`), no liquidity, a token 0x does not authorize
for this integrator (Stock Tokens need 0x's tokenized-equity opt-in), and every non-swap step (transfers, bridges, liquidity) on Robinhood Chain.

**Execution and reconciliation.** The submit is made once, only on the owner's explicit action, after the trade hash was recorded; a lost answer
is observed by trade hash, never resubmitted. Status is a hint; the chain decides: the receipt of a status transaction, sent to the genuine
Settler, must move exactly the reviewed sell amount from the owner and credit at least the minimum to the owner, with the owner's ETH balance
unchanged. The reconciled `outcome.inputSpent` / `outcome.outputReceived` feed the next workflow step exactly as a native swap does.

## 6. Consequences

- Native execution is unchanged for anyone who holds enough ETH or SOL.
- Reviews show who pays in plain words ("Network fee: at most 0.21 USDC, paid from your USDC through Circle", "Network fee: 0.0031 USDC, paid to
  Pimlico", "Fees included in the swap (0x): 0.42 USDG"), never "free" or "no fees"; protocol details stay under Technical details.
- FloFi pays no gas by default. Its only costs are provider service fees: a bundler plan (Circle), Pimlico API credits (Kora) and the residual
  failed-transaction fee in §4.

## 7. Not proven (honest limits)

Every test uses deterministic loopback doubles (a bundler and EntryPoint double with Circle semantics, a Kora JSON-RPC double, a 0x API double).
No provider, bundler, wallet or mainnet was contacted, and no transaction was signed for a real network. Live behaviour — wallet partial signing
with a foreign Solana fee payer, Pimlico's program allowlist, 0x's eligibility of USDG and Stock Tokens on 4663, Circle's exact prefund — must be
proven with the owner's small-value acceptance in [GAS-ABSTRACTION.md](../deploy/GAS-ABSTRACTION.md).
