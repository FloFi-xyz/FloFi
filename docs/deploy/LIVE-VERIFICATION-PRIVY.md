# Live verification: Privy sign-in, wallets and signing (BUILD-FLOFI-PRIVY-UX-001)

The browser suite (`playwright.auth-wallets.config.ts`) proves FloFi's own flows against a MOCKED loopback Privy stand-in. It cannot prove
Privy itself: the official React SDK talks to `auth.privy.io` and runs the wallet in Privy's frame, which no offline test can host. This
runbook is the live check, run by the owner (or with the owner) on an isolated **Preview** — never on production data, never with a real
person's account, never with a seed phrase or key anyone uses.

## Setup (owner)

1. A dedicated Privy app for previews (not the production app). Allowed origin: the Preview's origin. Login methods: Google, email, wallet.
   Embedded wallets for Ethereum and Solana, automatic creation **off**. No session signers, no policies, no delegated actions.
2. A Preview deployment of the PR with its own empty database (schema 19), `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET` of that app,
   optionally `PRIVY_VERIFICATION_KEY`. No `FLOFI_PRIVY_E2E`, no `PRIVY_API_URL`.
3. Disposable test identities only: a test Google account, a mailbox you control, a fresh browser-extension wallet with no funds.

## Checks

| # | Action | Expected |
| --- | --- | --- |
| 1 | Open `/login` | Google, Email, Web3 Wallet; no CSP errors in the console (Privy frame `auth.privy.io` loads) |
| 2 | Google | Privy's Google sign-in, back on the Preview, then **Add your wallets**; no second Google prompt |
| 3 | Create wallet (EVM), then (Solana) | Each address appears in its card within seconds; no extra sign-in, unlock screen or pop-up; buttons disabled while running; the Privy dashboard shows both embedded wallets on the test user |
| 4 | Reload during step 3 (create, then reload at once) | The wallet appears after the reload (recovery); never two wallets of the same kind |
| 5 | Import key (EVM) with a **freshly generated, unfunded** key | Back on Add your wallets with the address and "Imported"; DevTools → Network shows the key only in requests to `auth.privy.io`, never to the Preview's origin; the browser's own password manager (Chrome, Firefox, Safari) does not offer to save the key — record the result per browser |
| 6 | Continue, then Settings → Disconnect | Lands on `/login`; Back does not show signed-in pages; reloading `/login` does not sign in; the Privy dashboard shows the session ended |
| 7 | Email code sign-in with the same test mailbox after linking it (or a new one) | Privy sends the code; wrong code refused; right code signs in |
| 8 | Web3 Wallet with the extension wallet | Privy's SIWE/SIWS prompt; signed in; the wallet is not listed as a FloFi wallet |
| 9 | My wallets → Export (Privy wallet) | Privy's own export screen shows the key; FloFi never does; record whether Privy asked for MFA or re-authentication first (dashboard setting) |
| 10 | Signing (owner decision only) | Mainnet only, real funds: a trivial amount on Base or Solana, after Simulate → Review → Strategy Manifest → Authorize; Privy's confirmation names FloFi's reviewed strategy and run; FloFi broadcasts once and reconciles |

Record the date, Preview URL, Privy app id (public), the commit and each result in the build record (§Live verification). Do not record
tokens, codes, keys or the app secret. Delete the Preview's Privy test users afterwards.
