// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the FloFi Editor on the ONE approval model (`src/platform`, migrations 0006, 0015 and 0021). A
 * multi-step workflow the owner built and simulated on the Canvas starts the SAME workflow run a chat, an MCP client or a channel starts: one
 * approval handoff with a SEQUENTIAL plan, claimed on `/approve`, where the existing run panel offers "Confirm each step" or "Authorize once".
 * The Editor is a first-class `EDITOR_SESSION` requester — never an owner, never authority — that brings only what the shared model asks:
 *
 *   requester     `{ kind: EDITOR_SESSION, ref: <account id>, context: {} }`: the verified FloFi account session of the request (sealed HttpOnly
 *                 cookie and an unrevoked server-side record), never an argument or an unauthenticated caller
 *   link scheme   `flofi_edhs_` + 256 bits, digested with the Editor's own key (HKDF of the deployment's session secret under its own label, the way
 *                 account sessions derive theirs); only the digest is stored and the secret travels only in the /approve URL fragment
 *   rules         15-minute window, at most 3 open requests and 20 per hour per account; a newer request for the same workflow supersedes the older
 *   policy        the Editor handoff policy (FLOFI_EDITOR_HANDOFF_*, the same rules and defaults as MCP's: on the public product every mainnet,
 *                 never a test network), re-checked at view, claim and every step of the run
 *   claim policy  only a wallet the requesting account holds may claim (its saved and sign-in wallets, read from the account store at the claim)
 *   /approve      the browser's own account session is the viewer requester, so status sharing defaults on for the owner who started it
 *
 * Enabled where workflow runs are (FLOFI_WORKFLOW_RUNS=enabled) unless FLOFI_EDITOR_WORKFLOW_RUNS=disabled; any malformed value disables it (fail
 * closed). Nothing here signs, submits or authorizes: the owner still proves the wallet, runs each step's fresh simulation and Strategy Manifest
 * Review, and signs with their own wallet (or authorizes once with their own passkey where this deployment offers it).
 */
import { hkdfSync } from 'node:crypto';
import { ACCOUNT_ID } from '../accounts/account-model.ts';
import { createAccountStore } from '../accounts/account-store.ts';
import { readHandoffPolicy } from '../mcp/execution.ts';
import { approvalLinkScheme, HANDOFF_SECONDS, requestApproval, type ApprovalContributor, type ApprovalDeps, type ApprovalLinkScheme, type ApprovalRequester, type ClaimPolicy,
  type HandoffPolicy, type HandoffRules, type RequesterScope, type WalletRef } from '../platform/index.ts';
import { publicOrigin } from '../server/deployment.ts';
import { walletSessionKey } from '../server/wallet-session.ts';
import { workflowRunsEnabled } from '../workflow-runs/service.ts';
import { EDITOR_LINK_PREFIX } from './link-format.ts';
import { editorWorkflowStrategy } from './workflow-strategy.ts';

type Env = Readonly<Record<string, string | undefined>>;
export { EDITOR_LINK_PREFIX };
export const EDITOR_CLIENT_ID = 'flofi-editor';
export const EDITOR_DISPLAY_NAME = 'FloFi Editor';
export const EDITOR_HANDOFF_RULES: HandoffRules = Object.freeze({ handoffSeconds: HANDOFF_SECONDS, maxPending: 3, rate: Object.freeze([20, 3_600] as const),
  supersedeSameWorkflow: true });

export type EditorRunConfig = { readonly enabled: true; readonly origin: string; readonly key: Buffer; readonly policy: Extract<HandoffPolicy, { ok: true }> }
  | { readonly enabled: false; readonly code: 'EDITOR_RUNS_NOT_ENABLED' | 'EDITOR_RUNS_CONFIGURATION_INVALID'; readonly reason?: string };
const invalid = (reason: string) => ({ enabled: false, code: 'EDITOR_RUNS_CONFIGURATION_INVALID', reason } as const);
/** The Editor's approval-link key: its own HKDF label of the deployment's session secret (never the session or account key itself). */
export const editorApprovalKey = (env: Env): Buffer => Buffer.from(hkdfSync('sha256', walletSessionKey(env), 'flofi', 'flofi/editor/approval-link/v1', 32));
/** The Editor handoff policy: MCP's rules and defaults under the Editor's own variables (the public product: every mainnet, no test network). */
export const editorHandoffPolicy = (env: Env): HandoffPolicy =>
  readHandoffPolicy({ ...env, FLOFI_MCP_HANDOFF_TEST_FUNDS: env.FLOFI_EDITOR_HANDOFF_TEST_FUNDS, FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: env.FLOFI_EDITOR_HANDOFF_MAINNET_NETWORKS });

