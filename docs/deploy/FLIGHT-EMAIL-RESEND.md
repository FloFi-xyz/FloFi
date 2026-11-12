# Flight FloFi email: Resend, DNS and replies to Gmail (runbook)

Status: **preparation only**. Nothing in this document was executed against Resend, Cloudflare, the `flofi.xyz` DNS zone, Gmail or production.
No record values are given here on purpose: SPF, DKIM and MX values come from the Resend dashboard for this account, and the DNS provider's
own screens. Each step says who does it and how to check it. The owner authorizes every step; this document authorizes none.

Decisions applied (team, 9 Nov 2026): provider **Resend, free plan**; sender **`FloFi <hello@flofi.xyz>`**; reply-to **`flofi.xyz@gmail.com`**
(read by Dayane); domain **`flofi.xyz`**; no paid mailbox; no paid marketing service; the API key only on the server that sends.

## 1. Before touching DNS: record what exists (read-only)

1. Find who hosts the zone: `dig +short NS flofi.xyz`. If the answers end in `ns.cloudflare.com`, the zone is on Cloudflare (Email Routing
   in §5 is available); otherwise use that provider's console.
2. Save the current records (screenshot or export) before any change:
   ```bash
   dig +short MX flofi.xyz
   ```
   ```bash
   dig +short TXT flofi.xyz
   ```
   ```bash
   dig +short TXT _dmarc.flofi.xyz
   ```
3. Decide with the owner, from that output:
   - **MX on the root (`flofi.xyz`)**: if some mail service already receives `@flofi.xyz` mail, do **not** replace its MX records; use that
     service's forwarding for `hello@` instead of §5. If there is no MX, §5 (Cloudflare Email Routing) adds its own.
   - **SPF on the root**: there must be at most **one** `v=spf1` TXT record per name. Resend's SPF lives on its own subdomain (see §2), so the
     root SPF normally stays as it is; if Cloudflare Email Routing adds an `include:` to the root SPF, merge it into the existing record, never
     create a second one.
   - **DMARC**: if `_dmarc.flofi.xyz` exists, keep its policy and only add what §4 says.

## 2. Resend account and domain (Resend dashboard; owner or delegate)

1. Create or open the Resend account on the free plan. **Confirm the account's real limits** (Settings → Usage / Billing; the reference is
   100 emails per day and 3,000 per month) and write them in `FLOFI_EMAIL_DAILY_LIMIT` / `FLOFI_EMAIL_MONTHLY_LIMIT` if they differ.
2. Domains → **Add domain** → `flofi.xyz` (region as Resend suggests). Resend then shows the exact records to create, typically:
   - an **MX** and a **TXT (SPF)** record on a sending subdomain (for example `send.flofi.xyz`), used for bounces;
   - a **TXT (DKIM)** record such as `resend._domainkey.flofi.xyz`.
   Copy the names and values **exactly as Resend shows them** (they are specific to the account). These records are on their own names: they
   do not change the root MX or root SPF.
3. Create them at the DNS provider (§3), then press **Verify** in Resend. Wait until the domain shows **Verified** (minutes to hours).
4. API Keys → **Create API key**. Prefer **Full access** (the worker then checks the domain status itself, `GET /domains`); a **Sending
   access** key also works but then the operator must set `FLOFI_RESEND_DOMAIN_ATTESTED=flofi.xyz` after checking step 3 by eye. Copy the key
   once into the Railway worker's variables as `RESEND_API_KEY` (§6). Never paste it into chat, a file in Git, Vercel, or a `NEXT_PUBLIC_` name.

## 3. DNS records (DNS provider; owner or delegate)

1. Add exactly the records Resend listed in §2.2. On Cloudflare, set them **DNS only** (grey cloud), never proxied.
2. Do not edit the root MX or root SPF for Resend (§1.3).
3. Check with `dig` that each name answers what Resend showed:
   ```bash
   dig +short TXT resend._domainkey.flofi.xyz
   ```
   (and the MX/TXT of the sending subdomain Resend named). Then **Verify** in Resend.

## 4. DMARC (after SPF and DKIM verify)

- If there is no `_dmarc.flofi.xyz` record, start in monitoring mode: a TXT record on `_dmarc.flofi.xyz` with `v=DMARC1; p=none;` and, if the
  team wants aggregate reports, `rua=mailto:<an address the team reads>` (a report address on another domain needs that domain's
  authorization record). Move to `p=quarantine` only after a week of reports shows Resend's mail passing.
- If a DMARC record exists, keep it. Resend's DKIM signs with `d=flofi.xyz`, so mail aligns with an existing policy; check the first test in §7.

## 5. Replies: `hello@flofi.xyz` → `flofi.xyz@gmail.com` (free)

**Update, 10 Nov 2026:** the public zone is on Vercel and its root has no MX. The concrete ImprovMX Free procedure, observed DNS,
required records and Gmail acceptance checklist are in [FLIGHT-INBOUND-IMPROVMX.md](./FLIGHT-INBOUND-IMPROVMX.md).
That procedure takes precedence for this zone. No forwarding has been activated by engineering.

Emails go out with `Reply-To: flofi.xyz@gmail.com`, so replies already reach Gmail directly. Forwarding `hello@flofi.xyz` covers people who
write to the sender address itself.

