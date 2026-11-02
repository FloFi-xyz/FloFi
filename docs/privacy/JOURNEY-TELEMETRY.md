# Journey telemetry — privacy policy (LGPD first, GDPR too)

**Status: engineering policy pending owner and legal review (issue #149).** It describes what the code does and proposes a
legal basis. It is not legal advice and has no legal sign-off. Until the owner and counsel confirm it, the switches below stay
off. **Default: OFF.**

> **Resumo (PT-BR).** A telemetria de jornada mede apenas tempos (por exemplo, da intenção à primeira cotação), sem endereço,
> valor, token, hash, assinatura, texto de chat, conta ou IP gravados pela FloFi. Fica **desligada por padrão** e só liga
> quando o responsável pela implantação define `NEXT_PUBLIC_FLOFI_JOURNEY_TELEMETRY=on` (navegador) **e**
> `FLOFI_JOURNEY_TELEMETRY=on` (servidor). Base legal proposta: legítimo interesse (LGPD art. 7º, IX, e art. 10; GDPR art.
> 6(1)(f)), condicionada ao teste de balanceamento abaixo e à revisão jurídica. Retenção: a dos logs da plataforma; não há
> tabela nem cópia própria.

## 1. Purpose

Measure FloFi's own latency across one end-user journey (Build → Quote → Review → wallet → submission → confirmation →
reconciliation) so slow stages can be found and fixed. The person's own deliberation inside the wallet is reported apart from
system latency and is never counted as FloFi's speed. The data is an operational signal labelled `CLIENT_REPORTED`: never
used for profiling, marketing, credit, eligibility or any decision about a person, and never financial or certification
evidence.

## 2. Switches (default OFF, explicit opt-in by the deployment owner)

