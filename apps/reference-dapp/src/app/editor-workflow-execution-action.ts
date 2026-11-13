// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { flightWalletRefusal, withFlightAccess } from '../server/flight-access';
/**
 * P0 workflow execution: the Editor runs a multi-step Canvas workflow as ONE workflow run, in place, with the lowest-friction authorization the
 * owner's own wallet really supports (an EIP-5792 atomic batch where it reports one), instead of a sequence of separate per-step flows.
 *
 *   availability   whether this deployment offers it (Editor workflow runs + user-funded execution); reveals nothing about anyone
 *   review         read-only: the plan for the wallet's reported capabilities and the first group's exact calls, simulation and fee
 *                  (`src/editor/workflow-execution.ts`). Nothing is stored, signed or sent
 *   authorize      the owner's one click: the shared workflow run is started (the Editor's own approval handoff, `src/editor/approval.ts`),
 *                  claimed for the wallet this browser proved (EIP-4361 session; never a client-supplied address), started in user-funded mode
 *                  with the capabilities the browser read, and its first group prepared from fresh chain facts. The browser then hands exactly
 *                  that prepared request to the owner's wallet; every later step uses the run's own server actions (`approve-action.ts`)
 *
 * Every refusal is a closed code. A run that was started but could not reach its wallet request is ended (nothing was signed or sent).
 */
import { cookies } from 'next/headers';
import { accountHost, currentAccountSession } from '../accounts/account-host';
import { readEditorRunConfig } from '../editor/approval';
import { bindingOf, runMatchesBinding } from '../editor/authorize-binding';
import { editorWorkflowStrategy } from '../editor/workflow-strategy';
import { prepareCatalogs } from '../server/editor-catalogs';
import { platformStateHost } from '../server/platform-state-host';
import { deploymentEngineRuntime, evaluateGates, fixedWindow, type HandoffPolicy } from '../platform/index';
import { reviewEditorExecution, type EditorExecutionReview } from '../editor/workflow-execution';
import { walletProfileOf, workflowRunCancel, workflowRunUserFundedPrepare, workflowRunUserFundedStart, claimApproval, type ClaimedProposal } from '../platform/index';
import type { PreparedGroupView } from '../workflow-runs/service';
import { approvalSurface } from '../server/approval-surface';
import { currentWalletPrincipals } from '../server/session-principal';
import { userFundedRuntime } from '../user-funded/runtime';
import { startEditorWorkflowRun } from './editor-run-action';

