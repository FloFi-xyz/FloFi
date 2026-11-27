// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { flightWalletRefusal, withFlightAccess, withFlightOwner } from '../server/flight-access';
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
import { cookies, headers } from 'next/headers';
import { BATCH_PAYMENT_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { accountHost, currentAccountSession } from '../accounts/account-host';
import { readEditorRunConfig, startEditorRun, withdrawUnstartedHandoff, type EditorRunStarted } from '../editor/approval';
import { createPgHandoffStore } from '../platform/index';
import { EMBEDDED_APPROVAL_PATH } from '../server/embedded-approval';
import { createPgWorkflowRunStore, singleStepRunsSupported } from '../workflow-runs/pg-store';
import { bindingOf, reviewedWallets, runMatchesBinding, SOLANA_OWNER } from '../editor/authorize-binding';
import { editorWorkflowStrategy, singleCardRunRecord, type SingleRunRecord } from '../editor/workflow-strategy';
import { prepareCatalogs } from '../server/editor-catalogs';
import { platformStateHost } from '../server/platform-state-host';
import { deploymentEngineRuntime, evaluateGates, fixedWindow, type HandoffPolicy } from '../platform/index';
import { reviewEditorExecution, solanaBatchOnly, type EditorExecutionReview } from '../editor/workflow-execution';
import { walletProfileOf, workflowRunCancel, workflowRunStatus, workflowRunUserFundedPrepare, workflowRunUserFundedStart, claimApproval, type ClaimedProposal } from '../platform/index';
import type { PreparedGroupView } from '../workflow-runs/service';
import { approvalSurface } from '../server/approval-surface';
import { currentWalletPrincipals } from '../server/session-principal';
import { userFundedRuntime } from '../user-funded/runtime';
import { startEditorWorkflowRun } from './editor-run-action';
import { requirementOf } from '../delegation/steps';

type Result<T> = { ok: true; value: T } | { ok: false; code: string; step?: number };
const CODE = /^[A-Z][A-Z0-9_:]{2,100}$/;
const failure = (cause: unknown, fallback = 'EDITOR_EXECUTION_FAILED'): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** KAN-20: a Solana owner (base58, case-sensitive: never lower-cased); its workflow is re-validated as Solana Batch Payments only. */
const SOLANA_ADDRESS = SOLANA_OWNER;
/** Whole-workflow Reviews per FloFi account (each one reads quotes, allowances and a batch simulation on FloFi's RPC). */
const REVIEW_LIMIT = 30, REVIEW_WINDOW_SECONDS = 600;
/** Only the deployment and code facts of a bridge step's gates are read for the Review (the run's start applies its requester's own policy). */
const REVIEW_GATE_POLICY: HandoffPolicy = { ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' };
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: whether a Canvas workflow is ONE financial card (the Editor's single-card run). Only a hint for
 * choosing the path; the workflow itself is re-read and re-validated by `editorWorkflowStrategy`.
 */
const financialNodes = (workflow: unknown): readonly { readonly actionType: string; readonly chainId?: unknown }[] => {
  const nodes = workflow && typeof workflow === 'object' ? (workflow as { nodes?: unknown }).nodes : null;
  return Array.isArray(nodes) ? nodes.filter((node): node is { actionType: string; chainId?: unknown } => Boolean(node) && typeof node === 'object'
    && typeof (node as { actionType?: unknown }).actionType === 'string' && !(node as { actionType: string }).actionType.startsWith('mock-')) : [];
};
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: ONE Batch Payment card is not a single-card run: its run is its 2..8 payments (one atomic group), so it
 * takes the ordinary workflow run whatever the deployment answers about one-step runs. Only a hint for the path (re-validated by `editorWorkflowStrategy`).
 */
const loneBatchPayment = (workflow: unknown): boolean => { const nodes = financialNodes(workflow); return nodes.length === 1 && nodes[0]!.actionType === BATCH_PAYMENT_ACTION; };
/** ONE financial card (the single-card path: the shell then offers its own flow, or this run). */
const singleCard = (workflow: unknown): boolean => financialNodes(workflow).length === 1 && !loneBatchPayment(workflow);
/** The single-card run's scope: ONE EVM card (the user-funded EVM execution groups; a Solana card already signs once through its own flow). */
const singleEvmCard = (workflow: unknown): boolean => { const nodes = financialNodes(workflow);
  return singleCard(workflow) && typeof nodes[0]!.chainId === 'string' && nodes[0]!.chainId.startsWith('eip155:'); };
/** Whether this deployment's database accepts a one-step workflow run (migration 0032, exact identity; any failure: no). */
const singleStepRunsHere = async (env: NodeJS.ProcessEnv): Promise<boolean> => {
  try { return await singleStepRunsSupported((await platformStateHost(env)).db); } catch { return false; }
};
/**
 * Whether the Editor can run a whole workflow as one run with user-funded grouped authorization on this deployment. `singleStep`
 * (BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001): whether ONE financial card can run that way too — only once the database accepts one-step runs
 * (migration 0032, applied by an operator); until then a single card keeps its own flow.
 */
export async function editorWorkflowExecutionAvailability(): Promise<{ readonly enabled: boolean; readonly code: string | null; readonly singleStep?: boolean }> {
  return withFlightAccess(async () => {
  const env = process.env, editor = readEditorRunConfig(env);
  if (!editor.enabled) return { enabled: false, code: editor.code };
  const facts = userFundedRuntime(env).facts;
  if (!facts.enabled) return { enabled: false, code: facts.code ?? 'USER_FUNDED_NOT_ENABLED' };
  // Without a FloFi account session the run cannot start: the Editor keeps its step-by-step path primary instead of a Review that would refuse.
  const accounts = await accountHost(env).catch(() => null);
  if (!await currentAccountSession(accounts, env)) return { enabled: false, code: 'ACCOUNT_SESSION_REQUIRED' };
  return { enabled: true, code: null, singleStep: await singleStepRunsHere(env) };

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
    // KAN-20: a Solana Batch Payment is reviewed for the owner's Solana wallet (base58, passed verbatim); every other workflow for an EVM wallet.
    if (typeof owner !== 'string' || !EVM_ADDRESS.test(owner) && !SOLANA_ADDRESS.test(owner)) return { ok: false, code: 'EVM_WALLET_REQUIRED' };
    // P0: the Review is computed for the wallet the API will bind, so its Flight decision is the API's (a value, before any quote or simulation).
    const flight = await flightWalletRefusal(owner, env);
    if (flight) return { ok: false, code: flight };
    const host = await platformStateHost(env);
    if (!await fixedWindow(host.db, host.tenantId).allow(`editor-review:${session.accountId}`, REVIEW_LIMIT, REVIEW_WINDOW_SECONDS, new Date()))
      return { ok: false, code: 'EDITOR_REVIEW_RATE_LIMITED' };
    // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: ONE EVM card is reviewed as a run of that one step only where the database accepts such a run.
    const singleStep = singleEvmCard(workflow) && await singleStepRunsSupported(host.db).catch(() => false);
    if (singleCard(workflow) && !singleStep) return { ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' };
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
    return await reviewEditorExecution({ workflow, owner, profile: walletProfileOf(profile), facts: runtime.facts, deps: runtime.deps, now: new Date(), stepRefusal,
      singleStep });
  } catch (cause) { return failure(cause); }

  });
}

/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the Editor's own one-step run of ONE card, started only from the in-place Authorize below (never
 * exported as an action: "Run workflow" keeps handing off multi-step workflows only). The same requester, account session, deployment check and
 * approval service as `startEditorWorkflowRun`; the handoff is a SEQUENTIAL plan of that one step.
 */
async function startSingleCardRun(workflow: unknown): Promise<Result<EditorRunStarted>> {
  const env = process.env, config = readEditorRunConfig(env);
  if (!config.enabled) return { ok: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
  if ((await headers()).get('x-flofi-pathname') === EMBEDDED_APPROVAL_PATH) return { ok: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
  const accounts = await accountHost(env).catch(() => null), session = await currentAccountSession(accounts, env);
  if (!session) return { ok: false, code: 'ACCOUNT_SESSION_REQUIRED' };
  const host = await platformStateHost(env);
  return await startEditorRun({ config, origin: config.origin, handoffs: createPgHandoffStore(host.db, host.tenantId), allow: fixedWindow(host.db, host.tenantId).allow,
    runtime: deploymentEngineRuntime(env), now: new Date() }, session.accountId, workflow, { singleStepRun: true });
}
/** Withdraws this account's own Editor handoff only while no workflow run exists for it (`withdrawUnstartedHandoff`: a run keeps its handoff). */
async function revokeOwnHandoff(approvalId: string): Promise<void> {
  const env = process.env, accounts = await accountHost(env).catch(() => null), session = await currentAccountSession(accounts, env);
  if (!session) return;
  const host = await platformStateHost(env);
  await withdrawUnstartedHandoff({ handoffs: createPgHandoffStore(host.db, host.tenantId), runFor: id => createPgWorkflowRunStore(host.db, host.tenantId).byHandoff(id) },
    session.accountId, approvalId, new Date());
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
    // Only the reviewed EVM wallet is claimed (another proven EVM wallet of this browser never runs a workflow it did not review). KAN-20: a reviewed
    // Solana owner claims with exactly that proven Solana wallet only (SOLANA_WALLET_PROOF_REQUIRED otherwise: the Editor asks its sign-in once).
    const selected = reviewedWallets(await currentWalletPrincipals(), binding);
    if (!selected.ok) return { ok: false, code: selected.code };
    const wallets = selected.wallets, solanaOwner = binding.namespace === 'solana';
    // The workflow sent is the reviewed one before anything is created (no handoff or run for a workflow that changed since the Review).
    await prepareCatalogs(workflow);
    // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: ONE card runs as a workflow run of that one step only where the database accepts it (0032).
    const singleStep = singleEvmCard(workflow) && await singleStepRunsHere(process.env);
    if (singleCard(workflow) && !singleStep) return { ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' };
    const converted = editorWorkflowStrategy(workflow, { singleStep });
    if (!converted.ok || converted.workflowHash !== binding.workflowHash) return { ok: false, code: 'EDITOR_EXECUTION_PLAN_CHANGED' };
    // KAN-20: a Solana owner runs in place only a workflow of Solana Batch Payments on Solana mainnet (re-validated here from the canonical
    // composition, never from the browser's hint); nothing is created for anything else.
    if (solanaOwner) {
      const req = requirementOf(converted.composition);
      if (!req.ok || !solanaBatchOnly(converted.composition, req.value.steps)) return { ok: false, code: 'EDITOR_EXECUTION_PLAN_CHANGED' };
    }
    const started = singleStep ? await startSingleCardRun(workflow) : await startEditorWorkflowRun(workflow);
    if (!started.ok) return started;
    approvalId = started.value.approvalId;
    const secret = new URL(started.value.approvalUrl).hash.slice(1);
    const s = await surface();
    await claimApproval(s, secret, wallets, true);
    const proposal = await workflowRunUserFundedStart(s, approvalId, wallets, parsed);
    const run = proposal.view.workflowRun?.run;
    const first = run?.groups?.[0];
    // The Editor authorizes in place only a run whose first group is one wallet-grouped interaction; anything else is ended, never half-started.
    // A single card's run is one EVM group (its batch, or Circle's operation of the same calls) — nothing else is ever started for it.
    // KAN-20: a Solana Batch Payment's run is Solana sign-all groups only (each exactly one batch's legs, one atomic transaction).
    const grouped = solanaOwner ? ['SOLANA_SIGN_ALL'] : singleStep ? ['EVM_WALLET_BATCH', 'EVM_USER_OPERATION'] : ['EVM_WALLET_BATCH', 'EVM_USER_OPERATION', 'SOLANA_SIGN_ALL'];
    if (!run || run.mode !== 'USER_FUNDED' || !first || !grouped.includes(first.strategy) || singleStep && run.stepCount !== 1
      || solanaOwner && (run.groups ?? []).some(g => g.strategy !== 'SOLANA_SIGN_ALL'))
      throw new Error('EDITOR_EXECUTION_PLAN_CHANGED');
    // Exactly the reviewed workflow and plan: the same canonical workflow hash, the same groups (mechanism and steps) in the same order.
    if (!runMatchesBinding(run, binding)) throw new Error('EDITOR_EXECUTION_PLAN_CHANGED');
    // Review C4: the wallet kind this browser reported for the Review (FloFi Wallet, or none reported, is never handed a Circle permit).
    // Final review (P3): and only with the fee mechanism the Review showed for it — another one is refused before the group is stored, so the run
    // just started is ended below at once (never a fresh native batch that blocks ending it until it expires).
    const prepared = await workflowRunUserFundedPrepare(s, approvalId, wallets, 0, undefined, parsed.eip155?.wallet, binding.firstGroupGas);
    return { ok: true, value: { approvalId, proposal, prepared } };
  } catch (cause) {
    // Nothing was signed or sent: a started run that could not reach its wallet request is ended (it stays readable as ended).
    let ended = false;
    if (approvalId) { try { await workflowRunCancel(await surface(), approvalId, await currentWalletPrincipals()); ended = true; } catch { /* already ended or not created */ } }
    // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (security review): a run that could not be ended here keeps its handoff; only when NO run exists
    // for it (a refused claim, a run row the database refused) is the account's own handoff withdrawn, so it never lingers against the account's
    // pending limit. Nothing was signed or sent either way.
    if (approvalId && !ended) await revokeOwnHandoff(approvalId).catch(() => undefined);
    const refused = failure(cause);
    return ended && refused.code === 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED' ? { ok: false, code: 'EDITOR_MECHANISM_CHANGED_NOT_STARTED' } : refused;
  }

  });
}

/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (workflow review): what a single-card run proves about ONE Canvas card, read as its owner (the run's
 * own wallets, from this browser's sign-in), so a workflow that grew from that card never offers it again after a reload (`domain/sequence-restore.ts`,
 * kind `workflow-run`). Proven here, server-side: the run has exactly the card's steps (one; a lone Batch Payment's are its payments) and its
 * canonical hash is exactly this card's
 * (`editorWorkflowStrategy` single-step; the run's engine workflow carries no Canvas ids, so the card's ids are echoed only once it is proven).
 * Read-only: a status read, as the run's own poll does; nothing is resolved, prepared, signed or sent.
 */
export async function editorSingleRunRecord(approvalId: unknown, card: unknown): Promise<Result<SingleRunRecord>> {
  return withFlightOwner(async () => {
  try {
    if (typeof approvalId !== 'string' || !/^apr_[a-z2-7]{26}$/.test(approvalId)) return { ok: false, code: 'WORKFLOW_RUN_NOT_FOUND' };
    const jar = await cookies();
    const status = await workflowRunStatus(await approvalSurface(process.env, name => jar.get(name)?.value), approvalId, await currentWalletPrincipals());
    const run = status.view.workflowRun?.run;
    // Only a one-step run can be a single card's (checked before the caller's card is read at all) — or, BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001
    // (FE-BATCH-02), a lone Batch Payment card's run of its payments (`singleCardRunRecord` proves its exact step count and hash).
    if (!run || run.stepCount !== 1 && !loneBatchPayment(card)) return { ok: false, code: 'WORKFLOW_RUN_NOT_THIS_CARD' };
    await prepareCatalogs(card);
    const record = singleCardRunRecord(run, card);
    return record ? { ok: true, value: record } : { ok: false, code: 'WORKFLOW_RUN_NOT_THIS_CARD' };
  } catch (cause) { return failure(cause); }

  });
}
