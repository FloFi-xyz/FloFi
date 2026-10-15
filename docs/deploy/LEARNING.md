# Copilot learning — deployment and operations (BUILD-CHAT-LEARNING-001)

What ships: private memory per verified identity (web wallets, Telegram/WhatsApp senders), the reviewed and evaluated global glossary, content-free
feedback, the Memory panel, channel `MEMORY` commands and `/admin/ai-learning`. Privacy model: [`docs/security/LEARNING-PRIVACY.md`](../security/LEARNING-PRIVACY.md).
Schema contract: [`SCHEMA-COMPATIBILITY.md` §7](SCHEMA-COMPATIBILITY.md#7-certificate-0013_copilot_learning).

Nothing here changes a financial action, a workflow, a network, a wallet requirement, an approval, an execution or the 0.1% workflow fee.

## 1. Two releases, in order

| | PR | Contents | Database |
| --- | --- | --- | --- |
| **Release A** | `claude/build-chat-learning-001-release-a` | the forward-compatibility certificate for the exact 0013 (fixture, tests, §7 assessment); no feature | stays at 0012 |
| **Release B** | `claude/build-chat-learning-001` (stacked on A) | migration `0013_copilot_learning` + the feature (off by default) | Railway pre-deploy applies 0013 |

**Never merge B before A is deployed everywhere.** B's Vercel build serving while the database is still at 0012 refuses platform state
(`SCHEMA_NOT_MIGRATED`) like every Release B before it; learning itself fails soft (unavailable), but MCP, Developer, Channels and Admin would
refuse too — hence the staged promotion below.

## 2. Rollout sequence (owner actions; nothing here is performed by the build)

1. **Merge Release A.** Railway `flofi-api` pre-deploy: `migrate.applied versions=none schema_version=12`; API/worker `*.starting schema_version=12`.
   Vercel builds and serves as before.
2. **Confirm Release A everywhere** (SCHEMA-COMPATIBILITY §7.1): Railway `flofi-api` and `flofi-worker` active deployments at or after the Release A
   merge commit (`railway deployment list --service … --json`); Vercel Production `https://flofi.xyz/api/flofi/readiness` → `deployment.commit`
   descends from it; every Preview that uses the production `DATABASE_URL` rebuilt (today `DATABASE_URL` targets production **and** preview, so
   every Preview built before Release A refuses after 0013 — rebuild them or accept that); operator CLIs from a Release A checkout. Soak.
3. **Prepare Release B without exposing it.** Rebase B on `main` (which then contains A); confirm `forward-compatibility.test.ts` passes (the
   shipped 0013 equals the certificate). Turn off Vercel *Auto-assign Custom Production Domains* (or plan `vercel deploy --prod --skip-domain`) so the
   merge builds a staged deployment; optionally pause `flofi-worker` auto-deploy so the new worker starts after the migration.
4. **Merge Release B.** Railway `flofi-api` pre-deploy applies 0013: `migrate.applied versions=13 schema_version=13` (≈ 20 ms; it locks no existing
   table). Release A processes keep serving with `forward_migrations=13_copilot_learning`. New API: `api.starting schema_version=13`; deploy the worker.
5. **Promote** the staged Vercel deployment (`vercel promote <url>`); re-enable auto-assignment / worker auto-deploy if desired.
6. **Validate with learning still off** (the default): `/readyz`, `/api/flofi/readiness` (`READY`, `schemaVersion: 13`); one owner run (Simulate →
   Review → wallet → reconciled); a Channels message → approval link; MCP OAuth and `/approve`; `/admin` loads and **AI Learning** shows
   "off (FLOFI_LEARNING not enabled)".
7. **Enable learning** on Vercel Production (§3), redeploy (environment variables apply on the next deployment), then §4.

## 3. Enabling

Vercel Production (and, if wanted, a Preview with its **own** database):

* `FLOFI_LEARNING=enabled`
* `FLOFI_LEARNING_SECRET=<openssl rand -hex 32>` — dedicated; never reuse another FloFi secret (refused); store it like other secrets. Rotating it
  detaches every saved memory (users would start over); do not rotate casually.
* optional `FLOFI_LEARNING_GLOBAL=disabled` to run with private memory only.

Prerequisites: `DATABASE_URL` platform state (already present for MCP/Developer/Channels/Admin) and the Copilot itself (`FLOFI_COPILOT=live` or
`replay`). Railway needs nothing. Before production use, complete the legal-basis decision and the RIPD/DPIA recommended in the privacy document.

## 4. Verification after enabling (no real-money action)

1. Web, anonymous: "whenever I say arb, I mean Arbitrum" → FloFi says it applies to this conversation only and asks to prove a wallet.
2. Web, after proving a test wallet: the same sentence → **Remember** → the Memory panel lists `arb → Arbitrum One`; reload; "Bridge 10 USDC from
   Base to Arb" → the proposal notes "“arb” read as Arbitrum One — your saved meaning" (do not apply or execute; it is a proposal).
3. Another wallet / browser: the same request is a clarification (no inheritance).
4. `/admin/ai-learning` (OPERATOR): "Load reviewed PT-BR/EN starter set" → approve e.g. `eth sepolia` → **Evaluate approved (dry run)** → **Evaluate and
   publish** → v1. Both wallets: "Swap 0.001 WETH to USDC on eth sepolia" → proposal with "— FloFi glossary v1".
5. Telegram (an allowlisted test account): the same memory sentence → tap **Remember**; `memory` lists it; `stop` erases it.
6. Memory panel → **Delete all memory** → confirm → nothing listed.

## 5. Operating levers (fastest first)

| Need | Lever | Effect |
| --- | --- | --- |
| A bad global entry | `/admin/ai-learning` → retract it (Retract) and **publish**, or **Re-evaluate and roll back** to an earlier version, or **Disable glossary** | next request of every instance (no cache) |
| Stop the global glossary without the console | `FLOFI_LEARNING_GLOBAL=disabled` + redeploy | private memory continues |
| Stop all learning | unset `FLOFI_LEARNING` + redeploy | no memory, glossary or feedback; the Copilot exactly as before; data kept |
| Retention now | `/admin/ai-learning` → Run retention now | bounded batches (otherwise every ~10 min per instance) |
| A user asks for deletion | the user: Memory → Delete all / `forget everything` / STOP. Support cannot look a wallet up in the console (aggregates only) | immediate |

Every console action is OPERATOR-only, CSRF-checked and recorded in `admin_audit_events` (`ADMIN_LEARNING_*`). A publication needs a passing
evaluation of the exact document; the database refuses anything else (`LEARNING_EVALUATION_REQUIRED`). At most 30 evaluations per 10 minutes.

## 6. Rollback

| Situation | Safe action |
| --- | --- |
| Before 0013 is applied | roll back freely (Release A or later). |
| 0013 applied, Release B misbehaves | unset `FLOFI_LEARNING` first; if needed roll the application back to Release A (serves on 0013; its pre-deploy succeeds with `versions=none`). |
| 0013 applied, a build older than Release A | **unsafe**: refuses the database on every cold start. |
| 0013 must be removed (last resort) | SCHEMA-COMPATIBILITY §7.3, with Release A serving everywhere; destroys all learning data. |

## 7. What is measured where

`/admin/ai-learning` (last 30 days): private memories (count, by wallet/chat), opted-in contributors, Copilot turns by scope, proposal /
clarification / refusal / failure rates, correction rate (revisions per proposal — observed, not ground truth), proposals applied / dismissed /
revised afterwards, glossary suggestions confirmed / overridden, learned meanings used, interpreter failures by code, candidates with pseudonymous
support, versions, every evaluation with its corpus, probe, regression and safety results.
