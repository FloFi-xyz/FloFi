# BUILD-FLOFI-FLIGHT-GUEST-COPY-006 — Email 6 v6: guest invitation copy of 24/11

Branch: `claude/fervent-davinci-l2q2my`. Base: `origin/main` at `37f3db3`.
Source of truth: Dayane's approved canvas "Flight FloFi · Convite dos convidados (24/11)", Board 02
(`https://claude.ai/artifact/9uXPXafzjLFoumXeKLeAYw#page-dcb81aee8d83`). Strings transcribed by the owner in the build request, used verbatim.

## Objective

Reposition invited guests as early contributors to FloFi's product development: each guest does, on FloFi, a real DeFi operation from
their own weekly routine, then tells the team how it went. Target guest send: **24 Nov 2026, 09:00 BRT / 12:00 UTC**, by explicit operator
action only. This build is copy and template versioning only. It has no new feature, no redesign and no new send path.

## Change

Email 6 (`CREATOR_INVITE`) advances from **v5 to v6**. Exactly five fields change, in PT and EN:

| Field | v5 (PT) | v6 (PT) |
|---|---|---|
| headline | Obrigada por embarcar com a gente. | Abrimos o acesso para o seu grupo. |
| intro | Você está entre as primeiras pessoas… Ainda estamos no começo… | Obrigada por topar testar. Você está entre as primeiras pessoas a usar a FloFi fora do nosso time. Estamos construindo a FloFi agora e queremos fazer isso junto com quem usa DeFi de verdade. Comece com valores pequenos, porque é mainnet, com dinheiro de verdade. |
| steps[1] | Conecta a sua carteira, escreve o que quer fazer… | Conecta a sua carteira e faz a sua missão: qual operação você faz toda semana em DeFi e que mais te cansa? Faz ela na FloFi. Confere a simulação e assina só o que fizer sentido para você. |
| steps[2] | Conta pra nós como foi: onde travou… | Conta para nós como foi: o que você esperava encontrar, onde travou e o que faria você usar a FloFi toda semana. Pode responder este e-mail ou chamar a Dayane no WhatsApp ou no Telegram. Se quiser, ela faz uma call de 20 min e acompanha o seu teste. |
| note | Depois da sua primeira rota… O seu código é pessoal e funciona uma vez só. | O seu código é pessoal e funciona uma vez só. |

The English strings are the owner's EN transcription, used exactly as given (see `templates.ts` and the `approvedV6` fixture).

These are unchanged and pinned by tests: subject (`Seu convite para o beta da FloFi ✈️`), preheader (`Seu código e como embarcar.`),
steps[0], CTA, brief URL, invite-code and boarding (`ABERTO`) panels, layout, pose, band, branding, footer, risk disclosure, privacy link
and one-click unsubscribe. A test replaces the five fields with a placeholder and asserts that the v6 HTML then equals the frozen v5 HTML,
byte for byte.

## Files changed

- `apps/reference-dapp/src/flight/email/templates.ts`: v6 copy; `TEMPLATE_VERSIONS.CREATOR_INVITE` 5 → 6;
  `LAUNCH_UPGRADABLE_FROM.CREATOR_INVITE` [5] → [6]; one `TEMPLATE_DEVIATIONS` entry; `renderEmailForVersion` sends v5 to the frozen
  renderer. `LAUNCH_LANGUAGE` stays PT.
- `apps/reference-dapp/src/flight/email/templates-v5.ts` (new): the v5 renderer frozen with the v4 conventions. It drops the imports of
  older renderers, the launch-language tables, the recovery renderer and the version dispatcher, and makes the brief URL a private constant.
  It is SHA-256 pinned.
- Tests: `email/templates.test.ts`, `launch.test.ts`, `launch.pg.test.ts`, `launch-1311.pg.test.ts`, `backend/flight-admin.pg.test.ts`.
- `docs/engineering/coverage.json` and `COVERAGE.md` map `templates-v5.ts`. Also this record and `docs/STATUS.md`.

No change to outbox or delivery code, invites, redemption, auth, wallets, boarding, CARD_FOUNDING, schema, environment, dependencies,
infrastructure or provider configuration.

## Versioning behaviour (existing mechanism, no new subsystem)

- **Unsent v5 rows:** housekeeping and lease move PENDING/HELD v5 rows to HELD `TEMPLATE_VERSION_REVIEW`. Delivery refuses to render any
  non-current `CREATOR_INVITE` version.
- **Rows that left the outbox:** SENT, SENDING and UNKNOWN v5 rows are never rewritten or replayed.
- **In-place upgrade:** `email-launch-upgrade` cannot move a v5 row to v6, because `LAUNCH_UPGRADABLE_FROM` is `[6]`.
- **New v6 rows** come only from operator commands:
  - `creator-supersede-templates --apply`: replaces never-attempted HELD v5 rows with new email ids, the same recipient and the same code.
  - `creator-requeue-missing --apply`: enqueues HELD `OPERATOR_REVIEW` in batch `creators-v6`, only for active CREATOR invites with no Email 6
    in PENDING/HELD/SENDING/UNKNOWN/SENT.
