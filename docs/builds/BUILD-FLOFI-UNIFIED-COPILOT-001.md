# BUILD-FLOFI-UNIFIED-COPILOT-001 — unified Copilot, automations, saved recipients and cross-channel intelligence

Owner request (2026-11-15): fix the Anthropic `400` first, then make the Copilot tolerant of natural language and typos, educational,
continuous, able to explain and manage automations and guide platform settings, and add saved recipients to Credentials. It must behave the same
way on Web, Telegram and WhatsApp, and expose read-only MCP tools. Base `origin/main` `f54eb5f`; branch `claude/eloquent-carson-ioqmgc`.

Nothing in this work signed or sent a transaction, changed a production setting, environment variable or secret, applied a migration, merged,
deployed or restarted a service. No live Anthropic key was available in the engineering environment, so the Anthropic fix has
**offline evidence only**: the request shape is measured against Anthropic's documented limits and enforced by a test double. The live
probe exists and is SKIPPED without a key; a skip is not a pass (see Section 1).

## 1. P0 — Anthropic `400 invalid_request_error` (`COPILOT_UPSTREAM_REJECTED`)

**Root cause.** Anthropic compiles `output_config.format` and every `strict` tool schema into a grammar. Its documented per-request limits
are at most 20 strict tools, 24 optional parameters and 16 parameters with union types (`anyOf`, or a type array such as `["string","null"]`),
summed over every strict schema in the request. The Copilot V2 output contract is a strict OpenAI schema in which every optional field is
nullable. Translated for Anthropic it carries **160 union-typed parameters** (83 type arrays and 77 `anyOf`) across 48 nested objects. That
is ten times the limit, so the API refused the request before any model ran. This happened for every model, with or without effort. OpenAI
accepts the same schema, which is why OpenAI stayed green.

**Fix** (`server/copilot-providers.ts`). The single shared contract stays. `planAnthropicStructure` measures each request
(`schemaComplexity`) and chooses how the contract reaches Anthropic:

- `CONSTRAINED` — the whole request is within every limit. `output_config.format` is used as before.
- `PROMPTED` — it is not. The same schema goes in a cached system block as the output contract, with no grammar. The answer must be exactly
  one JSON object (`extractAnswerJson`). Strict tools stay strict while they alone are within the limits; the probe offers 9.

Every answer still passes FloFi's full deterministic validation: `parseCopilotOutputV2`, closed vocabularies, exact keys, bounded strings and
grounding. A malformed answer fails closed as `COPILOT_RESPONSE_INVALID`; it is never repaired or retried. Anthropic's `400` messages are
mapped to a closed reason (`ANTHROPIC_REJECTION_REASONS`: `SCHEMA_TOO_COMPLEX`, `TOOL_CHOICE_UNSUPPORTED`, `EFFORT_UNSUPPORTED`, …), and only
that reason is shown in Admin and recorded in the audit. The raw provider message is never recorded.

**Admin probe** (`admin/settings-http.ts`, `components/admin/copilot-settings-editor.tsx`):

- The probe uses a fixed mainnet transcript ("Swap 1 USDC to WETH on Base with 0.5% slippage") and offers the production tool definitions.
  Their run functions are never called, and orchestration is fixed at `maxRounds: 0`.
- It is tested per scope (Web, Telegram, WhatsApp), and each scope's activation remains independent. Rollback and reset are unchanged.
- The outcome reports `scope`, `toolsOffered` and `structure` (CONSTRAINED or PROMPTED, with the measured complexity). The audit adds `scope`,
  `upstreamStatus`, `upstreamReason` and `structure`.
- A probe never saves or activates settings.

**Evidence.**

- `copilot-providers.test.ts`: the root-cause measurement, the planning matrix, and that every strict schema sent is within limits.
- `settings-providers.pg.test.ts`: a provider double that enforces Anthropic's limits (≤16 unions) passes the probe through the real Admin
  HTTP route and disposable PostgreSQL, with 9 tools and no `tool_choice`. Per-channel independence and rollback are covered there too.
- Live: `copilot-anthropic.live.test.ts` (`pnpm test:copilot-live` with `ANTHROPIC_API_KEY`) sends the Admin transcript to the real Messages
  API, with and without effort, and requires FloFi validation to pass. **It was not run** because no key was available. The owner check:
  Admin → Copilot → Anthropic → Test connection on the Preview, for each scope, before activating anything.

