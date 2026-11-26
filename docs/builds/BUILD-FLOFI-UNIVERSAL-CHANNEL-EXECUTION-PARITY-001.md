# BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: conversational execution parity (ChatGPT, Claude, Telegram)

Branch `claude/sleepy-meitner-ag24n7` from `origin/main` `a62382d133b97dcfb9ff88b3c0dc0379f58a1c86` (the PR #255 merge commit; PR #255 was
already merged when this build started). Governance: GOVERNANCE-LITE ([scope guard](../SCOPE_GUARD.md)). Evidence levels follow
[EVIDENCE_LEVELS](../EVIDENCE_LEVELS.md). Everything below is local/automated engineering evidence (MOCKED chains, fixture providers, loopback
PostgreSQL). No real-money transaction, wallet signature, provider message, deployment, migration or production configuration change was made.

## 1. Executive summary

| Status | Meaning here |
| --- | --- |
| ENGINEERING COMPLETE (partial scope) | WS02 panel transport fixes, WS03 one-confirmation parity for MCP and Telegram, WS09/WS10 presentation fixes |
| CI CERTIFIED | Pending: CircleCI certification of the PR head (reported in the PR, not claimed here) |
| READY FOR OWNER ACCEPTANCE | Yes for the changed paths, with the procedure in section 13 |
| LIVE VERIFIED | No. No real host, wallet or mainnet journey was run by this build |
| BLOCKED BY HOST OR WALLET | Genuine signing inside ChatGPT/Claude mobile apps and Telegram, which have no injected wallet provider (section 6) |
| BLOCKED BY OWNER CONFIGURATION | A mobile signing transport (WalletConnect/Reown or MetaMask Connect needs a project id and an external relay); the exact ChatGPT sandbox origin for `FLOFI_MCP_FRAME_ANCESTORS` must be observed on the real host |

The owner's incident had four independent causes. Three are fixed in code; the fourth (a wallet transport for hosts without an injected
provider) needs an owner decision and is documented, not hidden behind an external button.

## 2. Baseline audit and PR preservation

- `origin/main` = `a62382d` (PR #255 merge). PR #255 changes (Orca sequencing, Uniswap authorization invalidation, zero-decimal amounts, Agents
  connection controls) are untouched by this diff.
- PR history was reviewed through the merged code and the build records in `docs/builds/` (UNIVERSAL-CHANNELS-001, SINGLE-CARD-ONE-CONFIRMATION-001,
  CHAT-FIRST-RESTORE-001, BETA-CRITICAL-RECOVERY-001, MULTICHAIN-WALLET-RESOLUTION-001, MAINNET-BRIDGE-RECONCILIATION-003). The GitHub
  descriptions of PRs #243 to #254, and which fixes of the closed PR #252 later landed, were **not re-audited** in this pass.
- Preserved by construction: the diff does not touch OAuth, scopes, refresh tokens, redirect-host validation, beta access, Privy provisioning,
  wallet resolution, quotes, slippage, Relay settlement, the batch builder, the batch fallback, reconciliation cadence, migrations, fee model,
  Orca/Uniswap invalidation or `formatTokenAmount`.

## 3. Root causes of the owner incident (24-11-2026, ChatGPT, Arbitrum One, 1 USDC to WETH, MetaMask)

The owner's figures are treated as observations. The durable execution record was **not** inspected: the FloFi production connector is not
authorized in this session.

