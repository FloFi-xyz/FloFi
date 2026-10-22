# BUILD-CHAT-E2E-001 — Report

Branch `codex/build-chat-e2e-001` from `origin/main` `7a844d2`. The branch is **not pushed** and has **no PR**. Nothing was deployed,
migrated in production, configured or activated, and no transaction was signed or sent.

See the [plan](BUILD-CHAT-E2E-001-PLAN.md) for the audit and the design decisions, and [WORKFLOW-RUNS.md](../deploy/WORKFLOW-RUNS.md) for the
operator guide.

## 1. Summary (PR-ready)

A multi-step workflow composed in a conversation (ChatGPT or Claude over MCP, Telegram, or any Channel Core provider) is now **one** approval.
Its owner opens `/approve`, proves every wallet the workflow needs, and a durable **workflow run** executes the steps in order, each only after
the previous step reconciled. The Canvas is optional. This replaces the old `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED` refusal for every sequence
whose steps all have an owner-execution flow.

There are two authorization modes. The owner chooses one before anything executes, and FloFi never switches between them silently:

| Mode | Owner authorizations | Available |
| --- | --- | --- |
| `CONFIRM_EACH_STEP` | One wallet confirmation per step at least (a flow may ask for more, e.g. a token approval), each after its own fresh simulation and Review | Every sequence whose steps all have an enabled owner-execution flow |
| `DELEGATED_SINGLE_AUTHORIZATION` | **One passkey assertion for the whole workflow** (the BUILD-AUTOMATION-002 Universal Workflow Authorization, as a one-shot manifest), after a one-time Credential enrollment per chain | Only where every step is delegable, the owner's grants cover every step under one passkey, and the deployment has a signer provider |

The authorization plan states how many authorizations each mode needs **before** anything executes. It is returned by
`request_user_approval`, shown on `/approve` and sent to channels.

What changed:

- **Engine.** `SEQUENTIAL` plan kind; typed step bindings `{step, amountFrom}` (a step spends what an earlier step actually delivered,
  `min(cap, received)`, never an estimate). The sequence hash covers bindings, and workflows without bindings keep their hashes byte for byte.
- **Durable runs.** Migration `0015_workflow_runs`, a forward-only state machine enforced by triggers, compare-and-set transitions, the
  `workflow-run.advance` work kind and the sweep. A step with an uncertain outcome makes the run `ATTENTION` and is never resubmitted.
  Partial completion is `HALTED`: reconciled steps stay done, and the owner may retry a step that submitted nothing, or end the run.
- **Delegated runs.** The BUILD-AUTOMATION-002 executor gains a workflow-run source with the same authority chain and per-step pipeline.
  The one-shot manifest is bounded by the workflow itself (caps = its spend, slippage = its own, one execution, at most 24 h).
- **`/approve`.** A run panel (EN/PT): mode choice, the delegated limits shown before the passkey, continue, retry/end, and status polls.
  A poll observes the run as the worker does, so a reconciled step shows at once, but it never readies or loads a step. Each next step
  gets its own fresh simulation automatically. An EVM + Solana workflow proves both wallets before its claim.
- **MCP.** `compose_strategy`, `review_strategy` and `get_capabilities` report sequences, and `request_user_approval` returns the
  authorization plan. `get_approval_status` reports the run: every step's state always, and hashes, amounts and evidence only while the owner
  shares status.
- **Telegram / Channel Core.** `ADD STEP`, `STEPS`, `REMOVE STEP n`, `MOVE STEP n TO m` (EN/PT), one workflow approval, "step N is ready"
  notifications with a continuation link (consent-gated), and `STATUS`. `LINK` never restarts a running workflow.
- **Developer API.** Shares the engine plan. New refusal codes map to `CAPABILITY_NOT_SUPPORTED`, and the OpenAPI documents `bindings`.
- **Off by default.** `FLOFI_WORKFLOW_RUNS=enabled` turns runs on. While it is off, a sequence is refused with `WORKFLOW_RUNS_NOT_ENABLED` and
  nothing else changes.

## 2. Evidence levels

Everything in this build is **MOCKED**:

