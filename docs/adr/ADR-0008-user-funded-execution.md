# ADR-0008 — User-funded execution groups replace the FloFi-funded delegated executor

Date: 2026-11-07. Status: proposed under the owner's BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 request (PR review pending).

## Context

PR #166 (`BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001`) let an owner authorize a whole EVM workflow with one EIP-712 signature per chain (an
ERC-7710 "workflow grant" of exact calls). FloFi's executor then **sent and paid for** every redemption from a shared AWS KMS address
(`delegation/drivers.ts signEvmCalls`; the runbook asked the owner to fund it with ETH). It also filled stale nonces with executor-paid
self-transactions. That breaks the product invariant this build makes mandatory:

> **S1 — FloFi never pays, advances, sponsors or reimburses network gas for a user's workflow.**

A shared, FloFi-funded sender also couples users (one nonce space, one balance), and one user's volume could drain it.

Production, read-only, before this change (Neon `Flofi` default branch, 2026-11-07): migrations through 0022; **zero** credential grants,
delegated authorizations, delegated executions or delegated work items ever; two automation rules, both `CONFIRM_EACH_TIME` (owner-signed,
user-paid) and `PAUSED`; one workflow run, `CONFIRM_EACH_STEP`. The owner reported that the Railway API and worker had delegation enabled and
logged `delegation.worker_enabled` and that KMS signing was validated. So the executor path was **configured, never used**.

## Decision

1. **Retire the executor as a sender (S1, enforced below the drivers).** The `executor` transport has no send method; the executor stops every
   step before simulation with `EXECUTOR_GAS_PAYER_REFUSED`; `prepareSubmission` refuses session-paid bytes; the nonce fillers are removed; the
   product boundary refuses every operation that would create new executor-paid authority (`EXECUTOR_FUNDED_GAS_RETIRED`). Reading, revoking
   and ending existing authority stay available. The authorization plan reports the delegated mode as `EXECUTOR_FUNDED_GAS_RETIRED`.
2. **Add run mode `USER_FUNDED` with execution groups** (migration 0023). A group is a maximal run of consecutive steps that ONE wallet
   interaction on ONE chain can authorize. Its fee payer is written once and must be the run's own wallet of that namespace — checked by the
   database at insert (`GAS_PAYER_NOT_OWNER`).
3. **Choose each group's mechanism from the owner's real wallet capabilities** (reported in the browser; every artifact is still verified on
   the server), never assumed silently.
4. **Bind dependent amounts to settlement, never to quotes.** Inside one group a dependent step spends the producer's signed guaranteed
   minimum (a swap's `amountOutMinimum`, a borrow's exact amount); across groups (e.g. after a bridge) it spends the reconciled delivery and
   its group is signed when it becomes due.
5. **Keep the AWS KMS key, with no role in user execution.** Do not delete it. Recommended: remove `kms:Sign` from the worker role
   (keep `kms:GetPublicKey` only if legacy grant verification is still wanted) and set `FLOFI_DELEGATED_SIGNER=none` /
   `FLOFI_DELEGATED_EXECUTION` unset. Do not fund the executor address; any balance it holds is not used by this build (see the runbook).

## Mechanisms compared (what each wallet × chain gets)