| Variable | Where | Read | Effect |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_FLOFI_JOURNEY_TELEMETRY` | browser build (web) | at build time (Next.js inlines it) | `on`: browsers send finished journeys as a same-origin beacon. Anything else: **no request is made at all**. |
| `FLOFI_JOURNEY_TELEMETRY` | server (web) | when the route module loads | `on`: `/api/flofi/journey` validates and logs accepted events. Anything else: the route answers `204` at once and reads no cookie, header or body, keeps no counter and logs nothing. |

Only the exact value `on` (any case, surrounding spaces ignored) turns a switch on; unset, empty, `off`, `true`, `1` or a typo
keep it off (`journeyTelemetryEnabled`, `apps/reference-dapp/src/domain/journey-metrics.ts`). Both must be `on` for anything to
be collected; either alone collects nothing. Environment changes apply to a new deployment, and the browser switch needs a
rebuild, so redeploy after changing either.

Before turning them on in production, the owner (with counsel):

1. confirms the legal basis and records the balancing test of §4 (LGPD art. 10; GDPR art. 6(1)(f));
2. adds this processing to the public privacy notice (`/privacy`): purpose, data, basis, retention, how to object
   (LGPD art. 9; GDPR art. 13). The notice does not mention it today because it is off;
3. records the log platform's actual retention, region and processors (and any log drain) in the record of processing
   (LGPD art. 37; GDPR art. 30), including any international transfer (LGPD art. 33; GDPR chapter V);
4. decides whether a per-person opt-out is required first (§7).

## 3. What is processed

**Sent by the browser** (only when the browser switch is on): one closed-schema event per finished journey, validated on both
sides by `parseJourneyEvent`; anything outside the schema is refused (`400`):

- a random version-4 UUID for the journey (never a quote, trace, run, session or account id);
- `operation` (one of 6), `network` (a chain FloFi registers, e.g. `eip155:8453`), `provider` (one of 8 routing labels or
  null), `wallet` kind (`privy-embedded`, `external`, `unknown`), `outcome` (one of 6);
- up to 12 named integer durations in milliseconds (0 to 24 h), and two totals the server recomputes and does not trust.

The beacon also carries what any same-origin request carries: the FloFi session cookie and the request metadata (IP address,
user agent, time) seen by the hosting platform.

**Logged by FloFi** (only when the server switch is on), one line per accepted event through the existing structured logger
(`apps/reference-dapp/src/server/journey-telemetry.ts`): the fields above, `evidence: CLIENT_REPORTED`, the deployment label
and the network's registry environment (MAINNET/TESTNET), plus the logger's timestamp, severity, event name and service. The
route runs outside any trace span, so no trace id is attached.

**Never collected or logged by FloFi**: wallet address, amount, asset or token, transaction hash, signature, chat text,
account or session identifier, IP address, user agent, cookie. The signed-in account is used only as an in-memory rate-limit
key (an HMAC under a per-process random key that never leaves the process), never logged or stored, and dropped when its
10-minute window ends. Refused requests log nothing.

**Logged by the platform anyway**: like every request, a beacon appears in the hosting platform's request logs (time, path,
status, IP address, user agent, region) under the platform's own retention. FloFi adds no body or header to those logs. With
the browser switch off, no beacon exists, so there is no such entry either.

The stored line carries no identifier, but it is **pseudonymous, not anonymous**: someone with access to the platform's request
logs could try to correlate it by time. FloFi does not do that, and this policy treats the processing as personal data.

## 4. Legal basis (proposal, pending owner/legal review)

LGPD art. 7, IX (legitimate interest of the controller), within the limits of art. 10; GDPR art. 6(1)(f).

Balancing note:

- **Interest**: a fast, reliable service for operations on real funds, where delay causes expired quotes, abandoned
  signatures and failed submissions. Server-side monitoring already exists, but it cannot see the browser and wallet stages.
- **Necessity and minimization** (LGPD arts. 6, III and 10 §1): timings only, a closed vocabulary, a random per-journey id, no
  account linkage in the line, aggregated p50/p95 reports with at least 20 samples per group
  (`scripts/journey-latency-report.mjs`).
- **Impact and expectations**: low (no content, no financial data, no decision about the person), but people do not expect it
  unless the privacy notice says so; hence prerequisite 2 of §2 (transparency, LGPD art. 10 §2).
- **Safeguards**: default off, two explicit switches, same-origin and signed-in only, size, rate and memory bounds (§5),
  no database table or second analytics system, retention of the platform's logs only.
- **Open points for counsel**: whether the per-person objection (LGPD art. 18 §2; GDPR art. 21) needs an in-product switch
  before production (§7), and whether ANPD's guidance calls for a written legitimate-interest assessment or impact report
  (LGPD art. 10 §3) for this processing.

## 5. Endpoint cost bounds (per server instance)

Same-origin only (`403`); a signed-in FloFi session, checked cryptographically without a database read (`401`); body at most
4 KiB, also for chunked bodies (`413`); closed schema (`400`); a journey id is logged once (`409`, at most 10,000 ids
remembered); at most 60 events per account per 10 minutes (at most 5,000 accounts tracked) and 600 accepted events per minute
overall (`429`). One log line of about 0.8 KB per accepted event: at most about 0.5 MB of log per minute per instance; N
instances admit N times as much. Off: zero work, zero lines.

## 6. Retention, deletion and access

- **Retention**: the log platform's (and any configured log drain's) retention for the deployment. FloFi keeps no table, file
  or other copy. The owner records the actual period (§2, prerequisite 3).
- **Deletion**: turn the switches off to stop collecting; delete existing lines with the platform's or drain's own log
  deletion, or let them expire. Because a line has no account identifier, a single person's lines cannot be selected without
  correlating platform request logs, which FloFi does not do; an erasure request is answered by stopping collection and
  the platform retention.
- **Access**: only people with access to the deployment's logs (owner and operators). Share aggregated reports only.

## 7. Opting out

- **Deployment**: unset either switch (or set it to `off`) and redeploy; nothing is sent or logged afterwards.
- **Person**: there is no per-person switch in the product today (gap, §4). A person can object through the contact on the
  privacy page, and a browser that blocks beacons sends nothing. Counsel decides whether a per-person switch is needed
  before production.

## 8. Rights

Data subject rights under LGPD art. 18 and GDPR arts. 15 to 22 apply through the contact on the privacy page, with the limits
of §6 (lines without an identifier).

## 9. Evidence

Unit suites: `apps/reference-dapp/src/domain/journey-metrics.test.ts` (opt-in parsing, no browser request when off, closed
schema), `apps/reference-dapp/src/app/api/flofi/journey/route.test.ts` (route off by default, nothing read),
`apps/reference-dapp/src/server/journey-telemetry.test.ts` (logged fields, bounds, no account in the log). These are local
tests; there is no production sample and no legal review yet.

Change history: issue #149 turned the default from ON (unset logged) to OFF and added the browser switch.
