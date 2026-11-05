# Workflow runs (BUILD-CHAT-E2E-001)

A workflow run executes one approved multi-step workflow for the wallets its owner proved when claiming it. A conversation on MCP or a
channel hands the workflow to its owner as **one** approval. The run then executes the steps in order, each only after the previous one
reconciled.

Workflow runs are **off by default**. With them off, a multi-step workflow is refused with `WORKFLOW_RUNS_NOT_ENABLED` and nothing else
changes.

## 1. Configuration

| Variable | Where | Effect |
| --- | --- | --- |
| `FLOFI_WORKFLOW_RUNS=enabled` | web (Vercel) **and** worker (Railway) | Sequences are handed off, claimed on `/approve`, observed and reported |
| `FLOFI_DELEGATION`, `FLOFI_DELEGATED_SIGNER`, `FLOFI_DELEGATED_EXECUTION` | BUILD-AUTOMATION-002 ([AUTOMATIONS.md §8](AUTOMATIONS.md)) | Delegated mode only. Hosted deployments cannot configure a signer provider, so delegated runs are unavailable there (`DELEGATED_SIGNER_UNAVAILABLE`) |
| `FLOFI_DELEGATION_MAINNET_CHAINS` (`eip155:1,eip155:8453,eip155:42161` or a subset) | web, API **and** worker (with `FLOFI_DELEGATION=enabled`) | BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001. Opts Ethereum, Base and Arbitrum One into delegated workflow runs authorized by ONE wallet-signed exact workflow grant per network (Uniswap v3 USDC⇄WETH swap, Aave V3 Supply and variable-rate Borrow). Unset: every mainnet step stays `MAINNET_DELEGATION_DISABLED`. Any other value disables delegation (`DELEGATION_CONFIGURATION_INVALID`); never together with a harness. Signing needs `FLOFI_DELEGATED_SIGNER=aws-kms` on the API and worker and `remote-api` on the web tier (docs/deploy/SINGLE-AUTH-MAINNET-ACTIVATION.md) |
| `FLOFI_EDITOR_WORKFLOW_RUNS` (`enabled` by default where workflow runs are; `disabled` turns it off) | web (Vercel) | The Editor's **Run workflow**: a signed-in FloFi account's simulated multi-step Canvas workflow starts the same run on `/approve` (requester kind `EDITOR_SESSION`, migration 0021). Needs `DATABASE_URL` (accounts), `FLOFI_PUBLIC_ORIGIN` and the session secret (`FLOFI_SESSION_SECRET`); any malformed value disables it |
| `FLOFI_EDITOR_HANDOFF_TEST_FUNDS`, `FLOFI_EDITOR_HANDOFF_MAINNET_NETWORKS` | web (Vercel) | The Editor handoff policy, with the same rules and defaults as `FLOFI_MCP_HANDOFF_*` (the public product: every mainnet, no test network) |

Requirements:

- **Schema 0015 must be applied first.** Follow the two-release process in [SCHEMA-COMPATIBILITY.md §9](SCHEMA-COMPATIBILITY.md#9-certificate-0015_workflow_runs).
- **The Editor's Run workflow needs schema 0021** (the `EDITOR_SESSION` requester kind), released certificate first:
  [SCHEMA-COMPATIBILITY.md §14](SCHEMA-COMPATIBILITY.md#14-certificate-0021_editor_requester).
- **Do not enable delegated workflow runs until every process runs Release B.**

## 2. What runs where

**Web (`/approve`, MCP, channels).** The web side does these things:

- creates a run at the claim, binding every wallet namespace the workflow needs;
- resolves each next step when its owner continues: it re-composes the step, re-checks the deployment and the requester kind's policy, and
  checks for review blockers;
- loads that step into the existing signing surface as an ordinary single-step proposal.

The Canvas is optional.

**Editor (`/app`, Execute).** A multi-step workflow built and simulated on the Canvas (2–8 steps, valid, simulated at its current revision, no
step executed yet in the Editor) offers **Run workflow**. The server action requires the verified FloFi account session; it re-reads the Canvas
workflow into the canonical v2 strategy (each step's authoring command, the Canvas funding as typed bindings), refuses any step the engine does
not reproduce exactly, and hands it to the same approval service. The browser then opens `/approve`, where only a wallet that account holds can
claim it and the run panel offers *Confirm each step* or *Authorize once*. The button never asks the wallet for anything. One-step workflows keep
their own per-flow path.

**Worker (`main.ts worker`).** The `workflow-run.advance` work item does these things:

- observes owner-signed step runs, read-only, through the worker's own flow services;
- mirrors a delegated run's execution into the run.

The worker never signs or submits. It never makes a step ready, because that needs the requester surface's policy. Its sweep also does two
jobs: it expires runs that never started, and it re-arms open runs whose work item is missing.

The owner's status polls on `/approve` run the same observe-only pass. A reconciled step therefore shows at once, and the owner's *Continue*
never waits on the worker. The worker is still required for three things:

- observing runs while no owner tab is open, which keeps conversation status and notifications current;
- delegated runs;
- the sweep.

**Delegated executor (`delegation.execute-run`).** This runs only on a deployment with a signer provider. It is BUILD-AUTOMATION-002's
executor, with a workflow run as its source.

## 3. Lifecycle and recovery

| Run state | Meaning | Who acts |
| --- | --- | --- |
| `PENDING` | Claimed. The owner chooses the authorization mode, or it starts at once when only one mode exists | Owner on `/approve` |
| `RUNNING` | A step waits for its signature (confirm mode), is in flight, or is executing under the one authorization (delegated mode) | Owner / FloFi |
| `ATTENTION` | A submitted step's outcome is unknown. FloFi keeps observing it and never resubmits it | FloFi; operator if it persists |
| `HALTED` | Partial completion: reconciled steps stay done, and a later step stopped before submitting anything | Owner: resume (if it submitted nothing) or end |
| `COMPLETED` | Every step reconciled. Recorded once (the single per-workflow completion fact) | — |
| `FAILED` / `CANCELLED` / `EXPIRED` | Terminal | — |

How a run recovers:

- **After a restart, reconnect or delay:** nothing is lost. The next advance re-reads durable state.
- **After an uncertain submission:** nothing is retried. Only the flow's own observation, or the delegated executor's re-broadcast of the
  identical persisted bytes, can settle it.

## 4. Status and consent

The requester (MCP `get_approval_status`, channel STATUS and notifications) always sees each step's state.

Some details are shown only while the owner shares status, which is the existing `/approve` choice:

- transaction hashes and explorer links;
- reconciled amounts;
- evidence;
- "step N is ready" notifications.

The claiming wallet is never shown.

The continuation link `/approve#apr_…` is not a secret. It opens only for the run owner's proven wallet.

## 5. Not covered

- Owner-signed sequences cannot resolve bound amounts (`DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED`).
- Delegated mode covers only BUILD-AUTOMATION-002's delegable steps, plus (BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001) Arbitrum One USDC⇄WETH
  swaps and Aave V3 Supply/Borrow where the deployment opted Arbitrum One in. See
  [the build report](../builds/BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001-REPORT.md) for the capability matrix and what remains blocked.
- The Developer API's approval status does not report per-step run progress yet.
- No FloFi fee is charged.
