# BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 — checkpoint (handoff)

## 0. Current state (session 2, 2026-11-07) — READ THIS FIRST

Implemented, committed and pushed on `claude/friendly-lamport-r1z0ac` (see `git log 3bdfe07..HEAD`):
- **Release A** certificate (base 0022 → 0023) as its own first commit; **migration 0023** (`USER_FUNDED` mode, `workflow_run_groups`,
  DB-checked fee payer = run wallet) + PostgreSQL suite; SCHEMA-COMPATIBILITY §17.
- **S1 gate**: executor transport has no send method; executor refuses every step before simulation (`EXECUTOR_GAS_PAYER_REFUSED`);
  `prepareSubmission` refuses session-paid bytes; nonce fillers removed; `operations.ts` refuses new executor-paid authority
  (`EXECUTOR_FUNDED_GAS_RETIRED`). Executor/adversarial/compatibility/delegated-run suites rewritten as refusal proofs (explained in commits).
- **User-funded engine**: `workflow-runs/execution-groups.ts` (planner + honest counts), `user-funded/{evm-calls,evm-reconcile,groups,runtime}.ts`,
  runner `user-funded-pass.ts`, store/service/approve-surface ops (start/prepare/authorize/report), RunView groups, plan `userFunded`
  section, browser `components/user-funded-browser.ts` (EIP-5792, user-op typed data, Solana sign-all) + run panel + PT copy.
- **Cross-chain hardening**: bridge deliveries count only when RECONCILED and delivered to the run's own wallet; refunded bridge → FAILED.
- **Chat ↔ Canvas**: `editor/workflow-strategy.ts canvasWorkflowOfStrategy` (one Canvas workflow, same canonical hash); approval preview uses it.
- Matrices regenerated (delegated row retired, user-funded row added, EVM↔Solana bridge row corrected); coverage.json mapped (agent_guard check PASS).
- Docs: `docs/adr/ADR-0008-user-funded-execution.md`, `docs/deploy/USER-FUNDED-EXECUTION.md` (runbook incl. KMS disposition and rollback),
  `docs/builds/BUILD-FLOFI-UNIVERSAL-WORKFLOW-002-CAPABILITY-MATRIX.md`; PR #166 activation runbook marked superseded.

Production facts verified READ-ONLY (Neon `Flofi` project `wandering-mode-28938220`, default branch): schema at 0022; zero credential
grants / delegated authorizations / executions / delegation work items ever; 2 automation rules both `CONFIRM_EACH_TIME` + `PAUSED`; 1 run
`CONFIRM_EACH_STEP/HALTED`; constraint names `workflow_runs_mode_check` and `workflow_runs_check3` present. Delegation was configured on
Railway (owner report) but never used.

Not done / honest limits: no mainnet transaction; Solana durable-nonce groups not offered (builders need balances to simulate);
bridges are not batched (own flow); Privy cannot batch (owner-step); no percentage/remaining vocabulary; PG16 locally (CI uses PG18:
one 0015 forward-compat case expects PG18 named NOT NULL constraints).

Environment for a fresh session: Node 24.21.0 is NOT preinstalled — download from nodejs.org (sha-verified) to `/opt/node24dl`, then
`corepack enable pnpm`; `pg_ctlcluster 16 main start`; role `flofi` / `TEST_DATABASE_URL=postgres://flofi:flofi-local-test@127.0.0.1:5432/postgres`;
run vitest from the REPO ROOT (root `vitest.config.ts` sets `FLOFI_NETWORK_SCOPE`); app typecheck needs `NODE_OPTIONS=--max-old-space-size=6144`.

---

## Session 1 checkpoint (historical)

**Status: WORK IN PROGRESS. Nothing here is production-ready, nothing was deployed, no migration exists yet, no mainnet transaction was sent.**
This checkpoint lets a fresh session continue without the original conversation. Read this file, then the three maps in `maps/`.

