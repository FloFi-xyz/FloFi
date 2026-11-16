# BUILD-INFRA-API-FAILOVER-CERT-001 — Report

Date: 2026-11-16. Branch `claude/peaceful-keller-dtdi1t`, base `origin/main` `b41ee5d` (last verified production commit).

**Recommendation: READY_FOR_2_REPLICAS once this change is merged and deployed — owner action required to merge, deploy and scale.**
Nothing in production was changed: no replica count, domain, secret, variable, migration, restart or deployment. Production facts
below were read only (service settings, variable *names*, deployment logs). No transaction was signed or broadcast; every chain in the
evidence is the repository's MOCKED loopback chain.

## Question

Can `flofi-api` (`node apps/reference-dapp/backend/main.ts api`) run as two Railway replicas on the shared Neon database without
breaking workflows, sessions or financial operations, and stay available when one replica is stopped?

## Defects found and fixed

1. **A stopping replica kept taking new work and was cut at 25 s** (reproduced on the pinned Node 24.21.0). On SIGTERM the API called
   `server.close()`. Node then refuses new TCP connections but keeps serving **new requests on connections kept alive** (answers still
   say `Connection: keep-alive`), and the close callback never fires while the client keeps its sockets. A reverse proxy pools exactly
   such connections, and Railway's healthcheck runs only at deployment start, never to take a running replica out of rotation. The
   replica took new work for the whole drain and exited only through the forced `process.exit(0)` at 25 s, cutting what it had started.
2. **The pool could close under a running mutation.** `server.close()` waits for connections, not handlers. A mutation whose caller
   already disconnected (its own deadline passed) keeps running by design; the shutdown could end the database pool under it.

**Fix (minimal, no route/authorization/idempotency/lease/queue/schema/BFF/UX change):**
- `packages/cloud-runtime/src/http.ts`: once the server stops listening, every answer — including one to a request that arrived
  before — carries `Connection: close`, and `/readyz` answers 503 (without a database query when the probe arrives after the drain
  started). The server counts running route handlers and exposes `drained()`.
- `apps/reference-dapp/backend/main.ts`: the pool closes after the server closed **and** `drained()` resolved; a second signal does
  not start a second shutdown; the unchanged 25 s cap now logs `api.stop_timeout` before exiting (exit code unchanged).

## Evidence (local, isolated)

Environment: Node 24.21.0 (SHA-256 verified), pnpm 11.22.0, frozen install, `postgres:18.6-bookworm` with the CircleCI image digest on
loopback, disposable databases created and dropped by `pg-harness.ts`. MOCKED Robinhood Testnet chain on `127.0.0.1:8553`; the test is
the only "wallet" (`MOCK_submit`, public fixture key, no funds). These are local results, not production observations.

### Existing suites (reused first)

| Suite | Result |
| --- | --- |
| `pnpm test:postgres` on unmodified `main` | 129 files passed, 1 skipped; 883 tests passed, 3 skipped (`schema-compatibility` 11/12 run only with a forward-migration certificate, `describe.runIf`) |
| Already covered there | two backend instances (one process) racing `begin`, idempotent HTTP replay/conflict, fenced leases and takeover, SKIP LOCKED work queue with reclaimed leases, sweeper, tenant isolation, worker SIGTERM from `worker.starting` |
| Not covered | two real API **processes**, SIGTERM/SIGKILL of one replica during requests, HTTP drain behaviour |

### New certification: `apps/reference-dapp/backend/api-failover.pg.test.ts`

Two real `main.ts api` processes (`NODE_ENV=production`, bearer token, `DATABASE_POOL_MAX=4`) on one database, plus the real worker.

| # | Scenario | With the fix (every run) | Unmodified `main` |
| --- | --- | --- | --- |
| 1 | simulate/review/begin/handoff/report alternating between replicas; one simulate sent to **both** replicas at once with the same idempotency key; `begin` raced on both | one run: the other replica answers `409 IDEMPOTENCY_IN_PROGRESS`, then the identical replay; one PREPARED attempt (the loser gets `TRANSFER_EXISTING_ATTEMPT_OBSERVE_ONLY`); journal `PREPARED → SUBMITTING → PENDING`; one transaction | pass |
| 2 | SIGTERM on replica A with three owner requests inside their handlers | all three answer 200 with `Connection: close`; the next request on A's pooled connections is refused (`ECONNREFUSED`) and the same key succeeds on B; A exits 0 about 4.9 s after SIGTERM, when its work ended; B served 45 reads with 0 failures meanwhile; every claim `COMPLETED`, no lease left held; peak 4 PostgreSQL connections for both replicas (bound 2 × 4) | **fails**: answers `keep-alive`, the new request is **served by the draining replica**, A exits only at **25 014 ms** (forced) |
| 2b | the caller of a running simulate disconnects, then SIGTERM | the mutation completes and stores its answer (claim `COMPLETED`); the later retry on B is a replay; exit 0 about 3.0 s after SIGTERM | with the connection fix but without `drained()`: the replica exits at once with the pool closed under the mutation; claim left `IN_PROGRESS` (whole scenario 1.4 s) |
| 3 | restarted replica killed (SIGKILL) during `begin`'s chain read, before its first write | claim left `IN_PROGRESS` for 120 s and the run lease for 30 s (measured); no attempt, no transaction; the BFF's retry on B gets `IDEMPOTENCY_IN_PROGRESS` while other runs are served; after both windows (fast-forwarded in the database) B takes over the same key: one PREPARED attempt, replay on repeat, lease fence 2 → 3 | pass |
| 4 | every API replica stopped; worker started; fresh replica | the worker reconciles the owner-signed attempt (`CONFIRMED`, `RECONCILED`); the fresh replica reports it; one transaction | pass |

