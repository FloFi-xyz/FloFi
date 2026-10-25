# Chat-first execution and minimal authorization — release evidence

Branch: `fix/chat-first-approval-ux-20261025`, based on `main` `4f88e863d8ee8ad202c038ec5647e0cf40afba0e`.
Status at PR publication: automated local checks passed as recorded below; remote certification and independent-account acceptance remain required. **Not live accepted or resolved**. No merge, deployment, production configuration change or real transaction signature is authorized by this work.

## Evidence and diagnosis

The owner supplied real historical executions `pub-01a2ec0f21c0507a1ce258eb` (Base Sepolia, reported RECONCILED / TESTNET_EXECUTED, 2026-10-24) and `pub-4ba810e120cce859e5695bd1` (reported ChatGPT/MCP initiation and RECONCILED). These establish owner-reported existing execution, not proof of completion without an external page. Unauthenticated GETs to their dashboard URLs returned the application shell, not owner-scoped run evidence. No execution details or tool trace were fabricated from those HTTP 200 responses.

At 2026-10-25 20:55:48 UTC, the public [readiness endpoint](https://flofi.xyz/api/flofi/readiness) reported production commit `4f88e86`, remote runtime READY and session CONFIGURED. This is deployment/runtime evidence, not proof of OAuth signup policy or a particular financial execution. Earlier deployment observations must not be substituted for this snapshot.

History reviewed:

| Checkpoint | What its implementation actually does |
| --- | --- |
| MCP-002, `f2881e3` / panel `651f4b0` | Conversational composition, OAuth, canonical handoff and progress. The panel opens an external FloFi window; its iframe wallet adapter is diagnostics only. |
| CHANNEL-SIGNING-001, `bca20db` | UI-only private capabilities, public account-authenticated references, wallet proof, recovery and conversation status. External signing remains the implemented adapter. |
| `a1ed8fd` | External approvals open the normal Canvas. |
| SOLANA-TRANSFER-UX-001, `1dc54b7`, integrated `7a844d2` | Adds the reusable minimal signing surface, automatic fresh preparation and one explicit Authorize-in-wallet action. Default `/approve` is signing; View in FloFi selects Canvas. |
| CHAT-E2E-001, integrated `78ea792` | Reuses the same surface and engine for durable ordered workflows, per-step reconciliation and optional bounded delegated authorization. It does not add an iframe wallet transport. |
| PR #122, `bcd76bd` / merge `4f88e86` | Trusted origin/parser/path/session/receipt enforcement. The merged tree equals the certified PR tree. It did not introduce the external-only adapter or Canvas selection. |

The specific 1 USDC Base → Arbitrum approval's URL/tool trace was not supplied. Its exact user click cannot be proved. The code does prove that the panel's old **View in FloFi** explicitly adds `?view=canvas`, which renders Build/Simulate/Execute and Copilot instead of `surface='signing'`. The compact notice also inherits the blue background from `.approval-notice`. Those are code causes consistent with the report. The four commits on `fix/approval-handoff-compact-ux-20261025` were read as reference only; they change copy/style, not the wallet transport, and were not merged or cherry-picked.

## Implementation

The existing MCP App gains **Authorize in chat**. It obtains a fresh session through app-only `open_approval_session`, validates the exact canonical `/approve#flofi_hs_…` result with the PR #122 parser, then derives only `/mcp/approve#<same capability>` on that trusted origin. It embeds the existing ProductWorkspace providers and AppShell signing orchestration. The wrapper never requests a wallet signature, sends a transaction or forwards transaction payloads through the model. The actual wallet adapters, exact-payload checks, simulation, Review, financial execution, reconciliation and workflow runner remain the existing ones.

New tool results reference a versioned MCP UI resource to avoid reuse of cached external-only HTML. The old resource URI remains readable for existing conversations. An embedded `frame-src` policy also blocks a signing-frame redirect to another origin, independently of the host's declared resource CSP. This does not establish that caching caused the reported historical approval UI.

**Open FloFi** opens the minimal external signing surface. **Open Canvas** is an explicit choice on that page. The embedded presentation remains signing even if a query requests Canvas. The notice is neutral and compact. Proposal provenance/hash and machine explanations remain available under collapsed details; amounts, sender/recipient, networks, fees, slippage/minimum output, permissions and material warnings remain in the main financial review.

Browser screenshot review also reproduced a pre-existing signing-layout defect: the shared quoted-outcome token icon inherited the global 100% size outside SimulationSummary, filling the card and wrapping the amount vertically. The signing surface now bounds that icon like the existing simulation view. A browser geometry assertion protects the readable financial outcome; no value, minimum, fee or risk text is removed.

The existing `/approve`, Connections and Admin framing restrictions remain. Only the new signing route permits the documented ChatGPT origin/sandbox and the exact Claude sandbox derived from the server-configured MCP endpoint. Unknown ancestors fail closed; no wildcard origin or URL derived from a request header is added. Deliberate preview origins remain separate. The wrapper resource permits only its own server origin as a subframe and retains empty network/static-resource permissions.

Embedded wallet proof uses separate HttpOnly, Secure, SameSite=None, Partitioned cookies scoped to `/mcp/approve`. First-party sessions remain Strict. The existing SIWE/SIWS signature, challenge, domain, MAC, expiry, claimed wallet, canonical workflow and financial authorization checks still apply. The client confirms that the browser retained the isolated session before treating the wallet as proven. Browsers that refuse it receive an explicit limitation, with no fabricated approval. OAuth cookies/tokens are not transferred to the frame. Session expiration uses the matching cookie path and partition attributes.

The child-to-wrapper message carries only height. The wrapper checks the child Window and canonical origin and never accepts approval status, navigation, payloads or receipts from that channel. Progress and model-context updates continue to use authenticated MCP results and the existing explicit public projection. The frame persists across progress refreshes. New/failed tool results and teardown clear stale frames/CTAs. External OpenAI opening explicitly disables redirect URL decoration.

No dependency/project/relay was added, and no WalletConnect integration was activated. The branch is explicitly excluded from automatic Vercel deployments in the existing Git configuration. This exclusion does not disable CI or change production deployment behavior.

## Host and wallet limits

MCP Apps permits declared nested frames; actual support remains host-dependent. OpenAI documents [frameDomains and iframe isolation](https://developers.openai.com/plugins/reference) and [the independent CSP of embedded pages](https://developers.openai.com/plugins/guides/security-privacy). The [MCP Apps CSP guide](https://apps.extensions.modelcontextprotocol.io/api/documents/csp-and-cors.html) specifies Claude's endpoint-derived sandbox domain. These contracts permit this implementation; they do not prove live acceptance for an account, browser or wallet version.

[Phantom explicitly states that it does not inject its provider into iframes](https://docs.phantom.com/solana/detecting-the-provider). Merely removing FloFi's diagnostic-only switch cannot make Phantom sign in a host iframe. Other existing EIP-1193 / Wallet Standard wallets must be tested on the actual host. A missing provider, blocked frame or rejected partitioned session is reported as such. An external fallback must **not** count as in-chat completion. A future compatible wallet transport can be assessed separately; no unconfigured relay/project is assumed or required by this PR.

Existing delegated execution is not a universal mainnet workaround. CHAT-E2E-001's deployed-signer/template conditions and the current public-mainnet capability restrictions still apply. No owner privileges, new wallet allowlist, standing delegation or signature bypass were added.

Server instructions cannot prevent arbitrary free-form links that a host LLM invents without a tool call. Retain the PR #122 negative-link tests. A real acceptance trace must contain the successful compose/review/approval calls and matching public approval ID/hash. A wrong brand, invented CTA or claimed execution without a corresponding tool result/reconciliation is a host/integration failure; report the host trace with secrets removed. Never infer OAuth compromise from prose alone.

## Certification record

Controlled browser financial sends use only the existing synthetic loopback harness and disposable wallets/databases. They are not mainnet or vendor-host evidence. Initial failed/interrupted runs remain failures; diagnostic reruns never replace required certification.

| Completed local validation | Result |
| --- | --- |
| `pnpm check` | Typecheck, lint, production build, 11 schema exports; 428 unit files / **5,030 passed**, 2 existing conditional skips |
| `pnpm test:postgres` on disposable loopback PostgreSQL | 77 files / **480 passed**, 3 existing conditional skips |
| Focused wallet proof, isolation and financial-disclosure tests | **81 passed** |
| Governance and its self-tests | Passed; **19 tests** |
| Complete CI plan, profile coverage, ledger and orchestration self-tests | **56 passed**; the new profile increases the complete plan from 47 to 48 |
| Dependency audit and pinned registry/integrity/release-age verification | No known vulnerabilities; 263 locked registry entries verified; no dependency changes |
| `mcp-embedded-signing` guarded browser profile | **3 passed**: EVM bridge and Solana swap wallet proof/fresh review entirely in the frame; missing signer explicitly refused; no open-link or Canvas |
| `approve-authorize-journeys` guarded browser profile | **3 passed**: external signing, optional Canvas, and the existing financial runtime completing inside chat after exactly two controlled wallet confirmations, with reconciled receipt returned through MCP |
| Existing MCP / anti-phishing / OAuth / route browser profile | **26 passed**, including hostile URLs, missing tools, unknown sessions, embedded redirects, preview/privacy and account routes |
| Channel-signing / workflow-run / Solana UX / universal bridge browser profiles | **6 / 1 / 7 / 4 passed**, including interrupted handoffs, multi-step continuation and verified Phantom-style Lighthouse signing compatibility in the existing external engine |

The browser profile writes a `MOCKED-in-chat-signing.png` screenshot, and remote runs attach model-visible MCP responses with public approval/run IDs, excluding `_meta`, capabilities and OAuth credentials. Additional regression profiles and exact-head CircleCI results are recorded in the PR checks/description. They must pass before release; this table does not predict pending checks.

Iteration failures were investigated and corrected: the proof unit fixture lacked `window.location`; the old UI tests expected the former Canvas/navigation labels; an old resource-URI assertion was updated while retaining legacy resource reads; the embedded Solana wallet dialog was outside the viewport, fixed by placing/bounding the signing frame first. Adding account journeys to the old database also hit its genuine 10/hour OAuth registration limit. A separate profile/database now covers those new journeys; no rate limit, test assertion about financial authority, or existing scenario was removed.

The initial CircleCI governance job on `040ba08` also rejected four orchestration-test expectations still counting 47 profiles. Its actual ledger correctly counted all 48. Those explicit expectations were updated to 48; the complete 56-test CI suite then passed locally. This was an incomplete test-plan update, not an infrastructure failure or evidence of a financial regression. Exact-head remote certification remains mandatory.

Changed code is confined to MCP instructions/resource/panel, the existing approval/signing presentation and wallet-proof transport, the new isolated `/mcp/approve` route/CSP/cookies, tests and this report. No backend flow, protocol implementation, workflow contracts, executor, reconciler, fee calculation or dependency was changed. The reference branch's four commits were not integrated.

## Independent-account acceptance (release remains NO-GO until passed)

1. After separate owner approval to deploy the reviewed SHA, record both web/API deployment SHAs, readiness, exact `https://flofi.xyz` origin, MCP endpoint and effective public OAuth access (`open`). Do not expose configuration secrets. A public discovery response alone cannot prove open signup.
2. Use a fresh independent ChatGPT account, a separate browser profile and the user's own wallet; repeat on Claude if it is a supported release target. Record host/client, OS, browser, wallet version and whether MCP Apps/nested frames are supported. OAuth must need no owner privileges, wallet enrollment or invite in the public deployment.
3. In the conversation call `get_capabilities`, `compose_strategy`, `review_strategy`, a real read-only `simulate_strategy` for the relevant public wallet addresses, and `request_user_approval`. Use Base → Arbitrum One, 1 USDC (or the owner's specifically chosen amount). Save only public approval ID, workflow hash, quote/fees/limits, and redacted tool responses. Keep OAuth tokens, capabilities, fragments and proof signatures out of transcripts/screenshots.
4. Choose **Authorize in chat**. The same conversation must show the minimal financial signing surface; no new FloFi tab/window, Canvas, manual workflow reconstruction or external Execute step is allowed. Choose status sharing consciously. Prove the actual wallet and inspect sender, recipient, asset contracts/mints, amount, network, route, fees including the unchanged FloFi fee, limits and permissions. **STOP before a transaction signature during certification without specific financial authorization.** A proof message is not a transaction approval.
5. For an independently authorized funded execution, inspect and confirm only the exact wallet requests required by the existing engine (including token approval where necessary). Never retry an uncertain send. Keep the conversation open through chain confirmation and reconciliation; use `get_approval_status` for the same approval, and verify actual run ID, transaction hashes, received amount, evidence environment/bundle hash and canonical receipt. The host's optimistic prose is not success evidence.
6. Repeat for a real supported Solana swap with a wallet compatible with that host's embedded context. If testing Phantom extension, record its documented iframe limitation as a blocker; a page opened outside chat does not pass this criterion. Do not claim a fixture Wallet Standard provider proves Phantom compatibility.
7. Separately choose **Open FloFi**: verify the neutral compact signing page, full financial disclosures, collapsed technical details and absent stage navigation/Copilot. Canvas must open only on **Open Canvas**. Decline a proof/signature, change wallet/network, test an expired/replaced approval and a refused embed; none may authorize or resubmit funds.

Release/rollback: owner review and exact-head CircleCI certification precede any merge. Deployment/promotion/configuration changes need separate authorization. After an authorized release, recheck both service SHAs, canonical domain/OAuth, MCP metadata and these acceptance cases. Roll back web and API to the recorded compatible prior deployments only under owner authorization; no database migration is introduced by this change. Preserve in-flight run journals and reconcile existing attempts rather than starting replacements. A source rollback must never undo PR #122's origin, capability separation or URL checks.
