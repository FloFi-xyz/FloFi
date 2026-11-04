# BUILD-FLOFI-SITE-001 — the owner-approved site replaces the landing and the Docs

Owner decision (2026-11-04): replace the current landing with the approved site from the Claude Artifact "FloFi — site aprovado", version
`1793715580-4561` (https://claude.ai/artifact/J3bchkuJGMxPGDNVAycYUR) — a real implementation, not a visual reference: Início, Como funciona,
Desenvolvedores, Docs and the documentation pages that match the existing boards, PT and EN, responsive, with working navigation, integrated with
FloFi's real routes. No fake capability, invented metric or mock content; login, the application, channels, documentation and existing routes are
preserved. In Portuguese, bridging is presented as "Levar para outra rede"; technical identifiers (Bridge) are unchanged inside the product.
Separate branch and PR from the updated `main`; no change to the Canvas (that is PR #157). No deploy, no merge.

## Source and page correspondence

The shared link's anchor (`#page-dcb81aee8d83`) names no page: the project index (`project/canvas.json`) declares `"pages": []`. The
correspondence therefore comes from the index itself — its 34 `boards` (17 Portuguese, 17 `EN-*`), their titles and their `order`:

| Boards (PT · EN) | Index title | Route |
| --- | --- | --- |
| `Main` · `EN-Main` | Início · EN · Home | `/` |
| `ComoFunciona` · `EN-ComoFunciona` | Como funciona · EN · How it works | `/how-it-works` |
| `Desenvolvedores` · `EN-Desenvolvedores` | Para desenvolvedores · EN · For developers | `/developers` |
| `Docs` · `EN-Docs` | Docs · EN · Docs | `/docs` |
| `Docs-<slug>` · `EN-Docs-<slug>` (13 each) | Docs · … · EN · Docs · … | `/docs/<slug>` (the existing 13 slugs, unchanged) |

Every board is a fluid page (`expand: "fill"`, 1440 px frame). One route serves both languages: the visitor's language is the product's own
shared preference (the `flofi_language` cookie and `flofi.language` storage that sign-in and /app read), Portuguese when none is set — as the
previous landing — and the header's "⋯" Preferences switches it.

Content: the four marketing pages' copy is in `components/site/site-copy.ts`; the 26 documentation boards were converted (stdlib HTML parse,
data only) into `components/site/docs-content.ts` — titles, groups, statuses, leads, sections, notes (info/warning), code blocks, tables,
numbered steps, the MCP surface cards, sources and the reading order — with the boards' links mapped to the real routes; anything unexpected
failed the conversion. Artwork: the artifact's nine SVG assets, byte for byte, in `public/brand/site/` (`source.md` records their ids and
SHA-256; `site.spec.ts` verifies the served bytes).

## Real integrations

