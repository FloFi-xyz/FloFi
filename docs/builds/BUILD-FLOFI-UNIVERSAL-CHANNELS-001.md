# BUILD-FLOFI-UNIVERSAL-CHANNELS-001 — Universal conversational execution (ChatGPT, Claude, Telegram)

Branch `claude/blissful-cannon-bbdruz` from `origin/main` `398beb1d498e1423757d1d85bcf6ea32ab2be680` (PR #247 merge). No open PR touched
MCP, Channel Core or Telegram when the branch was cut (open PRs: #245, #182, #140, #137, #102, #55, #54, #52). Governance: GOVERNANCE-LITE
([scope guard](../SCOPE_GUARD.md)). Evidence levels follow [EVIDENCE_LEVELS](../EVIDENCE_LEVELS.md): everything below is local/automated
engineering evidence (MOCKED flows, fixture providers, loopback PostgreSQL). **No real-money transaction, wallet signature, provider message,
deployment or production configuration change was made by this build.**

## 1. Initial audit (before any change)

The audit read current source, tests and the earlier build records (BUILD-MCP-001/002, BUILD-MCP-LINK-INTEGRITY-P0, BUILD-CHANNELS-001,
BUILD-CHANNEL-SIGNING-001, BUILD-SOLANA-TRANSFER-UX-001, BUILD-CHAT-E2E-001) and treated them as context, not proof: each capability below was
checked against the code that implements it today.

| Area | Finding |
| --- | --- |
| MCP transport/auth | `POST /api/mcp` (Streamable HTTP, 2025-11-25 and 2026-07-28 revisions), OAuth 2.1 (PKCE S256, CIMD, optional narrow DCR, rotating refresh tokens), per-tool scopes `flofi.strategy` / `flofi.approval` / `flofi.runs`, beta gate, request deadlines, strict output guard, canonical-origin link integrity. **Working.** |
| MCP workflow tools | Discovery (`get_supported_networks`, `get_supported_assets`, `get_capabilities`), authoring (`plan_strategy`, `compose_strategy`, `validate_strategy`, `review_strategy`), read-only `simulate_strategy`, approval handoff (`request_user_approval`, `get_approval_status`, app-only `open_approval_session` / `get_execution_progress`), owner-scoped `get_execution_status` / `get_evidence`, education and read-only automation tools. Multi-step v2 strategies with bindings. **Working.** |
| MCP identity/wallets | Pseudonymous OAuth account; wallets linked on `/connections` by the wallet's own sign-in proof; used only for `flofi.runs` reads. **No tool told the user who they are or which wallets are linked** — gap. |
| MCP portfolio/history | Dashboard has read-only portfolio (`server/wallet-portfolio.ts`), positions (`server/defi-positions.ts`) and cross-flow history (`GET /v1/runs`). **Not exposed to MCP** — gap. |
| MCP lifecycle vocabulary | Approval states (PENDING/CLAIMED/APPLIED/EXPIRED/SUPERSEDED/REVOKED/STALE) and the canonical run lifecycle existed, but **no single state that a client can use to tell draft / review / awaiting wallet / awaiting signature / submitted / pending / partial / confirmed / failed / cancelled / expired apart** — gap. |
| MCP cancel | `/connections` (browser) could withdraw an approval; **no MCP tool could** — gap. |
| MCP errors | Failures returned closed codes only (e.g. `MCP_SIMULATION_BUSY`); **no person-readable explanation** — gap. |
| Saved workflows | Saved workflows exist for the web Editor (`saved_workflows`, keyed by verified owner, semantic IR). There is **no IR → StrategySpec conversion**, so a saved Editor workflow cannot be re-requested from MCP or Telegram without a new contract — **not available externally** (see §13). |
| Telegram | Secret-token webhook, `update_id` dedup, private chats with people only (groups/channels/bots ignored), allowlist/beta gate, EN/PT, local commands, Copilot interpreter (untrusted), multi-step ADD STEP / STEPS / REMOVE / MOVE, one approval link per workflow, STATUS, consented run notifications, STOP/opt-out, memory consent controls. **Working.** |
| Telegram buttons | An approval message carried only one URL button; actions (status, add, cancel) had to be typed — partial. |
| Telegram safety | **Defect found:** after the owner APPLIED a proposal (it may have run), `ADD STEP`, `REMOVE/MOVE STEP` or a correction re-proposed the earlier steps inside the next workflow (`revokeForRequester` leaves APPLIED untouched), so a later signature could run an already-executed step again; `CANCEL` also replied "Cancelled" for an APPLIED request. Unmapped refusals showed the raw code. |
| Telegram identity | A chat is a `CHANNEL_CONVERSATION` requester, never a wallet. The only verified chat→wallet link is the automation-notification code (consented for notifications only). **No verified account link for portfolio/history** — gap (§13). |
| Signing | `/approve` already offers the **minimal signing surface (default)** with Canvas optional, wallet proof (EIP-4361 / SIWS), fresh simulation, Strategy Manifest Review and wallet confirmation; MCP Apps panel embeds it where host and wallet allow; MetaMask/Phantom deep links; FloFi Wallet (`wallet.flofi.xyz`, Privy/Circle) for embedded wallets. **Working; reused unchanged** (no new app or deployment). |
| Production reachability | `flofi.xyz` is not reachable from this build environment (egress policy refused the connection), so no live endpoint was observed here. |

## 2. Capability assessment

| Capability | Before | After this build |
| --- | --- | --- |
| Discover networks/assets/actions | ✅ registry-driven | unchanged |
| OAuth / identity | ✅ OAuth; ❌ identity not readable | ✅ `get_account` (client, scopes, proven wallet links, Connections link) |
| Linked wallets / link new | ⚠️ `/connections` only | ✅ `get_account` returns the link page; linking stays a wallet-signed browser step |
| Portfolio / positions | ❌ MCP | ✅ `get_portfolio` (linked wallets only) · ❌ Telegram |
| Single/multi-step compose, modify | ✅ | ✅ + `conversationState` |
| Validate / quote / simulate / review | ✅ | ✅ + `conversationState` |
| Signing request / resume | ✅ `/approve`, MCP App panel | unchanged |
| Status / evidence | ✅ | ✅ + `conversationState`; ✅ `list_executions` (MCP) |
| Execution history | ❌ MCP / Telegram | ✅ MCP (`list_executions`, `list_approvals`) · ⚠️ Telegram STATUS of the conversation's last approval only |
| Cancel before submission | ⚠️ browser / Telegram NEW | ✅ `cancel_approval`; ✅ Telegram "Cancel request" (APPLIED never reported cancelled) |
| Save / reuse workflows | ⚠️ web Editor only | ❌ external (deferred, §13) |
| Friendly errors (EN/PT) | ❌ | ✅ MCP `userMessage` block; ✅ Telegram refusal fallback |

## 3. Architecture decisions

1. **No new agent architecture, service, database, queue or deployment.** External channels keep calling the shared platform
   (`src/platform`): same composition, canonical IR/hash, review, simulation, approval handoff, owner-scoped reads.
2. **One conversational lifecycle** (`platform/conversation-state.ts`): a pure derivation from authoritative state only —
   deterministic validation/review, the durable handoff status, the workflow run (`RunView`) and the canonical run lifecycle
   (`domain/canonical-execution-status.ts`). States: `DRAFT_CREATED, MISSING_INFORMATION, VALIDATION_REQUIRED, SIMULATION_COMPLETED,
   REVIEW_REQUIRED, AWAITING_WALLET_CONNECTION, AWAITING_SIGNATURE, SUBMITTED, PENDING_CONFIRMATION, PARTIALLY_EXECUTED, CONFIRMED, FAILED,
   CANCELLED, EXPIRED`, plus two honesty states the request list lacked: `NEEDS_ATTENTION` (something may have been sent; never "not run") and
   `STATUS_UNKNOWN` (a read failed or the owner did not share; never "nothing happened"). Only `CONFIRMED` is `completed`, and it requires the
   approval read's strict evidence check where one exists.
3. **Additive MCP contract.** Existing tool names, input schemas and `structuredContent` fields are unchanged; `conversationState` is an
   added field. Error `structuredContent` is byte-for-byte unchanged; the person-readable explanation is a **second text content block**
   (`userMessage (EN)` / `userMessage (PT)`), so clients and the MCP App panel that parse the structured error are unaffected.
4. **Identity = proven wallet links.** New account reads take **no wallet or address input**; they read only `principalOwners` (wallets the
   OAuth account linked with the wallet's own sign-in proof), at most 4 per call. An e-mail, username or client metadata never selects data.
5. **Cancel is bounded by the signing flow.** `cancel_approval` withdraws only PENDING/CLAIMED handoffs (nothing can be signed from them); an
   APPLIED one is refused with `APPROVAL_NOT_CANCELLABLE` and the person is told to reject the wallet prompt or stop it in the signing page.
6. **Telegram one-tap actions are typed commands.** Callback ids `act:status|act:add|act:steps|act:cancel` map to the exact local command
   words in the conversation's language (no model). A forged callback can do nothing a typed message could not. Shown only by adapters that
   declare `linkWithChoices` (Telegram); WhatsApp is unchanged.
7. **Never re-execute applied steps.** When the previous approval is APPLIED, Channel Core starts a separate workflow instead of carrying its
   steps forward (ADD STEP, corrections), refuses step-list edits, and never says "cancelled".
8. **OAuth metadata advertises `offline_access`** (authorization-server metadata only): ChatGPT looks for it before relying on refresh tokens;
   FloFi already accepted it and always issued rotating refresh tokens. No scope, token lifetime or grant changed.
9. **MCP no-model invariant kept.** `server/defi-positions.ts` imported a limiter from `copilot-service.ts`; the limiter moved unchanged to
   `server/admission-limiter.ts` (re-exported as `createCopilotLimiter`) so the MCP route's transitive closure still never loads a model client.

## 4. Reused components

Shared platform (composition, review, simulation preview, approval service/handoff store, `approvalProgress`, `executionStatusView`),
`domain/canonical-execution-status.ts`, MCP gateway/OAuth/deadline/output guard, Channel Core (conversation, service, delivery/outbox,
approval), Telegram webhook/adapter/transport, `/approve` minimal signing surface and MCP App panel, `/connections`, Dashboard portfolio and
position readers, cloud API `GET /v1/runs` (same read as the Dashboard history), handoff store `listForRequester` / `revokeForRequester`.

## 5. Modified / new components (paths under `apps/reference-dapp/src/` unless noted)

| Path | Change |
| --- | --- |
| `platform/conversation-state.ts` (new), `platform/index.ts` | lifecycle derivation, `userFacingError` (EN/PT) |
| `mcp/account.ts` (new) | `accountView`, `portfolioView`, `positionsView` (explicit allowlist), `historyView`, deployment portfolio port |
| `mcp/tools.ts` | 5 tools, `conversationState`, `userMessage` block, scopes/timeouts/instructions |
| `mcp/gateway.ts`, `mcp/runtime.ts`, `server/cloud-api-client.ts` | portfolio port injection; owner `history` read (`listOwnerRuns`, remote runtime only) |
| `mcp/oauth/server.ts`, `mcp/oauth/consent-page.ts` | `offline_access` in AS `scopes_supported`; `flofi.runs` consent text names history, balances and positions |
| `mcp/config.ts` (`portfolioLinksFrom`), `components/connections-panel.tsx`, `i18n/pt-authoring.ts`, `mcp/handoff/links.ts` | consented-link cutoff for portfolio reads; Connections consent copy EN/PT |
| `server/admission-limiter.ts` (new), `server/copilot-service.ts`, `server/defi-positions.ts` | neutral limiter |
| `channels/core/{approval,conversation,copy,service,types}.ts`, `channels/telegram/{adapter,render}.ts` | actions, APPLIED guards, plain refusals |
| `components/site/docs-content.ts` | public docs EN/PT (tools table, "Use FloFi from ChatGPT, Claude or Telegram") |
| `docs/engineering/coverage.json`, `COVERAGE.md` | new sources and suites registered |
| Tests | `platform/conversation-state.test.ts`, `mcp/account-tools.test.ts`, `channels/telegram/universal-actions{,.pg}.test.ts`; updated `mcp/gateway.test.ts`, `platform/parity.test.ts`, `platform/approvals.pg.test.ts`, `mcp/visual.pg.test.ts`, `mcp/oauth/server.pg.test.ts`, `mcp/gateway.test-harness.ts` |

No migration, dependency, lockfile, fee configuration, network policy, execution engine or signing code changed. One **new optional, non-secret
environment variable** gates balance/position reads: `FLOFI_MCP_PORTFOLIO_LINKS_FROM` (§14); unset, `get_portfolio` fails closed.

## 6. Channel capability matrix (what the code does; availability is §11)

| Capability | ChatGPT (MCP) | Claude (MCP) | Telegram (@FloFiAppBot) |
| --- | --- | --- | --- |
| Natural language EN/PT | host model → tools | host model → tools | exact grammar + Copilot interpreter (when enabled) |
| Identity / linked wallets | `get_account` | `get_account` | conversation only (no wallet link) |
| Portfolio / positions | `get_portfolio` | `get_portfolio` | ❌ |
| Compose / modify / multi-step | ✅ | ✅ | ✅ (ADD STEP, STEPS, REMOVE/MOVE, "Add another action" button) |
| Validate / simulate / review | ✅ `conversationState` | ✅ | ✅ preview in the proposal message |
| Approval + signing | panel (host/wallet dependent) or `/approve` minimal page | same | URL button → `/approve` minimal page |
| Status / evidence / history | `get_approval_status`, `get_execution_status`, `get_evidence`, `list_executions`, `list_approvals` | same | STATUS / "Check status"; consented notifications |
| Cancel before signing flow | `cancel_approval` | same | NEW / "Cancel request" |
| Unsolicited notifications | ❌ (not promised; poll on request) | ❌ | ✅ after the owner shares status |
| Saved workflows | ❌ | ❌ | ❌ |

## 7. Security model

Unchanged financial authority: the model, OAuth, an MCP account, a Telegram message or button and an approval link authorize nothing. Only the
owner's proven wallet, after a fresh simulation, the Strategy Manifest review and wallet confirmation, executes. New surface: (a) account
reads use only proven wallet links and no input can name another wallet; another account's approval id is `APPROVAL_NOT_FOUND`; internal
account ids are not returned; (b) `cancel_approval` is `destructiveHint: true`, idempotent, requester-scoped and re-reads under the store lock
(an approval applied meanwhile is reported as it is); (c) position output is an explicit allowlist (no prepared operations); (d) every
output still passes the output guard; (e) Telegram callbacks run only existing typed commands; (f) applied workflows are never re-proposed.

## 8. Identity and session model

MCP: OAuth account (pseudonymous) → wallets linked on `/connections` by wallet proof (revocable there) → owner-scoped reads and the same
owner's runs/workflows as the web app (runs are owned by the wallet, so history and status are shared across web, ChatGPT and Claude).
Telegram: a chat is its own requester; the approval is claimed by the wallet proven on `/approve` (and only the intended wallet when the
strategy names one). Cross-channel sharing is through the wallet, never through matching e-mail, username or metadata.

## 9. Signing architecture

Unchanged and reused: approval handoff → `/approve` minimal signing surface (default; Canvas optional; no Dashboard/Chat/Editor visit) or the
MCP App panel → wallet proof → claim (server re-composes and re-checks) → fresh simulation → Strategy Manifest review → wallet confirmation per
step (or per user-funded group where enabled) → reconciliation → status/evidence in the originating channel. Supported wallets are those the
existing surface supports (injected EVM wallets incl. MetaMask, Phantom/Solflare for Solana, FloFi Wallet). Bindings to user, wallet, channel
(requester), workflow hash, plan, network, recipient (intended wallet), expiry, single-use link secret and replay/idempotency protections are
the existing handoff/claim/Manifest guarantees; this build adds none and weakens none.

## 10. Specialist findings

Reviewers were selected by `python3 scripts/agent_guard.py impact --base origin/main` (11 domains) and run read-only, at most three at a
time. Their reports are advisory; every finding below was checked against the source by the main session before acting on it.

**Batch 1 — flofi-mcp, flofi-channels, flofi-security (on `528d7cc`).**

| # | Severity | Finding (verified) | Resolution |
| --- | --- | --- | --- |
| 1 | **Blocking** (MCP + security, independently) | A SEQUENTIAL approval's workflow run starts at the owner's claim (`claimSequential`); user-funded groups can be signed while the handoff still reads CLAIMED and later EXPIRED/REVOKED. `approvalState` trusted the handoff status first, `cancel_approval` could revoke a CLAIMED handoff with a live run and answer "cancelled, nothing signed", and the Telegram guard only recognised APPLIED. | An existing workflow run now decides first for any handoff status; a claimed multi-step approval without a read run is `STATUS_UNKNOWN`; `cancel_approval` refuses `APPROVAL_NOT_CANCELLABLE` (`WORKFLOW_RUN_STARTED`) when a run exists and re-checks after revoking; Channel Core's `endChannelApproval` returns `RUN_STARTED` (no revoke) and every guard uses `inSigningFlow`. Tests: lifecycle unit cases, MCP cancel/list fixtures, Telegram PostgreSQL "claimed multi-step run" journey. |
| 2 | Important (channels) | LINK after an APPLIED workflow re-proposed it — and with the new guard, only its last step. | LINK proposes nothing for an APPLIED proposal or one with a workflow run; PostgreSQL test. |
| 3 | Important (MCP, security) | `list_executions` derived the lifecycle from status/hasEvidence only; an in-flight or result-unknown run could read as "waiting for the wallet". | `listOwnerRuns` passes `errorCode`, `needsObservation`, `attentionRequired`; summaries that cannot be told apart from an in-flight request are `STATUS_UNKNOWN`; test. |
| 4 | Important (MCP) | Instructions said a new approval supersedes a changed workflow's older request (only same-hash PENDING requests are superseded). | Wording corrected; the assistant offers `cancel_approval` for the older request with consent. |
| 5 | Important (MCP) | `runsTruncated` (no run among the wallet's recent runs) read as "in the signing page". | `STATUS_UNKNOWN` (`RUNS_TRUNCATED`); test. |
| 6 | Minor (MCP, security) | Wallets beyond the 4-per-call cap were skipped silently; positions for 3–4 wallets competed for the shared 2-slot limiter; no per-account portfolio budget. | `walletsOmitted` + `complete:false`; positions read sequentially and counted in `complete`; 30 portfolio reads per account per hour (`PORTFOLIO_RATE_LIMITED`); tests. |
| 7 | Minor (MCP) | Refusal families too broad (`TOKEN`), expiry text claimed "nothing was signed", portfolio/history codes read as unsupported network; gateway hard-deadline answers lacked the readable block. | Families narrowed and corrected; deadline answers carry `userMessage`; tests. |
| 8 | Minor (security, privacy) | Wallet links now expose balances, positions and history, but `/connections` consent text described status/evidence only. | Consent copy (EN/PT) and the link module comment updated. See batch 2 for previously created links. |
| 9 | Minor (channels) | A button on an older approval message acts on the conversation's current state (withdraws/keeps the newer proposal). | Accepted: only withdrawal or the typed command's effect, each reply says what happened. Recorded in §13. |
| 10 | Minor (channels) | Steps button missing for planner sequences; buttons could be silently dropped if a label grows. | Steps button for any multi-step proposal; unit test asserts all four actions fit Telegram's keyboard in EN and PT. |
| 11 | Note (security) | `accountView` said approvals follow wallets across Telegram. | Text corrected: approvals belong to the conversation/connection that made them. |

**Batch 2 — flofi-workflow, flofi-wallet-execution, flofi-data-privacy (on `e612cfa`).**

| # | Severity | Finding (verified) | Resolution |
| --- | --- | --- | --- |
| 12 | **Blocking** (workflow) | A cancelled/halted run with a `WALLET_BATCH_OUTCOME_UNKNOWN` group or step (the wallet may have executed the batch) mapped to CANCELLED/final. | Any such code makes an ended run `NEEDS_ATTENTION` (`BATCH_OUTCOME_UNKNOWN`, not final); test. |
| 13 | Important (wallet-execution, workflow) | `WAITING_FOR_RECONCILIATION` is the run view's fallback (also an unsigned `AWAITING_OWNER` step) and was shown as PENDING_CONFIRMATION; `OWNER_CONFIRMS_BATCH` (wallet already returned a batch id) was AWAITING_SIGNATURE / "confirm in wallet". | In-flight state from the current group/step records (SUBMITTED group → pending confirmation, UNCERTAIN → attention, otherwise UNKNOWN); batch report pending → `SUBMITTED` with "open the signing link"; tests. |
| 14 | Important (workflow) | Single-flow approvals used only the newest run and a status-only lifecycle. | Every bound run counts (unsettled first, then any confirmed, then partial; cancelled only if all declined); summaries without attempts are `STATUS_UNKNOWN`; `landed` and `terminal` respected; a reader's own lifecycle (Pix) used; RECONCILED_WITH_ATTENTION never stuck pending; tests. |
| 15 | Important (privacy) | OAuth consent text for `flofi.runs` still described status/evidence only; links made under the old Connections text would expose balances and positions without consent. | Consent text updated; portfolio reads only for links made at or after `FLOFI_MCP_PORTFOLIO_LINKS_FROM` (fail closed when unset); `balancesReadable` per wallet; re-linking renews consent; tests. |
| 16 | Minor (wallet-execution, workflow) | A claim could land between the cancel's read and its revoke (MCP and Channel Core). | A claimed multi-step handoff is in the signing flow before and after the revoke (locked row and run re-check), in both paths; test. |
| 17 | Minor (workflow) | LINK checked the conversation's last approval even when a newer pending proposal had none. | LINK checks only the current pending proposal's approval. |
| 18 | Notes | SINGLE handoffs cannot be signed before APPLIED (verified by wallet-execution: Simulate/Execute gated on `claimed && APPLIED`; apply and revoke are CAS under one row lock). Developer API outputs are unchanged. Telegram STATUS keeps its own wording (no `conversationState`). The privacy policy page does not describe MCP connections (pre-existing; owner/legal decision). | Recorded in §13. |

**Batch 3 — flofi-chat, flofi-infrastructure-ci, flofi-developers (on `e470945`).** No blocking findings; developers found none.

| # | Severity | Finding (verified) | Resolution |
| --- | --- | --- | --- |
| 19 | Important (chat) | A correction after the previous proposal reached the signing flow (incl. a goal-plan sequence) produced a new proposal with no indication that it does not replace the earlier one. | Such a proposal carries "This is a new, separate proposal: it does not replace or undo the earlier one" (EN/PT); it still needs a fresh simulation, Review and wallet signature; test. |
| 20 | Minor (chat) | A Status/Steps tap emptied FloFi's open clarification choices. | STATUS and STEPS keep `state.choices`; test. |
| 21 | Important (infra) | §5/§14 said no configuration was needed; §16 lacked the env step. | §5, §14 and §16 updated (above). |
| 22 | Minor (infra) | Solana history should use the Dashboard's owner header; history had no per-account budget; portfolio reads are not aborted with the request. | Solana owners sent as `x-flofi-workflow-owner: solana:…`; 60 history reads/account/hour; abort propagation recorded in §13; test of the read contract. |
| 23 | Note (chat, infra) | Buttons on older messages act on the current proposal; `/api/mcp` bundle grows by the portfolio readers (trace gate in CI decides). | §13 / CI. |

**Batch 4 — verification on the final head (`f3e8ecb`): flofi-workflow (re-review), flofi-frontend-ux, flofi-protocol-integrations.** No blocking
findings. flofi-workflow confirmed every earlier blocking finding (#1, #12) and #13–#17 **resolved** in the current source.

| # | Severity | Finding (verified) | Resolution |
| --- | --- | --- | --- |
| 24 | Medium (workflow) | The generic run reader's `terminal` is false for a declined/failed run without an error code, which the mapping read as "still observed" (STATUS_UNKNOWN forever, hiding an earlier confirmed run). | `sharedRunsRead` adds `observing: true` only while the run needs observation; the mapping uses it (and passes it to the canonical lifecycle); tests for declined/failed without error code. |
| 25 | Important (protocol-integrations) | Portfolio `complete` ignored UNAVAILABLE / partly checked networks and truncated holdings; raw units of an uninterpretable Token-2022 balance were returned; MCP balance reads bypassed the Dashboard's shared portfolio limiter and cache; a slow call could lose every result at the tool cap; the health factor was a raw 18-decimal integer. | Per-wallet `complete` + `incompleteNetworks`; `rawUnits` withheld when `displayUnits` is null, `unavailableCode` and price time returned, a note to show `displayUnits`; cached snapshot first, then a slot of the shared limiter (`PORTFOLIO_BUSY` = UNKNOWN); wallets and position scans read one at a time only while ≥ 15 s of the budget remains (`*_SKIPPED_DEADLINE`); health factor as a 4-place decimal plus the raw WAD; `NETWORK_UNAVAILABLE`/`UNSUPPORTED` scans count as "not offered", not failures; tests. |
| 26 | Important (protocol-integrations) | Aave reserve reads (`app/supply-action.ts` `supplyReserves`) run inside `withFlightAccess`, which needs the FloFi web session; an MCP request has none, so on a beta-gated deployment the Aave scan reports UNAVAILABLE through MCP. | Fails closed (UNAVAILABLE, `complete:false`, never empty). Not changed here: it is a Flight access boundary; recorded in §13 for a follow-up that reads reserves with the gateway's verified beta identity. |
| 27 | Important (frontend-ux) | PT docs called the page "Conexões" while the PT UI says "Ligações"; "link a wallet once" ignored the 30-day expiry and the consent cutoff; tracking omitted the status-sharing step and used an internal state name; `PORTFOLIO_RELINK_REQUIRED` got "try again later"; "já está na assinatura" is ambiguous in PT. | Docs EN/PT rewritten accordingly ("Ligações (Connections)", 30-day links and re-linking, sharing step, "reconciled result"), a dedicated relink message, PT "já foi aberto(a) para assinatura no FloFi", "Adicionar outra ação", alternatives introduced as "Connect one of these", Claude Team/Enterprise owner note, preview "where available", fee sentence matching the review card's "FloFi fee" with its charging status. |
| 28 | Note (frontend-ux) | `/connections` "Withdraw" (`withdrawApproval` → `handoffs.revoke`) is offered for a claimed multi-step request, which MCP and Telegram now treat as in the signing flow. | Pre-existing browser action, not changed; recorded in §13 for the owner. |


**Domains not separately reviewed (recorded skips).** `agent_guard.py review` also expects the action domains because `src/platform/` is shared
financial core: **flofi-swap, flofi-bridge, flofi-lending, flofi-liquidity, flofi-transfer-payments, flofi-payments-billing** — no action
adapter, composition, execution, fee or payment path changed; the only shared-core change is the read-only `conversation-state.ts` derivation
(reviewed by flofi-workflow twice) and an additive `observing` flag on run progress. **flofi-admin-analytics, flofi-automations** — no admin,
analytics or automation code changed (selected through module dependencies only; `get_automation_status` is untouched). Reviews of batches 1–3
ran on earlier commits of this branch; every later change was a fix of their findings and was covered by batch 4 or by the reviewer that raised it.

## 11. Platform distribution requirements (checked 2026-11-24)

- **ChatGPT:** full MCP in Developer mode is documented for Business and Enterprise/Edu workspaces on the web; an admin may need to enable it
  and create the app with the remote MCP URL; OAuth via CIMD is supported; refresh tokens need `offline_access` discoverable (now advertised).
  FloFi is not in the ChatGPT app directory; directory listing would require OpenAI review and its money-movement rules
  ([developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), [guide](https://developers.openai.com/api/docs/guides/developer-mode.md)).
- **Claude:** custom connectors with remote MCP and OAuth on Free (one connector), Pro, Max, Team and Enterprise; hosted callback
  `https://claude.ai/api/mcp/auth_callback`. FloFi is not in Anthropic's connector directory; listing requires submission and review
  ([remote MCP](https://claude.com/docs/connectors/custom/remote-mcp), [authentication](https://claude.com/docs/connectors/building/authentication), [submission](https://claude.com/docs/connectors/building/submission)).
- **Telegram:** Bot API webhook with secret token; private chats only; no in-chat wallet signer (signing opens FloFi).
- Policy: both directories restrict financial-transfer apps; private/custom connectors were the target in BUILD-MCP-002. The owner must
  re-check current usage policies before public promotion. No platform restriction is bypassed.

## 12. Test results (local engineering evidence; CircleCI is the certification authority)

Toolchain: Node `24.21.0`, pnpm `11.22.0` (pinned), Playwright `1.63.0` with the preinstalled Chromium `1243`. PostgreSQL: a disposable loopback
**PostgreSQL 16.15** cluster (Docker was unavailable; CI uses 18.6). No provider, wallet, RPC transaction or real funds were used; flows are
MOCKED/fixture doubles.

| Gate | Result |
| --- | --- |
| `pnpm check` (typecheck 17 tasks, lint, build 9 tasks, schema export check, unit suite) on `dfb46ea` (final code) | **Passed**: 777 files / 10,028 tests; 2 files / 2 tests skipped (existing owner-fixture gates, not passes) |
| `pnpm test:postgres` on `7750124` | 147 files / 1,016 tests passed; **6 failed, all PostgreSQL-version artifacts unrelated to this diff** (no file under `packages/` or `apps/reference-dapp/backend/` changed): `backend/database-privileges.pg.test.ts` ×5 (`unrecognized privilege type: "MAINTAIN"` — a PostgreSQL 17+ privilege — and cascaded grant failures) and `packages/cloud-runtime/test/forward-compatibility.pg.test.ts` ×1 (PostgreSQL 18 NOT NULL constraint catalogue). Neither these tests nor any code they exercise is touched by this build; they were not re-run on unmodified `main` locally. They must pass on CI's PostgreSQL 18.6. |
| Focused suites incl. PostgreSQL after the last fixes (channels, MCP, platform) | 732 passed, 3 skipped (existing); earlier run incl. workflow runs: 899 passed |
| New suites | `platform/conversation-state.test.ts` (10), `mcp/account-tools.test.ts` (14), `channels/telegram/universal-actions.test.ts` (5), `channels/telegram/universal-actions.pg.test.ts` (7) — all pass |
| Browser: `playwright.docs.config.ts` (`e2e/site.spec.ts`) against the local production build on loopback | **20/20 passed**, incl. Docs in both languages and no horizontal overflow at 320/390 px on `/docs/mcp-integrations` |
| `python3 scripts/governance_lite.py`; governance self-tests (21); `test_ci_*` (336); `git diff --check` | Passed |
| `python3 scripts/agent_guard.py check` | PASS (new sources and suites mapped in `coverage.json`) |
| `python3 scripts/agent_evolution.py --base origin/main` | Advisory skill-source notes only (pre-existing PENDING_VERIFICATION sources); no action for this build |

Not run locally: the full guarded browser profiles (they need the pinned Foundry Anvil fork, not installed here), fork suites, live provider
suites and SBOM/audit jobs — CircleCI runs them. Production endpoints could not be reached from this environment.

## 13. Remaining limitations (not delivered by this build)

- **Saved/reusable workflows from ChatGPT/Claude/Telegram:** needs an IR→StrategySpec contract or a strategy store keyed by proven wallet;
  deferred to avoid a schema change without review.
- **Telegram account linking, portfolio and history:** needs a new consented chat↔wallet link (the existing automation code is consented for
  notifications only and is not repurposed).
- **Telegram exact grammar:** a second exact `bridge …` command while a bridge is pending is answered "could not read" (pre-existing; reproduced
  in `decideTurn` without this change); typing a fresh command after NEW works.
- **History** is the newest 25 runs per linked wallet (≤4 wallets) on remote-runtime deployments; older runs are read by id.
- **No asynchronous MCP notifications** are promised; ChatGPT/Claude read status when asked.
- Through MCP, the **Aave** position scan reports UNAVAILABLE on a beta-gated deployment (reserve reads require the web session's Flight
  access); balances and Uniswap/Orca scans are unaffected. Follow-up: read reserves with the gateway's verified beta identity.
- `/connections` still offers "Withdraw" for a claimed multi-step request (pre-existing); MCP and Telegram refuse to cancel it.
- `get_portfolio` RPC reads are not aborted when the MCP request ends (they finish in the background within their own time budget).
- Telegram STATUS keeps its existing wording; it does not show `conversationState`.
- The public privacy policy page does not yet describe MCP connections (pre-existing); updating legal text is an owner/legal decision.
- Wallets linked before `FLOFI_MCP_PORTFOLIO_LINKS_FROM` must be re-linked on `/connections` before `get_portfolio` reads them.
- A Telegram action button on an **older** approval message acts on the conversation's current proposal (as typing the command would): it
  can only show status, keep the step or withdraw the newer, not-yet-applied proposal, and each reply says which.
- Live ChatGPT/Claude/Telegram/wallet acceptance, CircleCI certification and production verification are listed in §15.

## 14. Production configuration

**One new variable, required only to turn on `get_portfolio`:**

| Variable | Service | Value | Purpose |
| --- | --- | --- | --- |
| `FLOFI_MCP_PORTFOLIO_LINKS_FROM` | Vercel project serving `/api/mcp` and `/connections` — **Production scope only** | UTC instant, e.g. `2026-11-25T12:00:00Z` | Balance/position reads use only wallet links created at or after it, i.e. under the Connections text that discloses those reads. Not a secret. |

Provisioning: (1) merge and deploy; (2) confirm the production alias serves the new `/connections` text; (3) set the variable to a UTC instant
**at or after** that moment (round up: later is safe, earlier would count links made under the old text); (4) redeploy (Vercel applies
variables per deployment); (5) leave it unset in Preview so Preview stays fail-closed. Railway API and worker need nothing. Users whose
wallets were linked earlier re-link on `/connections` (one sign-in message) to allow balance reads; `get_account` shows `balancesReadable`.

Everything else uses existing settings: `FLOFI_MCP`, `FLOFI_MCP_OAUTH`, `FLOFI_PUBLIC_ORIGIN`, the network enablement and price
source the Dashboard portfolio already uses, and the remote cloud API base URL / `API_AUTH_TOKEN` the MCP status reads already use. Telegram
uses its existing `FLOFI_TELEGRAM*` / `FLOFI_CHANNEL*` settings. If a deployment caches tool lists, reconnect the connector (or refresh the
app's tool list in ChatGPT workspace settings) to see the new tools.

## 15. Manual acceptance still required (owner/tester; not done here)

1. ChatGPT (eligible workspace) and Claude: connect `https://flofi.xyz/api/mcp`, OAuth; `get_account` with zero and one linked wallet; link a
   wallet on `/connections`; `get_portfolio`, `list_executions`; compose → review → `request_user_approval`; open the link on desktop and
   mobile; **stop before signing** unless the owner explicitly authorizes a specific real transaction; `cancel_approval` on a PENDING request;
   `get_approval_status` after a real owner-signed execution shows CONFIRMED only after reconciliation.
2. Telegram private chat EN and PT: proposal message shows Authorize + Check status / Add another action / Cancel request; taps behave as the
   typed commands; after loading a proposal in FloFi, "Add another action" starts a separate workflow and "Cancel request" says it can no
   longer be cancelled here.
3. Record public facts only (no tokens, cookies, private links). A refusal or expiry is not a pass.

## 16. Rollback

1. **Unset `FLOFI_MCP_PORTFOLIO_LINKS_FROM`** in Vercel Production first (portfolio reads fail closed).
2. Revert the merge commit of this PR (or use Vercel Instant Rollback) and redeploy through the existing pipeline. There is no migration or
   data to revert; open approvals remain valid (states and secrets are unchanged); clients that cached the new tool list get `-32602` for the
   removed tools until they reconnect; removing `offline_access` from metadata only affects future ChatGPT connector setup.
3. When rolling forward again, set the variable to a **new** instant after the new Connections text is live again (links made while the old
   text was served must not qualify), then redeploy.
