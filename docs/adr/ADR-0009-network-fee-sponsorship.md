# ADR-0009 — Network-fee sponsorship (ERC-4337 paymaster, sponsored Solana fee payer)

Date: 2026-11-13. Status: proposed under the owner's BUILD-FLOFI-MAINNET-EXEC-002 request (PR review pending). Amends
[ADR-0008](./ADR-0008-user-funded-execution.md) invariant S1.

## Context

ADR-0008 made **S1 — FloFi never pays, advances, sponsors or reimburses network gas for a user's workflow** — mandatory, because the old
delegated executor *sent* and paid for user calls from a shared FloFi key. The owner now asks for gas abstraction: where sponsorship
infrastructure exists, FloFi pays the network fee; otherwise the owner's wallet pays, as today. The owner still authorizes every action;
FloFi never holds a user key and never sends a user's transaction with a FloFi key.

## Decision

1. **S1 is narrowed, not dropped.** Everything FloFi itself broadcasts or relays is still owner-paid (`assertUserFundedSubmission` unchanged:
   a relayed user operation with a paymaster is refused). The only sponsored path is an **owner wallet batch** that the owner's wallet signs
   and sends, whose fee a **pinned ERC-4337 paymaster** pays through **FloFi's ERC-7677 paymaster proxy**.
