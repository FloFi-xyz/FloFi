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
   policy would now pick another mechanism (ETH or SOL arrived or left), nothing switches silently: `GAS_MECHANISM_CHANGED_REVIEW_REQUIRED` (the
   Editor offers *End and review again*; on `/approve` the group is planned again and simply authorized again). A Circle fee cap that rose since
   the Review is shown next to the reviewed one and confirmed in place (`CIRCLE_FEE_CAP_ROSE_CONFIRM`) before anything is signed; a lower cap
   goes straight to the wallet.
5. **Later steps that still need native gas are said before the first signature.** A token-paid step can be followed, on the same chain, by a
   step whose own flow has no token-fee option (Orca or Uniswap liquidity, a Robinhood bridge, a Relay Solana deposit). The Editor Review and the
   `/approve` plan name those steps and the native token they need ("Later steps on Solana need SOL for their network fee: …"), so a run never
   stops midway by surprise; the design itself is never cancelled.

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

**Safety rules added by the review.** Circle is offered only when the bundler reports the EntryPoint the account needs
(`CIRCLE_BUNDLER_ENTRY_POINT_UNSUPPORTED` otherwise, before any permit is asked); an operation is never (re)sent at or after its calls' on-chain
deadline (a late send would revert while the paymaster still charges USDC: the group ends `CIRCLE_OPERATION_DEADLINE_PASSED`, nothing charged);
a group carrying an Across deposit reconciles from the operation's own logs, so its bridge delivery is verified like a wallet batch's; plans never
claim one interaction for a group whose fee Circle may pay.

