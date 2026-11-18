# BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002

System-wide execution settlement reliability (P0) and autonomous FinOps synchronization (P1). Branch
`feat/finops-automated-sync-002` from `main` `401ce8e1` (PR #217). Production runs schema 29 (PR #215). Nothing in this build was merged,
deployed, migrated on a hosted database or executed with real funds. Every chain and provider fact below was read read-only.

## 1. Takeover

The Codex agent stopped at its usage limit with 41 uncommitted files and no commit, push or PR. Claude preserved that work unchanged as
`b6e64a61` ("inherited Codex implementation (takeover snapshot)") and built on it in later commits, so the two authors' diffs stay
separable (`git diff 401ce8e1 b6e64a61` and `git diff b6e64a61 HEAD`).

**Inherited from Codex (kept):**

- P0: Parity `trace_transaction` validation of native deliveries (`nativeMovements`), the direct solver EOA path without traces, order
  binding for Relay contract fills, refund/delivery claim exclusivity under one lease, source/destination re-checks on every observation,
  RECOVERY_REQUIRED after the attention window, Base-only `relaySettlement`, owner-step execution claims (`settleOwnerStep`), UNCERTAIN for
  completions without readable evidence, bridge settlement transactions in step outcomes, dashboard polling of pending rows, and the
  "awaiting independent verification" labels.
- P1: migration 0030 and its certificate, worker loop (`startFinancialSync`), sync store (leases, checkpoints, periods, backfill),
  Neon/Railway/Vercel/OpenAI/Anthropic/CircleCI/Alchemy adapters, the Integrations panel with Sync now / Sync all, the stricter completed
  workflow cohort, execution economics and investor CSV rows.

**Found incomplete or defective at takeover:**

| Finding | Effect | Resolution |
| --- | --- | --- |
| Relay settlement authority only on Base, single executor | Equivalent native fills on Ethereum, Arbitrum and Robinhood (or another Base solver) stay `UNIVERSAL_DELIVERY_ORDER_NOT_BOUND` | All four EVM destinations, Relay's published solver sets |
| Only Parity traces | Arbitrum Nitro / Orbit and many providers serve only `debug_traceTransaction` | callTracer validator and per-method failover |
| Mainnet swaps and liquidity reconciled at canonical inclusion (0 confirmations) | A reorged swap could stay RECONCILED and fund the next step | Transfer-profile depth (2 L2 / 3 Ethereum) |
| No historical reconciliation tooling | Runs whose reconcile task already stopped (DEAD, attention) are never re-observed by the new code | `reconcile-history` |
| No regression matrix | — | Generated from the capability registry |
| Anthropic filter `product === 'api'` | No such value exists: nearly all API cost silently dropped | `products[]` filter + documented values |
| OpenAI images read `num_images` | Image usage dropped | `images`, `num_model_requests` |
| Stale `cloud-runtime` dist (older 0030 digest) | `finops-sync-migrate` refused (`FINOPS_MIGRATION_DIGEST_MISMATCH`) in the PostgreSQL suite | Rebuilt; source and certificate already agreed |
| 7 new sources unmapped, no AI/CircleCI tests, untranslated panel and raw codes | `agent_guard check` failed; PT copy test failed | Mapped, suites added and required, labels + PT catalog |

## 2. Verified incident findings (P0)

The owner's brief identifies the execution and both transactions; this repository deliberately does not repeat those identifiers (the
incident wallet is a user's). Read once from public endpoints (Base and Arbitrum public RPC, dRPC for traces, Relay's public request API).
The replay fixture `apps/reference-dapp/src/server/testdata/universal/relay-native-fill-base-2026-11-18.json` keeps the observed structure
(selector, calldata layout, solver sender, router, frames, gas, value) with every identifier substituted.

- Source (Arbitrum): `RelayDepository.depositNative(depositor, id)` of 0.0005 ETH, where `id` is FloFi's committed order id.
- Destination (Base): a Relay solver (in Relay's published Base solver set) called **RelayRouter v3.2** (`0x0729…97f7`, selector
  `0xcd6e13f7`) with the same order id as the trailing calldata word. The router forwarded **487,592,054,186,956 wei** to the recipient by
  an internal call (router self-call, then router → recipient; Parity and callTracer traces agree).
