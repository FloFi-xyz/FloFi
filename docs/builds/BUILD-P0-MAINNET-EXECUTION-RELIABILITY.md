# BUILD-P0 — Mainnet execution reliability, gas abstraction and cross-chain recovery

Production incidents of 2026-11-15. This document separates **confirmed** facts (code or public-chain evidence) from **hypotheses**, and states
every evidence level honestly. Nothing here was executed with real funds; no production database, environment or provider configuration was read
or changed (this build environment has no Vercel, Railway or Neon access).

## Evidence gathered

Read-only, public Base mainnet RPC (`mainnet.base.org`), wallet `0x90f5…d303`:

| Fact | Value |
| --- | --- |
| Aave supply `0x26a6…5bc4` | nonce 15, block 57,912,242, 2026-11-15 20:00:24 UTC, type-2, `authorizationList` none |
| Aave withdrawal `0xba74…04f9` | nonce 16, block 57,924,903, 2026-11-15 20:42:36 UTC, type-2 |
| Account code on Base (`eth_getCode`) | `0x` — a plain EOA, **no EIP-7702 delegation** |
| `latest` / `pending` nonce now | 17 / 17 |

So the two Base → Arbitrum attempts (20:31, 20:32) reserved nonce **16**, the correct next nonce: the supply (15) had confirmed 31 minutes
earlier and 16 was used only at 20:42. The Base → Solana attempt (21:01) reserved **17**, again the correct next nonce (the withdrawal at 16 had
confirmed 19 minutes earlier). FloFi's server-side reservation was right each time; the wallet provider's `eth_getTransactionCount(…, 'pending')`
disagreed with it.

**Not established:** which value the wallet returned. The previous code threw `UNIVERSAL_WALLET_NONCE_MISMATCH` without persisting the
wallet's answer (`walletFailure` stored only the code), so the incident cannot be classified retrospectively. MetaMask answers `pending` counts from
its own nonce tracker (the network count, raised by transactions it tracks locally), so a value **above** 16/17 (a transaction MetaMask still
tracked as pending, e.g. from another dapp or a dropped/replaced request) is the most plausible reading; a lagging wallet RPC (a value below) is
possible but less likely 19–31 minutes after confirmation. This build records the evidence so the next occurrence is classified.

## Incident A — nonce mismatch (fixed)

Root cause (confirmed in code): `apps/reference-dapp/src/state/universal-router-store.tsx` (and the Router, Uniswap, Aave supply and Robinhood
transfer stores) compared the wallet's `pending` count with the reserved nonce and turned **any** difference into one undifferentiated refusal,
worded as "another transaction took the next slot", without evidence and without a way to tell a lagging wallet view from a real pending transaction.

