# BUILD-FLOFI-FINOPS-INTEGRATIONS-UX-003

FinOps provider integrations, Investor Reporting in USD and indicative BRL, gas payer evidence, and Admin schema and incident health.
Branch `build/flofi-finops-integrations-ux-003` from `main` `e8847ba8` (PR #227). No SQL migration, forward certificate or migration
identity changes. Editable 0.1% workflow pricing, fee activation and fee collection are out of scope: the fixed 0.1% policy and the
current non-collection behaviour are unchanged.

## 1. Provenance and scope

Codex implemented the build in two sessions that both stopped at their usage limit (the second at 20:23:49 UTC on 20 November, during
review). Claude continued the uncommitted working tree from that state without resetting it, verified the three handoff blockers as
already fixed, closed the remaining review findings and certified the result.

**Owner scope change (20 November 2026).** Platform Announcements (Admin editor, publication endpoints, publication history and the
editable product banner) was removed from this release and will ship separately. The public FloFi Beta Mainnet banner is byte-identical
to `main`: `app/(product)/layout.tsx`, `components/app-shell.tsx`, `state/product-bootstrap.tsx`, `server/platform-state-host.ts`,
`app/globals.css` and `i18n/*` are unchanged. Nothing in this build writes announcement text, or any new kind of event, to
`admin_audit_events`. The removed work is preserved outside this pull request for the future release.

## 2. What ships

| Area | Change |
| --- | --- |
| Railway | Additive GraphQL fragments with identical tags are aggregated per allowlisted production service and measurement after exact project and environment filtering. The concurrent usage-query limit is a rate limit. Usage quantities and separately labelled list-price estimates are meters; billed expense needs scoped invoice evidence. |
| CircleCI | Export jobs poll on a durable checkpoint with bounded waits. Up to 32 signed AWS parts are fetched four at a time without credentials or redirects, with 8 MB per part and 100 MB per export. Raw gzip is decompressed off the event loop and the worker yields before each part is parsed. Mixed-case headers, organization and project filtering, canonical job UUIDs, identical duplicates, conflicting duplicates and skipped-job nulls are handled. A failed export job is `FINOPS_PROVIDER_EXPORT_FAILED`, so the next run requests a new export instead of polling the failed one. Credits carry no billed USD. |
| Anthropic | Meter identity includes the API product and cost type in `basis`, so products sharing a model, day and metric stay separate. A null cost type is `unattributed`; a missing or malformed one is refused. Workspace attribution, the product allowlist and the refresh watermark are unchanged. |
| Sync engine and store | A historical period never clears or replaces the provider's current status, except for account-wide refusals (authentication, access, entitlement, scope, configuration), which always surface and are cleared by the provider's next answer (a result or an accepted export). A historical period's final failure, including an abandoned lease, is recorded as an `UNAVAILABLE` coverage gap with its code; a gap never replaces a snapshot that holds data. Removing a credential ends its cycle. A meter `basis` shaped like an address is refused. |
| Investor Reporting | Actual-cost rollups use invoice, accounting and provider-cost records with invoice precedence. Meters, list prices and scenarios stay separate. Ordinary amounts show two locale-aware decimals; a non-zero amount never reads as zero (four significant digits below half a cent), and unit costs keep adaptive precision. CSV exports keep exact USD (the dashboard's ledger table shows exact recorded values), indicative BRL, the PTAX source, policy, cutoff, rate and São Paulo publication time, coverage and integration status. Ledger FX provenance is the fixed label "documented ledger FX rate". The monthly change compares the same number of closed UTC days in both months. |
| PTAX | Banco Central do Brasil PTAX sell rate (public, no credential). Open periods use the previous UTC day; closed periods use their last included day. A quote up to four days older is accepted. Missing, stale, future, conflicting or non-positive quotes leave BRL unavailable and USD intact. The loopback browser harness makes no PTAX request. |
| Gas payer evidence | A tenant-scoped, read-only count classifies recorded real-funds mainnet workflow groups as user-native, third-party-fronted (including a relayer-fronted failure whose token reimbursement was zero), observed FloFi sponsorship or unresolved. Counts are operational; billed expense requires an independently matched debit or invoice. |
| Admin connection states | The integrations table and the investor CSV share one connection state (synchronizing, manual only, not configured, not entitled, needs attention, stale, credential configured, usage synchronized, connected) with provider-specific recovery guidance. Synchronized periods count only periods with data; gaps are listed with their reason. |
| Schema and incident health | `assertSchemaCompatible` raises `SchemaCompatibilityError` with the legacy messages and causes plus a state: exact, certified ahead, behind, uncertified ahead, invalid history or unavailable. Admin health treats certified ahead as healthy, separates a failed incident read from an empty one, and shows only generic startup diagnostics before sign-in. |

## 3. Provider matrix (production as observed read-only on 20 November 2026, before this release)

| Provider | State | Next action (owner) |
| --- | --- | --- |
| OpenAI | Configured; synchronizing provider costs | Reconcile provider costs to invoices for verified billing. |
| Railway | Configured; the last production attempt failed with `FINOPS_PROVIDER_RESPONSE_INVALID`, the parsing defect this build fixes | Observe the first production sync after release; real charged dollars need a scoped invoice. |
| CircleCI | Configured; the last production attempt failed with `FINOPS_PROVIDER_RESPONSE_INVALID` (seven-part raw-gzip export), fixed here | Credits only; monetary coverage stays unavailable without scoped invoices. |
| Anthropic | Not configured | Needs an organization Admin or `read:analytics` key with verifiable workspace attribution; an individual Console account cannot create one. |
| Neon | Not configured | Confirm least-privilege Consumption Metrics v2 access for the inventoried projects (project-scoped attempts returned 404). |
| Vercel | Not configured | Verify Billing-role FOCUS export access (historical requests returned `Plan not found`). |
| Alchemy | Not configured | Free-plan per-app grouping returned 403; prove exclusive attribution before enabling. |
| Resend | Manual records only | Record scoped invoices. |

No provider plan, credential or production configuration was requested or changed.

## 4. Review findings and dispositions

| Reviewer | Finding | Disposition |
| --- | --- | --- |
| Security | Investor CSV exported free-text ledger FX labels | Fixed (fixed label); test asserts the private label is absent. |
| Billing / workflow | Failed Kora gas with zero reimbursement counted as unresolved | Fixed; PostgreSQL fixture with a valid Solana mainnet group. |
| Billing | Monthly change used unequal windows; equivalent Vercel decimal spellings bypassed deduplication; CSV status could contradict the dashboard | Fixed with tests. |
| Admin / analytics | A historical CircleCI poll cleared the current period's error; empty snapshots counted as synchronized; CSV meter rows used the current-period timestamp | Fixed with tests. |
| Automations F1 (P2) | Historical failures left no trace; account-wide refusals were hidden on historical-only cycles | Fixed (gap snapshots with codes, account codes always surface) with four PostgreSQL regressions. |
| Automations R1 (delta review) | An account-wide refusal from a historical-only cycle was not cleared by a later historical answer | Fixed: a historical result or accepted export clears it; PostgreSQL regression. |
| Automations F2–F4 | Event-loop blocking while decompressing CircleCI parts; failed export polled again; a deconfigured provider stayed active | Fixed (async gunzip and per-part yield; `EXPORT_FAILED`; deconfigure ends the cycle). The character-by-character CSV parser is unchanged; observed exports are under 1 MB. |
| Data / privacy | Address-shaped `basis`; `cost_type` coerced to `"undefined"` | Fixed with tests. Announcement findings closed by the scope removal. |
| Frontend | Missing Portuguese copy; singular counts and inclusive UTC ranges; sub-cent amounts shown as zero next to BRL; English quality codes in the Portuguese AI and workflow sections; AI cost hidden without telemetry | Fixed with tests. Announcement findings closed by the scope removal. |
| Infrastructure | Readiness probe started after the stopped-work query | Fixed (started first). |
| Security (final, clean head) | None | Outsider-tenant export assertion strengthened on its suggestion. |
| Billing and admin-analytics (final, clean head) | Usage and estimate ledger rows looked counted in the reconciliation table; a removed credential's old error appeared in the CSV and cost breakdown; an unreadable sync state left the CSV status section empty; two closed codes had no label | Fixed with tests: a per-record exclusion note, deconfiguration clears the stored error and both surfaces ignore it, an explicit `UNAVAILABLE` status row, labels in both languages. |

**Owner notes (no change made).**
- Recorded expenses now count only invoice, accounting and provider-cost records; usage and assumption ledger rows are shown but excluded.
  Production held only 32 provider-cost records (OpenAI) on 20 November, so no reported figure changes at release. A zero-spend required
  scope (gas sponsorship, relayer) is complete only with an invoice record, so margins and break-even stay unavailable until those exist.
  The FinOps engineering skill states this rule.
- BRL translation rows carry the quality of the USD amount they translate, with the source column marking them indicative. Labelling them
  `ESTIMATED` instead is an owner presentation decision.

## 5. Validation

- `pnpm check` (typecheck, lint, build, schema drift, unit tests), `agent_guard.py check`, `governance_lite.py` and its unittest suite:
  see the pull request for the exact-revision results.
- Focused unit and PostgreSQL 18 (disposable loopback) suites for FinOps, PTAX, Admin attention and health, schema compatibility
  (including the real `main.ts` cold starts) and forward compatibility pass.
- Local browser profiles could not start: the host's loopback networking began holding connections to every closed `127.0.0.1` port,
  so the fork harness's free-port probe times out (`E2E_PORT_OCCUPIED:8545` with nothing listening). CircleCI's browser jobs are the
  browser evidence for this build.
- CircleCI's certification ledger is the release authority. Fixtures, replays and loopback runs are not provider or production evidence.

## 6. Remaining limitations

- Provider costs other than invoices are `PROVIDER_REPORTED`, not verified billing; Railway estimates and CircleCI credits are not charges.
- BRL is indicative (PTAX) and never replaces USD accounting values.
- Gas sponsorship expense stays unavailable without a matched FloFi debit or invoice.
- Anthropic, Neon, Vercel and Alchemy remain unconfigured pending owner-side entitlement and attribution decisions (section 3).
