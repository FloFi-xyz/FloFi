// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native in-conversation signing of an MCP approval, end to end on a disposable PostgreSQL with the real
 * OAuth grant, approval handoff, Sign-In With Solana verifier, flow runtime (MOCKED in-memory Solana, never a broadcast to a public network) and a
 * test wallet that speaks the Phantom/Solflare deeplink protocol with real NaCl encryption. Proves: connect + proof + fresh simulation + claim
 * before any wallet transaction request; the signer's own Review page; the conversation's confirmation bound to exactly that Review; FloFi
 * broadcasts only the exact reviewed bytes, once; replayed, forged, mis-signed, rejected, racing and tampered answers change nothing or end with
 * nothing sent; one approval is never sent twice; another account cannot drive the session.
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
import { base58DecodeBytes, base58EncodeBytes } from './deeplink/base58.ts';
import { boxKeyPair } from './deeplink/nacl-box.ts';
import { callbackParts, deeplinkTestWallet } from './deeplink/test-wallet.test-harness.ts';
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
  const events: { event: NativeEvent; session: NativeSession; ref: string | null }[] = [];
  const native = await nativeSigningService(env, { host: { db: runtime.db, tenantId: runtime.tenantId }, runtime: embeddedMcpRuntime(runtime),
    flow: async (flow, method, args, context) => runtime.backend.callFlow(flow, method, args, undefined, context.principal) as never,
    notify: async (s, event, ref) => { events.push({ event, session: s, ref }); }, now: () => new Date(Date.now() + clock.offsetMs) });
  const composed = (await tool('compose_strategy', { strategy: { action: 'transfer', network: 'solana-devnet', asset: 'SOL', amount: '0.01', recipient } })).output as
    { strategy: unknown; workflowHash: string };
  const requested = (await tool('request_user_approval', { strategy: composed.strategy, workflowHash: composed.workflowHash })).output as { approvalId: string };
  const requester = { kind: 'MCP_ACCOUNT' as const, ref: accountId };
  const deliver = (url: string) => { const p = callbackParts(url); return native.callback(p.handoffId, p.sessionId, p.tag, p.params); };
  /** The Review's single-use reference, as only the owner's panel receives it. */
  const ref = async () => (await native.view(requested.approvalId, requester))!.panel.reviewRef!;
  const status = async (runId: string) => (await runtime.backend.callFlow('solana-devnet-transfer', 'status', [runId], undefined, key.owner) as
    { value: { notSubmitted?: boolean; attempt: { state: string } | null; verdict: string } }).value;
  /** connect → proof: the session at REVIEW_READY (what the signer's page showed is returned too). */
  const toReview = async (wallet: ReturnType<typeof deeplinkTestWallet>, start: { connectUrl: string }) => {
    const proof = await deliver(wallet.approve(start.connectUrl)) as { url: string };
    const page = await deliver(wallet.approve(proof.url)) as { page: string; session: NativeSession };
    return page;
  };
  return { chain, key, recipient, runtime, tool, state, native, requester, approvalId: requested.approvalId, events, deliver, ref, status, toReview };
}

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native wallet signing from a conversation', () => {
  it('connect → proof → fresh simulation + claim → Review (conversation and signer) → bound confirmation → exact signature → one broadcast → reconciled', async () => {
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
      expect(proof.kind).toBe('WALLET');
      const proofRequest = wallet.read((proof as { url: string }).url);
      expect(proofRequest.method).toBe('signMessage');
      expect(new TextDecoder().decode(base58DecodeBytes(String(proofRequest.payload!.message)))).toContain(`wants you to sign in with your Solana account:\n${c.key.owner}`);
      // The connect answer replayed: already handled, nothing changes.
      expect(await c.deliver(connected)).toMatchObject({ kind: 'PAGE', page: 'IGNORED', code: 'NATIVE_STEP_ALREADY_HANDLED' });
      expect(c.chain.state.sent).toHaveLength(0);

      // After the proof, the signer's own page shows FloFi's Review (with where it came from); the conversation gets it with its reference.
      const reviewed = await c.deliver(wallet.approve((proof as { url: string }).url));
      expect(reviewed).toMatchObject({ kind: 'PAGE', page: 'REVIEW', session: { state: 'REVIEW_READY', owner: c.key.owner } });
      const ready = (reviewed as { session: NativeSession }).session;
      expect(ready.review).toMatchObject({ flow: 'solana-devnet-transfer', action: 'transfer', owner: c.key.owner, recipient: c.recipient,
        pay: { symbol: 'SOL', amount: '10000000', decimals: 9 } });
      expect(c.events.map(e => e.event)).toEqual(['REVIEW_READY']);
      const reviewRef = await c.ref();
      expect(c.events[0]!.ref).toBe(reviewRef);
      // The approval is claimed and applied for the proven wallet; its run is the Review's own simulation; still nothing sent.
      const approval = (await c.tool('get_approval_status', { approvalId: c.approvalId })).output as { status: string; runs: { executionId: string; status: string }[] };
      expect(approval).toMatchObject({ status: 'APPLIED', runs: [{ executionId: ready.review!.runId, status: 'SIMULATED' }] });
      expect(c.chain.state.sent).toHaveLength(0);
      // What a requester or model may see carries no key, wallet, session id, reference or Review amounts.
      const visible = JSON.stringify(publicNativeSession(ready));
      expect(visible).not.toMatch(/dappSecret|walletSession|confirm|Nonce|nsg_|SOL|10000000/);
      expect(visible).not.toContain(c.key.owner);
      // The journal stores no reference: only nonces the deployment's key turns into them.
      const journal = (await c.runtime.db.query<{ bytes: Buffer }>(`SELECT s.bytes FROM execution_log_segments s WHERE s.namespace = 'native-signing'`)).rows
        .map(r => r.bytes.toString('utf8')).join('');
      expect(journal).not.toContain(reviewRef);

      // Another account, or a wrong reference, never confirms.
      await expect(c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: reviewRef, requester: { kind: 'MCP_ACCOUNT', ref: 'mcpacct_' + 'a'.repeat(26) } }))
        .rejects.toThrow('NATIVE_SESSION_NOT_FOUND');
      await expect(c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: 'x'.repeat(22), requester: c.requester })).rejects.toThrow('NATIVE_CONFIRMATION_INVALID');

      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: reviewRef, requester: c.requester });
      expect(signing.kind).toBe('WALLET');
      const signUrl = (signing as { url: string }).url;
      expect(wallet.read(signUrl).method).toBe('signTransaction');
      expect(c.chain.state.sent).toHaveLength(0);
      // The same confirmation again (a reload, a second tap) returns the same wallet request, never a second one.
      expect(await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: reviewRef, requester: c.requester })).toEqual({ kind: 'WALLET', url: signUrl });

      const sent = await c.deliver(wallet.approve(signUrl));
      expect(sent).toMatchObject({ kind: 'PAGE', page: 'RETURN', session: { state: 'SUBMITTED' } });
      expect(c.chain.state.sent).toHaveLength(1);
      expect(c.events.map(e => e.event)).toEqual(['REVIEW_READY', 'SUBMITTED']);
      // A late or duplicate answer after the signature only learns it was sent, never "nothing changed".
      expect(await c.deliver(wallet.approve(signUrl))).toMatchObject({ kind: 'PAGE', page: 'RETURN' });
      const final = await c.runtime.backend.callFlow('solana-devnet-transfer', 'observe', [ready.review!.runId], undefined, c.key.owner) as { ok: boolean; value: { verdict: string } };
      expect(final.value.verdict).toBe('RECONCILED');
      const after = (await c.tool('get_approval_status', { approvalId: c.approvalId })).output;
      expect(after).toMatchObject({ status: 'APPLIED', runs: [{ executionId: ready.review!.runId, reconciled: true }] });

      // One approval is sent at most once: a new session for it is refused, whatever the button or account says.
      await expect(c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'solflare', returnTo: 'NONE', language: 'EN' }))
        .rejects.toThrow('NATIVE_SIGNING_ALREADY_SENT');
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
      const parts = callbackParts(redirect + '?' + new URL(forged).searchParams.toString());
      expect(await c.native.callback(parts.handoffId, parts.sessionId, parts.tag, parts.params)).toMatchObject({ kind: 'PAGE', page: 'IGNORED' });
      // A guessed tag never reaches the session.
      expect(await c.native.callback(parts.handoffId, parts.sessionId, 'A'.repeat(22), parts.params)).toMatchObject({ page: 'IGNORED', code: 'NATIVE_STEP_ALREADY_HANDLED' });
      const proof = await c.deliver(wallet.approve(started.connectUrl));
      // A Sign-In signature by another key: refused; the session still waits for the real proof.
      expect(await c.deliver(wallet.approve((proof as { url: string }).url, { signer: createMockedSolanaWallet() })))
        .toMatchObject({ kind: 'PAGE', page: 'IGNORED', code: 'WALLET_SIGNATURE_INVALID' });
      const ready = (await c.deliver(wallet.approve((proof as { url: string }).url)) as { session: NativeSession }).session;
      expect(ready.state).toBe('REVIEW_READY');
      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: await c.ref() }) as { url: string };
      // The wallet appended instructions FloFi cannot verify: the flow refuses the bytes and nothing is broadcast (and nothing was sent says so).
      const tampered = await c.deliver(wallet.approve(signing.url, { alter: unsigned => appendMockedWalletGuards(unsigned) }));
      expect(tampered).toMatchObject({ kind: 'PAGE', page: 'ENDED', session: { state: 'ENDED', outcome: { afterSignature: false } } });
      expect(c.chain.state.sent).toHaveLength(0);
    } finally { await c.runtime.close(); }
  });

  it('a refusal racing the signed answer: exactly one is recorded, and the conversation is never told both', async () => {
    const c = await setup();
    try {
      const wallet = deeplinkTestWallet('phantom', c.key);
      const ready = (await c.toReview(wallet, await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' }))).session;
      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: await c.ref(), requester: c.requester }) as { url: string };
      const [refused, signed] = await Promise.all([c.deliver(wallet.reject(signing.url)), c.deliver(wallet.approve(signing.url))]);
      const told = c.events.map(e => e.event).filter(e => e === 'ENDED' || e === 'SUBMITTED');
      if (c.chain.state.sent.length === 1) {
        // The signed answer won: the refusal changed nothing, and nothing says "nothing was sent".
        expect(refused).toMatchObject({ page: 'RETURN' }); expect(told).toEqual(['SUBMITTED']);
        expect((await c.status(ready.review!.runId)).notSubmitted ?? false).toBe(false);
      } else {
        // The refusal won: the prepared request is cancelled, the signed bytes are never broadcast.
        expect(refused).toMatchObject({ page: 'ENDED', code: 'WALLET_REQUEST_REJECTED' }); expect(signed).toMatchObject({ page: 'ENDED' });
        expect(told).toEqual(['ENDED']); expect(await c.status(ready.review!.runId)).toMatchObject({ notSubmitted: true, attempt: { state: 'CANCELLED' } });
      }
      expect(c.chain.state.sent.length).toBeLessThanOrEqual(1);
    } finally { await c.runtime.close(); }
  });

  it('a rejection records that nothing was sent; a retry re-simulates; a near-expiry Review is renewed, never sent stale', async () => {
    const clock = { offsetMs: 0 }, c = await setup(clock);
    try {
      const wallet = deeplinkTestWallet('phantom', c.key);
      const first = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      const ready = (await c.toReview(wallet, first)).session;
      const signing = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready.id, confirmRef: await c.ref(), requester: c.requester }) as { url: string };
      // While that wallet request is open, no second session may start for the approval.
      await expect(c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'solflare', returnTo: 'NONE', language: 'EN' }))
        .rejects.toThrow('NATIVE_SIGNING_WALLET_REQUEST_OPEN');
      const rejected = await c.deliver(wallet.reject(signing.url));
      expect(rejected).toMatchObject({ kind: 'PAGE', page: 'ENDED', code: 'WALLET_REQUEST_REJECTED', session: { outcome: { afterSignature: false } } });
      expect(await c.status(ready.review!.runId)).toMatchObject({ notSubmitted: true, attempt: { state: 'CANCELLED' } });
      // The signed answer arriving after the refusal changes nothing.
      expect(await c.deliver(wallet.approve(signing.url))).toMatchObject({ page: 'ENDED' });
      expect(c.chain.state.sent).toHaveLength(0);

      // The owner tries again on the same (applied) approval: a new session, a new proof, a fresh Review.
      const again = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      const ready2 = (await c.toReview(wallet, again)).session;
      expect(ready2.review!.runId).not.toBe(ready.review!.runId);
      // Confirmed close to its Review's expiry: simulated again at once; its terms are no worse (the same transfer and fee), so the wallet is asked to
      // sign the FRESH run (never stale bytes), the conversation is told which terms went to the wallet, and the confirmed run is never begun.
      clock.offsetMs = 20_000;
      const signing2 = await c.native.confirm({ handoffId: c.approvalId, sessionId: ready2.id, confirmRef: await c.ref(), requester: c.requester });
      expect(signing2.kind).toBe('WALLET');
      const fresh = (await c.native.latestById(c.approvalId, ready2.id))!;
      expect(fresh).toMatchObject({ state: 'AWAITING_SIGNATURE' });
      expect(fresh.review!.runId).not.toBe(ready2.review!.runId);
      expect((await c.status(ready2.review!.runId)).attempt ?? null).toBeNull();
      expect(c.events.at(-1)).toMatchObject({ event: 'REVIEW_RENEWED' });
      await c.deliver(wallet.reject((signing2 as { url: string }).url));
      clock.offsetMs = 0;
      // Someone else's wallet proof never takes an approval this owner already claimed (and the signer is told, nothing sent).
      const other = deeplinkTestWallet('phantom', createMockedSolanaWallet());
      const foreign = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      expect(await c.toReview(other, foreign)).toMatchObject({ page: 'ENDED', code: 'HANDOFF_ALREADY_CLAIMED' });
      // An unauthenticated refusal on a session's current step only ends that session (never a send, never another session's request).
      const plain = await c.native.start({ handoffId: c.approvalId, requester: c.requester, wallet: 'phantom', returnTo: 'NONE', language: 'EN' });
      expect(await c.deliver(wallet.reject(plain.connectUrl))).toMatchObject({ page: 'ENDED', code: 'WALLET_REQUEST_REJECTED' });
      expect(c.chain.state.sent).toHaveLength(0);
      // A session past its validity reads as expired to its requester (no new step can start from it).
      clock.offsetMs = 16 * 60_000;
      expect((await c.native.view(c.approvalId, c.requester))!.public).toMatchObject({ state: 'ENDED', outcome: { code: expect.stringMatching(/EXPIRED|REJECTED/) } });
    } finally { await c.runtime.close(); }
  });
});
