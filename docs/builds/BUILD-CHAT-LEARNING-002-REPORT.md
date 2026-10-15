# BUILD-CHAT-LEARNING-002 — Invisible learning engine: report

Base: `main` at `4f377df` (BUILD-CHAT-LEARNING-001 merged; shipped schema 0013). Plan: [BUILD-CHAT-LEARNING-002-PLAN.md](BUILD-CHAT-LEARNING-002-PLAN.md).
Delivered as two stacked pull requests (the staged pattern of BUILD-DB-COMPAT-001 / BUILD-CHAT-LEARNING-001). Nothing merged, deployed or configured;
no production variable, database or real-money transaction touched.

| | Branch | Contents |
| --- | --- | --- |
| Release A | `claude/build-chat-learning-002-release-a` | forward-compatibility certificate for the exact 0014 (fixture, manifest, PostgreSQL compatibility tests, SCHEMA-COMPATIBILITY §8); no feature |
| Release B | `claude/build-chat-learning-002` (on A) | migration `0014_learning_automatic` + invisible learning; persistent automatic learning **off** by default |

## 1. What changed for users

* **The chat no longer teaches or asks.** The Copilot's Memory panel, the "Remember / Not now" offer and every invitation ("Tell the Copilot…",
  "Prove your wallet … and FloFi can remember it") are gone. A statement ("whenever I say arb, I mean Arbitrum") is acknowledged in one sentence.
* **FloFi adapts within the conversation** (`FLOFI_LEARNING=session` or `enabled`): after the user answers FloFi's question about a word it did not
  know, corrects a reading FloFi made on its own (in chat or on the canvas), or states a meaning, the rest of the conversation uses it, with a visible
  provenance note on every proposal. Nothing is stored for this.
* **Persistent individual memory** (`FLOFI_LEARNING_AUTOMATIC=consent | legitimate_interest`, default off): repeated, dominant evidence in the user's
  own interactions becomes a learned meaning for that verified identity only (EVM wallet, Solana wallet, Telegram or WhatsApp account — never merged),
  used in later sessions. Inferred meanings never select a real-funds network or a token: FloFi offers them first in its own question.
* **Privacy controls outside the chat:** Settings → *Privacy & memory* (`/app/privacy`, shown when the deployment keeps learning data): what is kept
  and how each meaning came to be, observed-but-unused evidence, the automatic-learning switch (opt-in under consent, opt-out under legitimate
  interest; off erases what was learned), pause, contribution opt-in, forget one, delete everything, download a copy. Channels keep `MEMORY`,
  `memory on/off` (now also the automatic-learning choice), `forget …`, `STOP`.
* The public privacy notice (`/privacy`, EN/PT) describes the three tiers, both bases, the controls and retention.

## 2. Design

* **Signals** (`domain/copilot-adaptation.ts`, pure, deterministic): reading provenance per proposal field (named, asked, stated, inferred, carried,
  model); lexical affinity (prefix / abbreviation with test wording / small typo) picks the one word a user meant; correction vs objective-change cues
  in EN/PT; only values FloFi read on its own can be corrected; canvas corrections need exactly one changed field; financial changes, removals,
  layout moves, dismissals and failed executions are never evidence (content-free reason codes instead).
* **Engine** (`domain/copilot-conversation.ts`): `ADAPTED` (in-conversation) and `LEARNED` (persistent) lexicon sources with the conservative
  grounding rule; withdrawn (word, meaning) pairs; observations only when T2 is permitted; `proposalApplied` / `observeWorkflow` entry points for
  the browser hook; a learned starting language that never overrides the user's words.
* **Persistent tier** (`learning/automatic.ts`, `learning/store.ts`, `learning/service.ts`, 0014): permission per basis and the identity's choice
  (re-checked on the server); requests counted once via keyed digests of a random conversation id; promotion: stated at once, otherwise weight ≥ 2 from
  distinct requests, ≥ 2× and ≥ 2 more than every other meaning of the word combined; a correction demotes a learned meaning; stated and remembered
  meanings are never replaced by inference; bounded rows; cascade erasure; retention; operator purge by basis.
* **Collective tier:** a learned meaning of an opted-in contributor becomes a pseudonymous pending candidate; the console lists contributed candidates
  individually only at ≥ 3 distinct contributors; approval, deterministic evaluation, versioned publication and rollback are unchanged. No model
  training, no prompt change from user data.
* **Admin** (`/admin/ai-learning`): *Invisible learning* — effectiveness, false positives, corrections by source, ignored signals by reason, persistent
  outcomes, choices by basis, evidence counts; *Erase automatic-learning data the current basis does not cover*.
* **Safety retained:** reserved vocabulary extended with financial-parameter words (EN/PT); the evaluation's safety invariant now forbids any inferred
  or global meaning from grounding real funds; execution authority, approvals, wallet authentication, workflow creation, automations, network support
  and the 0.1% fee untouched.