## 2. Conversational design

The engine is still the pure `startTurn`/`finishTurn` pair. It runs in the browser on Web and in Channel Core for Telegram and WhatsApp, so
every channel gets the same behaviour.

New deterministic local paths run before the model (`assistTurn`, in this order):

1. Resume of an open request ("ok, vamos continuar").
2. An answer to an open clarification. This always wins: a slot value is never read as a concept or command.
3. Concept follow-ups, then concept questions.
4. Automation FAQ and saved-automation management.
5. The platform guide.

None of these paths changes the workflow. When a request is still open, their answers remind the user of it.

**Typos and natural language** (`domain/copilot-assist.ts`, `author()`):

- Network and coin names are corrected only when unambiguous. Terms come from the network registry and coin names. A correction needs the same
  first letter and at most 1 edit for 5–6 letters or 2 edits for 7+. A stop-list protects everyday look-alikes. Words already in the learned
  lexicon are skipped.
- Every correction is shown before any proposal. A correction the user can see gets a "read as" note. One that would change a real-funds
  identity is asked as a confirm question.
- ETH/WETH, USDC/USDC.e, the ARB token versus Arbitrum, SOL/SPL and EVM/Solana stay distinct. "Ethereum" is the coin only in a coin position:
  after an amount, after a trade verb, or before "por/for/to <token>". In that position it never also names the Ethereum network, so
  "trocar 1 ethereum por usdc" asks which network.
- An unsaved automation proposal can be rescheduled from schedule words alone ("muda para segunda"). A message naming an asset or verb is a new
  request and goes to the model.

**Language.** A local answer follows the interface language, then the user's learned choice, then the message's function words, then its
opening question words. The conversation then continues in that language.

## 3. Education (`domain/intelligence/concepts.ts`)

- 20 concepts with EN/PT copy at four levels (STANDARD, SIMPLE, EXAMPLE, ADVANCED), plus protocol notes for Aave, Uniswap, Jupiter, Orca and
  Across.
- "In my workflow" explains the concept from the canonical steps only.
- Examples are labelled illustrative, and each concept declares its numbers. The eval's grounded-number invariant allows only those numbers.
- Live values are never answered from the catalog. "What is the APY on Aave right now?" stays `MARKET_DATA` (eval Q30, N08).
- If the model answers a concept question, FloFi's catalog text replaces the model's text (eval N09).
- Concept answers never mutate the workflow.

## 4. Automations

- **Explanations** (`automations/explain.ts`): rule summaries, "why didn't it run" from recorded history only, and an FAQ that covers
  insufficient balance, notifications and retired delegated execution.
- **Chat management**: list, pause, resume, archive and reschedule open `CopilotAutomationManager`. It reads through the existing
  owner-verified actions and changes nothing until the owner clicks Confirm on the exact change shown.
- **Reschedule**: definitions are immutable, so a reschedule is a confirmed replacement (`service.replace` / `store.archiveReplaced`).
  - A new rule is created and the old one archived in one transaction. The attention flag is re-checked under the row lock.
  - A paused rule's replacement stays paused, and the mode stays CONFIRM_EACH_TIME only.
  - Period limits and cooldown carry over the replacement chain. A same-owner, tenant-scoped, deduplicating recursive read over the existing
    `AUTOMATION_REPLACEMENT` records does this, with no migration.
  - Pending proposals of the old rule are withdrawn, and the confirm card says so.
- **Schedule reading** (`parseScheduleChange`): deterministic, with no model. It returns exactly the weekday, time and frequency the user
  wrote, or nothing, and then FloFi asks. Anything it cannot account for is refused, including:
  - two times;
  - an hour that does not fit its part of the day;
  - time-zone qualifiers;
  - relative or one-off dates;
  - a clock word with no time after it.

  "1 da noite" is 01:00, "9 da noite" 21:00 and "12 da noite" midnight.
- Delegated execution is reported as retired (`EXECUTOR_FUNDED_GAS_RETIRED`).

## 5. Platform settings assistant (`domain/intelligence/platform-guide.ts`)

- 14 topics, each with modes (EXPLAIN, NAVIGATE, READ, PREPARE_CHANGE, APPLY_CHANGE), a required permission and the surfaces it applies to.
- Links come only from FloFi's own workspace registry.
- Telegram and WhatsApp drop PREPARE_CHANGE and APPLY_CHANGE and give a page link instead.
- The assistant never applies a change itself and never acts as admin.
- A question about the user's own workflow ("which networks does this use?") is answered from the workflow, not the guide.

