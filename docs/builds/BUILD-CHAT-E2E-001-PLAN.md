# BUILD-CHAT-E2E-001 — Plan: conversational DeFi execution and universal workflow authorization

Branch `codex/build-chat-e2e-001`, worktree `/home/asus/projects/flofi-chat-e2e-001`, from `origin/main`
`7a844d24252d5f3c53a2e9b3dda0b226bd02ecdb` (PR #112). `origin/main` was re-fetched on 2026-10-22 and had not advanced, so no
integration was needed. No other worktree or branch was modified.

This plan records the Phase A audit, the architecture decisions and the scope. The [report](BUILD-CHAT-E2E-001-REPORT.md)
records what was built, what was tested, and what is still blocked. Where the build differs from this plan (the shape of step
bindings, owner-signed bound amounts, the MCP status tool, budget entries), the report's §8 lists each deviation and why.

## 1. Phase A audit

### 1.1 Branches and worktrees inspected (read-only)

| Source | State | Relevance |
| --- | --- | --- |
| `codex/build-automation-003-delegated-execution` (`~/projects/flofi-delegated`) | At `fa7816b` (main of 2026-10-14). No commits, no uncommitted files | BUILD-AUTOMATION-003 produced only an audit and plan in conversation, with no repository changes. Nothing to reuse or integrate |
| BUILD-AUTOMATION-002 (`src/delegation/`, migration 0011) | On main | Universal Workflow Authorization, manifest, authority graph, executor, budget ledger, revocation. **Reused** |
| BUILD-MCP-001/002 (`src/mcp/`, `src/platform/`) | On main | Tools, approval handoff, `/approve`, panel, run attribution. **Reused and extended** |
| BUILD-CHANNELS-001, BUILD-TELEGRAM-PUBLIC-001 (`src/channels/`) | On main | Channel Core, Telegram adapter, public mode, limits. **Reused** |
| BUILD-CHANNEL-SIGNING-001, BUILD-SOLANA-TRANSFER-UX-001 (`signing-surface.tsx`) | On main | Canvas-free signing surface on `/approve`. **Reused** |
| BUILD-SOLANA-COMPOSITION-001 (`composition-bindings.ts`) | On main | `min(cap, reconciled output)` binding pattern. **Pattern reused** |
| BUILD-ETHEREUM-MAINNET-001 | On main | Fee audit finding (no fee ledger exists). **Recorded** |
| WhatsApp (`src/channels/whatsapp`) | On main, provider activation pending | Not activated or bypassed |

### 1.2 What already exists

- **Authoring.** StrategySpec v1 and the step list v2 (`engine/strategy-spec.ts`, 1–8 steps). Each step composes to its own
  Semantic Workflow IR and hash. The workflow hash of several steps covers the ordered step hashes (`workflowSequenceHash`).
  MCP `compose/validate/review/simulate_strategy` work per step. The in-app Copilot (EN/PT) and Channel Core produce the same
  authoring `Command`s.
- **Owner-signed execution of one step.** `request_user_approval` → handoff (authority NONE, fragment secret) → `/approve`
  (wallet proof, claim, re-composition to the same hash) → signing surface (fresh simulation, Review, wallet signature) → the
  flow's own durable run, reconciliation and Evidence Bundle. `sharedRuns` attributes runs to a handoff by reviewed workflow
  hash and claimant, and reads reconciled evidence server-side. `resumeApproval` lets the proven claimant reopen an APPLIED
  handoff by id.
- **Delegated execution (BUILD-AUTOMATION-002).** Passkeys; Credentials with per-chain grants (ERC-7710 MetaMask DF v1.3.0;
  SPL `ApproveChecked`); the Delegated Authorization Manifest; the Universal Workflow Authorization envelope, signed once
  with a passkey; an executor that re-verifies the whole authority chain on every pass, reserves budget atomically, simulates
  freshly, checks policy, persists signed bytes before broadcast, reconciles and settles. **Its source is always an automation
  rule occurrence**: `delegated_authorizations.rule_id` and `delegated_executions.rule_id/occurrence_id` are `NOT NULL` with
  foreign keys to the automation tables.
- **Durable work.** `work_items` with fenced leases (`cloud-runtime/work-queue.ts`), used by automations and delegation.

### 1.3 Exact capability gaps

| Requirement | Gap on main |
| --- | --- |
| Multi-step execution | `workflowPlan` returns `NOT_EXECUTABLE / MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED` for every sequence except the fixed lending composition. No sequential runner and no durable run of a step list |
| Dependent steps | The v2 contract has fixed per-step amounts and no typed inter-step dependency. Only the Canvas-only Solana Devnet swap → Orca binding exists |
| One authorization for a conversational workflow | The delegated model exists, but only for automation rules. A chat or MCP workflow cannot be authorized once |
| Authorization count before execution | Not computed or shown anywhere |
| Run status in conversation | Single-step `get_approval_status` only; no per-step progress of a sequence |
| Fee | **No FloFi fee is collected or recorded on main** (`src/app/admin/page.tsx`; BUILD-ETHEREUM-MAINNET-001 report). The chargeable basis and partial-failure rule are not defined |
| Production delegated signing | Blocked: no KMS/HSM signer provider; hosted deployments refuse `memory` and `local-disposable` signers (`DELEGATED_SIGNER_UNAVAILABLE`) |
| Delegable actions | Only Uniswap v3 exact-input USDC↔WETH swaps on Base Sepolia and Ethereum Sepolia (production adapters), plus a MOCKED Solana harness. Mainnets, bridges, Aave, liquidity and Jupiter are refused with precise codes |

## 2. Architecture decisions

### 2.1 One workflow approval, one durable workflow run

The BUILD-MCP-002 plan (§4.7) reserved the `SEQUENTIAL` plan kind so that the runner would plug in "without schema or UI
redesign". This build follows that intent:

- A multi-step workflow is still **one** approval handoff (`request_user_approval`, one `approvalId`, the v2 strategy and the
  sequence hash). Its plan becomes `SEQUENTIAL` when every step has an owner-execution flow.
- A new durable **Workflow Run** (`wfr_…`) is bound 1:1 to that handoff and holds the sequence state: owner wallets, mode,
  current step, each step's resolved strategy and hash, run references, reconciled outcome and evidence references.
- `/approve` loads **the current step** of the run as an ordinary single-step proposal into the existing signing surface. The
  flow, Review, wallet signature, reconciliation and evidence of each step are therefore the existing, unchanged ones.

### 2.2 Two authorization modes, chosen before anything executes, never switched silently

| Mode | When | Owner authorizations |
| --- | --- | --- |
| `CONFIRM_EACH_STEP` | Always available when every step has an enabled owner-execution flow | One wallet confirmation per step, each after a fresh simulation and Review. A flow may ask for more (e.g. a token approval) |
| `DELEGATED_SINGLE_AUTHORIZATION` | Only when every step is delegation-capable, every step resolves to an ACTIVE grant of the proven owner, all grants anchor one passkey, and this deployment has a signer and executor | One-time enrollment (one wallet signature per chain grant, once), then **one passkey assertion for the whole workflow** and none per step |

A workflow where only some steps are delegable runs in `CONFIRM_EACH_STEP`. This build does not mix modes within one run. The
authorization plan says why delegation is unavailable, step by step, with the existing closed codes.

The **authorization plan** is a pure function of the composed workflow, the deployment facts and (when known) the owner's
grants. It is returned before anything executes, by MCP and by `/approve`. It reports:

- per step: flow, delegated capability or refusal code, and the covering grant;
- totals: wallet confirmations, passkey assertions and enrollments still missing.

One authorization does not mean one transaction or zero gas.

### 2.3 Typed step dependencies

A v2 step may declare `inputFrom: { step: k }`. Its `amount` then becomes a **cap**, and the amount actually used is
`min(cap, actual reconciled amount of that asset received by step k)`. This follows the existing Solana composition rule. Rules:

- `k` must be an earlier step. The producer's output asset must be the consumer's input asset, with the same chain and token
  identity. The consumer must be an action with one input amount (swap, bridge, supply, repay or transfer).
- The binding is part of the canonical workflow. The sequence hash covers it. A workflow without bindings keeps its existing
  hash byte for byte.
- The resolved amount is computed only from **reconciled** facts:
  - delegated steps: the executor's reconciled `received`;
  - owner-signed steps: only flows whose reconciled evidence states the received amount.
- A producer without such a source is refused at plan time (`DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED`). It is never estimated.

### 2.4 Sequencing, idempotency and recovery

- **Runs.** `PENDING → RUNNING → COMPLETED`. The other outcomes are:
  - `HALTED`: at least one step reconciled, and a later step cannot proceed. Funds rest in the owner's wallet. This is the
    explicit partial completion.
  - `FAILED`: nothing irreversible happened, or the first step reverted.
  - `ATTENTION`: an outcome is uncertain. Observation only.
  - `CANCELLED` and `EXPIRED`.
- **Steps.** `PENDING → READY → AWAITING_OWNER | DELEGATED → RECONCILED`, or `FAILED` (reconciled failure), `UNCERTAIN`
  (submitted, outcome unknown) and `SKIPPED`.
- **Ordering.** Step k+1 becomes READY only after step k is RECONCILED. Its inputs are then resolved, and it is re-composed and
  re-gated (deployment and policy) as a single-step workflow.
- **Transitions.** Every transition is a compare-and-set on the row version. Database triggers enforce forward-only states and
  the immutability of bound facts.
- **Advancement.** The work kind `workflow-run.advance` (deduplicated per run) advances the run, and status reads observe it.
  Both are idempotent. A restart re-reads durable state only.
- **No duplicate execution:**
  - A step is executed by its flow's own run, which keeps the flow's existing single-broadcast and observe-only recovery.
  - A step with any submitted, unknown outcome makes the run `ATTENTION`. Nothing is re-signed or retried.
  - A step whose run failed **before submission** may be retried by the owner, in the same signing surface. That is the flow's
    own existing behaviour.
- **Owner continuity.** The claim binds the run's owner wallets (every namespace the run needs must be proven in that browser).
  Every later step is loaded only for those wallets.

### 2.5 Delegated runs

Migration `0015_workflow_runs` adds the run tables. It also generalizes three BUILD-AUTOMATION-002 tables
(`delegated_authorizations`, `delegated_executions`, budget entries) to accept a workflow run as their source:
`rule_id`/`occurrence_id` become nullable, `workflow_run_id` is added, and an exclusive-source check is added.

The executor gains a workflow-run source beside the automation occurrence. Its authority chain and its per-step pipeline are
unchanged: verify, reserve, simulate, policy, prepare, broadcast, reconcile, settle.

A run's manifest is **one-shot**:

- validity of hours, not months;
- one execution;
- per-asset caps equal to the workflow's own spend;
- slippage equal to the workflow's own slippage (default 100 bps).

Revocation, budget, expiry, replay protection (a single-use challenge and a fresh nonce) and account isolation are the
existing mechanisms.

### 2.6 Conversation surfaces

- **MCP.**
  - `compose_strategy`, `review_strategy` and `get_capabilities` report the `SEQUENTIAL` plan and the authorization plan.
  - `request_user_approval` accepts executable sequences.
  - A new `get_workflow_run_status` returns per-step progress. Transaction hashes, explorer URLs, received amounts and evidence
    are included only when the owner shares status, which is the existing consent rule.
- **Telegram / Channel Core.** The same run lifecycle through the shared platform. The scope reached for channel multi-step
  authoring is recorded in the report.
- No channel or model ever receives signing authority.

### 2.7 Fee

No fee mechanism exists to preserve, and inventing a chargeable basis is out of scope. The run records exactly one terminal
`COMPLETED` fact per workflow run, keyed by run id. It is never recorded per step and never twice. This is the single event a
future 0.1% fee settlement must key on. The chargeable basis (for example input notional in which asset and at which price
source) and the behaviour on partial completion are owner decisions, listed in the report.

## 3. Phases and scope of this build

| Phase | Deliverable |
| --- | --- |
| A | This audit |
| B | `inputFrom` bindings; `SEQUENTIAL` plan and authorization plan; `/approve` loads the current run step into the existing signing surface and continues the run |
| C | Workflow run domain, state machines, migration 0015, PostgreSQL store, runner, `workflow-run.advance` work kind, observation of step runs through the existing flow runtime |
| D | Executor workflow-run source; one-shot manifest; run authorization review and sign (passkey) operations; bound-amount resolution in delegated mode |
| E | MCP tools and channel status through the shared run lifecycle |
| F | Unit tests (planning, bindings, state machines); PostgreSQL integration tests (run store, runner, delegated run on the MOCKED harness: one passkey assertion, no wallet request during execution, reconciliation, restart, duplicate delivery, revocation) |
| G | Report, capability and network matrix, acceptance checklist, PR summary |

## 4. Boundaries

- No push, PR, merge, deployment, production migration, production configuration change, production signer or delegation
  activation, or real-funds transaction.
- No new production custody shortcut: hosted deployments keep refusing disposable signers, and delegated mode stays
  unavailable there until a reviewed KMS/HSM provider exists.
- Evidence levels are reported honestly:
  - unit and PostgreSQL integration tests on MOCKED loopback doubles are **MOCKED**;
  - nothing here is a fork, testnet or mainnet execution.
- Heavy certification suites are not run on the owner's WSL machine. Focused unit and PostgreSQL suites run on a disposable
  loopback PostgreSQL.
- Migration 0015 needs the DB-COMPAT two-release process: a forward-compatibility certificate in a prior release. That release
  split is an owner decision.