/** Whether, and how, this deployment lets the Editor start workflow runs. */
export function readEditorRunConfig(env: Env): EditorRunConfig {
  const value = env.FLOFI_EDITOR_WORKFLOW_RUNS === undefined || env.FLOFI_EDITOR_WORKFLOW_RUNS === '' ? 'enabled' : env.FLOFI_EDITOR_WORKFLOW_RUNS;
  if (value !== 'enabled' && value !== 'disabled') return invalid('FLOFI_EDITOR_WORKFLOW_RUNS');
  if (value === 'disabled' || !workflowRunsEnabled(env)) return { enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
  // The requester is a FloFi account, which lives only in the deployment's PostgreSQL platform state.
  if (!env.DATABASE_URL) return { enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
  const origin = publicOrigin(env);
  if (!origin) return invalid('FLOFI_PUBLIC_ORIGIN');
  let key: Buffer;
  try { key = editorApprovalKey(env); } catch { return invalid('FLOFI_SESSION_SECRET'); }
  const policy = editorHandoffPolicy(env);
  if (!policy.ok) return invalid('FLOFI_EDITOR_HANDOFF_POLICY');
  return Object.freeze({ enabled: true, origin, key, policy });
}

export const editorApprovalScheme = (key: Buffer): ApprovalLinkScheme => approvalLinkScheme(EDITOR_LINK_PREFIX, key, ['EDITOR_SESSION']);
export const editorScope = (accountId: string): RequesterScope => ({ kind: 'EDITOR_SESSION', ref: accountId });
/** The requester of a run the signed-in account starts from its own Editor. */
export function editorRequester(accountId: string): ApprovalRequester {
  if (!ACCOUNT_ID.test(accountId)) throw new Error('ACCOUNT_SESSION_REQUIRED');
  return { kind: 'EDITOR_SESSION', ref: accountId, clientId: EDITOR_CLIENT_ID, displayName: EDITOR_DISPLAY_NAME, context: {} };
}
const sameWallet = (a: WalletRef, b: WalletRef) => a.namespace === b.namespace
  && (a.namespace === 'eip155' ? a.address.toLowerCase() === b.address.toLowerCase() : a.address === b.address);
/**
 * The Editor's claim rule: only a wallet the requesting account holds (read now, never cached) may claim its handoff. Any read failure refuses.
 */
export function editorClaimPolicy(walletsOf: (accountId: string) => Promise<readonly WalletRef[]>): ClaimPolicy {
  return async (handoff, wallet) => {
    if (handoff.requesterKind !== 'EDITOR_SESSION' || !ACCOUNT_ID.test(handoff.requesterRef)) return { ok: false, code: 'EDITOR_ACCOUNT_INVALID' };
    let held: readonly WalletRef[];
    try { held = await walletsOf(handoff.requesterRef); } catch { return { ok: false, code: 'ACCOUNTS_UNAVAILABLE' }; }
    return held.some(candidate => sameWallet(candidate, wallet)) ? { ok: true } : { ok: false, code: 'EDITOR_WALLET_NOT_IN_ACCOUNT' };
  };
}
/** The verified FloFi account of this request (its session cookie and server-side record), or null. Next.js request scope only. */
async function requestAccount(env: Env): Promise<string | null> {
  const { accountHost, currentAccountSession } = await import('../accounts/account-host.ts');
  const host = await accountHost(env).catch(() => null);
  return (await currentAccountSession(host, env))?.accountId ?? null;
}
export type EditorContributorSeams = { readonly config?: EditorRunConfig; readonly account?: () => Promise<string | null> };
/** The Editor's contribution to /approve, or null while Editor runs are not enabled on this deployment. */
export function editorApprovalContributor(env: Env, seams: EditorContributorSeams = {}): ApprovalContributor | null {
  const config = seams.config ?? readEditorRunConfig(env);
  if (!config.enabled) return null;
  const account = seams.account ?? (() => requestAccount(env));
  return host => {
    const store = createAccountStore(host.db, host.tenantId);
    return { scheme: editorApprovalScheme(config.key), profiles: { EDITOR_SESSION: { policy: config.policy,
      claimPolicy: editorClaimPolicy(accountId => store.walletAddresses(accountId)),
      viewerRequester: async () => { const accountId = await account().catch(() => null); return accountId ? editorScope(accountId) : null; } } } };
  };
}

export type EditorRunStarted = { readonly approvalId: string; readonly approvalUrl: string; readonly expiresAt: string; readonly stepCount: number;
  readonly walletNamespaces: readonly string[]; readonly authority: 'NONE' };
export type EditorRunResult = { readonly ok: true; readonly value: EditorRunStarted } | { readonly ok: false; readonly code: string; readonly step?: number };
/**
 * Starts the workflow run of the account's own Canvas workflow: the workflow is re-read into the canonical multi-step strategy server-side
 * (`editorWorkflowStrategy`: nothing the browser says about amounts or steps is trusted beyond the exact canonical IR it sent), then the shared
 * approval service re-composes it, re-evaluates every step's gates and review blockers, rate-limits and stores ONE PENDING handoff with the
 * SEQUENTIAL plan. Returns the approval link (authority NONE) for the owner's own browser to open; nothing is claimed, signed or submitted.
 */
export async function startEditorRun(deps: Omit<ApprovalDeps, 'policy' | 'rules' | 'scheme'> & { readonly config: Extract<EditorRunConfig, { enabled: true }> },
  accountId: string, workflow: unknown): Promise<EditorRunResult> {
  if (!ACCOUNT_ID.test(accountId)) return { ok: false, code: 'ACCOUNT_SESSION_REQUIRED' };
  const converted = editorWorkflowStrategy(workflow);
  if (!converted.ok) return converted;
  const result = await requestApproval({ ...deps, origin: deps.config.origin, scheme: editorApprovalScheme(deps.config.key), policy: deps.config.policy,
    rules: EDITOR_HANDOFF_RULES }, editorRequester(accountId), converted.strategy, converted.workflowHash);
  if (!result.ok) return { ok: false, code: result.code };
  const value = result.value;
  // Only a multi-step workflow is handed to the run; a one-step plan keeps its own per-flow execution path (never reached: 2..8 steps only).
  if (value.executionPlan !== 'SEQUENTIAL') return { ok: false, code: 'EDITOR_WORKFLOW_NOT_SEQUENCE' };
  return { ok: true, value: { approvalId: value.approvalId, approvalUrl: value.approvalUrl, expiresAt: value.expiresAt, stepCount: value.steps.length,
    walletNamespaces: value.walletNamespaces, authority: value.authority } };
}