- unit tests;
- PostgreSQL integration tests on a disposable loopback database (`flofi-chat-e2e-pg`, removed at the end);
- delegated runs on the BUILD-AUTOMATION-002 loopback chain doubles;
- owner-signed step runs from an isolated flow-runtime test double (`workflow-runs/workflow-run.test-harness.ts`).

The browser journeys (§7) are also MOCKED: the real application against the loopback MCP harness, the synthetic loopback swap RPC and
scripted wallet confirmations.

Nothing here is a fork run, a testnet run or a mainnet run. No live ChatGPT, Claude or Telegram client was used. Product code paths use only
the existing flows' own simulation, Review, signing, reconciliation and evidence: no mocked balance, quote or confirmation is reachable
outside tests.

## 3. Lifecycle by stage

| Stage | MCP (ChatGPT / Claude) | Telegram / Channel Core | `/approve` (owner) |
| --- | --- | --- | --- |
| BUILD | `compose_strategy` with `{version: 2, steps, bindings?}` | `ADD STEP …`, `STEPS`, `REMOVE STEP`, `MOVE STEP` (EN/PT), up to 8 steps | — |
| VALIDATE | `validate_strategy` / `review_strategy` per step; a blocker in any step refuses the whole workflow | Same engine, at `PROPOSE` | Re-verified at the claim |
| SIMULATE | `simulate_strategy` stays one step at a time (`SIMULATE_ONE_STEP_AT_A_TIME`) | — | Each step gets its own fresh, real simulation right before its signature. In delegated mode the executor simulates each step before broadcast |
| REVIEW | The authorization plan, per step and per mode | The authorization counts in the proposal message | Run panel; the delegated limits before the passkey; the step's Strategy Review in the signing surface |
| AUTHORIZE | Never: authority `NONE` | Never | Wallet confirmation per step, or one passkey assertion |
| EXECUTE | — | — | The step's own flow (owner wallet), or the delegated executor |
| RECONCILE | — | — | The flow's reconciliation, observed read-only by the runner (the worker, or the owner's status poll); or the executor's reconciliation |
| MONITOR | `get_approval_status` → `workflowRun` | `STATUS` and step notifications | Status polls |

A whole-sequence simulation before approval is **not** offered. A later step's inputs depend on what earlier steps actually delivered, and
often on another chain, so simulating it in advance would mean simulating against an estimate. Each step is therefore simulated when it is
about to run.

## 4. Single-authorization assessment

**What "one authorization" means here.** It is one passkey assertion over a Universal Workflow Authorization envelope. The envelope covers a
one-shot manifest whose limits the owner sees first:

- the networks;
- per-asset caps equal to the workflow's own spend;
- the workflow's own slippage;
- one execution;
- at most 24 hours of validity.

It needs a Credential per chain × mechanism, enrolled once (one wallet signature each) and reusable across workflows. One authorization is
**not** one transaction and not zero gas: every step still submits its own transactions and pays its own fees.

**Where it works today, by code.** Only workflows whose every step is a Uniswap v3 USDC↔WETH swap on Base Sepolia or Ethereum Sepolia
(ERC-7710, MetaMask Delegation Framework v1.3.0). Everything else is refused with an exact code; see the matrix in §5:

- bridges: LI.FI calldata is opaque, and the Across template is not compiled;
- Aave, liquidity and transfers: no delegation template;
- Solana: production builder not implemented, MOCKED harness only, and native SOL is not delegable at all;
- every mainnet.

**Where it works today, by deployment.** Nowhere hosted. Hosted deployments refuse in-memory and disposable signers, and no KMS/HSM signer
provider exists, so `/approve` reports `DELEGATED_SIGNER_UNAVAILABLE` and offers confirm-each-step.

**Fallback.** `CONFIRM_EACH_STEP` is the production path once `FLOFI_WORKFLOW_RUNS` is enabled. The owner is told the count up front: "at
least N wallet confirmations". Modes are never mixed inside one run, so a partly delegable workflow runs entirely in confirm mode.

**Not pursued, and why.**

- A single wallet signature over a batch (EIP-5792 / EIP-7702) is atomic within one chain. It cannot wait for a bridge to arrive or span
  chains, so it does not fit sequences that depend on reconciled outputs.
