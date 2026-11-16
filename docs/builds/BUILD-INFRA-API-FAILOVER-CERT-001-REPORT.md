# BUILD-INFRA-API-FAILOVER-CERT-001 — Report

Date: 2026-11-16. Branch `claude/peaceful-keller-dtdi1t`, base `origin/main` `b41ee5d` (last verified production commit).

**Recommendation: READY_FOR_2_REPLICAS once this change is merged and deployed — owner action required to merge, deploy and scale.**
Nothing in production was changed: no replica count, domain, secret, variable, migration, restart or deployment. Production facts
below were read only (service settings, variable *names*, deployment logs). No transaction was signed or broadcast; every chain in the
evidence is the repository's MOCKED loopback chain, and every result is local unless labelled as a production observation.

## Question

Can `flofi-api` (`node apps/reference-dapp/backend/main.ts api`) run as two Railway replicas on the shared Neon database without
breaking workflows, sessions or financial operations, and stay available when one replica is stopped?

## Defects found and fixed

1. **A stopping replica kept taking new work and was cut at 25 s** (reproduced locally on the pinned Node 24.21.0; inferred for
   Railway). On SIGTERM the API called `server.close()`. Node then refuses new TCP connections but keeps serving **new requests on
   connections kept alive** (answers still say `Connection: keep-alive`), and the close callback never fires while the client keeps its
   sockets. A reverse proxy that pools upstream connections would therefore keep sending work to the stopping replica (Railway's
   healthcheck runs only at deployment start, so it never takes a running replica out of rotation), and the replica exited only through
   the forced `process.exit(0)` at 25 s, cutting what it had started.
2. **The pool could close under a running mutation.** `server.close()` waits for connections, not handlers. A mutation whose caller
   already disconnected (its own deadline passed) keeps running by design; the shutdown could end the database pool under it.
3. **A repeated SIGTERM killed the replica mid-drain** (`process.once`: the second signal took Node's default action).
4. **One unauthenticated request could end an API process** (pre-existing on `main`): a request-target the URL parser refuses (`GET //`,
   `///`, `//a:99999/`, `http://`) threw from `new URL` inside the request listener, an uncaught exception (exit 1). It is included
   because it defeats the availability this certification is about (it can take down every replica in turn); the fix is one guarded
   parse.

**Fix (minimal; no route, authorization, idempotency, lease, queue, schema, BFF or UX change):**
- `packages/cloud-runtime/src/http.ts`: once the server stops listening, every answer — including one to a request that arrived
  before — carries `Connection: close`, and `/readyz` answers 503 (without a database query once draining). The server counts running
  route handlers and exposes `drained()`. An unparseable request-target is answered `400 REQUEST_INVALID` (before authentication, as
  `/healthz` is; nothing is routed and the target is not echoed).
- `apps/reference-dapp/backend/main.ts`: the pool closes after the server closed **and** `drained()` resolved; repeated signals are
  ignored (one drain); the unchanged 25 s cap is armed first and logs `api.stop_timeout` before exiting (exit code unchanged).

## Evidence (local, isolated)

Environment: Node 24.21.0 (SHA-256 verified), pnpm 11.22.0, frozen install, `postgres:18.6-bookworm` with the CircleCI image digest on
loopback, disposable databases created and dropped by `pg-harness.ts`. MOCKED Robinhood Testnet chain on `127.0.0.1:8553`; the test is
the only "wallet" (`MOCK_submit`, public fixture key, no funds).

### Existing suites (reused first)

| Suite | Result |
| --- | --- |
| `pnpm test:postgres` on unmodified `main` | 129 files passed, 1 skipped; 883 tests passed, 3 skipped (`schema-compatibility` 11/12 run only with a forward-migration certificate, `describe.runIf`) |
| Already covered there | two backend instances (one process) racing `begin`, idempotent HTTP replay/conflict, fenced leases and takeover, SKIP LOCKED work queue with reclaimed leases, sweeper, tenant isolation, worker SIGTERM from `worker.starting` |
| Not covered | two real API **processes**, SIGTERM/SIGKILL of one replica during requests, HTTP drain behaviour, malformed request-targets |

### New certification: `apps/reference-dapp/backend/api-failover.pg.test.ts`

Two real `main.ts api` processes (`NODE_ENV=production`, bearer token, `DATABASE_POOL_MAX=4`) on one database; the real worker runs in
scenario 4, after the API replicas stopped. Requests are held deterministically at the chain's `eth_getTransactionCount` (a gate the
test opens), not by timing. The numbers are from single runs of the final test (they were stable across runs).

