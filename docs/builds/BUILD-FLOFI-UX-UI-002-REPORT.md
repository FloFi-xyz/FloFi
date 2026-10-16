# BUILD-FLOFI-UX-UI-002 — report

Date: 2026-10-16. Base: `origin/main` `14255c3584b29aff5bc29b7d7365efc1a5909e0f` (worktree `~/projects/flofi-ux-ui-002`, clean at preflight).
Plan: [BUILD-FLOFI-UX-UI-002-PLAN.md](BUILD-FLOFI-UX-UI-002-PLAN.md). Nothing was merged or deployed; no environment variable, secret or production setting was changed.

| PR | Branch | Scope | Depends on |
| --- | --- | --- | --- |
| PR 1 (this report) | `claude/build-flofi-ux-ui-002` | UX/UI-001…007, plan, this report | `main` only |
| [#107](https://github.com/alrimarleskovar/FloFi/pull/107) | `claude/build-flofi-ux-ui-002-omnichannel` | UX/UI-008 | `main` only |

The two PRs touch disjoint files and can merge in either order. PR #107's screenshots (`approve-*.png`) live in its tree under the same evidence folder.

## Requirement checklist

| Req | Before (main 14255c3) | After | Status |
| --- | --- | --- | --- |
| UX/UI-001 Admin brand | Sidebar and sign-in rendered `/flofi-logo.png`, byte-identical to `/gryloo-logo.png` (the legacy Gryloo artwork), squeezed to 28×28. | `AdminBrand`: approved symbol + wordmark from `public/brand`, unmodified, switched by the console's own `prefers-color-scheme` query, at intrinsic aspect ratios. Guards, roles, navigation unchanged. Evidence: [light](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/admin-nav-light.png), [dark](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/admin-nav-dark.png). | Done |
| UX/UI-002/004 Social links | None on the landing. | X, Discord, LinkedIn, Telegram beside the hero CTAs (wrapping under them below 600 px) and in the footer. Owner URLs, EN/PT accessible names, 44 px targets, new tab with `noopener noreferrer`, distinct round marks, icons only (the visible "Community" label was removed in the [second owner revision](#second-owner-revision-of-pr-108); the list keeps the localized accessible name *FloFi community* / *Comunidade FloFi*). Marks are byte-identical official downloads (SHA-256 in `public/brand/social/sources.md`; X and LinkedIn kits from the owners' brand pages, Discord's symbol; Telegram reuses the existing mark). Evidence: hero [EN 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-en-1440.png), [PT 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-pt-390.png); footer [1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-en-1440.png), [390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-pt-390.png). | Done |
| UX/UI-003 Mascot journey | Production `https://flofi.xyz/` (read-only check, 2026-10-16) had no `data-mascot-motion` and no dock: `NEXT_PUBLIC_FLOFI_MASCOT_MOTION` was never set at build time. Dock/scroll logic was intact. | The existing journey is the default; `=false` remains an off switch. Docks on the new sections; the demo asks the active dock for reactions. Intro once per tab, skip, travel, jump/look/celebrate, mobile per-dock character, reduced-motion still state, hidden-tab pause and CTA hit-testing unchanged and tested. | Done |
| UX/UI-005 MCP onboarding | None. | Simplified in the [second owner revision](#second-owner-revision-of-pr-108): `#assistants` is *Connect FloFi once. Then ask your AI assistant.* One card: on the left, the Claude / ChatGPT tabs (official marks), two short assistant-specific steps from the operator guide, the deployed `https://flofi.xyz/api/mcp` with **Copy URL**, and one plan/invite note; on the right, a short illustration (*Swap 0.5 ETH to USDC on Base.* → *Your workflow is ready to review.* → *Continue in FloFi: Review and authorize transactions with your wallet in FloFi.*). Full instructions stay in `/docs/mcp-integrations` (unchanged). Evidence: [Claude 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-1440.png), [ChatGPT 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-chatgpt-1440.png), [Claude 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-390.png), [ChatGPT 320](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-chatgpt-320.png). | Done (simplified) |
| UX/UI-006 Mascot/chat/workflow demo ("How it works") | None. | Revised after the owner's preview review ([below](#owner-revision-of-pr-108)): one guided story for the owner's example *Supply 1 ETH on Aave and borrow 500 USDC*. The request is typed and sent, the mascot reacts, FloFi answers while the Canvas builds Supply → Borrow, then Simulate and Execute unfold in the same Canvas, all on one deterministic timeline. Labelled illustration; no input, request, wallet, signature, storage or invented value (asserted in the browser). Evidence: [typing](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-typing-1440.png) … [final 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-final-1440.png), [final 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-final-390.png). | Done (revised) |
| UX/UI-007 Earth flicker | Each scroll event set `data-earth-active=false`; CSS hid the screen-blended surface passes, lighting and atmosphere until 180 ms idle. | Scroll still pauses the animation clocks, but no layer is hidden. Same artwork, geometry, 60 s drift, offscreen/hidden-tab pause and reduced-motion still image. Measured on 8×8 tiles of the planet (mascot/text hidden, [earth-luminance.json](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/earth-luminance.json)): main's rule re-injected → up to 50 % local change when scrolling starts and ~100 % when it stops (1440 px; 17 % / 21 % at 390 px); fixed → ≤0.5 % / ≤0.8 % (drift only). [Old held-scroll frame](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/earth-old-rule-reinjected-1440-scrolling.png) vs [new](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/earth-new-1440-scrolling.png). | Done |
| UX/UI-008 A Remain in the channel | Composition, read-only preview and status already existed per surface but were not stated per channel. | Code-bound capability matrix (`src/platform/channel-capabilities.ts`, tested against tool names, channel switches, the notice sharing rule, the disabled in-frame wallet and the WhatsApp clearance gate), published in `/docs/mcp-integrations`. Truthful limits: no chat surface holds a signer; WhatsApp is not live. | Done within existing authority (see bounded decision) |
| UX/UI-008 B Open FloFi | Large "EXTERNAL PROPOSAL · FROM …" panel above the app, wallet proof, **Load proposal**, **Continue to simulation**. | The normal Canvas opens with the proposal's cards already placed (server `previewApproval`, PENDING only, grants nothing) and a compact notice in the workspace. The wallet proof (one sign-in message, or an existing FloFi session) loads the exact proposal through the existing claim → restore → hash-checked apply path; Simulate/Execute stay closed until then. Refresh of an applied proposal: explicit **Restore proposal**. Evidence (PR 2): `approve-before-proof-{1440,390}.png`, `approve-loaded-{1440,390}.png`. | Done (MOCKED/loopback evidence only) |

## Owner revision of PR #108

The owner reviewed the Vercel Preview of `f9c3083` and asked for a final revision of the landing before approving the merge. Only the landing changed; PR #107, the hero, Supported Networks, the MCP section's content, the closing Earth section, Admin, brand assets, backend, database, MCP and every financial path are untouched.

| Owner feedback | Change |
| --- | --- |
| Supported Networks must be the second section | `main > section` order is now `workflow → networks → demo → assistants → developers → about` (hero, Supported Networks, How it works, MCP, developers, closing; footer after `main`). IDs unchanged; every order assertion updated. |
| Rename the section; lighter heading | Eyebrow **HOW IT WORKS** / **COMO FUNCIONA**; title **From a message to a workflow.** / **Da conversa ao workflow.**; one short sentence. |
| Too much like a dashboard; progressive disclosure; no selectors | The three scenario buttons, preview grid, six-box journey and repeated warnings are gone. One example, revealed step by step; one "Illustration" chip and one honesty line. |
| Dynamic chat: typing, sending, thinking, short replies | The request is typed character by character into a composer with a caret, sent as a bubble, then thinking dots (the mascot looks at it). Replies: *I'll build your Aave workflow.* → *Adding the supply step…* → *Connecting your borrow step…* → *Your workflow is ready to simulate.* → *Simulating the workflow…* → *Your wallet has the final say.* |
| Canvas that builds itself, faithful to the product | The product's language: Build · Simulate · Execute stage pills, dotted surface, cards with blue numbered titles and the product's action icons, the provider line (Aave · Ethereum), a value box with the asset mark, side handles and the labelled edge *After previous step*. It starts empty; each card is first placed as an outline, then materializes; the connector is drawn. |
| Reach Simulate and Execute in the same Canvas, truthfully | Below the same cards, one reserved area changes with the stage: the *Simulate workflow* button (pressed), then four simulation checks, then the four-step execution lifecycle. |
| One timeline, viewport start, no loop, reduced motion, no layout shift | See the timeline below. Every not-yet-revealed element keeps its space (visibility/opacity/transform only). |

PT uses the product's own labels (`src/i18n/pt.ts`): Criar / Simular / Executar, Depositar, Pedir emprestado, Simular fluxo, Após a etapa anterior. The PT request is *Deposite 1 ETH no Aave e peça 500 USDC emprestados*.

**Timeline.** `demo-timeline.ts` defines fixed cues (ms after the section becomes meaningfully visible), and `demoFrame(time)` derives every visible state of the chat and the Canvas from that one time, so the two cannot drift apart. The engine, `useTimeline` in `scripted-steps.ts`, arms a single timer at a time. It starts at ≥ 35 % visibility (or 45 % of a taller-than-screen viewport), holds while scrolled away, while the tab is hidden or while the visitor pauses, and stops on its final frame. The MCP section's step sequence now runs on the same engine (`useScriptedSteps`: same steps and timing; it now also starts at the same visibility threshold and holds while offscreen). Server HTML, reduced motion and browsers without IntersectionObserver get the final frame, so there is no hydration mismatch.

| ms | Chat | Canvas |
| --- | --- | --- |
| 0 | empty, composer placeholder | Build, empty ("Your workflow appears here") |
| 600–2,700 | request typed (50 ms per character slot) | — |
| 2,900 / 3,300 | sent as a bubble (mascot *look*) / thinking dots | — |
| 4,700 | *I'll build your Aave workflow.* | — |
| 5,500 / 6,000 | *Adding the supply step…* | Supply outline / Supply card (1 ETH, Aave · Ethereum) |
| 7,000 / 7,500 / 7,900 | *Connecting your borrow step…* | Borrow outline / Borrow card (requested 500 USDC, *Borrowing limit checked in simulation*) / connector drawn |
| 9,000 / 10,000 | *Your workflow is ready to simulate.* (mascot *jump*) | *Simulate workflow* appears / is pressed |
| 10,400–13,800 | *Simulating the workflow…* | Simulate: checking the workflow (both cards), collateral and borrowing requirements (Borrow card), network costs, preparing the Strategy Manifest |
| 13,800–17,800 | *Your wallet has the final say.* (mascot *look* at wallet authorization) | Execute: strategy review → wallet authorization → execution (Supply, then Borrow highlighted) → status and reconciliation |
| 17,800 | final, held | every step shown as visited, none as a result; *Try it in FloFi →* |

**Truthful presentation.** No wallet connects, nothing is signed or sent, and there are no inputs, forms, requests, server actions or storage writes. The only numbers are the visitor's 1 and 500 and the stage/step ordinals; no balance, rate, fee, limit, gas, hash, confirmation or outcome appears (unit and browser assertions). Check and step markers mean "visited", never "passed", and the final state marks no step complete. The Borrow card says the limit is checked in simulation. One line under the Canvas reads: *No wallet is connected and nothing is sent. In FloFi, execution starts only after your wallet authorizes it.*

**Accessibility and motion decisions for owner review.**
- One small **Pause / Play / Replay** control sits in the chat header (44 px; icon-only below 600 px). WCAG 2.2.2 requires a way to pause content that moves automatically for more than five seconds beside other content. It is the only control added and is hidden when nothing moves.
- The moving picture is `aria-hidden`. Assistive technology reads one equivalent summary (`demoSummary`) instead of a live stream of changes. Only the control and the closing link are focusable, in that order.
- Reduced motion shows the complete static story at once, with Simulate and Execute both in view; no animation runs.
- The closing link appears with no visibility transition, so a keyboard user tabbing as it appears does not skip it (found by the new test).

Evidence (real Chromium, captured by `FLOFI_UX_EVIDENCE=1` from `e2e/ux-ui-002-landing.spec.ts` at exact timeline states; inspected visually):

| State | 1440 px | 390 px |
| --- | --- | --- |
| 1 User typing | [typing](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-typing-1440.png) | [typing](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-typing-390.png) |
| 2 FloFi thinking | [thinking](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-thinking-1440.png) | [thinking](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-thinking-390.png) |
| 3 Supply card created | [supply](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-supply-created-1440.png) | [supply](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-supply-created-390.png) |
| 4 Borrow card connected | [borrow](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-borrow-connected-1440.png) | [borrow](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-borrow-connected-390.png) |
| 5 Simulate | [simulate](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-simulate-1440.png) | [simulate](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-simulate-390.png) |
| 6 Execute | [execute](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-execute-1440.png) | [execute](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-execute-390.png) |
| 7/8 Final (EN, PT) | [EN](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-final-1440.png), [PT](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-final-pt-1440.png) | [EN](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-final-390.png), [PT](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/howitworks-final-pt-390.png) |

The superseded `demo-swap-*` and `demo-bridge-*` screenshots were removed.

## Second owner revision of PR #108

The owner reviewed the Preview of `adfca44`, approved How it works in principle, and asked for one targeted simplification before merging. Only `#assistants` and the visible social label changed. How it works, Supported Networks (second), the mascot journey, the Admin logo, the Earth correction, brand assets, social destinations, navigation, PR #107, MCP backend/OAuth/tools, wallet, execution, PostgreSQL and Railway are untouched.

| Owner request | Change |
| --- | --- |
| Remove "What happens where" and the "Read the MCP guide" CTA | Both blocks, their CSS (`.assistantWhere*`, `.assistantActions`) and copy (`assistantsWhere*`, `assistantsInChat`, `assistantsInFloFi`, `assistantsGuide`) are gone, with nothing in their place. `/docs/mcp-integrations` is unchanged; the browser test opens it directly. |
| Simplify around "Connect FloFi once. Then ask your AI assistant." | Title in two lines (the second in brand blue), no intro paragraph. One card replaces two cards, a separate tab row, the summary panel, the CTA and the closing note. Height at 1440 px: 1,425 → 681 px (Claude) / 703 px (ChatGPT); at 390 px: 2,171 (ChatGPT) → 1,041 px. |
| Left: Connect FloFi | The tabs (keyboard: arrows, Home, End) choose the assistant; two steps follow the operator guide (`docs/deploy/MCP.md` §2), shortened. Claude: *Open Settings → Connectors → Add custom connector.* / *Paste the URL and authorize the connection.* ChatGPT: *Turn on Developer mode in Settings → Apps & Connectors → Advanced, then choose Create.* / *Paste the URL, choose OAuth and authorize the connection.* The real endpoint and the working **Copy URL** stay. One note keeps the limits: *Custom connectors depend on your plan. FloFi may ask for an invite code when you authorize.* No step that the guide requires was dropped; "start a chat" is the right column. |
| Right: Use FloFi, lightweight and animated | Four steps on the existing timeline engine (`useScriptedSteps`, 900 ms each, 3.6 s in total, so no pause control is needed under WCAG 2.2.2): the request bubble, FloFi's working dots, *Your workflow is ready to review.*, then a small navy handoff, *Continue in FloFi*, with the single safety sentence. It starts when seen, holds offscreen, never loops, replays for the selected assistant, and reduced motion shows the final state. |
| No raw tool names, no repeated lifecycle or safety copy | `compose_strategy`, `simulate_strategy`, `request_user_approval` and the four tool cards are gone (`ILLUSTRATED_TOOLS` removed). The safety sentence appears once: *Review and authorize transactions with your wallet in FloFi.* / *Revise e autorize as transações com a sua carteira no FloFi.* The old closing note and the "no one-click install" sentence were removed; nothing on the page claims an install, in-chat signing, automatic execution or a result. |
| Mascot proportional | The standalone 128 px dock between heading and tabs became a compact dock in the heading (beside the title on desktop, beside the eyebrow on mobile). Same controller and the same `assistants` reaction (jump, pulse of the tabs). |
| Remove visible "COMMUNITY" / "COMUNIDADE" | The label `<p>` and its CSS are gone in the hero and the footer, leaving no gap. The `<ul>` keeps the accessible name *FloFi community* / *Comunidade FloFi*; each link keeps its label, 44 px target, hover, `target="_blank"` and `noopener noreferrer`. The row is pulled out by the 4 px target inset, so the marks line up with the CTA edge when they wrap below on mobile. Icons, order, size and artwork are unchanged. |

**Accessibility.** The tabs are WAI-ARIA tabs (roving `tabindex`, the panel named by its tab). Tab moves from the selected tab to **Copy URL**, and Enter copies. The illustration is a named group, `Illustrative conversation · Claude` (or ChatGPT); its text stays readable, and only the dots are `aria-hidden`. The section has no links; its only controls are the two tabs and the copy button, all 44 px or larger and hit-testable at every width.

Evidence (real Chromium, `FLOFI_UX_EVIDENCE=1`, final state; inspected visually):

| View | Files |
| --- | --- |
| 1 MCP section, Claude selected | [EN 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-1440.png), [PT 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-pt-1440.png) |
| 2 MCP section, ChatGPT selected | [EN 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-chatgpt-1440.png), [EN 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-chatgpt-390.png) |
| 3 Mobile MCP section | [Claude 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-390.png), [Claude PT 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-pt-390.png), [ChatGPT 320](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-chatgpt-320.png) |
| 4 Hero social icons, no label | [EN 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-en-1440.png), [PT 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-pt-1440.png), [EN 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-en-390.png), [PT 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-pt-390.png) |
| 5 Footer social icons, no label | [EN 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-en-1440.png), [PT 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-pt-1440.png), [EN 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-en-390.png), [PT 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-pt-390.png) |

## UX/UI-008 security notes

- Unchanged server invariants: secret only in the fragment (moved to tab storage, removed from the address bar; `/approve` is `no-referrer`, `no-store`, `noindex`, framing denied), tenant and requester scope, single immutable claimant, the requester's claim rule (channel intended wallet, automation owner, developer project state), STALE re-composition, lazy expiry, revocation/supersession, hash-checked apply, consumed MCP session links, recovery only for the proven claimant, sharing opt-in (channels default off; the chat's "loaded" notice requires it).
- New exposure: before proof, the link holder receives the open proposal's canonical workflow (what the view's summary already described). Accepted by the existing threat model ("possession of a stolen link can expose its proposal"); it cannot claim, apply, simulate within `/approve`, or spend.
- Auto-load replaces the former explicit Load click with the wallet proof as the owner action (owner instruction). It runs once per wallet and link; a refused claim is shown in plain words and never retried silently.
- A refresh never silently restores an applied proposal: `restoreWorkflow` retires flow state, which could hide an in-flight run's recovery and invite a duplicate execution.
- If the product ends a stale sign-in session (router store: connected account changed), the notice re-reads the session and asks to connect again (found by the WhatsApp spec).
- Leaving `/approve` before proof keeps the previewed cards in the owner's own Canvas, like any manually authored workflow; it is not claimed, so nothing is shared with the requester.

## Bounded decision for the owner (not implemented)

Execution without opening FloFi needs a signer inside the chat or a standing delegation for chat requests. Telegram and WhatsApp offer no wallet; ChatGPT/Claude iframes may inject one, but MCP in-frame signing is disabled pending host security review; the only delegated authority (BUILD-AUTOMATION-002 "automatic within limits") is scoped to owner automation rules, has MOCKED evidence and is blocked for production signing (no custody). Options, each a new authorization model needing a security review: (1) extend passkey-bounded delegation to chat requests within per-action limits; (2) enable an in-frame wallet for MCP hosts after a host-security review; (3) WalletConnect pairing from the chat. Until then, the highest truthful capability is: compose, preview and follow status in the chat; one tap to FloFi with the workflow already on the Canvas; one wallet sign-in; then FloFi's own simulate → review → sign.

## Validation

All runs local, on this machine (WSL, Node 24.21.0, pnpm 11.22.0, Chromium headless shell 1243, Anvil 1.8.3 SHA-verified by `scripts/bootstrap-anvil.py`, PostgreSQL `postgres:18.6-bookworm@sha256:3725f4e2…` on loopback). No CI runner job overlapped. MOCKED/loopback evidence only.

**PR 1 (`claude/build-flofi-ux-ui-002`)**, second owner revision (results on that revision's working tree; earlier numbers are in git history)

| Command | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | PASS — 386 files / 4,401 tests passed, 2 skipped (existing owner-fixture tests) |
| `vitest run …/marketing/landing.test.tsx` | 7/7 (icon-only social list with its EN/PT accessible name; the MCP section: endpoint, two tabs, three buttons, no link, no tool name, the safety sentence exactly once, no install/in-chat signing/execution claim, removed copy keys absent, shortened paths still the operator guide's; the How it works timeline and static story) |
| Landing/motion suite, `playwright --config playwright.motion.config.ts` against `next start` of the branch build | 78/78 (brand-motion-001 ×13, brand-visual-refinement ×13, workflow-story ×8, landing-structure ×9, earth-footer ×7, ux-ui-002-landing ×28) |
| Main CI config (reduced-motion default, as the `default-product` profile runs it): `playwright test brand-ux-001.spec.ts ux-ui-002-landing.spec.ts` | 43/43 (15 + 28) |
| `ux-ui-002-landing` MCP and social coverage | one card at 320, 375, 390, 768, 1024, 1440 and 1920 px in EN and PT for both assistants (side by side from 1024 px, stacked below; nothing outside the card or clipped; the URL complete on one line; 44 px hit-testable tabs and copy button; mascot clear of the title; no horizontal overflow; height ≤ 760 / 1,050 / 1,250 px); real-time playback at 390/1440 (steps 0→4 once and in order, dots only while working, final state held, replay per assistant); keyboard arrows/Home/End, Tab to **Copy URL**, Enter copies `https://flofi.xyz/api/mcp`; PT; no link, tool name or repeated sentence; nothing sent or stored; `/docs/mcp-integrations` still renders. Social links at seven widths: no visible text, named list, safe links, 44 px targets, centred beside the CTAs or edge-aligned when wrapped. |
| `ux-ui-002-landing` How it works coverage | real-time playback at 390/1440 (each of the 21 cues once and in order, more than 25 distinct typed lengths ending at the full request, chat/Canvas synchronized in every recorded frame, at least the scripted 17.8 s and under 22.8 s, mascot jump after *ready*, final state held, nothing sent or stored); fake-clock control test (keyboard pause/play, holds when scrolled away or in a hidden tab, language switch without restart, replay, Tab order); all seven key states at 320, 375, 390, 768, 1024, 1440, 1920 px in EN and PT (no element outside its panel, nothing clipped, no horizontal overflow, reading order, 44 px hit-testable control and link); reduced motion (complete static story, no control, no animation, summary for assistive technology, nothing focusable inside the hidden picture) |
| Cross-browser smoke (not a committed test): Playwright Firefox 1543 and WebKit 2359 at 1440 and 390 px | How it works (first revision): section order correct; the 22 frames (idle plus the 21 cues) in order in about 19 s; no horizontal overflow; no console errors; final layout matches Chromium. MCP section (second revision, also 320 px): final step reached, side by side / stacked as in Chromium, URL on one line, mascot clear of the title, social list unlabelled and named, no overflow or console errors |
| `python3 scripts/governance_lite.py` + 19 self-tests; `python3 -m unittest discover -s scripts -p 'test_ci_*.py'` (41 CI-plan tests); `git diff --check` | PASS |
| `node scripts/guarded-release-browser.mjs profile admin-console` | not re-run for the revision (no Admin file changed); 1/1 on the first tranche |

No spec file was added to a CI profile, so the profile pins are unchanged. Second revision, fixed during iteration: on mobile, `display: contents` first applied to the mascot dock too, and the heading kept the desktop 32 px row gap; both were caught on screenshots before the tests were written. Iteration failures, all fixed: the new control test switched language through the header, which scrolls the page; the story correctly held offscreen (test updated to scroll back). The closing link was skipped by Tab for one frame after it appeared (product fix above).

**PR 2 ([#107](https://github.com/alrimarleskovar/FloFi/pull/107), `claude/build-flofi-ux-ui-002-omnichannel`)**

| Command | Result |
| --- | --- |
| `pnpm check` | PASS — 385 files / 4,396 tests passed, 2 skipped |
| `pnpm test:postgres` | PASS — 68 files / 443 tests passed, 3 skipped (forward-schema certificate suite, `runIf(CERTIFICATE)`, same on main) |
| Guarded profiles on `7999cad`: channel-approve, mcp-in-chat, channel-signing, developer-journey, mcp-routes-oauth-disabled, automations, and the CI critical tier (copilot-learning, canvas-corrections, solana-wallet-refusal, supply-provenance, review-execute-recovery-components) | 3, 21, 6, 1, 11, 2, 1, 5, 3, 5 and 39 passed; none failed or skipped |
| governance-lite + 19 self-tests; `git diff --check` | PASS |
| CircleCI (governance, certification-checks, browser shards 1–2, certification) | first run on `7999cad`: `automations` failed — the spec snapshotted the handoff row before polling for `APPLIED`, a race exposed because the workspace now appears before apply; fixed in `3e76c72` (3/3 local reruns); rerun on `3e76c72`: all jobs PASS |

Iteration failures, all fixed: a spec forced expiry by SQL, which the handoff immutability trigger rightly refuses (`MCP_HANDOFF_IMMUTABLE`) — expiry stays in the PostgreSQL test, the browser checks a replaced link; the WhatsApp owner tab inherited a sign-in session the router store then ended, and the notice kept the stale account — fixed in the product (re-read the session on `*_WALLET_PROOF_REQUIRED`); interruption specs matched the workspace's own workflow requests instead of the apply call (narrowed to requests carrying the link secret); the automation spec read the Canvas before the automatic reload restore (now waits for the notice's `loaded` state).

**CircleCI on PR 1:** first run failed governance (the CI-plan pin above); after the fix every job passed (governance, certification-checks, both browser shards, certification).

Not run: the other ~30 guarded product profiles (provenance, fork, composition, CoW, card, BUILD-009 with a live LI.FI quote). They do not exercise the changed code paths; CircleCI runs them on both PRs.

## Schema, migration and environment

No migration, schema export or new environment variable. Behaviour change on deploy: the mascot journey appears by default (`NEXT_PUBLIC_FLOFI_MASCOT_MOTION=false` restores the previous still landing). PR 2 adds one server action; the remote automation API is unchanged (automation links keep their after-proof load).

## Deployment requirements

None beyond the normal build. Vercel compiles the mascot default at build time. PR 2 needs no Railway change. Vercel Previews of these PRs run against the production database (existing configuration); a preview's `/approve` writes the same handoff rows as production.

## Remaining limitations and outstanding live tests

- All channel/MCP/wallet evidence is MOCKED or loopback: no live ChatGPT or Claude connector, Telegram bot, WhatsApp provider (still blocked by policy clearance), MetaMask/Phantom mobile app or public transaction was exercised. The owner runbook (`docs/deploy/UNIVERSAL-SIGNING-OWNER-E2E.md`) lists the live procedure.
- Browser suites are Chromium headless shell 1243. For How it works and the simplified MCP section only, there were smoke runs in Playwright Firefox and WebKit builds; real Safari, real phones and hardware-level frame timing were not measured.
- Claude/ChatGPT menu names follow the operator guide (2026-10-06) and can drift. The landing now shows only the short path, without the earlier "menu names can vary" sentence (the owner asked for minimal text); the full instructions stay in `/docs/mcp-integrations`. PT menu names are translations of that path, not checked against the apps' Portuguese UI.
- PT on the landing is Brazilian Portuguese; the product catalog keeps its existing European-Portuguese style.
