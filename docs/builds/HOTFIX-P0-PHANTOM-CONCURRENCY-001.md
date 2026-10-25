# HOTFIX-P0-PHANTOM-CONCURRENCY-001: Phantom Lighthouse compatibility and independent workflow execution

Production commit at the start: `350e891` (PR #118 merged). Branch: `claude/hotfix-phantom-lighthouse-workflow-concurrency`.
Nothing here was merged, deployed, configured or signed, and no transaction was sent. The only network access was read-only public
mainnet-beta RPC reads of already finalized transactions (and the Lighthouse program account), used to build test fixtures.

## 1. P0-A — Phantom, Lighthouse and Jupiter

### What happened

A Jupiter SOL → USDC swap on mainnet-beta was refused with `JUPITER_TRANSACTION_CHANGED`: Phantom appended two Lighthouse instructions to
the reviewed transaction before signing. FloFi accepted only the byte-identical reviewed message, so it did not send it (correctly), and
nothing reached Solana. The owner-facing reason ("Your wallet added 2 instruction(s) from Lighthouse…") is only shown when every reviewed
instruction is still present, in order, and the fee payer and blockhash are unchanged: the wallet only appended.

### What Phantom appends (identified from real, finalized Phantom-signed mainnet-beta transactions)

The fixture `packages/reference-compiler/test/fixtures/phantom-lighthouse-mainnet.json` holds six real Phantom-signed transactions (five
Jupiter swaps, one Token-2022 transfer) read from the public RPC, with the lookup-table entries each one loaded at execution. In all of them
Phantom appends, after every dApp instruction:

| # | Lighthouse instruction | Target | Assertions (example: Jupiter swap `5DSfVKL9…`) |
|---|---|---|---|
| 1 | `AssertAccountInfoMulti` (disc. 6, log level FailedPlaintextMessage) | the owner (fee payer) | `lamports >= 66497618`, `owner == System`, `dataLength == 0` |
| 2 | `AssertTokenAccountMulti` (disc. 10) | the output token account | `amount >= 74867290`, `delegate == none`, `delegatedAmount <= 0`, `ownerIsDerivedAssociatedTokenAccount` |

These are post-state checks against Phantom's own simulation. If the result is worse, the whole transaction fails atomically. They read
one account each and compare; they cannot move, approve or create anything. The program `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` is
**immutable** on mainnet-beta: ProgramData `CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c` has upgrade authority None (last deployed at slot
294,179,293). Its binary has an OtterSec verified build of github.com/jac0xb/lighthouse (executable hash `b70084e0…529a`, frozen).

### The fix: verify the modification, never disable the check

`verifySolanaWalletGuard` (`packages/reference-compiler/src/solana-wallet-guard.ts`) accepts a wallet-returned message only if it is
the reviewed message byte for byte, or **all** of the following hold:
- same v0 version, fee payer, signers (same keys, same order, same read-only signer count) and recent blockhash, so the validity window and
  every signature slot are unchanged;
- every reviewed instruction is present, byte for byte with identical account flags, in order, as an exact prefix;
- every added instruction is a Lighthouse `AssertAccountInfo`/`AssertAccountInfoMulti`/`AssertTokenAccount`/`AssertTokenAccountMulti` whose
  data decodes completely (valid log level, every assertion field, 1–16 assertions, no trailing bytes), with exactly one target that the
  reviewed transaction already loads and with its flags unchanged;
- the resolved account set is the reviewed set plus only the Lighthouse program (read-only, unsigned), lookups only through the reviewed
  tables.

Everything else still fails closed: memory writes, `AssertSysvarClock`, `AssertAccountData`, unknown discriminators, inserted (not appended)
instructions, any compute-budget change (an inserted priority fee changes the fee the owner reviewed), new accounts, changed flags, unknown
lookup tables, another blockhash or signer. The owner's Ed25519 signature is verified over exactly the returned bytes, which are the bytes
broadcast. The accepted guard is journaled with the attempt (`walletGuard`), re-verified on every journal load (a tampered record fails as
`*_STORE_CORRUPT`) and again at reconciliation, and named in the evidence (`signedMessageHash`, `walletGuard`, and an explicit limitation
line). The Review, its commitment and its message hash are unchanged.

Applied to every Solana signing path: Jupiter swaps, Solana transfers (SOL/SPL/Token-2022), Orca liquidity (server, plus the browser
co-signer, where the position-mint key now signs the verified guarded message) and the Devnet runtimes that share them. The panels show
"Your wallet added N protection check(s) (Lighthouse)…" for an accepted guard.

## 2. P0-B — cross-workflow execution blocking

### Audit: every blocking mechanism found, and what replaced it

| Runtime / surface | Before | After |
|---|---|---|
| Jupiter swap (`jupiter-service.ts`) | `JUPITER_OWNER_ATTEMPT_IN_PROGRESS`: one unresolved attempt per owner, across runs | Durable per-transaction claims: a reviewed message hash and an owner signature each belong to one run. Any number of runs per wallet may be pending. |
| Solana transfer | `SOLANA_TRANSFER_OWNER_ATTEMPT_IN_PROGRESS` | Same per-transaction claims |
| Orca liquidity | `ORCA_LIQUIDITY_OWNER_ATTEMPT_IN_PROGRESS`; `POSITION_ALREADY_OPEN` (one FloFi position per owner per pool, simulate and begin) | Per-transaction claims; any number of positions (each OPEN has its own fresh mint, `ORCA_POSITION_MINT_IN_USE` still guards that identity); the Simulate panel always offers OPEN |
| EVM swaps, owner-bound Reviews (Arbitrum, Ethereum) | `OWNER_PENDING_TRANSACTION` at simulation, and handoff required latest == pending == reviewed nonce | The Review binds the account's next pending nonce; begin requires it to still be next; the permanent per-(chain, owner, nonce) reservation is kept |
| EVM transfers (`native-transfer.ts`, `robinhood-transfer-service.ts`) | `TRANSFER_PENDING_TRANSACTION` at simulation; `TRANSFER_NONCE_CHANGED` unless latest == pending | Same next-nonce rule; nonce reservation kept |
| Uniswap liquidity | `UNISWAP_PENDING_TRANSACTION`; handoff latest == pending | Same next-nonce rule; nonce reservation kept |
| Cross-chain router (bridges) | `ROUTER_PENDING_TRANSACTION`; `ROUTER_OWNER_DEPOSIT_IN_FLIGHT` (one unresolved deposit per owner) | Next-nonce rule; nonce claim kept; the deposit guard is keyed by the deposit's own FundsDeposited identity (`ROUTER_DEPOSIT_IDENTITY_IN_FLIGHT_SIMULATE_AGAIN`), not the owner |
| Aave (supply/borrow/repay/withdraw) | Server already used the pending nonce. The store refused Simulate while any attempt was unreconciled, for any workflow | Store refusal removed |
| Client stores and panels (Jupiter, Solana transfer, Orca, router, Uniswap, EVM transfer, lending, Aave) | Simulate refused/disabled while the current record had an unresolved attempt; lending also after a completed run | Removed. A note says the earlier transaction keeps being tracked; Dashboard lists every execution |
| Workflow runs (sequences), MCP, Telegram, automations | No cross-workflow execution block found. Run-level guards (a step in flight cannot be cancelled; a chat "link" continues the same open run) and quotas (25 automation rules, 16 MCP wallet links) | Unchanged (not execution blocking) |
| Solana Devnet composition (engineering only, not in the public product) | one open composition per owner; one position per pool | Unchanged; reported |

### Why the EVM change needed reconciliation work

EVM swaps proved the outcome from the owner's balance change between preparation and inclusion. EVM transfers and Uniswap mints proved it
from the change across the inclusion block, requiring exactly one owner transaction in that block. With the blanket rule gone, an
independent transaction of the same owner in that window would have been attributed to the wrong run (a false divergence). Now:
- with no other owner transaction in the window (or block), the proof and the evidence are exactly as before;
- otherwise the transaction is proven from its own transaction and receipt (exact call, nonce, fee bounds, status and its own token/Swap
  logs), and the evidence says so: `OWNER_TRANSACTIONS_IN_WINDOW_RECEIPT_RECONCILED` (swaps), `reconciliationScope: 'TRANSACTION'` plus an
  explicit limitation line (transfers), `OWNER_TRANSACTIONS_IN_BLOCK_RECEIPT_RECONCILED` (Uniswap). The router and Aave were already
  receipt-log based.

### Duplicate prevention that remains (per attempt, never per owner)

- One run, one attempt per step: `*_EXISTING_ATTEMPT_OBSERVE_ONLY` / `*_ATTEMPT_ACTIVE_OBSERVE_EXISTING`; a submit is accepted only from
  PREPARED (`*_WALLET_HANDOFF_NOT_AUTHORIZED`), so a double click or a retry after a timeout observes the existing attempt and never sends it
  again.
- Solana: the same reviewed message is never handed to two runs (`*_DUPLICATE_TRANSACTION_SIMULATE_AGAIN`); identical bytes under one
  blockhash would be one Solana transaction (Ed25519 is deterministic) and could land only once. A message whose holder was cancelled before
  any signature existed may be taken over. A signature is never reused (`*_DUPLICATE_SIGNATURE_NOT_SUBMITTED`).
- EVM: one nonce is never reserved by two active attempts.

## 3. Remaining actual protocol constraints

1. **EVM nonce ordering.** While an attempt is in the wallet's prompt (not yet broadcast), or its broadcast is unknown with nothing pending,
   it holds the account's next nonce: another FloFi transaction of the same account on the same chain waits (`*_OWNER_NONCE_IN_USE`,
   `*_NONCE_ALREADY_RESERVED`). Handing out the same nonce could replace it; skipping it would leave a gap. This holds one nonce, not the
   wallet. It resolves when the attempt is broadcast, refused, or proven expired/abandoned by observation.
