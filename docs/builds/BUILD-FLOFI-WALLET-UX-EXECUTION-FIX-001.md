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
| P0-07 "Estimate unavailable" on Simulate/Execute canvas | Inspection cards hard-coded "Estimate unavailable" and never requested the shared quote. | CODE | `composer-card.tsx`, `simulate-workflow-canvas.tsx` | Inspection cards use the same live quote (display only), or say why there is none. |
| P0-07 unexplained "Quote unavailable" | Any unmapped code fell back to a bare "Quote unavailable". | CODE | `src/domain/build-estimate.ts` | Explicit messages for unsupported/dependent/test-network/inconsistent-network/insufficient-balance; generic fallback explains itself and shows a reference code. |
| P0-08 "This wallet is a smart contract account" | Owner-bound swaps (Arbitrum One, Ethereum: `ownerBoundReview: true`) refuse any owner whose `eth_getCode` is not exactly `0x` (`bindSwapOwner` → `OWNER_NOT_EOA`). MetaMask "Smart Accounts" are EIP-7702 delegated EOAs: code `0xef0100 ‖ 0x63c0…e32b`. The same service's `verifyOwnerSubmission` already reconciles MetaMask Delegation Framework submissions (`DELEGATOR_IMPL`), so only the preflight guard blocked them. | CODE (the only producer of that message). HYPOTHESIS that the reported MetaMask account (`0x4b21…b3ce`) is 7702-upgraded: public RPCs are outside this session's network policy. Owner check (read-only): `cast code 0x4b212af0a923256961487ae72499ca79f920b3ce --rpc-url <arbitrum rpc>` — `0xef0100…` confirms. | `packages/reference-compiler/src/account-code.ts` (new), `src/server/public-testnet-service.ts` | EOA → unchanged. EIP-7702 delegated to the reviewed MetaMask DeleGator → accepted; the delegate is bound into the Review (`ownerReview.delegation`, part of `manifestHash`) and a change before Execute needs a new Review. Unknown delegate → `OWNER_DELEGATION_UNVERIFIED`. Contract wallet → `OWNER_NOT_EOA`. Account-specific messages for each. |
| P0-08 "Wallet changed. Simulate and review again" | A Review bound while no wallet was connected (wallet still restoring, or connected only after a manual Connect) treated `null → wallet` as a wallet change. | CODE | `src/state/review-authorization.ts` | `reviewBindingAdopts`: adopt only the Review's own owner, only from "no wallet", only within the same workflow restoration; every other change still retires the Review. |
| P0-09 chat and Canvas | Both build the same Semantic Workflow and use the same stores, estimate route and owner-bound simulation; the P0-07/P0-08 failures were in that shared path. | CODE | (shared) | Fixed once in the shared quote/owner path; no chat-only or Canvas-only path added. |
| P1-01 duplicate address row | Add your wallets rendered a full-address list above the tiles, plus the short address in the tile and again in the status line. | CODE | `add-wallets.tsx`, `account.module.css` | One tile per wallet: status, short address, copy button (copies the full address). Status line no longer repeats the address. |
| P1-02 Privy wallets not usable without Credentials | FloFi (Privy) wallets were registered for explicit selection only (`evm-discovery.ts`: "never passive"), so /app needed Connect Wallet → FloFi Wallet after every load. | CODE | `src/state/account-wallet-autoconnect.tsx` (new), `product-workspace.tsx`, `flofi-wallet-sync.ts` | The account's own FloFi wallet connects when nothing is connected (remembered or single FloFi wallet per ecosystem), never over an external choice, never after Disconnect, never in an embedding frame, no prompt. |
| P1-03 two wallet sections | "My wallets" (account) and "Wallets" (device references + connections) were separate lists with separate actions and statuses. | CODE | `src/domain/wallet-inventory.ts` (new), `secondary-product-workspace.tsx`, `account-wallets.tsx` | One Wallets section; account wallets merge with the device entry of the same canonical identity (ecosystem + address); Link EVM/Solana buttons removed; export only where the provider supports it; managed wallets not removable. |
| P1-04 Sign out + Disconnect | Two menu entries ran the same flow when signed in. | CODE | `header-settings.tsx` | One Disconnect (full flow when signed in; wallet-only without accounts). |
| P1-05 MetaMask sign-in → onboarding | `nextPath` and `/login` sent every `pending` account to `/onboarding/wallets`, including wallet sign-ins. | CODE (pg test) | `account-model.ts` (`needsWalletOnboarding`), `account-service.ts`, `account-host.ts`, `login/page.tsx` | Onboarding only when the account has no usable wallet (no wallet identity, no Privy/external wallet). Nothing is created or saved silently. |
| P1-06 "Wallet not connected" after MetaMask sign-in | Disconnect sets `evmDisconnected/solanaDisconnected`; nothing cleared them at the next sign-in, so the EVM store never read back the wallet MetaMask had just authorized. | CODE | `src/wallet/sign-in-wallet.ts` (new), `sign-in.tsx`, `account-action.ts` | A server-verified sign-in clears the marks (and, for a wallet sign-in, drops a remembered FloFi-wallet preference that would hide MetaMask). Silent reads only; no prompt, no authority. |
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

## 4. Remaining gaps (honest)

1. **No live evidence.** No real Privy, MetaMask or mainnet signing/execution was performed. Green tests are MOCKED evidence only.
2. EIP-7702 accounts are accepted for **swaps** only, and only for the reviewed MetaMask DeleGator. Native/token **transfers** keep the EOA-only
   rule (their reconciliation proves balances by exact deltas and a delegated owner's code can run on a self-transfer); a delegated MetaMask
   account now gets an accurate transfer-specific message. Other delegates need a code review before being added to `VERIFIED_EIP7702_DELEGATES`.
3. Contract wallets (Safe, ERC-4337 accounts) remain unsupported: FloFi's flows ask the connected account to originate the reviewed
   transaction; ERC-1271/4337 execution is not implemented.
4. If MetaMask relays a transaction in a shape `verifyOwnerSubmission` does not know (e.g. gas paid in a token through a third-party relayer),
   reconciliation fails closed (UNKNOWN/DIVERGENT); nothing is reported as executed.
5. Cross-chain single-authorization is unchanged (one signature per chain-specific transaction).
6. The navigation drawer keeps its existing "Logout" entry (same Disconnect flow).
7. Production logs also showed `/api/mcp` 300 s timeouts (18:19–18:20 UTC) — outside this build.

## 5. Deployment and rollback

- Components: Vercel (product pages, server actions, `/api/build-estimate`) and the Railway API (`arbitrum-swap`/`ethereum-swap` owner-bound
  simulation runs there). Deploy both from the merged commit; the estimate fix needs only Vercel, the owner-type fix needs Railway.
- No migration or variable. Neon is untouched.
- Rollback: revert the merge commit and redeploy (or promote the previous Vercel deployment / Railway deployment). Stored data is unaffected;
  Reviews created with `ownerReview.delegation` simply expire.
