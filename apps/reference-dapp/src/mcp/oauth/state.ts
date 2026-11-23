// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-002: the durable MCP state of one deployment (OAuth, approval handoffs, wallet links), all on its PostgreSQL and
 * tenant. One object per request; the pool comes from the shared durable platform state host.
 */
import { createPgWalletLinkStore, type WalletLinkStore } from '../handoff/links.ts';
import { createPgHandoffStore, type HandoffStore } from '../handoff/store.ts';
import { createPgOAuthStore } from './pg-store.ts';
import { mcpStateHost, type McpStateHost } from './runtime.ts';
import type { McpOAuthStore } from './store.ts';
import { createPgWorkflowRunStore, type WorkflowRunStore } from '../../workflow-runs/pg-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** BUILD-CHAT-E2E-001: `workflowRuns` holds the runs of multi-step approvals (read by `get_approval_status`). */
export type McpState = { readonly oauth: McpOAuthStore; readonly handoffs: HandoffStore; readonly links: WalletLinkStore; readonly workflowRuns: WorkflowRunStore };
export function stateOf(host: McpStateHost): McpState {
  return { oauth: createPgOAuthStore(host.db, host.tenantId), handoffs: createPgHandoffStore(host.db, host.tenantId), links: createPgWalletLinkStore(host.db, host.tenantId),
    workflowRuns: createPgWorkflowRunStore(host.db, host.tenantId) };
}
/** The deployment's state, or a thrown `MCP_OAUTH_STORE_UNAVAILABLE`. */
export async function mcpState(env: Env): Promise<McpState> { return stateOf(await mcpStateHost(env)); }