2. **A Review bound to a nonce another transaction took first** (owner-bound EVM swaps) must be reviewed again
   (`OWNER_STATE_CHANGED_REVIEW_REQUIRED`). The nonce is part of the reviewed transaction.
3. **Balances are checked against confirmed state.** Pending outflows of other transactions are not subtracted. If they leave too little,
   the later transaction fails on chain (atomically; the network fee is spent) or cannot be included.
4. **Solana identical bytes.** Two runs with byte-identical messages (the same quote under the same blockhash) cannot both run; the second
   is asked to simulate again. On mainnet-beta the blockhash changes every slot.
5. **Phantom priority fee.** If a transaction sets no compute-unit price, Phantom inserts `SetComputeUnitPrice` (observed on Devnet in P0).
   Mainnet Orca liquidity sets no price (an earlier owner decision), so Phantom may still change it, and FloFi still refuses that: it
   changes the reviewed fee. Jupiter swaps and Solana transfers carry a reviewed price.
6. **Lighthouse allowlist.** Only the four assertion kinds above are accepted. Phantom has been observed using only these. Any other
   (memory writes, delta assertions, clock or data assertions) is refused until it is reviewed.
7. **EVM wallet-assigned nonces.** On Base and Robinhood swaps, EVM transfers, Uniswap and the router, the wallet assigns the nonce. If the
   wallet holds a transaction the RPC does not see yet, the browser's pre-signing check (`*_WALLET_NONCE_MISMATCH`) or reconciliation
   (nonce mismatch → divergent for review) catches it. Funds are never moved twice.
