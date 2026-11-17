# Authentication UX & Login Regression Fix — item 6: simpler access recovery on Flight FloFi

**Scope:** the owner's request of November 17, 2026, item 6 ("Simplificar a recuperação de acesso ao Flight FloFi"), incorporated into the
Authentication UX & Login Regression Fix build. Branch `claude/eloquent-meitner-znoy3t`, from `main` at `d153f22`. Items 1–5 of that build are
not on this branch; this record covers item 6 only.

**No server, server-action, store, provider, migration, schema, dependency, environment or email-template change.** The change is presentation
and client flow over the reviewed identity-recovery mechanisms of BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (B1–B6), which stay the only authority.

## What the person sees

`/board`, signed in with a method other than the one they boarded with ("You boarded with another sign-in."):

- The split-flap board panel (ON BOARD · OTHER LOGIN · SIGN IN), the heading, the dark hero and the mascot are unchanged.
- One main action, **Continue to my account** (PT **Continuar para minha conta**), replacing "Bring this sign-in to my boarded account" and
  "Sign in with another method".
- One secondary action, **Need help signing in?** (PT **Precisa de ajuda para entrar?**), closed by default. Opened, it offers the sign-in with
  the boarded method and, during boarding, an email-only form that emails the boarded sign-in method (B5). No 6-digit code field.
- No email field, code field or beta explanation by default.

## What "Continue to my account" does (`src/flight/account-continue.ts`)

It calls the existing `startAccountMove()` and acts on its answer. The server decides every check.

| Server answer | Next step (only when needed) |
|---|---|
| Move started (empty duplicate, recent sign-in) | `/login?move=1`: sign in to the boarded account (proof of the keeper). Then Sign-in methods shows **only** the confirmation, then **only** the link of the closed method (Google → Link Google; email → the email-code link), then **Continue to my account** → `/app`. |
| `ACCOUNT_REAUTHENTICATION_REQUIRED` | Confirm it's you once (`/login?reauth=1`, same account only), back to `/board?continue=1`, which continues once. A second refusal on return never redirects again (no loop). |
| The account holds anything of its own, or cannot be closed (wallet, wallet sign-in, MFA, unsupported method, held elsewhere, …) | It stays a separate account; nothing is closed, merged or moved. The one action becomes **Sign in with the method I boarded with** → `/login?returnTo=/board?board=1`, which opens the boarded account straight into Board now's check. |
| Anything else (provider outage, expired step) | "Nothing changed. Try again." |

Only the exact `/login?move=1` destination is followed from the server's answer.

## What is preserved

Ownership proofs are unchanged: a recent sign-in to the duplicate, a sign-in to the keeper, the explicit irreversible-closure confirmation, the
FloFi-bound Privy link window, `heldElsewhere`/`unconfirmed` refusals, and the empty-duplicate rule. Nothing is moved to the kept account; its
grant, pass, claim and wallets are untouched (asserted in the browser test). The recovery email's public answer stays byte-identical; the help
text says only what may have happened.

## Evidence

- **CODE:** `account-continue.test.ts` (every server answer, return paths accepted by `safeReturnPath`, no second redirect);
  `board-page.test.tsx` (EN and PT: one main button, help closed, no email/code/beta text, board panel and mascot present).
- **BROWSER** (production build, headless Chromium, MOCKED Privy emulator, loopback PostgreSQL), `e2e/board.spec.ts` "closed beta protects a
  boarded person signed in another way…", in **EN and PT**: board with a Web3 wallet → Google in a separate empty account → `/board` shows one
  action (320/360 px fit) → help on request → Continue → keeper sign-in → confirmation only → link only Google → `/app` with the same grant and
  beta wallets → Google then opens that same account and `/board` no longer shows the recovery state. The existing identity-recovery test
  ("closed beta protects one account across sign-in methods…") still passes.
- **OWNER:** real Google/Privy OAuth returns and the owner's own accounts are not exercised here (as in BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 §F/G).

## Limitations

- A link that completes on the provider's page reloads Sign-in methods; the focused step is then not remembered, so the full page shows with the
  "Linked" notice and a **Continue to my account** link.
- If the keeper's sign-in is older than the link window when the duplicate closes, the person confirms it's you, then links from the full page.
