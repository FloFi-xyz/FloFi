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
| 2a | Right after step 2, Settings → Delete account is offered without "Sign in again" (cancel before confirming) | Privy updated the sign-in's verification time (`latest_verified_at`); if FloFi says "That sign-in was already used or is too old" on a fresh login instead, Privy's verification time is not updated on login: **NO-GO** |
| 2b | Signed in, delete only the `flofi_account_session` cookie in DevTools (the Privy session stays), then open `/login?privy_oauth_code=x&privy_oauth_state=y` | No FloFi session is opened from the leftover Privy session: the page signs Privy out, shows the sign-in methods, and no `flofi_account_session` cookie is set |
| 5 | Import key (EVM) with a **freshly generated, unfunded** key | Back on Add your wallets with the address and "Imported"; DevTools → Network shows the key only in requests to `auth.privy.io`, never to the Preview's origin; the key field is a masked text field in Chrome and Safari (a password field elsewhere); the browser's own password manager (Chrome, Firefox, Safari) does not offer to save the key; on Android Chrome the keyboard offers no suggestions from the key — record each result per browser |
| 6 | Continue, then Settings → Disconnect | Lands on `/login`; Back does not show signed-in pages; reloading `/login` does not sign in; the Privy dashboard shows the session ended |
| 7 | Email code sign-in with the same test mailbox after linking it (or a new one) | Privy sends the code; wrong code refused; right code signs in |
| 7a | Returning sign-in: Disconnect, wait **at least 11 minutes**, then sign in again with the same Google account; repeat with the same mailbox (email code) and, after step 8, the same extension wallet | Each returning sign-in succeeds and reaches the same account. A "That sign-in was already used or is too old" refusal means Privy did not update its verification time on that login: **NO-GO** (every returning user would be refused) |
| 8 | Web3 Wallet with the extension wallet | Privy's SIWE/SIWS prompt; signed in; the wallet is not listed as a FloFi wallet |
| 9 | My wallets → Export (Privy wallet) | Privy's own export screen shows the key; FloFi never does; record whether Privy asked for MFA or re-authentication first (dashboard setting) |
| 10a | Open `/app`, `/approve` and `/connections` signed in, DevTools console open | No CSP violation from FloFi or Privy (Privy loads, the wallet shows "Managed by Privy"); `document.querySelectorAll('script[src]')` lists only the Preview's own `/_next/` scripts; the response's `Content-Security-Policy` has `script-src 'self' 'nonce-…' 'unsafe-eval'` and no other host (the bot-check loader's host appears on `/login` only, when `FLOFI_PRIVY_BOT_PROTECTION` is set); from `/` click through to `/app`: the page reloads once (no loop) and the wallet works |
| 10b | Credentials → Add card (Preview with `FLOFI_CARD_ORIGIN` and Mercado Pago **test** credentials) | The dialog frames `https://<card origin>/card-entry`; Mercado Pago's fields load there (not in `/app`: `window.MercadoPago` is undefined in the `/app` console); Mercado Pago's test card is added; opening `/card-entry` on the product origin is 404. Record whether Mercado Pago's SDK worked on the card origin |
| 10 | Signing (owner decision only) | Mainnet only, real funds: a trivial amount on Base or Solana, after Simulate → Review → Strategy Manifest → Authorize; Privy's confirmation names FloFi's reviewed strategy and run; FloFi broadcasts once and reconciles, with no "cannot confirm the broadcast" (`FLOFI_WALLET_SIGNATURE_UNKNOWN`): that would mean Privy changed a signed field and FloFi refused the bytes — **NO-GO** for EVM signing |

Record the date, Preview URL, Privy app id (public), the commit and each result in the build record (§Live verification). Do not record
tokens, codes, keys or the app secret. Delete the Preview's Privy test users afterwards.
