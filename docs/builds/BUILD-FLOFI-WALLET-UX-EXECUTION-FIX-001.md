# BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 — Wallet UX, session continuity and real execution blockers

**Status:** ready for owner review. Branch `claude/clever-newton-bjdy6d`, based on `main` at `b8126a6` (PR #148 merged). Nothing is merged,
deployed or configured. Production was only **read** (Railway and Vercel logs); no production database, variable, credential or deployment was
changed, and no transaction was signed or submitted.

**Owner decision applied (follow-up on PR #150):** MetaMask Smart Account *relayed* submissions are supported for owner-bound swaps (§1a); the
Smart Account rejection is not restored. The CI screenshot baselines were regenerated in the CI image (§3b).

## 1. Root causes

Evidence levels: **PROD-LOG** = read-only production logs; **CODE** = reproduced deterministically in code/tests; **HYPOTHESIS** = consistent
with code and screenshots but not proven against live chain data from this session.

| Issue | Root cause | Evidence | Files | Fix |
| --- | --- | --- | --- | --- |
| P0-07 quote unavailable (USDC → ETH, Arbitrum) | The hosted Build estimate (`readBuildEstimate`, cloud preview path) required `'address' in` both workflow asset refs. Native ETH is `{chainId, nativeId, decimals}`, so every quote the API returned for a native ETH side was discarded as `ESTIMATE_RESPONSE_INVALID`. The local (non-hosted) path has no such check, so unit tests stayed green. | PROD-LOG: Vercel `swap.quote_failed ESTIMATE_RESPONSE_INVALID` at 18:00:42, 18:10:59, 18:11:18, 18:11:24 UTC (2026-11-01), each matched by a Railway `flow.preview arbitrum-swap prepare ok` at the same second. CODE: the new production-parity tests reproduce the same log line before the fix. | `src/server/build-estimate.ts` | A native side matches only the runtime's native sentinel (`NATIVE_ETH`) on catalog EVM networks; any other token (WETH included) or a sentinel on a token side is refused. |
| P0-07 "Estimate unavailable" on Simulate/Execute canvas | Inspection cards hard-coded "Estimate unavailable" and never requested the shared quote. | CODE | `composer-card.tsx`, `simulate-workflow-canvas.tsx`, `state/estimate-owners.tsx` | Simulate cards use the same live quote (display only) or say why there is none; Execute cards show no quote note (reviewed amounts are in the execution details). |
| P0-07 unexplained "Quote unavailable" | Any unmapped code fell back to a bare "Quote unavailable". | CODE | `src/domain/build-estimate.ts` | Explicit messages for unsupported/dependent/test-network/inconsistent-network/insufficient-balance; generic fallback explains itself and shows a reference code. |
| P0-08 "This wallet is a smart contract account" | Owner-bound swaps (Arbitrum One, Ethereum: `ownerBoundReview: true`) refuse any owner whose `eth_getCode` is not exactly `0x` (`bindSwapOwner` → `OWNER_NOT_EOA`). MetaMask "Smart Accounts" are EIP-7702 delegated EOAs: code `0xef0100 ‖ 0x63c0…e32b`. The same service's `verifyOwnerSubmission` already reconciles MetaMask Delegation Framework submissions (`DELEGATOR_IMPL`), so only the preflight guard blocked them. | CODE (the only producer of that message). HYPOTHESIS that the reported MetaMask account (`0x4b21…b3ce`) is 7702-upgraded: public RPCs are outside this session's network policy. Owner check (read-only): `cast code <your MetaMask address> --rpc-url <arbitrum rpc>` — a result starting `0xef0100` confirms. | `packages/reference-compiler/src/account-code.ts` (new), `src/server/public-testnet-service.ts` | EOA → unchanged. EIP-7702 delegated to the reviewed MetaMask DeleGator → accepted; the delegate is bound into the Review (`ownerReview.delegation`, part of `manifestHash`) and a change before Execute needs a new Review. Unknown delegate → `OWNER_DELEGATION_UNVERIFIED`. Contract wallet → `OWNER_NOT_EOA`. Account-specific messages for each. |
| P0-08 "Wallet changed. Simulate and review again" | A Review bound while no wallet was connected (wallet still restoring, or connected only after a manual Connect) treated `null → wallet` as a wallet change. | CODE | `src/state/review-authorization.ts` | `reviewBindingAdopts` (not-yet-accepted Reviews only, same workflow restoration): wallet-less identity changes, "no wallet" → exactly the Review's owner, and that owner's chain unknown → known. Every other change still retires the Review. |
| P0-09 chat and Canvas | Both build the same Semantic Workflow and use the same stores, estimate route and owner-bound simulation; the P0-07/P0-08 failures were in that shared path. | CODE | (shared) | Fixed once in the shared quote/owner path; no chat-only or Canvas-only path added. |
| P1-01 duplicate address row | Add your wallets rendered a full-address list above the tiles, plus the short address in the tile and again in the status line. | CODE | `add-wallets.tsx`, `account.module.css` | One tile per wallet: status, short address, copy button (copies the full address). Status line no longer repeats the address. |
| P1-02 Privy wallets not usable without Credentials | FloFi (Privy) wallets were registered for explicit selection only (`evm-discovery.ts`: "never passive"), so /app needed Connect Wallet → FloFi Wallet after every load. | CODE | `src/state/account-wallet-autoconnect.tsx` (new), `product-workspace.tsx`, `flofi-wallet-sync.ts` | The account's own FloFi wallet connects when no wallet has been connected on the page yet (remembered or single FloFi wallet per ecosystem): never over an external choice or a silently-authorized wallet, never after a wallet was seen on the page, never after Disconnect (unless a sign-in since), not on approval pages/frames/engineering, no prompt; the automatic choice is not remembered as the person's. |
| P1-03 two wallet sections | "My wallets" (account) and "Wallets" (device references + connections) were separate lists with separate actions and statuses. | CODE | `src/domain/wallet-inventory.ts` (new), `secondary-product-workspace.tsx`, `account-wallets.tsx` | One Wallets section; account wallets merge with the device entry of the same canonical identity (ecosystem + address); Link EVM/Solana buttons removed; export only where the provider supports it; managed wallets not removable. |
| P1-04 Sign out + Disconnect | Two menu entries ran the same flow when signed in. | CODE | `header-settings.tsx` | One Disconnect (full flow when signed in; wallet-only without accounts). |
| P1-05 MetaMask sign-in → onboarding | `nextPath` and `/login` sent every `pending` account to `/onboarding/wallets`, including wallet sign-ins. | CODE (pg test) | `account-model.ts` (`needsWalletOnboarding`), `account-service.ts`, `account-host.ts`, `login/page.tsx` | Onboarding only when the account has no usable wallet (no wallet identity, no Privy/external wallet). Nothing is created or saved silently. |
| P1-06 "Wallet not connected" after MetaMask sign-in | Disconnect sets `evmDisconnected/solanaDisconnected`; nothing cleared them at the next sign-in, so the EVM store never read back the wallet MetaMask had just authorized. | CODE | `src/wallet/sign-in-wallet.ts` (new), `sign-in.tsx`, `account-action.ts` | A server-verified wallet sign-in clears only its own ecosystem's mark (EVM sign-in → EVM; Solana → Solana) and drops a remembered FloFi-wallet preference that would hide it. Google/email/Apple keep both marks; any sign-in only re-allows the account's own FloFi wallets, until the next Disconnect. Silent reads only; no prompt, no authority. |
| P0-10 identity consistency | Distinct concepts confirmed in code: account session (identity), account wallets (stored), wallet session proofs (run ownership for router/payment flows), EVM/Solana store connections (signer), owner-bound Review (`ownerReview.account`). The observed failures were the P1-06 restore gap and the P0-10 binding false positive above. | CODE | as above | No identity was merged; only restore and binding rules changed. |

## 1a. Relayed MetaMask Smart Account submissions (owner decision: option (a))

**Problem.** A MetaMask Smart Account (EIP-7702 delegated EOA) may hand the reviewed call to MetaMask's relayer, which redeems the owner's
signed delegation through the Delegation Manager and pays the fee. Before this change an owner-bound swap recorded such a run as divergent
(`TRANSACTION_BOUNDS_MISMATCH`) and, because the relay never used the owner's nonce, the permanent nonce reservation refused every following
owner-bound swap on that chain (`SWAP_NONCE_ALREADY_RESERVED`).

**Relay evidence used.** The only verified relay data available is the real MetaMask relay already committed in
`src/server/testdata/metamask-delegated-depth1-approval.base-sepolia.json` (public Base Sepolia chain data: type 2, relayer `0xc066…8b8c`,
one `redeemDelegations` of `USDC.approve`). Decoding its logs (this session, read-only, from the committed file) shows how MetaMask relays: an
**open root delegation** (`delegate` = `0x…0a11`, any redeemer) with two caveats, **LimitedCalls(1)** and an exact-execution caveat
(target ‖ value ‖ calldata), and the LimitedCalls enforcer logging `IncreasedCount(DelegationManager, relayer, delegationHash, 1, 1)`.
**Missing:** a recorded relay of a *swap*, and any relay on Arbitrum One or Ethereum mainnet; public RPCs are outside this session's network
policy, so no mainnet chain data was read. Nothing about mainnet relays is assumed beyond that shape: any other shape fails closed.

**What is accepted (`src/server/public-testnet-service.ts`, owner-bound runs only).** A relayed receipt becomes evidence only when all hold:
- `verifyOwnerSubmission` (unchanged): canonical block inclusion; exactly the reviewed call (one call, default mode, value 0, depth 1) decoded
  from a type-2 `redeemDelegations` to the Delegation Manager; owner code = the reviewed DeleGator designator at the prepared and the receipt
  block; one `RedeemedDelegation` naming the owner as root delegator and the sender as redeemer.
- The Review bound that same delegation (`ownerReview.delegation`); the sender is not the owner. A type-4 (new authorization) or depth-2 relay,
  or any other delegated shape, is recorded as `OWNER_SUBMISSION_UNSUPPORTED`.
- **Single use, proven on chain** (`singleUseRelayedDelegation`): the decoded delegation is the owner's root delegation with LimitedCalls(1),
  and LimitedCalls logged its one call for exactly that delegation hash, so the relay can never redeem it again. Otherwise
  `RELAYED_DELEGATION_NOT_SINGLE_USE`. Verified against the recorded relay above (`owner-submission.test.ts`).
- Only the swap's own tokens and pool (WETH only for native/WETH conversions) and the reviewed framework (Delegation Manager, its v1.3 caveat
  enforcers, none of which moves funds) may log; amounts are proven from the receipt (`receiptSwap`, `receiptNative`, the single Approval).
- **One transaction, one attempt:** the hash is claimed create-once (`claim-<chain>-<hash>.tx`); another attempt reporting it is
  `RELAYED_TRANSACTION_ALREADY_CLAIMED`.
- **No duplicate:** before the receipt becomes evidence, every verified relayed execution of the same call since the run first prepared it, and
  a direct one at the reviewed nonce, are looked for; any second execution is `RELAYED_DUPLICATE_EXECUTION`. A wallet "refusal" is trusted for a
  new attempt only after checking it was not relayed (`REJECTED_ATTEMPT_EXECUTED`).
- A **reverted** relay has no logs, so it cannot be tied to the owner and its authorization may still be redeemable: `RELAYED_SUBMISSION_REVERTED`,
  never a final result and never a reservation release.

**Accounting.** For a delegated owner, balances can move through relays without its nonce moving, so its receipts are the proof for direct
submissions too (`OWNER_DELEGATED_ACCOUNT_RECEIPT_RECONCILED`). The owner's fee is what the owner paid: a relayer-paid receipt contributes 0
(`OWNER_SUBMISSION_RELAYED_FEE_PAID_BY_RELAYER`); Base Sepolia pair runs keep reporting the receipt's cost as before. The 0.1% workflow fee,
the slippage bound, `amountIn` and `minimumOut` checks are unchanged. OpenZeppelin-style tokens (aeWETH, ARB) that also log
`Approval(owner, router, remaining)` inside `transferFrom` are accepted (that pair on the input token, at most once).

**Nonce reservation.** Never released because a relay was observed. The intent log stays append-only; a newer reviewed transaction takes nonce
*N* over only when `relayedNonceRelease` holds: the holder's reserved transaction itself is a verified relayed redemption with a canonical,
single-use, fully reconciled receipt, every other holder attempt at *N* is such a relay or a pre-broadcast wallet refusal, and the holder has no
divergence. The hand-over line records the proving attempt and hash. Pending, unknown, unreconciled, reverted, direct or divergent attempts keep
the reservation.

**Lost wallet result.** An attempt without a hash is recovered from verified relayed executions (bounded `eth_getLogs` scan of the Delegation
Manager's `RedeemedDelegation(owner)` from the prepared block: 40 × 5,000 blocks per observation) as well as by nonce.

## 2. What did not change

Mainnet-only scope, the 0.1% workflow fee, the 100 bps default slippage, the Privy signing gate and exact-byte checks, server-side authorization,
direct-submission bounds, and evidence levels. Nonce reservation and reconciliation change only as described in §1a. No schema migration,
environment variable, dependency, CI configuration or required-check change; new durable files are create-once claims (`claim-*.tx`) and
appended intent lines in the existing execution storage (existing one-line intent files remain valid).

## 3. Tests (deterministic, MOCKED)

| ID | Coverage |
| --- | --- |
| T01–T04 | `account-service.pg.test.ts` (Privy embedded wallets saved; next sign-in skips onboarding), `account-wallet-autoconnect.test.ts`, `sign-in-wallet.test.ts` |
| T05 | `account-service.pg.test.ts` (MetaMask sign-in: `walletOnboarding: false`, nothing saved), `account-host.test.ts`, `account-model.test.ts`, `e2e/auth-wallets.spec.ts` (Web3 Wallet → `/app`) |
| T06/T08 | `sign-in-wallet.test.ts`; Disconnect: `e2e/auth-wallets.spec.ts` (no Sign out, session revoked, nothing deleted) |
| T07/T19 | `review-authorization.test.ts` (`reviewBindingAdopts`), `arbitrum-runtime.test.ts` (delegation added after Review → new Review) |
| T09/T10 | `wallet-inventory.test.ts`, `add-wallets.test.tsx` (short address once, copy button, full address only in data/title) |
| T11/T12/T22 | `build-estimate-production.test.ts` (native ETH both directions on Base/Arbitrum/Ethereum; WETH substitution refused), `build-estimate.test.ts` (explicit messages) |
| T16/T18 | `arbitrum-runtime.test.ts` (EOA unchanged; MetaMask Smart Account full approval→swap→reconcile; unknown delegate and contract refused), `account-code.test.ts` |
| Relayed (§1a) | `arbitrum-runtime.test.ts` (MOCKED relay in the recorded shape): USDC → native ETH relayed approval + swap reconciled from receipts, owner fee 0, owner nonce unchanged, hand-over line with evidence; next swap not blocked; reservation kept while PREPARED, unverified, divergent, non-single-use or reverted; lost hash recovered; duplicates (relayed ×2, relayed + direct, after a reported hash); refusal that was relayed; one claim per transaction; aeWETH `transferFrom` Approval (direct and relayed); tampered direct receipt refused; `relayedNonceRelease` cases. `owner-submission.test.ts`: single-use check against the real recorded relay. |
| T13–T15, T17, T20, T21, T23, T24 | Existing suites unchanged and run in `pnpm test` (chat/Canvas parity, Privy signing gate, retry/nonce reservation, automations, MCP and Telegram). No new live evidence. |

## 3a. Gates (this session)

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass (Node 24.22.1 for the first run; typecheck and lint re-run on the pinned 24.21.0 after the review fixes) |
| Final gate at the last code commit (`816eafc`) on the pinned **Node 24.21.0** (official binary, SHA-256 checked against nodejs.org SHASUMS256): `pnpm typecheck`, `pnpm lint`, `pnpm schemas:check`, `pnpm test` | pass: 511 files, 6,220 tests; 2 files skipped by their own environment conditions (as on `main`) |
| Account suites on PostgreSQL 16 (disposable loopback), same commit | 16 files, 142 tests pass |
| `pnpm build` (production) | pass |
| After review fixes: wallet/state/account/Credentials suites; swap, estimate and canvas suites | 62 files / 549 tests; 5 files / 167 tests — pass |
| **Relayed reconciliation + CI fix (this follow-up), pinned Node 24.21.0:** `pnpm check` (typecheck, lint, production build, schema drift, unit tests) | pass: 511 files, 6,238 tests; 2 skipped by their own environment conditions (as on `main`) |
| Swap/relay suites (`arbitrum-runtime`, `owner-submission`, `public-testnet-service`) and every other suite on the mocked chain (`base-swap`, `base-mainnet`, `robinhood-swap`, `ethereum-runtime`, `build-estimate-*`, `robinhood-transfer-mainnet`) | 3 files / 121 tests; 7 files / 179 tests — pass |
| `default-product` specs `base-observation` + `mock-artifact-chain` in the CI image (§3b) | 15/15 pass with the regenerated baselines, no update flags |
| `python3 scripts/governance_lite.py` + its unittest suite | pass (21 tests) |
| `python3 scripts/agent_guard.py check` | pass |
| Browser (guarded runner, pinned chromium_headless_shell-1243, Anvil 1.8.3 publisher-digest verified, disposable loopback PostgreSQL) | `auth-wallets` 15/15, `review-execute-recovery-components` 39/39 (critical tier), `workflow-ux-authoring`, `arbitrum-authoring-certification`: pass on the final build. `default-product`: 99 pass, 9 fail — see below. |

**`default-product` in this sandbox.** The same 9 tests fail on unmodified `origin/main` built and run here the same way (7 visual baselines
render differently in this sandbox, 2 BUILD-009 bridge-quote tests have no reachable route), so they are environmental here, not proof
either way. Comparing this branch's rendered screenshots with `main`'s pixel by pixel: 4 are identical; **3 change on purpose** —
`base-observation › observation-recorded.png` and `mock-artifact-chain › simulate-current.png / simulate-expired.png` — because the
Simulate card now shows the live quote state (e.g. "Quote service is not configured. Contact support.") instead of a fixed "Estimate
unavailable" (P0-07). Those specs now wait for the quote note to settle. **Their committed baselines must be regenerated in the CI rendering
environment**; this sandbox cannot produce CI-identical images (`main`'s own baselines differ here).

## 3b. CircleCI browser failures on PR #150 (commit `fbe1ea7`) and the regenerated baselines

CircleCI pipeline `10210cb0` on `fbe1ea7`: governance, certification-checks and **certification-browser-2 passed**; certification-browser-1 failed
with exactly three tests in `default-product` (read through the CircleCI API; the artifact host itself is outside this session's network policy):

| Test | Cause | Kind |
| --- | --- | --- |
| `base-observation` › WETH to USDC (`observation-recorded.png`) | 3,791 px differ: the Simulate card now shows the live quote state ("Quote service is not configured. Contact support.") instead of a fixed "Estimate unavailable" (P0-07) | intended visual change |
| `mock-artifact-chain` › semantic edits (`simulate-current.png`) and › expiry (`simulate-expired.png`) | The spec's "wait for the quote note to settle" never settles: these tests pause the page clock, so the quote debounce never fires and no request is sent. **Spec bug in this PR**, fixed: the spec now asserts the deterministic pending state ("Calculating estimate…"). | test defect (fixed), then intended visual change |

**Regenerated in the matching CI environment.** The exact CI image (`cimg/node:24.21.0-browsers`, as `.circleci/config.yml`), the pinned Node
24.21.0, and the approved headless shell 1243 extracted by `scripts/bootstrap-playwright.py` from the archive whose SHA-256 matched the pin
(`a9da0288…`, 119,809,080 bytes); same `CI=true`, port and `GRYLOO_MODE_A_E2E=synthetic` settings as the `default-product` profile; the
production build of this branch. Fidelity check before updating: the CI image reproduced **the same three failures, with exactly CI's 3,791 px
difference**, and every other test of both specs passed. `--update-snapshots=changed` then rewrote only failing snapshots. Two more baselines
in the same tests, `observation-expired.png` and `simulate-invalidated.png`, had never been reached (each sits after the first failing
assertion of its test, in CI too) and failed once the first ones passed; their diffs were inspected and are the same note change only (diff
bounding boxes confined to the quote note: 3,791 px and 300 px). Five baselines changed in total; after regeneration both specs pass
**15/15 in the CI image without update flags**. No screenshot assertion, threshold or required check was changed or skipped.

## 3c. Specialist reviews (`.claude/agents/flofi-*.md`, read-only)

`agent_guard.py impact` selects all 19 domains because `coverage.json` changed; the domains this diff actually touches were reviewed. The
repository hook refuses `SubagentHandback` to reviewers, so their reports were read from their final messages.

| Specialist | Result | Disposition |
| --- | --- | --- |
| flofi-swap | 7 (1 medium) | Fixed: owner account code re-checked at the receipt block (`OWNER_ACCOUNT_CODE_MISMATCH`); Execute plan shows no live estimate beside reviewed amounts; network-failure message ordering; native estimate side requires 18 decimals on the node's chain. Relayed submissions (medium): implemented by owner decision, §1a, nonce-only concurrency for 7702 redemptions, Base/Robinhood owner code (pre-existing, not owner-bound). |
| flofi-security | 5 (1 medium) | Fixed: sign-in clears only the ecosystem just used; Google/email/Apple re-allow only the account's own FloFi wallets (medium); adoption never for accepted Reviews; managed wallets not removable from Credentials; auto-connect re-checks live state and does not record its choice. Documented: DeleGator allowlist is address-based (no pinned runtime code hash available offline), §4.1. |
| flofi-wallet-execution | 8 (3 medium) | Fixed: auto-connect latch (never replaces a locked MetaMask), live re-check before connecting, not remembered as the person's choice, off on `/approve` and in engineering scope; two-step connect adoption; Solana sign-in rule; swap panel messages. **M3 (medium): owner chose relayed reconciliation, implemented in §1a.** |
| flofi-workflow | 4 (1 medium) | Fixed: an owner already connected when the Review appeared may have its chain become known; Execute-stage cards show no bare "Estimate unavailable". Documented: Reviews without an owner (Base/Robinhood swaps are not owner-bound) still retire on reconnect (fails closed, §4.4); hook wiring is tested through the pure rule only. |
| flofi-data-privacy | 5 (1 medium) | Fixed: an automatic FloFi connection restores the remembered wallet **and** Disconnect mark exactly (medium); "Remove from this device" for managed wallets saved on the device; synthetic test addresses and no full user address in this record; Disconnect forgets a remembered FloFi wallet. Documented: a wallet sign-in re-allows the passively read wallet of that ecosystem, which may differ from the signing wallet when several are installed (§4.8). |
| flofi-frontend-ux | 14 (2 medium) | Fixed: Execute cards (medium, with workflow); honest Credentials sign-in notice (medium); transport failures no longer blamed on the provider; Disconnect accessible description; FloFi wallet "still loading"; stable card keys/order; pt-BR wording for new strings; robust copy buttons; live region; dead CSS. Documented: status-pill axes, same address under two providers stays two device references (owner confirmation), brief empty state before the account loads, header Disconnect enabled while a wallet request is busy (as the former Sign out was). |

**Second round — relayed reconciliation (§1a)**, given the full diff and their domain reports (the hook also blocked their scratchpad reads,
so they reviewed the working tree directly):

| Specialist | Result | Disposition |
| --- | --- | --- |
| flofi-wallet-execution | 6 (1 high, 1 medium) | Fixed: receipt proof refused OpenZeppelin-style `transferFrom` Approval bookkeeping (high: aeWETH/ARB swaps by Smart Accounts would have diverged); duplicate detection now also when the wallet reported a hash, and a candidate not yet final keeps the attempt pending (medium); reverted relays never release (low); WETH allowed only for native runs (low). Documented: identical calldata in two concurrent runs (first claim wins, the other diverges), `eth_getLogs` errors make observation retry. Confirmed sound: hand-over race between two `begin()` calls, crash-safe claims, reservation kept while unresolved. |
| flofi-security | 4 (2 medium) | Fixed: reverted relays are `RELAYED_SUBMISSION_REVERTED`, never terminal success or release evidence (medium); duplicates after a reported hash and refusals that were relayed (medium); WETH logs (low); the hand-over race depended on reverted relays (low). Answered: replay of another run's hash blocked (owner-bound Redeemed log, claim registry); crafted shapes (batch, nested, payment enforcers, native value) refused; framework allowlist acceptable; discovery not foolable by reorg/other chains. |
| flofi-swap | 7 (1 medium) | Fixed: the same `transferFrom` Approval issue (medium) with aeWETH tests direct and relayed; WETH logs; relayer-fee label only on owner-bound runs; harness relay now reproduces the recorded log shapes (encoded delegation, `IncreasedCount`); harness `eth_getLogs` refuses unsupported filters; direct Smart Account test asserts the receipt proof, fees and labels; tampered direct receipt refused. Documented: fee-on-transfer tokens fail closed for delegated owners. |

Additionally, beyond the reviews: relayed acceptance now requires a **single-use** delegation proven on chain (LimitedCalls(1) counted for
exactly the redeemed delegation), verified against the real recorded relay.

Not invoked, with reasons: flofi-mcp, flofi-channels and flofi-developers — none of their modules imports the changed code (searched);
they reach swaps only through backend flows by name, whose quote result gains one optional field (`ownerReview.delegation`) and one refusal
code (`OWNER_DELEGATION_UNVERIFIED`); their schema/OpenAPI/boundary unit suites ran in `pnpm test`. flofi-admin-analytics, automations,
bridge, chat, infrastructure-ci, lending, liquidity, payments-billing, protocol-integrations, transfer-payments — selected only by the
`coverage.json` governance change and shared-core propagation; no source of theirs changed; their regression suites ran in `pnpm test`.
`agent_guard.py review --base origin/main` therefore reports them as not invoked.

## 4. Remaining gaps (honest)

**Evidence levels in this build.** MOCKED: every swap, relay, wallet and account test (in-memory chain and loopback harnesses; a MOCKED run is
never labelled as public execution). RECORDED: the relay shape and the single-use proof come from one real MetaMask relay on Base Sepolia
(public chain data committed earlier), not from Arbitrum or Ethereum mainnet. PROD-LOG: the P0-07 root cause (read-only Vercel/Railway logs).
CI-IMAGE: the browser baselines (§3b). **None of this is mainnet execution evidence.**

**Still requires real, user-authorized mainnet validation** (by the owner, through the reviewed wallet flow; never automated):
- a MetaMask Smart Account swap on Arbitrum One or Ethereum, both when MetaMask sends it directly and when it relays it: that the relay uses the
  recorded shape (type 2, depth 1, single-use LimitedCalls(1)), returns the relayer transaction hash to FloFi, and reconciles with an owner fee of 0;
- the following owner-bound swap starting without `SWAP_NONCE_ALREADY_RESERVED`;
- a native-ETH side (USDC → ETH) quoted and executed on Arbitrum, and aeWETH/ARB inputs reconciling for a Smart Account;
- Privy embedded wallets connecting in /app after creation, and MetaMask sign-in landing in /app connected.

1. **Relayed submissions — residual limits (owner decision implemented, §1a).**
   - Only the verified shape is reconciled. A relay with a new authorization (type 4), a redelegation (depth 2), a batch (e.g. gas paid in a token),
     a non-single-use delegation, or a revert is recorded as divergent with a named code. Its nonce reservation is then kept: the owner unblocks
     that chain's next owner-bound swap by sending any direct transaction from the account (which advances the nonce). Fail-closed, never a
     wrong credit.
   - The owner still needs ETH for the reviewed fee budget at Execute: FloFi cannot know beforehand whether the wallet will relay.
   - Duplicates are detected among executions present when the receipt is reconciled (and before any retry after a refusal). A single-use
     relayed delegation cannot run again; a further execution would need a new owner authorization in the wallet.
   - Lost-hash discovery scans at most 40 × 5,000 blocks per observation from the prepared block (~14 h on Arbitrum One, ~28 days on Ethereum);
     an older relay stays unresolved (reservation kept). Provider `eth_getLogs` range limits or errors make observation retry; nothing is adopted.
   - Two concurrent runs of the same owner with byte-identical calls (e.g. the same approval) and one relayed transaction: the first
     observation claims it, the other run is recorded as divergent.
   - Fee-on-transfer tokens fail closed for delegated owners (receipt proof needs exact transfer amounts).
   - The DeleGator and framework allowlists are address-based (MetaMask's deterministic deployment); pinning runtime code hashes per network needs
     a verified on-chain read.
2. **Smart Account transfers (outstanding).** EIP-7702 accounts are accepted for **swaps** only, and only for the reviewed MetaMask DeleGator.
   Native/token **transfers** keep the EOA-only rule (their reconciliation proves balances by exact deltas, and a delegated owner's code can run on
   a self-transfer); a delegated MetaMask account gets an accurate transfer-specific message. Not resolved here.
3. **Safe / ERC-4337 (outstanding).** Contract wallets remain unsupported: FloFi's flows ask the connected account to originate the reviewed
   transaction; ERC-1271/4337 execution is not implemented.
4. **Base / Robinhood wallet reconnection (outstanding).** Reviews without a bound owner (Base and Robinhood swaps, which are not owner-bound)
   still show "Wallet changed" when the wallet reconnects after a reload; adopting an arbitrary first wallet there is not provably safe (fails
   closed). Not resolved here.
5. **MCP timeout incident (outstanding).** Production logs showed `/api/mcp` 300 s timeouts (2026-11-01 18:19–18:20 UTC). Outside this build;
   not investigated or fixed here.
6. Cross-chain single-authorization is unchanged (one signature per chain-specific transaction).
7. The navigation drawer keeps its existing "Logout" entry (same Disconnect flow).
8. A wallet sign-in clears that ecosystem's Disconnect mark; with several wallets installed, the silently read one may not be the one that
   signed in (the browser does not receive the verified address). Signing still needs that wallet's own confirmation.
9. External wallets can no longer be linked to the account from Credentials (the requested removal of "Link EVM/Solana wallet"); a wallet
   sign-in still records the wallet as the account's sign-in identity, and Add wallet keeps device references.

## 5. Deployment and rollback

- Components: Vercel (product pages, server actions, `/api/build-estimate`) and the Railway API (`arbitrum-swap`/`ethereum-swap` owner-bound
  simulation runs there). Deploy both from the merged commit; the estimate fix needs only Vercel, the owner-type fix needs Railway.
- No migration or variable. Neon is untouched. The swap service's execution storage gains create-once `claim-<chain>-<hash>.tx` entries and,
  only after a verified relay, appended hand-over lines in existing `swap-*.intent` logs (older one-line intents stay valid).
- Rollback: revert the merge commit and redeploy (or promote the previous Vercel deployment / Railway deployment). Stored data is unaffected;
  Reviews created with `ownerReview.delegation` simply expire.
