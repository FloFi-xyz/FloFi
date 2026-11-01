# BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 — Wallet UX, session continuity and real execution blockers

**Status:** ready for owner review. Branch `claude/clever-newton-bjdy6d`, based on `main` at `b8126a6` (PR #148 merged). Nothing is merged,
deployed or configured. Production was only **read** (Railway and Vercel logs); no production database, variable, credential or deployment was
changed, and no transaction was signed or submitted.

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

## 2. What did not change

Mainnet-only scope, the 0.1% workflow fee, the 100 bps default slippage, the Privy signing gate and exact-byte checks, server-side authorization,
nonce reservation, reconciliation and evidence levels. No schema migration, environment variable, dependency or CI change.

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
| T13–T15, T17, T20, T21, T23, T24 | Existing suites unchanged and run in `pnpm test` (chat/Canvas parity, Privy signing gate, retry/nonce reservation, automations, MCP and Telegram). No new live evidence. |

## 3a. Gates (this session)

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass (Node 24.22.1 for the first run; typecheck and lint re-run on the pinned 24.21.0 after the review fixes) |
| `pnpm schemas:check`, `pnpm test` (unit) on the pinned **Node 24.21.0** (official binary, SHA-256 checked against nodejs.org SHASUMS256) | pass: 511 files, 6,213 tests; 2 files skipped by their own environment conditions (as on `main`). Run before the review-fix commits; the affected suites were re-run after them (see below). |
| Account suites on PostgreSQL 16 (disposable loopback) | 16 files, 142 tests pass |
| After review fixes: wallet/state/account/Credentials suites; swap, estimate and canvas suites | 62 files / 549 tests; 5 files / 167 tests — pass |
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

## 3b. Specialist reviews (`.claude/agents/flofi-*.md`, read-only)

`agent_guard.py impact` selects all 19 domains because `coverage.json` changed; the domains this diff actually touches were reviewed. The
repository hook refuses `SubagentHandback` to reviewers, so their reports were read from their final messages.

| Specialist | Result | Disposition |
| --- | --- | --- |
| flofi-swap | 7 (1 medium) | Fixed: owner account code re-checked at the receipt block (`OWNER_ACCOUNT_CODE_MISMATCH`); Execute plan shows no live estimate beside reviewed amounts; network-failure message ordering; native estimate side requires 18 decimals on the node's chain. Documented: relayed submissions (medium, §4.4), nonce-only concurrency for 7702 redemptions, Base/Robinhood owner code (pre-existing, not owner-bound). |
| flofi-security | 5 (1 medium) | Fixed: sign-in clears only the ecosystem just used; Google/email/Apple re-allow only the account's own FloFi wallets (medium); adoption never for accepted Reviews; managed wallets not removable from Credentials; auto-connect re-checks live state and does not record its choice. Documented: DeleGator allowlist is address-based (no pinned runtime code hash available offline), §4.2. |
| flofi-wallet-execution | 8 (3 medium) | Fixed: auto-connect latch (never replaces a locked MetaMask), live re-check before connecting, not remembered as the person's choice, off on `/approve` and in engineering scope; two-step connect adoption; Solana sign-in rule; swap panel messages. **Owner decision (M3, medium), §4.4.** |
| flofi-workflow | 4 (1 medium) | Fixed: an owner already connected when the Review appeared may have its chain become known; Execute-stage cards show no bare "Estimate unavailable". Documented: Reviews without an owner (Base/Robinhood swaps are not owner-bound) still retire on reconnect (fails closed, §4.8); hook wiring is tested through the pure rule only. |
| flofi-data-privacy | 5 (1 medium) | Fixed: an automatic FloFi connection restores the remembered wallet **and** Disconnect mark exactly (medium); "Remove from this device" for managed wallets saved on the device; synthetic test addresses and no full user address in this record; Disconnect forgets a remembered FloFi wallet. Documented: a wallet sign-in re-allows the passively read wallet of that ecosystem, which may differ from the signing wallet when several are installed (§4.9). |
| flofi-frontend-ux | 14 (2 medium) | Fixed: Execute cards (medium, with workflow); honest Credentials sign-in notice (medium); transport failures no longer blamed on the provider; Disconnect accessible description; FloFi wallet "still loading"; stable card keys/order; pt-BR wording for new strings; robust copy buttons; live region; dead CSS. Documented: status-pill axes, same address under two providers stays two device references (owner confirmation), brief empty state before the account loads, header Disconnect enabled while a wallet request is busy (as the former Sign out was). |

Not invoked, with reasons: flofi-mcp, flofi-channels and flofi-developers — none of their modules imports the changed code (searched);
they reach swaps only through backend flows by name, whose quote result gains one optional field (`ownerReview.delegation`) and one refusal
code (`OWNER_DELEGATION_UNVERIFIED`); their schema/OpenAPI/boundary unit suites ran in `pnpm test`. flofi-admin-analytics, automations,
bridge, chat, infrastructure-ci, lending, liquidity, payments-billing, protocol-integrations, transfer-payments — selected only by the
`coverage.json` governance change and shared-core propagation; no source of theirs changed; their regression suites ran in `pnpm test`.
`agent_guard.py review --base origin/main` therefore reports them as not invoked.

## 4. Remaining gaps (honest)

1. **No live evidence.** No real Privy, MetaMask or mainnet signing/execution was performed. Green tests are MOCKED evidence only.
2. EIP-7702 accounts are accepted for **swaps** only, and only for the reviewed MetaMask DeleGator. Native/token **transfers** keep the EOA-only
   rule (their reconciliation proves balances by exact deltas and a delegated owner's code can run on a self-transfer); a delegated MetaMask
   account now gets an accurate transfer-specific message. Other delegates need a code review before being added to `VERIFIED_EIP7702_DELEGATES`.
   The allowlist is address-based (the MetaMask Delegation Framework's deterministic deployment, as `verifyOwnerSubmission` already trusts);
   pinning the DeleGator's runtime code hash per network needs a verified on-chain read and is a follow-up.
3. Contract wallets (Safe, ERC-4337 accounts) remain unsupported: FloFi's flows ask the connected account to originate the reviewed
   transaction; ERC-1271/4337 execution is not implemented.
4. **Owner decision — relayed EIP-7702 submissions (wallet-execution M3, swap #1).** Owner-bound swaps reconcile only a *direct*
   transaction from the owner. If MetaMask relays a Smart Account's swap instead (for example gas paid in a token through its relayer, or a
   Delegation Manager redemption), the swap still executes on chain exactly as reviewed, but FloFi records the run as divergent
   (`TRANSACTION_BOUNDS_MISMATCH`/`TRANSACTION_MISMATCH`) and, because the owner's own nonce was never used, the permanent nonce reservation
   keeps refusing the next owner-bound swap on that chain (`SWAP_NONCE_ALREADY_RESERVED`) until the account sends a direct transaction. This
   is fail-closed (no wrong authority, no duplicate, nothing reported as executed), and MetaMask's plain `eth_sendTransaction` from a Smart
   Account is a direct type-2 transaction. Not changed here: releasing or reinterpreting that reservation, or reconciling relayed shapes,
   changes a financial-core invariant and needs real relay evidence. Options: (a) implement relayed-shape reconciliation with an explicit
   reservation hand-over; (b) refuse EIP-7702 owners again (restores the P0-08 blocker for MetaMask Smart Accounts).
5. Cross-chain single-authorization is unchanged (one signature per chain-specific transaction).
6. The navigation drawer keeps its existing "Logout" entry (same Disconnect flow).
7. Production logs also showed `/api/mcp` 300 s timeouts (18:19–18:20 UTC) — outside this build.
8. Reviews without a bound owner (Base and Robinhood swaps, which are not owner-bound) still show "Wallet changed" when the wallet
   reconnects after a reload; adopting an arbitrary first wallet there is not provably safe (fails closed).
9. A wallet sign-in clears that ecosystem's Disconnect mark; with several wallets installed, the silently read one may not be the one that
   signed in (the browser does not receive the verified address). Signing still needs that wallet's own confirmation.
10. External wallets can no longer be linked to the account from Credentials (the requested removal of "Link EVM/Solana wallet"); a wallet
    sign-in still records the wallet as the account's sign-in identity, and Add wallet keeps device references.

## 5. Deployment and rollback

- Components: Vercel (product pages, server actions, `/api/build-estimate`) and the Railway API (`arbitrum-swap`/`ethereum-swap` owner-bound
  simulation runs there). Deploy both from the merged commit; the estimate fix needs only Vercel, the owner-type fix needs Railway.
- No migration or variable. Neon is untouched.
- Rollback: revert the merge commit and redeploy (or promote the previous Vercel deployment / Railway deployment). Stored data is unaffected;
  Reviews created with `ownerReview.delegation` simply expire.