8. **Dashboard.** Pending executions are listed with status and transaction hashes and observed by the worker. The in-panel view follows
   the latest simulation of that tab.
9. **Compute units for wallet assertions.** Lighthouse assertions consume compute units from the reviewed limit (mainnet logs:
   about 1,800 CU for the owner check, 3,500–5,000 CU for the token-account check). Swap and liquidity Reviews size the limit as
   simulation × 1.2 + 10,000 CU, which is enough. Transfers size it as × 1.2 + 5,000: enough for a SOL transfer (owner check only) and for an
   SPL transfer (≥ 9,000 CU consumed). If a wallet ever appended more than the headroom, the transaction would fail on chain atomically
   (network fee spent) and be reconciled as failed. Nothing would be sent twice.

## 4. Test evidence

All of this is local, MOCKED or loopback, and it proves no public execution.

Local results on the final tree (2026-10-25):
- unit: 4,904 passed (2 opt-in suites skipped as before);
- PostgreSQL: 474 passed (3 skipped as before), on the pinned `postgres:18.6` image;
- browser: all 45 product profiles, 377 tests;
- fork suite and offline rehearsals: pass;
- typecheck, lint, schema drift, dependency audit, governance-lite, its unittests and the CI meta-tests: pass.

New or rewritten coverage:
- **Real Phantom bytes** (`solana-wallet-guard.test.ts`):
  - six real mainnet-beta Phantom transactions are accepted, with Phantom's real Ed25519 signatures verified over the exact bytes;
  - their exact instruction data are decoded;
  - adversarial mutations of the real Jupiter transaction are refused: memory writes, clock and unknown kinds, trailing or truncated data,
    bad log level or operator, a changed or dropped or reordered reviewed instruction, an inserted or appended priority fee, another
    blockhash or signer, a new target, a writable flag, two targets, an unknown lookup table, a wrong signer;
  - tampered guard records are refused;
  - every assertion variant is decoded.
