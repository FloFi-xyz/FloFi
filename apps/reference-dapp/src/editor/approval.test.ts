// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the Editor as a requester kind of the ONE approval model — its configuration (fail closed), link
 * scheme, requester, claim rule and /approve profile, and the abuse-limit bucket it is rate-limited under. No database: the PostgreSQL behaviour is
 * proven by `editor-run.pg.test.ts` and the migration suites.
 */
import { hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { APPROVAL_REQUESTER_KINDS, approvalLinkScheme, assembleApprovalSurface, HANDOFF_SECONDS, mintApprovalSecret, requestApproval, resolveApprovalSecret,
  type ApprovalContribution, type HandoffRecord, type HandoffStore, type WalletRef } from '../platform/index.ts';
import { composeWorkflowBound } from '../engine/strategy-engine';
import { walletSessionKey } from '../server/wallet-session.ts';
import { EDITOR_CLIENT_ID, EDITOR_DISPLAY_NAME, EDITOR_HANDOFF_RULES, EDITOR_LINK_PREFIX, editorApprovalContributor, editorApprovalKey, editorApprovalScheme, editorClaimPolicy,
  editorRequester, editorScope, readEditorRunConfig } from './approval.ts';

const SECRET = 'e'.repeat(64), ACCOUNT = 'acct_' + 'a'.repeat(32);
const ENABLED = { FLOFI_WORKFLOW_RUNS: 'enabled', DATABASE_URL: 'postgres://flofi@127.0.0.1:5432/x', FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3108', FLOFI_SESSION_SECRET: SECRET };
const evm = (address: string): WalletRef => ({ namespace: 'eip155', address });
const handoffOf = (overrides: Partial<HandoffRecord> = {}) => ({ requesterKind: 'EDITOR_SESSION', requesterRef: ACCOUNT, ...overrides }) as HandoffRecord;

describe('BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 Editor requester kind', () => {
  it('is one of the shared requester kinds, with its own link scheme that resolves Editor handoffs only', () => {
    expect(APPROVAL_REQUESTER_KINDS).toContain('EDITOR_SESSION');
    const scheme = editorApprovalScheme(randomBytes(32));
    expect(scheme).toMatchObject({ prefix: EDITOR_LINK_PREFIX, kinds: ['EDITOR_SESSION'] });
    expect(EDITOR_LINK_PREFIX).toBe('flofi_edhs_');
    const { secret, digest } = mintApprovalSecret(scheme), other = approvalLinkScheme('flofi_chs_', randomBytes(32), ['CHANNEL_CONVERSATION']);
    expect(resolveApprovalSecret([other, scheme], secret)).toEqual({ digest, kinds: ['EDITOR_SESSION'] });
    expect(resolveApprovalSecret([other], secret)).toBeNull();
    // A scheme may never resolve the Editor's kind together with another kind, nor an unknown kind.
    expect(() => approvalLinkScheme('flofi_edhs_', randomBytes(32), ['EDITOR' as never])).toThrow('APPROVAL_SCHEME_INVALID');
  });

  it('is off unless workflow runs are enabled, needs the account database, a public origin and a session secret, and fails closed on any malformed value', () => {
    expect(readEditorRunConfig({})).toEqual({ enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_WORKFLOW_RUNS: undefined })).toEqual({ enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_EDITOR_WORKFLOW_RUNS: 'disabled' })).toEqual({ enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED' });
    expect(readEditorRunConfig({ ...ENABLED, DATABASE_URL: undefined })).toEqual({ enabled: false, code: 'EDITOR_RUNS_NOT_ENABLED' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_EDITOR_WORKFLOW_RUNS: 'yes' })).toMatchObject({ enabled: false, code: 'EDITOR_RUNS_CONFIGURATION_INVALID' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_PUBLIC_ORIGIN: 'not a url' })).toMatchObject({ enabled: false, reason: 'FLOFI_PUBLIC_ORIGIN' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_SESSION_SECRET: 'short' })).toMatchObject({ enabled: false, reason: 'FLOFI_SESSION_SECRET' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_EDITOR_HANDOFF_MAINNET_NETWORKS: 'base-sepolia' })).toMatchObject({ enabled: false, reason: 'FLOFI_EDITOR_HANDOFF_POLICY' });
    expect(readEditorRunConfig({ ...ENABLED, FLOFI_EDITOR_HANDOFF_TEST_FUNDS: 'maybe' })).toMatchObject({ enabled: false, reason: 'FLOFI_EDITOR_HANDOFF_POLICY' });
    const config = readEditorRunConfig({ ...ENABLED, FLOFI_EDITOR_WORKFLOW_RUNS: 'enabled', FLOFI_EDITOR_HANDOFF_MAINNET_NETWORKS: 'base,arbitrum-one' });
    expect(config).toMatchObject({ enabled: true, origin: 'http://127.0.0.1:3108', policy: { ok: true, mainnetNetworks: ['base', 'arbitrum-one'] } });
  });

  it('derives its link key under its own label: never the session, account or another surface key', () => {
    const key = editorApprovalKey(ENABLED);
    expect(key).toHaveLength(32);
    expect(key.equals(editorApprovalKey(ENABLED))).toBe(true);
    expect(key.equals(walletSessionKey(ENABLED))).toBe(false);
    expect(key.equals(Buffer.from(hkdfSync('sha256', walletSessionKey(ENABLED), 'flofi', 'flofi/account-session/v1', 32)))).toBe(false);
    expect(key.equals(editorApprovalKey({ ...ENABLED, FLOFI_SESSION_SECRET: 'f'.repeat(64) }))).toBe(false);
  });

  it('names the signed-in account as the requester, never anything else', () => {
    expect(editorRequester(ACCOUNT)).toEqual({ kind: 'EDITOR_SESSION', ref: ACCOUNT, clientId: EDITOR_CLIENT_ID, displayName: EDITOR_DISPLAY_NAME, context: {} });
    expect(editorScope(ACCOUNT)).toEqual({ kind: 'EDITOR_SESSION', ref: ACCOUNT });
    for (const bad of ['', 'acct_short', ACCOUNT.toUpperCase(), '0x' + 'a'.repeat(40), `${ACCOUNT};drop`]) expect(() => editorRequester(bad)).toThrow('ACCOUNT_SESSION_REQUIRED');
    expect(EDITOR_HANDOFF_RULES).toEqual({ handoffSeconds: HANDOFF_SECONDS, maxPending: 3, rate: [20, 3_600], supersedeSameWorkflow: true });
  });

  it('lets only a wallet the requesting account holds claim, read at the claim; any failure refuses', async () => {
    const held = [evm('0x' + 'ab'.repeat(20)), { namespace: 'solana' as const, address: 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH' }];
    const asked: string[] = [];
    const policy = editorClaimPolicy(async accountId => { asked.push(accountId); return accountId === ACCOUNT ? held : []; });
    expect(await policy(handoffOf(), evm('0x' + 'ab'.repeat(20)))).toEqual({ ok: true });
    expect(await policy(handoffOf(), evm('0x' + 'AB'.repeat(20)))).toEqual({ ok: true });
    expect(await policy(handoffOf(), held[1]!)).toEqual({ ok: true });
    expect(await policy(handoffOf(), { namespace: 'solana', address: held[1]!.address.toLowerCase() })).toEqual({ ok: false, code: 'EDITOR_WALLET_NOT_IN_ACCOUNT' });
    expect(await policy(handoffOf(), evm('0x' + 'cd'.repeat(20)))).toEqual({ ok: false, code: 'EDITOR_WALLET_NOT_IN_ACCOUNT' });
    expect(await policy(handoffOf({ requesterRef: 'acct_' + 'b'.repeat(32) }), evm('0x' + 'ab'.repeat(20)))).toEqual({ ok: false, code: 'EDITOR_WALLET_NOT_IN_ACCOUNT' });
    expect(asked).toEqual([ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT, 'acct_' + 'b'.repeat(32)]);
    expect(await policy(handoffOf({ requesterKind: 'CHANNEL_CONVERSATION' }), evm('0x' + 'ab'.repeat(20)))).toEqual({ ok: false, code: 'EDITOR_ACCOUNT_INVALID' });
    expect(await policy(handoffOf({ requesterRef: 'cnv_x' }), evm('0x' + 'ab'.repeat(20)))).toEqual({ ok: false, code: 'EDITOR_ACCOUNT_INVALID' });
    const broken = editorClaimPolicy(async () => { throw new Error('connection refused'); });
    expect(await broken(handoffOf(), evm('0x' + 'ab'.repeat(20)))).toEqual({ ok: false, code: 'ACCOUNTS_UNAVAILABLE' });
  });

  it('contributes the Editor profile to /approve only when enabled: its policy, claim rule and the browser\'s own account as viewer', async () => {
    expect(editorApprovalContributor({})).toBeNull();
    const config = readEditorRunConfig(ENABLED);
    if (!config.enabled) throw new Error('config');
    const host = { db: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Database, tenantId: 'default' };
    let signedIn: string | null = ACCOUNT;
    const contribute = editorApprovalContributor(ENABLED, { config, account: async () => signedIn })!;
    const contribution: ApprovalContribution = contribute(host, () => undefined);
    expect(contribution.scheme).toMatchObject({ prefix: EDITOR_LINK_PREFIX, kinds: ['EDITOR_SESSION'] });
    expect(Object.keys(contribution.profiles)).toEqual(['EDITOR_SESSION']);
    const profile = contribution.profiles.EDITOR_SESSION!;
    expect(profile.policy).toEqual(config.policy);
    expect(await profile.viewerRequester!()).toEqual({ kind: 'EDITOR_SESSION', ref: ACCOUNT });
    signedIn = null;
    expect(await profile.viewerRequester!()).toBeNull();
    // The account store holds no wallet for this account here: the claim is refused.
    expect(await profile.claimPolicy!(handoffOf(), evm('0x' + 'ab'.repeat(20)))).toEqual({ ok: false, code: 'EDITOR_WALLET_NOT_IN_ACCOUNT' });
    // It assembles with the other surfaces' contributions: one prefix and one kind each.
    const surface = assembleApprovalSurface([contribution, { scheme: approvalLinkScheme('flofi_chs_', randomBytes(32), ['CHANNEL_CONVERSATION']), profiles: {} }],
      {} as HandoffStore, {} as never);
    expect(Object.keys(surface.profiles)).toEqual(['EDITOR_SESSION']);
    expect(() => assembleApprovalSurface([contribution, contribution], {} as HandoffStore, {} as never)).toThrow('APPROVAL_SURFACE_INVALID');
  });

  it('is rate-limited under its own account bucket, like every requester kind, and only after the workflow is re-composed and gated', async () => {
    const buckets: string[] = [];
    const strategy = { version: 2, steps: [{ action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 50 },
      { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '2', slippageBps: 50 }] };
    const request = (workflowHash: string) => requestApproval({ origin: 'http://127.0.0.1:3108', scheme: editorApprovalScheme(randomBytes(32)), handoffs: {} as HandoffStore,
      allow: async bucket => { buckets.push(bucket); return false; }, runtime: { kind: 'embedded', sequences: async () => ({ enabled: true, delegation: null }),
        mode: async () => 'harness', info: async () => ({ executionEnabled: true }) } as never, policy: { ok: true, testFunds: true, mainnetNetworks: [] },
      rules: EDITOR_HANDOFF_RULES, now: new Date() }, editorRequester(ACCOUNT), strategy, workflowHash);
    // A hash the browser made up is refused before the limiter is consulted.
    expect(await request('0x' + '0'.repeat(64))).toMatchObject({ ok: false, code: 'STRATEGY_WORKFLOW_HASH_MISMATCH' });
    expect(buckets).toEqual([]);
    const composed = composeWorkflowBound(strategy, undefined);
    if (!composed.ok) throw new Error(composed.code);
    expect(await request(composed.workflowHash)).toEqual({ ok: false, code: 'HANDOFF_RATE_LIMITED' });
    expect(buckets).toEqual([`handoff:editor:${ACCOUNT}`]);
  });
});
