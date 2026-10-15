// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: learning configuration — server-only, off by default. Any problem disables learning (fail closed): the Copilot then
 * behaves exactly as before this build, with no memory, no glossary and no feedback.
 *
 *   FLOFI_LEARNING          off (default) | session | enabled
 *                           session (BUILD-CHAT-LEARNING-002): in-conversation adaptation only — corrections, answers to FloFi's questions and
 *                           statements adapt the rest of the conversation; nothing is stored and no database or secret is used.
 *                           enabled: adaptation plus the stored tiers below (private memory, glossary, content-free feedback).
 *   FLOFI_LEARNING_SECRET   ≥ 32 characters, dedicated: refused when equal to API_AUTH_TOKEN, FLOFI_SESSION_SECRET, FLOFI_CHANNEL_SECRET,
 *                           FLOFI_MCP_OAUTH_SECRET or FLOFI_ADMIN_SESSION_SECRET. Keys the pseudonymous identity digests; rotating it detaches
 *                           every stored memory (a documented reset, never a silent merge).
 *   FLOFI_LEARNING_GLOBAL   enabled (default) | disabled — break-glass: stop serving the global glossary without a database change
 *   FLOFI_LEARNING_AUTOMATIC  off (default) | consent | legitimate_interest — BUILD-CHAT-LEARNING-002: persistent automatic learning per verified
 *                           identity, and the legal basis it runs under (an owner/counsel decision, `docs/security/LEARNING-PRIVACY.md`). off:
 *                           nothing observed is stored. consent: only for identities that turned it on in Privacy settings. legitimate_interest:
 *                           for every verified identity that did not object there. Requires FLOFI_LEARNING=enabled.
 */
import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';

type Env = Readonly<Record<string, string | undefined>>;
/** BUILD-CHAT-LEARNING-002 `evidence`: keys the per-request and per-conversation digests that count automatic-learning evidence once. */
export type LearningKeys = { readonly subject: Buffer; readonly contributor: Buffer; readonly evidence: Buffer };
/** BUILD-CHAT-LEARNING-002: under which legal basis persistent automatic learning runs on this deployment (OFF: it does not). */
export type AutomaticMode = 'OFF' | 'CONSENT' | 'LEGITIMATE_INTEREST';
export type LearningConfig = { readonly enabled: true; readonly keys: LearningKeys; readonly global: boolean; readonly automatic: AutomaticMode }
  | { readonly enabled: false; readonly reason: 'OFF' | 'SESSION_ONLY' | 'INVALID' | 'SECRET_MISSING' | 'SECRET_INVALID' | 'SECRET_REUSED' };
/**
 * The privacy notice a choice was recorded under (`docs/security/LEARNING-PRIVACY.md`). v1: BUILD-CHAT-LEARNING-001's "Remember" offer. v2:
 * BUILD-CHAT-LEARNING-002 — automatic learning in three tiers. Consent to automatic learning needs v2; v1 consents keep covering what they covered.
 */
export const LEARNING_NOTICE_VERSION = 2;
const OTHER_SECRETS = ['API_AUTH_TOKEN', 'FLOFI_SESSION_SECRET', 'FLOFI_CHANNEL_SECRET', 'FLOFI_MCP_OAUTH_SECRET', 'FLOFI_ADMIN_SESSION_SECRET'] as const;
const AUTOMATIC: Readonly<Record<string, AutomaticMode>> = { '': 'OFF', off: 'OFF', consent: 'CONSENT', legitimate_interest: 'LEGITIMATE_INTEREST' };
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const same = (a: string, b: string | undefined) => b !== undefined && b !== '' && timingSafeEqual(sha256(a), sha256(b));
const derive = (secret: string, label: string) => Buffer.from(hkdfSync('sha256', secret, 'flofi', `flofi/learning/${label}/v1`, 32));

export function learningConfig(env: Env): LearningConfig {
  const mode = env.FLOFI_LEARNING?.trim() ?? '';
  if (mode === '' || mode === 'off') return { enabled: false, reason: 'OFF' };
  if (mode === 'session') return { enabled: false, reason: 'SESSION_ONLY' };
  if (mode !== 'enabled') return { enabled: false, reason: 'INVALID' };
  const secret = env.FLOFI_LEARNING_SECRET ?? '';
  if (!secret) return { enabled: false, reason: 'SECRET_MISSING' };
  if (secret.length < 32 || /\s/.test(secret)) return { enabled: false, reason: 'SECRET_INVALID' };
  if (OTHER_SECRETS.some(name => same(secret, env[name]))) return { enabled: false, reason: 'SECRET_REUSED' };
  const global = env.FLOFI_LEARNING_GLOBAL?.trim();
  if (global !== undefined && global !== '' && global !== 'enabled' && global !== 'disabled') return { enabled: false, reason: 'INVALID' };
  const automatic = AUTOMATIC[env.FLOFI_LEARNING_AUTOMATIC?.trim() ?? ''];
  if (!automatic) return { enabled: false, reason: 'INVALID' };
  return { enabled: true, keys: Object.freeze({ subject: derive(secret, 'subject'), contributor: derive(secret, 'contributor'),
    evidence: derive(secret, 'evidence') }), global: global !== 'disabled', automatic };
}
/** BUILD-CHAT-LEARNING-002: in-conversation adaptation runs on this deployment (session mode, or learning enabled). Nothing stored for it. */
export function sessionAdaptation(env: Env): boolean {
  const config = learningConfig(env);
  return config.enabled || config.reason === 'SESSION_ONLY';
}
