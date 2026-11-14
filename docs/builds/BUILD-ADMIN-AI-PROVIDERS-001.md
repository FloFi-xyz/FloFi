# BUILD-ADMIN-AI-PROVIDERS-001 — Admin UX overhaul and native Anthropic provider

One coordinated change: the whole `/admin` console is reorganized around operator tasks, and Anthropic (Claude, Messages API) becomes a
second Copilot provider beside OpenAI, selectable per channel at runtime. No database migration. No change to wallet, signing, transaction,
execution, network-scope or authorization code. Nothing is activated by deploying it.

## 1. Admin inventory (before any change)

| Route | Purpose | Kept |
| --- | --- | --- |
| `/admin/login` | Wallet sign-in (EIP-4361, `personal_sign`), the only unauthenticated page | yes |
| `/admin` | Overview: execution KPIs, funnel, activity, network distribution, bridges, utilization, fee observability, errors | yes, plus *Status at a glance* |
| `/admin/health` | Database, Railway API, queue, executions under observation, scheduler, Copilot, incidents | yes, plus summary and attention list |
| `/admin/workflows` | By flow, requiring attention, executions (filters by range, environment, outcome) | yes (attention first) |
| `/admin/automations` | Rules, evaluations, occurrences, proposal → execution, delegated executions, issues | yes |
| `/admin/ai-settings` | Versioned Copilot settings: default + per-channel overrides, probe, reset, rollback, history | redesigned (§3) |
| `/admin/ai-analytics` | Daily Copilot counters (live/replay, 7/30/90 days) | yes, plus usage and estimated cost by provider/model |
| `/admin/ai-learning` | Learning status, metrics, glossary candidates, publication, rollback | yes |
| `/admin/flight` | Flight FloFi campaign: totals, OPERATOR subscriber search/export, VIEWER privacy | yes |
| `/admin/access` | Session, append-only audit trail | yes, plus plain event names and outcome filter |
| `/admin/api/**` | session, settings/copilot, learning, flight (+ entries, export) | unchanged contracts; settings gains the `models` action |

OPERATOR/VIEWER permissions, CSRF and origin checks, sealed sessions, audit writes and every metric definition are unchanged.

## 2. Admin UX

* **Navigation by task** — Monitor (Overview, System Health), Operations (Workflows, Automations), AI Copilot (Settings, Analytics,
  Learning), Campaigns (Flight FloFi), Security (Access & audit). Same URLs and link names; a page eyebrow shows the group; a skip link;
  on phones the menu is a horizontally scrollable strip (no page-level horizontal scroll, verified at 390 px).
* **"Is everything normal / what needs my attention?"** — Overview and System Health open with status tiles and an attention list built
  only from the existing health and Copilot probes (`src/admin/attention.ts`); an unreadable probe is "unknown", never "healthy". Each item
  links to where it is handled.
* **Shared blocks** (`components/admin/admin-ui.tsx`): status is always text + symbol (never color alone); warnings are never collapsed;
  implementation detail (env var names, raw codes, daily rows) sits in labelled *Technical details* disclosures.
* **Language** — "Environment bootstrap" → *Default system settings*; "Runtime vN" → *Active configuration vN*; "Provider API key" →
  *Provider connection*; "Per-channel overrides" → *Custom settings by channel*; "Test … with a live request" → *Test connection and
  model*; invalid stored settings → *Unavailable for safety*. Codes stay visible where operators need them.
* **Styles** — the existing FloFi palette and tokens; refined type scale, spacing, table headers and hover, consistent 36 px controls
  (44 px on touch), focus rings, reduced motion. No new design system, no decorative gradients.

## 3. Anthropic as a Copilot provider

### Architecture
`interpretCopilotV2` still builds one provider-neutral request and parses one response shape. `src/server/copilot-providers.ts` adds an
Anthropic transport that translates at the edge:

* request → Messages API: `system` blocks (instructions, then glossary / reply-language notes), transcript, FloFi's read-only tools
  (`strict: true`), `tool_choice` auto/none, `output_config.format` (strict JSON schema, with the keywords Anthropic does not compile —
  numeric/length bounds, `pattern`, array bounds — removed from the *sent copy*; `oneOf` → equivalent `anyOf`), `output_config.effort`.
  No `temperature`/`top_p`/`top_k` ever (refused on `anthropic-version: 2026-10-21`).
* answer → the shared shape: refusals stay refusals, `max_tokens`/`pause_turn` are incomplete, tool calls become function calls with the
  whole assistant turn (thinking blocks included) echoed back unchanged on the next round, any unexpected block (server tools, unknown
  types) stays an unknown item the shared reader refuses.

Everything that decides what a model may do is shared and untouched: instructions, the strict schema, `parseCopilotOutputV2`, the tool
allowlist and argument validation, orchestration bounds, grounding, the limiter and the closed failure codes. The model returns an
untrusted intent; it cannot sign, submit, approve, transfer, schedule or edit a workflow.

Transport: fixed `https://api.anthropic.com/v1/messages`, `redirect: 'error'`, hard timeout, 256 KiB byte cap, key only in `x-api-key`,
no automatic retries. Errors normalize to closed codes: `COPILOT_UPSTREAM_UNAUTHORIZED` (401/403), `COPILOT_UPSTREAM_BILLING` (402 or a
credit-balance 400), `COPILOT_UPSTREAM_MODEL_UNAVAILABLE` (404), `COPILOT_UPSTREAM_RATE_LIMITED` (+ bounded Retry-After), `COPILOT_TIMEOUT`,
`COPILOT_UPSTREAM_REJECTED`, `COPILOT_UPSTREAM_UNAVAILABLE` (5xx/529). Operators see only allow-listed diagnostics (status, error type,
named parameter); provider message text is never returned or logged.

