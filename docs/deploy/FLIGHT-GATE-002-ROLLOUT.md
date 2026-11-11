# Flight gate 002 — activation, compatibility and rollback

Owner review is required before merging or deploying production. This runbook is a proposed operation, not evidence that it ran.
No production grants, Admin roles, credentials, queues, schedules or financial operations are changed by this build.

## Fixed calendar and authority

- FIRST closes **2026-11-12 02:59 UTC** (11 November, 23:59 BRT).
- All boarding opens **2026-11-12 12:00 UTC** (12 November, 09:00 BRT). Guests and creators have no early phase.
- Founding remains the first 100 eligible cards. Only a qualifying direct-list Founding member gets three invites.
- Sign-in, beta access, Admin authority and financial authorization are separate. An Admin OPERATOR never acquires product execution authority from its role.

`FLOFI_BETA_ACCESS` is a server setting on Vercel and Railway API/worker:

| Value | Behavior |
| --- | --- |
| Unset or `open` | Existing rollout behavior; do not activate production without owner authorization. |
| `beta` | Re-read the account session, persisted grant, applicable group/calendar, revocation and wallet binding before private work. |
| `closed`, empty or another configured value | Deny private work. There is no implicit team/Admin exception. Public access and Admin remain available. |

No grant is created by sign-in, OAuth email matching, a client parameter or Admin role. Explicit Board establishes a grant after a single-use Flight link/code proof or a valid redeemed invite; returning linked-wallet sign-in reuses the persisted claim and grant. Repeated Board cannot revive a revoked grant. New wallet bindings require explicit boarding after proving that wallet belongs to the account. Wallet login never signs financial transactions.

MCP OAuth consent during beta requires the same live FloFi session and persists its account/session association. Legacy MCP grants must re-consent; static MCP credentials cannot acquire beta rights. The gateway and downstream API recheck the persisted session. Telegram conversational authoring in beta reuses the existing Automations notification link (`automation_notification_targets`) as conversation↔wallet binding proof, then re-checks that wallet's live Flight grant server-side at drain time. The link alone never grants Flight access or financial authority; HELP/STOP/privacy/link remain available without a grant; STATUS/CANCEL stay available after revocation. WhatsApp keeps its existing provider controls and has no wallet-link binding in this release, so private WhatsApp authoring stays closed under beta while delivery/status/reconciliation continue. `open` restores the prior channel authoring behavior. Developer sandbox APIs retain their existing sandbox-only authority; they do not become mainnet execution routes.

## Database releases and simultaneous binaries

Current production is reported by the owner as schema 24. New migrations are additive:

- **0025_flight_gate**: grant, bound-wallet and MCP-session mapping tables; no existing authorization or financial row is rewritten.
- **0026_flight_early_list**: invitation expiry/revocation, Google Forms provenance, and a widened outbox template constraint accepting Email 0. Legacy invitations keep null expiry; existing uses are retained.

A certificate included in the new binary does **not** retroactively certify the currently deployed binary. Use two releases:

1. **Release A:** ship the existing schema-24 application with the exact 25/26 forward certificate and fixtures. Run its full suites against the certified schema ahead. Deploy that compatibility release to Vercel, Railway API and worker only after review. Confirm its reported schema compatibility and readiness on every instance.
2. **Release B:** after Release A is active everywhere, apply 25 then 26 with the normal advisory-locked migration command, under explicit operational authorization. Never use a preview migration against the shared production database. The migration manifest pins exact SHA-256 identities.
3. Deploy the schema-26 Railway worker/API and Vercel frontend/BFF, with production beta flag unchanged. Keep campaign scheduling/sending coordinated so no old worker is asked to render a new `EARLY_LIST` or creator v3 row. Do not enqueue Email 0 until all email workers run Release B. Existing v1/v2 renderers are retained; old unsent creator messages are held for operator review, never silently rewritten or resent.
4. Confirm all replicas run the new commit, share the same tenant/calendar and have compatible schema. A mixed BFF/API gate deployment is not an activation-ready state. Older clients lack identity headers and must fail closed when the new API gate is enabled.
5. At the authorized launch operation, configure `FLOFI_BETA_ACCESS=beta` consistently on Vercel, Railway API and workers. Verify new instances after environment changes; environment settings are process-local, so an operator must replace every older process. The application rereads the in-process value for each request, rather than capturing it in cached flow services.
6. Verify anonymous and authenticated-but-unlisted direct calls fail, valid active accounts/wallets pass, postponed/revoked access fails, and `/board`, login/recovery, legal pages, public cards and Admin remain usable. Do not infer coverage from a rendered page or a variable alone.