- The recipient is an **EIP-7702 delegated EOA** (MetaMask delegator), so a balance delta cannot prove net credit.
- Relay's request status was `success` with those in/out transactions. Relay's request id is not the order id; binding uses the deposit id.
- Root cause: the verifier accepted a native delivery only as `tx.to === recipient` + `tx.value`; a contract-mediated fill could never
  match, so the run stayed `SOURCE_CONFIRMED` with `UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE`. This was fail-closed (no false
  settlement), but it blocked the workflow.
- Public `mainnet.base.org` refuses `trace_transaction` (-32611) and publicnode requires a token: production needs a trace-capable
  configured read path (Alchemy or a fallback URL) on each destination, or such deliveries stay pending.
- RelayRouter v3.2 bytecode sha256 `05acc78f…a71d` is identical on Ethereum, Base, Arbitrum and Robinhood.

## 3. P0 changes by Claude

- `evm-chain.ts`: `callTracerMovements` (root frame must be this transaction; reverted subtrees ignored; CALL/CREATE/SELFDESTRUCT must
  state their value; DELEGATECALL/CALLCODE/STATICCALL no net movement), `tracedMovements` (Parity first; the callTracer only when no Parity
  trace is served; a Parity trace that contradicts the receipt fails closed). The credit is always the recipient's net movement inside the
  canonical transaction; the provider status is never proof. `service.ts`: a trace-derived native credit is derived again when its block
  becomes final (changed → divergent; temporarily unverifiable → keeps waiting).
- `bridge-read-rpc.ts` / `runtime.ts`: `debug_traceTransaction` allowed; each trace method keeps its own preferred provider, and a node
  that declines a trace never moves ordinary reads off the primary.
- `action-registry/universal-router.ts`: `RELAY_ROUTER_V3_2` and `RELAY_SETTLEMENT_EXECUTORS` (Relay GET /chains `solverAddresses`,
  2026-11-18) for chains 1, 8453, 42161, 4663. Executors authorize only the order binding.
- `public-testnet-service.ts`, `uniswap-liquidity-service.ts`: PUBLIC_MAINNET swaps (owner-sent and 0x Gasless) and liquidity record
  nothing until the receipt is at the network's transfer `minimumConfirmations`; the receipt is re-verified on every observation until
  then. A catalog run without MOCKED provenance always uses the mainnet depth.
- `backend/finops-worker.ts`: the billing loop installs plain-Node source resolution itself (before, it loaded only when another worker
  subsystem happened to install it) and logs its enabled/ineligible state. Parameter properties removed from three modules the worker and
  admin CLI now load (plain-Node type stripping refuses them).
- `admin/support/historical-reconciliation.ts` + `admin-cli reconcile-history` (§6).
- Tests: closed incident replay (14 cases), callTracer mutation cases, callTracer-only reconciliation on Base/Ethereum/Robinhood with a
  rotated solver, swap and liquidity depth gates, lifecycle propagation (Canvas operation, history), historical reconciliation on
  PostgreSQL, and the generated matrix.

## 4. System-wide regression coverage

[`docs/engineering/SETTLEMENT-REGRESSION-MATRIX.md`](../engineering/SETTLEMENT-REGRESSION-MATRIX.md) is generated by
`apps/reference-dapp/src/platform/settlement-regression-matrix.test.ts` from `executionCapabilityRegistry` (every MAINNET row that
executes or reconciles; executing without reconciling fails: 15 action/adapter pairs over Ethereum, Base, Arbitrum, Robinhood and Solana). A new adapter or network without a declared
proof, finality rule and existing suite fails the test; the published table must equal the generated one.

Cross-flow audit outcome: no other mainnet path accepted `tx.to`/`tx.value` or a provider status as delivery proof. Remaining fail-closed
limits, not changed here: the 0x gasless native check and Aave's exact balance equality are block-level (a concurrent transaction in the
same block yields a false mismatch, never a false success); `flofi.router` profiles are ERC-20 only, so a future WETH→native route would
need the same trace verification.

## 5. Financial provider integration matrix (P1)