- Session keys held by FloFi are a custody change, which this build must not introduce.
- Wallet-granted permissions (ERC-7715) are not part of the pinned stack.

Each of these would be a new reviewed design, not an extension of this build.

**Verdict.** Universal single-workflow authorization is implemented end to end in code and exercised at MOCKED level (one passkey assertion,
no wallet request during execution, bound-amount narrowing, revocation). Using it in production is blocked by two things: the signer
provider, and template coverage.

## 5. Capability and network matrix

These rows are generated from code: the capability catalog, `strategyFlow`, and `stepCapability(…, 'PRODUCTION')`. Deployment enablement is
per deployment and is not shown here; `get_capabilities` reports it live.

How to read it:

- **Confirm mode** means the step may appear in a confirm-each-step sequence when its flow is enabled where the run executes and the
  requester's policy allows its network.
- **Delegated** shows the production capability, or the exact refusal code.
- **Evidence** is the registry's demonstrated evidence for that single path. No sequence evidence is claimed.

| Action | Network | Funds | Adapter | Owner flow (confirm mode) | Delegated (production) | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| swap | base-sepolia | test | uniswap.v3 | `base-sepolia-swap` | ✅ `EVM_ERC7710_METAMASK_V1_3` | TESTNET_EXECUTED |
| swap | ethereum-sepolia | test | uniswap.v3 | `base-sepolia-swap` | ✅ `EVM_ERC7710_METAMASK_V1_3` | none |
| swap | solana-devnet | test | orca.whirlpools-devnet | `solana-devnet-swap` | `SOLANA_DELEGATED_BUILDER_NOT_IMPLEMENTED` (MOCKED harness only) | none |
| bridge | base-sepolia → arbitrum-sepolia | test | flofi.router | `crosschain-router-testnet` | `DELEGATED_TARGET_SCOPE_UNAVAILABLE` | none |
| supply / borrow / repay / withdraw | base-sepolia, ethereum-sepolia | test | aave-v3 | `aave-supply` | `DELEGATION_TEMPLATE_NOT_IMPLEMENTED` | none |
| add_liquidity | base-sepolia, ethereum-sepolia | test | uniswap.v3 | `uniswap-liquidity` | `DELEGATION_TEMPLATE_NOT_IMPLEMENTED` | none |
| add_liquidity | solana-devnet | test | orca.whirlpools-devnet-liquidity | `orca-liquidity` | `OWNER_SIGNER_REQUIRED` | none |
| transfer | solana-devnet | test | solana.system-transfer | `solana-devnet-transfer` | `DELEGATION_STEP_ASSET_INVALID` | none |
| transfer | ethereum-sepolia | test | evm.native-transfer | `robinhood-transfer` | `DELEGATION_STEP_ASSET_INVALID` | none |
| transfer | robinhood-testnet | test | evm.native-transfer | `robinhood-transfer` | `DELEGATION_STEP_ASSET_INVALID` | TESTNET_EXECUTED |
| lending composition (supply → borrow → swap) | base-sepolia | test | aave-v3 + uniswap.v3 | `lending-composition` (one composite flow, not a run) | `DELEGATION_TEMPLATE_NOT_IMPLEMENTED` | MOCKED |
| swap | base, arbitrum-one, ethereum, robinhood | real | uniswap.v3 | `base-swap`, `arbitrum-swap`, `ethereum-swap`, `robinhood-swap` | `MAINNET_DELEGATION_DISABLED` (robinhood: `DELEGATION_TEMPLATE_NOT_IMPLEMENTED`) | none |
| swap | solana | real | jupiter.swap-v2 | `jupiter-swap` | `MAINNET_DELEGATION_DISABLED` | none |
| supply / borrow / repay / withdraw | base, arbitrum-one, ethereum | real | aave-v3 | `base-aave`, `arbitrum-aave`, `ethereum-aave` | `MAINNET_DELEGATION_DISABLED` | none |
| add_liquidity | base, arbitrum-one, ethereum, robinhood, solana | real | uniswap.v3 / orca mainnet | per-network liquidity flows | `MAINNET_DELEGATION_DISABLED` (robinhood: `DELEGATION_TEMPLATE_NOT_IMPLEMENTED`) | none |
| transfer | base, arbitrum-one, ethereum, robinhood, solana | real | evm.token-transfer / solana.spl-transfer | per-network transfer flows | `MAINNET_DELEGATION_DISABLED` (robinhood: `DELEGATION_TEMPLATE_NOT_IMPLEMENTED`) | none |
| bridge | 11 mainnet routes among base, arbitrum-one, ethereum and robinhood | real | flofi.router | `crosschain-router*` | `DELEGATED_TARGET_SCOPE_UNAVAILABLE` | none |
| bridge | EVM → Solana | — | — | — | `BRIDGE_ROUTE_UNAVAILABLE` | — |