- Branch: `claude/friendly-lamport-r1z0ac` (remote `origin` = `alrimarleskovar/FloFi`; the build brief names `FloFi-xyz/FloFi`, same tree).
- Base: `3bdfe07` = merge of PR #166 (`BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001`), the production baseline named in the brief.
- Brief: three mandatory objectives — (A) every user pays their own gas (retire the shared AWS-KMS executor as gas-paying sender; no paymaster,
  no reimbursement, no pooled treasury), (B) universal Chat/Canvas workflows with Solana first-class and cross-chain dependent amounts
  reconciled from real settlement, (C) the fewest safe wallet interactions, honestly counted. Deliverables: ADR, capability matrix, tests,
  runbook, `docs/builds/BUILD-FLOFI-UNIVERSAL-WORKFLOW-002-REPORT.md`, one PR against `main` (never merged by the agent).

## 1. Resume the environment (exact commands)

```bash
export PATH=/opt/node24/bin:$PATH            # Node 24.22.1 (project pins 24.21.0; pnpm warns, works; CI uses 24.21.0)
cd /home/user/FloFi
pnpm install --frozen-lockfile --ignore-scripts
pg_ctlcluster 16 main start                   # local PostgreSQL 16 for *.pg.test.ts (CI uses 18.6)
pnpm --filter @defi-workflow-engine/reference-compiler build   # the app resolves packages from dist/: rebuild after editing packages/*
```

Focused checks used so far (all passing at this checkpoint):

```bash
(cd packages/reference-compiler && pnpm exec vitest run test/erc4337.test.ts test/solana-nonce.test.ts)
(cd apps/reference-dapp && pnpm exec vitest run src/user-funded)
pnpm exec eslint packages/reference-compiler/src/erc4337.ts packages/reference-compiler/src/eip5792.ts packages/reference-compiler/src/solana-nonce.ts apps/reference-dapp/src/user-funded
pnpm typecheck                                # passed (16 tasks, 1m11s) with the new modules
```

Full gates before delivery: `pnpm check` (typecheck, lint, build, schema drift, unit tests), `pnpm test:postgres`, `python3 scripts/governance_lite.py`,
`python3 scripts/agent_guard.py check` / `impact --base origin/main` / `review --base origin/main`, browser profiles via `node scripts/guarded-release-browser.mjs critical`.

Network from the sandbox: `raw.githubusercontent.com` is reachable (contract sources were fetched from it); docs sites and public RPCs are
blocked by the proxy (403). No on-chain fact can be verified from here; `scripts/workflow-grant-mainnet-probe.mjs` shows the pattern for an
owner-run read-only probe.

## 2. Verified external facts (read from source, not docs)

MetaMask Delegation Framework (`MetaMask/delegation-framework` main, contracts v1.3.0):
- `EIP7702DeleGatorCore.validateUserOp` ignores the EntryPoint's `userOpHash` and verifies the signature over
  `getPackedUserOperationTypedDataHash(op)` = EIP-712 `0x1901 ‖ domainSeparator ‖ structHash` with domain
  `{ name: "EIP7702StatelessDeleGator", version: "1", chainId, verifyingContract: <the owner's own EOA> }` and type
  `PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,address entryPoint)`.
  `_isValidSignature` = ECDSA recovery to `address(this)`. **Consequence: a MetaMask smart-account owner can sign a user operation of their own
  account with `eth_signTypedData_v4`, the EntryPoint takes the gas from the owner's account (`_payPrefund`), and a bundler merely transmits it.**
- `execute(bytes32 mode, bytes executionCalldata)` is `onlyEntryPointOrSelf` (batch mode 0x01 = atomic; ERC-7579 `abi.encode(Execution[])`).
- EntryPoint is v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (`.env.example`, deploy script). Deterministic addresses in `documents/Deployments.md`
  (DelegationManager `0xdb9B1e94…`, `EIP7702StatelessDeleGatorImpl` `0x63c0c19a…`).
