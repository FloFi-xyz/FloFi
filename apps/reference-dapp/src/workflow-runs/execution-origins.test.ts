// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1/§8.2): the closed, server-derived context of a creating call — which page, which web
 * surface, which proven wallets — and the origin an Editor handoff's workflow run records (Web Chat only from a verified Chat initiation of the
 * creating request, Web Editor otherwise, never for another requester). Pure; nothing here reads a client label.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { workflowPlan } from '../mcp/execution.ts';
import type { HandoffRecord } from '../platform/handoff-store.ts';
import { EXECUTION_SURFACE_HEADER, ORIGIN_WALLETS_HEADER, originContextHeaders, originContextOf, originOfRequester, pageOfPath, WEB_ORIGINS,
  WEB_SURFACE_ORIGINS } from './execution-origins.ts';
import type { NewRun } from './pg-store.ts';
import { ensureForClaim, type WorkflowRunDeps } from './service.ts';

const EVM = '0x' + 'Ab'.repeat(20), SOL = 'So11111111111111111111111111111111111111112';

describe('creating-call context', () => {
  it('names the page from the proxy path only: the app page, the approval pages, nothing else', () => {
    for (const path of ['/app', '/app/', '/app/automations']) expect(pageOfPath(path)).toBe('APP');
    for (const path of ['/approve', '/mcp/approve']) expect(pageOfPath(path)).toBe('APPROVAL');
    for (const path of [null, undefined, '', '/', '/application', '/approve/x', '/mcp', '/apps', '/api/native-signing/x', '/admin']) expect(pageOfPath(path)).toBeNull();
  });

  it('round-trips through the BFF → API headers and accepts only closed values', () => {
    for (const surface of ['WEB_CHAT', 'WEB_EDITOR', 'WEB_APP'] as const) expect(originContextOf(originContextHeaders({ surface }))).toEqual({ surface });
    const approval = originContextHeaders({ surface: 'APPROVAL_PAGE', wallets: [{ namespace: 'eip155', address: EVM }, { namespace: 'solana', address: SOL }] });
    expect(approval).toEqual({ [EXECUTION_SURFACE_HEADER]: 'approval-page', [ORIGIN_WALLETS_HEADER]: `eip155:${EVM.toLowerCase()},solana:${SOL}` });
    expect(originContextOf(approval)).toEqual({ surface: 'APPROVAL_PAGE', wallets: [{ namespace: 'eip155', address: EVM.toLowerCase() }, { namespace: 'solana', address: SOL }] });
    // The legacy value a BFF of the previous build sends is still the combined FloFi Web (recorded as `web`).
    expect(originContextOf({ [EXECUTION_SURFACE_HEADER]: 'web-app' })).toEqual({ surface: 'WEB_APP' });
    // Anything else is no context (never an error, never a guess): an origin name, a raw label, a list, nothing.
    for (const value of ['web_chat', 'web-chat ', 'WEB_CHAT', 'chat', 'mcp_chatgpt', '', ['web-chat'], undefined])
      expect(originContextOf({ [EXECUTION_SURFACE_HEADER]: value }), String(value)).toBeNull();
    // Wallets travel only with the approval page, only in their exact form, at most two.
    expect(originContextHeaders({ surface: 'WEB_CHAT', wallets: [{ namespace: 'eip155', address: EVM }] })).toEqual({ [EXECUTION_SURFACE_HEADER]: 'web-chat' });
    expect(originContextOf({ [EXECUTION_SURFACE_HEADER]: 'approval-page', [ORIGIN_WALLETS_HEADER]: 'eip155:0x12,cosmos:abc' })).toEqual({ surface: 'APPROVAL_PAGE', wallets: [] });
    expect(originContextOf({ [EXECUTION_SURFACE_HEADER]: 'approval-page', [ORIGIN_WALLETS_HEADER]: `eip155:${EVM},eip155:${EVM},solana:${SOL}` }))
      .toEqual({ surface: 'APPROVAL_PAGE', wallets: [] });
    expect(originContextOf({ [EXECUTION_SURFACE_HEADER]: 'approval-page' })).toEqual({ surface: 'APPROVAL_PAGE', wallets: [] });
    expect(originContextHeaders(null)).toEqual({});
  });

  it('records Web Chat, Web Editor or the legacy combined web, each with its own evidence; an Editor handoff is Web Editor', () => {
    expect(WEB_SURFACE_ORIGINS).toEqual({ WEB_CHAT: { origin: 'web_chat', evidence: 'WEB_CHAT_INITIATION' },
      WEB_EDITOR: { origin: 'web_editor', evidence: 'WEB_EDITOR_SERVER_ACTION' }, WEB_APP: { origin: 'web', evidence: 'WEB_APP_SERVER_ACTION' } });
    expect([...WEB_ORIGINS].sort()).toEqual(['web', 'web_chat', 'web_editor']);
    expect(originOfRequester('EDITOR_SESSION', 'flofi-editor')).toBe('web_editor');
    expect(originOfRequester('MCP_ACCOUNT', 'https://chatgpt.com/oauth/abc123/client.json')).toBe('mcp_chatgpt');
    expect(originOfRequester('CHANNEL_CONVERSATION', 'telegram:123456789')).toBe('telegram');
  });
});

