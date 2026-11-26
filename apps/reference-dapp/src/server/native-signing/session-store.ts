// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the durable record of one native wallet signing session — an append-only journal in the platform's existing
 * execution log (`execution_logs`, its own namespace; no new table or migration). Every line is the whole session; a line may only follow the one
 * before it as an allowed transition, and the immutable facts (who asked, for which approval, with which wallet and one-time key) never change.
 * Writes are compare-and-swap on the log's version, so of two concurrent callbacks for one step exactly one is recorded: that write IS the step's
 * single use, made before anything else happens. Secrets (FloFi's one-time X25519 key, the wallet's session token) are sealed with AES-256-GCM
 * under a key derived from the deployment's wallet-session key and bound to this session and field; nothing here is ever returned to a client.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { PostgresLogStore } from '@defi-workflow-engine/cloud-runtime';
import type { DeeplinkWallet } from '../../wallet/deeplink/protocol.ts';

export const NATIVE_SESSION_ID = /^nsg_[a-z2-7]{26}$/;
export const NATIVE_TAG = /^[A-Za-z0-9_-]{22}$/;
export type { NativeSigningFlow as NativeFlow } from '../../platform/native-signing.ts';
import type { NativeSigningFlow as NativeFlow } from '../../platform/native-signing.ts';
export type NativeState = 'AWAITING_CONNECT' | 'AWAITING_PROOF' | 'PREPARING_REVIEW' | 'REVIEW_READY' | 'PREPARING_SIGNATURE' | 'AWAITING_SIGNATURE'
  | 'SUBMITTING' | 'SUBMITTED' | 'ENDED';
export type NativeStep = 'connect' | 'signIn' | 'sign';
export type NativeReturn = 'TELEGRAM' | 'CHATGPT' | 'CLAUDE' | 'NONE';
/** What the in-channel Review shows, from the flow's own fresh simulation (public facts; amounts as base-unit strings with their decimals). */
export type NativeReview = {
  readonly flow: NativeFlow; readonly runId: string; readonly commitment: string; readonly expiresAt: string; readonly owner: string; readonly network: string;
  readonly action: 'transfer' | 'swap';
  readonly pay: { readonly symbol: string; readonly amount: string; readonly decimals: number };
  readonly receive: { readonly symbol: string; readonly amount: string; readonly decimals: number; readonly minimum: string | null } | null;
  readonly recipient: string | null;
  /** The most the owner pays in network fees and any account deposit (lamports), or a token fee when a fee payer fronts SOL. */
  readonly maximumNetworkCostLamports: string | null;
  readonly feeToken: { readonly symbol: string; readonly amount: string; readonly decimals: number } | null };
export type NativeSession = {
  readonly v: 1; readonly id: string; readonly wallet: DeeplinkWallet; readonly handoffId: string;
  readonly requester: { readonly kind: 'MCP_ACCOUNT' | 'CHANNEL_CONVERSATION'; readonly ref: string };
  readonly flow: NativeFlow; readonly returnTo: NativeReturn; readonly language: 'EN' | 'PT';
  readonly createdAt: string; readonly expiresAt: string; readonly dappPublicKey: string; readonly dappSecret: string;
  /** The sealed Sign-In With Solana challenge, issued when the wallet connects (five minutes, single use within this session). */
  readonly challenge: string | null;
  readonly state: NativeState; readonly step: { readonly kind: NativeStep; readonly tag: string } | null;
  /** Set by `connect` (an unverified claim until the proof): the account, the wallet's encryption key and its sealed session token. */
  readonly connected: { readonly account: string; readonly walletKey: string; readonly walletSession: string } | null;
  /** The account proven by its Sign-In With Solana signature over this session's challenge. */
  readonly owner: string | null;
  readonly review: NativeReview | null;
  /** The single-use tag the in-channel confirmation must present for exactly this Review. */
  readonly confirmTag: string | null;
  /** `afterSignature`: the session ended after the wallet returned signed bytes (whether they were broadcast is then the flow's to say). */
  readonly outcome: { readonly code: string | null; readonly signature: string | null; readonly attemptState: string | null; readonly afterSignature?: boolean } | null;
  /** The wallet request this session waits for (the exact deeplink: encrypted for the wallet), so the conversation can re-open it; null otherwise. */
  readonly walletRequest: string | null;
  readonly updatedAt: string };

const fail = (code: string): never => { throw new Error(code); };
const ALLOWED: Readonly<Record<NativeState, readonly NativeState[]>> = Object.freeze({
  AWAITING_CONNECT: ['AWAITING_PROOF', 'ENDED'], AWAITING_PROOF: ['PREPARING_REVIEW', 'ENDED'], PREPARING_REVIEW: ['REVIEW_READY', 'ENDED'],
  REVIEW_READY: ['PREPARING_SIGNATURE', 'PREPARING_REVIEW', 'ENDED'], PREPARING_SIGNATURE: ['AWAITING_SIGNATURE', 'REVIEW_READY', 'ENDED'],
  AWAITING_SIGNATURE: ['SUBMITTING', 'ENDED'], SUBMITTING: ['SUBMITTED', 'ENDED'], SUBMITTED: [], ENDED: [] });
const IMMUTABLE = ['v', 'id', 'wallet', 'handoffId', 'requester', 'flow', 'returnTo', 'createdAt', 'expiresAt', 'dappPublicKey', 'dappSecret'] as const;