**FloFi Wallet (Privy embedded EOA).** Privy's embedded wallets sign EIP-7702 authorizations (`useSign7702Authorization`; external wallets are
refused by the SDK) and typed data, but not EIP-5792 batches. FloFi Wallet can therefore use Circle v0.8 on Ethereum, Base and Arbitrum One by
**upgrading its own address** to the pinned `Simple7702Account` v0.8 inside its first Circle operation: the operation carries the authorization
(`eip7702Auth`, `0x7702` initCode marker) and the bundler includes it in its own type-4 transaction, so no ETH is needed. Rules: only when the
account has no code (an account already delegated to the pinned delegate uses it; any other code is never replaced: `CIRCLE_ACCOUNT_UNSUPPORTED`);
only the pinned delegate, the specific chain id (never 0) and the account's current nonce (no pending transaction: `CIRCLE_ACCOUNT_NONCE_PENDING`;
re-checked before each signature: `CIRCLE_AUTHORIZATION_STALE`); FloFi's own explicit consent first, recorded server-side
(`FLOFI_WALLET_UPGRADE_CONSENT_REQUIRED` without it) — Privy shows no confirmation screen for an authorization, so FloFi's consent is the only
place the owner reads what the upgrade does; three signatures on first use (upgrade, USDC permit, operation), two afterwards; reconciliation
requires the account code to be `0xef0100 ‖ Simple7702Account` (`CIRCLE_DELEGATION_NOT_LANDED`). The upgrade stays after a failed operation
(it is applied at the start of the bundler's transaction), as the consent says. FloFi Wallet's traditional owner-paid path is unchanged.
Where it is reachable: `/approve` (every MCP, channel, chat, developer and Editor *Run workflow* link) when the owner authorizes **in groups**:
before the first step of a FloFi Wallet group on a Circle chain is loaded, FloFi asks for its preparation; ETH covers → the step runs through its
own flow exactly as before; Circle eligible → FloFi's consent card ("Upgrade and continue" / "Not now"); *Not now* withdraws the unsigned Circle
preparation (`CIRCLE_FEE_DECLINED`) and the step pays in ETH or shows the shortfall, with nothing signed. The Editor reviews a FloFi Wallet
workflow step by step (FloFi Wallet has no EIP-5792 batches), pays each step in ETH and says that USDC fees are available through `/approve`.
Not covered: *Confirm each step* mode (no groups), a page reload between the start and the browser's check (that group pays in ETH), and the
resume of a halted owner-step group.

**MetaMask on Ethereum: native ETH (provider/wallet limit, with evidence).** MetaMask's `EIP7702StatelessDeleGator` v1.3.0 takes its EntryPoint as
an immutable constructor argument, includes it in its user-operation typehash and accepts `validateUserOp` only from it (`EIP7702DeleGatorCore.sol`
l.50-57, l.116, l.147-162); the deployed implementation `0x63c0…e32b` is built for v0.7. Circle has no v0.7 paymaster on Ethereum. MetaMask exposes
no dapp-requested EIP-7702 authorization to another delegate (only its own upgrade inside `wallet_sendCalls`), and its EIP-5792 middleware
implements `atomic` and `auxiliaryFunds` only: a required `paymasterService` is refused with 5700 and an optional one ignored
(`processSendCalls` l.421-485, `getCapabilities` l.111-129). Its own `alternateGasFees` (MetaMask's fee-token relay) is chosen inside MetaMask after
FloFi hands over the batch — token, amount and relayer are not part of what FloFi reviews, so FloFi cannot bind or reconcile it (S1). What
MetaMask would need: a v0.8 DeleGator, a dapp-requested authorization to a v0.8 account, or EIP-5792 `paymasterService` with an ERC-7677 permit
flow. Until then MetaMask on Ethereum pays in ETH (Base and Arbitrum One work through the v0.7 paymaster).

**Not offered:** Coinbase Smart Wallet (EntryPoint v0.6), Robinhood Chain, delayed user operations signed upfront (a permit could be overtaken by
a later permit of the same owner), and single-step pages (they keep native gas; workflow runs — the Editor's whole-workflow execution for
injected wallets and `/approve` in groups for every wallet — carry it).

## 4. Pimlico hosted Kora (Solana)

Pimlico's endpoint (`https://solana.pimlico.io/v1/mainnet/rpc?apikey=…`) speaks Kora's JSON-RPC subset: `getPayerSigner`, `getBlockhash`,
`getSupportedTokens`, `estimateTransactionFee`, `signAndSendTransaction`. The fee payer is Pimlico's key (static account 0); the owner signs as
signer 1. The transaction itself repays the fee: one SPL `TransferChecked` of the quoted USDC/USDT amount from the owner's token account to
the pinned payment address's associated token account. Accepted mainnet tokens: USDC `EPjF…Dt1v`, USDT `Es9v…nwNYB` (both 6 decimals).

**FloFi never lets the transaction reach Kora without the payment (K1).** Pimlico charges the API key's balance for any transaction without a
valid payment: before `signAndSendTransaction` FloFi verifies, on the exact bytes, that static key 0 is the pinned signer, the owner signed
everything else, exactly one payment `TransferChecked` to the pinned payment ATA carries the reviewed amount, and the signer key appears in no
other instruction except as `payer` of an associated-token-account creation (Kora then charges that rent in the token fee).

**Refusals and identity.** A Kora answer is a definitive refusal only when it is Kora's own JSON-RPC pre-signing validation error to the
**first** call for those bytes; HTTP errors, -32603, rate limits and any answer after a lost call are unknown and the transaction is recovered by
the owner's signature until its blockhash is provably expired at finalized height (the recovery scans only that slot window, page by page). The
transaction id is the fee payer's signature, unknown until Kora signs. FloFi records the owner's signature and the signed bytes
durably first, calls `signAndSendTransaction` with `respond_after: "signed"`, verifies the answer (same message, owner signature intact, pinned
signer), records the transaction id, and broadcasts the same fully signed bytes itself through its own RPC (the existing single-broadcaster
path). A lost answer is retried with the identical owner-signed bytes (ed25519 is deterministic: the same transaction, at most once), or
recovered by scanning the owner's recent signatures for the owner's slot-1 signature until the blockhash expires.

Group progress (attempts, Kora ids, adopted signatures) is stored beside the written-once submission, so PostgreSQL's immutability
rule for submissions holds; transient RPC failures make a pass wait rather than mark the group uncertain.

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

A 0x `failed` status before the signed deadline is shown as *uncertain* and still observed (only a deadline passed with the Permit2 nonce
unused is final); a refused submit is *not submitted*; no new swap is simulated while a gasless attempt is unsettled. A Robinhood batch whose
ETH is short and whose swaps 0x could carry halts with `USER_FUNDED_GASLESS_REQUIRES_STEP_MODE`; Resume runs those swaps as owner steps.

**Not gasless (precise reasons, shown before anything is signed):** selling native ETH (`ZEROX_GASLESS_NATIVE_SELL_UNSUPPORTED`), a token without
a gasless approval and without an existing Permit2 allowance (`ZEROX_GASLESS_APPROVAL_UNAVAILABLE`), no liquidity, a token 0x does not authorize
for this integrator (Stock Tokens need 0x's tokenized-equity opt-in), and every non-swap step (transfers, bridges, liquidity) on Robinhood Chain.

**Reference price.** FloFi keeps its own on-chain Uniswap v3 quote beside the 0x quote and refuses a 0x minimum below FloFi's slippage
minimum net of the disclosed 0x fees (`ZEROX_QUOTE_WORSE_THAN_REFERENCE`); both appear in Technical details. A pair with no Uniswap route has no
reference and is refused at Simulate in this build (a Stock Token only 0x can route is therefore not offered yet). The first trade action may be
any of the Settler's `METATXN_*` actions, provided its permit words equal the signed permit.

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
