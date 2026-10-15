# BUILD-CHAT-LEARNING-001 — FloFi hybrid continuous learning: report

Plan: [BUILD-CHAT-LEARNING-001-PLAN.md](BUILD-CHAT-LEARNING-001-PLAN.md). Baseline `c46b563` (= `origin/main` on 2026-10-15; PR #96 and #97 included).
Owner authorization: implement, test, open PRs for review. Not done by this build: merge, deploy, production variables, production database,
real transactions, public model calls.

## 1. Delivery and merge order

| Order | Branch | PR | Contents |
| --- | --- | --- | --- |
| 1 | `claude/build-chat-learning-001-release-a` | Release A | certificate for the exact `0013_copilot_learning` (v12 build), fixture, §7 assessment, compatibility tests — no feature, no schema change |
| 2 | `claude/build-chat-learning-001` (stacked on 1) | Release B | migration 0013 + the feature (off by default) + docs |

Deploy Release A everywhere before merging Release B ([LEARNING.md §2](../deploy/LEARNING.md)). **Dependency:** PR #98 (FIX-CI-WEBHOOK-001, test-only)
was still **open** and `origin/main` unchanged at `c46b563` when this build was delivered, so it is **not** integrated here; the CircleCI
certification job of these PRs can still hit the `webhooks.pg.test.ts` race that #98 fixes. When #98 merges, rebase both branches on `main`.

## 2. What was built

**Pure engine (browser and Channel Core alike).**
* `domain/copilot-lexicon.ts`: validated terms, closed-vocabulary targets (network id, pinned token, operation), reserved canonical vocabulary
  (registry networks, tokens, protocols, commands, authority and instruction words), environment rules (test wording ⇔ test target), deterministic
  matching (longest first, whole words; a mainnet alias never before test wording or after a number), EN/PT-BR preference statements (remember,
  forget, forget everything, reply language).
* Grounding (`copilot-authoring.ts`): one lexicon-aware "named networks" function used by every planner, plus test wording from lexicon matches
  and private token terms. Session and saved meanings name networks/tokens; the global glossary names test networks only; numbers, addresses,
  slippage, ranges and fees are untouched.
* Conversation (`copilot-conversation.ts`): local memory statements and FloFi's offer (Remember / Not now), session aliases, typed memory actions
  performed by the caller only after the user's click, provenance notes on proposals, global mainnet suggestions offered first in FloFi's own
  question, content-free signals (correction, clarification answered, suggestion confirmed/rejected, repeated failure). Absent learning context
  ⇒ identical replies (the whole eval corpus is replayed to prove it).

**Interpreter.** `server/copilot-glossary.ts`: at most 8 entries matched in the open request, re-validated, rendered as quoted data in one extra
`developer` input item. Instructions, schema, `store: false`, limits unchanged; byte-identical request without it.

**Learning service** (`src/learning/*`): config (`FLOFI_LEARNING`, dedicated `FLOFI_LEARNING_SECRET`, `FLOFI_LEARNING_GLOBAL`), identity digests,
PostgreSQL store, fail-soft service, knowledge document, labeled PT-BR/EN corpus, deterministic evaluator (publication gate), web actions,
request glossary.

**Web.** `copilotInterpret` adds the glossary and records one content-free event; `app/learning-action.ts`; Memory panel (view, forget, pause,
contribute opt-in, delete all, identity choice between proven wallets, sign-in prompt); PT-BR copy; privacy page section.

**Channels.** Sender = own learning identity; `ChannelLearning` interface injected by the turn entry points (layering and model-free approval paths
preserved); offers as provider choices; `MEMORY`, `MEMORY OFF/ON` (EN/PT); STOP erases learning data; glossary on interpreter requests;
content-free feedback.

**Admin.** `/admin/ai-learning`: aggregates, candidates (pseudonymous support), approve/reject/retract/reopen, operator entries, reviewed starter
set, dry-run evaluation, evaluation-gated publication, rollback (re-evaluated), disable, retention; version and evaluation history.

**Schema.** `0013_copilot_learning`: seven new tables, their functions/triggers; nothing on any pre-existing relation; DB-enforced invariants
(candidate state machine, append-only evaluations and versions, gapless versions, **a version requires a passing evaluation of the exact
document's SHA-256**, immutable feedback events).

## 3. Validation

Local, loopback PostgreSQL 18.6 (CI image), no public network, no model, no real transaction.

| Gate | Result |
| --- | --- |
| `pnpm check` (Release B: typecheck, lint, build, schema drift, unit) | **passed** — 382 files, 4,332 tests (2 skipped, pre-existing) |
| `pnpm test:postgres` (Release B, full) | **passed** — 66 files, 419 tests (3 skipped: `schema-compatibility.pg.test.ts` skips by design in Release B) |
| Learning-specific suites inside those | lexicon 16, engine 21 (incl. the whole eval corpus replayed with learning on: identical replies), evaluation 8, glossary 4; PostgreSQL store/service 14, web path 5, admin AI Learning 6, Telegram learning 3 |
| Release A tree: cloud-runtime suites / backend `schema-compatibility.pg.test.ts` (runs for the new certificate) | 48 passed / 3 passed |
| Browser: `copilot-learning` (new) / `copilot` / `admin-console` (+ AI Learning) | 1 / 13 / 1 passed |
| governance-lite; self-tests; `git diff --check` | passed; 19 + 22 OK; clean |
| CircleCI Release A (#99) | certification (unit, PostgreSQL, offline compatibility + fork suite, full guarded browser suite, SBOM) and governance **passed** |
| CircleCI Release B (#100) | first run: governance passed; certification **failed** on `backend/admin-analytics.pg.test.ts`, which asserted 12 migrations (a stale "0012 is newest" literal this build missed locally). Fixed to follow the shipped manifest; the full local PostgreSQL run above includes the fix. See the PR for the re-run. |

**Not run locally:** fork suites, the full guarded browser phases and audit/SBOM for Release B (CircleCI certification runs them).

## 4. Acceptance (final criteria)

| Criterion | Evidence |
| --- | --- |
| User A establishes a persistent private language preference | engine (`copilot-learning.test.ts`), PostgreSQL (`learning.pg.test.ts`, `web-actions.pg.test.ts`), Telegram (`learning.pg.test.ts`), browser (`copilot-learning-memory.spec.ts`) |
| User B cannot read or inherit it | same suites: B's session, model request body and proposal carry nothing of A's; separate wallets, namespaces, channel senders, tenants |
| A verified and approved global improvement reaches both | admin API publishes only after a passing evaluation (`learning-http.pg.test.ts`); both users' sessions, requests and proposals carry it (`web-actions.pg.test.ts`, browser spec) |
| Ordinary interpretation, review and wallet authorization unchanged | the eval corpus replayed with learning on and nothing learned gives identical replies; Copilot/admin browser profiles pass; only Apply changes a workflow; no new signature path |

## 5. Limitations and risks (not claimed)

* **Production is not exercised**: no deployment, no live model, no production database. Effects of the glossary on a live model's classification
  (operation phrases, typos) are **not measured offline** — they are interpreter hints; the evaluator reports them as "hint only". Deterministic
  effects (test-network terms, user meanings, mainnet suggestions) are measured.
* **Legal basis** for both purposes is an open owner/counsel decision ([LEARNING-PRIVACY.md §5](../security/LEARNING-PRIVACY.md)); the existing
  privacy page names the Portuguese CNPD while Brazil is the primary market — review whether ANPD should be named (not changed here).
* WhatsApp uses the same Channel Core path as Telegram; only Telegram has an end-to-end learning test.
* A global meaning for a real-funds network only reorders FloFi's question; it never grounds the network (by design, safety first).
* Feedback outcomes are observed behaviour, not ground truth; client-reported events are bounded but can be inflated by a hostile client (they
  only affect aggregates).
* Rotating `FLOFI_LEARNING_SECRET` or `FLOFI_CHANNEL_SECRET` detaches existing memories (documented).
* Retention runs opportunistically (≤ every 10 min per instance) and from the console; there is no dedicated scheduler.
* `DATABASE_URL` targets Production **and** Preview today: Preview deployments built before Release A refuse platform state after 0013.
