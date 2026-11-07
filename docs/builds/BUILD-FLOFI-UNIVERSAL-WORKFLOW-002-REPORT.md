# BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 — completion report

Branch `claude/friendly-lamport-r1z0ac`, base `3bdfe07` (PR #166 merge). Decision record: [ADR-0008](../adr/ADR-0008-user-funded-execution.md).
Runbook: [USER-FUNDED-EXECUTION.md](../deploy/USER-FUNDED-EXECUTION.md). Matrix: [CAPABILITY-MATRIX](./BUILD-FLOFI-UNIVERSAL-WORKFLOW-002-CAPABILITY-MATRIX.md).

**Status: implemented and tested on loopback/MOCKED infrastructure; ready for owner review. Not mainnet-verified** (no real-money
transaction was sent, by design). Nothing was merged, deployed, or changed in AWS, Railway, Vercel or Neon production; production was only
read (Neon SQL `SELECT`s, Railway logs).

## 1. Objective A — user-funded gas

| Requirement | Implementation | Evidence |
|---|---|---|
| FloFi never pays user gas | Executor transport has no send method; executor refuses every step before simulation (`EXECUTOR_GAS_PAYER_REFUSED`); `prepareSubmission` refuses session-paid bytes; executor-paid nonce fillers removed; new executor-paid authority refused at the product boundary (`EXECUTOR_FUNDED_GAS_RETIRED`) | `delegation/boundaries.test.ts`, `executor.pg.test.ts`, `adversarial.pg.test.ts`, `compatibility.pg.test.ts`, `workflow-runs/delegated-run.pg.test.ts` (legacy authorization never executes; nothing signed or sent) |
| Every group paid by its owner | `workflow_run_groups.fee_payer` written once, must equal the run's wallet (DB trigger, `GAS_PAYER_NOT_OWNER`); S1 asserted before every relay (user operation: sender = owner, no paymaster; Solana: fee payer = owner) and on the chain at reconciliation (batch `from` = owner; `UserOperationEvent` sender = owner, paymaster = 0) | `user-funded-groups-migration.pg.test.ts`, `user-funded-run.pg.test.ts` (foreign payer → `GAS_PAYER_NOT_OWNER`), `user-funded/groups.test.ts` |
| Financial isolation / fee preview | Fee ceiling computed from live fee data and shown per group with its payer; preparation refused when the owner's own balance cannot cover it (`USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE`); no shared nonce or balance (each owner's own account; user operations use a nonce key per group) | `user-funded-run.pg.test.ts` (isolation case), `groups.test.ts` (insufficient balance, 1,000 submissions across users) |
| KMS role | Retained, not deleted, no role in user execution; runbook §5 removes `kms:Sign` and says never fund the executor | ADR-0008, runbook |

Production facts (read-only, 2026-11-07): delegation was configured on Railway (owner report: `delegation.worker_enabled`, KMS signing
validated) but **never used**: zero credential grants, delegated authorizations, executions or delegation work items; the two automation rules
are `CONFIRM_EACH_TIME` and paused. Retiring the executor disrupts no record, workflow or automation.

## 2. Objective B — universal workflows

