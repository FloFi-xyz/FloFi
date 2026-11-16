# BUILD-INFRA-API-FAILOVER-CERT-001 — Report

Date: 2026-11-16. Branch `claude/peaceful-keller-dtdi1t`, base `origin/main` `b41ee5d` (last verified production commit).

**Status: READY_FOR_2_REPLICAS once this change is deployed — owner action required to merge, deploy and scale.** Nothing in
production was changed: no replica count, domain, secret, variable, migration, restart or deployment. Production facts below were
read only. No transaction was signed or broadcast; every chain in the evidence is the repository's MOCKED loopback chain.

## Question

Can `flofi-api` (`node apps/reference-dapp/backend/main.ts api`) run as two Railway replicas on the shared Neon database without
breaking workflows, sessions or financial operations, and stay available when one replica is stopped?

## Finding and fix

**Defect (reproduced on the pinned Node 24.21.0):** on SIGTERM the API called `server.close()`. Node then refuses new TCP
connections but keeps serving **new requests on connections kept alive** (answers still say `Connection: keep-alive`), and the close
callback never fires while the client keeps its sockets. A reverse proxy pools exactly such connections, and Railway's healthcheck is
used only at deployment start, never to take a running replica out of rotation. Result: a stopping replica kept taking new work for
the whole drain and only exited through the forced `process.exit(0)` at 25 s, cutting whatever it had started meanwhile.

**Fix (minimal):**
- `packages/cloud-runtime/src/http.ts`: once the server stops listening (`server.close()`), every answer — including one to a request
  that arrived before — carries `Connection: close`, and `/readyz` answers 503. In-flight work completes; no new work starts on the
  draining replica; the server closes as soon as its last answer is written.
- `apps/reference-dapp/backend/main.ts`: the unchanged 25 s cap now logs `api.stop_timeout` before exiting (exit code unchanged), so a
  drain that had to cut requests is visible in the Railway logs.

No route, authorization, idempotency, lease, queue, schema, BFF, frontend or UX change.

## Evidence (local, isolated)

Environment: Node 24.21.0 (SHA-256 verified), pnpm 11.22.0, frozen install, `postgres:18.6-bookworm` (same image digest as CircleCI) on
loopback, disposable databases created and dropped by `pg-harness.ts`. MOCKED Robinhood Testnet chain on `127.0.0.1:8553`; the test is
the only "wallet" (`MOCK_submit`, public fixture key, no funds). These are local results, not production observations.

### Existing suites (reused first)

| Suite | Result |
| --- | --- |
| `pnpm test:postgres` on unmodified `main` | 129 files passed, 1 skipped; 883 tests passed, 3 skipped (`schema-compatibility` 11/12 run only with a forward-migration certificate, `describe.runIf`) |
| Already covered there | two backend instances racing `begin` (one attempt, one economic intent per nonce), idempotent HTTP replay/conflict, fenced leases and takeover, SKIP LOCKED work queue with reclaimed leases, sweeper, tenant isolation, worker SIGTERM from `worker.starting` |
| Not covered | two real API **processes**, SIGTERM/SIGKILL of one replica during requests, HTTP drain behaviour |

### New certification: `apps/reference-dapp/backend/api-failover.pg.test.ts`

Two real `main.ts api` processes (`NODE_ENV=production`, bearer token, `DATABASE_POOL_MAX=4`) on one database, plus the real worker.

| # | Scenario | Result with the fix (5/5 runs) | Unmodified `main` |
| --- | --- | --- | --- |
| 1 | simulate/review/begin/handoff/report alternating between replicas; one simulate sent to **both** replicas at once with the same idempotency key; `begin` raced on both | one run; the other replica answers `409 IDEMPOTENCY_IN_PROGRESS`, then the identical replay; one PREPARED attempt (`TRANSFER_EXISTING_ATTEMPT_OBSERVE_ONLY` for the loser); journal `PREPARED → SUBMITTING → PENDING`; one transaction | pass |
| 2 | SIGTERM on replica A with three owner requests in flight | all three answer 200 with `Connection: close`; the next request on A's pooled connections is refused (`ECONNREFUSED`) and succeeds on B with the same key; A exits 0 about 7.3 s after SIGTERM (when its in-flight work ended); B served 65–66 reads with 0 failures during the drain; four runs created, all readable on B, every claim `COMPLETED`, no lease left held | **fails**: answers `keep-alive`, the new request is **served by the draining replica**, A exits only at **25 014 ms** (forced) |
| 3 | replica restarted, then SIGKILL in the middle of `begin` | claim left `IN_PROGRESS` for 120 s and the run lease for 30 s (measured); no attempt, no transaction; the BFF's retry on B gets `IDEMPOTENCY_IN_PROGRESS` while other runs are served; after both windows (fast-forwarded in the database) B takes over the same key: one PREPARED attempt, replay on repeat, lease fence 2 → 3 | pass |
| 4 | every API replica stopped; worker started; fresh replica | the worker reconciles the owner-signed attempt (`CONFIRMED`, `RECONCILED`); the fresh replica reports it; one transaction | pass |
| — | pool | peak 4 connections for both replicas together (bound 2 × 4 = 8) | — |

