// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: learning configuration — server-only, off by default. Any problem disables learning (fail closed): the Copilot then
 * behaves exactly as before this build, with no memory, no glossary and no feedback.
 *
 *   FLOFI_LEARNING          enabled | off (default) — the whole feature (private memory, glossary, feedback)
 *   FLOFI_LEARNING_SECRET   ≥ 32 characters, dedicated: refused when equal to API_AUTH_TOKEN, FLOFI_SESSION_SECRET, FLOFI_CHANNEL_SECRET,
 *                           FLOFI_MCP_OAUTH_SECRET or FLOFI_ADMIN_SESSION_SECRET. Keys the pseudonymous identity digests; rotating it detaches
 *                           every stored memory (a documented reset, never a silent merge).
 *   FLOFI_LEARNING_GLOBAL   enabled (default) | disabled — break-glass: stop serving the global glossary without a database change
 */
import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';

type Env = Readonly<Record<string, string | undefined>>;
export type LearningKeys = { readonly subject: Buffer; readonly contributor: Buffer };
export type LearningConfig = { readonly enabled: true; readonly keys: LearningKeys; readonly global: boolean }
  | { readonly enabled: false; readonly reason: 'OFF' | 'INVALID' | 'SECRET_MISSING' | 'SECRET_INVALID' | 'SECRET_REUSED' };
/** The privacy notice users accept with "Remember" or the contribution switch (`docs/security/LEARNING-PRIVACY.md`). */
export const LEARNING_NOTICE_VERSION = 1;
const OTHER_SECRETS = ['API_AUTH_TOKEN', 'FLOFI_SESSION_SECRET', 'FLOFI_CHANNEL_SECRET', 'FLOFI_MCP_OAUTH_SECRET', 'FLOFI_ADMIN_SESSION_SECRET'] as const;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const same = (a: string, b: string | undefined) => b !== undefined && b !== '' && timingSafeEqual(sha256(a), sha256(b));
const derive = (secret: string, label: string) => Buffer.from(hkdfSync('sha256', secret, 'flofi', `flofi/learning/${label}/v1`, 32));

export function learningConfig(env: Env): LearningConfig {
  const mode = env.FLOFI_LEARNING?.trim() ?? '';
  if (mode === '' || mode === 'off') return { enabled: false, reason: 'OFF' };
  if (mode !== 'enabled') return { enabled: false, reason: 'INVALID' };
  const secret = env.FLOFI_LEARNING_SECRET ?? '';
  if (!secret) return { enabled: false, reason: 'SECRET_MISSING' };
  if (secret.length < 32 || /\s/.test(secret)) return { enabled: false, reason: 'SECRET_INVALID' };
  if (OTHER_SECRETS.some(name => same(secret, env[name]))) return { enabled: false, reason: 'SECRET_REUSED' };
  const global = env.FLOFI_LEARNING_GLOBAL?.trim();
  if (global !== undefined && global !== '' && global !== 'enabled' && global !== 'disabled') return { enabled: false, reason: 'INVALID' };
  return { enabled: true, keys: Object.freeze({ subject: derive(secret, 'subject'), contributor: derive(secret, 'contributor') }), global: global !== 'disabled' };
}
