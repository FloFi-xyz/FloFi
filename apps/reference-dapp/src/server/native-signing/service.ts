// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native wallet signing from a conversation, with no FloFi page to complete.
 *
 *   start      the conversation asks for its approval to be signed with Phantom or Solflare: a one-time X25519 key and a session; the answer
 *              is the wallet's own `connect` deeplink (the conversation opens it; nothing is signed)
 *   connect    the wallet names an account (unauthenticated) → FloFi asks that wallet to sign its Sign-In With Solana challenge
 *   signIn     the Ed25519 signature over the exact challenge proves the account (FloFi's existing SIWS verifier) → the existing claim and apply of
 *              the approval for that proven wallet (the requester's own claim rule included), then the flow's own fresh simulation; its Review is
 *              presented IN the conversation (the channel posts it; an MCP host's panel reads it)
 *   confirm    the owner confirms that exact Review in the conversation → the flow's Review acceptance and `begin` (fresh checks, durable PREPARED,
 *              the exact unsigned bytes) → the wallet's `signTransaction` deeplink with those bytes
 *   sign       the wallet returns the signed bytes → the flow's `submit` (exact reviewed bytes and owner signature verified, signature durable,
 *              one broadcast by FloFi) → automatic observation and reconciliation as for every run; the receipt reaches the conversation through
 *              the approval's existing status notifications
 *
 * The callback URL each wallet returns to carries the approval id, the session id and a single-use step tag. A step is recorded as used
 * (compare-and-swap) BEFORE its effect; a replayed, late, forged or out-of-order answer changes nothing. An answer that does not open under this
 * session's key, or a proof that does not verify, is refused without ending the session (only the wallet's real answer can advance it). FloFi
 * never holds or uses a key that can sign for the owner: the wallet signs, and the flow broadcasts only the exact reviewed bytes it verified.
 */
import { randomBytes } from 'node:crypto';
import { base58DecodeBytes as base58Decode, base58EncodeBytes as base58Encode } from '../../wallet/deeplink/base58.ts';
import { claimApproval, applyApproval, isNativeSigningFlow, nativeSigningEligible, openApprovalSession, typedId, verifyHandoff, type ApprovalRequester,
  type ApprovalSurface, type RequesterScope } from '../../platform/index.ts';
import { boxKeyPair } from '../../wallet/deeplink/nacl-box.ts';
import { connectUrl, connectedAccount, DEEPLINK_WALLETS, openAnswer, signedMessage, signedTransaction, signMessageUrl, signTransactionUrl,
  type DeeplinkCluster, type DeeplinkWallet } from '../../wallet/deeplink/protocol.ts';
import { issueWalletChallenge, solanaChallengeMessage, verifySolanaSignIn } from '../wallet-session.ts';
import type { BetaRequestIdentity } from '../../flight/beta-context.ts';
import { nativeEndedText } from './messages.ts';
import { nativeReviewLines, nativeReviewOf } from './review.ts';
import { NATIVE_TAG, type NativeFlow, type NativeReturn, type NativeReview, type NativeSession, type NativeSessionStore, type NativeState, type Sealer } from './session-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
/** The native flows: one owner signature over FloFi's exact reviewed Solana transaction, broadcast by FloFi (`simulate/review/begin/submit/observe`). */
export const NATIVE_FLOWS: Readonly<Record<NativeFlow, { readonly cluster: DeeplinkCluster; readonly prefix: string }>> = Object.freeze({
  'solana-transfer': { cluster: 'mainnet-beta', prefix: 'SOLANA_TRANSFER' }, 'solana-devnet-transfer': { cluster: 'devnet', prefix: 'SOLANA_TRANSFER' },
  'jupiter-swap': { cluster: 'mainnet-beta', prefix: 'JUPITER' } });
export const isNativeFlow = isNativeSigningFlow;
/** Whether an approval can be signed natively: one step on a native flow (any other plan keeps FloFi's signing page). */
export const nativeEligible = nativeSigningEligible;
/** How long an unused session stays usable (never beyond its approval). */
export const NATIVE_SESSION_SECONDS = 900;
/** A confirmed Review with less validity left than this is simulated again before the wallet is asked (the wallet hop itself takes time). */
const FRESH_MS = 45_000;
const sameAmount = (a: { symbol: string; amount: string; decimals: number }, b: { symbol: string; amount: string; decimals: number }) =>
  a.symbol === b.symbol && a.amount === b.amount && a.decimals === b.decimals;