## 3. Schema and rollout

`0014_learning_automatic` (3,642 bytes, SHA-256 `624884d9…`): `learning_automatic_settings`, `learning_evidence`, foreign keys to `learning_subjects`
(`ON DELETE CASCADE`). Measured 12.0–12.6 ms; during it only learning-subject writes of v13 processes wait. Rollout, flags, verification, levers and
rollback: [LEARNING.md](../deploy/LEARNING.md); certificate: [SCHEMA-COMPATIBILITY.md §8](../deploy/SCHEMA-COMPATIBILITY.md#8-certificate-0014_learning_automatic).

## 4. Owner and counsel decisions still open

See [LEARNING-PRIVACY.md §6](../security/LEARNING-PRIVACY.md#6-legal-basis-and-compliance--decisions-required-owner--counsel): the T2 basis (consent vs
legitimate interest + LIA), approval of the notice wording and controller identity, statistics basis, international transfer, RIPD/DPIA, children,
the status of BUILD-CHAT-LEARNING-001's v1 consents, and the procedure for changing basis later. Until decided, keep `FLOFI_LEARNING_AUTOMATIC` unset;
`FLOFI_LEARNING=session` (T1) can be enabled independently.

## 5. Validation

All local, offline (no model, no public provider, no transaction): PostgreSQL 18.6 on loopback (CI-pinned image), replay answers, injected sign-in
wallet, MOCKED harnesses.

| Gate | Result |
| --- | --- |
| Release B `pnpm check` (typecheck, lint, build, schema drift, unit) | **pass** — 4,392 tests passed, 2 skipped (as on `main`) |
| Release B `pnpm test:postgres` (full) | **pass** — 442 passed, 3 skipped (69 files; the cross-build suite skips by design once 0014 ships) |
| New: `copilot-adaptation.test.ts` (signal rules, PT-BR/EN) | 43 / 43 |
| `copilot-learning.test.ts` (engine: no offer, adaptation, corrections, objective change, canvas, confirmation, learned/stated precedence, values never learned, permission, language hint) | 32 / 32 |
| New: `automatic.test.ts` (permission per basis, promotion, conflicts, reserved financial words) | 4 / 4 |
| Learning evaluation (corpus v2 with PT-BR/EN adaptation cases; safety invariant: no inferred or global meaning grounds real funds) | 8 / 8; every case passes with no glossary and with the starter set |
| New: `automatic.pg.test.ts` (consent/objection per basis, repeated evidence, retrieval across sessions, conflicts, demotion, isolation by wallet/channel/tenant, closed values, bounds, forget/erase incl. a v13 plain DELETE, retention, purge by basis, fail-soft without 0014) | 14 / 14 |
| Web / admin / Telegram / WhatsApp learning PostgreSQL suites (updated for the invisible flow, consent / legitimate interest / off) | 30 / 30 |
| Release A: `forward-compatibility.test.ts` + `.pg.test.ts` | 24 / 24 |
| Release A: `backend/schema-compatibility.pg.test.ts` (real `main.ts` / CLI cold starts, API/worker, Vercel paths on v14) | 3 / 3 |
| Guarded browser profiles, as defined in `scripts/guarded-release-browser.mjs` | `copilot-learning` (rewritten acceptance) 1/1, `copilot` 13/13, `copilot-solana` 3/3, `chat-automations` 8/8, `admin-console` 1/1, `default-product` 85/85, `review-execute-recovery-components` 39/39 |
| governance-lite + unittests, `git diff --check` (both releases) | pass |

Not run locally: the other guarded browser profiles and the composition/fork phases (unaffected code paths; CircleCI certification runs them all).
The browser acceptance covers: no Memory panel or teaching prompt; in-conversation adaptation with nothing stored; Settings → Privacy & memory;
consent recorded with basis and notice v2; one observation is not enough, *Apply* confirms and the meaning is learned; a later session uses it,
labelled; another wallet is asked; a published glossary entry reaches both; the exact grammar unchanged; opt-out erases what was learned; delete
everything; no transaction request.

## 6. Known limits

* Grounding lets FloFi infer only test networks on its own, so most learnable evidence is *answers to FloFi's questions* and *applied proposals*;
  canvas corrections arise only where the canvas can change exactly one network/token of an applied step FloFi read on its own (covered by unit and
  engine tests; the Copilot-authorable Aave networks have no learnable test-network word, so the engine canvas test injects one inferred reading).
* Tokens learned automatically are interpreter hints only (only stated meanings ground a token); operation words are hints only.
* Confirmations from *Apply* exist on the web; channels have no canvas or Apply, so they learn from answers, corrections and statements.
* The learned starting language only affects FloFi's first words of a conversation.
