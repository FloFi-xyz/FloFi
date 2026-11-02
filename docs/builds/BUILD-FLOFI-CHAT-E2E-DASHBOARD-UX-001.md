# BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001 — Chat continuation, Privacy & Memory, history access, Your workflows, wallet portfolio

**Status:** ready for owner review. Branch `claude/festive-keller-om54li`, restarted from `main` at `d3d4b1f` (Builds 1 and 2 merged). Nothing is
merged, deployed or configured; no wallet was used and no funds moved. Evidence level: MOCKED / loopback only.

## 1. Scope (owner's)

1. The Editor's side chat continues after an execution and supports iterating the same workflow.
2. A first-access Privacy & Memory modal on `/app`: centered over a dimmed page, "I agree", Continue, "Not now"; no wallet proof.
3. Signed in → history available: no redundant "Verify wallet for history" for a wallet the signed-in person already holds.
4. Your workflows becomes the hub: A. Saved workflows, B. Executed / History, C. Needs attention / Unresolved.
5. A Dashboard wallet portfolio widget (compact card, expandable detail) on real data only.

The Editor (Canvas + side chat), the Review and wallet-confirmation gates, and Build 1 / Build 2 execution behaviour are unchanged.

## 2. Implementation

### 2.1 Side chat continuation (area 1)

| File | Change |
| --- | --- |
| `src/state/flofi-conversation.ts` | After a final **completed** result (one action, or every step of a sequence) FloFi reports the recorded result and asks “What would you like to do next?” with **Add another action**, **Modify this workflow** and **Create new workflow**. The open question keeps the workflow open for authoring: a typed action is committed to the same workflow; a bare yes/no re-asks. Partial and failed results keep their existing recovery path. Nothing is simulated, reviewed or signed until the owner asks. |
| `src/domain/conversation-lifecycle.ts`, `conversation-copy.ts` | `MODIFY` lifecycle request (“modify this workflow”, PT “modificar este workflow”, …) answered with what can be changed (in chat or on the step's Canvas card); EN/PT copy. |
| `src/state/workflow-store.tsx`, `src/components/app-shell.tsx` | `recordExecutedAction`: a one-action workflow whose own run is final and every action reconciled (the same rule a sequence step uses) is kept as the workflow's executed first step. An action added afterwards makes the workflow a sequence whose step 1 is already completed: only the new step is simulated, reviewed and signed (a funded step spends what the executed step's record proves it delivered). Changing the executed action, or anything before it, starts over (`validCompletions`, unchanged). `executedActions` tells the chat whether a change keeps the executed steps completed or would review an executed action again; the chat says which. |

### 2.2 Privacy & Memory first access (area 2)

| File | Change |
| --- | --- |
| `src/components/privacy-notice.tsx`, `privacy-notice.module.css` | Modal `<dialog>` (`showModal`, dimmed `::backdrop`, centered), checkbox **I agree**, **Continue** (enabled only when checked), **Not now** (also Escape). What FloFi keeps, that nothing changes a workflow, approval, signature or funds, per-wallet memory, and where to change the choice. |
| `src/domain/privacy-notice.ts`, `src/app/(product)/layout.tsx`, `src/state/product-bootstrap.tsx`, `src/components/product-workspace.tsx` | The answer is a first-party cookie (`flofi_privacy_notice=1.AGREED` for a year, `1.NOT_NOW` for 30 days; a new notice version asks again) read by the server so the first render is the same screen. Shown on `/app` routes only (never `/approve`, `/mcp/approve`, `/connections`). |
| `src/app/learning-action.ts` (`learningAgree`) | Agreeing turns on the Copilot's opt-in learning (`CONSENT` basis) for the wallet this browser can use — only when that wallet never made its own choice, so an earlier “off” is never overridden; wallets used here later receive the agreement the same way. Without a wallet nothing is stored server-side. |
| `src/components/privacy-controls.tsx` | Without a wallet identity the page no longer leads with “Prove an EVM / Solana wallet”: it explains memory is per wallet, offers **I agree to Privacy & Memory**, and keeps wallet verification as an optional, secondary path. |

### 2.3 Signed in → history available (area 3)

