// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: the account-scoped MCP tools over the real gateway (no PostgreSQL, no network, no model):
 * get_account, get_portfolio and list_executions read ONLY the wallets the OAuth account linked on FloFi (never an address from the request,
 * never another account's); a failed read is INCOMPLETE, never empty or zero; list_approvals / cancel_approval act only on this account's own
 * approval requests, cancel only before the proposal is in the owner's signing flow, and never report a request as cancelled that is not.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WalletPortfolio } from '../domain/wallet-portfolio';
import type { PositionScan } from '../domain/defi-positions';
import type { HandoffRecord, HandoffStatus } from '../platform/handoff-store';
import type { McpWalletOwner } from './config';
import type { PortfolioReadPort } from './account';
import { session } from './gateway.test-harness';
import { credentialDigest, newCredential } from './oauth/crypto';
import { readOAuthConfig, type McpScope, type OAuthConfig } from './oauth/config';
import { oauthEnv } from './oauth/oauth-test-harness';
import type { McpState } from './oauth/state';
import type { McpRuntime } from './runtime';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), S = 'So11111111111111111111111111111111111111112';
// Links made at or after this instant were made under the Connections text that discloses balance and position reads.
const env = { FLOFI_MCP: 'enabled', ...oauthEnv(), FLOFI_MCP_PORTFOLIO_LINKS_FROM: '2026-01-01T00:00:00Z' };
const config = readOAuthConfig(env) as OAuthConfig;
const accounts = { X: 'mcpacct_' + 'x'.repeat(26), Y: 'mcpacct_' + 'y'.repeat(26), Z: 'mcpacct_' + 'z'.repeat(26), W: 'mcpacct_' + 'w'.repeat(26) };
const tokens = { X: newCredential('access'), Y: newCredential('access'), Z: newCredential('access'), W: newCredential('access') };
const links: Record<string, McpWalletOwner[]> = { [accounts.X]: [{ namespace: 'eip155', address: A }, { namespace: 'solana', address: S }],
  [accounts.Y]: [{ namespace: 'eip155', address: B }], [accounts.Z]: [],
  // An account with more linked wallets than one call reads.
  [accounts.W]: [1, 2, 3, 4, 5].map(i => ({ namespace: 'eip155' as const, address: '0x' + String(i).repeat(40) }))};
const apr = (c: string) => 'apr_' + c.repeat(26);

/** An in-memory handoff store with the requester scoping the PostgreSQL store enforces (another requester's id is not found). */
function handoffs(records: HandoffRecord[]) {
  const scoped = (id: string, requester: { kind: string; ref: string }) => records.find(h => h.handoffId === id && h.requesterKind === requester.kind && h.requesterRef === requester.ref) ?? null;
  return {
    records,
    forRequester: vi.fn(async (id: string, requester: { kind: string; ref: string }) => scoped(id, requester)),
    listForRequester: vi.fn(async (requester: { kind: string; ref: string }, _now: Date, limit: number) =>
      records.filter(h => h.requesterKind === requester.kind && h.requesterRef === requester.ref).slice(0, limit)),
    revokeForRequester: vi.fn(async (id: string, requester: { kind: string; ref: string }, now: Date) => {
      const index = records.findIndex(h => h.handoffId === id && h.requesterKind === requester.kind && h.requesterRef === requester.ref);
      if (index < 0) return null;
      const h = records[index]!;
      if (h.status !== 'PENDING' && h.status !== 'CLAIMED') return h;
      records[index] = { ...h, status: 'REVOKED', endedAt: now };
      return records[index]!;
    }),
  };
}
const handoff = (id: string, account: string, status: HandoffStatus, sequential = false): HandoffRecord => ({ handoffId: id, requesterKind: 'MCP_ACCOUNT', requesterRef: account, requesterContext: {},
  accountId: account, grantId: 'grt_x', clientId: 'https://claude.ai/client', clientName: 'Claude', strategy: {}, workflowHash: '0x' + '1'.repeat(64), engineVersion: 'v1',
  networkEnvironment: 'PUBLIC_MAINNET', fundsClass: 'REAL_FUNDS', plan: { kind: sequential ? 'SEQUENTIAL' : 'SINGLE', steps: [], networks: ['base'] } as unknown as HandoffRecord['plan'],
  status, claimed: status === 'PENDING' ? null : { namespace: 'eip155', address: A }, shareStatus: false, runIds: [], expiresAt: new Date(Date.now() + 600_000), claimExpiresAt: null, claimedAt: null, appliedAt: null, endedAt: null,
  createdAt: new Date('2026-11-24T10:00:00Z'), signingExpiresAt: null });