/** Whether a fresh Review's terms are no worse for the owner than the confirmed one's. */
export function noWorse(confirmed: NativeReview, fresh: NativeReview): boolean {
  if (fresh.flow !== confirmed.flow || fresh.action !== confirmed.action || fresh.owner !== confirmed.owner || fresh.network !== confirmed.network
    || fresh.recipient !== confirmed.recipient || !sameAmount(fresh.pay, confirmed.pay)) return false;
  if (confirmed.receive) {
    const r = fresh.receive;
    if (!r || r.symbol !== confirmed.receive.symbol || r.decimals !== confirmed.receive.decimals) return false;
    if (confirmed.receive.minimum !== null && (r.minimum === null || BigInt(r.minimum) < BigInt(confirmed.receive.minimum))) return false;
  } else if (fresh.receive) return false;
  if (confirmed.feeToken) return !!fresh.feeToken && fresh.maximumNetworkCostLamports === null && fresh.feeToken.symbol === confirmed.feeToken.symbol
    && fresh.feeToken.decimals === confirmed.feeToken.decimals && BigInt(fresh.feeToken.amount) <= BigInt(confirmed.feeToken.amount);
  return !fresh.feeToken && confirmed.maximumNetworkCostLamports !== null && fresh.maximumNetworkCostLamports !== null
    && BigInt(fresh.maximumNetworkCostLamports) <= BigInt(confirmed.maximumNetworkCostLamports);
}

export type NativeFlowPort = <T>(flow: NativeFlow, method: string, args: readonly unknown[], context: { readonly principal: string;
  readonly betaIdentity: BetaRequestIdentity | null }) => Promise<Result<T>>;
export type NativeEvent = 'REVIEW_READY' | 'SUBMITTED' | 'ENDED';
export type NativeDeps = {
  readonly env: Env; readonly origin: string; readonly store: NativeSessionStore; readonly sealer: Sealer;
  readonly surface: () => Promise<ApprovalSurface>; readonly flow: NativeFlowPort;
  /** The conversation's own delivery of a session event (a channel posts it; an MCP panel reads the status instead). Failures never change the session. */
  readonly notify: (session: NativeSession, event: NativeEvent) => Promise<void>;
  /** The Flight (beta) identity the requester carries, where the deployment's beta access needs one. */
  readonly betaIdentity: (requester: NativeSession['requester']) => Promise<BetaRequestIdentity | null>;
  readonly now?: () => Date };
/** What a wallet's return to FloFi produces: the next wallet request, or a short page that sends the owner back to the conversation. */
export type NativeOutcome = { readonly kind: 'WALLET'; readonly url: string }
  | { readonly kind: 'PAGE'; readonly page: 'METADATA' | 'RETURN' | 'IGNORED' | 'ENDED'; readonly code: string | null; readonly session: NativeSession | null };

const fail = (code: string): never => { throw new Error(code); };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const codeOf = (error: unknown, fallback: string) => error instanceof Error && CODE.test(error.message) ? error.message : fallback;
const tag = () => randomBytes(16).toString('base64url');
const unwrap = <T,>(result: Result<T>): T => result.ok ? result.value : fail(result.code);
const TERMINAL: readonly NativeState[] = ['SUBMITTED', 'ENDED'];