describe('the origin an Editor handoff\'s workflow run records', () => {
  const composed = composeWorkflow({ version: 2, steps: [
    { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 },
    { action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.004', slippageBps: 100 }] });
  if (!composed.ok) throw new Error(composed.code);
  const wallets = [{ namespace: 'eip155' as const, address: EVM.toLowerCase() }];
  const created = async (requesterKind: HandoffRecord['requesterKind'], clientId: string, editorInitiation?: 'WEB_CHAT' | 'WEB_EDITOR') => {
    let input: NewRun | null = null;
    const store = { create: async (run: NewRun) => { input = run; return { ...run, state: 'PENDING', mode: null } as never; } };
    const deps = { store, now: () => new Date('2026-11-28T12:00:00Z'), newId: () => 'wfr_' + 'a'.repeat(26), ...editorInitiation ? { editorInitiation } : {} } as unknown as WorkflowRunDeps;
    const handoff = { handoffId: 'apr_' + 'a'.repeat(26), requesterKind, requesterRef: 'ref', clientId, plan: workflowPlan(composed, { run: true }),
      workflowHash: composed.workflowHash, claimed: null, fundsClass: 'REAL_FUNDS' } as unknown as HandoffRecord;
    await ensureForClaim(deps, handoff, composed, wallets);
    const run = input as NewRun | null;
    return run ? { origin: run.origin, evidence: run.originEvidence ?? 'APPROVAL_REQUESTER' } : null;
  };

  it('is Web Chat only when the creating request carried a verified Chat initiation, Web Editor otherwise, never for another requester', async () => {
    expect(await created('EDITOR_SESSION', 'flofi-editor', 'WEB_CHAT')).toEqual({ origin: 'web_chat', evidence: 'WEB_CHAT_INITIATION' });
    expect(await created('EDITOR_SESSION', 'flofi-editor', 'WEB_EDITOR')).toEqual({ origin: 'web_editor', evidence: 'APPROVAL_REQUESTER' });
    expect(await created('EDITOR_SESSION', 'flofi-editor')).toEqual({ origin: 'web_editor', evidence: 'APPROVAL_REQUESTER' });
    // A verified Chat initiation never relabels a run another requester proposed (its approval is its origin).
    expect(await created('MCP_ACCOUNT', 'https://claude.ai/oauth/mcp-oauth-client-metadata', 'WEB_CHAT')).toEqual({ origin: 'mcp_claude', evidence: 'APPROVAL_REQUESTER' });
    expect(await created('CHANNEL_CONVERSATION', 'telegram:123456789', 'WEB_CHAT')).toEqual({ origin: 'telegram', evidence: 'APPROVAL_REQUESTER' });
  });
});
