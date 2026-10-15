# Copilot learning — privacy, identity boundaries and data protection (BUILD-CHAT-LEARNING-001, -002)

Scope: how FloFi's Copilot learns — in a conversation, for one verified identity, and for everyone — on the web chat, Telegram and WhatsApp. Brazil is
the primary market: this is written against the **LGPD** (Lei 13.709/2018) first and kept compatible with the **GDPR**. It describes what the code
does. The legal basis of each stored purpose is an **open decision for the owner and counsel** (§6); the code ships every stored purpose **off** and
lets the owner select the basis once decided — it does not assume one.

BUILD-CHAT-LEARNING-002 removed the explicit learning UX from the chat (the Memory panel, the "Remember / Not now" offer and every prompt inviting
users to teach FloFi). Learning now comes from natural interaction, under the three separately switched tiers below. Privacy controls moved
outside the chat: Settings → **Privacy & memory** (`/app/privacy`) on the web; `MEMORY` commands on channels (the only surface a chat account has).

## 1. Three tiers, separately switched

| Tier | What | Where it lives | Switch | Proposed basis (§6) |
| --- | --- | --- | --- | --- |
| **T1 In-session adaptation** | The rest of a conversation uses what the user said or chose in it: a stated meaning ("whenever I say arb…"), the answer to FloFi's question about a word it did not know, a correction of a reading FloFi made on its own | the conversation state only: browser memory (web), the encrypted channel state erased after 30 idle minutes (channels) — **nothing new is stored** | `FLOFI_LEARNING=session` (adaptation only) or `enabled` | performance of the service requested (LGPD art. 7 V; GDPR art. 6(1)(b)) |
| **T2 Persistent individual memory** | After repeated, high-confidence evidence in the user's own interactions, a word's meaning (and the language they usually write in) is kept for that verified identity and used in later sessions | `learning_evidence`, `learning_automatic_settings` (0014), `learning_memories`, `learning_subjects` (0013) | `FLOFI_LEARNING=enabled` **and** `FLOFI_LEARNING_AUTOMATIC=consent \| legitimate_interest` (default `off`) **and** the identity's own choice | **pending**: consent (opt-in) or legitimate interest (opt-out) |
| **T3 Aggregated / global** | Opted-in contributors' learned meanings become pending candidates; operators review, evaluate, publish versioned, reversible glossary versions | 0013 candidate, support, evaluation and version tables | the separate contribution opt-in (default off) + operator action; `FLOFI_LEARNING_GLOBAL` break-glass | separate consent (unchanged from BUILD-CHAT-LEARNING-001) |
| Content-free statistics | which signal was classified or why it was ignored, inferred readings used/confirmed/corrected, what T2 did with an observation — closed codes and counts | `learning_feedback_events` (no subject, no text, no word) | with `FLOFI_LEARNING=enabled` | anonymised data (art. 12) or legitimate interest — §6 |

Meanings a user saved with BUILD-CHAT-LEARNING-001's "Remember" (consent recorded with notice v1) are **preserved and keep their purpose**: they are
still used while their memory is on, still listed, still deletable. They are never relabelled as learned, never erased by turning automatic
learning off, and never repurposed: automatic learning needs its own consent under notice v2 (or the legitimate-interest basis with notice).

## 2. Which interactions are evidence (deterministic)

Grounding never lets the interpreter choose a real-funds network or a token the user did not name — FloFi asks instead
(`domain/copilot-authoring.ts`). So the reliable signals are few and explicit (`domain/copilot-adaptation.ts`):

