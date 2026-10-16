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
| UX/UI-002/004 Social links | None on the landing. | X, Discord, LinkedIn, Telegram beside the hero CTAs (wrapping under them below 600 px) and in the footer. Owner URLs, EN/PT accessible names, 44 px targets, new tab with `noopener noreferrer`, distinct round marks with a mono "Community" label. Marks are byte-identical official downloads (SHA-256 in `public/brand/social/sources.md`; X and LinkedIn kits from the owners' brand pages, Discord's symbol; Telegram reuses the existing mark). Evidence: hero [EN 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-en-1440.png), [PT 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/hero-social-pt-390.png); footer [1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-en-1440.png), [390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/footer-social-pt-390.png). | Done |
| UX/UI-003 Mascot journey | Production `https://flofi.xyz/` (read-only check, 2026-10-16) had no `data-mascot-motion` and no dock: `NEXT_PUBLIC_FLOFI_MASCOT_MOTION` was never set at build time. Dock/scroll logic was intact. | The existing journey is the default; `=false` remains an off switch. Docks on the new sections; the demo asks the active dock for reactions. Intro once per tab, skip, travel, jump/look/celebrate, mobile per-dock character, reduced-motion still state, hidden-tab pause and CTA hit-testing unchanged and tested. | Done |
| UX/UI-005 MCP onboarding | None. | `#assistants`: Claude / ChatGPT tabs with the documented custom-connector steps and the deployed `https://flofi.xyz/api/mcp` (its protected-resource metadata answers), consent/invite note, explicit "no one-click install", an illustrated `compose_strategy → simulate_strategy → request_user_approval → FloFi wallet → status` sequence, a "what happens where" summary and the `/docs/mcp-integrations` guide. Evidence: [Claude 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-claude-1440.png), [ChatGPT 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/assistants-chatgpt-390.png). | Done |
| UX/UI-006 Mascot/chat/workflow demo | None. | `#demo`: three fixed requests (swap, swap + bridge, supply + borrow) play chat → mascot reaction → workflow cards → preview without invented quotes, outputs, fees, APY, balances or hashes → execution journey ending at "you sign". Labelled illustration; no input, request or storage (asserted in the browser). Evidence: [swap 1440](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/demo-swap-1440.png), [swap + bridge 390](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/demo-bridge-390.png). | Done |
| UX/UI-007 Earth flicker | Each scroll event set `data-earth-active=false`; CSS hid the screen-blended surface passes, lighting and atmosphere until 180 ms idle. | Scroll still pauses the animation clocks, but no layer is hidden. Same artwork, geometry, 60 s drift, offscreen/hidden-tab pause and reduced-motion still image. Measured on 8×8 tiles of the planet (mascot/text hidden, [earth-luminance.json](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/earth-luminance.json)): main's rule re-injected → up to 50 % local change when scrolling starts and ~100 % when it stops (1440 px; 17 % / 21 % at 390 px); fixed → ≤0.5 % / ≤0.8 % (drift only). [Old held-scroll frame](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/earth-old-rule-reinjected-1440-scrolling.png) vs [new](../../apps/reference-dapp/e2e/visual-evidence/flofi-ux-ui-002/earth-new-1440-scrolling.png). | Done |
| UX/UI-008 A Remain in the channel | Composition, read-only preview and status already existed per surface but were not stated per channel. | Code-bound capability matrix (`src/platform/channel-capabilities.ts`, tested against tool names, channel switches, the notice sharing rule, the disabled in-frame wallet and the WhatsApp clearance gate), published in `/docs/mcp-integrations`. Truthful limits: no chat surface holds a signer; WhatsApp is not live. | Done within existing authority (see bounded decision) |
| UX/UI-008 B Open FloFi | Large "EXTERNAL PROPOSAL · FROM …" panel above the app, wallet proof, **Load proposal**, **Continue to simulation**. | The normal Canvas opens with the proposal's cards already placed (server `previewApproval`, PENDING only, grants nothing) and a compact notice in the workspace. The wallet proof (one sign-in message, or an existing FloFi session) loads the exact proposal through the existing claim → restore → hash-checked apply path; Simulate/Execute stay closed until then. Refresh of an applied proposal: explicit **Restore proposal**. Evidence (PR 2): `approve-before-proof-{1440,390}.png`, `approve-loaded-{1440,390}.png`. | Done (MOCKED/loopback evidence only) |

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

**PR 1 (`claude/build-flofi-ux-ui-002`)**