## 6. Saved recipients (Credentials)

- Account-scoped name → public address entries. EVM addresses must be EIP-55; Solana addresses must be on-curve. The zero address and the
  System Program are refused.
- Saving is opt-in: offered once after a typed address, never required. Credentials supports rename, list and delete. Duplicates are
  refused, with 60 writes per 10 min.
- A name resolves only on an exact folded-label match, with no typo tolerance. An ambiguous name gets a CHOOSE question, whose buttons pick
  that recipient and are shown untranslated. A saved address pasted in full resolves to that recipient.
- The chosen recipient is kept by id for the whole request. The draft never stores its address, and it is re-resolved and re-checked against
  the network on every turn.
  - In a plan, only the final send or bridge is filled.
  - A wrong-ecosystem recipient is refused only for a network the user named or that was carried.
  - A stale choice prepares nothing.
- "Para mim" / "minha carteira" always means the connected wallet. Names that would capture it cannot be saved: Carteira, Wallet, "My wallet …",
  yes/no words, names without a letter, network and token names.
- The words of a saved name never ground a network, token or route. Typo reading and grounding use the masked text.
- The resolved address goes through the same review, simulation and wallet-signature path as a typed one. Review shows the full address with
  the name beside it, for display only.
- Saved names, partial names and saved addresses are masked (`maskSavedRecipients`) in every transcript entry before any model request.
  Masking keeps every name masked once in the conversation, even if the list later becomes unavailable.
- The status ("Your account wallet", "Connected") is derived at read time from verified wallets. A saved recipient is never a key, an
  allowlist entry or proof of ownership.
- Deleting the account deletes its saved recipients (cascade).
- **Migration 0028 is certified here but NOT applied**: see Section 12.

## 7. EVM, Solana and cross-chain

- A recipient's ecosystem must match the step: an EVM recipient for an EVM transfer, a Solana recipient for a Solana transfer.
- For a bridge, the recipient must match the destination ecosystem.
- Typed addresses keep the existing checksum and on-curve validation. Transfer and bridge stay distinct operations.

## 8. Channels (Telegram and WhatsApp)

- Same engine, with `surface` passed from the adapter. Concept, FAQ and guide answers work as on Web.
- Automation proposals and management hand off to the Web page by link. The delivery output guard admits a closed set of FloFi page links.
- The channel state decoder validates the new fields. `recipientOffer` is dropped, and `concept` and `automation` are shape-checked.
- Channels receive no account data, including saved recipients: production has no verified account link for a channel identity.

## 9. MCP (read-only)

Five tools were added (`mcp/tools.ts`, `mcp/automations.ts`, `platform/explain.ts`). All are `readOnlyHint: true` and non-destructive, their
output goes through `assertSafeOutput`, they never call a model, and none can create, pause, resume, archive, change or approve anything.

- `explain_concept` (`flofi.strategy`): a catalog concept by id or term, at a level and for a protocol, EN/PT. Marked
  `generalKnowledge: true` and `liveData: false`; an unknown term returns the catalog ids and never echoes the term back.
- `explain_strategy` (`flofi.strategy`): for a strategy the existing composer accepts, each canonical step with its key concepts and FloFi's
  review findings. No live health factor, LTV, price or APY.
- `get_platform_help` (`flofi.strategy`): the platform guide for the MCP surface. It answers EXPLAIN and NAVIGATE only, and states that MCP
  never prepares or applies a change.
- `list_automation_types` (`flofi.strategy`): the three kinds, CONFIRM_EACH_TIME only, delegated execution unavailable
  (`EXECUTOR_FUNDED_GAS_RETIRED`), the FAQ and a link to `/app/automations`.
- `get_automation_status` (`flofi.runs`): the principal's own automations, read through the same owner-verified overview and history reads as
  the web app, once per owner wallet.
  - An unknown rule and a rule of another owner give the same `AUTOMATION_NOT_FOUND`.
  - A failed owner read gives `INCOMPLETE`, never a partial answer presented as complete.
  - The output has no balances and no approval links.

**Not included:** a saved-recipient lookup over MCP. No consent scope exists for it, and adding one needs a migration (the scope CHECK
constraints), so it is left for a later build.