export function createNativeSigning(deps: NativeDeps) {
  const now = deps.now ?? (() => new Date());
  const domain = new URL(deps.origin).host;
  const callbackUrl = (s: Pick<NativeSession, 'handoffId' | 'id'>, step: string) => `${deps.origin}/api/native-signing/${s.handoffId}/${s.id}/${step}`;
  const channelOf = (s: NativeSession) => ({ dappPublicKey: base58Decode(s.dappPublicKey), dappSecretKey: deps.sealer.open(s.id, 'dapp', s.dappSecret) });
  const walletSessionOf = (s: NativeSession) => {
    const c = s.connected ?? fail('NATIVE_SESSION_NOT_CONNECTED');
    return { walletPublicKey: base58Decode(c.walletKey), session: new TextDecoder().decode(deps.sealer.open(s.id, 'wallet-session', c.walletSession)) };
  };
  const stamp = (s: NativeSession, patch: Partial<NativeSession>): NativeSession => ({ ...s, ...patch, updatedAt: now().toISOString() });
  const ended = async (version: number, s: NativeSession, code: string): Promise<NativeSession> => {
    const next = stamp(s, { state: 'ENDED', step: null, confirmTag: null, walletRequest: null, outcome: { code, signature: s.outcome?.signature ?? null,
      attemptState: s.outcome?.attemptState ?? null, afterSignature: s.state === 'SUBMITTING' || s.state === 'SUBMITTED' } });
    await deps.store.write(version, next).catch(() => undefined);
    await deps.notify(next, 'ENDED').catch(() => undefined);
    return next;
  };
  const flowCall = async <T,>(s: NativeSession, method: string, args: readonly unknown[]) =>
    unwrap(await deps.flow<T>(s.flow, method, args, { principal: s.owner ?? fail('NATIVE_OWNER_UNPROVEN'), betaIdentity: await deps.betaIdentity(s.requester) }));

  /** The approval as its requester sees it, re-verified now, with the exact canonical workflow it holds. */
  async function verified(surface: ApprovalSurface, s: Pick<NativeSession, 'handoffId' | 'requester'>) {
    const h = await surface.handoffs.forRequester(s.handoffId, s.requester, now()) ?? fail('APPROVAL_NOT_FOUND');
    if (!nativeEligible(h)) fail('NATIVE_SIGNING_NOT_AVAILABLE_FOR_THIS_OPERATION');
    const profile = surface.profiles[h.requesterKind] ?? fail('APPROVAL_NOT_FOUND');
    const check = await verifyHandoff(h, surface.runtime, profile.policy);
    if (!check.ok) return fail(check.code);
    return { h, workflow: check.composition.workflow };
  }

  /**
   * The proven owner takes the approval exactly as the signing page does (claim with the requester's own rule, then apply the canonical
   * workflow) and the flow simulates it afresh. Status sharing with the originating conversation is part of this in-conversation flow.
   */
  async function prepareReview(s: NativeSession): Promise<NativeReview> {
    const surface = await deps.surface(), { h, workflow } = await verified(surface, s), owner = s.owner ?? fail('NATIVE_OWNER_UNPROVEN');
    const wallets = [{ namespace: 'solana' as const, address: owner }];
    if (h.status === 'APPLIED' || h.claimed) {
      // A refresh (or a claim this owner already holds): never another wallet's approval.
      if (h.claimed?.namespace !== 'solana' || h.claimed.address !== owner) fail('HANDOFF_ALREADY_CLAIMED');
    }
    if (h.status !== 'APPLIED') {
      const scheme = surface.schemes.find(candidate => candidate.kinds.includes(h.requesterKind)) ?? fail('APPROVAL_NOT_FOUND');
      // A fresh, short-lived approval-session secret, used here at once and never stored.
      const requester: ApprovalRequester = h.requesterKind === 'MCP_ACCOUNT'
        ? { kind: 'MCP_ACCOUNT', ref: h.requesterRef, grantId: h.grantId ?? fail('APPROVAL_NOT_FOUND'), clientId: h.clientId, displayName: h.clientName }
        : { kind: h.requesterKind, ref: h.requesterRef, clientId: h.clientId, displayName: h.clientName };
      const opened = await openApprovalSession({ origin: deps.origin, scheme, handoffs: surface.handoffs }, requester, h.handoffId);
      const secret = decodeURIComponent(new URL(opened.approvalUrl).hash.slice(1));
      // The claim (or the same owner's live claim re-opened) re-verifies the proposal and the requester's own rule, then the exact workflow is applied.
      await claimApproval(surface, secret, wallets, true, now());
      await applyApproval(surface, secret, wallets, workflow, now());
    }
    const record = await flowCall<{ id: string }>(s, 'simulate', [workflow, owner]);
    const review = nativeReviewOf(s.flow, record);
    if (review.owner !== owner) fail('NATIVE_REVIEW_OWNER_MISMATCH');
    await surface.handoffs.bindRuns(h.handoffId, [review.runId]).catch(() => undefined);
    return review;
  }

  return {
    /** A new session for one of the requester's open native-eligible approvals; the wallet's `connect` deeplink. */
    async start(input: { readonly handoffId: string; readonly requester: RequesterScope; readonly wallet: DeeplinkWallet; readonly returnTo: NativeReturn;
      readonly language: 'EN' | 'PT' }): Promise<{ readonly sessionId: string; readonly connectUrl: string; readonly expiresAt: string; readonly wallet: string }> {
      if (input.requester.kind !== 'MCP_ACCOUNT' && input.requester.kind !== 'CHANNEL_CONVERSATION') fail('NATIVE_SIGNING_NOT_AVAILABLE');
      if (!Object.hasOwn(DEEPLINK_WALLETS, input.wallet)) fail('NATIVE_WALLET_UNSUPPORTED');
      const surface = await deps.surface();
      const { h } = await verified(surface, { handoffId: input.handoffId, requester: input.requester as NativeSession['requester'] });
      // An applied approval may be signed again after a rejection or a failure (its claimant's proof is checked at the proof step).
      if (h.status !== 'PENDING' && h.status !== 'CLAIMED' && h.status !== 'APPLIED') fail(`APPROVAL_${h.status}`);
      const flow = h.plan.flow as NativeFlow, at = now(), id = typedId('nsg'), pair = boxKeyPair();
      const expiresAt = new Date(Math.min(h.expiresAt.getTime(), at.getTime() + NATIVE_SESSION_SECONDS * 1000)).toISOString(), step = tag();
      const session: NativeSession = { v: 1, id, wallet: input.wallet, handoffId: h.handoffId, requester: { kind: input.requester.kind as NativeSession['requester']['kind'], ref: input.requester.ref },
        flow, returnTo: input.returnTo, language: input.language, createdAt: at.toISOString(), expiresAt, dappPublicKey: base58Encode(pair.publicKey),
        dappSecret: deps.sealer.seal(id, 'dapp', pair.secretKey), challenge: null, state: 'AWAITING_CONNECT', step: { kind: 'connect', tag: step },
        connected: null, owner: null, review: null, confirmTag: null, outcome: null, walletRequest: null, updatedAt: at.toISOString() };
      const url = connectUrl({ wallet: input.wallet, appUrl: deps.origin, dappPublicKey: pair.publicKey, redirectLink: callbackUrl(session, step), cluster: NATIVE_FLOWS[flow].cluster });
      await deps.store.create({ ...session, walletRequest: url });
      return { sessionId: id, expiresAt, wallet: DEEPLINK_WALLETS[input.wallet].name, connectUrl: url };
    },

    /** A wallet returned to FloFi (`/api/native-signing/<approval>/<session>/<tag>?…`). */
    async callback(handoffId: string, sessionId: string, stepTag: string, params: URLSearchParams): Promise<NativeOutcome> {
      // The wallet may read the redirect link for its own display (no answer parameters): never a state change.
      if (!params.has('errorCode') && !params.has('data')) return { kind: 'PAGE', page: 'METADATA', code: null, session: null };
      const found = NATIVE_TAG.test(stepTag) ? await deps.store.read(handoffId, sessionId) : null;
      if (!found) return { kind: 'PAGE', page: 'IGNORED', code: 'NATIVE_SESSION_NOT_FOUND', session: null };
      const { session: s, version } = found;
      if (TERMINAL.includes(s.state)) return { kind: 'PAGE', page: s.state === 'ENDED' ? 'ENDED' : 'RETURN', code: s.outcome?.code ?? null, session: s };
      if (now().getTime() >= Date.parse(s.expiresAt) && s.state !== 'AWAITING_SIGNATURE' && s.state !== 'SUBMITTING')
        return { kind: 'PAGE', page: 'ENDED', code: 'NATIVE_SESSION_EXPIRED', session: await ended(version, s, 'NATIVE_SESSION_EXPIRED') };
      if (!s.step || s.step.tag !== stepTag) return { kind: 'PAGE', page: 'IGNORED', code: 'NATIVE_STEP_ALREADY_HANDLED', session: s };
      const step = s.step.kind, method = step === 'connect' ? 'connect' as const : step === 'signIn' ? 'signMessage' as const : 'signTransaction' as const;
      let answer: ReturnType<typeof openAnswer>;
      try {
        answer = openAnswer({ wallet: s.wallet, method, params, channel: channelOf(s), walletPublicKey: s.connected ? base58Decode(s.connected.walletKey) : null });
        if (answer.kind === 'ANSWERED' && step === 'connect') connectedAccount(answer);
      } catch (error) {
        // Not this session's answer (malformed, forged or sealed under another key): refused, and the session still waits for its wallet.
        return { kind: 'PAGE', page: 'IGNORED', code: codeOf(error, 'DEEPLINK_ANSWER_INVALID'), session: s };
      }
      if (answer.kind === 'REFUSED') {
        if (step === 'sign' && s.review) await deps.flow(s.flow, 'walletFailure', [s.review.runId, { stage: 'SIGN', code: `${NATIVE_FLOWS[s.flow].prefix}_WALLET_REJECTED`,
          error: { code: answer.walletCode, message: answer.message ?? '' } }], { principal: s.owner!, betaIdentity: await deps.betaIdentity(s.requester) }).catch(() => undefined);
        return { kind: 'PAGE', page: 'ENDED', code: answer.code, session: await ended(version, s, answer.code) };
      }
      if (step === 'connect') {
        const connected = connectedAccount(answer);
        const challenge = issueWalletChallenge(deps.env, { domain, uri: deps.origin, now: now() }), next = tag();
        const updated = stamp(s, { state: 'AWAITING_PROOF', challenge: challenge.token, step: { kind: 'signIn', tag: next },
          connected: { account: connected.address, walletKey: base58Encode(answer.walletPublicKey),
            walletSession: deps.sealer.seal(s.id, 'wallet-session', new TextEncoder().encode(connected.session)) } });
        const message = solanaChallengeMessage(deps.env, { challengeToken: challenge.token, domain, uri: deps.origin, address: connected.address, now: now() });
        const url = signMessageUrl({ wallet: s.wallet, channel: channelOf(s), walletSession: walletSessionOf(updated), redirectLink: callbackUrl(s, next), message });
        await deps.store.write(version, { ...updated, walletRequest: url });
        return { kind: 'WALLET', url };
      }
      if (step === 'signIn') {
        const account = s.connected!.account;
        try {
          verifySolanaSignIn(deps.env, { challengeToken: s.challenge ?? undefined, domain, uri: deps.origin, address: account,
            signature: Buffer.from(signedMessage(answer)).toString('base64'), now: now() });
        } catch (error) { return { kind: 'PAGE', page: 'IGNORED', code: codeOf(error, 'WALLET_SIGNATURE_INVALID'), session: s }; }
        // The proof is used: recorded before anything depends on it.
        const proving = stamp(s, { state: 'PREPARING_REVIEW', owner: account, step: null, walletRequest: null });
        const at = await deps.store.write(version, proving);
        try {
          const review = await prepareReview(proving);
          const ready = stamp(proving, { state: 'REVIEW_READY', review, confirmTag: tag() });
          await deps.store.write(at, ready);
          await deps.notify(ready, 'REVIEW_READY').catch(() => undefined);
          return { kind: 'PAGE', page: 'RETURN', code: null, session: ready };
        } catch (error) {
          const code = codeOf(error, 'NATIVE_REVIEW_UNAVAILABLE');
          return { kind: 'PAGE', page: 'ENDED', code, session: await ended(at, proving, code) };
        }
      }
      // step === 'sign': the signed bytes, verified and broadcast only by the flow.
      let bytes: Uint8Array;
      try { bytes = signedTransaction(answer); }
      catch (error) { return { kind: 'PAGE', page: 'IGNORED', code: codeOf(error, 'DEEPLINK_TRANSACTION_INVALID'), session: s }; }
      const submitting = stamp(s, { state: 'SUBMITTING', step: null, walletRequest: null });
      const at = await deps.store.write(version, submitting);
      const review = s.review ?? fail('NATIVE_REVIEW_MISSING');
      const submitted = await deps.flow<{ attempt?: { state?: string; signature?: string | null } | null; error?: string | null }>(s.flow, 'submit',
        [review.runId, Buffer.from(bytes).toString('base64')], { principal: s.owner!, betaIdentity: await deps.betaIdentity(s.requester) })
        .catch(error => ({ ok: false as const, code: codeOf(error, 'NATIVE_SUBMISSION_UNKNOWN') }));
      if (!submitted.ok) {
        // A failed call is not proof that nothing was broadcast: the flow's own journal decides, and the run stays observed.
        return { kind: 'PAGE', page: 'ENDED', code: submitted.code, session: await ended(at, submitting, submitted.code) };
      }
      const attempt = submitted.value.attempt ?? null;
      const outcome = { code: submitted.value.error ?? null, signature: attempt?.signature ?? null, attemptState: attempt?.state ?? null };
      // The flow refused the bytes (changed, mis-signed or stale): nothing was broadcast.
      if (!attempt?.signature) return { kind: 'PAGE', page: 'ENDED', code: outcome.code ?? 'NATIVE_SUBMISSION_REFUSED',
        session: await ended(at, submitting, outcome.code ?? 'NATIVE_SUBMISSION_REFUSED') };
      const done = stamp(submitting, { state: 'SUBMITTED', outcome });
      await deps.store.write(at, done);
      // One observation now; the deployment's worker keeps observing until the run reconciles (as for every run).
      await deps.flow(s.flow, 'observe', [review.runId], { principal: s.owner!, betaIdentity: await deps.betaIdentity(s.requester) }).catch(() => undefined);
      await deps.notify(done, 'SUBMITTED').catch(() => undefined);
      return { kind: 'PAGE', page: 'RETURN', code: null, session: done };
    },

    /**
     * The owner confirmed this exact Review in the conversation. `confirmTag` is the Review's single-use tag (a channel's confirm action carries it;
     * an MCP panel's confirmation is the requester's own call). A Review with less than FRESH_MS of validity left is simulated again at once, so the
     * whole validity covers the hop to the wallet; FloFi goes on only when those fresh terms are no worse than what the owner confirmed (same
     * amounts, assets, recipient and owner; the fee at most, the minimum received at least, as confirmed). Otherwise the fresh Review is presented
     * in the conversation again and nothing reaches the wallet.
     */
    async confirm(input: { readonly handoffId: string; readonly sessionId: string; readonly confirmTag?: string; readonly requester?: RequesterScope }):
      Promise<{ readonly kind: 'WALLET'; readonly url: string } | { readonly kind: 'REFRESHED'; readonly session: NativeSession }> {
      const found = await deps.store.read(input.handoffId, input.sessionId) ?? fail('NATIVE_SESSION_NOT_FOUND');
      const { session: s, version } = found;
      if (input.requester && (input.requester.kind !== s.requester.kind || input.requester.ref !== s.requester.ref)) fail('NATIVE_SESSION_NOT_FOUND');
      if (!input.requester && (!input.confirmTag || input.confirmTag !== s.confirmTag)) fail('NATIVE_CONFIRMATION_INVALID');
      if (s.state !== 'REVIEW_READY' || !s.review || !s.confirmTag) fail(s.state === 'ENDED' ? 'NATIVE_SESSION_ENDED' : 'NATIVE_REVIEW_NOT_READY');
      if (now().getTime() >= Date.parse(s.expiresAt)) { await ended(version, s, 'NATIVE_SESSION_EXPIRED'); fail('NATIVE_SESSION_EXPIRED'); }
      const confirmed = s.review!;
      // The confirmation is used: recorded before the flow is asked.
      const preparing = stamp(s, { state: 'PREPARING_SIGNATURE', confirmTag: null });
      let at = await deps.store.write(version, preparing);
      try {
        let review = confirmed;
        if (Date.parse(confirmed.expiresAt) - now().getTime() < FRESH_MS) {
          const fresh = await prepareReview(preparing);
          if (!noWorse(confirmed, fresh)) {
            const again = stamp(preparing, { state: 'REVIEW_READY', review: fresh, confirmTag: tag() });
            await deps.store.write(at, again);
            await deps.notify(again, 'REVIEW_READY').catch(() => undefined);
            return { kind: 'REFRESHED', session: again };
          }
          review = fresh;
        }
        const surface = await deps.surface(), { workflow } = await verified(surface, s);
        await flowCall(preparing, 'review', [review.runId, review.commitment, workflow]);
        const begun = await flowCall<{ unsignedTransaction: string; walletChain: string }>(preparing, 'begin', [review.runId, s.owner, workflow]);
        const transaction = new Uint8Array(Buffer.from(begun.unsignedTransaction, 'base64')), next = tag();
        const url = signTransactionUrl({ wallet: s.wallet, channel: channelOf(s), walletSession: walletSessionOf(s), redirectLink: callbackUrl(s, next), transaction });
        at = await deps.store.write(at, stamp(preparing, { state: 'AWAITING_SIGNATURE', review, step: { kind: 'sign', tag: next }, walletRequest: url }));
        return { kind: 'WALLET', url };
      } catch (error) {
        const code = codeOf(error, 'NATIVE_SIGNATURE_REQUEST_UNAVAILABLE');
        await ended(at, preparing, code);
        return fail(code);
      }
    },

    /** The wallet request this session waits for now (an idempotent re-open from the conversation), or null. Changes nothing. */
    async pendingRequest(handoffId: string, sessionId: string): Promise<string | null> {
      const found = await deps.store.read(handoffId, sessionId);
      const s = found?.session;
      return s && s.walletRequest && (s.state === 'AWAITING_CONNECT' || s.state === 'AWAITING_PROOF' || s.state === 'AWAITING_SIGNATURE')
        && now().getTime() < Date.parse(s.expiresAt) ? s.walletRequest : null;
    },

    /** One session by its ids (server-side presentation only: never returned to a client as it is). */
    async latestById(handoffId: string, sessionId: string): Promise<NativeSession | null> {
      return (await deps.store.read(handoffId, sessionId))?.session ?? null;
    },

    /** The approval's most recent native session, as its requester may see it (public facts only: never a key, session token or tag). */
    async latest(handoffId: string, requester: RequesterScope): Promise<NativeSession | null> {
      const all = await deps.store.forHandoff(handoffId);
      return all.map(entry => entry.session).find(s => s.requester.kind === requester.kind && s.requester.ref === requester.ref) ?? null;
    },
  };
}
export type NativeSigning = ReturnType<typeof createNativeSigning>;

