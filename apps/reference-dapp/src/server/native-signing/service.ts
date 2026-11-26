// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native wallet signing from a conversation, with no FloFi page to complete.
 *
 *   start      the conversation asks for its approval to be signed with Phantom or Solflare: a one-time X25519 key and a session; the answer
 *              is the wallet's own `connect` deeplink (the conversation opens it; nothing is signed)
 *   connect    the wallet names an account (unauthenticated) → FloFi asks that wallet to sign its Sign-In With Solana challenge
 *   signIn     the Ed25519 signature over the exact challenge proves the account (FloFi's existing SIWS verifier) → the flow's own fresh simulation
 *              for that proven wallet, then the existing claim and apply of the approval (the requester's own claim rule included). Its Review is
 *              presented IN the conversation (the channel posts it; an MCP host's panel reads it) AND to the signer, on the page their wallet returns
 *              to, with where the request came from — so whoever signs has seen FloFi's Review, even when they are not the conversation's owner
 *   confirm    the conversation confirms that exact Review (its single-use reference) → the flow's Review acceptance and `begin` (fresh checks,
 *              durable PREPARED, the exact unsigned bytes) → the wallet's `signTransaction` deeplink with those bytes
 *   sign       the wallet returns the signed bytes → the flow's `submit` (exact reviewed bytes and owner signature verified, signature durable,
 *              one broadcast by FloFi) → automatic observation and reconciliation as for every run; the receipt reaches the conversation through
 *              the approval's existing status notifications
 *
 * Each wallet returns to `/api/native-signing/<approval>/<session>/<tag>`; the tag is an HMAC of the session, its step and a stored nonce (never
 * stored itself). A step is recorded as used (compare-and-swap) BEFORE its effect, so of concurrent answers exactly one acts. An answer that does
 * not open under this session's key, or a proof that does not verify, is refused without ending the session. A wallet REFUSAL is plain text by
 * protocol: whoever holds a callback URL can end that session (nothing more), and nothing is ever sent by it. One approval is sent at most once:
 * no new session or confirmation while another may have sent it or holds an open wallet request. FloFi never holds or uses a key that can sign for
 * the owner: the wallet signs, and the flow broadcasts only the exact reviewed bytes it verified.
 */
import { randomBytes } from 'node:crypto';
import { claimApproval, applyApproval, isNativeSigningFlow, nativeSigningEligible, openApprovalSession, typedId, verifyHandoff, type ApprovalRequester,
  type ApprovalSurface, type HandoffRecord, type RequesterScope } from '../../platform/index.ts';
import { issueWalletChallenge, solanaChallengeMessage, verifySolanaSignIn } from '../wallet-session.ts';
import type { BetaRequestIdentity } from '../../flight/beta-context.ts';
import { base58DecodeBytes as base58Decode, base58EncodeBytes as base58Encode } from './deeplink/base58.ts';
import { boxKeyPair } from './deeplink/nacl-box.ts';
import { connectUrl, connectedAccount, DEEPLINK_WALLETS, openAnswer, signedMessage, signedTransaction, signMessageUrl, signTransactionUrl,
  type DeeplinkCluster, type DeeplinkWallet } from './deeplink/protocol.ts';
import { nativeEndedText } from './messages.ts';
import { nativeReviewLines, nativeReviewOf } from './review.ts';
import { NATIVE_TAG, type NativeFlow, type NativeReturn, type NativeReview, type NativeSession, type NativeSessionStore, type NativeState, type NativeStep,
  type Sealer } from './session-store.ts';

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
/** Sessions one approval may have (a bounded journal listing; a person retrying a few times never reaches it). */
export const MAX_SESSIONS_PER_APPROVAL = 16;
/** A confirmed Review with less validity left than this is simulated again before the wallet is asked (the wallet hop itself takes time). */
const FRESH_MS = 45_000;
/** A prepared wallet request this long past its Review's validity can no longer be broadcast by FloFi (the flow's submit refuses it; its blockhash lapsed). */
const LAPSED_MS = 120_000;
const sameAmount = (a: { symbol: string; amount: string; decimals: number }, b: { symbol: string; amount: string; decimals: number }) =>
  a.symbol === b.symbol && a.amount === b.amount && a.decimals === b.decimals;
/** Whether a fresh Review's terms are no worse for the owner than the confirmed one's. */
export function noWorse(confirmed: NativeReview, fresh: NativeReview): boolean {
  if (fresh.flow !== confirmed.flow || fresh.action !== confirmed.action || fresh.owner !== confirmed.owner || fresh.network !== confirmed.network
    || fresh.recipient !== confirmed.recipient || !sameAmount(fresh.pay, confirmed.pay)) return false;
  if (confirmed.receive) {
    const r = fresh.receive;
    if (!r || r.symbol !== confirmed.receive.symbol || r.decimals !== confirmed.receive.decimals) return false;
    if (confirmed.receive.minimum !== null) {
      // The guaranteed minimum never drops, and the fresh estimate itself is at least what was guaranteed (a coherent quote).
      if (r.minimum === null || BigInt(r.minimum) < BigInt(confirmed.receive.minimum) || BigInt(r.amount) < BigInt(r.minimum)) return false;
    }
  } else if (fresh.receive) return false;
  if (confirmed.feeToken) return !!fresh.feeToken && fresh.maximumNetworkCostLamports === null && fresh.feeToken.symbol === confirmed.feeToken.symbol
    && fresh.feeToken.decimals === confirmed.feeToken.decimals && BigInt(fresh.feeToken.amount) <= BigInt(confirmed.feeToken.amount);
  return !fresh.feeToken && confirmed.maximumNetworkCostLamports !== null && fresh.maximumNetworkCostLamports !== null
    && BigInt(fresh.maximumNetworkCostLamports) <= BigInt(confirmed.maximumNetworkCostLamports);
}

export type NativeFlowPort = <T>(flow: NativeFlow, method: string, args: readonly unknown[], context: { readonly principal: string;
  readonly betaIdentity: BetaRequestIdentity | null }) => Promise<Result<T>>;
/** `REVIEW_RENEWED`: FloFi simulated again at the confirmation and asked the wallet with those (no worse) terms. */
export type NativeEvent = 'REVIEW_READY' | 'REVIEW_RENEWED' | 'SUBMITTED' | 'ENDED';
export type NativeDeps = {
  readonly env: Env; readonly origin: string; readonly store: NativeSessionStore; readonly sealer: Sealer;
  readonly surface: () => Promise<ApprovalSurface>; readonly flow: NativeFlowPort;
  /**
   * The conversation's own delivery of a session event (a channel posts it; an MCP panel reads the status instead). `confirmRef` is the Review's
   * single-use reference (REVIEW_READY only). Failures never change the session.
   */
  readonly notify: (session: NativeSession, event: NativeEvent, confirmRef: string | null) => Promise<void>;
  /** The Flight (beta) identity the requester carries, where the deployment's beta access needs one. */
  readonly betaIdentity: (requester: NativeSession['requester']) => Promise<BetaRequestIdentity | null>;
  /** An exclusive section per approval across instances (its confirmations); absent: in-process only (tests). */
  readonly lock?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  readonly now?: () => Date };
/** What a wallet's return to FloFi produces: the next wallet request, or a short page (the signer's Review after the proof, or where to go next). */
export type NativeOutcome = { readonly kind: 'WALLET'; readonly url: string }
  | { readonly kind: 'PAGE'; readonly page: 'METADATA' | 'REVIEW' | 'RETURN' | 'IGNORED' | 'ENDED'; readonly code: string | null; readonly session: NativeSession | null };

const fail = (code: string): never => { throw new Error(code); };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const codeOf = (error: unknown, fallback: string) => error instanceof Error && CODE.test(error.message) ? error.message : fallback;
const nonce = () => randomBytes(16).toString('base64url');
const unwrap = <T,>(result: Result<T>): T => result.ok ? result.value : fail(result.code);
const TERMINAL: readonly NativeState[] = ['SUBMITTED', 'ENDED'];
const SENT: readonly NativeState[] = ['SUBMITTING', 'SUBMITTED'];
type RunFacts = { readonly attempt?: { readonly state?: string; readonly signature?: string | null } | null; readonly verdict?: string; readonly error?: string | null;
  readonly review?: { readonly expiresAt?: string } };

export function createNativeSigning(deps: NativeDeps) {
  const now = deps.now ?? (() => new Date());
  const domain = new URL(deps.origin).host;
  const local = new Map<string, Promise<unknown>>();
  // In-process fallback: one at a time per key.
  const lock = deps.lock ?? (<T,>(key: string, action: () => Promise<T>): Promise<T> => {
    const prior = local.get(key) ?? Promise.resolve(), run = prior.catch(() => undefined).then(action);
    local.set(key, run); return run;
  });
  const tagOf = (s: Pick<NativeSession, 'id'>, kind: NativeStep | 'confirm', n: string) => deps.sealer.mac(s.id, kind, n);
  const callbackUrl = (s: Pick<NativeSession, 'handoffId' | 'id'>, kind: NativeStep, n: string) =>
    `${deps.origin}/api/native-signing/${s.handoffId}/${s.id}/${tagOf(s, kind, n)}`;
  const channelOf = (s: NativeSession) => ({ dappPublicKey: base58Decode(s.dappPublicKey), dappSecretKey: deps.sealer.open(s.id, 'dapp', s.dappSecret) });
  const walletSessionOf = (s: NativeSession) => {
    const c = s.connected ?? fail('NATIVE_SESSION_NOT_CONNECTED');
    return { walletPublicKey: base58Decode(c.walletKey), session: new TextDecoder().decode(deps.sealer.open(s.id, 'wallet-session', c.walletSession)) };
  };
  const stamp = (s: NativeSession, patch: Partial<NativeSession>): NativeSession => ({ ...s, ...patch, updatedAt: now().toISOString() });
  const beta = (s: NativeSession) => deps.betaIdentity(s.requester);
  /**
   * Ends a session — only if this write wins (compare-and-swap). The conversation is told only then; a lost write returns what is stored instead
   * (another answer already moved the session on, and that answer's outcome is the one to tell).
   */
  const ended = async (version: number, s: NativeSession, code: string, facts: { readonly afterSignature?: boolean; readonly attemptState?: string | null;
    readonly signature?: string | null } = {}): Promise<NativeSession> => {
    const next = stamp(s, { state: 'ENDED', step: null, confirmNonce: null, walletRequest: null, outcome: { code, signature: facts.signature ?? s.outcome?.signature ?? null,
      attemptState: facts.attemptState ?? s.outcome?.attemptState ?? null, afterSignature: facts.afterSignature ?? SENT.includes(s.state) } });
    try { await deps.store.write(version, next); }
    catch { return (await deps.store.read(s.handoffId, s.id))?.session ?? s; }
    await deps.notify(next, 'ENDED', null).catch(() => undefined);
    return next;
  };
  const flowCall = async <T,>(s: NativeSession, method: string, args: readonly unknown[]) =>
    unwrap(await deps.flow<T>(s.flow, method, args, { principal: s.owner ?? fail('NATIVE_OWNER_UNPROVEN'), betaIdentity: await beta(s) }));

  /** The approval as its requester sees it, re-verified now, with the exact canonical workflow it holds. */
  async function verified(surface: ApprovalSurface, s: Pick<NativeSession, 'handoffId' | 'requester'>) {
    const h = await surface.handoffs.forRequester(s.handoffId, s.requester, now()) ?? fail('APPROVAL_NOT_FOUND');
    if (!nativeEligible(h)) fail('NATIVE_SIGNING_NOT_AVAILABLE_FOR_THIS_OPERATION');
    const profile = surface.profiles[h.requesterKind] ?? fail('APPROVAL_NOT_FOUND');
    const check = await verifyHandoff(h, surface.runtime, profile.policy);
    if (!check.ok) return fail(check.code);
    return { h, workflow: check.composition.workflow };
  }
  /** No other session of this approval may have sent it, or hold a wallet request that still can be signed. */
  async function assertNoOtherSession(h: Pick<HandoffRecord, 'handoffId'>, self: string | null) {
    for (const { session: other } of await deps.store.forHandoff(h.handoffId)) {
      if (other.id === self) continue;
      if (SENT.includes(other.state) || other.outcome?.afterSignature) fail('NATIVE_SIGNING_ALREADY_SENT');
      if ((other.state === 'PREPARING_SIGNATURE' || other.state === 'AWAITING_SIGNATURE') && now().getTime() < Date.parse(other.expiresAt))
        fail('NATIVE_SIGNING_WALLET_REQUEST_OPEN');
    }
  }
  /**
   * None of the approval's runs (here, on FloFi's signing page or in another session) has a wallet attempt that could have executed: each is cancelled
   * before signing, proven never executed, or a prepared request long past its Review (the flow can no longer broadcast it).
   */
  async function assertNothingSent(s: NativeSession, h: Pick<HandoffRecord, 'runIds'>) {
    for (const runId of h.runIds) {
      const run = await flowCall<RunFacts>(s, 'status', [runId]), attempt = run.attempt;
      if (!attempt || attempt.state === 'CANCELLED' || run.verdict === 'NOT_EXECUTED') continue;
      const lapsed = attempt.state === 'PREPARED' && !attempt.signature && run.review?.expiresAt && now().getTime() > Date.parse(run.review.expiresAt) + LAPSED_MS;
      if (!lapsed) fail('NATIVE_SIGNING_ALREADY_SENT');
    }
  }

  /**
   * The flow's own fresh simulation for the proven owner, then the approval taken exactly as the signing page does (claim with the requester's own
   * rule, then apply the canonical workflow). Simulating first means a refusal (balances, the Flight beta) leaves the approval as it was. Status
   * sharing with the originating conversation is part of this in-conversation flow (its Review says so).
   */
  async function prepareReview(s: NativeSession): Promise<NativeReview> {
    const surface = await deps.surface(), { h, workflow } = await verified(surface, s), owner = s.owner ?? fail('NATIVE_OWNER_UNPROVEN');
    const wallets = [{ namespace: 'solana' as const, address: owner }];
    // A refresh (or a claim this owner already holds): never another wallet's approval.
    if ((h.status === 'APPLIED' || h.claimed) && (h.claimed?.namespace !== 'solana' || h.claimed.address !== owner)) fail('HANDOFF_ALREADY_CLAIMED');
    await assertNothingSent(s, h);
    const record = await flowCall<{ id: string }>(s, 'simulate', [workflow, owner]);
    const review = nativeReviewOf(s.flow, record);
    if (review.owner !== owner) fail('NATIVE_REVIEW_OWNER_MISMATCH');
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
    // The run must be the approval's own (its status and receipt reach the conversation through it): fail closed when it could not be bound.
    await surface.handoffs.bindRuns(h.handoffId, [review.runId]);
    const bound = await surface.handoffs.forRequester(h.handoffId, s.requester, now());
    if (!bound?.runIds.includes(review.runId)) fail('NATIVE_SIGNING_RUN_LIMIT');
    return review;
  }

  /** A confirmation of `s` with this reference: its Review's (unused) or the one already used (the same wallet request again), else null. */
  const confirmationOf = (s: NativeSession, ref: string): 'NEW' | 'REPEATED' | null =>
    s.confirmNonce && ref === tagOf(s, 'confirm', s.confirmNonce) ? 'NEW' : s.confirmedNonce && ref === tagOf(s, 'confirm', s.confirmedNonce) ? 'REPEATED' : null;

  const service = {
    /** A new session for one of the requester's open native-eligible approvals; the wallet's `connect` deeplink. */
    async start(input: { readonly handoffId: string; readonly requester: RequesterScope; readonly wallet: DeeplinkWallet; readonly returnTo: NativeReturn;
      readonly language: 'EN' | 'PT' }): Promise<{ readonly sessionId: string; readonly connectUrl: string; readonly expiresAt: string; readonly wallet: string }> {
      if (input.requester.kind !== 'MCP_ACCOUNT' && input.requester.kind !== 'CHANNEL_CONVERSATION') fail('NATIVE_SIGNING_NOT_AVAILABLE');
      if (!Object.hasOwn(DEEPLINK_WALLETS, input.wallet)) fail('NATIVE_WALLET_UNSUPPORTED');
      const surface = await deps.surface();
      const { h } = await verified(surface, { handoffId: input.handoffId, requester: input.requester as NativeSession['requester'] });
      // An applied approval may be signed again after a rejection or a failure before anything was sent (checked again at the proof).
      if (h.status !== 'PENDING' && h.status !== 'CLAIMED' && h.status !== 'APPLIED') fail(`APPROVAL_${h.status}`);
      await assertNoOtherSession(h, null);
      if ((await deps.store.forHandoff(h.handoffId)).length >= MAX_SESSIONS_PER_APPROVAL) fail('NATIVE_SESSION_LIMIT');
      const flow = h.plan.flow as NativeFlow, at = now(), id = typedId('nsg'), pair = boxKeyPair();
      const expiresAt = new Date(Math.min(h.expiresAt.getTime(), at.getTime() + NATIVE_SESSION_SECONDS * 1000));
      if (expiresAt.getTime() - at.getTime() < 60_000) fail('APPROVAL_EXPIRED');
      const step = nonce();
      const session: NativeSession = { v: 1, id, wallet: input.wallet, handoffId: h.handoffId, requester: { kind: input.requester.kind as NativeSession['requester']['kind'], ref: input.requester.ref },
        flow, returnTo: input.returnTo, language: input.language, createdAt: at.toISOString(), expiresAt: expiresAt.toISOString(), dappPublicKey: base58Encode(pair.publicKey),
        dappSecret: deps.sealer.seal(id, 'dapp', pair.secretKey), challenge: null, state: 'AWAITING_CONNECT', step: { kind: 'connect', nonce: step },
        connected: null, owner: null, review: null, confirmNonce: null, confirmedNonce: null, outcome: null, walletRequest: null, updatedAt: at.toISOString() };
      const url = connectUrl({ wallet: input.wallet, appUrl: deps.origin, dappPublicKey: pair.publicKey, redirectLink: callbackUrl(session, 'connect', step),
        cluster: NATIVE_FLOWS[flow].cluster });
      await deps.store.create({ ...session, walletRequest: url });
      return { sessionId: id, expiresAt: session.expiresAt, wallet: DEEPLINK_WALLETS[input.wallet].name, connectUrl: url };
    },

    /**
     * A wallet returned to FloFi (`/api/native-signing/<approval>/<session>/<tag>?…`). Of two answers racing for one step, the one whose write lost
     * changes nothing and is answered with what the winner recorded.
     */
    async callback(handoffId: string, sessionId: string, stepTag: string, params: URLSearchParams): Promise<NativeOutcome> {
      try { return await answerOf(handoffId, sessionId, stepTag, params); }
      catch (error) {
        if (!(error instanceof Error && error.message === 'NATIVE_SESSION_CHANGED')) throw error;
        const s = (await deps.store.read(handoffId, sessionId))?.session ?? null;
        return { kind: 'PAGE', page: !s ? 'IGNORED' : s.state === 'ENDED' ? 'ENDED' : SENT.includes(s.state) ? 'RETURN' : 'IGNORED',
          code: s?.outcome?.code ?? 'NATIVE_STEP_ALREADY_HANDLED', session: s };
      }
    },
  };
  async function answerOf(handoffId: string, sessionId: string, stepTag: string, params: URLSearchParams): Promise<NativeOutcome> {
      // The wallet may read the redirect link for its own display (no answer parameters): never a state change.
      if (!params.has('errorCode') && !params.has('data')) return { kind: 'PAGE', page: 'METADATA', code: null, session: null };
      const found = NATIVE_TAG.test(stepTag) ? await deps.store.read(handoffId, sessionId) : null;
      if (!found) return { kind: 'PAGE', page: 'IGNORED', code: 'NATIVE_SESSION_NOT_FOUND', session: null };
      const { session: s, version } = found;
      // After the signed bytes arrived, every later answer only learns that: never "nothing was sent".
      if (TERMINAL.includes(s.state) || s.state === 'SUBMITTING')
        return { kind: 'PAGE', page: s.state === 'ENDED' ? 'ENDED' : 'RETURN', code: s.outcome?.code ?? null, session: s };
      if (!s.step || stepTag !== tagOf(s, s.step.kind, s.step.nonce)) return { kind: 'PAGE', page: 'IGNORED', code: 'NATIVE_STEP_ALREADY_HANDLED', session: s };
      if (now().getTime() >= Date.parse(s.expiresAt) && s.state !== 'AWAITING_SIGNATURE')
        return { kind: 'PAGE', page: 'ENDED', code: 'NATIVE_SESSION_EXPIRED', session: await ended(version, s, 'NATIVE_SESSION_EXPIRED') };
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
        // The refusal is recorded first (compare-and-swap); only the write that wins cancels the prepared request (nothing was sent).
        const next = await ended(version, s, answer.code, { afterSignature: false });
        if (next.state === 'ENDED' && next.outcome?.code === answer.code && step === 'sign' && s.review)
          await deps.flow(s.flow, 'walletFailure', [s.review.runId, { stage: 'SIGN', code: `${NATIVE_FLOWS[s.flow].prefix}_WALLET_REJECTED`,
            error: { code: answer.walletCode, message: answer.message ?? '' } }], { principal: s.owner!, betaIdentity: await beta(s) }).catch(() => undefined);
        return { kind: 'PAGE', page: next.state === 'ENDED' ? 'ENDED' : 'RETURN', code: next.outcome?.code ?? answer.code, session: next };
      }
      if (step === 'connect') {
        const connected = connectedAccount(answer);
        const challenge = issueWalletChallenge(deps.env, { domain, uri: deps.origin, now: now() }), next = nonce();
        const updated = stamp(s, { state: 'AWAITING_PROOF', challenge: challenge.token, step: { kind: 'signIn', nonce: next },
          connected: { account: connected.address, walletKey: base58Encode(answer.walletPublicKey),
            walletSession: deps.sealer.seal(s.id, 'wallet-session', new TextEncoder().encode(connected.session)) } });
        const message = solanaChallengeMessage(deps.env, { challengeToken: challenge.token, domain, uri: deps.origin, address: connected.address, now: now() });
        const url = signMessageUrl({ wallet: s.wallet, channel: channelOf(s), walletSession: walletSessionOf(updated), redirectLink: callbackUrl(s, 'signIn', next), message });
        await deps.store.write(version, { ...updated, walletRequest: url });
        return { kind: 'WALLET', url };
      }
      if (step === 'signIn') {
        const account = s.connected!.account;
        try {
          verifySolanaSignIn(deps.env, { challengeToken: s.challenge ?? undefined, domain, uri: deps.origin, address: account,
            signature: Buffer.from(signedMessage(answer)).toString('base64'), now: now() });
        } catch (error) {
          const code = codeOf(error, 'WALLET_SIGNATURE_INVALID');
          // The sign-in challenge lived five minutes: a proof after that can never verify, so the session ends (a new one starts over).
          if (code === 'WALLET_SIGN_IN_CHALLENGE_INVALID') return { kind: 'PAGE', page: 'ENDED', code: 'NATIVE_PROOF_EXPIRED', session: await ended(version, s, 'NATIVE_PROOF_EXPIRED') };
          return { kind: 'PAGE', page: 'IGNORED', code, session: s };
        }
        // The proof is used: recorded before anything depends on it.
        const proving = stamp(s, { state: 'PREPARING_REVIEW', owner: account, step: null, walletRequest: null });
        const at = await deps.store.write(version, proving);
        try {
          const review = await prepareReview(proving), confirm = nonce();
          const ready = stamp(proving, { state: 'REVIEW_READY', review, confirmNonce: confirm });
          await deps.store.write(at, ready);
          await deps.notify(ready, 'REVIEW_READY', tagOf(ready, 'confirm', confirm)).catch(() => undefined);
          // The signer sees FloFi's Review too, on this page in their own browser, with where the request came from.
          return { kind: 'PAGE', page: 'REVIEW', code: null, session: ready };
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
      const submitted = await deps.flow<RunFacts>(s.flow, 'submit', [review.runId, Buffer.from(bytes).toString('base64')], { principal: s.owner!, betaIdentity: await beta(s) })
        .catch(error => ({ ok: false as const, code: codeOf(error, 'NATIVE_SUBMISSION_UNKNOWN') }));
      const observe = async () => { await deps.flow(s.flow, 'observe', [review.runId], { principal: s.owner!, betaIdentity: await beta(s) }).catch(() => undefined); };
      if (!submitted.ok) {
        // A failed call is not proof that nothing was broadcast: the flow's own journal decides, and the run is observed.
        await observe();
        return { kind: 'PAGE', page: 'ENDED', code: submitted.code, session: await ended(at, submitting, submitted.code, { afterSignature: true }) };
      }
      const attempt = submitted.value.attempt ?? null, attemptState = attempt?.state ?? null, signature = attempt?.signature ?? null;
      // The flow refused the bytes before any broadcast (changed, mis-signed or stale), or proved it never executed: nothing was sent.
      if (attemptState === 'CANCELLED' || submitted.value.verdict === 'NOT_EXECUTED') {
        const code = submitted.value.error ?? 'NATIVE_SUBMISSION_REFUSED';
        return { kind: 'PAGE', page: 'ENDED', code, session: await ended(at, submitting, code, { afterSignature: false, attemptState }) };
      }
      if (!signature) {
        // Handed on (a fee payer's answer was lost) with no transaction id yet: it may have been sent; observation decides, never a second send.
        await observe();
        const code = submitted.value.error ?? 'NATIVE_SUBMISSION_UNKNOWN';
        return { kind: 'PAGE', page: 'ENDED', code, session: await ended(at, submitting, code, { afterSignature: true, attemptState }) };
      }
      const done = stamp(submitting, { state: 'SUBMITTED', outcome: { code: submitted.value.error ?? null, signature, attemptState, afterSignature: true } });
      // The broadcast is the flow's durable fact; a failed write here only leaves the session reading SUBMITTING (still "sent", never "nothing").
      await deps.store.write(at, done).catch(() => undefined);
      // One observation now; the deployment's worker keeps observing until the run reconciles (as for every run).
      await observe();
      await deps.notify(done, 'SUBMITTED', null).catch(() => undefined);
      return { kind: 'PAGE', page: 'RETURN', code: null, session: done };
  }

  return {
    ...service,
    /**
     * The conversation confirmed this exact Review: `confirmRef` is its single-use reference (a channel's confirm link carries it; an MCP panel
     * receives it outside model context). Repeating the same confirmation returns the same wallet request (never a second one). A Review with less
     * than FRESH_MS of validity left is simulated again at once, so the whole validity covers the hop to the wallet; FloFi goes on only when those
     * fresh terms are no worse than the confirmed ones (same amounts, assets, recipient and owner; the fee at most, the minimum received at least),
     * and then tells the conversation which terms went to the wallet. Otherwise the fresh Review is presented again and nothing reaches the wallet.
     * One confirmation per approval at a time; never while another session may have sent it or holds an open wallet request.
     */
    async confirm(input: { readonly handoffId: string; readonly sessionId: string; readonly confirmRef: string; readonly requester?: RequesterScope }):
      Promise<{ readonly kind: 'WALLET'; readonly url: string } | { readonly kind: 'REFRESHED'; readonly session: NativeSession }> {
      return lock(`${input.handoffId}.confirm`, async () => {
        const found = await deps.store.read(input.handoffId, input.sessionId) ?? fail('NATIVE_SESSION_NOT_FOUND');
        const { session: s, version } = found;
        if (input.requester && (input.requester.kind !== s.requester.kind || input.requester.ref !== s.requester.ref)) fail('NATIVE_SESSION_NOT_FOUND');
        const kind = typeof input.confirmRef === 'string' ? confirmationOf(s, input.confirmRef) : null;
        if (!kind) fail('NATIVE_CONFIRMATION_INVALID');
        if (kind === 'REPEATED') {
          if (s.state === 'AWAITING_SIGNATURE' && s.walletRequest && now().getTime() < Date.parse(s.expiresAt)) return { kind: 'WALLET' as const, url: s.walletRequest };
          return fail(s.state === 'PREPARING_SIGNATURE' ? 'NATIVE_CONFIRMATION_IN_PROGRESS' : 'NATIVE_CONFIRMATION_USED');
        }
        if (s.state !== 'REVIEW_READY' || !s.review) fail('NATIVE_REVIEW_NOT_READY');
        if (now().getTime() >= Date.parse(s.expiresAt)) { await ended(version, s, 'NATIVE_SESSION_EXPIRED'); fail('NATIVE_SESSION_EXPIRED'); }
        const confirmed = s.review!;
        // The confirmation is used: recorded before the flow is asked (and kept, so the same confirmation again returns the same request).
        const preparing = stamp(s, { state: 'PREPARING_SIGNATURE', confirmNonce: null, confirmedNonce: s.confirmNonce });
        let at = await deps.store.write(version, preparing);
        try {
          const surface = await deps.surface(), { h, workflow } = await verified(surface, s);
          await assertNoOtherSession(h, s.id);
          let review = confirmed;
          if (Date.parse(confirmed.expiresAt) - now().getTime() < FRESH_MS) {
            const fresh = await prepareReview(preparing);
            if (!noWorse(confirmed, fresh)) {
              const again = stamp(preparing, { state: 'REVIEW_READY', review: fresh, confirmNonce: nonce(), confirmedNonce: null });
              await deps.store.write(at, again);
              await deps.notify(again, 'REVIEW_READY', tagOf(again, 'confirm', again.confirmNonce!)).catch(() => undefined);
              return { kind: 'REFRESHED' as const, session: again };
            }
            review = fresh;
          } else await assertNothingSent(preparing, h);
          await flowCall(preparing, 'review', [review.runId, review.commitment, workflow]);
          const begun = await flowCall<{ unsignedTransaction: string; walletChain: string }>(preparing, 'begin', [review.runId, s.owner, workflow]);
          const transaction = new Uint8Array(Buffer.from(begun.unsignedTransaction, 'base64')), next = nonce();
          const url = signTransactionUrl({ wallet: s.wallet, channel: channelOf(s), walletSession: walletSessionOf(s), redirectLink: callbackUrl(s, 'sign', next), transaction });
          const awaiting = stamp(preparing, { state: 'AWAITING_SIGNATURE', review, step: { kind: 'sign', nonce: next }, walletRequest: url });
          at = await deps.store.write(at, awaiting);
          if (review !== confirmed) await deps.notify(awaiting, 'REVIEW_RENEWED', null).catch(() => undefined);
          return { kind: 'WALLET' as const, url };
        } catch (error) {
          const code = codeOf(error, 'NATIVE_SIGNATURE_REQUEST_UNAVAILABLE');
          await ended(at, preparing, code);
          return fail(code);
        }
      });
    },

    /** The wallet request the requester's own session waits for now (an idempotent re-open from its panel), or null. Changes nothing. */
    async reopen(handoffId: string, sessionId: string, requester: RequesterScope): Promise<string | null> {
      const s = (await deps.store.read(handoffId, sessionId))?.session;
      if (!s || s.requester.kind !== requester.kind || s.requester.ref !== requester.ref) return null;
      return s.walletRequest && (s.state === 'AWAITING_CONNECT' || s.state === 'AWAITING_PROOF' || s.state === 'AWAITING_SIGNATURE')
        && now().getTime() < Date.parse(s.expiresAt) ? s.walletRequest : null;
    },

    /** One session by its ids (server-side presentation only: never returned to a client as it is). */
    async latestById(handoffId: string, sessionId: string): Promise<NativeSession | null> {
      return (await deps.store.read(handoffId, sessionId))?.session ?? null;
    },

    /** The approval's most recent session of this requester, as the requester (`public`) and its owner's panel (`panel`) may see it, or null. */
    async view(handoffId: string, requester: RequesterScope): Promise<{ readonly public: ReturnType<typeof publicNativeSession>; readonly panel: ReturnType<typeof panelNativeSession> } | null> {
      const all = await deps.store.forHandoff(handoffId);
      const s = all.map(entry => entry.session).find(candidate => candidate.requester.kind === requester.kind && candidate.requester.ref === requester.ref);
      if (!s) return null;
      const at = now();
      return { public: publicNativeSession(s, at), panel: panelNativeSession(s, at, s.state === 'REVIEW_READY' && s.confirmNonce ? tagOf(s, 'confirm', s.confirmNonce) : null) };
    },
  };
}
export type NativeSigning = ReturnType<typeof createNativeSigning>;

/** A session as it stands now: one past its validity that is still waiting for the wallet (or the person) reads as expired (no new step can start). */
function current(s: NativeSession, now: Date): NativeSession {
  const waiting = s.state === 'AWAITING_CONNECT' || s.state === 'AWAITING_PROOF' || s.state === 'PREPARING_REVIEW' || s.state === 'REVIEW_READY'
    || s.state === 'PREPARING_SIGNATURE' || s.state === 'AWAITING_SIGNATURE';
  return waiting && now.getTime() >= Date.parse(s.expiresAt)
    ? { ...s, state: 'ENDED', outcome: { code: 'NATIVE_SESSION_EXPIRED', signature: null, attemptState: null, afterSignature: false } } : s;
}
/**
 * What any reader of an approval may see of its native session (a model may read it): the wallet, the state and why it ended. Never the Review's
 * amounts or wallets (the claiming wallet is not revealed to the requester), the session id, a key, a reference or the transaction.
 */
export function publicNativeSession(stored: NativeSession, now: Date = new Date()) {
  const s = current(stored, now);
  return { wallet: s.wallet, state: s.state, expiresAt: s.expiresAt,
    outcome: s.outcome ? { code: s.outcome.code, afterSignature: s.outcome.afterSignature === true, ...s.state === 'ENDED' ? { text: nativeEndedText(s) } : {} } : null };
}
/**
 * What only the owner's own panel receives (outside model context): the session id, the Review in both languages and the single-use reference that
 * binds a confirmation to exactly this Review, then the transaction id once sent. Never a key, a wallet session token or a step tag.
 */
export function panelNativeSession(stored: NativeSession, now: Date = new Date(), reviewRef: string | null = null) {
  const s = current(stored, now);
  const shown = s.state === 'REVIEW_READY' || s.state === 'PREPARING_SIGNATURE' || s.state === 'AWAITING_SIGNATURE' || s.state === 'SUBMITTING' || s.state === 'SUBMITTED';
  const r = shown ? s.review : null;
  return { sessionId: s.id, reviewRef: s.state === 'REVIEW_READY' ? reviewRef : null,
    review: r ? { executionId: r.runId, flow: r.flow, action: r.action, network: r.network, owner: r.owner, recipient: r.recipient, pay: r.pay, receive: r.receive,
      maximumNetworkCostLamports: r.maximumNetworkCostLamports, feeToken: r.feeToken, expiresAt: r.expiresAt,
      lines: { EN: nativeReviewLines(r, 'EN'), PT: nativeReviewLines(r, 'PT') } } : null,
    transactionId: s.outcome?.signature ?? null };
}