| # | Observation | Root cause (code) | Fix |
| --- | --- | --- | --- |
| 1 | "Opening your wallet review in this chat..." never cleared | `mcp/app/panel.ts`: the panel unhid the signing frame on its handshake but never re-rendered, so its own "opening" notice stayed. Probable second cause, not reproducible here: `/mcp/approve` allows only `https://chatgpt.com` and `https://web-sandbox.oaiusercontent.com` as ancestors, while the MCP Apps specification lets a host serve a view from a default, typically per-conversation, sandbox origin when `ui.domain` is not declared. A refused frame never answers | Re-render on handshake; bounded lifecycle (10 s after a load with no answer, 5 s when the frame chain is not allowed, 25 s otherwise) with closed codes `HOST_FRAME_BLOCKED`, `HOST_FRAME_ORIGIN_NOT_ALLOWED`, `HOST_FRAME_TIMEOUT` and the observed public origins; optional `FLOFI_MCP_FRAME_ANCESTORS` |
| 2 | "Open in MetaMask" opened the wallet home | `https://metamask.app.link/dapp/<host>/approve#<secret>` is a navigation into MetaMask's browser, not a signing request. When the universal link falls back through the web redirect (in-app browsers often prevent universal links), the fragment that carries the private link never reaches the app. Not reproduced here | Worded as "Open FloFi in MetaMask" with what it does and the private-link fallback. A genuine mobile signing transport is section 6 |
| 3 | Simulation and Review could not finish in ChatGPT | Follows from 1 | As 1 |
| 4, 5 | Approval and swap needed several clicks and two wallet requests | A one-step MCP/channel proposal was always `SINGLE_FLOW`; `/approve` runs it through the card's own flow (approval `eth_sendTransaction`, "Continue to swap", on Arbitrum One a second Review). The one-confirmation run of BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 was Editor-only (`useEditorWorkflowRun` requires `surface === 'workspace'`; `prepareApprovalRequest` refuses `singleStepRun` for external requesters) | WS03 (section 5) |
| 6 | Extra interaction at reconciliation | Not reproduced without the record. The per-flow path follows automatically since PR #254 | Not changed; acceptance in section 13 |
| 7 | Minimum, fee ceiling and cost not at six significant digits | `components/signing-surface.tsx` printed `simulationAmount` strings (full precision) for fees, limits and known costs | Shared `TokenAmountText` with purpose rounding |
| 8 | Approval and swap shown as two "Swap · Confirmed" | The signing surface labelled every operation with the step's action | Approval rows use their own title ("Approve USDC") |
| 9 | Heading stayed "Ready for review" | The `/approve` notice text was fixed once the proposal loaded; the panel heading was unconditional | `domain/approval-notice.ts`; `panelPresentation` |
| 10 | Received WETH missing | The signing surface never rendered the compact receipt of PR #254, only raw costs; the `/approve` run panel (the WS03 path) showed no received amount at all. The Canvas card case was not reproduced without the record | Signing surface renders `ExecutionResultSummary`; the run panel shows each reconciled step's received amount (`domain/run-outcome-amounts.ts`) |
| 11 | Mixed PT/EN | Panel was English-only; the `/approve` mobile wallet section was hard-coded English | Panel follows `hostContext.locale`; strings translated |

## 4. Architecture (no new engine, lifecycle or service)

```
ChatGPT / Claude (MCP Apps panel)   Telegram (URL button)   Developer API
            \                              |                    /
             +---- shared platform: compose -> review -> requestApproval (approval service) ----+
                                           |
                       SINGLE_FLOW plan  or  SEQUENTIAL run of 1 step (new, server-decided)
                                           |
              /approve (embedded as /mcp/approve in the panel frame)
              wallet proof -> claim -> ensureForClaim -> WorkflowRunPanel
              -> user-funded group: planExecutionGroups + buildEvmGroupCalls -> ONE wallet_sendCalls
              -> independent chain reconciliation -> receipt -> panel / get_approval_status / Telegram notify
```