| # | Scenario | The test asserts (observed values) | Without the fix |
| --- | --- | --- | --- |
| 1 | one simulate sent to **both** replicas at once with the same idempotency key; review, begin, handoff and report on alternating replicas; `begin` raced on both | one run; the other replica answers `409 IDEMPOTENCY_IN_PROGRESS` or the replay (observed: 409), then the identical replay; exactly one PREPARED attempt, the loser answering `TRANSFER_BUSY` or `TRANSFER_EXISTING_ATTEMPT_OBSERVE_ONLY` (observed: the latter); journal `PREPARED → SUBMITTING → PENDING`; one transaction | pass (unmodified `main`) |
| 2 | SIGTERM on replica A with three owner requests inside their handlers, held 2 s into the drain | all three answer 200 with `Connection: close`; the next request on A's pooled connections is refused (`ECONNREFUSED`/`ECONNRESET`), and the test then sends the same key to B, which answers it; B answered reads during A's drain (observed: 18–19 in the 2 s) with 0 failures; A exits 0 well under the 25 s cap (observed: 2.1 s after SIGTERM, i.e. once released); every claim `COMPLETED`, no lease left held | **fails** on unmodified `main`: answers `keep-alive`, the new request is **served by the draining replica**, A exits only at **25 014 ms** (forced) |
| 2b | the caller of a running simulate disconnects; SIGTERM, then a second SIGTERM; the simulate is released after the drain began | the replica stays alive through the second signal; the handler ends after `api.stopping`; the mutation stores its answer (claim `COMPLETED`); the later retry on B is a replay; exit 0 (observed: 0.3 s after SIGTERM) | intermediate build without `drained()`: the pool closes under the mutation, claim left `IN_PROGRESS`; with `process.once`: killed by the second SIGTERM |
| 3 | restarted replica killed (SIGKILL) during `begin`'s chain read, before its first write | claim left `IN_PROGRESS` (observed: 120 s) and the run lease (observed: 30 s); no attempt, no transaction; the BFF's retry on B gets `IDEMPOTENCY_IN_PROGRESS` while other runs are served; after both windows (fast-forwarded in the database) B takes over the same key: one PREPARED attempt, replay on repeat, the lease fence advances past the crashed holder's (observed: 2 → 3) | pass (unmodified `main`) |
| 4 | every API replica stopped; worker started; fresh replica | the worker reconciles the owner-signed attempt (`CONFIRMED`, `RECONCILED`); the fresh replica reports it; one transaction | pass (unmodified `main`) |