Stability: 5/5 consecutive passes before the review follow-ups and 6/6 after them (about 17 s per run).
`packages/cloud-runtime/test/http-drain.test.ts` (unit stage) pins the HTTP contract — after `close()` an in-flight answer and an
in-flight readiness probe close their connection (readiness 503), a new connection is refused, the server closes without waiting for
the client's kept-alive sockets, and `drained()` waits for a handler whose caller left. It fails on the unmodified `http.ts`; it passed
20/20 consecutive runs. Both suites are registered in `docs/engineering/coverage.json` (required postgres/unit suites), so a skip or
removal fails `agent_guard.py verify-results`.

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
the file (production has the object-store variables configured).

## Pre-existing findings (not caused by the replica count; not changed here)

| Finding | Effect | Suggested follow-up |
| --- | --- | --- |
| **Owner nonce stuck after a failed PREPARED write** (`robinhood-transfer-service.ts`, `reserveNonce` then `save(prepared)`: two durable writes). Verified with an injected database failure on the PREPARED write: the retry of `begin` and a new run of the same owner nonce both answer `TRANSFER_NONCE_ALREADY_RESERVED`; the run stays `PENDING` without attempt. | Fails closed (nothing is sent), but the owner cannot execute that transfer in FloFi until their chain nonce moves outside FloFi. Any transient database error, crash or forced exit between the two writes triggers it — equally with one replica. | Accept the run's own reservation (`last.id === record.id`, same transaction, no attempt) in `reserveNonce`, with a PostgreSQL test that fails between the writes; check the other flows' nonce reservations for the same two-write shape. Wallet-execution/transfer review. |
| Idempotency takeover is not bound to the holder: after a claim's 120 s, a retry takes it over; the first holder's late `complete`/`release` can overwrite or delete it. | Only the stored replay can be lost; leases and durable state still prevent a second economic mutation. A `simulate` slower than 120 s could create two runs for one key. | Bind complete/release to a claim token. |
| The BFF's run/journal/list reads (`readCloudRun`, `listCloudRuns`) are not retried. | A read the edge cannot place at the instant of a drain may answer `CLOUD_API_UNAVAILABLE` once (flow and preview calls do retry with the same key). | Optional bounded retry for reads. |
| `FLOFI_EXECUTION_PAUSED` is read from each process's environment. | During a redeploy the old replicas stay unpaused until they drain (bounded by the 25 s cap). | Operational note. |

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
| Replicas | 2, same region (`us-east4`) | the certified topology; one region keeps database latency unchanged |
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

1. Merge this PR and deploy with **one** replica. On that deploy the replaced replica should log `api.stopping` and no `api.stop_timeout`.
2. Scale `flofi-api` to 2. Watch: HTTP 5xx, `api.stop_timeout`, `IDEMPOTENCY_IN_PROGRESS` and `*_BUSY` refusals, Neon connections,
   RPC 429s (each replica paces its own RPC reads, so the aggregate read rate doubles).
3. Rollback: set replicas back to 1. No schema, data or protocol depends on the replica count. Reverting the code is independent and
   safe in either order (the change only alters drain behaviour).

## Not proven here

Railway's edge proxy itself (whether it pools upstream connections, its idle timeout, and whether it retries a refused or reset
connection on another replica) could not be observed without touching production; the test client retries on the other replica as the
BFF does. Not exercised either: Flight/beta mode with wallet principals across replicas, hosted-only guards (the test processes are not
"hosted"), work longer than the 25 s cap (cut; its claim and lease then expire as in scenario 3), HTTP pipelining by a proxy, public
execution, mainnet and the hosted environment. CircleCI remains the certification authority.
