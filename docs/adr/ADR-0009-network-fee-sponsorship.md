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
     contract**, computes the operation's worst-case cost with the paymaster's gas, refuses above the per-operation cap, reserves it in the
     daily-budget ledger, records the `userOpHash` on the grant (at most 3 per grant), and only then returns the paymaster data.
   - **Reconciliation** (`reconcileWalletBatch`): a bundle transaction not sent by the owner reconciles only through the EntryPoint's own
     `UserOperationEvent` of a hash on that group's grant, with `sender` = the owner and `paymaster` = the pinned one. The hash commits to the
     operation's calldata, which the proxy checked before sponsoring. Legs are attributed from that operation's own logs. `gasPaid` records
     `payer` = the paymaster, `sponsored: true`, `actualGasCost`; the ledger replaces the reserved worst case with it. Without a grant, a
     transaction the owner did not send still never reconciles (`GAS_PAYER_NOT_OWNER`).
   - **REQUIRED**: when the owner's native balance cannot cover the fee ceiling but covers any native value sent, the batch is prepared
     only as sponsored: a wallet without `paymasterService` is not asked (`GAS_SPONSORSHIP_WALLET_UNSUPPORTED`, nothing sent).
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
6. **Secrets stay server-side.** The provider's paymaster URL (which carries its API key) and the Solana sponsor key are server environment
   variables; the browser only ever sees FloFi's proxy URL and the grant id. No user key is ever sent to or held by the backend.

## Consequences

- The Editor and `/approve` show "Network fee sponsored when your wallet supports it: gas paid by FloFi" (PT: "Taxa de rede patrocinada…
  gas pago pela FloFi") when offered, "Network fee sponsored: gas paid by FloFi" when required, and "Gas paid by FloFi: X" once reconciled.
- `workflow_run.group_reconciled` logs `gasSponsored: true` for sponsored groups.
- Production is **unchanged until the operator configures it** (`FLOFI_GAS_SPONSORSHIP` unset ⇒ every batch owner-paid).

## Not done (honest limits)

- **No real-funds proof.** Every test uses loopback doubles (a provider double, an EVM chain double, in-memory ed25519 keys). No paymaster
  provider, bundler, wallet or mainnet was contacted; nothing was signed for a real network. Real behaviour depends on each wallet's EIP-5792
  `paymasterService` implementation (Coinbase Smart Wallet documents it; MetaMask's support for EIP-7702 accounts must be verified live).
- **Solana sponsorship is not connected to a flow.** Wiring it needs the Jupiter/transfer builders to compile with a separate fee payer and
  the sign-all verification to accept a two-signer message; that is a follow-up build.
- **Server-relayed EVM user operations stay owner-paid** (a bundler must never be configured with a paymaster for them).
- **ERC-4337 v0.8 / EntryPoint 0x4337…** is not supported (v0.7 only).