- "Entrar" / "Open" (header, hero, closing section, How it works) → `/login`, from which the builder stays reachable without an account.
- Examples → the closing "Entrar" section (`#entrar`), as the board links them; "Ver exemplos" → `#exemplos`; "API e SDK" → `/developers`;
  "Ler a documentação" → `/docs`; "Falar com o time" → FloFi on X; footer socials → X, Discord, LinkedIn, Telegram (the board's URLs).
- Docs: the sidebar search filters the guides by title, group and section titles (accent-insensitive); the breadcrumb, previous/next and every
  in-guide link resolve (`site.spec.ts` requests each one); an unknown slug is a 404.
- The capability matrix of the MCP guide is checked surface for surface against `SURFACE_CAPABILITIES` (`channel-capabilities.test.ts`).

## Deliberate differences from the boards (real reasons)

Where a board states something the product does not do, the product wins; everything else is the approved copy.

- **Developer API path.** The board's terminal shows `POST …/strategies/:id/preview`; the Developer API v1 serves
  `/strategies/{id}/simulate` (`docs/developer/openapi.json`), so the real path is shown, and the strategy reaches the user only through
  `POST /approvals`, so that line is added. `site.spec.ts` checks every path shown exists.
- **What today's keys do.** Only sandbox keys are issued, and on a hosted deployment (mainnet only, no test networks) a sandbox key can only
  discover capabilities (`developer/openapi.ts`, `developer/service.ts`). "Começa em teste" / "Starts in test mode" and the Developer API guide's
  availability note now say so; "usam o FloFi" / "use FloFi" became "podem usar" / "can use" (no partner is claimed); webhooks are described as
  approval changes plus, when the user shares it, run progress.
- **SDK examples use mainnet ids** (`base`, `arbitrum-one`, the OpenAPI enum) instead of `base-sepolia`/`arbitrum-sepolia`, which the public
  product refuses.
- **MCP surface cards** gain an "Availability" row from `SURFACE_CAPABILITIES.activation`, so WhatsApp reads "Not live" (pinned by
  `channel-capabilities.test.ts` in both languages).
- **Links**: "the app" / "Launch FloFi" go to `/app` (the boards pointed at the home page), the OpenAPI link is the deployment's own
  `/docs/api-reference.json` (not production), and the section anchors of the previous Docs (`#invalidation`, `#endpoints`, `#evidence-levels`,
  `#recovery`, `#strategy-to-handoff`, `#signing-window`) are restored; the spec checks every anchor names a section.
- **Portuguese vocabulary**: "Pontes entre as 5 redes" became "Leve ativos de uma rede para outra entre as 5 redes", and one Docs sentence says
  "levar ativos a outra rede" instead of "bridge" (the `bridge` action id stays in code).
- **Accessibility**: the example cards are named by their own prompt (they only lead to the start section and carry nothing into sign-in); a white
  focus ring on the ink and blue panels and inside code blocks; "skip to content" lands on the Docs article past the sidebar; the header's Docs link
  is `aria-current="true"` on a guide (the sidebar marks the page); the sticky sidebar scrolls on short windows; choosing a language returns focus
  to Preferences, and confirming the language already shown saves it (so a visitor who keeps Portuguese gets it in sign-in and /app too); a
  preference kept only in storage is followed on arrival; the PT breadcrumb label is translated.
- **Preferences** offers the language only (the approved site has no other preference to set).
- **Responsive overflow guards**: grids use `min(…, 100%)` and the Docs sidebar stacks above the article below 900 px, so nothing scrolls sideways
  at 320 px; otherwise phones keep the boards' own proportions.
- `<h1>` and the Docs hero keep a space before their line break so assistive technology reads "DeFi do jeito que você fala."

Known, unchanged: without a saved preference the site is Portuguese (as the previous landing) while sign-in and /app keep their English default;
whether they should default to Portuguese too is an owner decision. The root document's server-rendered `lang` stays "en" until hydration (the
site's own wrapper carries `lang="pt-BR"`), because the root layout serves every route.

## Removed (no longer routed)

Landing 07 (`components/marketing/*`, `app/landing07-fonts.css`, `public/landing07/`, `public/fonts/landing07/` with the Anton font and its
OFL notice) and the previous Docs components (`components/docs/*`), with the specs that described only those pages (`landing07`, the six already
retired landing specs, `native-docs`, `docs-mascot`) and the unit tests of the removed modules (`landing.test.tsx`, `landing07-fonts.test.ts`).
`brand-ux-001`, `beta-ui` and `channel-capabilities` keep their intent against the new site. The coverage map drops the removed sources and
suites and maps the new ones (`app.e2e.site`); `scripts/test_ci_optimization.py` names `site.spec.ts` in `default-product`. The former footer's
official community marks stay registered; `THIRD_PARTY_NOTICES.md` now describes the site footer's glyphs.

## Tests

`e2e/site.spec.ts` (replaces `landing07.spec.ts` in the `default-product` profile; also the docs and motion configs' match): closed network
(any request outside the app's origin fails), Portuguese by default, sections and real entries, keyboard skip link, no horizontal overflow
(measured with the site's clip lifted) at 320/390/768/1024/1440/1920 px on Home and at 320/390 px on How it works, For developers and the Docs,
the shared language preference to English and back (also into sign-in, with focus returned), confirming Portuguese into sign-in, How it works and
For developers on phone and desktop, every guide in both languages with its sidebar state and reading order, the Docs skip link, the sidebar
search, every internal docs link and anchor, the 404, and the artwork bytes.

Evidence (Artifact rendered locally from its own board markup, left; implementation, right):
`apps/reference-dapp/e2e/visual-evidence/build-flofi-site-001/`.
