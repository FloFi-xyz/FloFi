# BUILD-FLOFI-7702-TRANSFER-001 — MetaMask Smart Account transfers, blue chat actions, Passkeys session reuse

**Status:** PR for owner review. Branch `claude/eloquent-carson-ioqmgc`, based on `main` at `9842b78`. No migration, environment variable,
dependency or CI configuration change. No transaction was signed or submitted; production was only read (Railway logs).

Evidence levels: **CODE** = reproduced deterministically in code/tests; **MOCKED** = the loopback chain harness (not public chain data);
**HYPOTHESIS** = consistent with code but not proven against live chain data from this session.

## 1. MetaMask Smart Account (EIP-7702) transfers

### 1.1 Root cause

| Issue | Root cause | Evidence | Fix |
| --- | --- | --- | --- |
| A 1 USDC transfer on Arbitrum One from a MetaMask Smart Account fails before simulation with `TRANSFER_OWNER_NOT_EOA` | `readTransferState` (`packages/reference-compiler/src/native-transfer.ts`) refused every owner whose `eth_getCode` was not exactly `0x`. A MetaMask Smart Account is an EIP-7702 delegated EOA (code `0xef0100 ‖ DeleGator`), so every transfer it authored was refused at Simulate. The classification that owner-bound swaps already use (`ownerAccountCode`, verified delegates) was never applied to transfers. | CODE: the only producer of that code on the transfer path; the Railway API logs do not record flow refusals (searched read-only, nothing to read). HYPOTHESIS that the production account is 7702-upgraded (its code was not read from a public RPC in this session). | Owners are classified with `ownerAccountCode`; a verified MetaMask DeleGator owner is accepted and bound into the Review. |
| The reconciler would also have refused it | `reconcileNativeTransfer` (`packages/reference-reconciler/src/native-transfer.ts`) required `tx.from = owner`, empty owner code after inclusion and block-level balance deltas only. A relayed submission (sender = MetaMask's relayer, owner nonce unused, relayer pays the fee) could never reconcile, and a Smart Account's balances can move through relays without its nonce. | CODE | Direct and relayed submissions are reconciled separately (below). |
| The coordinator assumed one execution per owner nonce | `robinhood-transfer-service.ts` protects against a second execution only through the owner nonce (reservation, discovery by nonce, recovery only for the same unconsumed nonce). A relay never uses the owner nonce. | CODE | Relay claims, duplicate scans, lost-hash discovery and nonce hand-over from the owner-bound swap are reused. |

### 1.2 What changed

**Simulate / Review** (`reference-compiler/src/native-transfer.ts`)
- `readTransferState`: EOA → unchanged (no new field: EOA Reviews are byte-identical); on **mainnet transfer profiles**, EIP-7702 delegated to a reviewed delegate
  (`VERIFIED_EIP7702_DELEGATES`, the MetaMask Delegation Framework v1.3.0 `EIP7702StatelessDeleGator`) → `state.ownerDelegation` (part of the
  commitment and, through the artifact set, the manifest); unknown delegate → `TRANSFER_OWNER_DELEGATION_UNVERIFIED`; any other code (Safe,
  contract wallet, malformed or zero-address designator) → `TRANSFER_OWNER_NOT_EOA`. A verified Smart Account on an engineering test network
  → `TRANSFER_SMART_ACCOUNT_NETWORK_UNSUPPORTED` (those read clients do not serve `eth_getLogs`, which proving a single execution needs; refused
  before Review instead of stuck after signing).
- `assertTransferOwnerAccount`: Review, `begin` and the wallet `handoff` refuse (`TRANSFER_OWNER_ACCOUNT_CHANGED_REVIEW_REQUIRED`) when the
  account was upgraded, its delegation removed or changed since Review — before any nonce reservation or wallet request.
- The exact wallet request is unchanged: an ordinary transaction from the owner (native value or `transfer(recipient, amount)`), simulated
  with the account's delegate code at the pinned block. A native self-transfer runs the reviewed delegate's `receive()`, which accepts ETH and
  logs nothing. Recipient rules are unchanged (EOA-only or recipient code bound into the Review, per network profile).

**Reconciliation** (`reference-reconciler/src/native-transfer.ts`)
- **Direct submission** (the account sent it): every existing direct check (exact call, nonce, fee bounds, canonical inclusion,
  confirmations, status, logs). The owner code must be exactly the reviewed designator at `block − 1` and `block`
  (`TRANSFER_OWNER_ACCOUNT_CODE_MISMATCH`). The block-level balance proof is used when the block's changes are exactly this transfer's. Only
  positive evidence that something else of the owner moved in that block — another of its transactions (nonce), or another transaction's
  `RedeemedDelegation` rooted at the owner (`eth_getLogs` for that block) — makes the transaction and receipt the proof
  (`reconciliationScope: 'TRANSACTION'`, stated in the evidence); an unexplained difference is `TRANSFER_(TOKEN_)BALANCE_MISMATCH`, exactly as
  for a standard account.
- **Relayed submission** (MetaMask's relayer sent it; ERC-20 only): proven by the coordinator's relay verifier, which is the owner-bound
  swap's own code (`verifyOwnerSubmission`, `singleUseRelayedDelegation`): canonical type-2 `redeemDelegations` by a third party of exactly
  the reviewed call (one call, default mode, depth 1, no native value) from the owner's reviewed delegation, unchanged from preparation to
  inclusion; one `RedeemedDelegation` naming the owner and the relayer; only the token and the reviewed framework contracts logging; single
  use (LimitedCalls(1) counted for exactly that delegation). Then exactly one `Transfer(owner → recipient, amount)`. Facts:
  `submission: 'RELAYED'`, `gasPayer` (the relayer), `networkFee`; the owner's `fee` is **0** and its nonce is untouched.
- Refused relayed shapes are divergent with a named code, never a result: native-value relay (`TRANSFER_RELAYED_NATIVE_UNSUPPORTED`),
  reverted relay, non-single-use delegation, batched/fee-paying or other shapes (`TRANSFER_SUBMISSION_UNSUPPORTED`,
  `TRANSFER_RELAYED_EXECUTION_UNSUPPORTED_SHAPE`), and any relay for an owner reviewed as a standard account.
- EOA reconciliation and evidence are unchanged.

**Coordinator** (`apps/reference-dapp/src/server/robinhood-transfer-service.ts`; one engine, the swap's relay helpers exported from
`public-testnet-service.ts`, not duplicated)
- One relayed transaction is credited to one run (create-once `claim-<chain>-<hash>.tx`; otherwise `TRANSFER_RELAYED_TRANSACTION_ALREADY_CLAIMED`).
- Before a Smart Account's receipt becomes evidence, every relayed execution of the reviewed call since preparation (and, for a relayed
  receipt, a direct one at the reviewed nonce) is looked for: a second execution is `TRANSFER_RELAYED_DUPLICATE_EXECUTION`; a scan that is
  not final or cannot cover the window keeps the attempt pending (`TRANSFER_RELAYED_EXECUTION_PENDING`).
- A lost wallet result is also searched among relayed executions, without another wallet request.
- A wallet refusal is trusted for a new Review of the same nonce only after checking that the refused call was not relayed
  (`TRANSFER_REJECTED_ATTEMPT_EXECUTED`), at `recoverReview` and again inside the recovery run's `begin` just before it reserves. Every scan of
  a recovery run starts at the first attempt of the refused run(s) it recovers, so a relay landing between them is a duplicate, not missed.
- A lost wallet result whose owner nonce another transaction used is kept observable until the relay scan covered its window, then recorded
  as `TRANSFER_NONCE_USED_RELAY_NOT_FOUND` (a relay needs no nonce, so FloFi does not claim it "can never execute"). An EIP-7702 authorization
  that moved the nonce without a transaction of the owner counts as such a different use.
- The shared relay scan (`relayedExecutions`) matches a call without calldata (native ETH) by its target and value word instead of an empty
  string, so unrelated relays of the owner never mark a native transfer as executed or duplicated (swap behaviour unchanged: its calldata is
  never empty).
- Nonce reservation: a newer Review of the same unused owner nonce takes the reservation over only when the holder reconciled its transfer
  from a verified relayed redemption, with evidence (an appended hand-over line naming the holder and its hash). Pending, unknown, divergent
  or direct holders keep it.
- Messages (EN/PT) name the actual account kind and each relay outcome; MetaMask Smart Accounts are no longer told to use a "plain EOA".

**Other paths reviewed for the same restriction**
- Workflow runs (user-funded wallet batches, Circle Paymaster, sponsored batches): already accept EIP-7702 accounts — the wallet-batch
  reconciler decodes the EIP-7702 `execute(batch)` self-call and Circle's USDC paymaster pins MetaMask's DeleGator (v0.7) and Simple7702Account
  (v0.8). Unchanged. A MetaMask-*relayed* wallet batch is still refused there (the S1 rule: the owner wallet pays the fee) — fails closed.
- 0x Gasless swaps keep `ZEROX_OWNER_NOT_EOA` (0x's signature type needs a plain EOA): unrelated to transfers, unchanged.
- The archived RH-DEMO testnet self-transfer verifier (`robinhood-transfer-verifier.ts`) recovers an EOA signer by design; unchanged.

### 1.2a Specialist reviews (read-only; `.claude/agents/flofi-*.md`)

| Specialist | Findings | Disposition |
| --- | --- | --- |
| flofi-transfer-payments | 4 medium, 4 low, 3 info | Fixed: native empty-calldata relay match (M1); Smart Accounts refused on test networks whose read client cannot scan (M2); recovery-run scan gap (M3); delegated balance proof needs positive evidence (M4); relayed result line in the panel (L2); reverted-relay copy says the authorization may still be used (L1); EIP-7702 nonce bumps in discovery (L4); pending notes no longer append a line per poll (L3, partly). Documented below: scan bounds, independent verifier EOA-only. |
| flofi-wallet-execution | 2 medium, 3 low | Fixed: native empty-calldata match (M1); recovery re-scan in `begin` and scans from the first attempt (M2); honest code after a lost result with a used nonce (L2); block bound checked before the relay verifier and receipt-shape failures classed as mismatches (L3). Documented: nonce reservation kept by divergent relayed holders (L1); "not submitted" no longer shown for a divergent run. |
| flofi-security | 3 medium, 4 low | Fixed: native empty-calldata match (M1); contract-recipient debit and log wording via the positive-evidence rule (M2); used-nonce lost result (M3); error classification (L1); a non-redemption sender is a plain mismatch (L2). Documented: identical concurrent calls — first claim wins (L3, same as swaps); locked nonce after a divergent relay (L4). |

**Second round** (same five-plus domains, read-only, on the fixed code at `5de7ddd`; flofi-swap and flofi-frontend-ux added). No high finding;
no path to RECONCILED, a released reservation or a second wallet request. Fixed, each with a regression test that fails without the fix:

| Finding | Fix |
| --- | --- |
| Shared relay scan dropped a candidate whose receipt was served without its transaction, and still reported itself complete (security, swap — pre-existing for swaps) | Such a candidate keeps the scan pending (`waiting`). |
| Fallback match ignored the token/target: an unrelated relay (USDT vs USDC, WETH vs ETH, same recipient and amount) was "executed"/"duplicate" (transfer-payments, security, wallet-execution, swap) | `redemptionExecutions` decodes `redeemDelegations` strictly (single and batch ModeCodes, nested redemptions; canonical ABI) and compares target, value and calldata exactly; only an undecodable input falls back to the conservative byte match. Unit-tested against the real recorded MetaMask relay. |
| A divergence found while the attempt was still SUBMITTING (browser never reported) hit an invalid journal transition (wallet-execution) | `diverge` goes through SUBMISSION_RESULT_UNKNOWN, and records the relayed hashes it found (`relayedExecutions`). |
| A recovery run's lost-result discovery scanned from the oldest refused attempt with a bounded window, so it could miss its own relay (wallet-execution) | Discovery scans from the run's own preparation; duplicate and refusal checks scan from `relayScanFrom`, fixed once in the recovery record (no ancestor reloads). |
| An inconsistent nonce read was final (security, wallet-execution); "nonce used, relay not found" could be decided on the first poll (wallet-execution) | Inconsistent reads and that verdict wait a 10-minute settle window and a complete scan. |
| `begin`'s recovery re-scan saved nothing (wallet-execution) | The recovery Review is de-authorized with `TRANSFER_REJECTED_ATTEMPT_EXECUTED` and the hashes. |
| Positive-evidence logs were not validated; a lagging log index looked like "no other redemption" (security, transfer-payments) | Each log must be the manager's `RedeemedDelegation(owner)` in the receipt's block hash and number; for a relay, its own log must be present, else INCONCLUSIVE. A direct receipt with any Delegation Manager log is a mismatch. |
| Inconclusive polls appended a full journal line each time; the recovery branch accepted a non-pending predecessor (wallet-execution) | `note()` for inconclusive results; the predecessor must still be PENDING. |
| Evidence wording (ERC-20 self-transfer, contract-recipient caveat) and the PT copy (pt-BR forms; "você não pagou") | Corrected. |
| UI: Passkeys showed "No passkeys yet" while the overview loaded or after it failed (frontend-ux, medium); "Switch to …" prefix styled primary; touch height; relayed result without evidence download | See §2/§3 (UI fixes in the same commit). |

Documented, not changed: relay scans see only Delegation Manager redemptions (not ERC-4337 EntryPoint execution); duplicate detection runs
for the reviewed DeleGator only (the only verified delegate); "Undo this change" keeps the danger tone (owner's mapping).

Every reviewer confirmed: EOA Reviews have no new field; the delegate is bound and re-checked at Review, begin, handoff and reconciliation;
unverified delegates, contract wallets, value-carrying, batched, depth-2, type-4, non-single-use and reverted relays never reach RECONCILED;
recipient rules are unchanged; nothing signs or adds a send path.

### 1.3 Gas behaviour

The owner still needs ETH for the reviewed fee budget at Simulate and Execute: FloFi cannot know beforehand whether the wallet will relay,
and it does not promise gasless execution. Circle Paymaster and user-funded gas behaviour are unchanged (they apply to workflow runs, not to
this owner-signed single-transfer engine).

### 1.4 Tests (deterministic, MOCKED)

`apps/reference-dapp/src/server/smart-account-transfer.test.ts` (34 tests): EOA unchanged (ERC-20, native); verified MetaMask EIP-7702
Simulate/Review with the delegate bound; the production case (1 USDC on Arbitrum One); unknown delegate; contract wallet, malformed and
zero-address designators; recipient code still bound; upgrade/removal/change after Review and between begin and handoff; direct ERC-20 and
native, third-party and self-transfer; transaction-scope proof when another movement shares the block; owner code changed at inclusion; extra
log; relayed ERC-20 (fee 0, relayer paid, nonce unused, claim); nonce hand-over then a direct transfer; no hand-over before reconciliation or
after divergence; `relayedTransferNonceRelease` cases; relayed native refused; relay for an owner reviewed as EOA refused; reverted relay;
relay moving another asset; one claim per transaction; relayed + direct and direct + relayed duplicates; lost hash recovered from a relay;
lost hash relayed in batch mode; refusal that was relayed; genuine refusal recovered; EOA has no claim. Plus
`packages/reference-reconciler/test/native-transfer.test.ts` (unknown delegate now names `TRANSFER_OWNER_DELEGATION_UNVERIFIED`, contract code
still `TRANSFER_OWNER_NOT_EOA`) and `simulation-presentation.test.ts` (messages).

### 1.5 What is not validated

- **No mainnet evidence.** Every relay in these tests is MOCKED in the shape of the one real MetaMask relay committed in
  `src/server/testdata/metamask-delegated-depth1-approval.base-sepolia.json` (Base Sepolia, an `approve`). There is no recorded relay of a
  *transfer*, and none on Arbitrum One, Ethereum or Base mainnet. Any other relay shape fails closed (divergent), which is honest but may
  happen in practice (for example MetaMask paying its fee from the account in the same batch).
- Still requires real, owner-authorized validation through the reviewed wallet flow (never automated): a MetaMask Smart Account sending
  1 USDC on Arbitrum One directly; the same transfer relayed by MetaMask (that it returns the relayer's hash and uses the recorded shape);
  a native ETH transfer and a self-transfer; the next transfer starting without `TRANSFER_NONCE_ALREADY_RESERVED` after a relay.
- Engineering test networks (Robinhood Testnet, Ethereum Sepolia) refuse Smart Accounts for transfers (their read clients have no
  `eth_getLogs`); only the mainnet transfer profiles accept them.
- A Smart Account's direct transfer in a block where another redemption rooted at it also landed is proven from its own transaction and
  receipt; ERC-4337 EntryPoint execution of the account is not detected as such evidence (an unexplained difference then diverges).
- A divergent or unresolved relayed transfer keeps the owner's (unused) nonce reserved: the owner's next FloFi transfer on that chain is refused
  with `TRANSFER_NONCE_ALREADY_RESERVED` until the account sends any transaction itself (which moves the nonce). Fail-closed; no in-app release.
- Evidence of a Smart Account transfer cannot be checked by the independent archive verifier (`robinhood-transfer-verifier.ts`, EOA signer
  recovery by design).
- A refusal older than the duplicate-scan window (about 5.8 days on Arbitrum One) cannot be recovered in-app: the check cannot cover the
  window, so recovery stays `TRANSFER_RELAYED_EXECUTION_PENDING` (fail-closed).
- Limits inherited from the swap's relay rules (BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 §4.1): the DeleGator allowlist is address-based;
  relay scans use `eth_getLogs` in 5,000-block windows (lost-hash discovery 40 windows per observation, duplicate check 400 windows, about
  5.8 days on Arbitrum One — a receipt observed later stays pending); a divergent relay keeps the nonce reservation until the owner sends any
  direct transaction from the account; two concurrent runs with byte-identical calls and one relay: the first claim wins, the other is
  divergent; fee-on-transfer tokens fail closed.

## 2. FloFi Copilot — blue action buttons

**Before:** every answer button in a FloFi chat message used the neutral chip style. **After:** the step forward FloFi offers is FloFi's
existing primary blue; choices stay neutral; undo/discard/delete use the existing danger tone. Presentation only: labels, what each button
sends, handlers and workflow state transitions are unchanged.

- `src/domain/chat-action-variant.ts` (new): `chatActionVariant(label)` → `primary | secondary | destructive`, read from which existing copy
  wrote the label, in EN and PT. Primary: Review workflow, Add another action, Yes I confirm, Yes execute, Continue, Accept and continue, Apply
  it, Check status, Create new workflow, Copilot's Continue my request / Yes prepare it / Save recipient, Connect wallet, Switch to {network}.
  Destructive: Undo this change, Discard it, Delete all. Everything else — including any model-written or unknown label, saved names, No, Not
  now, clarification answers — is secondary, so an AI reply can never present an arbitrary label as a primary or destructive action. Warnings
  stay text (no warning buttons exist).
- `components/copilot-ai.tsx`: one shared `ChatActions` component (`class="chat-action"`, `data-variant`, `aria-busy` on the group while FloFi
  answers), now used by AI replies and by `copilot-panel.tsx`'s deterministic replies (one class path).
- `app/approved-ux-editor.css`: the three variants with hover, `:focus-visible` (2px `--accent` ring, offset 2px), disabled (`--soft`/`--muted`,
  never blue) and busy; existing radius and height; long labels wrap. Tokens reused: `--primary` (#2343D9) with `--on-accent` white text,
  7.3:1 in light and dark; danger `--red`/`--danger-line`, 6.17:1 light, 7.14:1 dark.
- Verified (agent, local): unit tests (variant in EN/PT on both reply paths, saved names secondary, busy/disabled markup, CSS rules); the two
  Copilot browser specs 13/13; screenshots at 1280 and 375 px, EN and PT, light and dark; Tab reaches the buttons with a visible focus ring; no
  horizontal overflow. Not verified: forced-colors mode; the live busy state (simulated).
- Two primary buttons can sit side by side ("Add another action" and "Review workflow"), as both were named in the request.
- Screenshot baselines that include chat buttons are regenerated (see §4).

## 3. Passkeys — reuse an existing server-verified wallet session

### 3.1 Root cause (CODE)

- `useWalletProof` exposed `proven: null` both for "not checked yet" and for "no session", and reset it on every scope change before the
  server read (`walletSessionStatus`) answered. Passkeys and Credentials → Automatic execution therefore showed **Connect wallet and prove
  ownership** while the read was in flight. On a fresh load the EVM store restores the account asynchronously (owner null → address restarts
  the read), and Next sends Server Actions one at a time per client, so the read waited behind the shell's other actions for seconds — long
  enough to click, which asks for a new `personal_sign` although a valid session existed.
- `useOverview` re-fetched the delegation overview on every shell re-render (its key was the `owner` object, rebuilt each render), adding to
  that queue, and had no guard against a late result for an earlier wallet.
- Address casing was not the cause (both sides are lowercase); the comparison is now canonical anyway.

### 3.2 Fix

- `useWalletProof` (`components/wallet-proof.tsx`) gains `checking`: no proof is exposed until the current scope's own server read answered.
  Scope = namespace, connected address, chain, Solana wallet name and the FloFi account (Privy `userId`); each read is bound to the scope and a
  request counter, so a late answer for wallet A never unlocks wallet B. `sameWallet()` compares EVM case-insensitively and Solana exactly. An
  expired session is never exposed; a timer at `expiresAt` clears it and reads the server again; focus and `WALLET_PROOF_CHANGED` still re-read.
  The read is bounded (10 s). A proof attempt is accepted only if the FloFi account did not change meanwhile.
- Passkeys shows the existing "Checking passkeys…" state while checking (and while a remembered wallet is still being restored); Credentials →
  Automatic execution shows "Checking wallet ownership…". With a valid, unexpired session that matches the connected wallet and the shell's
  owner, the management interface appears with no click and no signature. Otherwise the existing prove flow is unchanged.
- `useOverview` is keyed on namespace and address and ignores late results for an earlier owner.
- Registration and revocation of passkeys stay user-initiated. No server check, endpoint or authorization rule changed: every delegation
  action still re-verifies the HttpOnly wallet session on the server. No parallel authentication implementation.
- Tests: `wallet-proof.test.ts` (+10) and `delegation-credentials.test.ts` (new, 9): valid session opens without click or signature (no
  challenge, sign-in, `personal_sign`, chooser, connect or passkey call), missing proof, expired and expiring proof, casing-only match,
  different wallet, account switch, slow read for A after switching to B, disconnect, the 10 s bound, a proof attempt interrupting the first
  read. Mutation checks: disabling each guard breaks at least one test. Playwright `delegated-execution.spec.ts` 3/3.

### 3.3 Owner decisions (not changed here)

- **Signing in to FloFi with MetaMask through Privy does not create the wallet-ownership session** (`flofi_wallet_session` is set only by
  `walletSignIn`), and that session lasts 8 h while the account session lasts 12 h. In those cases there is no server-verified wallet proof, so
  the prove step is still shown — correctly, by the rules above. Accepting the account's verified sign-in wallet as the proof would change
  server authorization (`delegation-operation.ts`) and needs the owner's decision.
- The wallet-proof cookie is not bound to a FloFi account (only `accountSignOut` clears it); the server enforces the account binding only in
  beta (`withFlightAccess`). The client now re-reads on account change; the server rule is unchanged.
- Other screens using `WalletProof` (Automations, Copilot automation manager, saved workflows, approval) can adopt `proof.checking` the same way.
- Adding a passkey still needs a wallet sign-in from the last 15 minutes (`PASSKEY_FRESH_SIGN_IN_REQUIRED`, unchanged).

## 4. Validation and screenshot baselines

See the PR for the gate results at the final commit. Chat-button screenshots change on purpose in `swap-authoring`
(`chat-committed`, `review-blocked`), `mock-artifact-chain` (`simulate-current`, `simulate-invalidated`, `simulate-expired`) and
`base-observation` (`observation-recorded`, `observation-expired`); they are regenerated in the CI image (`cimg/node:24.21.0-browsers`, Node
24.21.0, pnpm 11.22.0, headless shell 1243) from the production build of this branch, with `--update-snapshots=changed` limited to those specs;
no screenshot assertion, threshold or required check was changed or skipped.