| File | Change |
| --- | --- |
| `src/server/history-principals.ts` | `historyPrincipals()`: wallets proven in this browser (the existing HttpOnly wallet sessions) **plus** the wallets held by the verified FloFi account session (unrevoked, unexpired server record): its saved wallets (embedded wallets the provider listed for the account, legacy FloFi Wallet records, external wallets linked with a fresh FloFi wallet proof) and the wallets it signs in with. Read from the database on every request; never inside the embedded approval route. |
| `src/accounts/account-store.ts` | `walletAddresses(accountId)`: one tenant- and account-scoped query over saved wallets and EIP155/SOLANA sign-in identities (each address belongs to at most one account per tenant). |
| `src/lib/dashboard/data-service.ts`, `src/server/owner-history.ts`, `src/server/workflow-persistence.ts`, `src/app/learning-action.ts` | History reads, history archive/delete (deletion still rechecks financial eligibility server-side), the workflow library (list/open/save) and the Copilot's per-wallet memory use `historyPrincipals`. The browser address stays an expected-wallet guard only. Automations, delegation, approvals and signing are unchanged (their own proofs). |
| `src/components/app-shell.tsx`, `src/state/saved-workflows.ts` | Save no longer asks for a wallet proof up front: the server decides, and the proof is offered only when it refused this wallet. |
| `src/components/dashboard/*`, `src/components/saved-workflows.tsx` | The remaining proof prompt (a wallet no signed-in account holds) says why it is needed and that it signs a message only. A proof made anywhere on the page re-reads the history (a read, never another signature). |

### 2.4 Your workflows hub (area 4)

| File | Change |
| --- | --- |
| `src/components/saved-workflows.tsx` | **A. Saved workflows**: an open, expandable `<details>` at the top with the library entries saved and never executed (the library's own `saved` and `runCount`), Open, Archive, Delete. |
| `src/components/dashboard/dashboard-view.tsx`, `dashboard-workspace.tsx` (`mode="records"`) | **B. Executed and history** and **C. Needs attention**, from the same canonical execution records and run mapping the Dashboard used (Build 1 lifecycle truth). Each run is in exactly one section: C holds runs with an attention reason (unresolved, partial, failed, declined, awaiting a status check, …) or still in progress; B holds the rest. Run cards keep View run, Archive and Delete, and offer **Open workflow: <name>** when the workflow is in the owner's library. |
| `src/components/app-shell.tsx` | `/app/workflows` renders the hub; one proof prompt covers both the library and the history when one is needed. |
| `src/components/dashboard/dashboard-view.tsx` (`mode="dashboard"`) | The Dashboard keeps the overview: the portfolio widget, the current execution, and a **Workflow records** summary (records that need attention, executed records) with **Open Your workflows**. The run-history list and attention list moved to the hub. |

### 2.5 Dashboard wallet portfolio (area 5)

Before this build FloFi had no portfolio read at all: every balance read belonged to one workflow's simulation or reconciliation, and no wallet
transaction history exists. The widget therefore adds one read-only path and shows only what it can prove.

| File | Change |
| --- | --- |
| `src/server/wallet-portfolio.ts` | `readWalletPortfolio({ evm, solana })`. Networks: Ethereum, Base, Arbitrum One and Robinhood Chain for an EVM wallet, Solana mainnet-beta for a Solana wallet — each read only where the deployment enables it (the same gate as its swap/transfer flow; a loopback harness is `MOCKED` test data and a hosted deployment never reads one). EVM: chain-id check, one pinned block, Multicall3 code check, `aggregate3` of `balanceOf` over the network's validated official token list (≤ 120 per call, ≤ 600 tokens) plus the native balance; without Multicall3 only the native balance (`eth_getBalance`) and the network says token balances could not be read. Solana: cluster check, owner account, SPL and Token-2022 accounts; mints outside the Jupiter verified list are counted ("N unlisted tokens not shown"), never shown or valued. Each network fails alone; 12 s budget; 30 s cache (5 s when a network was unavailable). No signer, session, submission or persistence. |
| `src/app/portfolio-action.ts` | Server action; closed error codes; a per-process admission window (4 concurrent, 120 per minute) bounds the RPC reads any caller can cause. |
| `src/domain/wallet-portfolio.ts` | Types, address checks, exact EN/PT amount and USD formatting, sorting, summary and network breakdown. |
| `src/components/dashboard/portfolio-widget.tsx` (+ CSS module) | Compact card (priced total or holdings count, proportional bar of the priced holdings, top holdings, networks read, Refresh); the card expands in place (`aria-expanded`) into the wallet identity (short address, ecosystem, copy), the networks read with status and provenance, and an **Assets** table (asset, network, balance, price, value; “—” where no price), with the price source and observation time. Transactions, DeFi positions and perpetuals are not shown — FloFi has no verified source for them — and the widget says so, pointing to Your workflows for FloFi's own executions. |
| `src/i18n/pt-portfolio.ts` | PT entries (spread first, so existing translations keep precedence). |

**Prices.** The only USD source is the deployment's verified price source (`deploymentPriceSource`: Chainlink USD feeds on Base, or the MOCKED
fixture in tests), applied only to native ETH/SOL and the canonical wrapped WETH/WSOL. A stablecoin is never assumed to be worth $1 and no
other asset is valued. The total is “Priced holdings” with the count of holdings that have no price; with no price source configured no USD
figure appears anywhere and the widget says values are unavailable on this deployment.