**Consent note for the owner:** `get_automation_status` sits under the existing `flofi.runs` scope. The consent and `/connections` copy now
say so, but grants approved before this change were approved under the older wording. See Section 14 for the reviewers' assessment.

## 10. Security and privacy

- AI proposals remain proposals. Applying, reviewing, simulating and signing still require explicit owner action in the reviewed wallet flow.
- No private keys are handled, nothing is signed automatically, and no credentials are printed.
- The Copilot engine stays pure: the eval invariant forbids imports outside `domain/`. Automation helpers go through
  `domain/copilot-automation.ts`.
- Saved recipients never reach a model or a channel.

## 11. Tests and validation (local, at the PR head)

These are local results; CircleCI remains the certification authority (Section 14).

| Gate | Result |
| --- | --- |
| Typecheck (`next typegen` + `tsc --noEmit`) | pass |
| ESLint on every added or modified TS/TSX/MJS file | pass |
| Schema drift (`export-schemas.mjs --check`) | pass (11 exports) |
| Unit suite (as `pnpm test`: packages, app, backend; `--testTimeout=30000`) | **8728 passed, 0 failed, 2 skipped** (684 files) |
| PostgreSQL suites (all 129 `*.pg.test.ts`, loopback PostgreSQL 16.15) | **877 passed, 1 failed** |
| `governance_lite.py` and its unittest suite | pass (278 unittests) |
| `agent_guard.py check` (coverage map) | pass (19 domains, 176 modules) |
| `git diff --check` | clean |
| Browser (Playwright) suites | **not run locally**: they need a production build and the pinned Anvil runtime; CircleCI runs all three browser shards |
| Production build (`pnpm build`) | **not run locally**: an unnecessary production build was out of scope; CircleCI builds |
| Live Anthropic probe (`pnpm test:copilot-live`) | **not run**: no key; SKIPPED is not a pass |

- **Skipped unit tests:** the 2 skipped are `composition-service.test.ts` and `mode-b-service.test.ts`. They are older fork-runtime-gated
  tests (`it.skipIf(!path|!pin)`), not touched by this branch.
- **The one PostgreSQL failure** is `forward-compatibility.pg.test.ts` ("what 0015 does to a v14 database"). It fails identically on unmodified
  `origin/main` in this container, verified in a temporary `main` worktree. It is an environment difference (local PostgreSQL 16.15; CI pins
  `postgres:18.6`), not a regression. This branch does not touch that test or migration 0015.
- **New and changed suites, with what they cover:**
  - `unified-copilot.test.ts` (33 cases): journeys A–D, guidance, continuity, and two review-regression rounds.
  - `copilot-assist.test.ts`, `concepts.test.ts`, `platform-guide.test.ts`.
  - `saved-recipients.test.ts`: masking, matching, reserved names, and a backtracking bound.
  - `saved-recipients-store.test.ts`: write-after-invalidation and stale-row handling.
  - `copilot-automation.test.ts`, `copilot-eval` corpus (N01–N09).
  - `explain.test.ts`: 497 cases, including all 48 final violations grouped by root cause and a must-work list.
  - `replace.pg.test.ts`: lineage limits and cooldown, the forged cross-owner link, cycles and duplicates, and the attention re-check under
    lock.
  - `recipient-store.pg`, `certificate-0028.pg`, `settings-providers.pg`.
  - The MCP `education`, `automation-status` and `no-model` suites.
- **Every review regression test was confirmed to fail on the pre-fix code and pass after the fix.** In the final parser pass, 55 of the 79
  new cases fail on the previous parser; the other 24 are must-work and control cases.

## 12. Migrations, production configuration, rollout and rollback

- **No migration was applied.** Release A (this PR) ships the 0028 certificate and fixture. Every saved-recipient action answers
  `RECIPIENTS_UNAVAILABLE` until the exact certified 0028 is in `schema_migrations`. Release B (later, owner-run) ships 0028, in the order Neon,
  Railway API, Railway worker, Vercel. See [RELEASE-SAVED-RECIPIENTS-0028.md](../deploy/RELEASE-SAVED-RECIPIENTS-0028.md) and
  [SCHEMA-COMPATIBILITY.md §20](../deploy/SCHEMA-COMPATIBILITY.md).
- **No new environment variable.** Anthropic needs no configuration change: the fix is in the request shape. Per-scope activation stays an
  owner action in Admin after Test connection passes.
