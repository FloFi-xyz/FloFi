// SPDX-License-Identifier: AGPL-3.0-only
'use server';
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

/** Whether the Editor can run a whole workflow as one run with user-funded grouped authorization on this deployment. */
export async function editorWorkflowExecutionAvailability(): Promise<{ readonly enabled: boolean; readonly code: string | null }> {
  const env = process.env, editor = readEditorRunConfig(env);
  if (!editor.enabled) return { enabled: false, code: editor.code };
  const facts = userFundedRuntime(env).facts;
  return facts.enabled ? { enabled: true, code: null } : { enabled: false, code: facts.code ?? 'USER_FUNDED_NOT_ENABLED' };
}

/**
 * The whole-workflow Review (read-only) for the connected EVM wallet and the capabilities the browser read from it. Requires the FloFi account
 * session the run itself needs (so the Review is never an anonymous quote proxy); the wallet address is the one the owner will sign with.
 */
export async function reviewEditorWorkflow(workflow: unknown, owner: string, profile: unknown): Promise<Result<EditorExecutionReview>> {
  try {
    const env = process.env;
    if (!readEditorRunConfig(env).enabled) return { ok: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
    const accounts = await accountHost(env).catch(() => null);
    if (!await currentAccountSession(accounts, env)) return { ok: false, code: 'ACCOUNT_SESSION_REQUIRED' };
    if (typeof owner !== 'string' || !EVM_ADDRESS.test(owner)) return { ok: false, code: 'EVM_WALLET_REQUIRED' };
    const runtime = userFundedRuntime(env);
    return await reviewEditorExecution({ workflow, owner, profile: walletProfileOf(profile), facts: runtime.facts, deps: runtime.deps, now: new Date() });
  } catch (cause) { return failure(cause); }
}

export type EditorAuthorization = { readonly approvalId: string; readonly proposal: ClaimedProposal; readonly prepared: PreparedGroupView };
/**
 * The owner's Authorize: starts the shared workflow run of this Canvas workflow, claims it for the proven wallet, starts it in user-funded mode
 * for the reported wallet capabilities and prepares its first group. Returns what the owner's wallet is asked next (nothing has been asked yet).
 * EVM_WALLET_PROOF_REQUIRED: this browser has not proven the wallet (the Editor then asks the wallet's sign-in message once and retries).
 */
export async function authorizeEditorWorkflow(workflow: unknown, profile: unknown): Promise<Result<EditorAuthorization>> {
  let approvalId: string | null = null;
  const jar = await cookies();
  const surface = () => approvalSurface(process.env, name => jar.get(name)?.value);
  try {
    const parsed = walletProfileOf(profile);
    const wallets = await currentWalletPrincipals();
    if (!wallets.some(w => w.namespace === 'eip155')) return { ok: false, code: 'EVM_WALLET_PROOF_REQUIRED' };
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
    const prepared = await workflowRunUserFundedPrepare(s, approvalId, wallets, 0);
    return { ok: true, value: { approvalId, proposal, prepared } };
  } catch (cause) {
    // Nothing was signed or sent: a started run that could not reach its wallet request is ended (it stays readable as ended).
    if (approvalId) { try { await workflowRunCancel(await surface(), approvalId, await currentWalletPrincipals()); } catch { /* already ended or not created */ } }
    return failure(cause);
  }
}