function state(store: ReturnType<typeof handoffs>, scopes: readonly McpScope[] = ['flofi.strategy', 'flofi.runs', 'flofi.approval'],
  options: { runs?: Record<string, unknown>; allow?: (bucket: string) => boolean } = {}) {
  return {
    oauth: { authenticate: async (digest: Buffer) => {
      const who = (Object.keys(tokens) as (keyof typeof tokens)[]).find(k => credentialDigest(config.keys.token, tokens[k]).equals(digest));
      return who ? { accountId: accounts[who], grantId: 'grt_' + who.toLowerCase().repeat(26), clientId: 'https://claude.ai/client', clientName: 'Claude', scopes,
        resource: config.resource, familyId: 'fam_' + 'a'.repeat(26), expiresAt: new Date(Date.now() + 3_600_000) } : null;
    }, allow: async (bucket: string) => options.allow?.(bucket) ?? true },
    links: { active: vi.fn(async (account: string) => (links[account] ?? []).map((l, i) => ({ linkId: `lnk_${i}`, ...l, createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }))) },
    handoffs: store, workflowRuns: { byHandoff: vi.fn(async (id: string) => options.runs?.[id] ?? null) },
  } as unknown as McpState;
}

const portfolioOf = (owner: McpWalletOwner): WalletPortfolio => ({ format: 'flofi.wallet-portfolio.v2', observedAt: '2026-11-24T10:00:00.000Z',
  accounts: [{ ecosystem: owner.namespace === 'eip155' ? 'evm' : 'solana', address: owner.address }],
  networks: [{ id: owner.namespace === 'eip155' ? 'base' : 'solana', name: 'Base', chain: 'eip155:8453', chainId: 8453, ecosystem: 'evm', status: 'READ', provenance: 'PUBLIC_MAINNET',
    observedAt: '2026-11-24T10:00:00.000Z', block: '1', slot: null, tokens: 'ALL', uncheckedTokens: 0, code: null },
  { id: 'arbitrum-one', name: 'Arbitrum One', chain: 'eip155:42161', chainId: 42161, ecosystem: 'evm', status: 'UNAVAILABLE', provenance: null, observedAt: null, block: null, slot: null,
    tokens: null, uncheckedTokens: 0, code: 'PORTFOLIO_RPC_UNAVAILABLE' }],
  holdings: [{ networkId: 'base', network: 'Base', chain: 'eip155:8453', symbol: 'USDC', name: 'USD Coin', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6,
    units: '1500000', displayUnits: '1500000', displayBasis: 'RAW', unavailableCode: null, native: false, provenance: 'PUBLIC_MAINNET', price: null, valueUsd: '1.50', logo: null }],
  pricedTotalUsd: '1.50', unpricedCount: 0, unlisted: 0, priceSource: 'CHAINLINK', testData: false } as unknown as WalletPortfolio);
const SCAN: PositionScan = { protocol: 'Aave V3', network: 'base', chain: 'eip155:8453', status: 'COMPLETE', observedAt: '2026-11-24T10:00:00.000Z', provenance: 'PUBLIC_MAINNET',
  positions: [{ id: 'aave-usdc', type: 'SUPPLIED', collateralEnabled: true, assets: [{ address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, units: '2000000',
    valuation: { usd: '2.00', observedAt: '2026-11-24T10:00:00.000Z', expiresAt: '2026-11-24T10:05:00.000Z' } }] }],
  risk: { healthFactor: '3.1', liquidationThresholdBps: '7800' } };
