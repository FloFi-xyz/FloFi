# BUILD-CHAT-LEARNING-002 — Invisible learning engine: plan

Baseline: `main` at `4f377df` (BUILD-CHAT-LEARNING-001 Release A #99 and Release B #100 merged; shipped schema `0013_copilot_learning`).
Owner authorization: implement, test, open PRs for review. No merge, deploy, production variable, production database or real-money transaction.

## 1. Preflight findings

| Area | Finding (on `4f377df`) | Consequence for this build |
| --- | --- | --- |
| Explicit learning UX | `components/copilot-memory.tsx` (Memory panel in the Copilot), "Remember / Not now" offers in replies, copy inviting users to teach FloFi ("Nothing saved yet. Tell the Copilot…", "Prove your wallet … and FloFi can remember it"). | Removed from the chat. Privacy controls move to a page outside the chat. |
| Grounding (`copilot-authoring.ts`) | A network or token the user did not **name** is never proposed: FloFi asks (`whichNetwork`, `realFundsWhichNetwork`, `tokenNotFound`). "arb", "arb sep", "eth sepolia", "base sep", typos are not registry mentions. | The model cannot silently misread a network or token. The reliable natural signals are therefore: the user's **answer to FloFi's own question** for a word FloFi did not know; a **correction of a reading FloFi made on its own** (learned / adapted / glossary vocabulary, or the model's choice of operation); a proposal FloFi read on its own that the user **applied unchanged**; and explicit statements. |
| Conversation engine | Pure; keeps transcript, open request (`segment`), referents (proposals shown), session aliases; one Command at most, applied by the user. Runs in the browser and in Channel Core. | Signal detection is a pure, deterministic module beside it (`copilot-adaptation.ts`); in-session adaptation is conversation state; nothing new reaches the model except validated glossary lines. |
| Canvas | Every canvas edit is a new immutable IR (`workflow-store.tsx`); applied Copilot proposals are recorded referents with their step. Layout moves do not change the IR. | A canvas edit of an applied Copilot step is compared field by field with the step FloFi proposed; only a change of exactly the network/token field FloFi read on its own counts. |
| Learning service / 0013 | Subjects are keyed digests per verified identity (EVM, Solana, channel sender — never merged); private memory needs explicit consent (`memory_enabled`, `memory_consent_at`, notice v1); global glossary is candidate → operator approval → deterministic evaluation → append-only version. | Reused as is. Persistent automatic learning needs two things 0013 cannot express without misusing its columns: repeated-evidence counting per identity and a per-identity choice recorded with its **legal basis** (consent vs legitimate interest / objection). |
| Schema compatibility | Certificates one release ahead (Release A), migration with the feature (Release B). | New additive migration `0014_learning_automatic` (two tables, FK to `learning_subjects` with `ON DELETE CASCADE` so every erasure path — including a v13 process — also erases them). Release A certifies its exact bytes for the v13 build. |
| Admin | `/admin/ai-learning`: aggregates, candidate review, evaluated publication, rollback, retention. | Extended with automatic-learning metrics and a k-anonymity threshold for contributed candidates; no user-facing administration. |

## 2. Three separated tiers (each with its own switch)

| Tier | What | Storage | Switch | Proposed legal basis |
| --- | --- | --- | --- | --- |
| **1. In-session adaptation** | Corrections, answers to FloFi's questions and statements adapt the rest of *this* conversation | Conversation state only (browser memory; channel state is already encrypted and erased after 30 minutes) | `FLOFI_LEARNING=session` (adaptation only, no database) or `enabled` | Performance of the service the user is requesting (LGPD art. 7 V; GDPR art. 6(1)(b)); no new storage |
| **2. Persistent individual memory** | Repeated, high-confidence evidence becomes a learned meaning for that verified identity only | `learning_evidence`, `learning_automatic_settings` (0014) + `learning_memories` (0013) | `FLOFI_LEARNING_AUTOMATIC=off` (default) \| `consent` \| `legitimate_interest`, plus the user's own choice in Privacy settings | **Pending owner/counsel decision.** `consent` = opt-in; `legitimate_interest` = opt-out with notice and LIA. Default off: nothing is collected persistently |
| **3. Aggregated / global** | Opted-in contributors' promoted meanings become pending candidates; operators review, evaluate, publish (versioned, reversible) | 0013 candidate tables | existing contribution opt-in + `FLOFI_LEARNING_GLOBAL` | Separate consent (unchanged); candidates below 3 distinct contributors are not shown individually |

## 3. Signal rules (deterministic, explainable, bounded)

* **Reading provenance** is computed for every proposal field (network, source/destination, token, operation): `NAMED` (the user's own canonical words), `ASKED` (named in the answer to FloFi's question), `STATED` (the user's declared meaning), `INFERRED` (an adapted/learned/glossary term FloFi applied on its own; the model's operation choice), `CARRIED`.
* **CLARIFIED** — FloFi asked for a network/token; the answer named it; exactly one word group of the original request has *lexical affinity* with it (prefix, abbreviation with test wording, small edit distance) and is a valid lexicon entry → adapted for the conversation; one observation.
* **CORRECTED / CONTRADICTED** — only a value FloFi read **on its own** (`INFERRED`) can be corrected: in chat with a correction cue ("no, I meant…", "não, eu quis dizer…"), or on the canvas by changing exactly that field of the applied step. The inferred meaning is suppressed (and removed if persisted); the new meaning is learned only if the same word has affinity with it. Values the user named or chose, mixed edits (amount, slippage, address, range…), objective-change cues ("actually, let's…", "mudei de ideia"), removals, layout moves, dismissals and failed executions are ignored (content-free reason codes).
* **CONFIRMED** — a proposal that used an inferred reading was applied without changing that field.
* **STATED** — explicit statements (unchanged parser) adapt the conversation; persisted only when tier 2 is permitted.
* **Promotion** (tier 2): a stated meaning at once; otherwise weight ≥ 2 from ≥ 2 distinct requests and at least twice any competing meaning of the same word; conflicting evidence never promotes. A correction of a learned meaning removes it. Language: ≥ 3 distinct conversations, 3× dominance, used only as a start-language hint.
* **Safety**: an inferred meaning (adapted, learned or global) never selects a real-funds network or a token — it is offered first in FloFi's own question; it grounds test networks and is otherwise interpreter context. Nothing learned ever supplies an amount, address, recipient, slippage, range, balance, signature or decision. Learning failures never block a turn (fail-soft).

## 4. Implementation outline

1. `0014_learning_automatic.sql`; store (evidence, settings, provenance on read, cascade-safe purge); service `observe()` + pure promotion rules; config (`session` mode, `FLOFI_LEARNING_AUTOMATIC`, notice v2).
2. Engine: lexicon sources `ADAPTED`/`LEARNED`; `copilot-adaptation.ts` (affinity, cues, readings, canvas diff); conversation integration (adapted aliases, suppression, observations, content-free events); statements without Remember offers.
3. Web: Memory panel removed; hook reports observations (only when tier 2 is permitted), tracks applied proposals and canvas edits; `/app/privacy` page (Settings → Privacy & memory) (view, provenance, pending evidence, automatic switch per basis, pause, contribution, delete one/all, download) linked from Settings and the privacy notice.
4. Channels: same engine; offers removed; `MEMORY` commands kept as the channel's privacy controls; observations applied server-side.
5. Admin: automatic-learning metrics (effectiveness, false positives, corrections by source, ignored reasons, promotions/demotions/conflicts, opt-ins/objections by basis), contributor k-threshold, purge of automatic data not covered by the current basis.
6. Evaluation corpus: PT-BR/EN adaptation cases; safety invariant tightened to "only the user's own stated meaning may name a mainnet".
7. Docs: privacy notice (EN/PT), `LEARNING-PRIVACY.md` v2 (tiers, retention, deletion, legal decisions), `LEARNING.md` (rollout, flags, rollback), `SCHEMA-COMPATIBILITY.md` §8, report.

## 5. Delivery

* **Release A** `claude/build-chat-learning-002-release-a` (from `main`): certificate for the exact 0014 (fixture, manifest, compatibility tests, §8). No feature.
* **Release B** `claude/build-chat-learning-002` (stacked on A): migration 0014 + feature, everything off by default.
* Validation: focused unit and PostgreSQL suites, `pnpm check`, full `pnpm test:postgres`, governance-lite + unittests, `git diff --check`, the learning browser profile and the affected guarded profiles.