- **Services** (Jupiter, Orca, Solana transfer, Devnet swap, composition):
  - a guarded swap is broadcast once and reconciled, with evidence naming the guard;
  - a failing Phantom assertion reverts atomically;
  - unverifiable additions are still refused;
  - a tampered journal is refused;
  - a guarded two-signer OPEN is co-signed;
  - independent swaps or transfers of one wallet run while earlier ones are pending (B), and the same swap runs twice (C);
  - one transaction is never handed to two runs, and a double submit is refused (D);
  - an uncertain or dropped attempt does not block another (H);
  - a declined attempt leaves nothing locked (G);
  - two positions are prepared in parallel.
- **EVM:**
  - Robinhood and Arbitrum swaps: two swaps of the same pair, the second reviewed and executed while the first is pending, both mined in one
    block and each reconciled from its own receipt; an unprovable receipt diverges; a Review whose nonce was taken must be reviewed again;
  - EVM transfers: concurrent transfers with ordered nonces; a block shared with another owner transaction reconciles from the receipt, and
    a wrong nonce, value or logs still diverge;
  - Uniswap: two position workflows side by side (F);
  - router: an independent deposit takes the next nonce; the same deposit identity is refused; an unknown relayed attempt holds only its
    own nonce.
- **Browser:** `solana-wallet-refusal` now includes a Phantom wallet with Lighthouse protections completing the swap and the two-signer
  position (sent once each, reconciled); the unverifiable-guard refusal shows the new wording.

## 5. Owner acceptance (real wallets, real funds — owner action only)

CI and MOCKED/loopback tests do not prove public execution. Each step below needs the owner's own wallet and explicit action through the
reviewed flow, on the deployed build, with amounts the owner chooses. Nothing below is run by FloFi or by an agent.

| ID | Scenario | Pass when |
|---|---|---|
| I | Phantom (Lighthouse protections on) executes a Jupiter SOL → USDC swap on mainnet-beta | Signed, sent once, finalized, RECONCILED; the run shows the protection note; evidence has `walletGuard` and `signedMessageHash`; Solscan shows the two Lighthouse instructions after the Jupiter ones |
| A | Workflow A simulated and left unfinished; workflow B created and executed | B executes; A is untouched (Dashboard: not started) |
| B | Swap A pending (submit, then simulate B before A finalizes); swap B authorized and submitted | Two signatures, both RECONCILED independently |
| C | The same swap (same tokens and amount) twice, each with its own Simulate → Review → wallet signature | Two distinct signatures, both reconciled, balances moved twice |
| D | Double-click Execute; reload during the wallet prompt; retry after a timeout | One signature request per attempt; never two broadcasts; the attempt is observed |
| E | A Solana swap while an unrelated Solana transfer workflow exists (pending or unfinished) | Both proceed independently |
| F | Two EVM transactions from one wallet on one chain (e.g. two Base or Arbitrum swaps): the second reviewed after the first is broadcast | Sequential nonces; both reconciled (receipt-scoped if they share a block) |
| G | A declined or failed transaction | A new workflow (or a fresh Simulate) proceeds at once |
| H | An uncertain submission (close the tab after signing) | The run keeps being observed and reconciles; other workflows proceed meanwhile |

## 6. Not yet certified

- Every path above at real-funds level (no owner-signed mainnet execution exists yet for this build).
- Phantom on two-signer Orca mainnet liquidity (constraint 5 may still apply).
- Wallets other than Phantom that append Lighthouse instructions (accepted only if they use the same verified forms).
