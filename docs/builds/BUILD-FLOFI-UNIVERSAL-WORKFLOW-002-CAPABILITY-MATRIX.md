# BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 — capability matrix (user-funded execution)

Evidence levels used here, never mixed:
- **Tested (MOCKED)** — implemented in product code and exercised end to end by automated tests on loopback chain doubles / fakes
  (PostgreSQL + real approval service, run store, runner and worker loop). Not a public-network execution.
- **Mainnet-verified** — an owner-signed mainnet execution with recorded transaction hashes. **None in this build** (no real-money
  transaction was sent; see the report).
- **Unsupported** — with the concrete technical reason.

Every row: the owner's own wallet pays the network fee (S1). "Interactions" are wallet interactions, per network, never rounded down.

## EVM groups (Ethereum 1, Base 8453, Arbitrum One 42161)

| Wallet | Actions batched in one group | Mechanism | Interactions | Status |
|---|---|---|---|---|
| MetaMask (EIP-5792 `atomic: supported`) | Uniswap v3 USDC⇄WETH (0.05%), Aave V3 supply / borrow (registered reserves), ERC-20 / native transfers; in-group dependent amounts at the signed minimum | `EVM_WALLET_BATCH` (the group's own EIP-5792 `id`; a known id is read back, never sent twice) | 1 per group; the first group upfront, every later batch when due | Tested (MOCKED, PostgreSQL E2E incl. late answer, same id, exact-calls reconciliation); mainnet unverified; whether a wallet honours the app-provided `id` (EIP-5792 error 5720) is the wallet's |
| MetaMask (`atomic: ready`) | same | `EVM_WALLET_BATCH` (+ MetaMask's own 7702 upgrade inside the same confirmation) | 1 per group (setup shown) | Tested (planner); wallet prompt behaviour not exercised in CI |
| MetaMask, group waiting for a bridge delivery, no dependency on it, account already a MetaMask smart account (`atomic: supported`) | same | `EVM_USER_OPERATION` (owner's 7702 account, EIP-712, bundler, no paymaster) | 1 signature upfront | Tested (unit: prepare, owner-only signature, plain account refused, due-time simulation within the signed gas words, record-then-relay, resend of a lost relay, UserOperationEvent reconciliation); needs `FLOFI_BUNDLER_RPC_<id>`; mainnet unverified. A signed, unrelayed operation stays valid until the owner revokes it (panel button: `EntryPoint.incrementNonce` from their wallet) |
| MetaMask, group spending a bridge delivery | same | `EVM_WALLET_BATCH` signed when due (reconciled actual amount) | 1 when due | Tested (planner, binding resolution) |
| Other injected wallets (no `atomic`) | — | `EVM_OWNER_STEP` (each step's own flow) | ≥ 1 per step | Existing flows, unchanged |
| FloFi Wallet (Privy) | — | `EVM_OWNER_STEP` (one owner-step group per same-chain run; it finishes only when every step reconciled) | ≥ 1 per step (`atLeast`) | Unsupported for batching: Privy's embedded provider has no `wallet_sendCalls`; its 7702 authorization is headless only (never used); Privy smart wallets need a dashboard change + `permissionless` and a different account |

Other EVM actions (Uniswap pairs other than USDC/WETH, catalog swaps, liquidity, repay, withdraw, bridges) run as their own group through
their existing flows (`USER_FUNDED_ACTION_NOT_BUILDABLE:<ACTION>`), user-paid, one confirmation per step.

## Robinhood Chain (4663)

| Wallet | Batched | Status |
|---|---|---|
| MetaMask reporting `atomic` on 4663 | ERC-20 / native transfers | Tested (planner/builders); whether MetaMask reports `atomic` on 4663 is decided by the wallet at runtime; mainnet unverified |
| Any | swaps / liquidity | Own flow (`EVM_OWNER_STEP`): no delegation-grade Uniswap profile registered for 4663; no Aave market |
| Any | user operations | Unsupported: no bundler configured; EntryPoint/delegator deployment on 4663 not verified on chain |

## Solana mainnet

| Wallet | Grouped | Mechanism | Interactions | Status |
|---|---|---|---|---|
| Phantom / Solflare (Wallet Standard) | consecutive independent SOL/SPL transfers and Jupiter swaps | `SOLANA_SIGN_ALL` | 1 request (the wallet may show one prompt per transaction) | Tested (unit: ordered submission, blockhash expiry, fee-payer refusal, owner deltas); mainnet unverified |
| Phantom / Solflare | a step spending an earlier in-group output | new group, `SOLANA_SIGN_ALL` when due | +1 when due | Tested (planner) |
| FloFi Wallet (Privy) | — | `SOLANA_OWNER_STEP` | 1 per transaction | Privy shows one screen per transaction (verified in the installed SDK) |
| Any | post-bridge groups signed upfront (durable nonces) | — | — | Not offered (never selected; `FLOFI_SOLANA_NONCE_ACCOUNTS` defaults to disabled): builders need the input balance to simulate the exact message; signed when due instead |
| Phantom / Solflare | a later Solana group (not the first) | `SOLANA_SIGN_ALL` when due | 1 when due | A blockhash lives about a minute: only the first group is signed upfront |
| Any | Orca liquidity | own flow | per step | Existing flow |

## Cross-chain (Relay via the universal router; Across / LI.FI via the certified router)

| Route | Status |
|---|---|
| EVM ↔ EVM, EVM → Solana, Solana → EVM (all 20 directed pairs of the five mainnets) | Executed by the existing owner-signed bridge flows (user-paid); in a USER_FUNDED run the bridge is its own group. The next group spends the **reconciled delivery** (verdict RECONCILED, recipient = the run's own wallet), signed when due. MOCKED end to end; read-only quotes 40/40 executable (2026-10-25); no mainnet transaction recorded. |
| Bridge inside a batch / user operation | Unsupported: the bridge flow's verifier accepts direct owner transactions only and its quotes live ≤ 120 s |
| Refunded / divergent bridge | The step FAILS (`BRIDGE_REFUNDED`) and funds nothing later; any non-RECONCILED universal record reports nothing received |
| Delivery to another wallet | Reconciled with nothing received for the run: a dependent step stops (`WORKFLOW_BINDING_NOTHING_RECEIVED`; no dedicated code yet) |
| Matrix certification | The `bridge-evm-solana` row is not certifiable by a per-pair ledger key until mainnet evidence exists (per-pair rows needed then) |

## Chat ↔ Canvas

| Capability | Status |
|---|---|
| Canvas workflow → canonical v2 strategy (Chat/MCP/channels/approval) | Existing (`editorWorkflowStrategy`, exact per-node parity) |
| Chat v2 strategy → ONE Canvas workflow with the same canonical hash and bindings | New (`canvasWorkflowOfStrategy`); tested for EVM swap→supply, EVM→Solana bridge→swap, Solana→EVM bridge→swap, Solana swap→transfer; used by the approval preview |
| Percentage / "remaining" amount vocabulary | Not added: dependent amounts are min(cap, guaranteed or reconciled); a portion is expressed by the consumer's cap |

## Retired

| Capability | Status |
|---|---|
| Delegated single authorization (ERC-7710 workflow grants redeemed by FloFi's KMS executor) | Retired (`EXECUTOR_FUNDED_GAS_RETIRED`): FloFi paid the gas. Never used in production (zero rows). |
| Delegated automations (passkey Credential grants) | Retired for the same reason; owner-confirmed automations unchanged |