**Cloudflare Email Routing (if the zone is on Cloudflare and no other service receives `@flofi.xyz`):**
1. Cloudflare dashboard → `flofi.xyz` → Email → Email Routing → **Enable**. Cloudflare shows the MX and SPF records it needs and offers to add
   them; review them against §1 (one SPF record on the root: merge, never duplicate; do not remove an MX another service uses).
2. **Destination addresses** → add `flofi.xyz@gmail.com` → open the verification email in that Gmail inbox and confirm.
3. **Routing rules** → Custom address `hello@flofi.xyz` → Action *Send to an email* → `flofi.xyz@gmail.com` → Save.
4. Optional, free: in Gmail, Settings → Accounts → *Send mail as* `hello@flofi.xyz` only if the team wants to answer *from* that address
   (requires an SMTP relay; otherwise answer from the Gmail address, which is the agreed reply-to).

**Zone not on Cloudflare, or the root MX already belongs to a mail service:** use that DNS host's or mail service's free forwarding to
create `hello@flofi.xyz` → `flofi.xyz@gmail.com`. Do not move the zone to change MX without the owner's decision.

**Check:** from a personal address, send an email to `hello@flofi.xyz` and confirm it arrives in `flofi.xyz@gmail.com` (check Spam too).

## 6. Configure FloFi (owner; see ENVIRONMENT.md §5n)

| Service | Variables |
| --- | --- |
| Railway **worker** | `FLOFI_FLIGHT_EMAIL=enabled`, `RESEND_API_KEY`, `FLOFI_FLIGHT_ACCESS_SECRET` (same value as Vercel), optional `FLOFI_RESEND_DOMAIN_ATTESTED=flofi.xyz`, optional limits, and the campaign calendar variables if Vercel sets them |
| Vercel **Production** | `FLOFI_FLIGHT_ACCESS_SECRET` (≥ 32 random characters; generate it on the owner's machine, e.g. `openssl rand -base64 48`, and paste it only into the two dashboards) |
| Railway API | nothing new (it applies migration 0024 in its pre-deploy) |

The worker logs `flight.email.worker_enabled` when it starts, or `flight.email.worker_disabled` with a fixed code naming what is missing.

## 7. First real send (owner; only after §2–§6 and the release of 0024)

1. `node apps/reference-dapp/backend/flight-admin.ts email-status --tenant default` (production `DATABASE_URL`, `--tenant default`): limits,
   today's reservations, nothing held.
2. Join the list at `https://flofi.xyz/board` with a team Gmail address and a team Outlook address. Within about 15 seconds Email 1 arrives.
   Check in each: it is not in Spam; *Show original* says `SPF: PASS`, `DKIM: PASS` (`d=flofi.xyz`), `DMARC: PASS`; Reply goes to
   `flofi.xyz@gmail.com`; the unsubscribe link and the List-Unsubscribe button work; images show.
3. In Resend → Emails, the two sends appear; `email-status` shows them `SENT`.
4. Remove the test entries afterwards: `flight-admin.ts erase-email --email <address> --tenant default`.

Until step 2 passes, nothing proves real delivery: the repository's tests use a fake provider in the test process.

## 8. Operating during the campaign

| When (BRT) | What happens | Operator |
| --- | --- | --- |
| Tue 10 Nov | Email 6 to creators | `flight-admin.ts creator-invites --file <reviewed csv: email,language> --tenant default` (one invite and one Email 6 per address; codes are never printed for a list). The worker sends them as batch `creators`. |
| Wed 11 Nov 14:00–18:00 | Creators' test flight (TEST card, not stored) | Nothing |
| Wed 11 Nov 20:00 | Email 2 enqueued for the whole beta list as batch `eve` | Before 20:00: `email-status`; if the list is larger than the day's budget, the whole batch is **held** (`QUOTA_DAILY`), never partly sent: decide (see below) |
| Thu 12 Nov 9:00 | Email 3 enqueued for every open group (batch `group-<n>`; entries without a group: `group-0`) | `email-status` |
| Any time | A held batch | Choose: wait for the next day (`email-release --batch <key> --tenant default` the next day), send an explicit block within today's budget (`email-release --batch <key> --max <n>`), or raise capacity (an owner decision: upgrade the Resend plan in its dashboard, then raise `FLOFI_EMAIL_*_LIMIT` and release). FloFi never upgrades or sends partly on its own. |
| Incident | Stop campaign email now | `email-pause --reason "<why>"` (the person's own access requests still go out); `email-resume` |
| Provider stop | Resend answered quota exceeded or key invalid | The worker stops (`blockedReason`); fix, then `email-unblock` and `email-release --reason <CODE>` |
| Unknown outcome | A timeout etc. older than 23 h | `email-attention` lists it (`UNRESOLVED_OUTCOME`). Check Resend → Emails for that recipient: delivered → `email-mark-delivered --email-id <fem_…> --provider-id <id>`; not there → `email-release --email-id <fem_…>` |

The FloFi counter counts FloFi's own reservations only. Emails sent from the same Resend account by anything else also spend the quota: keep
`FLOFI_EMAIL_EXTERNAL_*_RESERVE` for them and compare with Resend's usage page before each large send.

## 9. Not provided by this build

- No bounce or complaint webhook is consumed (Resend shows them in its dashboard); a provider rejection fails the email.
- No open or click tracking (Resend's tracking stays off; the artifact's `email_open` / `email_click` events are not implemented).
- Email 0 (the old Google Forms list) is not one of the seven emails of this build.
