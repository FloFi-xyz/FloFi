# Copilot learning — privacy, identity boundaries and data protection (BUILD-CHAT-LEARNING-001)

Scope: FloFi's Copilot learning — private memory per verified identity, the shared global glossary, and content-free feedback — on the web chat,
Telegram and WhatsApp. Brazil is the primary market: this is written against the **LGPD** (Lei 13.709/2018) first and kept compatible with the
**GDPR**. It describes what the code does; the legal basis for each purpose is an **open decision for the owner and counsel** (§5), not an
assumption of this build.

## 1. Purposes (two, separately controlled)

| Purpose | What FloFi keeps | When | Control |
| --- | --- | --- | --- |
| **P1 Private memory** — understand the user's own words and reply language in later sessions | short term → closed target pairs (`arb → network:ARBITRUM`), a reply language, the consent time and notice version | only after the user clicks **Remember** (web) / taps it (channel) | Memory panel (web) or `memory`, `memory off/on`, `forget X`, `forget everything` (channels); pausing keeps entries unused; deleting is immediate |
| **P2 Contribution to the shared glossary** — improve understanding for everyone | a generalized term → target pair as a *candidate*, with a pseudonymous contributor digest (counts distinct contributors) | only with the separate **Help improve FloFi's shared glossary** switch on (default **off**) | the same switch: turning it off withdraws past contributions; "delete all" erases them |
| Content-free feedback (operational statistics) | event kind, closed outcome code, scope (web/Telegram/WhatsApp), language, small counts, glossary version | when learning is enabled on the deployment | not linked to any person (no subject, no text): aggregates only |

Nothing is learned while the deployment has learning **off** (`FLOFI_LEARNING` unset, the default). Global knowledge is never published by
repetition: only an operator's approval followed by a passing deterministic evaluation publishes a glossary version (`docs/deploy/LEARNING.md`).

## 2. What is never stored or derived

* Message text, transcripts, model prompts or responses (the existing channel retention rules are unchanged: encrypted transient payloads,
  30-minute state, erased bodies).
* Secrets: private keys, seed phrases and 64-hex secrets are refused **before** any learning parser runs (`looksSecret`, unchanged).
* Financial values: amounts, addresses, slippage, ranges, balances, transactions. A memory target is a closed vocabulary (network id, pinned
  token symbol, operation) — validation refuses anything else.
* Wallet addresses or channel sender ids: a learning subject is `HMAC-SHA256(FLOFI_LEARNING_SECRET-derived key, principal)`; the database alone
  cannot tell whose memory a row is. Contributor digests use a second derived key.
* Previously collected data: nothing reads existing conversations, runs, channel records or analytics. Learning starts from new, explicit
  statements after the owner enables it.

## 3. Identity boundaries

| Principal | Established by | Learning subject |
| --- | --- | --- |
| EVM wallet (web) | SIWE signature → sealed HttpOnly `flofi_wallet_session` cookie, read on the server | `wallet:eip155:<address>` |
| Solana wallet (web) | SIWS signature → sealed HttpOnly `flofi_solana_session` cookie | `wallet:solana:<address>` |
| Telegram sender | Bot API webhook secret token, keyed sender digest (Channel Core) | `channel:TELEGRAM:<bot>:<sender digest>` |
| WhatsApp sender | Meta webhook signature, keyed sender digest | `channel:WHATSAPP:<phone number id>:<sender digest>` |
| Anonymous web visitor | none | none — what they say lasts for the conversation only |

* The browser can only **choose** which of its proven wallets (EVM or Solana) a request concerns; it can never name an address. A requested
  namespace that is not proven in that browser is treated as anonymous — never silently replaced by the other wallet.
* EVM and Solana memories are separate even when both are proven in one browser (that is not an account link). A channel sender is never a
  wallet and never a sender on another channel. There is no cross-identity merge in this build; a future merge would need verified linkage.