Sequence-level rules:

- **Mixed namespaces.** An EVM + Solana sequence is supported in confirm mode, and both wallets are proven before the claim.
- **Bound amounts.** In confirm mode they are refused (`DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED`): owner-signed flows expose no canonical
  "received" amount. In delegated mode they resolve from the executor's reconciled `received`.
- **Policy.** Requester policy applies to every network of every step, exactly as for single steps. Mainnet steps remain subject to it.
- **Composite flow.** A sequence equal to the lending composition (with no bindings) stays one composite flow, as before.

## 6. Fee (0.1% per complete workflow)

Main has no fee mechanism or fee ledger to preserve. Inventing a chargeable basis would be a new financial decision, so this build charges
**no fee**.

What it guarantees for a future fee is one terminal `COMPLETED` fact per workflow run, keyed by run id. It is recorded once, never per step and
never twice, and it is enforced by the run state machine's triggers.

Owner decisions are needed before any fee exists:

- the chargeable basis: input notional, in which asset, and at which price source;
- whether a `HALTED` (partial) or cancelled workflow is charged;
- the collection mechanism. An on-chain fee transfer would itself be one more authorization or step, which changes the counts in §4.

## 7. Test evidence

All runs used `TMPDIR=~/.cache/flofi-chat-e2e-tmp` and, for PostgreSQL suites,
`TEST_DATABASE_URL=postgres://flofi@127.0.0.1:29436/postgres?options=-c%20synchronous_commit%3Doff`. That is a disposable loopback container
with CI's commit setting; without it, local fsync pushes one developer test past its 5 s timeout.

Final code head: `a8ac7bd`. Every gate below ran on that head, or on a tree whose application code is identical to it.

| Gate | Command | Result |
| --- | --- | --- |
| CI check | `pnpm check` (typecheck, lint, build, schema drift, unit) | **Pass.** Typecheck 16/16 tasks; lint clean; build 9/9; 11 schema exports verified; unit 406 files, **4,779 passed**, 2 skipped (pre-existing `skipIf` in `server/mode-b-service` and `server/composition-service`), 0 failed |
| PostgreSQL | `pnpm test:postgres` (75 files, 2 workers) | **Pass.** 74 files, **468 passed**, 3 skipped, 0 failed. The 3 skipped tests are the backend schema-compatibility certificate block, which runs only when this build's head migration is a certificate base, i.e. on Release A; see the next row |
| Release A tree | `origin/main` + `d69b4bd` only, exported to a scratch directory (no git worktree or branch): `forward-compatibility*.test.ts` and `backend/schema-compatibility.pg.test.ts` | **Pass, 32/32.** Includes the 3 backend tests that skip on Release B by design: the v14 API and worker keep serving through 0015, and cold starts work on the certified schema. `d69b4bd` applies cleanly onto `7a844d2` |
| Browser (loopback) | `node scripts/guarded-release-browser.mjs profile <name>` with CI's environment: `approve-workflow-run` (new), `approve-authorize-journeys`, `solana-transfer-ux`, `channel-signing`, `channel-approve`, `mcp-in-chat`, `mcp-routes-oauth-disabled`, `developer-journey`, `automations` | **Pass, 54/54 tests in 9 profiles.** These are every profile that drives `/approve`. `default-product` (it only links to the route) and the other product profiles were not run locally |
| Governance | `python3 scripts/governance_lite.py`; `unittest` of `test_governance_lite.py` and `test_ci_*.py`; `git diff --check` | **Pass.** Governance-lite clean; 19 and 54 unit tests OK; no whitespace errors |

