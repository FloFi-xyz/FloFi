# Authentication UX & Login Regression Fix — P0 Google sign-in ("Sign-in did not complete. Try again."), login and Sign-in methods

**Scope:** the owner's request of November 17, 2026 (after PR #211): the pending items of the Authentication UX & Login Regression Fix build, with
the P0 first. Branch `claude/eloquent-meitner-znoy3t`, restarted from `main` at `ac46d39` (PRs #210 and #211 included and unchanged in
behaviour). **No migration, schema, dependency, environment variable, Privy dashboard setting or database correction.** No production record
was read or changed from this session; the owner's two accounts are not special-cased anywhere.

Evidence levels: **CODE** unit tests · **PG/BROWSER** production build, headless Chromium, loopback PostgreSQL and FloFi's MOCKED Privy stand-in
(a regression guard only: **never** proof of how Privy or Google behave) · **SDK** reading the shipped `@privy-io/react-auth` 3.51.0 source ·
**OWNER** needs the owner's real Google account, real Privy app and real wallet (not run here).

## 1. What already existed on `main` (not redone)

| Requirement | On `main` before this build | This build |
|---|---|---|
| Recovery page "You boarded with another sign-in." | Simplified in PR #211 (one action, help on request) | Unchanged |
| Duplicate prevention at sign-in, empty-duplicate retirement, Google link through FloFi's window | BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (B1–B6) | Unchanged (same proofs) |
| Login screen simplification | Not done | §4 |
| Sign-in methods management simplification | Only the focused move/link step (PR #211) | §5 |
| Login with a Privy session left in the browser | Ended asynchronously while the methods were already clickable | §3.1 (P0) |
| Other account sent to wallet onboarding | Yes (no gate) | §3.2 (P0) |

## 2. The production evidence and what it means

Owner's read-only query (Neon production), as reported:
- account A `acct_3f49…c305` — PRIVY + EIP155, Boarding Pass #001, Founding Seat #001, beta access active, last access 17/11 17:23 UTC;
- account B `acct_7830…1e06` — GOOGLE (`alrimar6@gmail.com`), authenticated 23:33:03 UTC, **session revoked 23:33:21 UTC**.

So Google **did** sign in (to B). FloFi revokes a session only in these code paths (all in `src/app/account-action.ts`): sign-out
(`accountSignOut`), the start of a move (`startAccountMove`), a superseding sign-in in the same browser, a refused step-up
(`ACCOUNT_REAUTH_OTHER_ACCOUNT`) and the hand-off of a just-created duplicate (`privyMoveToExisting`, revoked at once). An 18-second gap is a
person's click: since PR #211 (live from ~23:31 UTC), B's sign-in lands on `/board` → "Continue to my account" → `startAccountMove`, which
**revokes B's session by design** and sends the person to `/login?move=1` to sign in to A (or, when B cannot be closed, "Sign in with the method I
boarded with", which signs out). A's last access did not change, so **the sign-in to A on the next page never reached FloFi**.

**Root cause (SDK + CODE):** `/board` ends FloFi's session but never Privy's (it does not host Privy), so the login page opens with **B's Privy
session still alive**. The login page ended it with a fire-and-forget `logout()` once Privy was ready, while the method buttons were already
enabled. Privy's real SDK (3.51.0) does not start a login over a live session:
- `login()` (Web3 Wallet, the modal) only warns `"Attempted to log in, but user is already logged in"` — nothing happens;
- the wallet signature step throws `"User already authenticated"`;
- a Google return finds the session and either **links** Google to that session's user or, when it already has Google, only warns
  `"User is already logged in with this OAuth provider"` — no completion, no error: the page waited on "Signing you in…" forever.

None of these texts matched a FloFi code, so they reached the person as the generic **"Sign-in did not complete. Try again."**, and every retry
in that tab hit the same live session. The emulator could not show it: it simply logged in again over a session.

**Aggravating cause (CODE):** after any sign-in, an account with no usable wallet is sent to wallet onboarding first — including the person's
**other** account, which has no beta access. "Create wallet" there makes it hold a wallet, so it can **never** be closed as an empty duplicate
(`ACCOUNT_MOVE_HAS_WALLET` / `ACCOUNT_MOVE_BLOCKED_WALLETS`), and its Google can then never be added to the boarded account.

Not established here (needs the logs listed in §7): which of the two `/board` actions the owner pressed, and whether B's Privy user holds anything
at Privy (an embedded wallet or MFA would make B impossible to close; FloFi refuses rather than strand it).

## 3. P0 fixes (all users, no exception for anyone)

### 3.1 The login page never starts a sign-in over a live Privy session (`src/components/account/sign-in.tsx`)
- The methods are disabled ("Getting sign-in ready…") until Privy has loaded **and** any session left in the browser has **finished** ending;
  `begin()` also ends one that appeared since. If Privy does not load in 15 s, the page says the provider could not be reached.
- A Google return that Privy reports as "already authenticated", or that Privy has not finished within 20 s, is ended **with a reason**: the
  return is removed from the address (a reload never retries it), the Privy session is ended, and the person reads "This browser still had another
  sign-in open, so this one didn't finish. It's closed now. Choose your method again." (`PRIVY_SIGN_IN_INTERRUPTED`, EN/PT).
- Privy's real refusals (`already logged in`, `already authenticated`, `no OAuth flow is in progress`) map to that code
  (`src/accounts/privy-context.tsx`), never to the generic failure; the page ends the session so the next attempt starts clean.

### 3.2 The other account goes to recovery, never to wallet onboarding (`src/flight/other-account.ts`)
In closed beta (`FLOFI_BETA_ACCESS=beta`), an account with **no beta grant of its own (even revoked)** whose strongly verified address (email code,
or Google on gmail.com/googlemail.com) is held by **another** account (`entryHolder`, the same rule as `/board`'s hint, now shared in
`src/flight/held-elsewhere.ts`) is sent to `/board` after sign-in instead of wallet onboarding or `/app` (one hop fewer), and the wallet
onboarding and import pages redirect it to `/board`. It decides a destination only: nothing is granted, linked, closed or deleted; any failure keeps
the previous destination. Open and closed deployments are unchanged.

### 3.3 Diagnostics (`src/app/account-action.ts`)
Each sign-in, move start and ended session writes one log line with enums and FloFi codes only (no account id, address, token or provider text):
`account.sign_in` {mode, result, created, destination}, `account.move_start` {result}, `account.session_ended` {reason: sign_out,
sign_out_everywhere, move_started, superseded, reauth_other_account, move_handoff}. The existing `account.privy_sign_in_failed` stays.

## 4. Login screen (simplified)
Removed: the paragraph listing what FloFi stores (Privacy stays one click away) and "Methods shown as unavailable…" (the banner already says it).
Shorter: the step-up banner ("Sign in again with the same method."), the move banner ("Use the method you boarded with, not Google."), the
existing-account question ("That account signs in with Web3 wallet."; its three choices are unchanged). EN and PT.

## 5. Sign-in methods (account settings, simplified)
The methods list; **Add Google** and **Add email** only when the account does not have that kind yet (Privy holds one of each); the email field
appears only after "Add email"; "Confirm it's you" appears only when adding and only if the sign-in is not recent (the 10-minute rule is
unchanged). The duplicate-account option sits behind "Is this a second FloFi account?". The focused move/link step of PR #211 is unchanged.

## 6. Protections validated (unchanged)
- Closing a duplicate still needs a recent sign-in to it, a sign-in to the keeper, the explicit confirmation, the server-side emptiness check at
  FloFi **and** at Privy (no wallet of any kind, no MFA, only Google/Apple/email) re-checked under a row lock, and the audit records.
- Dependencies of an account, re-inventoried over every migration: every table with a foreign key to `flofi_accounts` is in
  `RETIREMENT_CHECKS` (an existing PostgreSQL test fails otherwise); the account references without a foreign key are the Editor requester
  (`workflow_runs`, `mcp_handoffs`: HISTORY) and the MCP account link (`flight_beta_mcp_accounts`: MCP); everything else (automations,
  delegations, saved workflows, learning, admin principals) is keyed by a wallet address, which an account FloFi may close cannot hold.
- Nothing here merges, moves or deletes an account by itself, and nothing writes to the database outside the existing reviewed paths.

## 7. Proven here vs. depends on the owner's real test

**Proven here**
- CODE: Privy's real refusal texts map to `PRIVY_SIGN_IN_INTERRUPTED`; the other-account rule (closed beta only, no grant, strong address held
  elsewhere) and its destinations; the login page's first paint keeps methods disabled until ready; no technical copy.