/** One session's journal must be a chain of allowed transitions over the same immutable facts. */
export function validateNativeJournal(bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || bytes.length > 262_144) fail('NATIVE_SESSION_STORE_CORRUPT');
  let prior: NativeSession | null = null;
  for (const line of text.trimEnd().split('\n')) {
    const s = JSON.parse(line) as NativeSession;
    if (s.v !== 1 || !NATIVE_SESSION_ID.test(s.id) || !(s.state in ALLOWED) || (s.step && !NATIVE_TAG.test(s.step.tag))) fail('NATIVE_SESSION_STORE_CORRUPT');
    if (prior) {
      if (IMMUTABLE.some(key => JSON.stringify(s[key]) !== JSON.stringify(prior![key]))) fail('NATIVE_SESSION_STORE_CORRUPT');
      if (!ALLOWED[prior.state].includes(s.state)) fail('NATIVE_SESSION_STORE_CORRUPT');
      // What a proof established never changes; a connected account is never replaced.
      if (prior.owner && s.owner !== prior.owner || prior.connected && s.connected?.account !== prior.connected.account
        || prior.challenge && s.challenge !== prior.challenge) fail('NATIVE_SESSION_STORE_CORRUPT');
    } else if (s.state !== 'AWAITING_CONNECT' || s.owner || s.connected || s.review || s.challenge) fail('NATIVE_SESSION_STORE_CORRUPT');
    prior = s;
  }
}

/** Seals a short secret for one session field (AES-256-GCM, 96-bit random nonce, AAD = tenant, session and field). */
export type Sealer = { readonly seal: (sessionId: string, field: string, plain: Uint8Array) => string; readonly open: (sessionId: string, field: string, sealed: string) => Uint8Array };
export function nativeSealer(walletSessionKey: Buffer, tenantId: string): Sealer {
  const key = Buffer.from(hkdfSync('sha256', walletSessionKey, 'flofi', 'flofi/native-signing/v1', 32));
  const aad = (sessionId: string, field: string) => Buffer.from(`${tenantId}\u0000${sessionId}\u0000${field}`, 'utf8');
  return {
    seal(sessionId, field, plain) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(sessionId, field));
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return `g1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
    },
    open(sessionId, field, sealed) {
      const raw = typeof sealed === 'string' && sealed.startsWith('g1.') ? Buffer.from(sealed.slice(3), 'base64url') : null;
      if (!raw || raw.length < 29) return fail('NATIVE_SESSION_SEAL_INVALID');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAAD(aad(sessionId, field)); decipher.setAuthTag(raw.subarray(12, 28));
        return new Uint8Array(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
      } catch { return fail('NATIVE_SESSION_SEAL_INVALID'); }
    },
  };
}

export type NativeSessionStore = {
  readonly create: (session: NativeSession) => Promise<void>;
  readonly read: (handoffId: string, id: string) => Promise<{ readonly session: NativeSession; readonly version: number } | null>;
  /** The approval's sessions, newest first (bounded). */
  readonly forHandoff: (handoffId: string) => Promise<readonly { readonly session: NativeSession; readonly version: number }[]>;
  /** Appends `next` only if the journal is still at `version` (NATIVE_SESSION_CHANGED otherwise: another request recorded first). */
  readonly write: (version: number, next: NativeSession) => Promise<number>;
};
const HANDOFF_ID = /^apr_[a-z2-7]{26}$/;
/** `<approval>.<session>.jsonl`: a session is read by both ids (the callback URL carries both), and an approval's sessions are listed by prefix. */
const nameOf = (handoffId: string, id: string) => HANDOFF_ID.test(handoffId) && NATIVE_SESSION_ID.test(id) ? `${handoffId}.${id}.jsonl` : fail('NATIVE_SESSION_NOT_FOUND');
const encode = (s: NativeSession) => new TextEncoder().encode(JSON.stringify(s) + '\n');
export function createNativeSessionStore(log: PostgresLogStore): NativeSessionStore {
  async function read(handoffId: string, id: string) {
    if (!HANDOFF_ID.test(handoffId) || !NATIVE_SESSION_ID.test(id)) return null;
    const stored = await log.readVersioned(nameOf(handoffId, id));
    if (!stored) return null;
    validateNativeJournal(stored.bytes);
    const lines = new TextDecoder().decode(stored.bytes).trimEnd().split('\n');
    const session = JSON.parse(lines.at(-1)!) as NativeSession;
    return session.handoffId === handoffId && session.id === id ? { session, version: stored.version } : null;
  }
  return {
    async create(session) {
      validateNativeJournal(encode(session));
      if (!await log.create(nameOf(session.handoffId, session.id), encode(session))) fail('NATIVE_SESSION_EXISTS');
    },
    read,
    async forHandoff(handoffId) {
      if (!HANDOFF_ID.test(handoffId)) return [];
      const names = await log.list(`${handoffId}.nsg_`, 32), out: { session: NativeSession; version: number }[] = [];
      for (const name of names) { const found = await read(handoffId, name.slice(handoffId.length + 1, -'.jsonl'.length)); if (found) out.push(found); }
      return out.sort((a, b) => Date.parse(b.session.createdAt) - Date.parse(a.session.createdAt));
    },
    async write(version, next) {
      const name = nameOf(next.handoffId, next.id), stored = await log.readVersioned(name);
      if (!stored || stored.version !== version) return fail('NATIVE_SESSION_CHANGED');
      const bytes = new Uint8Array(Buffer.concat([Buffer.from(stored.bytes), Buffer.from(encode(next))]));
      try { return await log.extendAt(name, version, bytes, validateNativeJournal); }
      catch (error) {
        if (error instanceof Error && error.message === 'EXECUTION_VERSION_CONFLICT') return fail('NATIVE_SESSION_CHANGED');
        throw error;
      }
    },
  };
}