| Provider | Authoritative API (verified 2026-11-18) | Minimum credential | FloFi attribution (verified) | Recorded as |
| --- | --- | --- | --- | --- |
| Neon | Consumption Metrics v2 `/consumption_history/v2/{projects,branches}` | Organization API key; Launch+ plan (org is Launch) | Org `org-odd-block-82235574`; projects Flofi (production) and three preview/rehearsal projects. RoundFi (same org) excluded and refused if returned | Metered usage + list-price estimate meters (no ledger cost) |
| Railway | Public GraphQL `usage(projectId, …, groupBy)` | Account/workspace token (Bearer) | Project `e0ea4b67…`, production env, `flofi-api` and `flofi-worker` | Metered usage + list-price estimate meters |
| Vercel | Billing Charges `GET /v1/billing/charges` (FOCUS v1.3 JSONL) | Billing-capable team token | Team `team_absG3F…`, project `flofi` (`prj_2fqd…`, flofi.xyz); unattributed team charges excluded | Daily `PROVIDER_COST` (BilledCost); allocation estimates as meters |
| OpenAI | Costs + Usage (completions, embeddings, images, code interpreter, vector stores) | Admin key | Configured `proj_…`; any other project refused | Daily `PROVIDER_COST` + usage meters |
| Anthropic | Usage and Cost Analytics API (beta header `analytics-usage-cost-2026-08-24`) | Admin key or `read:analytics` | Configured workspace; `messages_api`, `message_batches_api`, `managed_agents_api` only; days after `data_refreshed_at` excluded | Daily `PROVIDER_COST` (after discounts, before credits) + usage meters |
| CircleCI | Usage Export (async job, signed S3 CSV) | Personal token of an org admin | Project `bdb424bd…` (FloFi-xyz/FloFi, verified); org UUID `2b3602e4…` not independently verified | Credit and job meters only (no invoiced amount) |
| Alchemy | Admin `POST /v1/usage/time-series` | Access key with `ADMIN_USAGE_READ`; paid plan for filters | Configured app ids | Compute-unit meters only |
| Resend, 0x, LI.FI, Relay, Jupiter, sponsorship, domains | No authoritative per-account cost API verified | — | — | Manual invoice records (unchanged) |

Quality is explicit per period (FULL / PARTIAL / UNAVAILABLE) with labelled limitations. Cost qualities distinguish VERIFIED (invoice or
accounting), PROVIDER_REPORTED (provider billing API, new), METERED, ESTIMATED, PARTIAL and UNAVAILABLE. Estimates and meters are never added
to cost totals (USD meters in the investor CSV are marked not additive); an invoice or accounting record supersedes overlapping
provider-reported costs of the same scope in any environment; margins and the month-over-month change (same number of days) are unavailable
unless coverage is complete. The CircleCI signed download must be an AWS S3 host with a signature; CircleCI does not publish its export
bucket, so the host is not pinned further (a forged export could only affect CircleCI credit meters). Synchronization: daily by default (6–168 h), independent per provider, Sync now / Sync all (operator, 5-minute admission),
initial backfill of the current and two closed months, re-review of the previous month right after it closes and weekly, fenced 90-second leases, durable
checkpoints for async exports, five bounded retries with backoff, restart recovery, idempotent ledger writes under one advisory lock. The
loop runs on the existing Railway worker with its own one-connection pool; no Redis, LiteLLM or new service.