- `documents/Deployments.md` now lists **Robinhood Chain** (and its testnet) among the mainnet deployments. PR #166 recorded the opposite
  (`FRAMEWORK_NOT_DEPLOYED` for `eip155:4663` in `apps/reference-dapp/src/delegation/capabilities.ts`). Must be verified on chain
  (`eth_getCode` of the CREATE2 addresses on 4663) before enabling; bundler availability on 4663 is unknown.

Solana (`@solana-program/system` 0.16.0 and `@solana/transaction-messages` 8.5.0, installed): durable nonce = `AdvanceNonceAccount` (discriminator 4)
must be the first instruction and the nonce value replaces the recent blockhash; `InitializeNonceAccount` 6, `CreateAccount` 0 (80-byte account),
`WithdrawNonceAccount` 5. Wallet Standard `solana:signTransaction` takes several inputs in one call (one wallet prompt for N transactions).

## 3. Verified repository facts (see `maps/*.json` for file:line detail)

- **Gas payer today.** Every delegated EVM submission is an EIP-1559 transaction `from` the shared KMS session address to the DelegationManager
  (`apps/reference-dapp/src/delegation/drivers.ts` `signEvmCalls`), nonces allocated per (chain, session) under an advisory lock
  (`delegation/pg-store.ts prepareSubmission`), stale nonces filled with executor-paid self-transactions (`fillStaleNonces`). The runbook
  `docs/deploy/SINGLE-AUTH-MAINNET-ACTIVATION.md` §3 asks the owner to fund the executor. Activation (§2–§6) was never done: delegated execution
  is NOT live in production (report §9: no mainnet transaction). Owner-signed "confirm each step" flows are user-paid already.
- **Workflow runs** (`apps/reference-dapp/src/workflow-runs/*`, migration `0015`): one run per SEQUENTIAL approval handoff; modes
  `CONFIRM_EACH_STEP` (browser signs/submits each step through its own flow; the server observes the flow's record) and `DELEGATED` (ERC-7710
  workflow grants redeemed by the executor). DB CHECKs pin `mode IN ('CONFIRM_EACH_STEP','DELEGATED')`, step states, `step_count 2..8`; triggers
  freeze strategy/hash/bound. No execution groups, no gas-payer field, no estimated/guaranteed/actual triad. The worker cannot ready confirm-mode
  steps (no requester policy on the worker: `runner.ts policyFor`).
- **Authorization plan** (`workflow-runs/authorization-plan.ts`): reasons `WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED` (any Solana step),
  `WORKFLOW_BINDING_NOT_EXACT` (cross-chain / non swap-borrow producers), `DELEGATION_FRAMEWORK_NOT_DEPLOYED` (4663), etc. Counts are coarse.
- **Bindings**: `{step, amountFrom}` on one exact asset identity, resolved as min(cap, reconciled received) (`engine/workflow-bindings.ts`,
  `runner.ts`); no percentage / remaining / exact-vs-minimum vocabulary. Canvas and Chat do NOT share one canonical multi-step workflow: Chat v2 is
  N isolated one-node IRs + a sequence hash; the Canvas holds one SemanticWorkflow with `dependencies` edges (see `maps/workflow-ir-engine.json`).
- **Wallets**: MetaMask path signs EIP-712 via `components/delegation-browser.ts signWorkflowGrant` (switches chain first). FloFi Wallet (Privy) EVM
  provider (`wallet/flofi-evm-provider.ts`) supports only `eth_sendTransaction` (type-2, bound to a reviewed run, FloFi broadcasts the signed raw tx),
  `personal_sign` (UTF-8 only), `wallet_switchEthereumChain`; it refuses typed data, `eth_signTransaction` for later use, `wallet_sendCalls`,
  7702. The wallet-app protocol (`wallet-app/protocol.ts`) has ops `evm_sign_transaction`, `evm_sign_message`, `solana_sign_transaction` (exactly one
  transaction per request, bound to a PREPARED attempt), `solana_sign_message`. Whether the installed Privy SDK (3.51.0) can sign typed data /
  7702 authorizations / several Solana transactions was NOT yet verified (reader `privy-sdk-capabilities` did not complete).
