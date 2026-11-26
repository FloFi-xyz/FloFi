// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native in-conversation signing of an MCP approval, end to end on a disposable PostgreSQL with the real
 * OAuth grant, approval handoff, Sign-In With Solana verifier, flow runtime (MOCKED in-memory Solana, never a broadcast to a public network) and a
 * test wallet that speaks the Phantom/Solflare deeplink protocol with real NaCl encryption. Proves: connect + proof + claim + fresh simulation
 * before any wallet request; the in-conversation confirmation before the signing request; FloFi broadcasts only the exact reviewed bytes; replayed,
 * forged, mis-signed, rejected and tampered answers change nothing or end with nothing sent; another account cannot drive the session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLANA_DEVNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { appendMockedWalletGuards, createMockedSolanaTransferChain, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createEmbeddedRuntime } from '../flow-runtime.ts';
import { session } from '../../mcp/gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from '../../mcp/oauth/oauth-test-harness.ts';
import { createPgOAuthStore } from '../../mcp/oauth/pg-store.ts';
import { stateOf } from '../../mcp/oauth/state.ts';
import { embeddedMcpRuntime } from '../../mcp/runtime.ts';
import { base58DecodeBytes, base58EncodeBytes } from '../../wallet/deeplink/base58.ts';
import { boxKeyPair } from '../../wallet/deeplink/nacl-box.ts';
import { callbackParts, deeplinkTestWallet } from '../../wallet/deeplink/test-wallet.test-harness.ts';
import { nativeSigningService } from './runtime.ts';
import { publicNativeSession, type NativeEvent } from './service.ts';
import type { NativeSession } from './session-store.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });

async function setup(clock: { offsetMs: number } = { offsetMs: 0 }) {
  const chain = createMockedSolanaTransferChain({ profile: SOLANA_DEVNET_TRANSFER, send: 'OK' }), key = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
  chain.fundWallet(key.owner, 3_000_000_000n);
  const env = { FLOFI_RUNTIME: 'embedded', DATABASE_URL: t.url, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/native-channel-signing', FLOFI_MCP: 'enabled',
    GRYLOO_SOLANA_TRANSFER_HARNESS: 'MOCKED_LOOPBACK_ONLY', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_SESSION_SECRET: 's'.repeat(40), ...oauthEnv() };
  const runtime = await createEmbeddedRuntime(env, { rpc: { 'solana-devnet-transfer': chain.rpc }, busyRetries: 3 });
  const tokens = await signIn(oauthClient({ env, store: createPgOAuthStore(runtime.db, runtime.tenantId) }), { scope: 'flofi.strategy flofi.approval flofi.runs' });
  const { account_id: accountId } = (await runtime.db.query<{ account_id: string }>('SELECT account_id FROM mcp_oauth_grants ORDER BY created_at DESC LIMIT 1')).rows[0]!;
  const state = stateOf({ db: runtime.db, tenantId: runtime.tenantId });
  const tool = (name: string, args: unknown) => session({ env, token: tokens.access_token, runtime: embeddedMcpRuntime(runtime), state }).callTool(name, args);
  const events: { event: NativeEvent; session: NativeSession }[] = [];
  const native = await nativeSigningService(env, { host: { db: runtime.db, tenantId: runtime.tenantId }, runtime: embeddedMcpRuntime(runtime),
    flow: async (flow, method, args, context) => runtime.backend.callFlow(flow, method, args, undefined, context.principal) as never,
    notify: async (s, event) => { events.push({ event, session: s }); }, now: () => new Date(Date.now() + clock.offsetMs) });
  const composed = (await tool('compose_strategy', { strategy: { action: 'transfer', network: 'solana-devnet', asset: 'SOL', amount: '0.01', recipient } })).output as
    { strategy: unknown; workflowHash: string };
  const requested = (await tool('request_user_approval', { strategy: composed.strategy, workflowHash: composed.workflowHash })).output as { approvalId: string };
  const requester = { kind: 'MCP_ACCOUNT' as const, ref: accountId };
  const deliver = (url: string) => { const p = callbackParts(url); return native.callback(p.handoffId, p.sessionId, p.tag, p.params); };
  return { chain, key, recipient, runtime, tool, state, native, requester, approvalId: requested.approvalId, events, deliver };
}

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native wallet signing from a conversation', () => {
  it('connect → proof → claim + fresh simulation → Review in the conversation → confirmation → exact signature → one broadcast → reconciled', async () => {
    const c = await setup();
    try {
      const wallet = deeplinkTestWallet('phantom', c.key);
      const started = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'CHATGPT', language: 'EN' });
      expect(started.connectUrl).toMatch(/^https:\/\/phantom\.com\/ul\/v1\/connect\?app_url=/);
      expect(new URL(started.connectUrl).searchParams.get('cluster')).toBe('devnet');
      // Phantom reads the redirect link for its own display: nothing changes.
      expect(await c.native.callback(c.approvalId, started.sessionId, callbackParts(wallet.read(started.connectUrl).redirect).tag, new URLSearchParams()))
        .toMatchObject({ kind: 'PAGE', page: 'METADATA' });
      const connected = wallet.approve(started.connectUrl);
      const proof = await c.deliver(connected);
      expect(proof.kind).toBe("WALLET");
      const proofRequest = wallet.read((proof as { url: string }).url);
      expect(proofRequest.method).toBe('signMessage');
      expect(new TextDecoder().decode(base58DecodeBytes(String(proofRequest.payload!.message))))
        .toContain(`wants you to sign in with your Solana account:\n${c.key.owner}`);
      // The connect answer replayed: already handled, nothing changes.
      expect(await c.deliver(connected)).toMatchObject({ kind: 'PAGE', page: 'IGNORED', code: 'NATIVE_STEP_ALREADY_HANDLED' });
      expect(c.chain.state.sent).toHaveLength(0);

      const reviewed = await c.deliver(wallet.approve((proof as { url: string }).url));
      expect(reviewed).toMatchObject({ kind: 'PAGE', page: 'RETURN', session: { state: 'REVIEW_READY', owner: c.key.owner } });
      const ready = (reviewed as { session: NativeSession }).session;
      expect(ready.review).toMatchObject({ flow: 'solana-devnet-transfer', action: 'transfer', owner: c.key.owner, recipient: c.recipient,
        pay: { symbol: 'SOL', amount: '10000000', decimals: 9 } });
      expect(c.events.map(e => e.event)).toEqual(['REVIEW_READY']);
      // The approval is claimed and applied for the proven wallet; its run is the Review's own simulation; still nothing sent.
      const status = (await c.tool('get_approval_status', { approvalId: c.approvalId })).output as { status: string; runs: { executionId: string; status: string }[] };
      expect(status).toMatchObject({ status: 'APPLIED', runs: [{ executionId: ready.review!.runId, status: 'SIMULATED' }] });
      expect(c.chain.state.sent).toHaveLength(0);
      // What a requester may see carries no key, wallet session or tag.
      expect(JSON.stringify(publicNativeSession(ready))).not.toMatch(/dappSecret|walletSession|confirmTag|"tag"|g1\./);

      // Another account never drives this session.
      await expect(c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, requester: { kind: 'MCP_ACCOUNT', ref: 'mcpacct_' + 'a'.repeat(26) } }))
        .rejects.toThrow('NATIVE_SESSION_NOT_FOUND');
      await expect(c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmTag: 'x'.repeat(22) })).rejects.toThrow('NATIVE_CONFIRMATION_INVALID');

      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, requester: c.requester });
      expect(signing.kind).toBe('WALLET');
      const signRequest = wallet.read((signing as { url: string }).url);
      expect(signRequest.method).toBe('signTransaction');
      expect(c.chain.state.sent).toHaveLength(0);
      // The confirmation is single use.
      await expect(c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, requester: c.requester })).rejects.toThrow('NATIVE_REVIEW_NOT_READY');

      const sent = await c.deliver(wallet.approve((signing as { url: string }).url));
      expect(sent).toMatchObject({ kind: 'PAGE', page: 'RETURN', session: { state: 'SUBMITTED' } });
      expect(c.chain.state.sent).toHaveLength(1);
      expect(c.events.map(e => e.event)).toEqual(['REVIEW_READY', 'SUBMITTED']);
      const final = await c.runtime.backend.callFlow('solana-devnet-transfer', 'observe', [ready.review!.runId], undefined, c.key.owner) as { ok: boolean; value: { verdict: string } };
      expect(final.value.verdict).toBe('RECONCILED');
      const after = (await c.tool('get_approval_status', { approvalId: c.approvalId })).output;
      expect(after).toMatchObject({ status: 'APPLIED', runs: [{ executionId: ready.review!.runId, reconciled: true }] });
      expect(c.chain.state.sent).toHaveLength(1);
    } finally { await c.runtime.close(); }
  });

  it('refuses forged and mis-signed answers without ending the session, and a wallet that changed the transaction sends nothing', async () => {
    const c = await setup();
    try {
      const wallet = deeplinkTestWallet('solflare', c.key), stranger = deeplinkTestWallet('solflare', createMockedSolanaWallet());
      const started = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'solflare', returnTo: 'CLAUDE', language: 'PT' });
      expect(started.connectUrl).toMatch(/^https:\/\/solflare\.com\/ul\/v1\/connect\?/);
      const redirect = wallet.read(started.connectUrl).redirect;
      // An answer sealed under another wallet key for another dapp key: not this session's.
      const forged = stranger.approve(started.connectUrl.replace(/dapp_encryption_public_key=[^&]+/, `dapp_encryption_public_key=${base58EncodeBytes(boxKeyPair().publicKey)}`));
      expect(await c.native.callback(...Object.values(callbackParts(redirect + '?' + new URL(forged).searchParams.toString())) as [string, string, string, URLSearchParams]))
        .toMatchObject({ kind: 'PAGE', page: 'IGNORED' });
      const proof = await c.deliver(wallet.approve(started.connectUrl));
      // A Sign-In signature by another key: refused; the session still waits for the real proof.
      expect(await c.deliver(wallet.approve((proof as { url: string }).url, { signer: createMockedSolanaWallet() })))
        .toMatchObject({ kind: 'PAGE', page: 'IGNORED', code: 'WALLET_SIGNATURE_INVALID' });
      const ready = (await c.deliver(wallet.approve((proof as { url: string }).url)) as { session: NativeSession }).session;
      expect(ready.state).toBe('REVIEW_READY');
      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmTag: ready.confirmTag! }) as { url: string };
      // The wallet appended instructions FloFi cannot verify: the flow refuses the bytes and nothing is broadcast.
      const tampered = await c.deliver(wallet.approve(signing.url, { alter: unsigned => appendMockedWalletGuards(unsigned) }));
      expect(tampered).toMatchObject({ kind: 'PAGE', page: 'ENDED', session: { state: 'ENDED' } });
      expect(c.chain.state.sent).toHaveLength(0);
    } finally { await c.runtime.close(); }
  });

  it('a rejection in the wallet records that nothing was sent; an expiring Review is simulated again before the wallet is asked', async () => {
    const clock = { offsetMs: 0 }, c = await setup(clock);
    try {
      const wallet = deeplinkTestWallet('phantom', c.key);
      const started = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      const proof = await c.deliver(wallet.approve(started.connectUrl)) as { url: string };
      const ready = (await c.deliver(wallet.approve(proof.url)) as { session: NativeSession }).session;
      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, requester: c.requester }) as { url: string };
      const rejected = await c.deliver(wallet.reject(signing.url));
      expect(rejected).toMatchObject({ kind: 'PAGE', page: 'ENDED', code: 'WALLET_REQUEST_REJECTED' });
      const record = await c.runtime.backend.callFlow('solana-devnet-transfer', 'status', [ready.review!.runId], undefined, c.key.owner) as { ok: boolean; value: { notSubmitted?: boolean; attempt: { state: string } } };
      expect(record.value).toMatchObject({ notSubmitted: true, attempt: { state: 'CANCELLED' } });
      expect(c.chain.state.sent).toHaveLength(0);

      // The owner tries again on the same (applied) approval: a new session, a new proof, a fresh Review.
      const again = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      const proof2 = await c.deliver(wallet.approve(again.connectUrl)) as { url: string };
      const ready2 = (await c.deliver(wallet.approve(proof2.url)) as { session: NativeSession }).session;
      expect(ready2.review!.runId).not.toBe(ready.review!.runId);
      // Confirmed close to its Review's expiry: simulated again at once; its terms are no worse (the same transfer and fee), so the wallet is asked to
      // sign the FRESH run (never stale bytes), and the confirmed run is never begun.
      clock.offsetMs = 20_000;
      const signing2 = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready2.id, requester: c.requester });
      expect(signing2.kind).toBe('WALLET');
      const fresh = (await c.native.latestById(c.approvalId, ready2.id))!;
      expect(fresh).toMatchObject({ state: 'AWAITING_SIGNATURE' });
      expect(fresh.review!.runId).not.toBe(ready2.review!.runId);
      const stale = await c.runtime.backend.callFlow('solana-devnet-transfer', 'status', [ready2.review!.runId], undefined, c.key.owner) as { value: { attempt: unknown } };
      expect(stale.value.attempt ?? null).toBeNull();
      await c.deliver(wallet.reject((signing2 as { url: string }).url));
      clock.offsetMs = 0;
      // Someone else's wallet proof never takes an approval this owner already claimed.
      const other = deeplinkTestWallet('phantom', createMockedSolanaWallet());
      const foreign = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      const foreignProof = await c.deliver(other.approve(foreign.connectUrl)) as { url: string };
      expect(await c.deliver(other.approve(foreignProof.url))).toMatchObject({ kind: 'PAGE', page: 'ENDED', code: 'HANDOFF_ALREADY_CLAIMED' });
      expect(c.chain.state.sent).toHaveLength(0);
    } finally { await c.runtime.close(); }
  });
});