Not run:

- the full guarded browser plan (46 profiles), the fork suite and Cloud Build;
- any CI system, because the branch is not pushed.

The Cloud Build source manifest (`cloudbuild-source-manifest.json`) was not regenerated. It is refreshed only for an owner-triggered direct
upload.

### 7.1 Defects found and fixed during final verification

| Defect | Found by | Fix (commit) |
| --- | --- | --- |
| A run's one-shot manifest capped slippage at `max(100, step slippages)`. A 50 bps workflow was shown "Max slippage 1%" before the passkey, and the policy's minimum-output floor accepted up to 1% | Review of the manifest against the plan | The cap is the workflow's own slippage, exactly as the drivers apply it (`7c4a668`) |
| A confirm-mode run stalled after step 1 wherever the worker did not run workflow runs, because only the worker recorded a reconciled owner step. With a worker, the owner waited about 20 s | Review while planning the browser journey | The owner's status poll runs the worker's observe-only pass. It never readies or loads a step (`b631c23`, with a PostgreSQL test that fails on the old poll) |
| After *Continue to step 2*, the signing surface kept step 1's simulation under a misleading "Wallet changed" status and asked the owner to simulate again. Nothing was authorizable | The new browser journey | Automatic preparation now ignores only a final run of another workflow, as `executionStart` already did (`700d0fc`) |

### 7.2 Intentional changes to existing tests (for review)

- `mcp/step-list.test.ts`, `mcp/handoff/handoff.pg.test.ts`, `engine/robinhood-composition.test.ts`, `platform/workflow-visual.test.ts` and
  `developer/engine.pg.test.ts` asserted `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED` or a "not executable" visual. Sequences whose steps all have
  flows are now `SEQUENTIAL`; they are refused with `WORKFLOW_RUNS_NOT_ENABLED` only where `FLOFI_WORKFLOW_RUNS` is off.
