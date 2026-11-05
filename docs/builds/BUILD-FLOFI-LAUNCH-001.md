# BUILD-FLOFI-LAUNCH-001 — the approved launch landing, English by default

Team decision for the public launch proposed for **17 Nov 2026**: the Claude Artifact "FloFi — opção hero digitando"
(https://claude.ai/artifact/HU6GgvFM1zi7uztf3ac2FM, version `1793885744-1380`) is the official reference of FloFi's landing, with English as
the default language. Owner decisions taken while implementing it (2026-11-05):

1. **English by default across the entry journey.** A visitor with no saved language gets English on the site, sign-in, onboarding and /app
   (`DEFAULT_LANGUAGE = 'EN'`, `src/i18n/language.ts`), so the landing → sign-in → app journey never switches language. This supersedes the
   Portuguese default of BUILD-FLOFI-SITE-001 (2026-11-04). A saved preference (`flofi_language` cookie or `flofi.language` storage) always
   wins; the default is never written as anyone's preference; Portuguese stays one choice away (site Preferences, /app Settings). The MCP
   signing surface, FloFi Wallet and the admin console keep English whatever the default is.
2. **Landing only; the "Flight FloFi" `/board` campaign is not built** (see below).
3. **The Claude Doc of the launch material was not readable** from the implementation session and is not reflected here (see below).

## The three approved materials

| Material | What it is | Treatment |
| --- | --- | --- |
| Artifact 1 — "Flight FloFi" (Design canvas, `9swYNgCuDz4pmW93fbBWMD`, version `1793892357-f7d9`) | Campaign kit for a closed-beta waitlist at `flofi.xyz/board`: style sheet, boarding-pass card (2/4 steps, developer map), mascot pose options "for the team to choose", "Not on the list" and standby cards, a 5-state landing (Final call · Now boarding · Batch still closed · Not on the list · Founding closed), OG image, a handoff for the owner, and 5 X posts (9–16 Nov). | Reference for the team; **not implemented** (owner decision 2). |
| Artifact 2 — Claude Doc (`X4c4KMJgUgcbE13LbUBzGK`) | Not shared with the implementation session: the Docs service answered "access denied" and the published page holds only the editor shell. | **Not read**; nothing implemented from it. |
| Artifact 3 — "FloFi — opção hero digitando" (Design canvas, `HU6GgvFM1zi7uztf3ac2FM`) | The landing (Home) and its FAQ, PT and EN boards. | **Implemented** at `/` and `/faq`. |

## What the landing implements (Artifact 3)

Boards → routes: `Main` · `EN-Main` → `/`; `PerguntasFrequentes` · `EN-FAQ` → `/faq` (one route per page, both languages, by the shared
preference). Copy is the boards' own, word for word, in `components/site/site-copy.ts` (`home`, `faq`, the footer line); the artwork is the
existing `public/brand/site/` SVGs — the five images the boards use are byte-identical to `flofi-mark`, `flofi-wordmark`, `mascot-wave` and
`mascot-check` (SHA-256 compared), so no asset was added.

- Sections, in the boards' order and ids: `top` (typing hero), `dor` (DeFi is still hard work), `como-funciona` (one sentence becomes a plan),
  `hoje` (what you can ask for today, 5 networks, channels), `seguranca` (the decision is always yours), `perguntas` (4-question preview),
  `entrar` (what do you want to do first?). Header and footer are the shared site shell; the footer gains the boards' line and the FAQ link
  on every site page.
- Typing hero (`components/site/typing-text.tsx`): the boards' five verbs and five sentences in the boards' 19.67 s loop; the moving text is
  decorative (`aria-hidden`), the heading and the "Try it" boxes are named by the full sentence; without JavaScript or with reduced motion the
  first phrase stands still, as the boards' `prefers-reduced-motion` rule does.
- Real destinations: "Open" and both "Try it" boxes → `/login` (sign in or create an account with Google, email or a Web3 wallet, or explore
  the builder without an account — the existing reviewed entry, unchanged; wallet connection then happens in the product as before); the five requests and "Sign in your wallet" → the closing
  "Try it" (`#entrar`), as the boards link them; "API and SDK" → `/developers`; "See all" and the footer "FAQ" → `/faq`; "Open Discord" and
  the socials → the boards' URLs. The plan card and wallet prompt are illustrations only: nothing on the site signs, simulates or moves funds.
- Responsive from 320 px: the boards' own breakpoint scales the illustration at ≤700 px; at ≤600 px the hero keeps three lines of height (no
  jump while typing), the mascot beside the wallet prompt moves under it, and the "Try it" box tightens — the raw board overflowed sideways at
  390 px, the implementation does not.
- Statuses stay the approved conservative ones (Beta · In testing · Coming soon); no metric, counter or capability was added.

## Not built: the Flight FloFi `/board` campaign (Artifact 1)

It conflicts with the approved landing and with the brief: the landing says "Public beta on mainnet" and opens the product directly, while
`/board` is a **closed beta** whose "Board now" checks a list, an access batch and an invite before entry — an access gate the product does
not have. Building it needs new product decisions and systems that do not exist today: a beta-list store with email capture and LGPD notice,
invites with attribution, batches with opening dates, numbered Founding seats (#001–#100) and their perks (Discord help, a "Founding Members
wall", 3 invites), boarding-pass image generation, a live departures feed with X handles, server-rendered OG counters and the funnel events
listed in the handoff. Several boards are themselves still open ("for the team to choose", "+N steps — not yet tested").

**Launch dependency:** the five X posts (9, 10, 13 and 16 Nov) all link `flofi.xyz/board`, which does not exist. Until the team decides,
those links would 404; either point the posts at `flofi.xyz` (the approved landing) or decide and build `/board` first.

## Verification

`e2e/site.spec.ts` (20 tests: the landing at 320–1920 px, reduced motion, the FAQ in both languages at 320–1440 px, the language rules on the
site, sign-in and /app, the document language from the first byte, How it works, For developers, the Docs and the artwork bytes);
`beta-ui.spec.ts` and `brand-ux-001.spec.ts` new-visitor journeys (landing → sign-in → /app); `typing-text.test.ts` (the typing timeline in
both languages); `locale.test.tsx` (the default rule and the always-English surfaces). Local and loopback evidence only: CircleCI remains the
certification authority and the Vercel preview is the deployment evidence.