## 3. Tests

Intentional test changes (none weakened; nothing skipped):

- Dashboard unit and acceptance tests that asserted the history list on the Dashboard now assert it in the records view (`mode="records"`) and assert
  the Dashboard summary instead; the reading order follows the owner's section order (executed history, then needs attention).
- `saved-workflows.test.tsx`: an executed workflow is no longer listed under Saved workflows (it is listed with its records); new hub-order test.
- `owner-history.spec.ts`, `acceptance-workflows.spec.ts`: history is read in Your workflows; the one wallet proof there is the existing proof
  control; reopen buttons carry the saved name.
- Browser suites visit as a returning visitor who answered the notice “not now” (`answeredPrivacyNotice` in every Playwright config and custom
  context); `privacy-notice.spec.ts` removes the answer and covers first access.

Results: see §5.


## 4. Specialist reviews (read-only) and dispositions

Selected from `agent_guard.py impact` (all 19 domains are touched through shared files; the reviews below cover the changed behaviour). Batch 1:
flofi-security, flofi-data-privacy, flofi-workflow. Batch 2: flofi-chat, flofi-frontend-ux, flofi-protocol-integrations.

| Finding | Disposition |
| --- | --- |
| data-privacy HIGH: a browser-level agreement was re-applied to any wallet appearing later (another person on a shared browser) | Fixed: the agreement is applied once, when given, to the wallet available at that moment; never later. |
| data-privacy MEDIUM: the recorded consent could misstate the notice shown and its time; copy wrong under legitimate interest / no automatic learning; no withdrawal | Fixed: the modal repeats the Settings learning notice (the recorded `LEARNING_NOTICE_VERSION` text) and applies it only under an opt-in basis with learning enabled, at the moment of agreement; copy per basis (`learningNotice`: tier and basis, no database read); “Not now” is stated not to be an objection; **Withdraw agreement** on the Privacy page (and learning off for the current wallet under consent). |
| data-privacy LOW: check-then-act race between reading the setting and turning it on | Left as is (documented): an explicit “off” saved in the same instant as an agreement can be overwritten; the person sees the switch state and can turn it off again. |
| data-privacy LOW: public privacy page out of date; PT variants mixed | Fixed: the policy names account wallets and the `flofi_privacy_notice` cookie and durations; PT aligned to pt-BR in the new catalog. |
| security MEDIUM: memory could land on an account wallet the person did not pick; the Copilot read memory through a different principal source | Fixed: `memoryPrincipals` — a wallet proven here, else the account's **only** wallet of that ecosystem (several and none proven: no memory identity); used by every learning action and by the Copilot (`copilot-action.ts`). |
| security LOW: an address could be held by two accounts across the two account tables | Fixed: `walletAddresses` leaves out any address another account holds in either table (PostgreSQL test). |
| security LOW: permanent Delete needs no recent sign-in through an account-held wallet | Left as is (documented): Delete still rechecks financial eligibility server-side and only records proven to have no financial submission or pending responsibility can be deleted; Archive is the default suggestion. |
| security LOW: account model documentation stated the old rule | Fixed (`account-model.ts`, `learning-action.ts`). |
| workflow HIGH: “what already executed is not sent again” was promised for workflows that run as a whole | Fixed: `continuable` (finished sequence, or one action on a runtime that runs steps) decides the promise; otherwise the chat says the next review covers everything again, and a change after such a run adds the explicit warning. |
| workflow MEDIUM: a carried step can keep `received = null` if an action is added before its record proves the delivery | Partly: a later re-record of the same run now learns the delivery (and keeps later steps); while the workflow is a sequence the carried step's delivery is not re-read, so a step funded by it stays blocked (“delivery not proven”, fail-closed) until the owner undoes and re-adds after reconciliation. Documented. |
| workflow LOW: re-recording truncated a longer history | Fixed (the same executed run at the head keeps every later step). |
| workflow LOW: carried completions are not tied to the signer | Left as is (documented; the existing sequence path has the same property; the Review of the next step binds the connected wallet). |

## 6. Open questions and limitations

See §6.