| Signal | When | Effect |
| --- | --- | --- |
| **Clarified** | FloFi asked for a network/token the request left unresolved; the answer named one; exactly one word group of the request has *lexical affinity* with it (prefix "arb" of Arbitrum, abbreviation with test wording "arb sep", small typo "solona") and is a valid entry | T1: the word means it for the conversation. T2: one observation |
| **Corrected / contradicted** | Only a value FloFi read **on its own** (an adapted, learned or glossary term; the interpreter's unprompted test network or operation) — in chat with a correction cue ("no, I meant…", "não, eu quis dizer…"), or on the canvas by changing exactly that one field of the applied step | the inferred meaning is withdrawn (T1), removed if learned (T2); the word is learned for the new value only if it has affinity with it |
| **Confirmed** | A proposal FloFi read on its own was applied with that field unchanged | T2: one observation |
| **Stated** | An explicit statement (EN/PT parser of BUILD-CHAT-LEARNING-001) | T1 at once; T2 at once (the user's own declared meaning) |
| **Language** | A message unmistakably in one language (function words) on which the interpreter agrees, once per conversation | T2 evidence for the *starting* language only |

**Never evidence** (content-free reason code only): a value the user named or chose themselves (changing it is changing their objective), an
objective-change cue ("actually, let's…", "mudei de ideia", "em vez disso"), several fields changed at once on the canvas, any edit that also changes
an amount, slippage, address, range, fee or routing, a removed step, a layout move, a dismissed proposal, a failed or unsuccessful execution.

**Promotion (T2, `learning/automatic.ts`)**: a stated meaning is kept at once (the latest statement for a word replaces any other). Otherwise a
meaning needs a weight ≥ 2 (each clarification, correction or confirmation counts 1, each from a different request — the server counts a request once
using keyed digests of a random conversation id and the request's ordinal), at least twice the combined weight of every other meaning observed for the
word and at least 2 more. Conflicts never learn. A correction of a learned meaning removes it at once; a stated or remembered meaning is never
replaced by inference. Bounds: 4 meanings per word, 128 evidence rows and 64 meanings per identity.

## 3. What is never stored or derived

* Message text, transcripts, model prompts or responses (channel retention unchanged: encrypted transient payloads, 30-minute state).
* Secrets: refused **before** any learning parser runs (`looksSecret`).
* Financial values or decisions: amounts, addresses, recipients, slippage, ranges, fees, balances, signatures, transaction authorizations,
  investment decisions. An observation is one validated short word and one closed-vocabulary target (network id, pinned token, operation, or
  `language:EN|PT`); words naming a financial parameter ("slippage", "valor", "endereço"…) are reserved and can never be learned. The database
  enforces the closed vocabulary with `CHECK` constraints.
* Wallet addresses or channel sender ids: a subject is `HMAC(FLOFI_LEARNING_SECRET-derived key, principal)`; request/conversation digests use a
  third derived key over a random id, so the database cannot link evidence to a person or a conversation.
* Previously collected data: nothing reads existing conversations, runs, channel records or analytics; existing BUILD-CHAT-LEARNING-001 memories
  are not converted into evidence.

## 4. Identity boundaries (unchanged)

| Principal | Established by | Learning subject |
| --- | --- | --- |
| EVM wallet (web) | SIWE signature → sealed HttpOnly `flofi_wallet_session` cookie | `wallet:eip155:<address>` |
| Solana wallet (web) | SIWS signature → sealed HttpOnly `flofi_solana_session` cookie | `wallet:solana:<address>` |
| Telegram sender | Bot API webhook secret, keyed sender digest | `channel:TELEGRAM:<bot>:<sender digest>` |
| WhatsApp sender | Meta webhook signature, keyed sender digest | `channel:WHATSAPP:<phone number id>:<sender digest>` |
| Anonymous web visitor | none | none — T1 only |

Different wallets, the EVM and Solana wallets of one browser, a wallet and a chat account, two chat accounts — never the same person. The browser can
only choose *which* of its proven wallets a request concerns, never name an address; the server re-checks every observation's permission. Tenants are
isolated in every query (proven by the PostgreSQL suites).

## 5. Safety of learned language

* Only what the user **stated** (in the conversation, or saved) may select a real-funds network or a token. Whatever FloFi **inferred** (adapted in
  the conversation, learned for the identity) or reviewed globally grounds test networks only; for real funds it is offered first in FloFi's own
  question, with a note ("You used “arb” for Arbitrum One before… choose it only if that is what you mean"); for tokens and operations it is
  interpreter context only.
* Learned preferences never override the current request: the user's own words and this conversation's statements take precedence over saved and
  learned meanings, which take precedence over the glossary; a mainnet meaning never applies next to test-network wording; nothing learned supplies a
  value. Every use is a visible note on the proposal, which still needs Apply, a fresh simulation, the Strategy Manifest review and the wallet
  signature. No execution authority, approval, network support, wallet authentication, workflow creation, automation or the 0.1% fee changed.
* The interpreter receives at most 8 matched entries as quoted data, labelled by source; instructions, schema, `store: false` unchanged. Model
  weights are never trained; prompts are never changed by user data; the global glossary changes only by operator approval and a passing evaluation.
* Learning failures never block a turn: every learning path is fail-soft (no context, observations dropped).

## 6. Legal basis and compliance — decisions required (owner + counsel)

This build ships T2 **off** (`FLOFI_LEARNING_AUTOMATIC` unset). Decisions to take before enabling:

1. **T2 basis.** (a) **Consent** (LGPD art. 7 I, 8; GDPR art. 6(1)(a), 7): opt-in in Privacy & memory or `memory on` on a channel, recorded with
   basis, notice version (`LEARNING_NOTICE_VERSION = 2`) and time; withdrawal erases what it produced. Lowest risk; few users will opt in. (b)
   **Legitimate interest** (LGPD art. 7 IX, 10; GDPR art. 6(1)(f)): on for verified identities unless they object; requires a documented legitimate
   interest assessment (LIA — purpose: understand the user's own vocabulary; necessity; balancing: pseudonymous, closed vocabulary, no values, no
   decisions, transparent notes, easy objection, short retention), the notice update below, and the right to object honoured immediately (implemented:
   turning it off erases and records the objection). Counsel should also confirm whether learned vocabulary is "profiling" under LGPD art. 20 /
   GDPR art. 22 — the code takes no decision with legal or similarly significant effect: every proposal is reviewed and signed by the user.
2. **Notice.** `/privacy#memoria-copilot` / `#copilot-memory` (PT/EN) now describes the three tiers, what is kept, both bases, the controls and
   retention. Counsel to approve the final wording and the controller identity (`FLOFI_PRIVACY_CONTROLLER_NAME`) and contact before enabling T2.
3. **Statistics.** Content-free events: confirm anonymised (art. 12) or legitimate interest with a balancing test (90-day retention).
4. **International transfer.** The interpreter is OpenAI's Responses API (already used for every Copilot message). A learned word is sent only inside the
   glossary of a request whose own text contains it. Review the transfer mechanism (LGPD art. 33; ANPD Resolution 19/2024 standard clauses).
5. **RIPD/DPIA** before enabling T2 (new purpose, systematic pseudonymous processing of user behaviour).
6. **Children** (LGPD art. 14): no age verification; the product is not directed at children — confirm.
7. **Existing data.** BUILD-CHAT-LEARNING-001 memories (consent v1) stay under their original purpose; if counsel decides v1 consent does not cover
   continued use under the new notice, re-consent can be requested in Privacy & memory (no code change needed: pause them or delete).
8. **Changing basis later.** Switching legitimate interest → consent leaves data collected under LI without a basis: run *Erase automatic-learning data the
   current basis does not cover* in `/admin/ai-learning` (audited).

T1 is proposed under performance of the requested service: nothing is stored beyond the conversation state FloFi already keeps for the chat itself.

## 7. Retention and erasure

| Data | Kept | Erased |
| --- | --- | --- |
| T1 adaptation | the conversation | when the conversation ends (page reload; channel state after 30 idle min; `new` / STOP) |
| Unlearned evidence (T2) | while observed | 90 days after the last observation; on forget of the word; on turning automatic learning off; on delete all / STOP |
| Learned meaning (T2) | while used | 365 days after last use; on correction (demoted); on forget; on turning automatic learning off; on delete all / STOP |
| Starting-language evidence | while observed | 365 days after the last observation; on turning off; on delete all / STOP |
| Automatic-learning choice (consent or objection) | while the subject exists | with the subject (an objection keeps the subject beyond the 30-day idle rule so it is honoured); 24 months idle |
| Remembered / stated meanings, language, settings | as in BUILD-CHAT-LEARNING-001 | as before |
| Contribution support / pending candidates | 180 days | on opt-out, delete all |
| Feedback events | 90 days | — |
| Glossary versions and evaluations | permanently (append-only record of what was served; no personal data) | — |

Every erasure path deletes 0014 rows through `ON DELETE CASCADE`, including a plain `DELETE` of the subject by an older build (proven in
`automatic.pg.test.ts`). Purges are bounded batches (opportunistic every ~10 minutes per instance, or from the console).

## 8. Data-subject rights (LGPD art. 18; GDPR arts. 15–21)

| Right | Web (Settings → Privacy & memory) | Channels |
| --- | --- | --- |
| Confirmation and access | list of kept meanings with origin (you told FloFi / learned from your choices / saved with Remember), observed-not-used evidence, choices, languages | `MEMORY` |
| Portability | **Download my data** (JSON) | `MEMORY` (text) |
| Correction | forget a word, or state the right meaning | `forget X`, a statement |
| Deletion | Forget, Delete everything | `forget everything`, `STOP` |
| Withdrawal of consent / objection | **Learn from how I use the Copilot** off (erases what it learned) | `memory off` |
| Information on sharing | the notice: no sharing except the interpreter request in §6.4 | the notice |

An operator cannot look a person up in the console (aggregates only); a support request for a wallet requires the learning secret to compute the
digest — a documented manual procedure, never exposed in the product.