function port(fail: Record<string, string> = {}) {
  const calls: string[] = [];
  const p: PortfolioReadPort = {
    balances: async owner => { calls.push(`balances:${owner.namespace}:${owner.address}`); if (fail[owner.address]) throw new Error(fail[owner.address]); return portfolioOf(owner); },
    positions: async owner => { calls.push(`positions:${owner.namespace}:${owner.address}`); return [SCAN]; },
  };
  return { port: p, calls };
}
const runtime = (pages: Record<string, unknown>): McpRuntime => ({ kind: 'remote', mode: async () => 'live', preview: async () => ({ ok: false, code: 'X' }),
  run: async () => ({ ok: true, value: null }), journal: async () => ({ ok: true, value: null }), evidence: async () => ({ ok: true, value: null }),
  history: async owner => owner in pages ? pages[owner] as never : { ok: false, code: 'CLOUD_API_UNAVAILABLE' } });

describe('BUILD-FLOFI-UNIVERSAL-CHANNELS-001 account tools', () => {
  it('get_account: identity is the proven wallet links only, with the Connections link; no internal account id', async () => {
    const out = (await session({ env, token: tokens.X, state: state(handoffs([])) }).callTool('get_account', {})).output;
    expect(out).toMatchObject({ ok: true, authenticated: true, kind: 'FLOFI_ACCOUNT_VIA_OAUTH', client: 'Claude', walletCount: 2,
      wallets: [{ namespace: 'eip155', address: A }, { namespace: 'solana', address: S }], linkWallet: { url: `${config.origin}/connections` }, authority: expect.stringMatching(/^NONE/) });
    expect(JSON.stringify(out)).not.toContain(accounts.X);
    const none = (await session({ env, token: tokens.Z, state: state(handoffs([])) }).callTool('get_account', {})).output;
    expect(none).toMatchObject({ ok: true, walletCount: 0, wallets: [], nextSteps: [expect.stringMatching(/No wallet is linked/)] });
  });

  it('get_portfolio reads exactly the linked wallets; an unread network is UNAVAILABLE, a failed wallet INCOMPLETE, never zero', async () => {
    const { port: p, calls } = port({ [S]: 'PORTFOLIO_SOLANA_ADDRESS_INVALID' });
    const out = (await session({ env, token: tokens.X, state: state(handoffs([])), portfolio: p }).callTool('get_portfolio', {})).output as Record<string, unknown>;
    // Positions are read one wallet after another, and not for a wallet whose balances could not be read.
    expect(calls.sort()).toEqual([`balances:eip155:${A}`, `balances:solana:${S}`, `positions:eip155:${A}`].sort());
    expect(out).toMatchObject({ ok: true, readOnly: true, complete: false, note: expect.stringMatching(/UNKNOWN \(not zero\)/) });
    const [evm, sol] = out.wallets as Record<string, unknown>[];
    expect(evm).toMatchObject({ read: true, wallet: { address: A }, pricedTotalUsd: '1.50', holdings: [{ symbol: 'USDC', units: '1500000', valueUsd: '1.50' }],
      networks: expect.arrayContaining([expect.objectContaining({ id: 'arbitrum-one', status: 'UNAVAILABLE' })]),
      positions: [{ protocol: 'Aave V3', count: 1, risk: { healthFactor: '3.1' }, positions: [{ type: 'SUPPLIED', assets: [{ symbol: 'USDC', valueUsd: '2.00' }] }] }] });
    expect(sol).toEqual({ read: false, wallet: { namespace: 'solana', address: S }, code: 'PORTFOLIO_SOLANA_ADDRESS_INVALID' });
    // Another account reads only its own wallet; an account with no link gets the link instruction, and nothing is read.
    const y = port();
    await session({ env, token: tokens.Y, state: state(handoffs([])), portfolio: y.port }).callTool('get_portfolio', { positions: false });
    expect(y.calls).toEqual([`balances:eip155:${B}`]);
    const z = port(), refused = await session({ env, token: tokens.Z, state: state(handoffs([])), portfolio: z.port }).callTool('get_portfolio', {});
    expect(refused.output).toMatchObject({ ok: false, code: 'MCP_WALLET_LINK_REQUIRED', linkWalletUrl: `${config.origin}/connections` });
    expect(refused.texts.at(-1)).toMatch(/^userMessage \(EN\): Link your wallet to FloFi first[\s\S]*userMessage \(PT\): Vincule/);
    expect(z.calls).toEqual([]);
  });

  it('wallets beyond the per-call cap are reported omitted, never a complete answer; portfolio reads have an hourly account budget', async () => {
    const { port: p, calls } = port();
    const out = (await session({ env, token: tokens.W, state: state(handoffs([])), portfolio: p }).callTool('get_portfolio', { positions: false })).output;
    expect(out).toMatchObject({ ok: true, complete: false, walletsOmitted: 1 });
    expect(calls).toHaveLength(4);
    const pages = Object.fromEntries([1, 2, 3, 4].map(i => ['0x' + String(i).repeat(40), { ok: true, value: { next: null, items: [] } }]));
    expect((await session({ env, token: tokens.W, state: state(handoffs([])), runtime: runtime(pages) }).callTool('list_executions', {})).output)
      .toMatchObject({ ok: true, complete: false, walletsOmitted: 1 });
    const limited = await session({ env, token: tokens.X, state: state(handoffs([]), undefined, { allow: bucket => !bucket.startsWith('portfolio:') }), portfolio: port().port })
      .callTool('get_portfolio', {});
    expect(limited.output).toEqual({ ok: false, code: 'PORTFOLIO_RATE_LIMITED' });
  });

  it('list_executions never presents a summary it cannot tell apart from an in-flight request as waiting for the wallet', async () => {
    const pages = { [A]: { ok: true, value: { next: null, items: [
      { runId: 'run-x', flow: 'base-swap', status: 'AUTHORIZED', ownerAccount: A, hasEvidence: false, updatedAt: '2026-11-24T09:00:00.000Z', errorCode: 'PAYMENT_WALLET_RESULT_UNKNOWN' },
      { runId: 'run-y', flow: 'base-swap', status: 'SIMULATED', ownerAccount: A, hasEvidence: false, updatedAt: '2026-11-24T08:00:00.000Z' }] } },
      [S]: { ok: true, value: { next: null, items: [] } } };
    const out = (await session({ env, token: tokens.X, state: state(handoffs([])), runtime: runtime(pages) }).callTool('list_executions', {})).output as { items: Record<string, unknown>[] };
    for (const item of out.items) expect((item.conversationState as { state: string }).state, String(item.executionId)).not.toBe('AWAITING_SIGNATURE');
  });

  it('balances and positions are read only for links made after the Connections page disclosed them (fail closed when unconfigured)', async () => {
    for (const cutoff of [undefined, 'not-a-date', '2999-01-01T00:00:00Z']) {
      const { port: p, calls } = port(), configured = { ...env, FLOFI_MCP_PORTFOLIO_LINKS_FROM: cutoff as unknown as string };
      if (cutoff === undefined) delete (configured as Record<string, unknown>).FLOFI_MCP_PORTFOLIO_LINKS_FROM;
      const client = session({ env: configured, token: tokens.X, state: state(handoffs([])), portfolio: p });
      expect((await client.callTool('get_portfolio', {})).output, String(cutoff)).toMatchObject({ ok: false, code: 'PORTFOLIO_RELINK_REQUIRED',
        linkWalletUrl: `${config.origin}/connections` });
      expect(calls, String(cutoff)).toEqual([]);
      expect(((await client.callTool('get_account', {})).output.wallets as { balancesReadable: boolean }[]).map(w => w.balancesReadable)).toEqual([false, false]);
    }
    const account = (await session({ env, token: tokens.X, state: state(handoffs([])) }).callTool('get_account', {})).output;
    expect((account.wallets as { balancesReadable: boolean }[]).map(w => w.balancesReadable)).toEqual([true, true]);
  });

  it('get_portfolio and list_executions accept no wallet or address argument', async () => {
    const client = session({ env, token: tokens.X, state: state(handoffs([])), portfolio: port().port });
    for (const [tool, args] of [['get_portfolio', { wallet: B }], ['list_executions', { wallet: B }], ['list_executions', { owner: B }]] as const) {
      const message = await client.request('tools/call', { name: tool, arguments: args });
      const result = message.result as { isError?: boolean } | undefined;
      expect(result?.isError ?? Boolean(message.error), `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it('list_executions: newest first across linked wallets with lifecycle; a failed wallet makes it INCOMPLETE; no history read is unavailable, never empty', async () => {
    const pages = { [A]: { ok: true, value: { next: 'c1', items: [
      { runId: 'run-a1', flow: 'base-swap', status: 'RECONCILED', ownerAccount: A, hasEvidence: true, updatedAt: '2026-11-24T09:00:00.000Z' },
      { runId: 'run-a2', flow: 'across-bridge', status: 'SOURCE_CONFIRMED', ownerAccount: A, hasEvidence: false, updatedAt: '2026-11-24T11:00:00.000Z' }] } } };
    const out = (await session({ env, token: tokens.X, state: state(handoffs([])), runtime: runtime(pages) }).callTool('list_executions', {})).output as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, available: true, complete: false, unreadWallets: [expect.any(String)], olderRuns: expect.any(String) });
    expect((out.items as Record<string, unknown>[]).map(i => [i.executionId, (i.conversationState as { state: string }).state])).toEqual([
      ['run-a2', 'PENDING_CONFIRMATION'], ['run-a1', 'CONFIRMED']]);
    const local: McpRuntime = { ...runtime(pages) };
    delete (local as { history?: unknown }).history;
    expect((await session({ env, token: tokens.X, state: state(handoffs([])), runtime: local }).callTool('list_executions', {})).output)
      .toEqual({ ok: false, code: 'HISTORY_NOT_AVAILABLE' });
  });
});

describe('BUILD-FLOFI-UNIVERSAL-CHANNELS-001 approval requests', () => {
  it('list_approvals: only this account\'s requests, each with its conversational state; an APPLIED one defers to get_approval_status', async () => {
    const store = handoffs([handoff(apr('a'), accounts.X, 'PENDING'), handoff(apr('b'), accounts.X, 'APPLIED'), handoff(apr('c'), accounts.X, 'SUPERSEDED'),
      handoff(apr('d'), accounts.Y, 'PENDING')]);
    const out = (await session({ env, token: tokens.X, state: state(store) }).callTool('list_approvals', {})).output as { approvals: Record<string, unknown>[] };
    expect(out.approvals.map(a => [a.approvalId, a.status, (a.conversationState as { state: string }).state])).toEqual([
      [apr('a'), 'PENDING', 'AWAITING_WALLET_CONNECTION'], [apr('b'), 'APPLIED', 'STATUS_UNKNOWN'], [apr('c'), 'SUPERSEDED', 'CANCELLED']]);
    expect(JSON.stringify(out)).not.toContain(accounts.X);
  });

  it('cancel_approval withdraws a PENDING request; APPLIED is refused; ended is reported as it is; another account\'s id is not found', async () => {
    const store = handoffs([handoff(apr('a'), accounts.X, 'PENDING'), handoff(apr('b'), accounts.X, 'APPLIED'), handoff(apr('c'), accounts.X, 'EXPIRED'),
      handoff(apr('d'), accounts.Y, 'PENDING')]);
    const x = session({ env, token: tokens.X, state: state(store) });
    expect((await x.callTool('cancel_approval', { approvalId: apr('a') })).output).toMatchObject({ ok: true, cancelled: true, status: 'REVOKED',
      conversationState: { state: 'CANCELLED', reason: 'WITHDRAWN', final: true } });
    expect(store.records.find(h => h.handoffId === apr('a'))!.status).toBe('REVOKED');
    // Idempotent: cancelling again reports the ended request, never "cancelled" twice.
    expect((await x.callTool('cancel_approval', { approvalId: apr('a') })).output).toMatchObject({ ok: true, cancelled: false, alreadyEnded: true });
    const applied = await x.callTool('cancel_approval', { approvalId: apr('b') });
    expect(applied.output).toMatchObject({ ok: false, code: 'APPROVAL_NOT_CANCELLABLE', status: 'APPLIED' });
    expect(applied.texts.at(-1)).toMatch(/can no longer be cancelled/);
    expect(store.records.find(h => h.handoffId === apr('b'))!.status).toBe('APPLIED');
    expect((await x.callTool('cancel_approval', { approvalId: apr('c') })).output).toMatchObject({ ok: true, cancelled: false, conversationState: { state: 'EXPIRED' } });
    expect((await x.callTool('cancel_approval', { approvalId: apr('d') })).output).toEqual({ ok: false, code: 'APPROVAL_NOT_FOUND' });
    expect(store.records.find(h => h.handoffId === apr('d'))!.status).toBe('PENDING');
  });

  it('a request applied between the read and the cancel is reported as it is, never as cancelled', async () => {
    const store = handoffs([handoff(apr('a'), accounts.X, 'PENDING')]);
    store.revokeForRequester.mockImplementationOnce(async () => ({ ...store.records[0]!, status: 'APPLIED' as const }));
    expect((await session({ env, token: tokens.X, state: state(store) }).callTool('cancel_approval', { approvalId: apr('a') })).output)
      .toMatchObject({ ok: true, cancelled: false, status: 'APPLIED', conversationState: { state: 'STATUS_UNKNOWN' } });
  });

  it('a multi-step request whose run started at the claim is never cancellable here and never listed as awaiting, expired or cancelled', async () => {
    const store = handoffs([handoff(apr('a'), accounts.X, 'CLAIMED', true), handoff(apr('b'), accounts.X, 'EXPIRED', true), handoff(apr('c'), accounts.X, 'PENDING', true)]);
    const x = session({ env, token: tokens.X, state: state(store, undefined, { runs: { [apr('a')]: { runId: 'wfr_a' }, [apr('b')]: { runId: 'wfr_b' } } }) });
    const listed = (await x.callTool('list_approvals', {})).output as { approvals: { approvalId: string; conversationState: { state: string } }[] };
    expect(listed.approvals.map(a => [a.approvalId, a.conversationState.state])).toEqual([[apr('a'), 'STATUS_UNKNOWN'], [apr('b'), 'STATUS_UNKNOWN'],
      [apr('c'), 'AWAITING_WALLET_CONNECTION']]);
    const refused = await x.callTool('cancel_approval', { approvalId: apr('a') });
    expect(refused.output).toMatchObject({ ok: false, code: 'APPROVAL_NOT_CANCELLABLE', reason: 'WORKFLOW_RUN_STARTED' });
    expect(store.records.find(h => h.handoffId === apr('a'))!.status).toBe('CLAIMED');
    // Not claimed yet: nothing could have been signed, so it is cancellable.
    expect((await x.callTool('cancel_approval', { approvalId: apr('c') })).output).toMatchObject({ ok: true, cancelled: true });
  });

  it('a multi-step claim that lands between the read and the cancel is reported as it is, never as cancelled', async () => {
    const store = handoffs([handoff(apr('a'), accounts.X, 'PENDING', true)]);
    const runs: Record<string, unknown> = {};
    // The store's locked row shows the claim (its run is created right after it commits).
    store.revokeForRequester.mockImplementationOnce(async () => ({ ...store.records[0]!, claimed: { namespace: 'eip155' as const, address: A }, status: 'REVOKED' as const }));
    expect((await session({ env, token: tokens.X, state: state(store, undefined, { runs }) }).callTool('cancel_approval', { approvalId: apr('a') })).output)
      .toMatchObject({ ok: true, cancelled: false, conversationState: { state: 'STATUS_UNKNOWN' } });
  });

  it('the account tools need the scopes they declare (no approval scope: no approval tools)', async () => {
    const client = session({ env, token: tokens.X, state: state(handoffs([]), ['flofi.strategy', 'flofi.runs']) });
    const listed = ((await client.request('tools/list')).result as { tools: { name: string }[] }).tools.map(t => t.name);
    expect(listed).toEqual(expect.arrayContaining(['get_account', 'get_portfolio', 'list_executions', 'list_approvals', 'cancel_approval']));
    const call = await client.post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cancel_approval', arguments: { approvalId: apr('a') } } },
      { 'mcp-protocol-version': '2025-11-25' });
    expect(call.status).toBe(403);
  });
});