- BROWSER (MOCKED Privy, made to refuse a login over a live session as the real SDK does): the recovery flow in EN and PT reaches the boarded
  account without any login started over a live session; the other account lands on `/board` and cannot open wallet onboarding; the boarded
  account's claim, grant, wallets and pass rows are unchanged.
- SDK: the behaviours in §2 are read from the shipped `@privy-io/react-auth` 3.51.0 code.

**Depends on the owner's real account (OWNER, after deploy)**
1. On flofi.xyz sign in with **Google**. Expected: `/board` "You boarded with another sign-in." (not wallet onboarding).
2. **Continue to my account** → the sign-in page says "Sign in to the account that keeps everything"; wait until the methods are enabled, then
   **Web3 Wallet** with the boarded wallet. Expected: Sign-in methods with "Close the duplicate account?".
3. Confirm and close. Expected: "The duplicate account is closed." and **Link Google** → Google → back on Sign-in methods with "Linked".
   If FloFi refuses to close it instead, the message names why (for example a wallet or a second factor at the provider): nothing is lost and the
   wallet sign-in keeps working; tell us the message.
4. Sign out, sign in with **Google**. Expected: the boarded account (pass #001, Founding Seat #001) straight into the product.

Real Google OAuth redirects, Privy's freeze/delete of B's Privy user, and the link of Google to A's Privy user are only proven by these steps.
To pinpoint any step that still fails: the Vercel function logs for the attempt (`account.sign_in`, `account.move_start`,
`account.session_ended`, `account.privy_sign_in_failed`), the browser console (Privy's warnings), and, read-only, B's sessions and identities
with their times.

## 8. Limitations
- A Privy SDK that never becomes ready keeps the methods disabled (with the "could not be reached" message) rather than letting a click fail.
- The other-account rule needs a strongly verified address; another Google/Apple domain keeps the previous destinations (as `/board`'s hint).
- Delivering a link for a closed method still needs a recent sign-in to the keeper (10 minutes), as before.