2. **EVM: EIP-5792 `paymasterService` + ERC-7677 proxy** (`src/gas-sponsorship`).
   - When a wallet batch is prepared on a chain the operator configured, the artifact carries a **single-use grant** (owner, chain, SHA-256
     of the exact calls, 10-minute expiry) and the proxy URL `https://<origin>/api/gas/paymaster/<chainId>`.
   - The browser asks the wallet `wallet_getCapabilities`; only a wallet that **reports** `paymasterService` on that chain receives the
     capability (`optional: true` unless required). A wallet without it, or one that refuses it (EIP-5792 `5700`, nothing sent), gets the
     unchanged owner-paid batch.
   - The proxy answers `pm_getPaymasterStubData` / `pm_getPaymasterData` only for: the pinned EntryPoint v0.7 and chain; a known, unexpired
     grant; `sender` = the grant's owner; no account deployment; and calls — decoded from the account's own encoding (MetaMask DeleGator
     `execute(bytes32,bytes)` batch, Coinbase Smart Wallet `executeBatch`/`execute`) — **exactly** the reviewed calls. It forwards to the
     provider with the provider's own sponsorship context (never FloFi's grant), requires the answer to name the **pinned paymaster
     contract**, computes the operation's worst-case cost with the paymaster's gas, and refuses above the per-operation cap. It then records
     the `userOpHash` and owner nonce on the grant under the grant's lease (at most 3 per grant, all on one pinned nonce, so a concurrent
     request for another nonce is refused there). Next it reserves the worst case in the daily-budget ledger, and only then returns the
     paymaster data. A reservation is never released (a refusal must not free the reservation of an answer already handed out). A use
     recorded before the budget refused its reservation sponsors nothing, because no paymaster data is returned for it.
   - The operation's fees and gas must stay within the preparation's own fee ceiling and gas allowance, with bounded verification and
     pre-verification gas. `pm_getPaymasterStubData` is held to the same bounds and to the pinned nonce wherever it carries a value (a
     wallet's `0x0` placeholder never exceeds one). A stub answer the provider marks `isFinal` is refused, because the wallet would then skip
     the final request and every control it runs. Stub answers are never recorded or reserved.
   - **Reconciliation** (`reconcileWalletBatch`): a bundle transaction not sent by the owner reconciles only through the EntryPoint's own
     `UserOperationEvent` of a hash on that group's grant, with `sender` = the owner and `paymaster` = the pinned one. The hash commits to the
     operation's calldata, which the proxy checked before sponsoring. Legs are attributed from that operation's own logs. `gasPaid` records
     `payer` = the paymaster, `sponsored: true`, `actualGasCost`; the ledger replaces the reserved worst case with it. Without a grant, a
     transaction the owner did not send still never reconciles (`GAS_PAYER_NOT_OWNER`).
   - **REQUIRED**: when the owner's native balance cannot cover the fee ceiling but covers any native value sent, the batch is prepared
     only as sponsored: a wallet without `paymasterService` is not asked (`GAS_SPONSORSHIP_WALLET_UNSUPPORTED`, nothing sent). The same
     applies when the artifact requires sponsorship but carries no offer the browser can use (for example a URL that is not FloFi's https
     proxy): the wallet is asked nothing at all.
3. **Solana: sponsored fee payer** (`solana-fee-payer.ts`). The sponsor key (a FloFi operational key, never a user's) is static key 0 and
   pays only the fee; the owner signs every instruction as signer 1. Before co-signing, the exact message must: name the sponsor as fee payer;
   have exactly two signers (sponsor, owner); carry the reviewed blockhash and no address-lookup tables; call only allowed programs plus
   Compute Budget; **never reference the sponsor in any instruction** (so nothing can debit, close or reassign it); and have a worst-case fee
   (5 000 lamports per signature + price × limit) within the per-transaction cap. The owner's signature over exactly that message is verified;
   the sponsor's slot must be empty. Account rent (e.g. a token account a step creates) stays the owner's and is disclosed at Review.
   **Not yet wired into a Solana flow in this build** (see *Not done*): the module, its policy and its tests are the building block.
4. **Per network, per step, fail closed.** Each chain is configured on its own; anything missing or malformed disables that chain only
   (`GAS_SPONSOR_EVM_CONFIG_INVALID`). A disabled chain, an exhausted daily budget, a provider refusal or an unsupporting wallet all fall back
   to owner-paid gas (or, when REQUIRED, to "nothing sent"). A step that is not a wallet batch (an owner step, a delayed user operation, a
   Solana group) is owner-paid exactly as before.
5. **Abuse protection is on the sponsor's funds, not on people.** Exact reviewed calls only, single-use expiring grants, a per-operation cap,
   a per-chain daily budget in PostgreSQL (shared by every serverless instance), no account deployment, no JSON-RPC batches, no cookies on
   the proxy. No per-user quota limits what anyone may build or execute.
   **Unsettled reservations count for their whole UTC day.** A reserved worst case is replaced only by the fee reconciliation reads from the
   chain. It is never released and never expires within the day, so an owner who never reports back cannot get budget back by waiting. The
   cost is availability: a refused or abandoned signature keeps its worst case reserved until the day ends, so operators size the daily
   budget for it ([GAS-SPONSORSHIP.md](../deploy/GAS-SPONSORSHIP.md), *Budget accounting*).
6. **Secrets stay server-side.** The provider's paymaster URL (which carries its API key) and the Solana sponsor key are server environment
   variables; the browser only ever sees FloFi's proxy URL and the grant id. No user key is ever sent to or held by the backend.

## Consequences

- The Editor and `/approve` show "Network fee sponsored when your wallet supports it: gas paid by FloFi" (PT: "Taxa de rede patrocinada…
  gas pago pela FloFi") when offered, "Network fee sponsored: gas paid by FloFi" when required, and "Gas paid by FloFi: X" once reconciled.
- `workflow_run.group_reconciled` logs `gasSponsored: true` for sponsored groups.
- Production is **unchanged until the operator configures it** (`FLOFI_GAS_SPONSORSHIP` unset ⇒ every batch owner-paid).

## Not done and residual risks (honest limits)

- **No real-funds proof.** Every test uses loopback doubles (a provider double, an EVM chain double, in-memory ed25519 keys). No paymaster
  provider, bundler, wallet or mainnet was contacted; nothing was signed for a real network. Real behaviour depends on each wallet's EIP-5792
  `paymasterService` implementation (Coinbase Smart Wallet documents it; MetaMask's support for EIP-7702 accounts must be verified live).
- **Solana sponsorship is not connected to a flow.** Wiring it needs the Jupiter/transfer builders to compile with a separate fee payer and
  the sign-all verification to accept a two-signer message; that is a follow-up build.
- **Server-relayed EVM user operations stay owner-paid** (a bundler must never be configured with a paymaster for them).
- **ERC-4337 v0.8 / EntryPoint 0x4337…** is not supported (v0.7 only).
- **The sender account's code is not verified.** The proxy decodes the operation's calldata with the known account encodings and requires
  exactly the reviewed calls, but it does not check what the sender's code (for example the contract an EIP-7702 delegation points to)
  does with that calldata. A delegation to a custom contract could execute something other than the decoded calls. The sponsor's exposure
  stays bounded by the per-operation cap and the reviewed batch's fee ceiling and gas allowance. Reconciliation still attributes legs only
  from the chain's own logs.
- **Grants created just before UTC midnight book on the previous day's ledger.** A reservation goes on the ledger of the grant's creation
  day, even when the operation is sponsored or lands after midnight. The sponsor's spend within one calendar day can therefore exceed that
  day's budget by what late grants of the previous day reserved (each within the per-operation cap, and at most the previous day's budget
  in total).
