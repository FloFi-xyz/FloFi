# BUILD-CHAT-E2E-001 — Report (interim: the session's usage limit was reached)

Branch `codex/build-chat-e2e-001` from `origin/main` `7a844d2`. The branch is not pushed and has no PR. Nothing was deployed, migrated in
production, configured or activated, and no transaction was signed or sent.

See the [plan](BUILD-CHAT-E2E-001-PLAN.md) for the audit and the design decisions.

## Evidence levels

Everything below is **MOCKED**: unit tests, and PostgreSQL integration tests on a disposable loopback database with the BUILD-AUTOMATION-002
loopback chain doubles. Owner-signed step runs come from an isolated flow-runtime test double.

Nothing here is a fork run, a testnet run or a mainnet run. No live ChatGPT, Claude or Telegram client was used.

## Implemented and tested

| Area | State | Tests |
| --- | --- | --- |
| Typed step bindings `{step, amountFrom}`: exact token identity, the sequence hash covers them, unchanged hashes without them, `min(cap, received)` | Implemented | `engine/workflow-bindings.test.ts` |
| `SEQUENTIAL` plan, per-mode gates, `FLOFI_WORKFLOW_RUNS` deployment switch (default off) | Implemented | `mcp/step-list.test.ts`, `workflow-runs/authorization-plan.test.ts` |
| Authorization plan: wallet confirmations (at least one per step) vs one passkey assertion, with exact refusal codes | Implemented | as above |
| Migration 0015: run/step/event tables, forward-only triggers, delegated-table generalization | Implemented | `workflow-runs/migration.pg.test.ts`: SQL equals the TypeScript state machine for every pair |
| Durable runner: ordering, re-gating per step, observation of reconciled flow evidence, ATTENTION without retry, HALTED partial completion, resume/end, idempotent under concurrency | Implemented | `workflow-runs/confirm-run.pg.test.ts` (7 tests) |
| Universal workflow authorization for runs: one-shot manifest, one passkey assertion, no wallet signature during execution, bound-amount narrowing, revocation | Implemented | `workflow-runs/delegated-run.pg.test.ts` (4 tests) |
| `/approve` without the Canvas: run panel, mode choice, continue, end/retry, step signer per namespace, read-only status polls (EN/PT) | Implemented | `components/workflow-run-panel.test.tsx` (render only; **no browser run**) |
| MCP: `compose`/`review`/`capabilities`, `request_user_approval` with the authorization plan, `get_approval_status` with the run (consent-gated) | Implemented | `mcp/handoff/workflow.pg.test.ts` |
| Telegram/Channel Core: ADD STEP / STEPS / REMOVE / MOVE (EN/PT), one workflow approval, step notifications with a continuation link, LINK never restarts a running workflow | Implemented | `channels/core/workflow.test.ts`, `channels/telegram/workflow.pg.test.ts` |
| DB-COMPAT certificate for 0015 (Release A material), assessment §9 | Implemented | `forward-compatibility*.test.ts` (31 tests) |

Existing suites run in this session all passed after the intentional updates listed below:

- delegation, platform, MCP, channels and automations unit tests;
- their PostgreSQL suites.

The full `pnpm check` gate was **not** run. CI was **not** run. No browser (Playwright) test was run.

### Intentional changes to existing tests (for review)

- `step-list.test.ts`, `handoff.pg.test.ts`, `robinhood-composition.test.ts` and `workflow-visual.test.ts` asserted
  `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED` or a "not executable" visual. Sequences whose steps all have flows are now `SEQUENTIAL`; they are
  refused only where `FLOFI_WORKFLOW_RUNS` is off.
- `platform/boundary.test.ts` now allows `src/workflow-runs/` as an engine service.
- Four channel tests and one delegation test gained type-only non-null assertions.

## Blocked or not implemented

1. **Production delegated signing.** No KMS/HSM signer provider exists. Hosted deployments therefore offer confirm-each-step only and say why.
2. **Delegated coverage.** Delegation covers only Uniswap v3 USDC↔WETH swaps on Base Sepolia and Ethereum Sepolia; Solana is a MOCKED harness
   only. Bridges, Aave, liquidity and mainnets are refused with exact codes.
3. **Confirm-mode bound amounts.** Owner-signed flows do not expose a canonical "received" amount, so these are refused with
   `DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED`.
4. **0.1% fee.** No fee collection or ledger exists on main. Runs record one completion fact per workflow, for a future fee to key on. The
   chargeable basis and the partial-failure rule are **owner decisions**.
5. **Still to do:**
   - a Playwright journey on `/approve`;
   - the backend `schema-compatibility.pg.test.ts` on a Release A tree;
   - the 0015 duration with large delegated tables;
   - `pnpm check` and governance-lite;
   - docs updates (`STATUS.md`, `deploy/MCP.md`, developer docs, the in-app docs text naming `MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED`);
   - the capability matrix document.
6. **Real-world acceptance.** Still pending for real wallets on public testnets: a confirm-mode run, and a delegated run on a deployment with
   custody. A live ChatGPT/Claude/Telegram session is also still pending.

## Owner decisions

- The release split for 0015: Release A is commit `d69b4bd` alone; Release B is the rest.
- Enabling `FLOFI_WORKFLOW_RUNS`.
- KMS provider choice.
- The fee basis.