| Wallet / chain | Mechanism (strategy) | Gas payer | Tx sender | Signer | Interactions | Validity / revocation | Dynamic amounts | On-chain enforcement | Production dependencies |
|---|---|---|---|---|---|---|---|---|---|
| MetaMask (EIP-5792 `atomic` supported/ready) on Ethereum, Base, Arbitrum One | `EVM_WALLET_BATCH` — `wallet_sendCalls` atomic, no capabilities | owner account | owner account (the wallet sends) | owner | 1 per group (+ the wallet's own one-time 7702 upgrade inside the same confirmation when `ready`) | sent at once; quotes honoured 10 min | in-group: signed minimum | exact calls; router `amountOutMinimum`; atomic revert | wallet support; `FLOFI_USER_FUNDED_RPC_<id>` for reconciliation |
| MetaMask, a group that waits for a delivery, no binding to it | `EVM_USER_OPERATION` — ERC-4337 v0.7 op of the owner's own `EIP7702StatelessDeleGator` account, EIP-712 signed | owner account (EntryPoint prefund) | a bundler (transmits only; repaid from the owner's prefund) | owner | 1 typed-data signature, upfront | no on-chain expiry in that delegator; FloFi relays only while the run is open and only when due; owner revokes by using the nonce key (`EntryPoint.incrementNonce`) from their account | exact authored amounts only | exact calls; nonce key per group (exactly once); signed gas words = maximum charge | `FLOFI_BUNDLER_RPC_<id>` (v0.7, verified chain + EntryPoint); an upgraded account |
| MetaMask, a group bound to a delivery | `EVM_WALLET_BATCH` signed **when due** | owner | owner | owner | 1, when the delivery reconciled | as above | reconciled actual, capped | as above | as above |
| Any injected EVM wallet without atomic batching | `EVM_OWNER_STEP` (the step's own flow) | owner | owner | owner | ≥ 1 per step | per step | reconciled actual | per flow | none new |
| FloFi Wallet (Privy embedded) EVM | `EVM_OWNER_STEP` | owner | owner (FloFi broadcasts the owner-signed tx) | owner (Privy screen) | ≥ 1 per step | per step | reconciled actual | per flow | none new |
| Robinhood Chain (4663) | `EVM_WALLET_BATCH` for transfers when the wallet reports `atomic` on 4663; otherwise `EVM_OWNER_STEP` | owner | owner | owner | 1 per group / per step | as above | as above | as above | user-funded opt-in for `eip155:4663`; no bundler configured (no user operations) |
| Phantom / Solflare (Wallet Standard) on Solana | `SOLANA_SIGN_ALL` — one `solana:signTransaction` request with every transaction of the group | owner (fee payer = static key 0, asserted) | FloFi relays owner-signed bytes in order | owner | 1 request (the wallet may show one prompt per transaction) | recent blockhash (~60–90 s): sent at once, each after its predecessor confirmed; an expired one is never sent | independent steps only inside a group; a step spending an in-group output starts a new group signed when due | exact simulated messages; Jupiter `otherAmountThreshold` | `GRYLOO_SOLANA_RPC_URL`, `JUPITER_API_KEY` (existing) |
| FloFi Wallet (Privy) Solana | `SOLANA_OWNER_STEP` | owner | FloFi relays the owner-signed tx | owner | 1 per transaction (Privy shows one screen per transaction) | per step | reconciled actual | per flow | none new |
| EVM ↔ EVM bridge (Relay universal router, Across/LI.FI certified router) | the bridge step's own flow (`EVM_OWNER_STEP`) | owner | owner | owner | 1–2 per bridge (approval + deposit) | quote ≤ 120 s | the next group spends the reconciled delivery | Relay order id / Across exact output | existing providers |
| EVM ↔ Solana bridge (Relay) | the bridge step's own flow | owner (source chain) | owner | owner | 1–2 | as above | the destination group spends the reconciled delivery (recipient must be the run's own wallet) | Relay order (minimum output) | existing |

Rejected or deferred, with reasons:
- **FloFi-funded executor, paymaster, relayer reimbursement, pooled gas treasury** — violate S1 (the whole point of this build).
- **Privy smart wallets** (`useSmartWallets`) — need a Privy dashboard change, the uninstalled `permissionless` peer dependency, and a different
  smart-account address (Safe/Kernel/…), so funds would have to move to a new account. Not without the owner's decision.
- **Privy `useSign7702Authorization`** — signs a raw hash headlessly (`secp256k1_sign`, no confirmation screen): never used.
- **Squads / Swig / SPL delegate for Solana single authorization** — custody change or unrestricted recipient; refused.
- **Solana durable nonces for post-bridge groups** — the primitives exist (`reference-compiler/src/solana-nonce.ts`), but every Solana builder
  requires the input balance to exist (simulation), so a post-bridge transaction cannot get FloFi's exact-message simulation before signing.
  Such groups are signed when due (one more interaction, honestly counted). `SOLANA_DURABLE_NONCE` is in the schema and planner vocabulary
  but no product path selects it in this build.
- **Bridges inside a batch** — the universal router's verifier accepts only direct transactions (or the retired DelegationManager path) and
  its quotes live ≤ 120 s; bridges stay in their own flow (their delivery observation, refund and recovery logic is unchanged).

## What "one authorization" means here (S10)

The review counts interactions per wallet and network and never rounds down: one group = one wallet interaction on one chain; a workflow on
two chains needs at least two; a Solana group is one request even if the wallet shows several prompts; network switches and one-time setup
are listed. `single: true` only when exactly one interaction authorizes everything. An EVM signature never authorizes a Solana transaction.

## Consequences

- Existing confirm-each-step runs, owner-signed flows and automations (`CONFIRM_EACH_TIME`) are unchanged. Delegated automations can no
  longer be created; none existed in production.
- The worker now RELAYS owner-signed artifacts of USER_FUNDED runs (user operations to a bundler after its simulation; Solana transactions
  whose fee payer is the owner). It holds no signer and can create no transaction. This is a reviewed boundary change.
- A v22 build tolerates schema 23 (certificate in Release A) and never acts on a USER_FUNDED run.