PostgreSQL connections were sampled throughout: the observed peak for both replicas together was 4 (an observation of this load, not a
proof of the pool bound, which is `pg.Pool`'s `max`). Each regression was confirmed by mutation: removing `Connection: close` fails
scenario 2, removing the `drained()` wait or restoring `process.once` fails scenario 2b. Stability: with the fix, every run of every
version of the suite passed; the final version passed 6/6 consecutive runs plus the full PostgreSQL stage, about 12 s per run.

Unit stage: `packages/cloud-runtime/test/http-drain.test.ts` (after `close()` an in-flight answer and an in-flight readiness probe close
their connection, readiness 503, a new connection is refused, the server closes without waiting for the client's kept-alive sockets,
`drained()` waits for a handler whose caller left; 20/20 consecutive passes; fails on the unmodified `http.ts`) and
`packages/cloud-runtime/test/http-request-target.test.ts` (`//`, `///`, `//a:99999/`, `http://` → 400 and the process keeps serving;
absolute-form, `OPTIONS *` and odd query strings behave as before, auth included; fails without the guard with an uncaught
`TypeError: Invalid URL`). All three suites are required suites in `docs/engineering/coverage.json`, so a skip or removal fails
`agent_guard.py verify-results`.

### Production observations (read only)

- `flofi-api`: 1 replica (`us-east4`), `drainingSeconds` 30, `overlapSeconds` 15, healthcheck `/readyz`; `flofi-worker`: 1 replica,
  `drainingSeconds` 130. Neither service sets `DATABASE_POOL_MAX` (10 per process).
- SIGTERM reaches the Node process through the start command: replaced deployments `43ec95d0` and `b30a205b` logged `api.stopping`
  before Railway's "Stopping Container".

## In-process state audit (API path)

The import closure of `backend/app.ts`, `automation-api.ts` and `delegation-api.ts` (515 modules) was searched for module- and
factory-level state and every hit read; the specialists re-checked the main claims. No state on the hosted API path is
correctness-relevant across replicas: every mutating flow method runs under the PostgreSQL fenced lease, and every log write re-checks
it and compare-and-sets the log version; owner nonces, transaction hashes, Solana messages/signatures and payout orders are create-once
rows; Flight/beta sessions and grants, passkey challenges (consumed once), Telegram link codes and rate limits and approval handoffs
live in PostgreSQL. Per-process state is pacing (RPC queues), memoization and TTL read caches (catalog loaders 30–300 s) whose staleness
can only refuse or reproduce the reviewed bytes, because Review bindings are durable and `begin` re-reads under the lease.
Configuration-only caveats: a memory/local delegated signer keeps keys in one process (refused on any hosted deployment; production's
API has KMS variables configured — names read, values not), and a filesystem evidence store serves evidence only on the replica holding
the file (production has the object-store variables configured). The API is the only raw `node:http` server in production; the other
`new URL(request.url)` uses are Next.js route handlers (Fetch `Request`, absolute URL) or test harnesses.

## Pre-existing findings and limits (not caused by the replica count; not changed here)

| Finding | Effect | Suggested follow-up |
| --- | --- | --- |
| **Owner nonce stuck after a failed PREPARED write** (`robinhood-transfer-service.ts`, `reserveNonce` then `save(prepared)`: two durable writes). Verified with an injected database failure on the PREPARED write: the retry of `begin` and a new run of the same owner nonce both answer `TRANSFER_NONCE_ALREADY_RESERVED`; the run stays `PENDING` without attempt. | Fails closed (nothing is sent), but the owner cannot execute that transfer in FloFi until their chain nonce moves outside FloFi. A transient database error, a crash, the 25 s cap or a SIGKILL between the two writes triggers it — equally with one replica. | Accept the run's own reservation (`last.id === record.id`, same transaction, no attempt) in `reserveNonce`, with a PostgreSQL test that fails between the writes; check the other flows' nonce reservations for the same two-write shape. Wallet-execution/transfer review. |
| Idempotency takeover is not bound to the holder: after a claim's 120 s, a retry takes it over; the first holder's late `complete`/`release` can overwrite or delete it. | Only the stored replay can be lost; leases and durable state still prevent a second economic mutation. A `simulate` slower than 120 s could create two runs for one key. | Bind complete/release to a claim token. |
| The BFF's run/journal/list reads (`readCloudRun`, `listCloudRuns`) are not retried; flow calls retry the same edge URL for about 3.5 s (previews about 1.5 s). | If the edge keeps a stopping replica in rotation, unretried reads that reach it fail (`CLOUD_API_UNAVAILABLE`) for as long as that lasts, at most the drain. | Optional bounded retry for reads. |
| `FLOFI_EXECUTION_PAUSED` is read from each process's environment. | After the variable changes, the old replicas accept new work until the new deployment is healthy plus `overlapSeconds` (15 s); then in-flight requests may finish within 25 s. The worker follows its own drain (cap 120 s). | Operational note. |
| Node HTTP limits during a drain: `close()` drops idle connections whose last answer is still being flushed (a large read can be cut); a connection opened before the drain that has not sent its request yet can still deliver one (it then gets `Connection: close`, and keeps the replica draining up to the cap); a pipelined request behind a closing answer runs without its answer being delivered (new with `Connection: close`; its idempotency key makes the retry a replay). | Reads can fail once; work can start late in the drain and be cut at 25 s. Whether Railway's edge pre-opens or pipelines upstream connections is unknown. | Accept, or track sockets and end each after its own answer. |
| The worker still uses `process.once` for its signals. | A repeated SIGTERM ends the worker mid-drain (its leases and claims expire). | Align with the API in a follow-up. |

## PostgreSQL pool impact

Default 10 connections per process. Steady state with two API replicas: 2 × 10 + worker 10 = **30**. During an API deployment the old
replicas overlap the new ones for `overlapSeconds` plus up to 25 s of drain: 4 × 10 + 10 = 50, plus the pre-deploy `migrate` (1); if a
worker deployment overlaps too, +10 → about **61** at most, before the Vercel functions (which keep their own pools, independent of the
API replica count). Production's compute autoscales 0.25–8 CU; Neon's `max_connections` is 112 at 0.25 CU (105 usable). Through the
pooled host (`-pooler`, PgBouncer transaction mode, `default_pool_size` = 0.9 × `max_connections`, up to 10 000 client connections)
this is well within limits even at the minimum size; on a direct host the deployment peak plus Vercel could approach it.
`DATABASE_URL`'s value was not read; `docs/deploy/CLOUD.md` already requires the pooled string at runtime and the direct one for
`migrate`. Budget: `(2 × API replicas + 2 × worker replicas) × DATABASE_POOL_MAX + 1 + Vercel instances × their pool` must stay under
the pooler (or direct) limit at the minimum compute size.

## Railway parameters (recommended)

| Setting | flofi-api | Why |
| --- | --- | --- |
| Replicas | 2, same region (`us-east4`) | the tested topology (two processes, one database; loopback); one region keeps database latency unchanged |
| `drainingSeconds` | 30 (unchanged) | above the API's 25 s cap |
| `overlapSeconds` | 15 (unchanged) | new replicas pass `/readyz` before the old ones get SIGTERM |
| `healthcheckPath` | `/readyz` (unchanged) | checks the database |
| `DATABASE_POOL_MAX` | unset (10) or explicit 10 | see the budget above |
| `flofi-worker` | unchanged (1 replica, `drainingSeconds` 130 > its 120 s cap) | the worker is already replica-safe |

Drift for the owner to decide (no action taken; editing these files could change production on the next deploy if the services read
them): `deploy/railway/api.railway.json` has no `drainingSeconds`, `overlapSeconds` or replica count, so a service recreated from it
would get Railway's defaults; `deploy/railway/worker.railway.json` and `docs/deploy/CLOUD.md` say `drainingSeconds: 90` while the live
worker uses 130 (the worker's own cap is 120 s). Live values differing from the files suggest the services do not read them.

## Rollout and rollback

1. Merge this PR; the deploy (still one replica) replaces a replica that runs the previous code, so it proves nothing about the new
   drain. Then redeploy once (still one replica): the replaced replica now runs this code. Check its logs for `api.stopping` and no
   `api.stop_timeout`, with a light read load through the product meanwhile and no HTTP 5xx.
2. Scale `flofi-api` to 2. Watch: HTTP 5xx, `api.stop_timeout`, `IDEMPOTENCY_IN_PROGRESS` and `*_BUSY` refusals, Neon connections,
   RPC 429s (each replica paces its own RPC reads, so the aggregate read rate doubles).
3. Rollback: set replicas back to 1 first; no schema, data or protocol depends on the replica count. Reverting the code while two
   replicas run brings back defects 1–4 — no worse than today's single-replica deploys, but not the certified state — so revert the code,
   if needed, after scaling back.

## Not proven here

Railway's edge proxy itself (whether it pools or pre-opens upstream connections, pipelines, its idle timeout, and whether it retries a
refused or reset connection on another replica) could not be observed without touching production. In scenario 2 the test sends the
retry to replica B itself; in production the BFF can only retry the same edge URL (flow calls for about 3.5 s, reads not at all), so
availability during a drain depends on the edge routing new connections to the replica that still listens. Not exercised either: the
opt-in route families (automations, delegation/passkeys) and every flow other than the robinhood transfer across two processes (their
replica safety rests on the code audit); Flight/beta mode with wallet principals; hosted-only guards (the test processes are not
"hosted"); work longer than the 25 s cap (cut and failing closed: its claim and lease expire as in scenario 3, except the nonce window
above); public execution, mainnet and the hosted environment. CircleCI remains the certification authority.