* Rotating `FLOFI_LEARNING_SECRET` detaches every stored memory (a documented reset); rotating `FLOFI_CHANNEL_SECRET` does the same for channel
  senders (their digests change).
* Tenants: every query is scoped to the deployment tenant; the PostgreSQL suites prove another tenant reads nothing.

## 4. Safety of learned language

* Learned vocabulary only changes **which networks or tokens the user named**; it never supplies a number, an address, a slippage or a range, and
  never overrides a value the user wrote. A user's own meaning (this conversation's, or saved) may name a network or token; the shared glossary may
  name **test networks only** — for a real-funds network it can only offer that option first in FloFi's own question, and the user decides.
* Every use is shown on the proposal ("“arb” read as Arbitrum One — your saved meaning"); the proposal still needs the user's Apply, the fresh
  simulation, the Strategy Manifest review and the wallet signature, exactly as before.
* Canonical vocabulary cannot be redefined (registry network names, pinned tokens, protocols, commands, authority and instruction words), and a
  term with test-network wording can only name a test network or test token (and vice versa).
* The interpreter receives at most 8 matched entries as quoted data in one extra `developer` input item; instructions, schema and `store: false`
  are unchanged. The model remains untrusted: grounding decides.

## 5. Legal basis — decision required (owner + counsel)

This build **does not assume** a legal basis. Proposed, for review:

* **P1 Private memory — consent** (LGPD art. 7, I; GDPR art. 6(1)(a)): specific (one meaning or the reply language at a time), informed (the
  offer says what and for whom, and links to this notice), unambiguous (an explicit click), revocable at any time (pause, forget, delete all),
  recorded (consent time + notice version `LEARNING_NOTICE_VERSION = 1`). Alternative to assess: performance of the service the user requested
  (art. 7, V) — weaker, because remembering is not necessary to provide the chat.
* **P2 Contribution — separate consent**, default off; withdrawal deletes the contributor's support. Published glossary entries are generalized
  language (no personal data) once approved; whether a published entry derived from contributions needs further treatment is part of the review.
* **Feedback statistics** — content-free and unlinked; assess whether they are anonymized data (LGPD art. 12) or legitimate interest (art. 7, IX)
  with a balancing test; they are kept 90 days.
* **International transfer**: the interpreter is OpenAI's Responses API (already the case for every Copilot message). A saved term is sent to it
  only inside the glossary of a request whose own text contains that term. Review the existing transfer basis (LGPD art. 33) for this added data.
* **Children**: no age verification exists; the product is not directed at children. Assess LGPD art. 14 obligations.
* **DPIA/RIPD**: recommended before enabling in production (new purpose, pseudonymous profiling of vocabulary).

## 6. Retention and erasure

| Data | Kept | Erased |
| --- | --- | --- |
| Private memory entry | while used | 365 days after last save/use; on forget, pause does not erase; on delete all |
| Learning subject (no memory, no consent) | — | 30 days idle |
| Any learning subject | while seen | 24 months idle (with its memory) |
| Contribution support | until decided or withdrawn | 180 days; on opt-out; on delete all |
| Pending contributed candidate | — | 180 days without new support |
| Feedback event | 90 days | then deleted |
| Glossary versions and evaluations | permanently (append-only audit of what was served) | — (no personal data) |
| Learning rate-limit windows | 2 days | then deleted |

Purges are bounded batches run opportunistically by the web/channel processes (at most every 10 minutes per instance) and from the admin console.
**STOP** on a channel also erases that sender's learning data.

**Data-subject requests.** Access/portability: the Memory panel or `memory` lists everything stored about the user's own vocabulary; deletion: "Delete
all memory" / `forget everything` / STOP. An operator-side lookup by wallet requires the learning secret (HMAC of the principal) — documented for
a support process, never exposed in the console, which shows aggregates only.

## 7. Product notice

The in-app privacy page (`/privacy#copilot-memory`) and the Memory panel describe P1 and P2 in plain EN/PT. Copy must stay consistent with this
document; change both together.
