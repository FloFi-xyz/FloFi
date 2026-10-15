# BUILD-CHAT-LEARNING-001 — FloFi hybrid continuous learning: plan

Baseline: branch `claude/build-chat-learning-001` at `c46b563` (= `origin/main` after fetch on 2026-10-15; includes PR #96 BUILD-DB-COMPAT-001
and PR #97 BUILD-ADMIN-001). Shipped schema: `0012_admin_control_plane`. PR #98 (FIX-CI-WEBHOOK-001, test-only) is open and not on `main`.
Owner authorization: implement, test, open PRs for review. No merge, deploy, production variable, production database or real transaction.

## 1. Preflight findings (current `main`)

| Area | Finding | Consequence |
| --- | --- | --- |
| Interpretation boundary | One model call per turn (`server/copilot-service.ts` `interpretCopilotV2`): strict JSON schema, no tools, `store: false`, closed failure codes. The intent is untrusted data. | Learning adds data to that one request (a bounded, code-rendered glossary message) and nothing else. Instructions and schema are unchanged. |
| Grounding | `domain/copilot-authoring.ts`: every amount, slippage, range and address must appear in the user's own words; mainnets must be **named** (`mentionedNetworks`, registry `mention` regexes) with no test-network wording; values carried by FloFi have deterministic provenance (`Grounding.carried`). "Arb" alone is not a registry mention. | Learned aliases enter grounding at exactly one place — which networks/tokens the user *named* — with provenance notes on the proposal. They never ground a number, an address, a slippage or a range. |
| Conversation engine | `domain/copilot-conversation.ts` is pure (enforced by `copilot-eval.test.ts`): local turns (secrets, yes/no, FloFi's own buttons) and model turns; one Command at most, applied only by the user's click. Runs in the browser (web) and in Channel Core (server). | Preference statements ("whenever I say Arb I mean Arbitrum") are parsed deterministically and locally, before any model call; the engine only *describes* a memory action, the caller performs it. |
| Web identity | Sealed HMAC cookies: SIWE (`flofi_wallet_session`) and SIWS (`flofi_solana_session`), read only on the server (`server/session-principal.ts`). The browser never sends an address the server trusts. | Durable memory binds to the server-verified session principal (namespace + address), pseudonymized with a keyed digest. EVM and Solana are separate subjects; never merged. Anonymous = session-only aliases. |
| Channel identity | Sender = provider-authenticated id (webhook secret / signature), stored only as `HMAC(FLOFI_CHANNEL_SECRET-derived key, channel:business:user)` (`channel_conversations.subject_digest`); conversations are erased after 7 idle days; state after 30 min. | Channel learning subject = keyed digest over (channel, business, sender digest): a Telegram sender is never linked to a wallet or to a WhatsApp number. |
| Admin | `/admin` (BUILD-ADMIN-001): sealed admin sessions, VIEWER/OPERATOR, POST + JSON + Origin + CSRF token, append-only `admin_audit_events`, versioned settings pattern. | AI Learning reuses `adminPage`, `adminMutation`, `store.audit`; no new auth or settings framework. |
| Rate limits | `platform/fixed-window.ts` over `mcp_rate_limits` (0005), shared by every surface. | Learning anti-abuse uses it with `learning:*` buckets; learning's own retention purges those buckets. |
| Evaluation | `domain/copilot-eval.corpus.ts` (150+ cases, scripted model answers, real engine) + absolute safety invariants in `copilot-eval.test.ts`. | Extended with a learning corpus (PT-BR/EN, ambiguity, adversarial, corrections); a production evaluator runs the same engine as the publication gate. |
| Schema compatibility | `SCHEMA-COMPATIBILITY.md` (BUILD-DB-COMPAT-001): a newer migration is served by an older build only under its certificate; certificates are written one release ahead (Release A). | Migration `0013_copilot_learning` ships in Release B; Release A certifies its exact bytes for the v12 build. |
| pgvector | Not installed anywhere; no measured need (aliases are exact terms, retrieval is a bounded exact match). | No vector retrieval in this build. |

## 2. Data protection model (LGPD first, GDPR compatible)

- **Two separately controlled purposes.** (1) *Private memory*: off until the user explicitly confirms a "Remember" offer (the click is
  recorded with the notice version); pausable; every entry viewable and deletable; "Delete all" erases the subject row and every entry.
  (2) *Contribution to global improvement*: a separate opt-in (default off); contributes only a generalized `term → target` pair, under a
  pseudonymous contributor digest, never text, never an identity; erased with "Delete all".
- **Minimization.** No raw transcript is stored. Memory entries are a short validated term plus a closed-vocabulary target
  (`network:ARBITRUM`, `asset:USDC`, `operation:BRIDGE`) or a language. Feedback events are content-free (kind, outcome, scope, language,
  counts, knowledge version) and carry no subject. No wallet address is stored by learning: subjects are keyed digests
  (`FLOFI_LEARNING_SECRET`).
- **Never stored:** secrets (refused before parsing, as today), amounts, addresses, slippage, balances, transaction data.
- **No repurposing.** Nothing reads existing conversations, runs or channel records; learning starts from new explicit statements.
- **Retention.** Content-free events 90 days; pending candidates' contributor rows 180 days or until decided; a memory unused for 365 days
  expires; a subject without memory or consent is deleted after 30 idle days; any subject after 24 idle months. Purges are bounded batches.
- **Legal basis** is documented as an open owner/counsel decision (consent proposed for both purposes), not assumed.

## 3. Architecture

```
browser chat ──startTurn──► engine (pure) ──REMOTE──► copilotInterpret (server action)
   ▲  lexicon (session aliases + own private entries + active global version)        │ verified session → subject digest
   │                                                                                 ├─ private entries + global version (PostgreSQL)
   └── finishTurn ◄── untrusted intent ◄── model (store:false, schema) ◄── glossary (≤ 8 matched entries, code-rendered data)
                    grounding: aliases name networks/tokens with provenance notes; numbers/addresses still only from the user's words
```

1. **Pure lexicon (`domain/copilot-lexicon.ts`).** Term normalization; entry validation (closed targets; reserved canonical vocabulary;
   environment rules: a test-network target needs test wording in the term, a mainnet target must have none; instruction-like words
   refused); deterministic matching (longest first, word boundaries, a mainnet alias never matches before test wording or after a number);
   preference statement parser (EN/PT: remember / forget / reply language).
2. **Engine + grounding.** `Grounding.lexicon`; `mentionedNetworks` → lexicon-aware naming used by every planner: session and private
   entries name networks/tokens (the user's own declared meaning); global entries name **test** networks only; a global entry for a mainnet
   only ranks that option first in FloFi's clarification. Each use adds a provenance note ("“arb” read as Arbitrum One — your saved
   meaning"). Memory offers are FloFi's own question with deterministic buttons; replies carry a typed memory action.
3. **Model glossary (`server/copilot-service.ts`).** Optional `developer` input item rendered from validated entries matched in the open
   request; bounded; quoted terms; enum targets; states it is data and never a value source. No change to instructions, schema, `store`.
4. **Learning service (`src/learning/*`).** Config (`FLOFI_LEARNING=enabled` + dedicated `FLOFI_LEARNING_SECRET`), identity → subject
   digest, PostgreSQL store, retrieval, knowledge document validation, deterministic evaluation, retention. Fail-soft: any learning
   failure means "no learning" and the Copilot behaves exactly as before.
5. **Web.** `copilotInterpret` adds the glossary and records a content-free event; `app/learning-action.ts` (status, remember, forget,
   language, pause/resume, contribute opt-in, delete all, feedback). A Memory panel in the Copilot (view/delete/pause/opt-in), PT/EN.
6. **Channels.** Same engine; the service loads the sender's learning context; memory offers become provider choices; `memory` /
   `memória`, `forget all` / `esquecer tudo` commands; STOP also erases the sender's learning data. Budgets, encryption, erasure,
   idempotency and delivery unchanged.
7. **Admin AI Learning.** Aggregates only (counts, rates, top generalized candidates), candidate review (approve/reject/retract),
   publication gated by the deterministic evaluation (zero safety violations, zero regressions, generated probes pass), version history with
   evaluation results, rollback (re-evaluated) and disable (null version). OPERATOR + CSRF + audit for every change.

## 4. Global knowledge promotion workflow

`PENDING` (contribution or operator entry; validated on entry) → `APPROVED` | `REJECTED` (human decision, audited; `APPROVED` → `REJECTED` =
retraction) → **publish**: proposed document = active entries + approved − retracted → deterministic evaluation against the active
version and the empty baseline (static corpus + probes generated per new entry) → stored evaluation row → only a passing evaluation
appends version *n+1* (append-only, gapless). **Rollback** appends a version restoring an older document after re-evaluation; **disable**
appends a NULL document (no global knowledge). Repetition never promotes: support counts distinct pseudonymous contributors and is only
shown to the reviewer.

## 5. Schema and rollout

- `0013_copilot_learning`: new tables only (`learning_subjects`, `learning_memories`, `learning_feedback_events`, `learning_candidates`,
  `learning_candidate_support`, `learning_knowledge_versions`, `learning_evaluations`) and their own functions/triggers; no foreign key,
  trigger, index or constraint on any pre-existing relation (no lock on existing tables); `SET LOCAL lock_timeout`.
- **PR A — Release A:** certificate `{ base: 12 admin_control_plane, migrations: [13 copilot_learning <sha256>] }`, the SQL as a pinned
  fixture, `SCHEMA-COMPATIBILITY.md` §7 assessment, compatibility tests (catalog diff, lock list, runners, reversal). No feature code.
- **PR B — Release B (stacked on A):** the migration, the feature, docs. Merge order: A, deploy A everywhere, then B.
- Learning is **off by default**; enabling it is an environment change on Vercel only (`FLOFI_LEARNING`, `FLOFI_LEARNING_SECRET`).

## 6. Validation plan

Focused unit suites (lexicon, engine, grounding, glossary, evaluation, channels conversation, admin view), PostgreSQL suites (store isolation,
erasure, caps, rate limits, retention, append-only/gapless, admin HTTP with roles/CSRF/audit, channel isolation, migration catalog diff and
compatibility), the extended eval corpus, a replay-mode browser spec for the memory panel, then `pnpm check`, `pnpm test:postgres`,
governance-lite and its unittests, relevant guarded browser profiles. No public model or real-money call.
