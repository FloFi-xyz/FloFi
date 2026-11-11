# BUILD-FLOFI-FLIGHT-EMAIL6-CONSOLE-FIX-001

Branch: `codex/flight-email6-console-fix`. Base: `origin/main` at `9cb5c7d3` (includes PR #183).

## Implemented

Email 6 (`CREATOR_INVITE`) advances from **v3 to v4**. Its former creator invitation and required X posting window are replaced with Dayane's approved PT/EN guest invitation: headline, introduction, personal code, boarding panel, three steps, guest brief, optional sharing note and invitation reason. The approved Notion URL is identical in both locales. Current rendering refuses a different destination. The date panel still derives from the existing Brasília calendar; the calendar itself is unchanged.

The 600px layout, branding, palette, typography, footer risk/privacy/unsubscribe, HTML escaping, text alternative, recipient language, stored invite binding, suppression, quota reservation and Resend delivery remain in place. Defaults remain `FloFi <hello@flofi.xyz>` and Reply-To `flofi.xyz@gmail.com`.

Historical v1/v2 files are untouched. `templates-v3.ts` freezes the previous renderer without changing its executable rendering; a SHA-256 regression pins the extracted file. `renderEmailForVersion` retains v3 inspection. Only Email 6 changes version; regressions compare every unrelated template to the frozen renderer in both languages.

Delivery refuses retired Email 6 versions with `TEMPLATE_VERSION_REVIEW`. Housekeeping holds legacy PENDING/HELD rows, and excludes legacy SENDING from expired-lease recovery. Leasing excludes legacy UNKNOWN before selecting a batch. SENT, SENDING and UNKNOWN legacy rows retain every field, including reservations and original provider keys. No automatic replacement or requeue is introduced. Tests exercise the existing explicit supersede operation only in disposable PostgreSQL: never-attempted, unreserved HELD rows get a new email id with the same recipient, locale and invite code. Existing invite records remain unchanged.

### Console root cause

The pinned `@privy-io/react-auth` **3.51.0** has a catalog request separate from its optional WalletConnect providers. FloFi's named `metamask`, `phantom`, `rabby_wallet`, `solflare` and `backpack` appearance entries make the SDK's `shouldFetchWcRegistryListings` return true. Its provider invokes `useExternalWalletListings`, which fetches `https://explorer-api.walletconnect.com/v3/wallets`, even when `externalWallets.walletConnect.enabled` is false. The strict signer CSP correctly blocks it.

FloFi now configures `detected_ethereum_wallets`, `detected_solana_wallets` and `coinbase_wallet`. The actual pinned SDK guard returns false, and its actual `WalletFilterer` retains injected MetaMask/Rabby, Phantom across both ecosystems, Solflare, Backpack and Coinbase's separate connector using fixture connectors. **No CSP directive, provider package, authorization or signing behavior is relaxed.**

The guarded browser regression executes the installed SDK catalog hook with only its app-config context replaced. The old list is a positive control under the unchanged account CSP; the new list must cause no catalog violation. Other auth browser tests use the existing loopback Privy emulator. These are different evidence levels; neither proves live Privy or extension behavior.

No `ObjectMultiplex`, `app-init-liveness` or `background-liveness` implementation was found in application/installed dependency JavaScript during inspection. Those warnings are consistent with injected extensions, but the affected Chrome profile's call stack/initiator was unavailable. Their specific source remains **unconfirmed**, and console output is not muted.

## Operator acceptance and manual send procedure

**No production query, invite modification, enqueue, campaign send, Gmail/Outlook test, configuration change or deployment is authorized by this procedure during this build.** The eight existing guest invites must be preserved. The owner performs the following separately after reviewing the PR and authorizing each real test recipient.

### Local PT and EN rendering

From the repository root, the following pure renderer writes fixture examples only. It imports no runtime/outbox/provider and needs no database or Resend credentials. The displayed code is a non-production fixture and must never be substituted for a stored recipient code in actual delivery.

```bash
node --input-type=module <<'JS'
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEmailForVersion, FLIGHT_CREATOR_BRIEF_URL } from './apps/reference-dapp/src/flight/email/templates.ts';
import { FLIGHT_DEFAULT_CALENDAR } from './apps/reference-dapp/src/flight/campaign.ts';
const dir = await mkdtemp(join(tmpdir(), 'flofi-email6-preview-'));
for (const language of ['PT', 'EN']) {
  const email = renderEmailForVersion({ template: 'CREATOR_INVITE', code: 'FLF-7Q2K-9XMB', briefUrl: FLIGHT_CREATOR_BRIEF_URL }, {
    language, recipient: 'fixture@example.invalid', origin: 'https://flofi.xyz', calendar: FLIGHT_DEFAULT_CALENDAR,
    unsubscribeUrl: 'https://flofi.xyz/board/unsubscribe?t=local-render-only'
  }, 4);
  for (const part of ['html', 'text']) await writeFile(join(dir, `${language}.${part === 'html' ? 'html' : 'txt'}`), email[part], { mode: 0o600 });
  console.log(language, JSON.stringify({ subject: email.subject, preheader: email.preheader }));
}
console.log(dir);
JS
```

1. Open both local HTML examples. Verify the exact subjects and preheaders against the approved copy in the request.
2. Verify every paragraph, punctuation, three numbered steps in order, the personal code and `NOV 12 09:00`. There is one info panel and no Test flight panel or required social promotion.
3. Verify the single CTA label (`Ler o brief do convidado` / `Read the guest brief`) and exact destination:
   `https://cooked-goat-9ec.notion.site/Flight-FloFi-Brief-do-criador-4147b5d0a5fd81afb15ffdeb090a6450`.
4. Verify the note below the CTA, invitation reason, unchanged DeFi risk notice, `https://flofi.xyz/privacy` and unsubscribe link. Verify all approved content and links in both `.txt` alternatives. The local unsubscribe fixture is intentionally not redeemable.

### Existing rows and provider reconciliation

Before any real test or guest send, an authorized operator must inspect the correct tenant's `email-status` and `email-attention` and read-only row details: template/version, recipient binding, code, state, attempts, first attempt, reservation, provider id and lease. Production was not inspected by this build; the existence/count of unsent legacy rows is unknown.

Keep campaign processing under owner control. Do not resume a worker or call a general due-send cycle to preview one message: it can send other eligible emails. Do not run `creator-invite(s)` again to recreate the eight existing invitations. Do not redeem, reissue or replace their codes.

For legacy rows, inspect Resend delivery logs first. Never rewrite a provider key's content. Leave SENT, SENDING and UNKNOWN untouched by migration; reconcile uncertain provider outcomes through the established operator process before considering any further action. An unresolved/expired lease is not evidence of non-delivery. Do not bulk-release `TEMPLATE_VERSION_REVIEW`.

The existing `creator-supersede-templates` command is **dry-run by default**. Its explicit `--apply` cancels only eligible never-attempted, unreserved HELD rows and queues current-version replacements with new email ids, preserving the existing code/recipient/language. It is not invoked by this build. Its selection is oldest-first with `--max`, not a recipient selector: the owner must review the entire candidate set and ensure it contains only authorized rows before any future apply. Do not use it as a selective test-send tool. Record approval, old/new ids, code binding and provider evidence privately; never publish addresses/codes.

### Resend daily budget and controlled inbox tests

1. Obtain the owner's explicit authorization and **exact Gmail PT and Outlook EN recipient addresses**. Do not infer addresses from this repository. Review the existing controlled-send tooling with the owner; this PR adds no bulk sender or new send command.
2. Reconcile **both** FloFi's daily/monthly reservations and outbox **and** the Resend account's actual usage/delivery logs, across all tenants, API keys and applications sharing the account. FloFi's counters alone do not establish account capacity. Check outstanding UNKNOWN/SENDING/reserved attempts, other queued messages, essential-access headroom and external sends; avoid double-counting already delivered messages represented in both systems.
3. Record the provider's reset window/timezone from the account and reconcile it with FloFi's UTC day/month counters. The November 11 BRT send date can cross a UTC boundary. Recheck immediately before sending and after each test. Free-plan budget is **100/day** (and the existing 3000/month cap); the **two tests consume two slots**. Compute remaining capacity from actual usage plus unresolved/outstanding obligations and all planned other sends. Hold if the counts cannot be reconciled. Do not raise limits or change production environment settings in this build.
4. With separate owner authorization, send **one real PT test to the approved Gmail address** and **one real EN test to the approved Outlook address** using isolated, reviewed recipient records and the existing Resend/suppression/idempotency/quota path. Never use or redirect an existing guest's bound code. Use a reviewed operator process for test invite data; local rendering fixtures are not delivery codes. Do not run the whole production queue to send these tests. If the current tooling cannot isolate these two sends, stop for an owner-reviewed procedure before sending.
5. Record each outbox/provider id privately and reconcile outcomes; never retry changed content under the same key. Visually inspect both **actual inboxes** (and spam folders), desktop/mobile widths where available, subject, preheader, code, CTA, note, footer and text alternative. Inspect raw headers for From `FloFi <hello@flofi.xyz>`, Reply-To `flofi.xyz@gmail.com`, `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Check reply routing and unsubscribe/suppression using controlled test data only.
6. Reconcile usage and delivery records again, including both tests and other account messages. The intended guest send is manual on **Wednesday November 11, 2026 BRT**; opening remains **Thursday November 12, 09:00 BRT / 2026-11-12T12:00:00Z**. Require the **owner's final explicit authorization for the actual guest campaign** and the reviewed recipient/version/code list. No scheduled or automatic campaign activation is introduced by this PR.

### Clean and extension-enabled Chrome acceptance

Use a new Chrome profile with all extensions absent, then the owner's normal wallet-enabled profile. In each, preserve Console/Network logs and inspect `/onboarding/wallets` after the owner's Google login. Verify embedded EVM/Solana creation/listing, app access, external injected-wallet discovery and the reviewed confirmation flow. Wallet ownership proofs and explicit signing must remain required. Do not execute real-money transactions for this diagnostic.

For any explorer request, record Network → Initiator and stack, the application chunk/source or `chrome-extension://` id, request URL, CSP violation and Chrome/extension versions. Compare with extensions disabled, then enable extensions individually. For ObjectMultiplex warnings, expand the stack and identify its source before assigning blame. Do not whitelist a host or suppress diagnostics to clear extension-generated warnings. Live Google/email auth, installed extension behavior and real wallet ceremonies remain owner acceptance; local emulator success cannot establish them.

## Validation and review

Results are recorded in the PR after gates finish. Required local checks: `pnpm check`, full PostgreSQL on a disposable loopback server, relevant guarded `auth-wallets`/`flight`/`flight-closed-beta`/`flight-team-early-access` profiles, engineering guard/result verification, governance and CI self-tests. Authoritative CircleCI certification and Vercel Preview status must be checked on the final PR head. AI reviews are advisory only.

## Rollback

Owner review/merge and deployment remain separate actions. To roll back source, revert this PR through the normal reviewed PR process and run the same gates. Do not downgrade existing v4 outbox rows, alter provider keys, requeue SENT/UNKNOWN/SENDING, undo delivery records or regenerate invite codes. A rolled-back renderer cannot deliver v4 rows: leave them held for operator reconciliation. The safest campaign response is to keep sends held until the approved renderer/version is restored. No migration, production configuration or database rollback is needed by this change. CSP remains strict before and after rollback.