Fix:
- `src/domain/wallet-nonce.ts`: one shared rule. The equality check is unchanged in strength (nothing reaches `eth_sendTransaction` unless the
  wallet's count equals the reserved nonce). Disagreements are classified: `WALLET_BEHIND` (the wallet's view lags the chain), `WALLET_AHEAD` (the
  wallet holds or sees a pending transaction FloFi's RPC does not), `INVALID`. Only `WALLET_BEHIND` is re-read — at most 3 reads, 2 s apart,
  session/run re-validated before each — because the reserved nonce was proven next by FloFi's own chain read. Nothing is skipped, fabricated,
  replaced or resent.
- Applied to every owner-wallet EVM flow with the same check: universal bridge, Router, Uniswap pool, Aave supply/withdraw, Robinhood transfer.
- Server (`universal-router/service.ts`, `nonce-check.ts`): a pre-send nonce refusal now records `nonceCheck` on its CANCELLED attempt — the wallet's
  count and relation (validated: only for the attempt's own nonce), FloFi's `latest`/`pending` at refusal time, and the chain relation (`CONSUMED`:
  another transaction really used the slot; `PENDING_ELSEWHERE`; `UNCHANGED`: only the wallet disagreed; `UNKNOWN`). A run refuses a 17th attempt
  cleanly (`UNIVERSAL_ATTEMPT_LIMIT_SIMULATE_AGAIN`) instead of failing its log validator.
- Retry: a proven pre-send refusal releases the nonce claim; the same run is re-reviewed (fresh `begin`, fresh nonce read) or re-quoted in place.
  An attempt that reached the hand-off (`SUBMITTING`) can never be recorded as a pre-send refusal (`UNIVERSAL_DIAGNOSTIC_NOT_PRE_SUBMISSION`).

Other paths: FloFi Wallet (`managed-signing.ts`, `FLOFI_WALLET_NONCE_MISMATCH`) reads the nonce server-side from FloFi's own RPC, so the
wallet-RPC disagreement does not apply to it; it is unchanged.

## Incident D — execution status after a pre-send refusal (fixed)

Root cause (confirmed): a CANCELLED universal/Router attempt mapped to the lifecycle state `cancelled`, which the result projection words as
"Execution needs attention · The run has an incomplete action" and whose only action was "Create new workflow".

Fix: `financialAttemptState` (shared by the lifecycle and run status) reads a CANCELLED attempt whose note is a pre-wallet refusal (nonce
refusals, `NONCE_CHANGED`, provider/run change, read failure before the wallet) as `NOT_SUBMITTED`; the server records CANCELLED for these only from
PREPARED without a wallet invocation. The lifecycle keeps the refusal code as the operation's `reason`; the result says "Transaction not submitted"
with the plain sentence for that reason; bridges offer **Refresh & review** on the same workflow (in-place re-quote after a landed approval,
otherwise a fresh simulation). An uncertain, submitted or partially executed run never qualifies. Absence of a hash alone is never used as proof.

## Incident B — USDC swap with zero ETH on Arbitrum (root cause confirmed; full fix needs an owner decision)

Root cause (confirmed in code):
1. A single swap runs on the owner-wallet Uniswap path (`public-testnet-service.ts`). On Arbitrum/Base its Review (`bindSwapOwner`) requires native
   ETH and fails with `INSUFFICIENT_GAS_FUNDS`; its gas binding (`bindSwapGas`) only ever evaluates 0x Gasless (Robinhood Chain). Circle Paymaster is
   never considered for a single swap.
2. Circle Paymaster is wired only into workflow runs (Editor *Review whole workflow*, `/approve`), and `workflow_runs.step_count` is constrained to
   2–8 by the schema (`EDITOR_WORKFLOW_SINGLE_STEP`). A one-step swap cannot be a workflow run.
3. Circle also needs an EIP-7702 smart account on the right EntryPoint (MetaMask `EIP7702StatelessDeleGator` v1.3.0 on v0.7 — Base, Arbitrum; or
   `Simple7702Account` v0.8). The incident wallet is a plain EOA (no code on Base); MetaMask does not let a dapp request its smart-account upgrade.

This build does **not** claim USDC-paid gas for single swaps. It replaces the bare "Add funds" with the real limitation
(`SINGLE_SWAP_NATIVE_FEE_MESSAGE`). Production readiness of Circle/bundler variables could not be re-checked from this environment.

Combinations that can pay gas in USDC today (by design, unchanged here, not re-verified in production by this build): multi-step workflow runs on
Ethereum, Base and Arbitrum One from a MetaMask smart account (EntryPoint v0.7: Base, Arbitrum) or a `Simple7702Account` (v0.8), and a FloFi
Wallet after its explicit upgrade consent; Solana via Kora; Robinhood Chain via 0x Gasless. Plain MetaMask EOAs: native gas only.

Owner decision required — either:
- **(a)** allow one-step workflow runs (schema migration of the `step_count` CHECK, under the controlled migrate-before-merge procedure) and route a
  short-of-ETH single EVM swap into the existing Circle workflow-run path; or
- **(b)** add a single-step Circle path to the owner-wallet swap engine (new UserOperation execution and reconciliation surface).

## Incident C — Base → Solana bridge (improved)

Confirmed: the explicit Solana recipient was bound correctly (`recipientKind: EXPLICIT`; the server canonicalizes it for the destination network
and the route's recipient must equal it). New regression tests prove it survives a pre-send refusal and an in-place re-quote. New: the Review records
whether the recipient already holds an associated token account for the delivered token (`destination.recipientTokenAccount`). Per Relay's fee
documentation, a missing account's rent falls on the user and is not separated from Relay's destination fee (already included in the quote); the
Review says so. Base origin gas stays the Base native fee (never Kora). Completion still requires independently reconciled destination delivery.

## Incident E — bridge costs (improved)

The Review shows each included provider fee as part of one included total with its share of the amount sent, when every included fee is in the
input's own unit (production Base → Solana 1 USDC: 0.148723 USDC = 14.8%, exactly the gap to the quoted 0.851277; never added twice). A share
of 5 % or more adds a plain notice before authorization; nothing is blocked. The source network fee stays its own ceiling in ETH; the FloFi 0.1%
fee stays a separate obligation recorded at reconciliation.

## Incident F — New workflow and Log out (fixed)

Root causes (confirmed): the drawer's and Dashboard's "New workflow" only switched to Chat (`setTab(BUILD_ENTRY)`), which kept the previous Canvas
("A new request is added to it") and its run; an unresolved run of another workflow stayed attached to any Canvas; after a reload the empty draft
re-adopted a run recovered from the browser. Log out disappeared from Settings in `1d61620c` (2026-11-12), which hid the session action except
on `/approve`.

Fix: New workflow performs the existing clean reset (new identity; Canvas, selection, proposal, Review binding, conversation) and opens Chat,
and is a no-op on an already-clean workspace; a run of another identity is `detached` from an explicitly created workflow (presentation only — its
record, observation and reconciliation continue and it stays in the Dashboard and History); the empty draft is persisted as `fresh` so a reload
keeps that state. Settings shows **Log out** (the existing `disconnectToLogin` flow: server revocation, cookie, Privy, wallet connection) when
a FloFi session exists and **Disconnect** (wallet only) otherwise. No on-chain permission is revoked and no run is touched.

## Integration and specialist review

Merged `origin/main` through PR #201 (MetaMask Smart Account transfers, `0de23d81`) with a normal merge: source files merged cleanly; only the
generated coverage files conflicted (re-applied and regenerated). #201's relayed transfers do not change `robinhood-transfer-store.tsx`; every
transfer still passes the pre-send equality check. Read-only specialist reviews (security, wallet execution, workflow) found no P0/P1; fixed:

- Router and Uniswap servers refused nothing when a client reported "never invoked" after an unknown wallet outcome
  (`SUBMISSION_RESULT_UNKNOWN`); with the new NOT_SUBMITTED mapping that would have re-offered a possibly sent request. Now refused; only a
  proven wallet refusal concludes it, and a refusal's note is derived by the server from its EIP-1193 code (`refusalNote`), never a client label.
- Router, Uniswap, Aave supply and transfer re-read accounts and chain before every nonce re-read; supply/transfer (compared with the Review's
  nonce) word a higher wallet count neutrally; canonical wallet counts only; an unreadable answer has its own sentence.
- The New workflow marker survives authoring and reload; a landed unwrap and a run at its attempt limit are not offered an in-place refresh; one
  Refresh & review button; New workflow is never a no-op while a recovered Canvas is still being read.

Reported, not changed (pre-existing): the Simulate view can show a same-runtime store's previous error before the new workflow is simulated
(workflow review F5).

## Not changed

No schema migration, environment variable, provider configuration, fee recipient, fee model (0.1 %), authorization, delegation or signing rule.
No production deployment or real-money transaction was performed by this build.