type Result<T> = { ok: true; value: T } | { ok: false; code: string; step?: number };
const CODE = /^[A-Z][A-Z0-9_:]{2,100}$/;
const failure = (cause: unknown, fallback = 'EDITOR_EXECUTION_FAILED'): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Whole-workflow Reviews per FloFi account (each one reads quotes, allowances and a batch simulation on FloFi's RPC). */
const REVIEW_LIMIT = 30, REVIEW_WINDOW_SECONDS = 600;
/** Only the deployment and code facts of a bridge step's gates are read for the Review (the run's start applies its requester's own policy). */
const REVIEW_GATE_POLICY: HandoffPolicy = { ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' };
/** Whether the Editor can run a whole workflow as one run with user-funded grouped authorization on this deployment. */
export async function editorWorkflowExecutionAvailability(): Promise<{ readonly enabled: boolean; readonly code: string | null }> {
  return withFlightAccess(async () => {
  const env = process.env, editor = readEditorRunConfig(env);
  if (!editor.enabled) return { enabled: false, code: editor.code };
  const facts = userFundedRuntime(env).facts;
  if (!facts.enabled) return { enabled: false, code: facts.code ?? 'USER_FUNDED_NOT_ENABLED' };
  // Without a FloFi account session the run cannot start: the Editor keeps its step-by-step path primary instead of a Review that would refuse.
  const accounts = await accountHost(env).catch(() => null);
  return await currentAccountSession(accounts, env) ? { enabled: true, code: null } : { enabled: false, code: 'ACCOUNT_SESSION_REQUIRED' };

  });
}

/**
 * The whole-workflow Review (read-only) for the connected EVM wallet and the capabilities the browser read from it. Requires the FloFi account
 * session the run itself needs (so the Review is never an anonymous quote proxy); the wallet address is the one the owner will sign with.
 */
export async function reviewEditorWorkflow(workflow: unknown, owner: string, profile: unknown): Promise<Result<EditorExecutionReview>> {
  return withFlightAccess(async () => {
  try {
    const env = process.env;
    if (!readEditorRunConfig(env).enabled) return { ok: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
    const accounts = await accountHost(env).catch(() => null), session = await currentAccountSession(accounts, env);
    if (!session) return { ok: false, code: 'ACCOUNT_SESSION_REQUIRED' };
    if (typeof owner !== 'string' || !EVM_ADDRESS.test(owner)) return { ok: false, code: 'EVM_WALLET_REQUIRED' };
    // P0: the Review is computed for the wallet the API will bind, so its Flight decision is the API's (a value, before any quote or simulation).
    const flight = await flightWalletRefusal(owner, env);
    if (flight) return { ok: false, code: flight };
    const host = await platformStateHost(env);
    if (!await fixedWindow(host.db, host.tenantId).allow(`editor-review:${session.accountId}`, REVIEW_LIMIT, REVIEW_WINDOW_SECONDS, new Date()))
      return { ok: false, code: 'EDITOR_REVIEW_RATE_LIMITED' };
    // The workflow's listed tokens resolve exactly as on the Canvas (the run's own start does the same).
    await prepareCatalogs(workflow);
    // ADR-0009: the Review's preparation is a preview (no sponsorship grant), but it says whether FloFi would sponsor the fee (shared state).
    const runtime = userFundedRuntime(env, fetch, host), engine = deploymentEngineRuntime(env);
    // P0 hotfix: a bridge joins the batch only while its own flow executes on this deployment (code support and the deployment's live mode /
    // owner-execution switch — the policy part is the run's own, checked when it starts); otherwise the Review says why, step by step.
    const stepRefusal = async (step: Parameters<typeof evaluateGates>[0]) => {
      const gates = await evaluateGates(step, engine, REVIEW_GATE_POLICY);
      return !gates.supportedByCode.execute ? gates.supportedByCode.reason ?? 'OWNER_EXECUTION_NOT_IMPLEMENTED'
        : !gates.enabledByDeployment.enabled ? gates.enabledByDeployment.reason ?? 'FLOW_NOT_ENABLED' : null;
    };
    return await reviewEditorExecution({ workflow, owner, profile: walletProfileOf(profile), facts: runtime.facts, deps: runtime.deps, now: new Date(), stepRefusal });
  } catch (cause) { return failure(cause); }

  });
}

export type EditorAuthorization = { readonly approvalId: string; readonly proposal: ClaimedProposal; readonly prepared: PreparedGroupView };
/**
 * The owner's Authorize: starts the shared workflow run of this Canvas workflow, claims it for the proven wallet, starts it in user-funded mode
 * for the reported wallet capabilities and prepares its first group. Returns what the owner's wallet is asked next (nothing has been asked yet).
 * Bound to what the owner reviewed: the wallet this browser proved must be the reviewed one (EVM_WALLET_PROOF_REQUIRED otherwise: the Editor
 * asks the reviewed wallet's sign-in message once and retries), and the started run must be the reviewed workflow with the reviewed groups
 * (EDITOR_EXECUTION_PLAN_CHANGED otherwise; the run is ended before anything is asked).
 */
export async function authorizeEditorWorkflow(workflow: unknown, profile: unknown, reviewed: unknown): Promise<Result<EditorAuthorization>> {
  return withFlightAccess(async () => {
  let approvalId: string | null = null;
  const jar = await cookies();
  const surface = () => approvalSurface(process.env, name => jar.get(name)?.value);
  try {
    const parsed = walletProfileOf(profile);
    const binding = bindingOf(reviewed);
    if (!binding) return { ok: false, code: 'REVIEW_REQUIRED' };
    // Only the reviewed EVM wallet is claimed (another proven EVM wallet of this browser never runs a workflow it did not review).
    const wallets = (await currentWalletPrincipals()).filter(w => w.namespace !== 'eip155' || w.address.toLowerCase() === binding.owner);
    if (!wallets.some(w => w.namespace === 'eip155')) return { ok: false, code: 'EVM_WALLET_PROOF_REQUIRED' };
    // The workflow sent is the reviewed one before anything is created (no handoff or run for a workflow that changed since the Review).
    await prepareCatalogs(workflow);
    const converted = editorWorkflowStrategy(workflow);
    if (!converted.ok || converted.workflowHash !== binding.workflowHash) return { ok: false, code: 'EDITOR_EXECUTION_PLAN_CHANGED' };
    const started = await startEditorWorkflowRun(workflow);
    if (!started.ok) return started;
    approvalId = started.value.approvalId;
    const secret = new URL(started.value.approvalUrl).hash.slice(1);
    const s = await surface();
    await claimApproval(s, secret, wallets, true);
    const proposal = await workflowRunUserFundedStart(s, approvalId, wallets, parsed);
    const run = proposal.view.workflowRun?.run;
    const first = run?.groups?.[0];
    // The Editor authorizes in place only a run whose first group is one wallet-grouped interaction; anything else is ended, never half-started.
    if (!run || run.mode !== 'USER_FUNDED' || !first || !['EVM_WALLET_BATCH', 'EVM_USER_OPERATION', 'SOLANA_SIGN_ALL'].includes(first.strategy))
      throw new Error('EDITOR_EXECUTION_PLAN_CHANGED');
    // Exactly the reviewed workflow and plan: the same canonical workflow hash, the same groups (mechanism and steps) in the same order.
    if (!runMatchesBinding(run, binding)) throw new Error('EDITOR_EXECUTION_PLAN_CHANGED');
    const prepared = await workflowRunUserFundedPrepare(s, approvalId, wallets, 0);
    return { ok: true, value: { approvalId, proposal, prepared } };
  } catch (cause) {
    // Nothing was signed or sent: a started run that could not reach its wallet request is ended (it stays readable as ended).
    if (approvalId) { try { await workflowRunCancel(await surface(), approvalId, await currentWalletPrincipals()); } catch { /* already ended or not created */ } }
    return failure(cause);
  }

  });
}