- **Solana compiler** (`packages/reference-compiler/src/solana.ts`): own `compileMessageV0(payer, instructions, blockhash, tables)`, parse/serialize,
  no `@solana/kit` usage; Jupiter/Orca/transfer flows sign one owner transaction per run with a recent blockhash
  (`packages/reference-executor/src/jupiter.ts`). Nothing about `signAllTransactions` or durable nonces existed before this checkpoint.
- **Strategy contract** (`engine/strategy-spec.ts`): v2 step lists (1–8 steps) with optional bindings; bridge steps already accept `solana` as source or
  destination and routing `auto|best|relay|lifi|mayan|across`; the universal router registers Solana mainnet rows. Delegation capability refuses bridges.
- **Schema compatibility** (`docs/deploy/SCHEMA-COMPATIBILITY.md`, `packages/cloud-runtime/src/migrations.ts CERTIFIED_FORWARD_MIGRATIONS`): expand-only
  migrations, bytes frozen as `packages/cloud-runtime/test/fixtures/NNNN_name.sql`, a certificate whose base is the newest shipped migration (0022
  `editor_requester`), an assessment section, `forward-compatibility.pg.test.ts` catalog diff, Release A (certificate) before Release B (migration).
  0022 widened CHECK constraints on tables the previous build writes — precedent for widening `workflow_runs.mode`.
- Specialist reviewers: `.claude/agents/flofi-*.md` (Read-only); ownership in `docs/engineering/coverage.json`; run `python3 scripts/agent_guard.py impact --base origin/main`.

## 4. Design direction decided so far (not yet implemented beyond primitives)

1. **Retire executor-sent ERC-7710 redemption for user workflows** (it is the FloFi-funded-gas path). Add a fail-closed gas-payer invariant
   (`apps/reference-dapp/src/user-funded/gas-payer.ts`, written) and call it below the driver layer (`delegation/executor.ts` before
   `store.prepareSubmission`; also remove `eth_sendRawTransaction` from the `executor` transport purpose in `delegation/chains.ts`). The
   `delegableByCode` plan then reports the old "authorize once" as retired (`EXECUTOR_FUNDED_GAS_RETIRED`). Existing pg suites that exercise
   executor-paid execution (`delegation/executor.pg.test.ts`, `adversarial.pg.test.ts`, `credentials.pg.test.ts`, `workflow-runs/delegated-run.pg.test.ts`)
   must be rewritten to expect the refusal — an intentional, explained safety change for owner review. KMS key: keep, do not delete; worker stops needing
   `kms:Sign`; document the retained role (legacy grant verification uses only `GetPublicKey`).
   **Open:** automations (DCA, `src/automations`, `delegation/credentials`) also execute through the KMS executor; the automations reader did not
   complete. Decide: owner-signed proposals per occurrence (user pays) vs. no delegated automations until a user-funded session model exists.