`packages/cloud-runtime/test/http-drain.test.ts` (unit stage) pins the HTTP contract: after `close()` an in-flight answer and an
in-flight readiness probe close their connection (readiness 503), a new connection is refused, and the server closes without waiting
for the client's kept-alive sockets. It fails on the unmodified `http.ts` (`keep-alive`).

## In-process state audit (API path)

The import closure of `backend/app.ts`, `automation-api.ts` and `delegation-api.ts` (515 modules) was searched for module- and
factory-level state and every hit read. No state on the hosted API path is correctness-relevant across replicas: every mutating flow
method runs under the PostgreSQL fenced lease, every log write re-checks it and compare-and-sets the log version; owner nonces,
transaction hashes, Solana messages/signatures and payout orders are create-once rows; passkey challenges, Telegram link codes and rate
limits, approval handoffs and beta access live in PostgreSQL. Per-process state is pacing (RPC queues), memoization and TTL read caches
(catalog loaders 30–300 s) whose staleness can only refuse or reproduce the reviewed bytes, because Review bindings are durable and
`begin` re-reads under the lease. Configuration-only caveats: a memory/local delegated signer keeps keys in one process (refused on
any hosted deployment; production's API has KMS variables configured — names read, values not) and a filesystem evidence store serves
evidence only on the replica holding the file (production has the object-store variables configured).

Pre-existing, unchanged by replicas: a mutation that outlives its 120 s idempotency claim can lose its stored replay response if a retry
takes the claim over; the run lease and durable state checks still prevent a second mutation.

## PostgreSQL pool impact

`DATABASE_POOL_MAX` is unset in production (10 per process). Steady state with two API replicas: 2 × 10 + worker 10 = 30 client
connections (one more replica adds at most 10). During a deployment the old replicas overlap the new ones for `overlapSeconds` (15 s):
4 × 10 + 10 + the pre-deploy `migrate` (1) = 51 at most. The Vercel functions keep their own pools, independent of the API replica count.
Production's compute autoscales 0.25–8 CU (Neon `max_connections` 112 at 0.25 CU, 105 usable). Through the pooled host (`-pooler`,
PgBouncer transaction mode, up to 10 000 client connections) this is far from any limit; on a direct host at the minimum size the
deployment peak plus Vercel could approach it. `DATABASE_URL`'s value was not read; `docs/deploy/CLOUD.md` already requires the pooled
string.

## Railway parameters (recommended)

| Setting | flofi-api | Why |
| --- | --- | --- |
| Replicas | 2, same region (`us-east4`) | the certified topology; one region keeps database latency unchanged |
| `drainingSeconds` | 30 (unchanged) | above the API's 25 s cap |
| `overlapSeconds` | 15 (unchanged) | new replicas pass `/readyz` before the old ones get SIGTERM |
| `healthcheckPath` | `/readyz` (unchanged) | checks the database |
| `DATABASE_POOL_MAX` | unset (10) or explicit 10 | 51 peak connections during deploys, see above |
| `flofi-worker` | unchanged (1 replica, `drainingSeconds` 130 > its 120 s cap) | the worker is already replica-safe |

Drift to note (no action taken): `deploy/railway/api.railway.json` has no draining/overlap settings and
`deploy/railway/worker.railway.json` says `drainingSeconds: 90` while the live worker uses 130.

## Rollout and rollback

1. Merge this PR and deploy with **one** replica. On that deploy the old replica should log `api.stopping` and no `api.stop_timeout`.
2. Scale `flofi-api` to 2. Watch: HTTP 5xx, `api.stop_timeout`, `IDEMPOTENCY_IN_PROGRESS` and `*_BUSY` refusals, Neon connections,
   RPC 429s (each replica paces its own RPC reads, so the aggregate read rate doubles).
3. Rollback: set replicas back to 1. No schema, data or protocol depends on the replica count. Reverting the code is independent and
   safe in either order (the change only alters drain behaviour).

## Not proven here

The hosted Railway edge proxy's own behaviour (whether it pools upstream connections, and whether it retries a refused connection on
another replica) could not be observed without touching production. The fix makes the API correct either way; when the edge does not
retry, the BFF's bounded flow and preview retries (same idempotency key) do. The BFF's run/journal/list reads (`readCloudRun`,
`listCloudRuns`) are not retried, so a read the edge cannot place at that instant may answer `CLOUD_API_UNAVAILABLE` once; this is
unchanged from one replica's deployments. Public execution, mainnet and the hosted environment were not exercised.
CircleCI remains the certification authority.