| Requirement | Status |
|---|---|
| Five mainnets in the workflow engine | Ethereum, Base, Arbitrum One, Robinhood Chain and Solana all participate in USER_FUNDED runs (grouped or through their own flows); mainnet-only scope unchanged |
| EVM ↔ EVM, EVM ↔ Solana | Bridges run through the existing owner-signed Relay/Across flows; the next group spends the reconciled delivery (only when RECONCILED and delivered to the run's own wallet; refunds fail the step) |
| Dependent amounts from settlement | In-group: the producer's signed guaranteed minimum; cross-group: reconciled actual, signed when due; never a quote |
| Chat ↔ Canvas same canonical workflow | Canvas→Chat (existing, exact per-node parity) and new Chat→Canvas (`canvasWorkflowOfStrategy`, same canonical hash and bindings), tested for EVM, EVM→Solana, Solana→EVM, Solana-only; approval preview opens the whole workflow |
| Build → simulate → authorize → execute → reconcile | Groups: prepared from fresh chain facts (EVM first-call estimate; Solana exact simulated messages; user operations simulated by the bundler when due), authorized by the owner's wallet, relayed only if owner-signed, reconciled from the chain into each step's outcome (spent/received, gas paid) |

## 3. Objective C — minimum wallet authorization

Per wallet and chain (counts are honest; see the matrix): MetaMask — 1 interaction per same-chain group (atomic batch; the 7702 upgrade, if
needed, inside the same confirmation; only the first group upfront, later batches when due) and 1 typed-data signature upfront for a delayed
group without a dependency on the delivery (account already a MetaMask smart account);
Phantom/Solflare — 1 request per Solana group of independent steps; FloFi Wallet (Privy) — one confirmation per step (Privy offers no
batching or one-prompt multi-sign; its 7702 signing is headless and never used). Cross-chain: at least one interaction per network; groups
that spend a delivery are signed when it lands. A step through its own flow (bridge, FloFi Wallet) counts as a minimum (`atLeast`, "at least N").
The plan recommends user-funded groups only when they need fewer interactions than confirming each step, and `single: true` only when exactly
one interaction authorizes everything.

## 4. Genuine limitations (not hidden)

- **No mainnet evidence.** All execution evidence is MOCKED/loopback. Real wallet behaviour (MetaMask `wallet_sendCalls` on each chain,
  Phantom/Solflare multi-input prompts) and real bundlers are not exercised in CI.
- **Solana durable nonces** are not offered: FloFi's Solana builders require the input balance to simulate the exact message, so a
  post-bridge Solana group is signed when due (+1 interaction).
- **Bridges are not batched** (their verifier accepts direct owner transactions only; quotes live ≤ 120 s).
- **Batchable EVM actions** are the delegation-grade templates (USDC⇄WETH Uniswap v3, Aave supply/borrow, transfers); other actions run
  through their own flows.
- **Robinhood Chain**: no bundler / user operations; swaps and liquidity via their own flows.
- **No percentage / "remaining" vocabulary** beyond the consumer's cap.
- `EVM_USER_OPERATION` uses MetaMask's `EIP7702StatelessDeleGator`, which has no on-chain validity window: FloFi relays only while the run
  is open and only when due; a signed operation FloFi never relayed stays valid until the owner revokes it (panel: "Cancel the signed
  operation in my wallet" = `EntryPoint.incrementNonce(key)` from their own wallet). Its signature is stored (append-only) while it can still
  execute; redaction after the nonce is used is not implemented.
- **Wallet-batch duplicate protection depends on the wallet honouring the app-provided EIP-5792 `id`** (error 5720). FloFi additionally never
  drops a prepared batch, takes a late answer, reads a known id back instead of sending, and refuses to end a run while a batch may be in
  the owner's wallet; a request left open in the wallet past its window and confirmed after the owner ended the run would still execute
  from the owner's own wallet without being recorded.
- **Something the owner signed is never replaced**: a signed group that stops (e.g. a batch the wallet reports failed off chain) cannot be
  resumed; the owner ends the run and starts a new one.
- **Delivery to another wallet**: a bridge whose recipient is not the run's own wallet reconciles with nothing received for the run; a
  dependent step stops with `WORKFLOW_BINDING_NOTHING_RECEIVED` (no dedicated code yet). The EVM ↔ Solana matrix row is not certifiable by a
  per-pair ledger key until mainnet evidence exists.
- **Fees on OP-stack L2s (Base)**: gas paid is `gasUsed × effectiveGasPrice`; the L1 data fee is not added (understated); the fee ceiling
  check uses the same L2 figures.
- **Solana**: a group with two byte-identical transactions is refused at preparation (`SOLANA_GROUP_DUPLICATE_TRANSACTION`; one signature
  would execute once); the `prepared` bound is 256 KiB.
- **Crash consistency**: group, step and run moves are separate compare-and-set writes (each idempotent); a crash between them can leave a
  run RUNNING with a stopped group until the owner ends it.

## 5. Test and CI evidence

(Filled in below from this session's runs; CircleCI remains the certification authority.)

## 6. Deployment requirements

Release A (certificate commit) to all consumers first, then this build (migration 0023), then the environment variables of runbook §4.
KMS: keep, remove `kms:Sign`, never fund. Rollback: `FLOFI_USER_FUNDED_EXECUTION=disabled`, or the previous build (serves schema 23).

## 7. Go / No-Go

See the final section after CI.