- `docs/developer/openapi.json` was regenerated: the optional v2 `bindings` array and the reworded step-order description.
- `platform/boundary.test.ts` now allows `src/workflow-runs/` as an engine service and `src/delegation/views.ts` as type-only.
- Four channel tests and one delegation test gained type-only non-null assertions, because `ClaimedProposal.workflow` became nullable.
- `workflow-runs/delegated-run.pg.test.ts` (this build's own test) now expects `maxSlippageBps: 50` for 50 bps steps instead of 100.
- `scripts/test_ci_gcp_orchestration.py` pins 46 browser profiles instead of 45, and the drop/repeat mutation in
  `scripts/test_ci_optimization.py` targets the shard's new last line. Both follow from the new `approve-workflow-run` profile, which adds
  about 85 s to CircleCI browser shard 2 and to the single-worker Cloud Build run.
- No test was deleted or skipped.

## 8. Deviations from the plan

| Plan | Built | Why |
| --- | --- | --- |
| Per-step `inputFrom: {step}` | Workflow-level `bindings: [{step, amountFrom}]` | Steps stay byte-identical v1 objects, so their per-step hashes and the v1 schemas are unchanged |
| Owner-signed bound amounts where a flow's evidence states the received amount | Refused in confirm mode | No owner flow exposes a canonical reconciled "received" amount yet. Estimating one is forbidden |
| A new MCP tool `get_workflow_run_status` | `get_approval_status` → `workflowRun` | One approval, one status. No new tool or scope for clients to learn |
| Budget entries generalized in 0015 | Unchanged | Budget entries key on the authorization, which already carries the run |

## 9. Blocked or not implemented

1. **Production delegated signing.** No KMS/HSM signer provider exists. Hosted deployments offer confirm-each-step only and say why.
2. **Delegated coverage.** See §4 and §5.
3. **Confirm-mode bound amounts.** `DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED`.
4. **Developer API run progress.** Its approval status does not report per-step run progress yet; MCP and channels do.
5. **Fee.** See §6.
6. **Browser coverage of other run paths.** The new journey covers confirm mode on one EVM network. There is no browser test yet for:
   - a mixed EVM + Solana run (dual wallet proof);
   - `HALTED` with retry or end;
   - `ATTENTION`;
   - delegated mode, which has no browser-reachable signer on any loopback deployment.

   These paths are covered at PostgreSQL level only.
7. **0015 on large delegated tables.** The duration was measured on empty tables only (20–25 ms). A 20k-row seeding script failed on
   duplicate rule ids and was not completed; `SCHEMA-COMPATIBILITY.md` §9 says so.

## 10. Outstanding real-world acceptance checklist

Each step needs explicit owner action. None of it was done in this build.

1. Decide the release split, then merge Release A (`d69b4bd`: the 0015 certificate only) and deploy it. The production build must report the
   certificate while still serving v14.
2. Merge Release B and apply 0015 through the documented process. Do not enable `FLOFI_WORKFLOW_RUNS` yet.
3. On a Preview with its **own** non-production database (never the production `DATABASE_URL`), set `FLOFI_WORKFLOW_RUNS=enabled` on web and
   worker.
4. **Confirm mode, testnet, MCP.** From a live ChatGPT or Claude session: compose a two-step workflow (e.g. a Base Sepolia → Arbitrum Sepolia
   bridge, then a swap) and request approval. Check that the authorization counts are shown. On `/approve`, sign step 1 with a real wallet,
   wait for reconciliation, continue, sign step 2, and reach `COMPLETED`. `get_approval_status` should show each step; toggling sharing should
   hide and show hashes.
5. **Mixed namespaces.** A workflow with an EVM step and a Solana Devnet step: prove MetaMask and Phantom, then run both steps.
6. **Telegram, EN and PT.** Work through these:
   - `ADD STEP` / `STEPS` / `REMOVE STEP` / `MOVE STEP`, then `PROPOSE`;
   - the approval link and the "step N is ready" notification (with sharing on and off);
   - `STATUS`;
   - `LINK` during a running workflow.
7. **Failure paths on testnet:**
   - reject step 2 in the wallet → `HALTED`, then *Try this step again* and *End workflow*;
   - a slow step → `RUNNING` / `ATTENTION` observation without resubmission;
   - a worker restart mid-run.
8. **Delegated mode.** Needs a deployment with a reviewed signer provider first:
   - enroll Base Sepolia Credentials;
   - run a bound two-swap workflow with one passkey assertion, and confirm there is no wallet prompt during execution;
   - revoke mid-run;
   - check the budget and the single execution.
9. The first CI run of the new `approve-workflow-run` profile, once the branch is pushed. It passed locally only.
10. The fee decisions in §6.

## 11. Owner decisions

- The release split for 0015: Release A is commit `d69b4bd` alone; Release B is the rest.
- Enabling `FLOFI_WORKFLOW_RUNS` (default off).
- The KMS/HSM provider for delegated signing.
- The fee basis, the partial-completion rule and the collection mechanism.

## 12. Commits

On `7a844d2`, in order (`d69b4bd` alone is Release A):

- `ba1bd41` durable sequential workflow runs and one workflow-level delegated authorization
- `7b43336` tests for bindings, the authorization plan and the 0015 state machines
- `224fbf5` /approve runs a multi-step workflow without the Canvas
- `42321ad` multi-step workflows in Telegram and every Channel Core provider
- `8551a30` MCP journey for multi-step workflows; public run view passes the output guard
- `d69b4bd` forward-compatibility certificate for 0015 (Release A material)
- `63d759d` interim report (implemented, tested, blocked, pending)
- `3ae932c` /approve proves both wallets of an EVM + Solana workflow before claiming it
- `e8b288b` docs for multi-step execution; Developer API maps the new refusal codes
- `3d61589` Developer API plans a general sequence SEQUENTIAL; OpenAPI documents bindings
- `7c4a668` a run's one-shot manifest caps slippage at the workflow's own, not a 100 bps floor
- `b631c23` the owner's status poll observes the run, so Continue never waits on the worker
- `700d0fc` the signing surface prepares the next step's fresh simulation after the previous step's run
- `a8ac7bd` browser journey for a two-step workflow run on /approve, as CI profile approve-workflow-run
- the commit that adds this final report and its links.
