# Copilot learning — deployment and operations (BUILD-CHAT-LEARNING-001, -002)

What ships: invisible learning in three separately switched tiers — in-conversation adaptation, persistent individual memory learned from repeated
evidence (off until the legal basis is decided), and the reviewed, evaluated, versioned global glossary — plus content-free metrics, Settings →
**Privacy & memory** (`/app/privacy`) for users, channel `MEMORY` commands, and `/admin/ai-learning` for operators. The chat has no Memory panel and
no "Remember" offer. Privacy model and the open legal decisions: [`docs/security/LEARNING-PRIVACY.md`](../security/LEARNING-PRIVACY.md). Schema
contract: [`SCHEMA-COMPATIBILITY.md` §8](SCHEMA-COMPATIBILITY.md#8-certificate-0014_learning_automatic).

Nothing here changes a financial action, a workflow, a network, a wallet requirement, an approval, an execution, an automation or the 0.1% workflow
fee. Learning failures never block a turn.

## 1. Two releases, in order

| | Branch / PR | Contents | Database |
| --- | --- | --- | --- |
| **Release A** | `claude/build-chat-learning-002-release-a` | the forward-compatibility certificate for the exact 0014 (fixture, tests, §8); no feature | stays at 0013 |
| **Release B** | `claude/build-chat-learning-002` (stacked on A) | migration `0014_learning_automatic` + the feature (persistent automatic learning off by default) | Railway pre-deploy applies 0014 |

**Never merge B before A is deployed everywhere.** B serving while the database is still at 0013 refuses platform state (`SCHEMA_NOT_MIGRATED`), like
every Release B before it — learning itself fails soft, but MCP, Developer, Channels and Admin would refuse too.

Prerequisite: 0013 (BUILD-CHAT-LEARNING-001) is applied in production before Release A's 0014 can matter. Release A is harmless on a 0012 or 0013 database.

## 2. Rollout sequence (owner actions; nothing here is performed by the build)

1. **Merge Release A.** Railway `flofi-api` pre-deploy: `migrate.applied versions=none schema_version=13`. Vercel builds and serves as before.
2. **Confirm Release A everywhere** (§8.1): Railway `flofi-api` and `flofi-worker` at or after the Release A merge (`railway deployment list --service … --json`);
   Vercel Production `https://flofi.xyz/api/flofi/readiness` → `deployment.commit` descends from it; every Preview on the production `DATABASE_URL`
   rebuilt from Release A or later (or accept that older Previews refuse); operator CLIs from a Release A checkout. Soak.
3. **Prepare Release B without exposing it.** Rebase B on `main` (which then contains A); `forward-compatibility.test.ts` passes (shipped 0014 =
   certificate). Turn off Vercel *Auto-assign Custom Production Domains* (or plan `vercel deploy --prod --skip-domain`); optionally pause
   `flofi-worker` auto-deploy.
4. **Merge Release B.** Railway pre-deploy applies 0014: `migrate.applied versions=14 schema_version=14` (≈ 12 ms; learning-subject writes of Release A
   processes wait at most that long). Release A processes keep serving with `forward_migrations=14_learning_automatic`.
5. **Promote** the staged Vercel deployment; re-enable auto-assignment / worker auto-deploy.
6. **Validate with the defaults** (`FLOFI_LEARNING` as before, `FLOFI_LEARNING_AUTOMATIC` unset): `/readyz`, `/api/flofi/readiness` (`READY`,
   `schemaVersion: 14`); one owner run (Simulate → Review → wallet → reconciled); a Channels message → approval link; MCP OAuth and `/approve`;
   `/admin/ai-learning` shows "Persistent automatic learning: Off".
7. **Choose the tiers** (§3), one environment change at a time, redeploying after each (environment variables apply on the next deployment).

## 3. Enabling, tier by tier (Vercel only; Railway needs nothing)

| Step | Variables | Effect | Needs |
| --- | --- | --- | --- |
| T1 only | `FLOFI_LEARNING=session` | in-conversation adaptation; nothing stored; no database or secret used | nothing else |
| T1 + stored tiers | `FLOFI_LEARNING=enabled`, `FLOFI_LEARNING_SECRET=<openssl rand -hex 32>` (dedicated; never another FloFi secret) | adaptation, BUILD-CHAT-LEARNING-001 memories served, the global glossary, content-free metrics, Settings → Privacy & memory, channel `MEMORY` | `DATABASE_URL` platform state |
| T2 under consent | + `FLOFI_LEARNING_AUTOMATIC=consent` | learned meanings for identities that turn on *Learn from how I use the Copilot* (or send `memory on`) | **legal decision** (LEARNING-PRIVACY §6) |
| T2 under legitimate interest | + `FLOFI_LEARNING_AUTOMATIC=legitimate_interest` | learned for every verified identity that did not object | **legal decision**, LIA, approved notice |
| Break-glass | `FLOFI_LEARNING_GLOBAL=disabled` | stop serving the global glossary | — |

Rotating `FLOFI_LEARNING_SECRET` detaches every stored meaning, choice and evidence (users start over); do not rotate casually. An invalid
`FLOFI_LEARNING_AUTOMATIC` turns all learning off (fail closed), never on.

## 4. Verification after enabling (no real-money action)

1. Web, any visitor: "Swap 0.1 SOL to devUSDC on sol dev" → FloFi asks → choose *Solana Devnet* → proposal. "Swap 0.2 SOL to devUSDC on sol dev" →
   proposal with the note "“sol dev” read as Solana Devnet — as you chose earlier in this conversation". No Memory panel, no Remember button.
2. Settings → Privacy & memory: prove a test wallet (sign-in message only). With T2 under consent, turn on *Learn from how I use the Copilot*.
3. Repeat step 1 in a new conversation and **Apply** the second proposal (do not simulate or execute) → Privacy & memory lists "sol dev → Solana
   Devnet (test network) · learned from your choices"; a later conversation shows "— learned from your earlier choices".
4. Another wallet / browser: the same request is asked again (no inheritance).
5. "Bridge 10 USDC from Base to arb" → choose *Arbitrum One* → next time FloFi still asks, with Arbitrum One first and the note "You used “arb” for
   Arbitrum One before…" (a learned meaning never selects a real-funds network).
6. Privacy & memory → turn learning off → the learned meaning disappears; *Delete everything* → nothing listed. Telegram (allowlisted test account):
   `memory`, `memory off`, `stop`.
7. `/admin/ai-learning` → *Invisible learning* shows the counts; no word or identity is shown.

## 5. Operating levers (fastest first)

| Need | Lever | Effect |
| --- | --- | --- |
| A wrong learned meaning for one user | the user: Privacy & memory → Forget, or correct it in chat ("no, I meant…") — a correction removes it at once | immediate |
| Stop persistent learning | unset `FLOFI_LEARNING_AUTOMATIC` + redeploy | nothing more is stored; existing data kept (use the purge below to erase) |
| Erase data no longer covered by the basis | `/admin/ai-learning` → *Erase automatic-learning data the current basis does not cover* (bounded batches; audited) | immediate |
| A bad global entry | retract + publish, *Re-evaluate and roll back*, or *Disable glossary* | next request of every instance |
| Stop all learning | unset `FLOFI_LEARNING` + redeploy | the Copilot exactly as before BUILD-CHAT-LEARNING-001; data kept |
| Keep only in-conversation adaptation | `FLOFI_LEARNING=session` | nothing read or stored |
| Retention now | `/admin/ai-learning` → *Run retention now* | bounded batches (otherwise every ~10 min per instance) |

Every console action is OPERATOR-only, CSRF-checked and audited (`ADMIN_LEARNING_*`).

## 6. Rollback

| Situation | Safe action |
| --- | --- |
| Before 0014 is applied | roll back freely (Release A or later). |
| 0014 applied, Release B misbehaves | unset `FLOFI_LEARNING_AUTOMATIC` and/or `FLOFI_LEARNING` first; if needed roll the application back to Release A (serves on 0014; its pre-deploy succeeds with `versions=none`). |
| 0014 applied, a build older than Release A | **unsafe**: refuses the database on every cold start. |
| 0014 must be removed (last resort) | SCHEMA-COMPATIBILITY §8.3, with Release A serving everywhere; destroys automatic-learning choices and evidence. |

## 7. What is measured where

`/admin/ai-learning` (last 30 days): BUILD-CHAT-LEARNING-001's aggregates, plus **Invisible learning** — effectiveness (inferred readings applied
unchanged ÷ applied or corrected), false positives (inferred readings corrected ÷ used), corrections per proposal by source (chat, canvas), signals
adapted, signals ignored by reason (`CANONICAL`, `USER_CHOSEN`, `OBJECTIVE_CHANGED`, `AMBIGUOUS`, `FINANCIAL_FIELD`, `SEVERAL_FIELDS`, `STEP_REMOVED`,
`*_NO_TERM`, `*_TERM_INVALID`…), inferred readings by source (adapted, learned, glossary, interpreter), what the persistent tier did with each
observation (`CLARIFIED_LEARNED`, `CONTRADICTED_DEMOTED`, `…_CONFLICT`…), identities' choices by basis, evidence and learned-meaning counts. Contributed
candidates appear individually only with ≥ 3 distinct contributors.
