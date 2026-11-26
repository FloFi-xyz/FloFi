# BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001

**Base and scope**
- Base: certified `main` at `9fd172b` (PR #258).
- This BUILD covers the wallet transport and channel execution only. It finishes the native signing work left open by PRs #256 and #258 and KAN-6.
- It adds no migration, no paid service and no production configuration change.

**Dependency.** One new direct dependency, `@noble/ciphers` 1.3.0 (MIT). It was already in the lockfile through `@turnkey/crypto`, and no new package
was downloaded.

**What this BUILD does not show.** Green CI here is not real-wallet acceptance. Every "live" item in §6 is still to be done on real devices.

## 1. What a person does now

### Solana operation in a conversation (Phantom or Solflare)

1. Ask in ChatGPT, Claude or Telegram, for example "send 0.01 SOL to … on Solana" or a Jupiter swap.
2. **ChatGPT or Claude.** The FloFi panel shows **Sign with Phantom** and **Sign with Solflare** buttons.
3. **Telegram.** The approval message shows the same two buttons under **Authorize**.
4. Tapping a button opens the wallet app.
5. The wallet asks to **connect**. Then it asks to **sign FloFi's Sign-In With Solana message**, which authorizes no transaction and moves no funds.
6. FloFi claims the approval for that proven wallet, using the requester's own claim rule, and runs the flow's **fresh simulation**.
7. FloFi presents the **Review in the conversation**. In the panel it shows in place. In Telegram it arrives as a message with **Confirm in Phantom**.
8. The person confirms in the conversation.
9. The wallet shows the **exact reviewed transaction**. Only the owner's approval there signs it.
10. FloFi verifies the signed bytes against the Review and **broadcasts them once**.
11. FloFi observes and reconciles automatically.
12. The **receipt** reaches the conversation through the approval's existing status. Telegram gets "Execution reconciled ✅ … Receipt: …"; the panel shows the run and its receipt.
13. The conversation continues.

### Between the apps

- An encrypted deeplink answer has to land on an https URL, so the phone's browser shows a FloFi transit page for a moment.
- That page shows no Review, no amount and no decision. It opens the wallet, or says "Done, go back to your conversation".
- No step needs the FloFi website.
- The FloFi signing page (`/approve`) stays the fallback for everything else: EVM operations, multi-step workflows, and desktop extension wallets.

## 2. Architecture

| Step | What happens | Where |
|---|---|---|
| start | One-time X25519 key and a session journal; the wallet's `connect` deeplink (`app_url`, `dapp_encryption_public_key`, `cluster`, `redirect_link`) | `server/native-signing/service.ts` `start` |
| connect | The wallet's answer is opened (NaCl box) and names an account. It is **not authenticated**: anyone holding the redirect link could forge one. FloFi answers with `signMessage` of its Sign-In With Solana challenge | `callback` (connect) |
| signIn | `verifySolanaSignIn` checks the Ed25519 signature over the exact challenge. The account is then **proven**. Next come the existing `claimApproval` (with the requester's claim rule, e.g. a channel's intended wallet) and `applyApproval`, then the flow's `simulate` for that owner. The Review comes from the flow record only | `callback` (signIn), `prepareReview` |
| Review | Posted to the conversation (Telegram) or read by the panel (`get_execution_progress.walletSigning`) | `review.ts`, `messages.ts`, `channels/native-signing.ts` |
| confirm | The conversation's single-use confirmation. A Review with less than 45 s of validity left is simulated again at once, and FloFi continues only if the fresh terms are **no worse** than what was confirmed (§3). Then the flow's `review` (acceptance) and `begin` (fresh checks, durable PREPARED, the exact unsigned bytes), then the wallet's `signTransaction` deeplink | `confirm`, `noWorse` |
| sign | The signed bytes go to the flow's `submit`, which verifies the reviewed bytes and the owner signature, makes the signature durable and broadcasts once. One `observe`, then the deployment's worker as for every run. A rejection (`errorCode=4001`) is recorded through the flow's `walletFailure`: nothing was sent | `callback` (sign) |

**Wire protocol** (`wallet/deeplink/`).
- Phantom `https://phantom.com/ul/v1/<method>` and Solflare `https://solflare.com/ul/v1/<method>`, per both wallets' documentation.
- The two are wire-compatible apart from the answer key's name (`phantom_` / `solflare_encryption_public_key`).
- `signTransaction` is used because Phantom deprecated `signAndSendTransaction`, and FloFi broadcasts the verified bytes itself.
- NaCl `crypto_box` is implemented with Node's X25519 plus `@noble/ciphers` HSalsa20 and XSalsa20-Poly1305. It matches libsodium/PyNaCl byte for byte (`nacl-box.test.ts`).

**Durable state.**
- An append-only journal in the existing `execution_logs` table, namespace `native-signing`, under the name `<approval>.<session>.jsonl`. No new table.
- Each line is the whole session. Transitions are checked, and immutable facts never change.
- Each write is a compare-and-swap on the log version, so a step tag is recorded as used before its effect.
- FloFi's X25519 secret and the wallet's session token are sealed with AES-256-GCM. The key is derived by HKDF from the deployment's wallet-session key, with tenant, session and field as additional data.

**Entry points.**
- `/api/native-signing/…` (route handler). It is not under `/api/wallet/`, which is reserved for the FloFi Wallet origin.
- MCP app-only tools: `start_wallet_session`, `confirm_wallet_review` and `report_panel_diagnostic`.
- Telegram approval buttons.

**Off switch.** `FLOFI_NATIVE_SIGNING=disabled` turns the whole surface off. The default is on.

## 3. Security properties and where they are proven

| Property | Mechanism | Test |
|---|---|---|
| Wallet ownership proven before any claim, simulation or Review | SIWS signature over FloFi's sealed challenge (existing verifier); the connect answer alone grants nothing | `native-signing.pg` (mis-signed proof refused, session still waits) |
| Requester claim rules preserved | The existing `claimApproval` path, including `CHANNEL_INTENDED_WALLET_MISMATCH` and "another wallet already claimed" | `native-signing.pg` (foreign wallet → `HANDOFF_ALREADY_CLAIMED`, nothing sent) |
| Review in the conversation before any signing request | `signTransaction` is produced only by `confirm`, which requires the REVIEW_READY state and its single-use tag, or the MCP requester itself | all three journey tests |
| Exact transaction binding | The wallet receives `begin`'s exact bytes; the flow's `submit` refuses changed or mis-signed bytes (Lighthouse rule unchanged) | `native-signing.pg` (appended instructions → ENDED, 0 broadcasts) |
| One broadcast | The flow's existing signature claim plus the journal's compare-and-swap on the step | journeys assert `sent` = 1 |
| Replay, forgery, out-of-order | Single-use step tags; answers that do not open under the session key are refused without ending the session | `native-signing.pg`, `protocol.test` |
| Session isolation | Sessions are bound to `{approval, requester}`; MCP confirmation by the requester scope; Telegram by a channel-keyed start token (URL fragment, never stored) and a single-use confirm tag | `native-signing.pg`, `mcp/native-signing.pg`, `native-start.test` |
| Expiry | Session ≤ 15 min and ≤ the approval; the challenge lasts 5 min; the flow's own Review TTL is unchanged | `native-signing.pg` |
| Nothing secret in model context | The wallet URL is only in `_meta['flofi/wallet']`; `publicNativeSession` carries no key, token, tag or commitment | `mcp/native-signing.pg` |
| Channel code has no financial authority | Channel modules only mint start tokens and post FloFi text; the boundary test is unchanged and passes | `channels/boundaries.test` |

**The "no worse than confirmed" rule** (`noWorse`, unit-tested).
- **Why:** a Solana Review lives 60 s, and hopping from the chat to the wallet and back easily takes longer. Sending stale bytes would just fail.
- **What FloFi does:** it simulates again at confirmation. It continues only when the fresh run has the same owner, network, recipient, asset and amount, a fee and deposit at most as confirmed, and (for swaps) a minimum received at least as confirmed.
- **Otherwise:** the new Review is presented in the conversation and nothing reaches the wallet.
- **Who accepts the fresh run:** FloFi records the flow's acceptance of that fresh run on the owner's behalf, within the bounds the owner confirmed. The wallet still shows the exact transaction, and the owner's approval there remains the authority.

## 4. Per wallet and channel

Legend:
- **Impl.**: implemented.
- **CI**: covered by CI tests.
- **Ready**: ready for live acceptance.
- **Live**: live-verified on a real device and wallet.
- **Blocked**: blocked by a documented external limitation.

| | Impl. | CI | Ready | Live | Blocked |
|---|---|---|---|---|---|
| Phantom (Solana: transfer, Jupiter swap) | yes | yes (protocol-exact test wallet, MOCKED chain) | yes | **no** | — |
| Solflare (Solana: transfer, Jupiter swap) | yes | yes | yes | **no** | — |
| MetaMask | no native transport | — | — | — | **yes** (§5) |
| ChatGPT panel → Phantom/Solflare | yes | yes (gateway, app-only tools) | yes | **no** | — |
| Claude panel → Phantom/Solflare | yes | yes | yes | **no** | — |
| Telegram → Phantom/Solflare | yes | yes (Bot API double) | yes, where Flight is open (§5) | **no** | in Flight beta mode (§5) |
| Embedded in-chat signing frame, ChatGPT | diagnostics added | yes | after the observed sandbox origin is allowed | **no** | partly (§5) |
| Embedded in-chat signing frame, Claude | `ui.domain` behind a flag | yes | after the flag is enabled | **no** | **yes** for most connectors (§5) |
| EVM operations in any channel | FloFi signing page only | — | — | — | **yes** (needs MetaMask/WalletConnect, §5) |

## 5. Documented external limitations and decisions

### MetaMask

There is no maintained, commercially usable transport compatible with AGPL that delivers an arbitrary signing request to MetaMask Mobile:

| Option | Licence and terms | Why it is not used |
|---|---|---|
| MetaMask Connect (`@metamask/connect-evm` 2.1.1, `connect-multichain` 1.2.0); the legacy `@metamask/sdk` is deprecated | ConsenSys licence: distribution "solely for Non-Commercial Use"; one clause covers ≤ 10,000 MAU "as reasonably determined by ConsenSys in its sole discretion"; no published commercial terms (`metamask.license@consensys.net`) | Not AGPL-compatible without an agreement |
| WalletConnect / Reown (`@walletconnect/sign-client` 2.26.0) | WalletConnect Community License (Reown, 20 Aug 2025): paid commercial licence above 500 MAU or 2.5M RPC/month; must use Reown's gateway (§2b); modifications assigned to Reown (§1c) | Proprietary; 2.21.x (the last Apache-2.0) is excluded by the CTO |
| A clean-room client on the MIT WalletConnect spec | No SDK licence, but the public relay requires a Reown Cloud `projectId` (account and terms) | Needs a Reown account (and the CTO's approval) |
| EIP-681 links (`link.metamask.io/send/…`) | Open (CC0) | Native send and ERC-20 transfer only; any other function is dropped; no callback or transaction hash; a warning screen for unsigned links. Exact binding and reconciliation by hash are not possible |

**What the CTO can do:**
1. Obtain a commercial agreement with ConsenSys (MetaMask Connect).
2. Or obtain one with Reown (WalletConnect plus a `projectId`).
3. Either way, EVM signing in the channel then follows the same session design. Until then, EVM uses FloFi's signing page, including inside MetaMask's own browser.

### Telegram during the Flight beta

- **The evidence:** production holds 14 beta grants and one beta-bound MCP account.
- **What the API requires in beta mode:** every owner flow call must carry a live FloFi account session. An MCP account carries the identity it was bound to at sign-in, and the native service passes it on. A Telegram conversation carries none.
- **What happens today:** with `FLOFI_BETA_ACCESS=beta`, Telegram's native signing ends at the simulation with a plain message ("…not open to your account in this beta yet. Use the Authorize button…"). Nothing is sent.
- **Decision for the CTO:** how a Telegram conversation proves a Flight identity. This is an authentication design decision and is out of scope here.

### ChatGPT embedded frame

- **Why the frame is refused:** frames are blocked by default and the widget runs on a subdomain of `web-sandbox.oaiusercontent.com`. The current allowlist has the bare host only. The exact subdomain is not documented, and production logs held no record of it, because the panel showed its diagnostic only to the person.
- **What this BUILD adds:** the panel now reports the real frame chain (public origins and a closed code) through `report_panel_diagnostic`, logged as `mcp.panel.diagnostic`.
- **Next step:** set `FLOFI_MCP_FRAME_ANCESTORS` to the origin it logs, after CTO approval.

### Claude embedded frame

- **Why the frame never loads:** without `ui.domain`, Claude serves each conversation from its own sandbox host, so no fixed `frame-ancestors` list can match. That is the documented root cause.
- **What this BUILD adds:** `FLOFI_MCP_CLAUDE_UI_DOMAIN=enabled` declares the documented dedicated host for Claude clients. The host is SHA-256 of the exact connector URL the request came to; `https://flofi.xyz/api/mcp` → `57290993f7dd5cabb0ea146de14615bd.claudemcpcontent.com`. `frame-ancestors` now also lists the trailing-slash form.
- **Why the flag is off by default:** Claude shows an error instead of the panel when `ui.domain` does not match the person's configured URL.
- **What still blocks it:** Claude allows embedded sites only for verified directory listings or a limited set of organizations, and the person must approve the origin. Without that, the frame stays blocked whatever FloFi sends.
- **What works anyway:** native signing in Claude goes through `ui/open-link` and needs no frame.

### Return to the conversation

- **ChatGPT and Claude:** the transit page links to `https://chatgpt.com/` and `https://claude.ai/`.
- **Telegram:** the page links to `tg://resolve?domain=<bot>` when `FLOFI_TELEGRAM_BOT_USERNAME` is set. That variable is optional and not set.
- Whether each phone app reopens the conversation is live acceptance.

## 6. Live acceptance (owner, real devices)

1. **Telegram on iOS and Android:**
   1. Propose a 0.01 SOL transfer, then tap **Sign with Phantom**. Phantom opens and asks to connect, then to sign the FloFi message.
   2. The Review arrives in the chat. Tap **Confirm in Phantom**; Phantom shows the exact transfer. Approve it.
   3. The chat shows "Signed in Phantom and sent once by FloFi", then the reconciled receipt.
   4. Repeat with Solflare.
   5. Repeat with a reject at each wallet prompt; each must end with "Nothing was signed or sent".
   6. Run this in Flight-open conditions, or with the beta decision made.
2. **ChatGPT mobile and desktop, then Claude mobile and desktop:** the same flow from the panel. Check that the panel's Review matches the wallet's transaction, and that the receipt appears in the panel.
3. **Universal links:** record, per app (ChatGPT, Claude, Telegram in-app browser, Safari, Chrome), whether the wallet opened on its own or only on the transit page's button.
4. **ChatGPT desktop frame:** open a non-Solana approval and choose **Authorize in chat**. If it fails, read `mcp.panel.diagnostic` in the Vercel logs and propose `FLOFI_MCP_FRAME_ANCESTORS` from that origin.
5. **Mainnet transfers:** these also need the existing `GRYLOO_SOLANA_TRANSFER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`, unchanged here.

## 7. Configuration

- **Required:** none. The feature is on by default after an approved deploy; `FLOFI_NATIVE_SIGNING=disabled` is the kill switch.
- **Optional, each needing approval:**
  - `FLOFI_TELEGRAM_BOT_USERNAME`: the return link to Telegram.
  - `FLOFI_MCP_CLAUDE_UI_DOMAIN=enabled`: after a live check against the configured connector URL.
  - `FLOFI_MCP_FRAME_ANCESTORS`: only origins observed in `mcp.panel.diagnostic`.

## 8. Data

- **What a session journal holds:** the approval id, the requester (MCP account id or channel conversation id), the proven owner address, the Review facts, the sealed one-time key and wallet session token, the pending wallet request (a deeplink whose payload is encrypted for the wallet) and the outcome. No message text and no plaintext transaction bytes; the flow's own run journal keeps those, as before.
- **When it becomes inert:** within 15 minutes. The sealed key is useless once the session ends.
- **Retention:** the journal follows the execution log's retention. This BUILD adds no separate purge; that is a recorded gap.
