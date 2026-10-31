# BUILD-FLOFI-LANDING07-README-001 — Landing Page 07 and the end-user README

Status: **PARTIAL — README delivered; Landing 07 BLOCKED on input.** Nothing was merged, deployed, configured or executed. No
transaction was signed or sent.

| Part | State |
| --- | --- |
| Install Caio's Landing 07 at `/` and route its entry CTAs into the PR #143 sign-in flow | **Blocked.** The package `FloFi-Landing-07-Alrimar-2026-10-30.zip` was not available in this session (see §2). No landing file, asset, route or test was changed. |
| Rewrite `README.md` as an end-user product README | **Done** (§4). |

## 1. Base

- Repository: `FloFi-xyz/FloFi` (the session's remote `alrimarleskovar/FloFi` redirects there; PR #143 reports `FloFi-xyz/FloFi`).
- Dependency: PR #143 `BUILD-FLOFI-AUTH-WALLETS-001`, **open, not merged**, head branch `claude/wonderful-shannon-nacbbz` at
  `a5fa5c838b4bd4f2b6a00b826383f0ec31c194cb`, base `main` at `39459013b125c7ef5bf6c92b9fb9326005ed55fe` (checked 2026-10-31).
- This build: branch `claude/build-flofi-landing07-readme-001`, created from `a5fa5c8` and stacked on PR #143. PR #143's branch was
  not modified.

## 2. Landing 07 input — not available

The prompt names the attachment `FloFi-Landing-07-Alrimar-2026-10-30.zip` (with `COPY_INTO_REPO/`, `ROUTE_EXAMPLE/page.tsx`,
`SHA256SUMS.txt`, `README_COMECE_AQUI.md`, `INTEGRACAO.md`, `VALIDACAO_E_LIMITES.md`, `PENDENCIA_HERO_F.md`, `ASSET_NOTES.md`,
`BRAND_REFERENCE`, `VISUAL_REFERENCES`, `PREVIEWS`, `ISSUES`). Searched, with no match:

- the session container (whole filesystem, by name and for any recent `.zip`), the attachment and upload mounts;
- the repository (all 286 remote refs) and GitHub code/PR search for `landing07`;
- the owner's mailbox (attachments, `.zip`, Drive links, messages from or to Caio).

Because the approved design must be installed byte for byte and must not be recreated, nothing was approximated. Consequently there
is **no** list of received hashes, no source-vs-integrated diff, no screenshots and no route change in this build. `PENDENCIA_HERO_F.md`
could not be read; the hero "F" observation is carried forward only as the owner reported it, unaddressed by design.

### 2.1 Integration plan once the package is supplied (no design change)

1. Unpack into an empty scratch directory; record `sha256sum` of every file and check it against `SHA256SUMS.txt`.
2. Copy only `COPY_INTO_REPO/apps/reference-dapp/src/components/marketing/landing07-{page.tsx,demo.tsx,copy.ts,module.css}` and
   `COPY_INTO_REPO/apps/reference-dapp/public/landing07/*`; re-hash them in the repository (expected: identical).
3. `apps/reference-dapp/src/app/page.tsx`: render `Landing07Page` instead of the old `LandingPage`, reconciling `ROUTE_EXAMPLE/page.tsx`
   with the current root layout (`app/layout.tsx`, `base.css`, `fonts.css`) and metadata. Any font the package needs is provisioned for
   `/` only, never globally for `/app` or `/login`.
4. Entry CTAs: PR #143 sends every landing "Launch" CTA to `/login`. `/login` already restores a valid session (onboarding when pending,
   otherwise a safe `returnTo`, default `/app`) and offers *Explore the builder without an account*; `/app` stays open. If Caio's CTAs
   point to `/app` (the snapshot predates PR #143), the only change is that destination, reported line by line; classes, markup, text
   and motion stay untouched. `/docs` and every other link stay as delivered.
5. Old-landing browser specs that assert the previous layout (`landing-structure`, `ux-ui-002-landing`, `earth-footer`,
   `brand-motion-001`, `beta-ui`, `native-docs`) are retargeted to Landing 07 without editing the landing.
6. Desktop and mobile screenshots compared with `VISUAL_REFERENCES` / `PREVIEWS`; `/` → `/login` → onboarding → `/app`, returning
   session, direct `/app` and `/docs` exercised on the MOCKED loopback harness (`playwright.auth-wallets.config.ts`).

## 3. Files changed

| File | Change |
| --- | --- |
| `README.md` | Rewritten (§4). |
| `docs/builds/BUILD-FLOFI-LANDING07-README-001.md` | This record. |

No application code, test, asset, dependency, workflow, migration, provider, fee or security control changed.

## 4. README

Language: English. Structure:

1. Identity — logo, tagline from the product copy (*Many ways in. One clear path.*), official links, a real product screenshot
   (`docs/builds/BUILD0-UX-001-EVIDENCE/build0-desktop-dark-1240.png`, Build 0 with the *FloFi Beta Mainnet* banner) and a one-line
   real-funds beta notice.
2. What is FloFi — non-custodial multichain DeFi; chat (AI Copilot where enabled) and the optional visual builder; simulate, review,
   sign, track.
3. Why people use it — user-value table.
4. What you can do today — action × network table for the five mainnets, bridges (including EVM ↔ Solana), multi-step workflows, and
   the honest evidence boundary.
5. How it works — sign in/connect → describe or build → review → authorize → track; the canvas is optional.
6. Your account and wallets — PR #143 methods and embedded wallets, with their rollout state.
7. Use FloFi where you already are — app, MCP, Telegram, WhatsApp with real availability.
8. Pricing — the 0.1% model versus what the code does today.
9. FloFi for Developers — API, SDK, webhooks, MCP and their current limits.
10. Security — principles; no audit claim.
11. Status & evidence — built-but-per-deployment features and the roadmap.
12. Documentation, local run for developers (`FloFi-xyz/FloFi`), contributing, license and the Gryloo note.

### 4.1 Sources of truth for each claim

| README claim | Source |
| --- | --- |
| Mainnet-only product, five networks, actions per network | `src/engine/strategy-spec.ts`, `src/domain/network-scope.ts`, `src/components/docs/content.ts` (Supported Networks table); production MCP `get_supported_networks` / `get_capabilities` at `https://flofi.xyz/api/mcp` (read-only, 2026-10-31): every listed row `enabledByDeployment: live`, `demonstratedEvidence: NONE_DEMONSTRATED` |
| EVM ↔ Solana bridges | `packages/workflow-contracts/src/universal-router.ts`, `src/engine/strategy-engine.ts` (universal bridge, Relay execution) |
| Bridge review shows provider, fees, guaranteed minimum | `src/components/universal-bridge-panel.tsx` |
| Multi-step: in order, fresh review + signature per step, spend what was delivered | `src/domain/workflow-sequence.ts` |
| Not certified on mainnet; recorded executions are testnet owner runs | `docs/builds/BUILD-FLOFI-UNIVERSAL-E2E-001-CERTIFICATION-MATRIX.json` (11 `LIVE_CERTIFIED`, all testnet/devnet), `docs/builds/BUILD-FLOFI-UNIVERSAL-E2E-001-READINESS.md` |
| Approvals spelled out, uncapped allowance warning | `src/domain/review-presentation.ts`, `src/components/review-workspace.tsx` |
| Accounts and embedded wallets, disabled-when-unconfigured, `/app` open | PR #143: `app/(account)/login/page.tsx`, `docs/builds/BUILD-FLOFI-AUTH-WALLETS-001.md` §6–§7, §12 |
| MCP endpoint and tools; ChatGPT/Claude acceptance pending | `src/mcp/config.ts`, `src/mcp/tools.ts`, `components/marketing/assistant-onboarding.tsx`, `docs/builds/BUILD-MCP-LINK-INTEGRITY-P0.md` |
| Telegram built, live acceptance pending; WhatsApp policy-blocked | `src/channels/telegram/config.ts`, `docs/deploy/TELEGRAM.md`, `src/channels/whatsapp/config.ts` |
| 0.1% fee recorded, not collected; waived on failure; other runtimes record none | `src/server/universal-router/fee-obligation.ts` (+ test), `src/domain/conversation-lifecycle.ts`, `src/app/admin/page.tsx` |
| Developer API sandbox-only, per deployment | `src/developer/config.ts`, `src/developer/http.ts`, `src/developer/service.ts`, `src/platform/strategy.ts`, `docs/developer/README.md` |
| Automations built, opt-in; delegated execution blocked in production | `src/automations/config.ts`, `src/delegation/config.ts` |
| Social links | `src/components/marketing/social-links.tsx` (owner-supplied) |
| Website and MCP URL | `src/platform/navigation.ts`; production MCP navigation result |

Links to `flofi.xyz` and `github.com` could not be fetched over HTTP from this session (the network policy denies both hosts). The
website and MCP URLs were confirmed through the production MCP server's own result; the repository URL through the GitHub API.

## 5. Validation

Toolchain: Node 24.21.0, pnpm 11.22.0.

| Check | Result |
| --- | --- |
| `pnpm check` | pass — typecheck 16/16, lint, build 9/9, 11 schema exports, 465 test files · 5,855 tests passed · 2 pre-existing skips |
| `python3 scripts/governance_lite.py` | pass |
| `python3 scripts/test_governance_lite.py` | pass (19 tests) |
| README relative links and images | all resolve |
| Landing, login-flow and screenshot checks | **not run** — Landing 07 was not installed; the app is unchanged from PR #143, whose own browser evidence applies |

## 6. Open items for the owner

- **Supply the Landing 07 package** (§2); integration then follows §2.1 in this same PR.
- Hero "F" / ribbon crossing (`PENDENCIA_HERO_F.md`): pre-existing visual item of the package, left for the owner and Caio.
- Live Google, Apple and Turnkey verification remains a PR #143 external gate; MOCKED provider tests do not prove it.
- Outdated repository links outside this build's scope, not changed: the current landing footer
  (`components/marketing/page.tsx`), the docs header "Source code" link (`components/docs/docs-shell.tsx`) and the in-app Getting
  Started clone command (`components/docs/content.ts`) still point to `alrimarleskovar/gryloo`.
- Stale status documents, not changed: `docs/STATUS.md` (no entries for PRs #118–#141; "No FloFi fee exists yet" predates the
  recorded 0.1% obligation; matrix counts 51/9 vs the file's 52/8), `docs/deploy/TELEGRAM.md` (allowlist described as default; code
  defaults to public when enabled), the matrix row `bridge-evm-solana` (says no route exists).
- The repository has no vulnerability-disclosure policy (`SECURITY.md`); the README does not invent one.