/**
 * A session as its requester (an MCP panel, a channel) may see it: its state, wallet, Review (with its words in both languages) and outcome. Never a
 * key, wallet session token, step or confirmation tag, the Review's commitment or the run's executable material; the transaction id is public.
 */
export function publicNativeSession(s: NativeSession) {
  const shown = s.state === 'REVIEW_READY' || s.state === 'PREPARING_SIGNATURE' || s.state === 'AWAITING_SIGNATURE' || s.state === 'SUBMITTING' || s.state === 'SUBMITTED';
  const r = shown ? s.review : null;
  return { sessionId: s.id, wallet: s.wallet, state: s.state, expiresAt: s.expiresAt,
    review: r ? { executionId: r.runId, flow: r.flow, action: r.action, network: r.network, owner: r.owner, recipient: r.recipient, pay: r.pay, receive: r.receive,
      maximumNetworkCostLamports: r.maximumNetworkCostLamports, feeToken: r.feeToken, expiresAt: r.expiresAt,
      lines: { EN: nativeReviewLines(r, 'EN'), PT: nativeReviewLines(r, 'PT') } } : null,
    outcome: s.outcome ? { code: s.outcome.code, transactionId: s.outcome.signature, afterSignature: s.outcome.afterSignature === true,
      ...s.state === 'ENDED' ? { text: nativeEndedText(s) } : {} } : null };
}