- **Already-sent invites:** an invite whose Email 6 v5 was SENT is never re-invited.
- **Codes:** no invite code is created, regenerated or invalidated.

## Evidence (local, this branch)

| Check | Result |
|---|---|
| Frozen v5 renderer vs `origin/main` `renderEmail` (9 templates × PT/EN, subject/preheader/HTML/text) | byte-identical (18/18) |
| `renderEmailForVersion` v1–v4 vs `origin/main` | identical |
| `templates.test.ts` v6 PT/EN: five strings in HTML and text, unchanged elements, layout diff only in the five fields; v5 historical fixture unchanged; v1–v5 + 99 refused by delivery | pass |
| `pnpm check` (typecheck, lint, build, schema drift, unit tests) | pass: 9998 passed, 2 skipped (existing skips) |
| `pnpm test:postgres`: disposable loopback PostgreSQL **16** | 1009 passed, 6 failed (see note) |
| `launch.pg` (legacy v1–v5 held; SENT/SENDING/UNKNOWN untouched; supersede to v6 with same code; invites unchanged), `launch-1311.pg` (requeue `creators-v6`, no duplicate for SENT, beta-list overlap is read-only and masked), `flight-admin.pg` (repeat invite does not resend SENT) | pass |
| `python3 scripts/governance_lite.py` + its 21 unit tests; `agent_guard.py check`; `git diff --check` | pass |

Note: the 6 failures (`database-privileges.pg`, `forward-compatibility.pg`) fail identically on unmodified `origin/main` with local
PostgreSQL 16. `MAINTAIN` needs PostgreSQL 17+, and CI uses 18.6. CircleCI is the certification authority for those suites and for
browser tests. No browser surface changed, and no email was sent: all transport in tests is a fake in-process provider.

## Specialist review (read-only)

- **flofi-frontend-ux:** no findings. All 10 strings match character for character; unchanged elements confirmed.
- **flofi-security:** no defects. Escaping, the code regex and the brief allow-list are enforced. The bump does not widen recipients, and
  nothing is sent on deploy.
  - Advisory L1 (copy, owner decision): the new call offer plus "message Dayane on WhatsApp/Telegram" could be exploited by an impersonator.
    Consider telling guests that Dayane will never ask for a seed phrase or a signature.
- **flofi-data-privacy:** no blocking findings. Four low, pre-existing outbox behaviours now apply to v5 rows:
  1. An orphaned v5 SENDING row is not recoverable by the CLI.
  2. The TEMPLATE_VERSION_REVIEW relabel overwrites the previous reason and the row is never pruned.
  3. Supersede cancels before it inserts, so a dedupe-key collision leaves an invite without Email 6.
  4. Supersede enqueues PENDING with no batch. It sends on the next cycle unless campaign email is paused, and it bypasses the release gate.
- Security L2 matches item 4. These are outside this build's authorized scope and are recorded for a follow-up. The runbook below mitigates them.

## Production launch prerequisites (not performed by this build)

1. Merge after green CircleCI, governance and Vercel checks. Then verify the deployed commit and the Railway worker. The worker renders
   email, so the worker must run v6 before any guest row is released.
2. Before the worker deploys, `email-pause`. Then `email-status` / `email-attention`: confirm no `CREATOR_INVITE` row is SENDING or UNKNOWN.
3. Dry-run only, then review with the owner:
   - `creator-supersede-templates`: lists the held v5 rows.
   - `creator-requeue-missing`: by invite status; expect EMAIL6_SENT = 0 and an eligible count equal to the 15 approved codes.
   - `guestWaitlistOverlap`: masked.
   - Confirm 15 recipients, v6, PT, zero beta-list-only recipients, no SENT duplicate.
4. A single test email to Dayane through a reviewed, isolated operator path, never a guest code. Dayane approves it.
5. A TEST invite code redeemed at flofi.xyz/board. A team member confirms the mainnet journey, signing in their own wallet.
6. With explicit owner/operator authorization at 09:00 BRT:
   - Apply the reviewed path. Supersede creates PENDING rows: keep campaign paused and use `email-hold-campaign --keep CREATOR_INVITE`
     before `email-resume`. Requeue creates HELD batch `creators-v6`: release with `email-release --batch creators-v6`.
   - Never run both blindly.
   - CARD_FOUNDING stays as found.

## Rollback

Roll forward is preferred. Reverting the code makes v6 rows "non-current": they are held (`TEMPLATE_VERSION_REVIEW`), never rendered
with v5 copy and never deleted. Historical outbox rows are never mutated in place. Once v6 rows exist, avoid re-superseding back to v5:
`creator-v5:<code>` keys may already exist (data-privacy finding 3). Recovery is by email id after reconciliation.

## Release status

**BUILD COMPLETE — LAUNCH BLOCKED** until the prerequisites above are verified with real evidence. This build sent no email, queried no
production data and executed no transaction.