- **Rollback.** Revert the PR, or roll back to the previous Vercel/Railway deployment. No data migration has to be undone: 0028 is not
  applied by Release A. Copilot settings rollback is unchanged (Admin → Restore previous).

## 13. Engineering review and the final parser pass

**Reviewers.** The read-only FloFi specialists reviewed this branch:

- chat, security, automations;
- data-privacy, MCP, channels;
- admin-analytics, frontend-UX, transfer-payments;
- workflow, bridge, and a security re-review.

They had to work from the current source, because the review hook blocks Git-ignored diff files.

Verified findings in the shared Copilot engine, saved recipients, the web chat and automations were fixed in this PR. Each has a regression
test.

**Final parser pass.** The last adversarial round of the schedule reader left 48 violations, from 4 root causes:

| Root cause | Cases | Fix |
| --- | --- | --- |
| A second hour read as minutes ("10h 11h" as 10:11) | 19 | Two hours are asked for |
| An hour that does not fit its part of the day ("1 da noite" as 13:00, "11 da tarde" as 23:00) | 17 | Explicit table; "1 da noite" = 01:00 |
| A time-zone qualifier dropped ("my time", "meu horário") | 5 | Asked for |
| A clock anchor with no time kept the current time ("friday at") | 7 | Asked for |

All four were fixed in one pass, and that pass closed the correction loop.

## 14. Status, remaining items and follow-up PR

**Certification.** CircleCI certifies this PR (static, unit, PostgreSQL 18, fork and three browser shards). Local evidence does not certify
public execution, the live Anthropic API, Neon or Release B.

**Release conditions.** None of these block merging the code; each must hold before the related feature is enabled in production:

1. **Anthropic:** Admin → Copilot → Test connection must pass for each scope (Web, Telegram, WhatsApp) before Anthropic is activated there.
   The fix has offline evidence only.
2. **Saved recipients:** they stay unavailable until the owner runs Release B (migration 0028).
3. **MCP `get_automation_status`:** it sits under the existing `flofi.runs` scope.
   - Grants consented before this change (refresh families last at most 30 days) can read automation status without having seen the new
     wording.
   - Before deploying, the owner either accepts that window explicitly or holds this one tool until the follow-up below.
   - The other four MCP tools need only `flofi.strategy` and read no user data.

**Remaining verified defects, not fixed here (scope frozen), for a follow-up PR:**

- **MCP**
  - Medium:
    - The consent re-gating for `get_automation_status` (above).
    - The single-rule status reports `pendingProposals: 0`.
  - Low:
    - Platform-help automation copy mentions pausing.
    - No output cap on the automation list.
    - The status read records an already-applied approval as completed (a bookkeeping write).
    - A failed beta-eligibility read is reported as "no linked wallet".
    - The delegation concept copy says it is available "where enabled" (it is retired).
  - Nit: links without `websiteUrl`.
- **Channels**, all low:
  - After a concept answer, "pode executar" skips the authorization notice.
  - An aside's follow-up choices can capture a bare numeric answer.
  - A reply with both a link and a choice drops the choice.
  - The guide gives web-only wording on Telegram and WhatsApp.
  - The automation handoff wording.
  - Nits: duplicate page lists, the surface default, comments.
- **Admin**
  - Medium:
    - Anthropic cost estimates price cached prompt tokens at the full input rate.
    - `extractAnswerJson` accepts a bare object plus a fenced object. Either answer still passes FloFi's full validation and Review, so it
      fails safe.
  - Low:
    - The probe reports "Works" for a schema-valid misreading.
    - The structure line compares the wrong numbers.
    - A Default-card test is audited as WEB.
- **Frontend**, all low:
  - The manager card's expired-proof path.
  - Credentials loading and error states, refresh losing an open form, and early "Detected" validation.
  - Accessibility of the Review name tag and some focus and label gaps.
  - Platform-guide Portuguese page names, and "Ligações" → "Conexões".
- **Schedule reader**, low and all fail-safe: some valid but uncommon phrasings are refused and asked for: "set it for 10am", "12 noon", a
  bare "9 horas", "same time friday".
- **Data-privacy**, nits: the lock-wait comment wording, and the 0028 reversal SQL read from the release document.
- **Pre-existing on `main`:** a model answer inherits an open draft's carried values even for a new request. This branch limits that for its
  own new fields only.

Fixes for the MCP, channels and admin/frontend items were drafted in separate local worktrees when the scope was frozen. They were neither
verified nor merged into this PR.