The fresh Preview uses a separate Neon project named `flofi-flight-gate-launch-002`, not the prior QA database or a copy of production data. Branch-scoped Preview settings select embedded runtime, beta mode, disabled email and paused execution. Hosted Preview uses the real clock; post-opening cases are additionally verified with explicit test clocks in disposable PostgreSQL, not represented as early public boarding. No real provider, wallet signing or email delivery is certified by a test seam.

## Emergency execution pause

`FLOFI_EXECUTION_PAUSED=true` denies new begin/handoff and server EVM, Solana, bundler and delegated/grouped submissions. Unset or literal `false` retains the existing technical controls; malformed configured values fail closed. Only an authorized operator with hosting configuration authority changes it. There is no public pause/resume endpoint and no dollar cap.

Activation procedure (owner/operator): record incident/time/commit; set the flag on every execution-capable Vercel/Railway process; replace old replicas; verify a fresh begin/handoff and an isolated submission test are refused with `EXECUTION_PAUSED`; verify a previously submitted transaction can still be reported, observed and reconciled. Never stop all workers as a substitute: observation and recovery must continue. Retain unknown outcomes and transaction identities; never automatically resend to test the pause.

A wallet payload or prompt already released before activation cannot be recalled by the server. The pause blocks new releases and server broadcasts; it cannot prevent a user independently submitting previously obtained bytes. Late wallet-batch reports remain accepted because the wallet may already have submitted them. A known transaction hash/receipt continues through reconciliation; unsent authorized groups remain durable and resumable.

Resume only with operator authorization: investigate/resolve the cause, record approval, restore literal `false` everywhere, verify replica versions, then let the owner explicitly resume. This build does not activate the switch in production.

## Rollback

- For an authorization incident, set `FLOFI_BETA_ACCESS=closed` consistently; preserve public login/recovery and Admin. Keep reconciliation running.
- For an execution incident, use the emergency pause independently; closing beta access is not a substitute for guarding a queued submission.
- Rolling back to `open` deliberately reopens the private product. It requires an explicit owner decision, not an automatic error recovery.
- Roll back application binaries only to Release A after schema 26 exists. An older uncertified schema-24 binary must fail readiness. Keep additive tables/columns and all grants, revocations, invitation history, imports and email state; do not run destructive down migrations.
- Never reset `SENT`, `UNKNOWN`, reservations or idempotency keys. For held old creator templates, inspect Resend outcomes first. Do not bulk-release `TEMPLATE_VERSION_REVIEW`, resend existing messages or create replacement invites without an operator-reviewed plan.
- Controlled creator v3 replacement (dry-run first; never production without owner authorization):

```sh
node apps/reference-dapp/backend/flight-admin.ts creator-supersede-templates --tenant default
node apps/reference-dapp/backend/flight-admin.ts creator-supersede-templates --tenant default --apply
```

  Only unsent `HELD`/`TEMPLATE_VERSION_REVIEW` rows with no provider contact are cancelled and re-queued as current CREATOR_INVITE v3 with the **same invite code**. `SENT` is never touched. `UNKNOWN` is skipped until an operator confirms the Resend log (`email-mark-delivered` or explicit non-delivery).

## Wednesday acceptance and evidence ledger

The responsible human records its name, UTC/BRT time, commit, environment, result and artifact URL for each item. Unexecuted steps stay pending.