The official `@anthropic-ai/sdk` was deliberately not added: the existing OpenAI path uses a hand-built HTTPS transport so that the
endpoint is fixed, redirects are refused and the response is byte-capped before parsing — properties the SDK does not offer — and adding
a dependency would also widen the dependency-security surface. The request/response shapes follow Anthropic's documented REST contract.

### Settings model (no migration)
Every settings set carries a provider. Schema stays `flofi.copilot-settings.v1`:

* a set without `provider` is OpenAI — every existing version keeps its meaning and stays restorable;
* OpenAI sets are **stored** without the field (byte-identical to the previous build's form, so a rolling deploy reads them);
* Anthropic sets carry `provider: "ANTHROPIC"`, which the previous build refuses (fail closed) rather than misreads as OpenAI;
* validation refuses mixing providers (a `claude-*` id is never sent to OpenAI and vice versa), provider-specific efforts (OpenAI
  `minimal`–`high`, Anthropic `low`–`max`), any Anthropic temperature, Claude families known to lack strict structured output (Opus 4.6/4.7,
  Sonnet 4.5/4.6, Claude 3); unknown Claude ids need an explicit acknowledgment.

### Routing and credentials
`resolveCopilotLive` resolves the channel's effective settings, then uses **only that provider's key**. A missing key →
`COPILOT_PROVIDER_NOT_CONFIGURED` for that channel; there is no fallback to the other provider, so an Anthropic outage never creates
OpenAI traffic or charges. A live Copilot with only `ANTHROPIC_API_KEY` works once Anthropic settings are active; the `OPENAI_COPILOT_*`
bootstrap stays OpenAI-only and unchanged. On a live Copilot, saving or restoring a version that uses a keyless provider is refused.

### Admin AI Settings
Provider connections (connected / not connected, used by which channels, how to connect, console links), the active configuration per
channel, then a guided editor: provider → model (Anthropic models from the organization's Models API, friendly name + exact id, cached
10 min, *Refresh Anthropic models*; FloFi catalog fallback; controlled custom id) → only the parameters that model accepts → issues
explained before saving → *Test connection and model* (real request with the candidate's own provider and key, fixed harmless
transcript, FloFi validation, latency, tokens, estimated cost, technical diagnostics; rate-limited and audited) → change summary per
channel → *Save and activate* (next request, every instance, no redeploy). Reset and restore ask for confirmation.

### Usage and cost
AI Analytics folds the existing daily server-interpretation counters into requests, errors, measured tokens, mean latency and an estimated
cost per provider/model/surface (provider derived from the model id; no schema change; no double counting). Estimates use Anthropic list
prices checked 2026-11-03 (`MODEL_PRICES`). The page separates **measured** usage, **estimated** cost and **billing** (link to the
Anthropic console). FloFi never reads or displays a credit balance; the promotional grant (USD 100, expiring 2026-12-03 00:00 UTC) is
consumed through normal API billing and must be checked in the console. No OpenAI price is listed (none validated for this build).

## 4. Environment variables

| Variable | Where | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Vercel only** (the Next.js app: chat server action, channel webhooks, Admin). Production; Preview only if a Preview should call Anthropic | Server-side, never `NEXT_PUBLIC_*`. Not needed on Railway: the API/worker never import Copilot code. Independent of `OPENAI_API_KEY`. |
| `OPENAI_API_KEY`, `OPENAI_COPILOT_*` | Vercel (unchanged) | Optional when every channel is on Anthropic. |
| `FLOFI_COPILOT=live` | Vercel (unchanged) | Required for any live provider. |

`FLOFI_ADMIN_SESSION_SECRET` must also differ from `ANTHROPIC_API_KEY` (enforced).

## 5. Production activation (owner action; nothing happens on deploy)

1. In the Anthropic console create a dedicated API key in a workspace with a spend limit; do not enable auto-reload.
2. Add `ANTHROPIC_API_KEY` to the Vercel project (Production) and redeploy once. Existing traffic is unchanged: every channel keeps its
   current provider and model.
3. `/admin/ai-settings` → *Anthropic: Connected*, model list shown.
4. Open *Custom settings by channel* for one channel (e.g. FloFi chat), choose Anthropic and a model, *Test connection and model*.
5. *Save and activate*. To undo: *Restore* the previous version (or uncheck the custom settings and save).

## 6. Validation

See the PR description for the exact commands and counts of this run. Evidence levels:

* Unit/contract (mocked provider `fetch`, recorded Messages API shapes): request translation, structured-output schema, tool loop and
  echo, refusals/incomplete/malformed/invalid/unexpected answers, every error class, fixed endpoint/headers, discovery and caching, cost.
* PostgreSQL: settings save/rollback in the canonical stored form, refusal of keyless providers on live, probe through the Messages API,
  live channel routing to the provider each channel names with no redeploy; existing settings/rollout suites unchanged.
* Browser (loopback DB, injected sign-in wallet, no public network): every Admin page, grouped navigation, provider-aware editor, change
  summary, discard, 390 px layout, CSRF refusal, audit filter, Flight VIEWER privacy.
* **Not performed:** a real Anthropic API request. No Anthropic credential is available to this build and none was requested; the live
  probe must be run once by the owner after step 2 above. Mocked tests do not prove the live integration.

## 7. Known limits

* Telegram and WhatsApp share the `CHANNEL` surface in the daily metrics, so analytics splits web vs channels, not per messenger.
* Prompt caching is not used for Anthropic yet (it would make cost estimates depend on cache reads/writes the metrics do not record).
* Fable/Mythos-family models are catalogued; Fable requires 30-day data retention on the organization and may answer with refusals.
* The local PostgreSQL used for this run is 16; one pre-existing migration assertion is PostgreSQL 18-specific (CI uses 18.6).
