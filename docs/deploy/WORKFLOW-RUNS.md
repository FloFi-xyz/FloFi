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

Requirements:

- **Schema 0015 must be applied first.** Follow the two-release process in [SCHEMA-COMPATIBILITY.md §9](SCHEMA-COMPATIBILITY.md#9-certificate-0015_workflow_runs).
- **Do not enable delegated workflow runs until every process runs Release B.**

## 2. What runs where

**Web (`/approve`, MCP, channels).** The web side does these things:

- creates a run at the claim, binding every wallet namespace the workflow needs;
- resolves each next step when its owner continues: it re-composes the step, re-checks the deployment and the requester kind's policy, and
  checks for review blockers;
- loads that step into the existing signing surface as an ordinary single-step proposal.

The Canvas is optional.

**Worker (`main.ts worker`).** The `workflow-run.advance` work item does these things:

- observes owner-signed step runs, read-only, through the worker's own flow services;
- mirrors a delegated run's execution into the run.

The worker never signs or submits. It never makes a step ready, because that needs the requester surface's policy. Its sweep also does two
jobs: it expires runs that never started, and it re-arms open runs whose work item is missing.

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
- Delegated mode covers only BUILD-AUTOMATION-002's delegable steps.
- The Developer API's approval status does not report per-step run progress yet.
- No FloFi fee is charged.