| Acceptance | Responsible role | Evidence / acceptance | Rollback / pending |
| --- | --- | --- | --- |
| Preview isolation and gate | Engineering + release operator | New Neon project, branch settings, direct `/app` and API refusals, allowed account and revocation cases | Close gate; no production settings touched |
| Real recurring Privy wallet login | Account owner + engineering | First link/code proof, explicit link, sign out/in with the same real wallet; no second email | Recovery by verified email; real device remains owner acceptance |
| Guests and cards | Campaign + engineering | Before opening: exact EN/PT refusal and unchanged invite row; after opening: single redemption, simulation-based card, no TEST card, Founding race | Hold activation, preserve all issued records |
| Email 0 and creator v3 EN/PT | Campaign owner | Review HTML/plain text/subject/preheader/CTA/footer against canvas; approved list and timestamp/consent mapping | Hold new campaign rows; never resend SENT/UNKNOWN |
| Gmail/Outlook and inbound hello@ | Campaign + email/DNS operator | Explicitly authorized individual sends, message IDs/headers, inbox receipt and reply forwarding | No automatic DNS edits or campaign sends |
| Pause, recovery and resume | Release operator + execution engineer | Isolated denial of every new submission surface, continued known-hash reconciliation, approved resume | Keep new submissions paused while investigating |
| One small real route | Participating wallet owner + execution engineer | Team chooses amount/route after a fresh quote; owner reviews/signs; record hash, network and final reconciliation | Follow existing provider recovery; no autonomous resend |
| Simulation load | Engineering | Loopback/disposable or dedicated Preview only, bounded concurrency, latencies/refusals, no production traffic | Stop generator; preserve public quotas |
| UI and legal EN/PT | UX + engineering | 320/390/768/1440, header/footer open/closed/hover/focus/touch, keyboard/outside/Escape and screenshots | Revert scoped menu style only |
| CircleCI + Vercel | Release operator | Exact-SHA Governance, Contracts, browser jobs, authoritative certification ledger and Preview readiness | No merge/promotion before owner review |
| Freeze **11 Nov 18:00 BRT** | Product/release owner | Explicit freeze announcement, approved exception owner, outstanding-risk ledger | No automatic schedule changes |

### Controlled mainnet route (prepared; not executed)

Use the existing supported mainnet route and a wallet controlled by a participating team member. The team chooses the small amount after reading the provider's current minimum, fees, balance, slippage and liquidity; do not assume any fixed dollar amount works for all bridges. Confirm destination/network and review exact steps and approvals. Engineering records readiness; the human owner authorizes and signs through the normal wallet flow. Record the transaction hash and receipt, destination settlement and FloFi reconciliation/evidence. If status is unknown, inspect/reconcile instead of sending again. Completion requires evidence of execution **and** reconciliation. No transaction from this build has been signed or sent by the agent.

### Imports and delivery (prepared; not executed)

Use the existing operator CLI with an explicit tenant and an isolated `DATABASE_URL`. Dry-run first:

```sh
node apps/reference-dapp/backend/flight-admin.ts import-google-forms --file /secure/forms.csv --tenant default
node apps/reference-dapp/backend/flight-admin.ts creator-invites --file /secure/guests.csv --tenant default
```

Forms columns are `email,submitted_at,language,consent`; timestamp is ISO with its original explicit timezone, language is EN/PT or empty, consent is explicitly true/false. Never substitute import time for unknown signup time. Validate the original file, timezone and consent with its owner before applying. Import, enqueue and sending are separate operations:

```sh
node apps/reference-dapp/backend/flight-admin.ts import-google-forms --file /secure/forms.csv --apply --tenant default
node apps/reference-dapp/backend/flight-admin.ts email-early-list --apply --tenant default
node apps/reference-dapp/backend/flight-admin.ts creator-invites --file /secure/guests.csv --apply --out /secure/flight-invites.csv --tenant default
```

The output must be a new private mode-0600 CSV, delivered through the team's secure channel. Results/logs contain counts/state, not readable codes. Do not attach CSVs to a public PR, CI artifacts or commits. No apply/import/enqueue/send operation is authorized until the original lists and operational authorization are supplied. Existing Railway Worker + Resend + Neon remain the delivery stack.
