# BUILD-MCP-LINK-INTEGRITY-P0 — open incident / release assessment

Status: **NOT RESOLVED. NO-GO for production release until certification and fresh-account acceptance pass.**
Repository implementation is authorized; merge, deployment, environment changes and real wallet signatures/transactions require
separate explicit owner authorization. No production changes were made during this investigation.

## Evidence and attribution

| Evidence | Observation / limit |
| --- | --- |
| User incident report | A separate ChatGPT account using OAuth and a different wallet was shown `https://www.flo.finance/?utm_source=chatgpt.com` as FloFi's official website. Treat as brand impersonation / transaction-link integrity, P0. |
| Current main fetched 2026-10-25 | `origin/main` and branch base: `2e96d5ae9a9c0c4a615cd78b4273939b6243669d` (PR #121). Dedicated branch: `security/mcp-link-integrity-p0`. |
| Public production readiness, 2026-10-25 ~16:57–17:00 UTC | `GET https://flofi.xyz/api/flofi/readiness`: HTTP 200; deployment `production`, branch `main`, commit `2e96d5ae9a9c0c4a615cd78b4273939b6243669d`. Read only; no credentials or redirects used. |
| Public OAuth discovery | `/.well-known/oauth-authorization-server`: HTTP 200, issuer `https://flofi.xyz`, authorization/token/revocation endpoints on that origin, `code`, PKCE `S256`, public client authentication `none`. |
| Public protected-resource discovery | `/.well-known/oauth-protected-resource/api/mcp`: HTTP 200, resource `https://flofi.xyz/api/mcp`, authorization server `https://flofi.xyz`, name `FloFi`. |
| Unauthenticated MCP | `GET /api/mcp`: HTTP 401 `MCP_UNAUTHORIZED`, challenge points to the canonical protected-resource metadata; no redirect. This is not evidence of an authenticated tool call. |
| Source at deployed SHA | Instructions identified FloFi and wallet authority but omitted the canonical domain and explicit invented-link/quote/status prohibition. `get_capabilities` omitted navigation identity. Approvals were generated from `FLOFI_PUBLIC_ORIGIN`; public references and private UI capabilities were already separated. |
| Incident transcript/tool trace | **Unavailable.** No original request timestamp, MCP request/result, approval ID, host trace or authenticated production initialize/tools response has been supplied. Attribution to a genuine tool result versus an answer without a tool call remains **undetermined**. |

The domain in the reported answer is not FloFi. Its UTM query alone does not identify its source. The deployed source and
public metadata establish the baseline, not what the host actually saw during the incident. There is no evidence here that
OAuth was compromised. Do not describe the event as an OAuth breach or assert that a missing tool call has been proven.
No private production logs or credentials were accessed. Existing gateway logs intentionally record tool/outcome/duration,
not tool arguments/results; a log entry alone would not reconstruct the offending answer.

Preserve a redacted incident record: UTC time, connector endpoint, source SHA if known, host/model version if available,
the exact visible answer, whether each MCP tool was actually invoked, its public structured result and JSON-RPC ID, public
approval ID and workflow hash. Compare the link byte-for-byte with the tool result. Never collect tokens, cookies, codes,
wallet-link capabilities, private `_meta` or private approval fragments into a ticket/PR/chat transcript.

## Threat model and boundaries

| Threat / boundary | Protection / residual risk |
| --- | --- |
| Host confuses FloFi with another brand, hallucinates a website, approval, quote, ID or status | Canonical identity in initialize instructions and capabilities result; explicit successful-tool-only CTA instructions. A host can still disregard instructions or generate an answer without tools. |
| Attacker supplies lookalikes, subdomains, Unicode lookalikes, userinfo, HTTP, unsafe schemes or malformed URLs | Production origin fixed to `https://flofi.xyz`; strict URL parser rejects normalization/credentials and compares exact server-trusted origin. Paths/fragments are separately allowlisted. |
| Request Host/Forwarded headers or model arguments try to select the origin | Origin remains server-side `FLOFI_PUBLIC_ORIGIN`; never taken from these inputs. OAuth audience/issuer remain bound to the configured origin. |
| Legitimate preview needs a different origin | Preserve its exact configured HTTPS origin, issuer/resource and tenant. It is the explicit preview allowlist, not a hostname suffix wildcard. Preview configuration is an operator trust boundary. Production URLs are never substituted into preview approval/OAuth flows. |
| Fabricated approval ID / failed or missing tool result | IDs are minted by durable approval creation; unknown IDs return `APPROVAL_NOT_FOUND`; failed results contain no approval CTA; panel clears old actions and validates public reference/ID and private session before navigation. Syntactic URL checks alone cannot prove an approval exists; durable server lookup is essential. |
| Private capability or OAuth secret reaches model/chat/third party | Public `/approve#apr_…` reference only in MCP content/structured content/readable summary. Private `flofi_hs_…` and wallet URLs remain UI-only `_meta['flofi/approval']`; app-only visibility alone is not redaction. Tests cover the full content array and logs. |
| Approval/open-link/receipt redirect or parameter injection | Exact `/approve#…`, exact receipt path, no unexpected query/userinfo/normalized forms; session ID must match the displayed approval. Existing wallet destination equality checks and empty network/frame/resource CSP remain. |
| Wallet deep-link provider redirects | Only existing MetaMask `/dapp/<exact FloFi host>/approve#<capability>` and Phantom `/ul/browse/<encoded public FloFi /approve>?ref=<origin>` are authorized. MetaMask capability stays in fragment; Phantom never receives it in path/query. Provider/host/browser redirect behavior beyond FloFi's control still needs real-user inspection. |

OAuth authentication, an approval URL and a connected account grant no financial authority. The human's proven wallet,
fresh simulation, manifest review, explicit authorization and wallet confirmation remain required. No owner-only restriction,
Canvas requirement, execution mock, fee change or mainnet policy change was introduced. Local test runtime doubles do not
replace end-user mainnet execution. The 0.1% fee model is unchanged.

## Audit and changes

- `src/mcp/tools.ts`: canonical production identity and endpoint, alternate-brand prohibition, real compose/review/approval
  sequence, successful public URL verbatim, no fabricated quote/ID/status/CTA, disclosure on unavailable tools, explicit
  host limitation. Preview context names its exact trusted origin. `get_capabilities.navigation` supplies real website/endpoint
  values in a tool result. Approval descriptions repeat the critical rules. Public references validate approval ID grammar.
- `src/server/deployment.ts`: production rejects any configured origin other than `https://flofi.xyz`; previews retain
  their configured HTTPS origin; HTTP remains local-loopback-only. No environment value was changed.
- `src/platform/navigation.ts`, `approvals.ts`, `wallet-links.ts`: common strict parser; valid capability/reference generation;
  exact wallet navigation path/fragment. The parser is serialized into the panel so browser/server use the same URL parsing.
- `src/mcp/app/panel.ts`: retain existing origin/path/hash checks and exact MetaMask/Phantom equality checks; add canonical
  parsing/userinfo rejection, initial fallback validation, session ID binding, success checks and clearing stale actions on
  failed results. Receipt checks also reject userinfo/invalid run IDs. Only the two link metadata fields are projected into
  the UI result. Preserve `ui/open-link` → `openai.openExternal` compatibility, optional Canvas, signing support and private fallback.
- Existing OAuth CIMD fetch uses DNS/address validation, a pinned HTTPS connection, body/time limits, and no redirect following
  (`platform/pinned-https.ts`, `mcp/oauth/cimd.ts`). Non-200 responses fail closed. Registered callback URIs are checked exactly;
  public native clients retain the RFC 8252 loopback-port exception. These protections are retained, with redirect regressions.
- Approval progress and workflow runs build FloFi receipt paths from trusted origin and encoded run IDs. Explorer URLs use
  known chain profiles and validated transaction hashes, with MOCKED outcomes omitted (`domain/execution-lifecycle.ts`).
  `/approve` resolves an account-authenticated reference or a private capability; it does not accept an arbitrary outbound
  redirect. Browser wallet links use the same helper. These existing boundaries were audited, not duplicated.
- `vercel.json`: disable automatic deployment for this security branch only, before publishing the PR, in accordance with
  [Vercel's branch deployment control](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled).
  CI workflows contain no deployment job. Other branch rules are retained; main is unaffected until owner review/merge.
- Tests: `platform/navigation.test.ts`, `mcp/link-integrity.pg.test.ts`, `mcp/oauth/foundation.test.ts`, and
  `e2e/mcp-in-chat.spec.ts`. The OAuth test harness now uses each explicitly configured test origin, permitting genuine
  PKCE/consent/audience tests at both canonical production and preview origins. All chain/wallet doubles stay local.

Paths above are relative to `apps/reference-dapp/` (runtime/tests beneath `src/` or `e2e/` as shown). No migration, dependency,
financial engine, wallet signing implementation or fee configuration changed.

## Validation record

Initial focused verification passed 74 unit tests and 81 OAuth/approval PostgreSQL tests. Production build passed after
allowing its existing Google Fonts fetch; the sandboxed attempt failed on DNS. The first new browser test run caught a test
fixture API mistake, corrected before final verification; this failed run is not counted as a pass.

Final gates, exact PR commit and CircleCI links are recorded in the PR description after completion. Required:

- `pnpm check` (typecheck, lint, build, 11 schema exports, unit/contract tests).
- `pnpm test:postgres` on disposable loopback databases.
- Guarded browser profiles `mcp-in-chat` and `channel-signing`; full existing CircleCI certification, including its remaining
  browser/fork/SBOM checks, on the PR head SHA.
- `pnpm audit --audit-level low`, dependency integrity/license/release-age verification, governance and governance/CI self-tests,
  `git diff --check`.

Local profiles use recorded/mock chains and wallets, not real-user acceptance or public mainnet execution. The canonical/preview
PostgreSQL regression exercises real OAuth/PKCE → capabilities → compose → review → approval creation → app session → status,
verifies the durable approval, rejects fabricated IDs and failed hash-bound requests, and checks content/summary/status/logs for
all generated OAuth secrets, codes, cookies and private fragments. Browser regressions test alternate brands/lookalikes,
malformed URLs, unexpected redirect queries, userinfo, missing/failed tool results, stale CTA clearing, valid matching
canonical sessions, unsafe sessions and receipts. Existing journeys cover wallet proof, simulation and signing safety gates.

## Fresh ChatGPT account + different wallet acceptance (owner-run, pending)

Do not mark the incident resolved using local fixtures or CI alone. No fresh ChatGPT account or real wallet was available to
the agent. Capture the actual responses below; do not prefill IDs or claim a pass from this runbook.

1. After explicit owner authorization, deploy a certified candidate to an approved environment. Record commit SHA and public
   readiness/discovery responses. For production acceptance use **only** `https://flofi.xyz/api/mcp`. For an authorized preview,
   record the exact operator-configured origin and use it consistently; repeat production acceptance after approved promotion.
2. Use a fresh separate ChatGPT account, new conversation, FloFi connector with OAuth, and a different owner-controlled wallet.
   Complete consent in the browser; verify the issuer and returned resource. Do not export OAuth codes, tokens, cookies or a HAR.
3. Request `get_capabilities` for the owner's chosen supported mainnet/action. Open the tool trace: verify it was really called,
   navigation fields match the approved origin, and deployment/policy enable that action. Record its nonsecret result and UTC time.
4. Ask for an owner-chosen amount/asset/recipient strategy, review only. Require actual `compose_strategy`, `review_strategy`,
   then `request_user_approval` with exactly the returned normalized strategy and workflow hash. Save tool names, JSON-RPC
   IDs if available, timestamps and **public content/structuredContent only**. Remove `_meta` entirely before saving.
5. Record the actual public `approvalId`, `workflowHash`, `expiresAt`, `status`, `fundsClass`, `authority`, and `approvalUrl`.
   Parse the URL: HTTPS, no userinfo/query, exact expected origin, `/approve`, fragment exactly `#` plus that approval ID.
   Compare ChatGPT's visible CTA byte-for-byte with this result. Any `flo.finance`, lookalike, invented ID, invented quote or
   unsupported status is a **FAIL**. Capture the actual answer separately from its tool result so attribution is possible.
6. Open the public reference in the OAuth browser, and separately check the MCP App's FloFi-window action. A different browser
   lacking the account session should fail closed; it should not send the user to another brand. The App's short-lived private
   session is a UI transport detail: never paste/capture its capability in the transcript. Observe the final address and any
   redirects; it must remain the approved FloFi `/approve` surface. Test the appropriate existing mobile wallet route if in scope.
7. Select the different wallet. If ownership proof requires a sign-in message, obtain explicit owner authorization for that
   specific non-transaction signature first; the agent must not sign. If authorization is absent, stop and record BLOCKED.
   Verify exact proposal/hash, network, assets, amount, recipient, costs and the unchanged 0.1% fee in FloFi's fresh simulation
   and manifest review. Canvas remains optional. OAuth alone must not be treated as wallet ownership or authority.
8. The owner may open the wallet's transaction review only under explicit authorization to reach that prompt. **STOP BEFORE
   SIGNING. Reject/cancel the transaction prompt.** No automated wallet clicks, transaction signatures, broadcasts or fund movement.
   Record only public review facts and that no transaction was signed/submitted. A refusal/expiry is not successful acceptance.
9. Check `get_approval_status`: use its actual status; do not infer a transaction completed from proposal creation. It may be
   PENDING/CLAIMED/APPLIED depending on wallet-proof/proposal loading; these states are not execution. Verify no successful
   execution/receipt is invented. Repeat with tools unavailable/refused: disclose failure, no CTA. If the host invents a link,
   record host failure even if FloFi's panel refuses it.

Acceptance evidence template (public fields only): environment/origin; commit; UTC time; host/account-is-fresh confirmation;
wallet-is-different confirmation (address optional); OAuth issuer/resource; ordered actual tool names and redacted public
results; actual approval ID/hash/URL/expiry; answer-vs-tool URL comparison; final origin/path/redirect observations; wallet
review facts; sign-in-proof authorization if applicable; transaction prompt cancelled; zero transaction signatures/broadcasts;
status result; PASS/FAIL/BLOCKED and reviewer. Store private diagnostic material only in owner-approved restricted storage.

## Host-side limitation and proposed mitigations

Server instructions and descriptions are guidance to the host. FloFi cannot enforce every free-form hyperlink independently
generated by a third-party LLM, force that host to invoke a tool, authenticate an arbitrary answer as a tool result, or control
host/browser/wallet-provider redirects. A host also delivers the App result; the panel is not a cryptographic attestation of
the host's honesty. This change constrains FloFi-provided URLs and strengthens the UI; it does **not** fully eliminate the incident class.

Propose to the host product team: render a verified FloFi action directly from the latest successful tool result, bind its
origin/approval ID to that result, distinguish it from generated prose, reject alternate-domain financial CTAs, and suppress
approval CTAs without a successful matching result. Expose tool provenance and a connector-origin badge. Report this incident
through the host's support/security/product channel with the redacted comparison, endpoint, timestamp and reproducible prompt;
request brand/domain disambiguation. These are proposals, not implemented host controls, and no report/message was sent.

## Deployment and rollback procedure (not executed)

1. Owner reviews the focused PR and exact head certification, verifies incident evidence and authorizes the target deployment.
   The branch's Vercel deployment-disable rule intentionally prevents an automatic preview. Do not change it or trigger a
   manual deployment without owner authorization. A dedicated approved preview keeps its own trusted origin/tenant/audience.
2. Confirm server-side production `FLOFI_PUBLIC_ORIGIN` is already exactly `https://flofi.xyz` (public discovery currently agrees),
   and preview's value is its exact HTTPS origin. Do not rotate secrets or change scopes/mainnet/fee policies for this hotfix.
3. Deploy the reviewed SHA only after authorization. Verify readiness SHA, discovery, OAuth, authenticated initialize/tools,
   capabilities identity, model/public vs UI/private separation, panel/wallet compatibility and the acceptance sequence above.
   Refresh/reconnect the host connector if it caches old instructions/tool descriptions. Record actual results.
4. On wrong-origin links, leaked capability, OAuth/Apps regression or blocked valid mainnet approval: stop promotion, preserve
   redacted evidence and obtain owner authorization to roll back to the recorded pre-release deployment/SHA. This hotfix has
   no schema changes. Do not roll back a database, migrate state, change environments, merge or redeploy autonomously.
5. After an authorized rollback, recheck readiness/discovery and existing OAuth/App journey. Prioritize the original brand-link
   risk again: rollback restores earlier instructions/checks; it is not a resolution. Private capabilities remain short-lived;
   do not publish them while collecting evidence.

Recommendation: **GO for review and certification; NO-GO for production release / incident closure until the exact candidate
passes CircleCI and real fresh-account/different-wallet acceptance with owner authorization.** Attribution remains open until
the affected tool trace or equivalent host evidence is available.
