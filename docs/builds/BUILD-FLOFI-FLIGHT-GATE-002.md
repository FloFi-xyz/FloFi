# BUILD-FLOFI-FLIGHT-GATE-002

Implementation recovered on 10 November 2026. Base: `origin/main` at `3a8b97abe4e28b30b52a3755d3f22a15a5d3d34e` (merged PR #178). No production operation is implied by this report.

## Recovery and source of truth

The previous session left branch `codex/flight-gate-launch-002` in `.worktrees/flight-gate-launch-002`, based on `509b7ac6`, with 66 modified and 11 untracked files. `/tmp/flofi-flight-gate-launch-002` is a symlink to that same worktree, not a second implementation. A private backup of unstaged/staged diffs and untracked files was made under `/tmp/flight-gate-recovery-20261110`, followed by checkpoint `48c1c970`. Latest main was merged without reset, clean, force checkout or destructive rebase; Admin, legal content and frozen v1/v2 renderer changes from #178 were retained.

The updated canvas was recovered as local extracted documents under `/tmp/flight-gate-canvas/assets/`: technical strategy `7458fa1a-728e-4244-89c7-0ad1520abd03`, Email 0 `dcdb1592-cc88-4cd9-b915-ebfb27cc7d8f`, Email 6 `12c6cf5d-a76b-4ba2-aaad-33435f89e009`, Portuguese emails `e7d2bf54-a83b-4f81-928e-28ef29e9243b`, and launch/landing handoffs. The owner's current written decisions override older TEST-flight proposals. No missing campaign text is invented as approved copy.

## Diagnostic and compliance matrix

| Boundary | Before this build | Result / evidence | External acceptance |
| --- | --- | --- | --- |
| `/app`, Chat, Editor, product deep links | Divergent: authentication/campaign controlled benefits, not closed-beta product use | Server product layout + private Server Action boundary; direct API/quote protection | Hosted rollout must be authorized and coordinated |
| Privy/account/wallet | Implemented authentication and durable links; incomplete beta authorization | Active Flight grant, live account session, tenant and wallet membership rechecked; first link/code proof then recurring linked-wallet login | Live real-wallet/Privy device acceptance remains separate |
| FIRST groups | Campaign eligibility existed | Closed group denies; opening and postponement rechecked against persistent source | Campaign batch schedule remains owner-controlled |
| Invitations and cards | Divergent: creators had early TEST phase | One opening at 12 Nov 09:00 BRT; no early consumption or official card; single-use/recipient binding/expiry/revocation; 100 Founding and non-propagating three invites retained | No production invites generated |
| API/BFF/Railway | Incomplete: service bearer did not prove Flight identity | Shared backend gate on direct calls, previews, persistence/history and extra automation/delegation routes; authorization before idempotent replay | Mixed-version deployment requires Release A/B sequence |
| MCP | Incomplete beta identity binding | Explicit OAuth consent binds to authorized FloFi session; unmapped/static/invalid/revoked identities denied; identity carried to runtime | Legacy MCP clients re-consent during beta |
| Channels | No shared Flight authorization for private authoring | Conversational authoring closed during beta per canvas; delivery receipts, notifications/status and reconciliation continue | Provider delivery remains separately configured/accepted |
| Automations/delegation/workers | Existing owner authorization; missing beta policy | Worker checks owner beta access before new proposals/signing/submission; submitted/unknown work stays reconcilable | Production delegated signing is not newly enabled or certified |
| Emergency pause | Fragmented technical execution flags, cached services and grouped paths | Shared dynamic server guard before new begin/handoff/broadcast; receipt/report/reconciliation preserved | Already released external-wallet requests cannot be recalled |
| Email 0 | Not implemented | Independent EARLY_LIST template EN/PT; original Forms provenance/timestamp/consent; idempotent outbox and CLI dry-run/apply | Original export and operational import/send authorization missing |
| Email 6 | Divergent: early test flight in v1/v2 | New creator v3 EN/PT with Thursday opening and official brief; old unsent creator rows held; SENT never resent | Campaign owner review and actual Gmail/Outlook delivery pending |
| Resend/inbound email | Sender/Reply-To, quota reservation and domain checks implemented | Code preserves `FloFi <hello@flofi.xyz>`, Reply-To Gmail, 100/day and 3000/month defaults with reservations and external reserve | Provider plan/domain account state, real delivery and inbound forwarding need separate proof |
| Landing Language | Divergent: large bordered circle | Compact transparent trigger, touch area, focus/keyboard/Escape/outside click, upward footer | 84 captures across 320, 390, 768 and 1440 px, EN/PT, header/footer and touch |
| Admin `/admin/flight` | Implemented in #178; owner confirms 3 active OPERATOR, 0 VIEWER | Kept independent from beta and financial authority; no grants/roles/session updates executed | Owner's confirmed production state preserved, not re-granted |

New source ownership and required meaningful tests are assigned in `docs/engineering/coverage.json`; specialist reviews are advisory, not certification. No new dollar limit, action/network claim, fee activation or transaction-path agent is added.

## Mainnet/bridge technical minimum audit

No universal minimum or arbitrary dollar ceiling is introduced. Supported capability registries remain unchanged. The legacy Router keeps its current 12 directed USDC/USDG paths among Ethereum, Base, Arbitrum and Robinhood; the universal Relay Depository paths retain Ethereum/Base/Arbitrum/Robinhood/Solana mainnet identities. Discovery catalogs alone do not establish execution support.

| Provider/path | Existing technical refusal | Primary reference / evidence limit |
| --- | --- | --- |
| Across direct/LI.FI routing | Quote fee/input/output, calldata, balance/gas, expiry, liquidity and minimum checks; unavailable/too-small routes refuse | [Across quote API](https://docs.across.to/api-reference/swap/approval/get); route-dependent fees can exceed input. No live numeric minimum was proven. |
| LI.FI discovery and legacy Router | Provider route/error and fee consistency; insufficient route/liquidity safely refuses | [LI.FI error codes](https://docs.li.fi/api-reference/error-codes). Pre-existing generic top-level errors may hide nested `errors[].code` and surface `LIFI_NO_ROUTE` instead of a specific minimum reason. |
| Relay universal execution | Provider-driven minimum/fees/liquidity, min receive, balance/gas and exact transaction validation | [Relay errors](https://docs.relay.link/references/api/api_core_concepts/handling-errors). Current quote is required for the actual route and amount. |

A read-only Across limits lookup was inaccessible through the research tool. No numeric minimum and no claim that US$20 works everywhere is made. Specialist bridge audit: 161 focused unit cases passed using fixtures. No real bridge transaction was attempted.

## Validation and operational evidence

Focused implementation results already produced:

- Backend beta/HTTP and previews: 18 passed, including revoked-session/grant replay, wallet/tenant isolation and continued reconciliation after a MOCKED submission.
- Email/data: 36 focused unit cases and 50 PostgreSQL cases passed; v1/v2 renderer history and new creator v3 tested, imports/CSV and consent/idempotency tested.
- Execution pause: 42 cases passed in five focused suites; additional service run 70 passed, two existing owner/fork-gated cases skipped. No public submission.
- MCP: seven PostgreSQL OAuth+PKCE/gateway cases passed with a test-only Privy-session seam; real delivery/provider device acceptance is not implied.

The complete local unit suite passed 6,961 cases with two existing skips before the final login-wallet adjustment. The focused account, Privy and Flight request re-run passed 27 cases after that adjustment. The previous complete PostgreSQL run passed 699 cases with three existing skips. The final revision is tracked independently in the PR checks. Anvil and isolated fork checks passed 4 and 31 cases respectively, with 10 and 32 existing skips. Five closed replay passes each completed 50 cases. The replay and provider fixtures supply no evidence of live mainnet transactions.

Playwright captured 84 images for the two language menus, including keyboard and pointer states and touch. The baseline reconstructs the trigger CSS from PR #178 on the same loopback page. [Desktop PR #178 baseline](evidence/flight-gate-002/language-EN-1440-header-pr178-trigger.png) · [Desktop adjusted trigger, hover](evidence/flight-gate-002/language-EN-1440-header-hover.png) · [320 px PT footer, open](evidence/flight-gate-002/language-PT-320-footer-open.png) · [390 px footer, touch](evidence/flight-gate-002/language-390-footer-touch-open.png).

The 24-compatible certificate is available in [Release A PR #179](https://github.com/FloFi-xyz/FloFi/pull/179). Its local package build passed 8 tasks, and 72 focused compatibility cases passed on real isolated PostgreSQL.

Public DNS queries confirmed DKIM at `resend._domainkey.flofi.xyz`, `p=none` DMARC, and the provider alias at `send.flofi.xyz`. Neither of the queried public resolvers returned an apex MX. Incoming forwarding to Gmail and current Resend dashboard verification remain unconfirmed. The approved From and Reply-To are preserved. The [Resend Free plan](https://resend.com/pricing) publishes 100 messages per day and 3,000 per month. Production quota usage and Gmail/Outlook inbox receipt need authorized provider evidence.

The current 12-hour account session and existing invitation storage are retained for compatibility. Wallet recovery through Privy requires an email already associated with the same Privy account. Proving a Flight email does not move a grant to a different account. A wallet-only identity without a linked Privy recovery method requires assisted recovery. No cross-account transfer is enabled.

The fresh isolated Neon project is `cool-meadow-65373994` (`flofi-flight-gate-launch-002`), created empty for this build. The owner explicitly authorized storing its connection credential only in the Vercel Preview of this branch. No prior QA or production dataset was used. Preview-only execution is paused and campaign sending disabled; these settings are not production activation.

See [activation, compatibility, rollback and Wednesday checklist](../deploy/FLIGHT-GATE-002-ROLLOUT.md). Mainnet low-value execution, Google Forms/import, creator-list application, campaign sends, Gmail/Outlook delivery and inbound forwarding remain unexecuted pending original data and/or explicit human action. No production permissions, DNS, queues, funds or schedule were changed.