One canonical engine, one workflow identity (the step's own hash), one run lifecycle (`workflow-runs`), one reconciliation source. Channel
adapters only differ in presentation and transport.

## 5. WS03: single-card one-confirmation parity

`platform/external-single-step.ts` decides, server-side and fail closed. Every condition is required:

1. requester is `MCP_ACCOUNT` or `CHANNEL_CONVERSATION` (automations and the Developer sandbox keep `SINGLE_FLOW`; the live Developer API already
   had its own one-step runs);
2. exactly one step on an EVM chain whose flow the user-funded groups build: `{base,arbitrum,ethereum,robinhood}-swap`, certified
   `crosschain-router-*`, `*-mainnet-transfer`, `{base,arbitrum,ethereum}-aave` (and their engineering test-network counterparts);
3. `FLOFI_WORKFLOW_RUNS=enabled` and user-funded groups on that chain (a bridge also needs a certified batch route from it);
4. migrations 0032 and 0033 active with their certified identities (`singleStepRunsSupported`);
5. every run gate passes.

Otherwise the proposal keeps `SINGLE_FLOW` exactly as before. `ensureForClaim` re-checks the stored plan. The Editor-only `singleStepRun`
opt-in stays refused for external requesters. The run's own Review still decides the wallet interaction: `ONE_WALLET_CONFIRMATION` only for a
wallet that reports EIP-5792 atomic on that chain; otherwise `STEP_BY_STEP` (the card's own flow, as before).

**Contract note (additive, reviewed):** for an eligible one-step proposal `request_user_approval` and the Telegram proposal now report
`executionPlan: "SEQUENTIAL"` with `authorizationPlan`, and status reads carry `workflowRun`, exactly as multi-step proposals already do. Tool
names, inputs and the error shapes are unchanged.

| Card | Wallet with EIP-5792 atomic on the chain | Wallet without it, FloFi Wallet (Privy) |
| --- | --- | --- |
| Catalog swap, allowance short (Arbitrum One, Base, Ethereum) | 1 confirmation: `[exact approve, swap]` (PG-tested) | Own flow, 2 requests (unchanged) |
| Catalog swap, allowance sufficient | 1 confirmation | 1 confirmation |
| Aave supply / borrow / repay / withdraw, transfer | 1 confirmation (Editor suites) | Own flow (unchanged) |
| Certified Router bridge | 1 confirmation where a batch route is configured | Own flow |
| Relay bridge, Uniswap/Orca liquidity, ERC-20 to native, Solana, token-paid gas | Not batched (unchanged, never promised as one) | Unchanged |

Activation in production depends on 0032/0033 being applied and on the user-funded configuration. This environment cannot read production,
so whether the path is active today is **unknown**; it is dormant (SINGLE_FLOW) until those conditions hold.

## 6. Wallet transport evaluation (WS02)

| Transport | Genuine financial authorization inside the host? | Status |
| --- | --- | --- |
| Injected EIP-1193 / EIP-6963 in the `/mcp/approve` frame | Only on desktop browsers whose wallet extension injects into nested cross-origin frames, and only when the host's frame chain is allowed | Implemented (existing). Not verified on real ChatGPT or Claude |
| EIP-5792 `wallet_sendCalls` | Yes, the batch is the reviewed request | Used by WS03 |
| EIP-7702 | Wallet-driven upgrade inside the confirmation; not FloFi-controlled | Unchanged |
| WalletConnect / Reown, MetaMask Connect | The only option for hosts without an injected provider (ChatGPT and Claude mobile apps, Telegram webviews). Needs a project id, an external relay, CSP `connect-src` for the relay, a new dependency and a licence review | **Not added: owner decision** (external service, credentials, possible cost) |
| Phantom encrypted deep links (`signTransaction`) | A genuine Solana mobile signing protocol without an SDK, but needs an x25519 session and a redirect back | Not implemented; candidate |
| Wallet browser deep links (MetaMask, Phantom) | No: navigation only | Reworded honestly |
| Privy (FloFi Wallet) | Signs in its own origin; no `wallet_sendCalls` | Unchanged; not verified inside a host frame |
| Telegram Mini App | No wallet is injected in Telegram's webview; a Mini App alone does not create a signing transport | Not implemented; depends on the transport decision above |

## 7. Security and ownership model

Unchanged authority: the model, OAuth, an MCP account, a Telegram message and an approval link authorize nothing. The new one-step decision is
server-side only and cannot be forced by a caller. `FLOFI_MCP_FRAME_ANCESTORS` accepts only exact `https` origins on `oaiusercontent.com` and
`claudemcpcontent.com` (no wildcard, path, port or user info; at most 8); without a valid public origin nothing may frame `/mcp/approve`. The
panel's model-context report stays an explicit projection of public facts (ids, states, validated FloFi receipt URLs); private approval links
never enter it.

## 8. Channel capability matrix

Classification: SUPPORTED, CONDITIONAL, UNSUPPORTED, HOST_BLOCKED. Validation: NOT_TESTED, ENGINEERING_VERIFIED, LIVE_VERIFIED.

| Channel | Review in channel | Signing in channel | One confirmation (eligible EVM card, atomic wallet) | Automatic reconciliation | Receipt in channel | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| FloFi Web Chat / Editor | SUPPORTED | SUPPORTED | SUPPORTED | SUPPORTED | SUPPORTED | ENGINEERING_VERIFIED |
| ChatGPT web, desktop browser + MetaMask extension | CONDITIONAL (frame chain allowed) | CONDITIONAL (extension injects in nested frame) | CONDITIONAL (WS03 active) | SUPPORTED (server) | SUPPORTED (panel polls; status tools) | ENGINEERING_VERIFIED (mocked host); NOT_TESTED live |
| Claude web, desktop browser + MetaMask extension | CONDITIONAL | CONDITIONAL | CONDITIONAL | SUPPORTED | SUPPORTED | ENGINEERING_VERIFIED (mocked host); NOT_TESTED live |
| ChatGPT / Claude mobile apps | CONDITIONAL | HOST_BLOCKED (no injected provider) | HOST_BLOCKED | SUPPORTED | SUPPORTED | NOT_TESTED |
| Telegram bot | CONDITIONAL (preview in chat; full Review on `/approve`) | HOST_BLOCKED inside Telegram; external `/approve` page only | CONDITIONAL (WS03, on `/approve`) | SUPPORTED | SUPPORTED with status sharing | ENGINEERING_VERIFIED (PG); NOT_TESTED live |
| Telegram Mini App | UNSUPPORTED (not implemented) | UNSUPPORTED | UNSUPPORTED | n/a | n/a | n/a |
| Developer API (production) | n/a (owner on `/approve`) | `/approve` | SUPPORTED (existing) | SUPPORTED | via status endpoints | ENGINEERING_VERIFIED |

Networks and actions follow the registry unchanged: Solana actions sign once through their own flows (Phantom, Solflare); Robinhood Chain swaps
keep their own flow where not batchable; liquidity and Relay bridges are never presented as one confirmation.

## 9. Financial presentation rules (WS09)

The signing surface uses the shared `TokenAmountText`: minimum received rounds down, fee ceilings and recorded costs up, estimates to the nearest
with "≈"; no scientific notation; exact value one tap away; EN/PT separators. Examples (unit-tested in EN and PT): `0.000589872367683721 WETH`
reads `0.000589872 WETH`; `0.0000089732844 ETH` reads `0.00000897329 ETH`. `formatTokenAmount(units, 0)` (PR #255) is untouched.

## 10. Regression evidence (this environment)

| Suite | Result |
| --- | --- |
| `platform/external-single-step.test.ts` (new) | Rule, eligibility, never forced, Solana keeps SINGLE_FLOW |
| `editor/single-card-run.pg.test.ts` (+1 case, PostgreSQL 16 locally) | Incident shape: a channel request of the Arbitrum swap becomes ONE run and ONE atomic batch `[exact approve, swap]`, nothing sent by FloFi |
| `editor/single-card-strategy.test.ts` (intentional change) | MCP/channel stored one-step runs now reach the certified-schema gate; automations and Developer sandbox still refused; ungrouped flows and stored-plan-only forgeries refused |
| Affected suites after review fixes (`mcp`, `platform`, `channels`, `editor`, `workflow-runs`, unit + PostgreSQL 16) | 123 files, 1019 tests passed locally |
| Full unit suite (`pnpm test`, before the review fixes) | 802 files passed, 2 skipped (pre-existing); 10351 tests passed |
| `mcp/app/panel.test.ts` (new) | State-aware heading/badge, never "Review" after the signing flow, EN/PT, serialized function closes over nothing, bounded frame codes |
| `server/embedded-approval.test.ts` (+1) | Exact-origin configuration, pattern rejection |
| `domain/approval-notice.test.ts` (new), `components/signing-surface.test.tsx` (+1) | Notice phases; six-significant-digit incident amounts EN/PT |
| `domain/run-outcome-amounts.test.ts` (new) | A reconciled run step shows its received amount (0.000595831 WETH for the owner-observed value), resolved only through the catalog |

Local PostgreSQL was 16.15; CircleCI certifies on 18.6. Browser profiles (`mcp-in-chat`, `channel-signing`) were updated for the renamed labels
but not run here. The 45 scenarios of the build request are mapped in the PR description; most real-host scenarios remain owner acceptance.

## 10a. Specialist findings (read-only reviewers: flofi-security, flofi-workflow, flofi-mcp)

No blocker. Fixed in this PR:

- **Panel wording diverged from the canonical lifecycle (mcp, major).** `panelPresentation` now derives heading, badge, notice, actions and
  polling from the server's `conversationState` (`approvalState`); a table test runs both on the same progress. The model-context report carries
  `conversationState` and the run's `code`/`halted`.
- **Unknown batch outcome shown as "Ended" (security, workflow, mcp).** A run or step/group with `WALLET_BATCH_OUTCOME_UNKNOWN` reads "may have
  executed" in the panel and on `/approve`, never "Ended", and polling continues. Never-run steps read "Not run" (was "Already done").
- **Panel URI cache (mcp, major).** New URI `ui://flofi/approval-panel-chat-first-v2.html`; v1 and the legacy URI stay registered with the same
  document.
- **Fast-fail could tear down a working frame (security, mcp).** Waits are fixed (10 s after load, 25 s overall); the chain check only names the
  failure, and a masked `null` ancestor is unknown, not refused.
- **One-step consent (workflow major, security).** Without the owner's status sharing, an external one-step run's state is withheld exactly as
  for a SINGLE_FLOW proposal (`statusHidden`, `STATUS_UNKNOWN NOT_SHARED`).
- **Refusal after the claim committed (workflow).** `/approve` checks one-step support before the claim, so nothing is left CLAIMED without a run.
- **Claim re-check (security).** `ensureForClaim` requires both the stored plan and the freshly composed plan to be one grouped step.
- **Base to Arbitrum One Router (workflow).** `crosschain-router` added to the allowlist.
- **Cheap refusals first (security).** The one-step reads run after the test-network refusal.
- **Shared OpenAI file host (security).** `https://files.oaiusercontent.com` is refused in `FLOFI_MCP_FRAME_ANCESTORS`; only FloFi-exclusive
  sandbox origins may be listed.
- **Tool descriptions (workflow, mcp).** `get_approval_status` and `cancel_approval` describe one-step run approvals.

Documented, not changed:

- A claimed one-step run cannot be withdrawn from the conversation (`cancel_approval` refuses `WORKFLOW_RUN_STARTED`; Telegram treats it as
  started). Conservative; the owner ends it on `/approve`.
- Request-time eligibility does not prove the step can be batched (ERC-20 to native, Stock Tokens, contract recipients, slippage above the batch
  limit, Robinhood Gasless): such a proposal becomes a run whose Review plans the card's own flow (no one-confirmation benefit, same safety).
- A bridge is eligible when any certified batch route starts from its chain; the exact pair is checked by the batch builder at preparation.
- Telegram sends no "loaded in FloFi" notice for a one-step run; it reports the outcome when shared.
- `ui.domain` / `openai/widgetDomain` not declared (a host-dependent value could break the other host); `get_capabilities` still lists the
  per-step plan.
- Not reviewed in this pass: flofi-wallet-execution, flofi-channels, flofi-developers, flofi-automations, flofi-transfer-payments. The diff
  reuses the existing user-funded batch path unchanged; automations and the Developer API behavior are unchanged.

## 11. FinOps and infrastructure

No new dependency, service, credential, project id, database object or migration. One optional, non-secret environment variable:
`FLOFI_MCP_FRAME_ANCESTORS` (Vercel, the web tier serving `/mcp/approve` and `/api/mcp`). Cost: none. A WalletConnect/Reown transport would add an
external relay dependency and a project id (free tier with usage limits, paid tiers beyond): owner decision.

## 12. Limitations

- No real host was exercised; the ChatGPT sandbox origin is not known from here. If the panel reports `HOST_FRAME_ORIGIN_NOT_ALLOWED`, its
  Technical details list the exact origins; adding them to `FLOFI_MCP_FRAME_ANCESTORS` is the owner's step. Whether to declare `ui.domain` (a
  host-dependent format shared by ChatGPT and Claude) is left open because a wrong value could break the other host.
- Mobile hosts and Telegram cannot sign in channel without a new transport (section 6).
- A wallet batch's hash still comes from the owner's browser (`wallet_getCallsStatus`); if the frame closes right after sending, the run waits
  until the page is reopened (BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 §5). Nothing is resent.
- WS05, WS06, WS11 and WS12 were audited only as far as the changed paths; no new behavior was added there.
- Items 6 and 10 (Canvas card) were not reproduced without the durable record.

## 13. Release, rollback and owner acceptance

Deployment order unchanged: Railway API, Railway worker (no behavior change in either), then Vercel. Rollback: revert the PR; no data, schema
or configuration migration is involved. Stored one-step SEQUENTIAL handoffs created meanwhile stay valid runs (the run machinery predates this
build); unset `FLOFI_MCP_FRAME_ANCESTORS` to return to the fixed list.

Owner acceptance (independent account, mainnet, explicit authorization of the specific transaction; stop before signing otherwise):

1. Record deployment SHA, host and client (ChatGPT web on desktop Chrome first), browser and OS, MetaMask version.
2. Ask: "Swap 1 USDC to WETH on Arbitrum". Confirm the panel shows "Review swap" in your host's language.
3. Choose "Authorize in chat". Expected: the review opens within seconds in the panel. If an error appears, open Technical details and note
   `code`, `frameChain` and `notAllowed`; set `FLOFI_MCP_FRAME_ANCESTORS` to the exact `notAllowed` sandbox origin(s), redeploy, repeat.
4. Prove the wallet, check the fresh simulation (minimum and fee ceiling at six significant digits), choose Authorize in wallet. Count wallet
   prompts: with 0032/0033 and user-funded groups active and MetaMask reporting atomic on Arbitrum One, expect ONE batch confirmation.
5. Do not click refresh. Expect "Confirming on chain", then "Completed" with the received WETH and the recorded cost; record the transaction
   hash, public approval id and execution id (never the private link).
6. Ask "Now supply the WETH I received to Aave" and confirm the new proposal does not include the completed swap.
7. Repeat on Claude web, then Telegram (expect the external `/approve` page; in-Telegram signing is HOST_BLOCKED).
