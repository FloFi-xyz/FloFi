# BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001

| | |
|---|---|
| Baseline | `origin/main` at `25dceebd5cf92a9d5b056095b281632b24c86e2c` (merge of PR #259, BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001) |
| Branch | `claude/compassionate-curie-fmhg6j` |
| Commits | WS01: `3bb39ce`, `2e1e180`. WS02: the Batch Payment commit on top of them |
| Workstreams | WS01: MCP corrections from the external technical review (TheSmith, 2026-11-26). WS02: native Batch Payment ("Pagamento em lote") |
| Status | See [Final status](#final-status) |

Nothing in this build executes a real-money transaction, deploys, merges or changes production configuration. Every execution test runs on
loopback doubles or a closed replay (evidence `MOCKED`).

## 1. Prior work reviewed

PRs #249 to #259 were read before any change (#252 was not merged):

| PR | Build | Relevance here |
|---|---|---|
| #249 | BETA-UX-INTELLIGENCE-001 | Account wallets and workflow propagation that the Batch Payment Canvas card reuses (estimates, card status) |
| #250 | MAINNET-BRIDGE-RECONCILIATION-003 | Reconciliation bindings: the basis for the exact Batch Payment bindings |
| #251 | Multichain wallet resolution | The account-wallet resolution that `get_account` reports |
| #253 | BETA-CRITICAL-RECOVERY-001 | The wallet-batch fallback that Batch Payment now explicitly refuses |
| #254, #255 | Execution / consolidated hotfix | Prompt reconciliation that the batch legs use unchanged |
| #256, #257 | UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (+ test fix) | One-confirmation parity for MCP and Telegram that Batch Payment inherits |
| #258 | POST-257-HOTFIX-001 | The MCP corrections WS01 builds on |
| #259 | NATIVE-CHANNEL-SIGNING-001 | Native Phantom/Solflare signing from ChatGPT, Claude and Telegram, preserved unchanged |

## 2. WS01: traceability matrix of the external findings

| # | Finding | Classification | Evidence | Result |
|---|---|---|---|---|
| P0 | A wallet is linked but the portfolio is unreadable (`balancesReadable: false`, `PORTFOLIO_RELINK_REQUIRED`); re-linking did not help | **CONFIGURATION ISSUE** plus a **CONFIRMED** software defect in the answer | `FLOFI_MCP_PORTFOLIO_LINKS_FROM` is absent from the Production environment (Vercel listing, read only). Without it, no link has consent, and the code answered `PORTFOLIO_RELINK_REQUIRED`, which no re-link can fix | Fixed in code (honest states, below). Production remediation is in [§9](#9-production-configuration-cto-approval-required) for CTO approval |
| P1 | A 9-step workflow became an 8-step one silently | **EXTERNAL HOST LIMITATION** plus a **MISSING IMPLEMENTATION** (coded refusal) | No truncation in FloFi: a 9-step list was refused at SDK input validation with an uncoded plain-text error, logged as outcome OK. The host or model then dropped a step | Coded, explained refusal; authoring safeguard; telemetry. 8-step limit kept |
| P2 | Help: "Can I cancel a request before signing, and what if a transaction has already been sent?" | **MISSING IMPLEMENTATION** | No platform topic covered withdrawal, wallet rejection, sent, pending, unknown and confirmed outcomes | New EN and PT topic |
| P2 | Readiness is implicit (valid ≠ executable) | **MISSING IMPLEMENTATION** | Results said `valid` or `ok` only | Additive `readiness` block |
| S1 | OAuth PKCE S256 only | ALREADY IMPLEMENTED AND VERIFIED | `mcp/oauth/server.ts`, `crypto.ts`, `foundation.test.ts`, `server.pg.test.ts` | Unchanged |
| S2 | Exact redirect URI and CIMD validation | ALREADY IMPLEMENTED AND VERIFIED | `mcp/oauth/cimd.ts` and its tests | Unchanged |
| S3 | Token audience / resource binding (RFC 8707) | ALREADY IMPLEMENTED AND VERIFIED | OAuth server and gateway tests | Unchanged |
| S4 | Scope enforcement, token expiry, revocation, refresh rotation with family revocation | ALREADY IMPLEMENTED AND VERIFIED | `mcp/oauth/*.pg.test.ts` | Unchanged |
| S5 | Cross-account isolation of links, approvals and runs | ALREADY IMPLEMENTED AND VERIFIED | Account-scoped stores and tests; the new `portfolio-consent.pg.test.ts` adds a cross-account case | Identity text corrected to say approvals are account-scoped |
| S6 | Session ownership, Origin validation (DNS rebinding), SSRF for outbound fetches, confused deputy | ALREADY IMPLEMENTED AND VERIFIED | Gateway and CIMD tests | Unchanged |
| S7 | Approval ownership and expiry; review-to-signature hash binding; duplicate submission prevention | ALREADY IMPLEMENTED AND VERIFIED | Handoff, native-signing and run tests | Unchanged; Batch Payment adds its manifest to the same hash |
| S8 | Idempotency of `request_user_approval` / `cancel_approval` | IMPLEMENTED BUT NOT VERIFIED (by design, partial) | Effect-unknown answers are `retryable: false`; supersession replaces a repeated request; no idempotency key | Documented limitation (§11) |
| S9 | Sanitized logging and traceability | Gateway: ALREADY IMPLEMENTED AND VERIFIED. OAuth endpoints: IMPLEMENTED BUT NOT VERIFIED (no request id) | `gateway.ts`, redacting logger, `server.pg.test.ts` | Documented limitation (§11) |

No finding was classified UNRESOLVED.

### 2.1 Root causes and corrections

**P0 (portfolio).** `get_portfolio` reads balances only for wallets linked at or after the instant in `FLOFI_MCP_PORTFOLIO_LINKS_FROM`
(the consent cut-off introduced with the Connections disclosure). Production does not set it, so every link is outside consent. The software
answered `PORTFOLIO_RELINK_REQUIRED`, but re-linking cannot create consent while the deployment has none. Corrections
(`mcp/config.ts`, `mcp/gateway.ts`, `mcp/account.ts`, `mcp/tools.ts`):

- `portfolioConsent(env, now)` returns `ENABLED {since}`, `NOT_YET_EFFECTIVE {since}` or `NOT_ENABLED {cause: UNSET_OR_INVALID | BEFORE_DISCLOSURE}`.
- A cut-off before the production go-live of the disclosure (`PORTFOLIO_DISCLOSURE_LIVE_FROM = 2026-11-24T04:40:00Z`) would backdate consent, so it reads nothing and is logged without addresses.
- Impossible calendar dates are invalid instead of rolled forward.
- `get_portfolio` refuses `PORTFOLIO_READS_NOT_ENABLED` (`relinkHelps: false`), before spending the caller's rate budget. It refuses `PORTFOLIO_REQUIRES_FLOFI_ACCOUNT` without an account, and `PORTFOLIO_RELINK_REQUIRED` only when re-linking really helps, naming the wallets.
- `get_account` reports `portfolioReads` and, per wallet, a `balancesUnreadableReason`. Its next steps follow the state.
- Missing consent is never shown as a zero balance. There is no backdating, and nothing is granted without the owner's own link.

**P1 (9→8).** FloFi advertises `maxItems: 8` and refuses a ninth step. The refusal was uncoded and logged as OK, which invited the host to
"repair" the list silently. Corrections:

- Lists of 9 to 64 steps reach the tool and are refused with `WORKFLOW_TOO_MANY_STEPS` and a `userMessage`. The limit stays 8.
- The optional `expectedStepCount` (the steps as described to the person) refuses a list shortened on its way (`WORKFLOW_STEP_COUNT_MISMATCH`).
- SDK input refusals are logged as `MCP_INPUT_INVALID`.
- The instructions forbid dropping, merging or reordering steps.
- Tests: `mcp/step-limit.test.ts` (count, order, amounts, bindings, hash, both scopes).

**P2 help.** The new `CANCEL_AND_SENT_TRANSACTIONS` topic (`domain/intelligence/platform-guide.ts`, EN and PT) separates six outcomes:

- withdrawing a pending approval ("Cancel request" in Connections);
- rejecting in the wallet;
- submitted;
- pending confirmation;
- unknown outcome;
- confirmed.

It names the chain-specific replacement options and never calls a broadcast transaction cancelled. Test: `mcp/platform-help-cancel.test.ts`.

**P2 readiness.** compose, validate, review, simulate and request add a `readiness` block that leaves the existing fields untouched. It
covers authoring validity, simulation availability, review, execution, owner authorization and submission/reconciliation.

## 3. WS02: Batch Payment

### 3.1 What it is

One source wallet, one network, one asset, 2 to 8 recipients, each with its own exact amount. The amounts are equal only when the person
asks: the card has a "Same amount for all" action. The parts:

- **Semantic operation.** `batch_payment` {network, asset, recipients[{recipient, amount}]} in every channel's strategy, and the canonical IR node `asset.transfer.batch` (adapter `evm.batch-payment`, `packages/workflow-contracts/src/batch-payment.ts`).
- **Hash binding.** The node's closed declaration is the ordered manifest. Each recipient, amount, the order, the asset and the chain are bound by the semantic hash, and the exact integer total is its `MAXIMUM_INPUT`.
- **Execution.** `composeWorkflow` executes the batch as N ordinary transfer legs. Each leg is exactly that network's verified transfer declaration (no new contract, adapter or calldata path).
- **Workflow hash.** The hash binds `batches: [{step, legs:[from,to], workflowHash}]` only when a batch is present, so every existing workflow keeps its hash.
- **Atomic only.** The legs run as ONE atomic group: an EIP-5792 `wallet_sendCalls` with `atomicRequired: true` from the owner's own wallet (`EVM_WALLET_BATCH`), or the owner's smart-account user operation (`EVM_USER_OPERATION`).

### 3.2 Capability matrix

| Network | Native ETH | Catalog ERC-20 (non-stock) | Stock Token | Execution | Exposed |
|---|---|---|---|---|---|
| Base (eip155:8453) | yes | yes (e.g. USDC, WETH) | n/a | atomic wallet batch or smart-account user operation | **yes** |
| Arbitrum One (eip155:42161) | yes | yes (USDC, WETH) | n/a | same | **yes** |
| Ethereum (eip155:1) | yes | yes (USDC, WETH) | n/a | same | **yes** |
| Robinhood Chain (eip155:4663) | yes | yes (USDG, WETH) | **refused** (`BATCH_PAYMENT_ASSET_UNSUPPORTED`) | same | **yes** |
| Solana | — | — | — | no atomic multi-recipient path is implemented | **no** (explicit refusal) |
| Any testnet | — | — | — | — | **no** (mainnet only) |

The registry rows (`packages/action-registry/src/execution-capabilities.ts`) declare `asset.transfer.batch` on the four EVM mainnets with
evidence `null` and certification `IMPLEMENTED_UNCERTIFIED`. No owner-signed mainnet batch has been executed. The capability matrix
(`docs/builds/BUILD-FLOFI-MAINNET-PRODUCT-001-CAPABILITY-MATRIX.json`) and the certification matrix
(`docs/builds/BUILD-FLOFI-UNIVERSAL-E2E-001-CERTIFICATION-MATRIX.json`, web runtime "per group", flow `workflow-run`) were regenerated.

### 3.3 Atomic versus sequential guarantees

Batch Payment is **atomic only**. Sequential execution is never offered, so there is no partial-completion state to disclose:

| Situation | Behavior | Code |
|---|---|---|
| Owner chooses confirm-each-step | Refused before anything is prepared | `BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION` (`authorization-plan.ts`) |
| Wallet reports no atomic batch on the chain | Refused before a group is stored or anything sent | `BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE` (`execution-groups.ts`, `platform/approvals.ts`) |
| Planner would split the legs across groups | Refused | `BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE` |
| Wallet rejects the batch | Recorded; the batch is never continued leg by leg; resume refuses | `BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION` (`workflow-runs/service.ts`) |
| Duplicate click or reload in the same browser | The same prepared batch (same id) is returned; nothing new is asked of the wallet | hand-out check |
| Another browser asks for the batch | Refused | `WALLET_BATCH_HANDED_OUT_ELSEWHERE` |
| Timeout, disconnect or unknown outcome | The existing wallet-batch status and reconciliation decide; nothing is resent before the outcome is established | unchanged run machinery |
| A failed atomic batch | Every leg stays unexecuted; never reported as partial | the atomic group has one outcome |

Swap→Batch, Bridge→Batch, Swap→Bridge→Batch and Aave Withdraw→Batch compose through typed bindings. A batch consumer binds every leg
`exact: true`: each recipient receives exactly its amount from reconciled funding. If the reconciled funding is short, nothing is paid and
the run stops for a new Review (`WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT`). An amount is never reduced. This is enforced in
`workflow-runs/runner.ts`, `service.ts` (due checks), `user-funded/evm-calls.ts` and `delegation/executor.ts`. A batch is never a producer.

### 3.4 Validation and limits

- **Recipients.** 2 to 8. The maximum is the workflow-run budget: every payment is one run step, and `workflow_runs.step_count` is at most 8 (migration 0015). A batch inside a longer workflow shares that budget (`BATCH_PAYMENT_EXCEEDS_WORKFLOW_STEP_BUDGET`). The bound also keeps one atomic EIP-5792 request well within wallet and gas limits.
- **Addresses.** Each must be a 0x address that is not the zero address, and the network's transfer profile must allow explicit recipients. Recipients are lower-cased, and a duplicate (case-insensitive) is refused with `BATCH_PAYMENT_DUPLICATE_RECIPIENT`, never merged or dropped. Addresses are never invented: every channel requires the explicit address.
- **Amounts.** Positive exact decimals, turned into integer base units with the asset's decimals. Native amounts respect the profile's per-transfer maximum. The total is an exact integer sum, refused above 2^256−1.
- **Asset.** Native ETH or a non-stock ERC-20 of the network's validated catalog. A mixed asset is refused at the IR. There is no USD cap. Internal transfers count toward the step budget.
- **Prerequisites.** Balance, fee balance, gas and wallet capabilities are evaluated by the existing user-funded Review (simulation of the exact calls) before authorization.

### 3.5 Channel parity

The canonical strategy and hash are identical in every channel:

| Channel | Authoring |
|---|---|
| Editor (Canvas) | The new Batch Payment card. A lone card runs as the shared workflow run, without the single-card opt-in |
| Chat / Copilot | The exact sentence `pay 25 USDC to 0x…, 50 USDC to 0x… and 75 USDC to 0x… on Base`. The natural sentence "Send 25 USDC to wallet A, 50 USDC to wallet B and 75 USDC to wallet C on Base" with explicit addresses becomes ONE Batch Payment |
| ChatGPT MCP and Claude MCP | `compose_strategy` with `batch_payment`. It reports `batchPayments` [{step, legs, recipients, total, execution: ATOMIC_ONLY}]. A preview needs the owner's browser (`SIMULATION_REQUIRES_OWNER_BROWSER`), and MCP keeps no signing authority |
| Telegram | Through the shared channel strategy (`channels/core/strategy.ts`) |
| Developer API | The same strategy schema (OpenAPI regenerated) |

PR #259 native signing is unchanged. A Chat or MCP batch opens on the Canvas as ONE card, never as one Send card per payment
(`canvasWorkflowOfStrategy`).

## 4. UX freeze and visual evidence

Only these surfaces change:

- **The Batch Payment card** (`components/batch-payment-fields.tsx`). Its fields are network, asset, recipient rows (address and amount, remove), "Add recipient", "Same amount for all", the recipient count, the exact total, the atomic disclosure, and Apply/Cancel. It is built only from existing design tokens and classes: the Send card's address field, the amount form's buttons and notes, and a few `.batch-payment-*` layout rules in `app/approved-ux.css`.
- **The catalog entry** ("Batch Payment" / "Pagamento em lote") in the existing first rail group, after Send, with a new line icon.
- **The operation-specific content** inside the existing card, Review and execution surfaces: the action name, the total, "N recipients" and the provider "Wallet batch".

The landing page, dashboard, chat, navigation, other cards, headers, footers, login, wallet connect, the Simulate/Review/Execute patterns,
the workflow lifecycle and the fee model are unchanged.

**Baselines.** Two committed screenshots show the Build page's docked tool row and therefore must change: `e2e/visual-shell.spec.ts`
`build.png` and `e2e/swap-authoring.spec.ts` `chat-committed.png`. The only intended difference is the added "Batch Payment" tool after
"Send". Renders from this container differ from the committed baselines in font rasterization on every page (including unchanged ones), so
they are not committed. The CI's candidate renders are the source, per `docs/engineering/CI.md` §5. See [§8](#8-test-results) for their
status.

## 5. Files

WS01 (committed):

- `apps/reference-dapp/src/mcp/{config,gateway,account,tools}.ts`
- `platform/conversation-state.ts`
- `domain/intelligence/platform-guide.ts`
- tests `mcp/{step-limit,platform-help-cancel,account-tools}.test.ts`, `mcp/oauth/portfolio-consent.pg.test.ts`, `platform/parity.test.ts`
- `e2e/mcp-in-chat.spec.ts`
- `docs/deploy/MCP.md`

WS02:

- **Contracts and registry.** `packages/workflow-contracts/src/batch-payment.ts`, `packages/reference-linter/src/batch-payment.ts`, `packages/action-registry/src/execution-capabilities.ts`.
- **Engine.** `apps/reference-dapp/src/engine/{strategy-spec,strategy-engine,workflow-bindings,strategy-examples,capability-catalog,certification-matrix}.ts`.
- **Authoring.** `domain/{batch-payment-authoring,commands,editor,workflow-steps,composer-presentation,copilot-*}.ts`.
- **Runs and execution.** `workflow-runs/{execution-groups,authorization-plan,runner,service}.ts`, `user-funded/evm-calls.ts`, `delegation/{steps,executor}.ts`.
- **Platform and channels.** `platform/{approvals,strategy,workflow-visual,conversation-state}.ts`, `channels/core/strategy.ts`, `mcp/{tools,simulation}.ts`, `editor/workflow-strategy.ts`, `app/editor-workflow-execution-action.ts`.
- **UI.** `components/{batch-payment-fields,composer-card,workflow-canvas,action-icon,app-shell}.tsx`, `i18n/pt-batch-payment.ts`.
- **Tests.** New and updated tests are listed in §8.
- **CI.** `scripts/guarded-release-browser.mjs` and `scripts/test_ci_optimization.py` (the `canvas-workflow-ux` profile also runs `batch-payment-card.spec.ts`).
- **Generated.** OpenAPI and its public copy, the capability, certification and settlement matrices, and `docs/engineering/{coverage.json,COVERAGE.md}`.

No new dependency, contract, custody, paid infrastructure or database migration.

## 6. Specialist reviews

Pending at this commit: WS02 specialist reviews are running; their verified findings and fixes are recorded here before delivery.

## 7. Security notes

- **Authority.** MCP and every AI channel keep no financial authority. A batch is authorized only by the owner's own wallet, through the reviewed flow.
- **Integrity.** The manifest is bound to the semantic hash, the workflow hash, the Review and the prepared calls. Any change to a recipient, amount, order, asset or chain produces a different hash, which invalidates the authorization.
- **No silent behavior.** There is no silent downgrade, resend or partial execution. Refusals are closed codes with plain-language messages.

## 8. Test results

Pending at this commit: the full gate results are recorded here before delivery.

## 9. Production configuration (CTO approval required)

Nothing below has been applied. The P0 remediation:

1. In the Vercel project's **Production** environment, set `FLOFI_MCP_PORTFOLIO_LINKS_FROM` to a UTC ISO-8601 instant **at or after `2026-11-24T04:40:00Z`**. The earliest defensible value is that instant, the PR #248 deployment that published the Connections disclosure, rounded up. The instant of applying the change is the conservative choice. An earlier value is rejected by the code as backdating.
2. Redeploy Production so the variable is read.
3. Links made before that instant stay without consent. Their owners re-link in Connections; `get_account` names those wallets (`relinkRequired`). Do not backdate the variable to include them.
4. Not verified from here: the exact alias time of that deployment and the Skew Protection setting. Confirm the alias time in Vercel before choosing the earliest value.

Batch Payment needs no new variable. It runs where user-funded execution and Editor workflow runs are already enabled.

## 10. Owner acceptance procedure

All steps are manual, by the owner, with their own wallet and small amounts. Nothing is automated or pre-approved.

1. **P0.** After §9, call `get_account` from ChatGPT or Claude. It shows `portfolioReads.status: ENABLED`. Re-link one wallet, then `get_portfolio` returns balances, while an older link is named in `relinkRequired`.
2. **P1.** Ask for a 9-step workflow. The answer refuses with `WORKFLOW_TOO_MANY_STEPS` and asks to split it. Nothing is shortened.
3. **P2.** Ask the cancel question in EN and in PT and check the six outcomes.
4. **Editor.** Add a Batch Payment card on Base with 2 or 3 of your own addresses and minimal USDC amounts. Check the count and total, Apply, open Review, and confirm the single wallet request shows one transfer per recipient. Authorize only if you intend to pay. Then check reconciliation and the receipts.
5. **Channels.** Repeat the authoring from Chat ("pay … on Base") and from ChatGPT or Claude (`compose_strategy` with `batch_payment`). The workflow hash equals the Editor's for the same manifest.
6. **Refusals.** With a wallet without atomic batches, the run refuses before any request, and confirm-each-step is not offered.

LIVE VERIFIED is claimed only after step 4 is performed and reconciled on mainnet by the owner.

## 11. Known limitations

- **Mainnet evidence.** No owner-signed mainnet Batch Payment exists yet. Execution evidence is MOCKED (a PostgreSQL run on a Base chain double) plus browser authoring.
- **Solana.** Not exposed: FloFi has no atomic multi-recipient Solana path.
- **Recipient budget.** At most 8 recipients (the run step budget). A batch inside a longer workflow shares the 8 steps.
- **Atomic wallets only.** A wallet without EIP-5792 atomic batches (and without a FloFi smart account) cannot run a Batch Payment. There is no sequential mode, by design.
- **Saved recipients.** The Copilot resolves at most one saved-recipient name per sentence (existing limitation). Explicit addresses work for every recipient.
- **MCP idempotency and OAuth logs.** `request_user_approval` and `cancel_approval` carry no idempotency key (mitigated by supersession and `retryable: false`). OAuth endpoints carry no request id.
- **Visual baselines.** See §4.

## 12. Rollback and migration

- **Migration.** None. No schema change. Runs keep `step_count ≤ 8`.
- **Rollback.** Revert the WS02 commit: the `asset.transfer.batch` rows, the `batch_payment` strategy action and the card disappear, and no existing workflow hash changes. A pending approval of a batch would then fail closed at its re-composition and could be withdrawn (no funds move without the owner's signature). Reverting WS01 restores the previous MCP answers. The P0 configuration change is independent and can be reverted by removing the variable, which makes reads honestly `NOT_ENABLED` again.

## Final status

Pending at this commit.