| Command | Result |
| --- | --- |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | PASS — 386 files / 4,400 tests passed, 2 skipped (existing owner-fixture tests) |
| `vitest run …/marketing/landing.test.tsx …/admin/admin-brand.test.tsx` | 8/8 |
| Landing/motion suite, `playwright --config playwright.motion.config.ts` against `next start` of the branch build | 63/63 (brand-motion-001, brand-visual-refinement, workflow-story ×8, landing-structure ×9, earth-footer ×7, ux-ui-002-landing ×13) |
| Main CI config: `playwright test brand-ux-001.spec.ts ux-ui-002-landing.spec.ts` | 28/28 |
| `node scripts/guarded-release-browser.mjs profile admin-console` | 1/1 (light and dark identity asserted) |
| `python3 scripts/governance_lite.py` + 19 self-tests; `git diff --check 14255c3..HEAD` | PASS |

Iteration failures, all fixed before the final runs: the new spec expected the onboarding chat to play while it was offscreen at 390 px (test corrected: it plays when seen); the hero height budget in `workflow-story.spec` failed at 320/1024/1440/1920 px after adding the community row — the links now sit beside the CTAs on wide layouts (desktop budget unchanged at 1,100 px) and the narrow budget is 2,100 px instead of 2,000 px (the wrapped 44 px row); a scratch `pkill -f` matched its own shell and stopped one rebuild (rerun).

**PR 2 ([#107](https://github.com/alrimarleskovar/FloFi/pull/107), `claude/build-flofi-ux-ui-002-omnichannel`)**

| Command | Result |
| --- | --- |
| `pnpm check` | PASS — 385 files / 4,396 tests passed, 2 skipped |
| `pnpm test:postgres` | PASS — 68 files / 443 tests passed, 3 skipped (forward-schema certificate suite, `runIf(CERTIFICATE)`, same on main) |
| Guarded profiles on `7999cad`: channel-approve, mcp-in-chat, channel-signing, developer-journey, mcp-routes-oauth-disabled, automations, and the CI critical tier (copilot-learning, canvas-corrections, solana-wallet-refusal, supply-provenance, review-execute-recovery-components) | 3, 21, 6, 1, 11, 2, 1, 5, 3, 5 and 39 passed; none failed or skipped |
| governance-lite + 19 self-tests; `git diff --check` | PASS |

Iteration failures, all fixed: a spec forced expiry by SQL, which the handoff immutability trigger rightly refuses (`MCP_HANDOFF_IMMUTABLE`) — expiry stays in the PostgreSQL test, the browser checks a replaced link; the WhatsApp owner tab inherited a sign-in session the router store then ended, and the notice kept the stale account — fixed in the product (re-read the session on `*_WALLET_PROOF_REQUIRED`); interruption specs matched the workspace's own workflow requests instead of the apply call (narrowed to requests carrying the link secret); the automation spec read the Canvas before the automatic reload restore (now waits for the notice's `loaded` state).

Not run: the other ~30 guarded product profiles (provenance, fork, composition, CoW, card, BUILD-009 with a live LI.FI quote). They do not exercise the changed code paths; CircleCI runs them on both PRs.

## Schema, migration and environment

No migration, schema export or new environment variable. Behaviour change on deploy: the mascot journey appears by default (`NEXT_PUBLIC_FLOFI_MASCOT_MOTION=false` restores the previous still landing). PR 2 adds one server action; the remote automation API is unchanged (automation links keep their after-proof load).

## Deployment requirements

None beyond the normal build. Vercel compiles the mascot default at build time. PR 2 needs no Railway change. Vercel Previews of these PRs run against the production database (existing configuration); a preview's `/approve` writes the same handoff rows as production.

## Remaining limitations and outstanding live tests

- All channel/MCP/wallet evidence is MOCKED or loopback: no live ChatGPT or Claude connector, Telegram bot, WhatsApp provider (still blocked by policy clearance), MetaMask/Phantom mobile app or public transaction was exercised. The owner runbook (`docs/deploy/UNIVERSAL-SIGNING-OWNER-E2E.md`) lists the live procedure.
- Browser validation is Chromium headless shell 1243 only; Safari/Firefox, real phones and hardware-level frame timing were not measured.
- Claude/ChatGPT menu names follow the operator guide (2026-10-06) and can drift; the section says so.
- PT on the landing is Brazilian Portuguese; the product catalog keeps its existing European-Portuguese style.