2. **Execution groups + per-group authorization strategy** (new run mode `USER_FUNDED`, additive migration 0023: widen `workflow_runs.mode` CHECK
   and its authorization_id co-constraint; new table `workflow_run_groups` {run_id, group_index, chain, namespace, wallet, step_from, step_to, strategy,
   state, authorization/artifact jsonb, submission facts}; grouped steps reuse step state `DELEGATED` → `RECONCILED`). A group = consecutive steps on one
   chain/wallet whose amounts are fixed at signing (exact or the producer's guaranteed minimum). A group boundary = chain change or a dependency on a
   cross-chain delivery. Strategies:
   - `EVM_WALLET_BATCH` — EIP-5792 `wallet_sendCalls` (atomic required, no capabilities/paymaster), browser submits, server re-reads receipts
     (`packages/reference-compiler/src/eip5792.ts`, written). MetaMask reports `atomic` `supported|ready` per chain; `ready` = MetaMask upgrades the account
     in the same confirmation (the required one-time setup, inside the flow).
   - `EVM_USER_OPERATION` — user-signed ERC-4337 v0.7 operation of the owner's own 7702 account, no paymaster, gas prefund from the owner's balance,
     bundler submits (`packages/reference-compiler/src/erc4337.ts` + `apps/reference-dapp/src/user-funded/bundler.ts`, written). Needs per-chain
     `FLOFI_BUNDLER_RPC_<id>` (`user-funded/config.ts`, written). Used for delayed EVM groups (after a bridge) collected upfront; nonce key per group
     (`nonceKeyOf`), so the owner's other transactions never invalidate it; gas words signed = maximum charge; a fee spike beyond `maxFeePerGas`
     leaves it unmined → fail closed, ask again (never resign silently).
   - `EVM_OWNER_STEP` — existing confirm-each-step (already user-paid), the fallback and the Robinhood Chain answer until 4663 is verified.
   - `SOLANA_SIGN_ALL` — one `solana:signTransaction(...N)` prompt for a same-cluster group; server submits sequentially (recent blockhash, so submit
     promptly; an expired later transaction fails closed and asks again).
   - `SOLANA_DURABLE_NONCE` — owner-controlled nonce accounts (one per pending pre-signed transaction; one-time setup transaction the owner pays,
     rent refundable) for Solana groups that must wait for a bridge (`packages/reference-compiler/src/solana-nonce.ts`, written). Revocation = the owner
     advances the nonce. Requires each Solana flow's transaction builder to accept a nonce lifetime (Jupiter: `/swap-instructions` instead of the
     prebuilt `/swap` transaction) — not done.
   - `SOLANA_OWNER_STEP` — existing.
   Squads/Swig/SPL delegate were rejected for single authorization (custody change / unrestricted recipient). Kernel-style session keys (KMS as a
   scoped session signer whose UserOps the user's account pays) are the documented future for Privy wallets and automations, not this build.
3. **Dependent amounts**: keep index bindings, add an optional portion (`{ share?: bps | exact | 'remaining' }`) so hashes of existing workflows do not
   change; type `estimated / guaranteed / actual` per step (quote expected, signed minimum, reconciled received); destination groups wait for reconciled
   delivery (≥ the pre-signed amount, else fail closed). Routes must come from the real providers (Across exact `outputAmount`, Relay/LI.FI/Mayan `toAmountMin`).
4. **Honest interaction count** per wallet/network/strategy (typed-data signatures, wallet batches, Solana sign-all prompts, one-time upgrades,
   nonce-account setup, chain switches), shown in the review (EN/PT) and in MCP/channel copy; S10: never claim one signature when more are needed.

## 5. Files changed at this checkpoint (all WIP, all tests passing)

| File | Purpose | Tests |
|---|---|---|
| `packages/reference-compiler/src/erc4337.ts` | ERC-4337 v0.7 `PackedUserOperation` packing, EntryPoint `userOpHash`, MetaMask 7702 delegator EIP-712 digest/typed data, owner-signature recovery, 2-D nonces, `UserOperationEvent` parsing, bundler wire format (no factory, no paymaster) | `test/erc4337.test.ts` 11 passing |
| `packages/reference-compiler/src/eip5792.ts` | EIP-5792 `wallet_sendCalls` request (atomic required, no capabilities), capability/status parsing | same file |
| `packages/reference-compiler/src/solana-nonce.ts` | Durable-nonce System instructions, nonce account decode, nonce-lifetime message compile/detect | `test/solana-nonce.test.ts` 4 passing; `apps/reference-dapp/src/user-funded/solana-nonce-codec.test.ts` 4 passing (byte-equal with installed codecs) |
| `packages/reference-compiler/src/index.ts` | exports `erc4337`, `eip5792`, `solanaNonce` namespaces | — |
| `apps/reference-dapp/src/user-funded/config.ts` | `FLOFI_USER_FUNDED_EXECUTION`, `FLOFI_USER_FUNDED_CHAINS`, `FLOFI_BUNDLER_RPC_<id>`, `FLOFI_USER_FUNDED_RPC_<id>` (fallback `FLOFI_DELEGATION_RPC_<id>`), `FLOFI_SOLANA_NONCE_ACCOUNTS`; fail closed | `bundler.test.ts` 6 passing |
| `apps/reference-dapp/src/user-funded/bundler.ts` | bundler JSON-RPC allowlist client, EntryPoint/chain verification, hash match, AAxx code mapping | same |
| `apps/reference-dapp/src/user-funded/gas-payer.ts` | invariant S1: fee payer must be the run's owner wallet, no sponsorship, no FloFi-controlled address | same |
| `docs/builds/BUILD-FLOFI-UNIVERSAL-WORKFLOW-002-WIP/maps/*.json` | reader maps (delegation/executor/KMS, workflow runs, workflow IR/engine) | — |

Nothing in the product uses the new modules yet (no run-model, UI, migration, MCP or Canvas change). `eslint` and `pnpm typecheck` pass.

## 6. Current problems and open questions

- Understanding readers not completed (stopped at handoff): solana-stack (in flight), bridges-crosschain, wallets-signing, privy-sdk-capabilities,
  chat-mcp-channels, canvas-editor, reconciler-observe, infra-ci-config-migrations, approve-ui-review, compiler-evm-encoding, automations-credentials,
  capability-registry-developer-api, and the completeness critic. Their prompts are in the original workflow script
  (`/root/.claude/projects/-home-user-FloFi/9aa17c30-0ffd-500d-a692-84ef93e1a13e/workflows/scripts/flofi-002-understand-wf_511fe592-4a7.js` — sandbox-local,
  may be gone; the reader list and questions are reproduced in §8).
- Privy capabilities unknown (typed data, 7702 `signAuthorization`, `eth_signTransaction`, Solana sign-all) — decides what FloFi Wallet can get.
- Which EVM↔Solana bridge routes are executable with a guaranteed minimum today (universal router: Relay/LI.FI/Mayan; Across SVM) — not verified.
- Robinhood Chain: framework listed as deployed; bundler availability unknown; MetaMask `atomic` capability on 4663 unknown.
- Automations under S1 (see §4.1).
- Sandbox has 4 CPUs: the Workflow tool runs at most 2 agents at once; plan long understanding phases accordingly or read inline.

## 7. Pending tasks (from the session task list)

1. Understand baseline — partial (3 of 15 maps). 2. ADR-0008 — not started. 3. Execution groups + strategies (contracts, plan, state) — not started.
4. User-funded EVM execution — primitives done; wiring, gas-payer gate in the executor, EIP-5792 browser path, worker submission not started.
5. Solana first-class (sign-all groups, durable-nonce delayed steps, reconciliation, Chat/Canvas authoring) — primitives only.
6. Cross-chain dependent execution (delivery-gated groups, estimated/guaranteed/actual, portions) — not started.
7. Chat/Canvas parity — not started. 8. Security/recovery/gas-isolation tests, migration 0023 + certificate, capability registry honesty — not started.
9. Docs (ADR, matrix, runbook, report), specialist reviews, CI gates, commit series by concern, PR — not started.

## 8. Next actions for a fresh session (in order)

1. Finish understanding with inline reads (or a 2-agent workflow): `apps/reference-dapp/src/accounts/privy-*.ts`, `wallet-app/*`, Privy SDK d.ts under
   `node_modules/.pnpm/@privy-io+react-auth@3.51.0*/` (grep `signTypedData`, `sign7702Authorization`, `signAuthorization`, `eth_signTransaction`,
   `signAllTransactions`); `packages/reference-executor/src/{across,bridge,cross-chain-liquidity}.ts`, `packages/workflow-contracts/src/universal-router*.ts`,
   `apps/reference-dapp/src/domain/universal-bridge-authoring.ts`, `src/server/universal-router/*`; `src/automations/*`, `delegation/credentials.pg.test.ts`;
   `src/mcp/tools.ts`, `src/editor/workflow-strategy.ts`, `state/workflow-store.tsx`, `domain/workflow-sequence.ts`; `src/workflow-runs/received-amounts.ts`,
   `packages/reference-reconciler/src`; `.circleci/config.yml`, `packages/cloud-runtime/test/fixtures`, `forward-compatibility.pg.test.ts`,
   `backend/schema-compatibility.pg.test.ts`.
2. Write `docs/adr/ADR-0008-user-funded-execution.md` from §2–§4 (table per wallet×chain: gas payer, sender, signer, mechanism, interactions, validity/revocation,
   dynamic amounts, on-chain enforcement, dependencies).
3. Gas-payer gate: wire `assertUserFundedSubmission` into `delegation/executor.ts` (before `prepareSubmission`) and `delegation/drivers.ts`; drop
   `eth_sendRawTransaction` from the executor purpose in `delegation/chains.ts`; make `authorization-plan.ts` report the 7710 mode as retired; update the
   affected pg tests to assert the refusal; adjust `delegation/boundaries.test.ts`.
4. Migration `0023_user_funded_groups` (expand-only) + fixture bytes + certificate (base 0022) + SCHEMA-COMPATIBILITY §17 + forward-compat test; new
   `workflow_run_groups` store; `RUN_MODES` + `USER_FUNDED`; `execution-groups.ts` (pure grouping/strategy planner) + extended `AuthorizationPlan`
   (groups, strategies, honest counts, fee per network, fee-paying wallet).
5. EVM paths: browser `wallet_getCapabilities`/`wallet_sendCalls`/`wallet_getCallsStatus` beside `components/delegation-browser.ts`; typed-data signing of
   `delegatorUserOpTypedData` (reuse `signWorkflowGrant`'s chain switch); server operations (review groups → sign → report batch id); worker work kind
   `workflow-run.group-submit` using `user-funded/bundler.ts`; receipt reconciliation per step from one receipt (sequential Transfer-leg matcher); gas paid
   fact from `UserOperationEvent.actualGasCost` / receipt `gasUsed × effectiveGasPrice`.
6. Solana paths: `signAllWithSolanaWallet` in `wallet/solana-wallet.ts` (multi-input `solana:signTransaction`); FloFi Wallet protocol op for several
   transactions; nonce-account onboarding flow; nonce-lifetime option in the Solana flow builders; group submission + reconciliation.
7. Bindings portions + estimated/guaranteed/actual; delivery-gated destination groups; Chat authoring of Solana/cross-chain sequences and the
   Canvas round trip; EN/PT copy; MCP `get_capabilities` honesty; capability/certification matrices regenerated.
8. Tests per the brief §8 (gas isolation, authorization adversarial cases, composition, integration), `pnpm check`, pg suites, browser profiles,
   governance, `agent_guard.py` specialist reviews; docs (matrix, runbook incl. KMS disposition, report); commits by concern; push; PR against `main`.

Reader prompts not completed (reproduce as needed): solana-stack (how Solana txs are built/signed/sent/reconciled; what sign-all and durable nonces need);
bridges-crosschain (providers, EVM↔Solana routes, delivery reconciliation, refunds/partial fills); wallets-signing (methods per wallet, what must change);
privy-sdk-capabilities (installed SDK evidence); chat-mcp-channels (authoring, approval handoff, post-execution continuation, parity gaps); canvas-editor
(node types, bindings, saved workflows, parity); reconciler-observe (receipt → per-step evidence, bridge arrival, one receipt with several steps, UserOp
receipts); infra-ci-config-migrations (migration 0023 requirements, env flags, CI jobs, browser profiles); approve-ui-review (what the review shows,
gaps vs §5 of the brief); compiler-evm-encoding (reusable primitives — largely answered: `erc7710.ts` ABI codec, EIP-712, RLP, `signedEip1559`,
`workflowCallData`, `account-code.ts`); automations-credentials (what breaks under S1); capability-registry-developer-api (pinned literals, how to add modes).