Required environment variables: [ENVIRONMENT.md §5p](../deploy/ENVIRONMENT.md#5p-finops-automatic-synchronization-build-flofi-finops-automated-sync-002-admin--finops--financial-integrations).

## 6. Historical reconciliation procedure

Affected runs still ask for observation. A run whose `reconcile` task is still queued is re-observed automatically by the new worker
release; one whose task stopped (DEAD, `attention_required`) is not, and needs the operator.

1. Deploy this release to the API and worker (the verifier runs in the worker). Confirm a trace-capable read path per destination (§2).
2. Dry run (writes nothing): `node apps/reference-dapp/backend/admin-cli.ts reconcile-history --tenant default` (defaults:
   `--flow crosschain-universal`, the incident-class settlement codes, `--limit 100`). Review each candidate's disposition:
   ELIGIBLE, ALREADY_OBSERVING (no action needed) or REFUSED with its closed code.
3. Apply with an approval reference: `… reconcile-history --tenant default --apply --approval-ref <ticket> --reason "<text>"` (the reason
   is an operational note: no wallet, name or other personal data). Each run goes through the audited `execution.resume-observation`
   recovery (state token, idempotency key derived from the approval reference, refusals audited). One apply queues at most 20 runs so
   interactive Support & Recovery keeps headroom in the tenant's 30-per-10-minutes budget; rerun to continue. Repeats are idempotent.
4. Verify in Admin → Support & Recovery and on the run: RECONCILED with an evidence bundle, or still pending with its code. Workflow runs
   in ATTENTION advance automatically once their step's execution reconciles (the workflow sweep re-arms them).

It never prepares, signs, submits, replays or replaces a transaction and moves no funds.

## 7. Database compatibility and rollback

0030 (`finops_sync`, sha256 `63b3c6ca…508b`) is certified ahead of shipped schema 28 together with 0029; the normal deploy migration
still ships 28. See [SCHEMA-COMPATIBILITY.md §22](../deploy/SCHEMA-COMPATIBILITY.md#22-certificate-0030_finops_sync): two empty
tenant-scoped tables, no change to existing objects, 5-second lock timeout. Before 0030 is applied, the PR #215 release remains a rollback
target. After it is applied, roll back only to a release carrying this certificate, with `FLOFI_FINOPS_SYNC` off; leave the tables and the
ledger in place. Builds before this certificate refuse schema 30.

## 8. Production activation runbook (infrastructure operator)

1. Merge only after owner review and green CircleCI; deploy the same revision to Vercel, the Railway API and the worker.
2. Settlement: confirm trace support on each EVM destination path; run §6.
3. FinOps: rehearse `finops-sync-migrate` on a disposable Neon branch first (never a Preview database shared with other branches). For production, confirm every
   consumer runs this revision, then with the direct `DATABASE_MIGRATION_URL`: `node apps/reference-dapp/backend/admin-cli.ts
   finops-sync-migrate --tenant default` (a rerun applies nothing).
4. Create dedicated least-privilege billing credentials (§5) in the worker's server-side environment only, then set
   `FLOFI_FINOPS_BILLING_TENANT=default` and `FLOFI_FINOPS_SYNC=enabled` on the worker.
5. In Admin → FinOps → Financial integrations, check each provider's connection, coverage and limitations after the first cycle, and
   reconcile one month against an independently obtained invoice before using totals in an investor report.
6. To stop collection: unset `FLOFI_FINOPS_SYNC` on the worker. Recorded data stays.

## 9. Validation and reviews

Specialist reviews (read-only): flofi-bridge, flofi-workflow, flofi-security, flofi-admin-analytics, flofi-data-privacy and
flofi-infrastructure-ci. Their medium and high findings were fixed in this build: callTracer fallback on contradicting traces, gasless
depth, invoice precedence across environments, provider-reported quality, plain-Node loading of the billing loop, and identifiers in the
fixture. Results are listed in the PR description with CircleCI links. Local runs used a disposable loopback PostgreSQL 18 and MOCKED chains or
closed replays only: they do not prove public execution, provider entitlements or invoice accuracy.

## 10. Remaining operational blockers

- Billing credentials do not exist yet; every provider is "Not configured" until the operator creates them.
- A trace-capable RPC path per destination network is required for contract-mediated native deliveries (otherwise they stay pending).
- Schema 30 activation is an operator action.
- The incident run reconciles only after deployment (and §6 if its task stopped); no mainnet confirmation in this build.
- Anthropic's analytics API is beta; CircleCI's export state values and Railway's units were not exercised against live accounts.
- A workflow step whose execution was already claimed by another run's identical step (`WORKFLOW_STEP_EXECUTION_ALREADY_CLAIMED`) stays in
  ATTENTION until an operator resolves it; there is no automatic exit yet.
- Known fail-closed limits outside this build: the 0x Gasless native check and Aave's exact balance equality are block-level.
