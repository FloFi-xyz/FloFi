// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the Editor's "Run workflow" — a multi-step workflow the owner built and simulated on the Canvas
 * starts the SAME workflow run chats, MCP clients and channels start, without rebuilding it elsewhere (`src/editor/approval.ts`).
 *
 * The requester is the verified FloFi account session of this request (sealed HttpOnly cookie + unrevoked server-side record), never an argument;
 * without one nothing is created (ACCOUNT_SESSION_REQUIRED). The Canvas workflow is only the canonical IR the owner authored: the server re-reads
 * it into the canonical strategy, requires every composed step to reproduce its Canvas node exactly, re-composes it in the shared approval
 * service, re-evaluates every step's gates and review blockers and rate-limits it. The result is ONE pending approval (authority NONE) whose link
 * the browser opens: `/approve`, where the owner proves the wallet and chooses "Confirm each step" or "Authorize once". Nothing here claims,
 * simulates, signs or submits anything.
 */
import { headers } from 'next/headers';
import { accountHost, currentAccountSession } from '../accounts/account-host';
import { readEditorRunConfig, startEditorRun, type EditorRunStarted } from '../editor/approval';
import { NETWORK_CHAINS } from '../engine/capability-catalog';
import { NETWORK_IDS } from '../engine/strategy-spec';
import { prepareNetworkCatalogs } from '../platform/catalogs';
import { createPgHandoffStore, deploymentEngineRuntime, fixedWindow } from '../platform/index';
import { arbitrumAuthoringCatalog } from '../server/arbitrum-mainnet';
import { baseAuthoringCatalog } from '../server/base-mainnet';
import { EMBEDDED_APPROVAL_PATH } from '../server/embedded-approval';
import { ethereumAuthoringCatalog } from '../server/ethereum-mainnet';
import { platformStateHost } from '../server/platform-state-host';
import { robinhoodAuthoringCatalog } from '../server/robinhood-mainnet';
import { solanaAuthoringCatalog } from '../server/solana-asset-catalog';

type Result<T> = { ok: true; value: T } | { ok: false; code: string; step?: number };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown, fallback = 'EDITOR_RUN_FAILED'): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });

/** Whether this deployment lets the Editor start workflow runs (no account needed: it reveals nothing about anyone). */
export async function editorWorkflowRunAvailability(): Promise<{ readonly enabled: boolean }> {
  return { enabled: readEditorRunConfig(process.env).enabled };
}

/** Registers the official catalogs of the networks the workflow's nodes use, so a listed token resolves exactly as it did on the Canvas. */
async function prepareCatalogs(workflow: unknown): Promise<void> {
  const nodes = workflow && typeof workflow === 'object' && Array.isArray((workflow as { nodes?: unknown }).nodes) ? (workflow as { nodes: unknown[] }).nodes : [];
  const chains = new Set(nodes.slice(0, 64).flatMap(node => node && typeof node === 'object' && typeof (node as { chainId?: unknown }).chainId === 'string'
    ? [(node as { chainId: string }).chainId] : []));
  const networks = NETWORK_IDS.filter(id => chains.has(NETWORK_CHAINS[id]));
  if (!networks.length) return;
  const env = process.env;
  await prepareNetworkCatalogs({ version: 2, steps: networks.map(network => ({ network })) }, { solana: () => solanaAuthoringCatalog(env),
    ethereum: () => ethereumAuthoringCatalog(null, env), robinhood: () => robinhoodAuthoringCatalog(null, env), base: () => baseAuthoringCatalog(null, env),
    'arbitrum-one': () => arbitrumAuthoringCatalog(null, env) });
}

/**
 * Starts the workflow run of this account's own multi-step Canvas workflow and returns its approval link (authority NONE). Refusals are closed
 * codes: EDITOR_RUNS_NOT_ENABLED, ACCOUNT_SESSION_REQUIRED, EDITOR_WORKFLOW_* (with the 0-based `step` that could not be represented exactly),
 * the composition's and gates' own codes, REVIEW_BLOCKED, HANDOFF_RATE_LIMITED, HANDOFF_PENDING_LIMIT.
 */
export async function startEditorWorkflowRun(workflow: unknown): Promise<Result<EditorRunStarted>> {
  try {
    const env = process.env, config = readEditorRunConfig(env);
    if (!config.enabled) return { ok: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
    // The embedded approval route's wallet authority stays isolated from the account (as for history principals).
    if ((await headers()).get('x-flofi-pathname') === EMBEDDED_APPROVAL_PATH) return { ok: false, code: 'EDITOR_RUNS_NOT_ENABLED' };
    const accounts = await accountHost(env).catch(() => null), session = await currentAccountSession(accounts, env);
    if (!session) return { ok: false, code: 'ACCOUNT_SESSION_REQUIRED' };
    await prepareCatalogs(workflow);
    const host = await platformStateHost(env);
    return await startEditorRun({ config, origin: config.origin, handoffs: createPgHandoffStore(host.db, host.tenantId), allow: fixedWindow(host.db, host.tenantId).allow,
      runtime: deploymentEngineRuntime(env), now: new Date() }, session.accountId, workflow);
  } catch (cause) { return failure(cause); }
}
