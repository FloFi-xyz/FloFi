// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: whether this deployment serves the private Admin console, and its own session key.
 *
 * `FLOFI_ADMIN=enabled` plus a dedicated `FLOFI_ADMIN_SESSION_SECRET` (32–512 characters, `openssl rand -hex 32`). The secret must differ
 * from every other FloFi secret, so a wallet-session, API, channel, automation, developer or MCP key can never seal an admin session.
 * Anything else leaves the console off: `/admin` answers 404 and its APIs refuse. Server-only; never `NEXT_PUBLIC_*`.
 */
import { hkdfSync } from 'node:crypto';

type Env = Readonly<Record<string, string | undefined>>;
export type AdminConfig = { readonly enabled: true; readonly key: Buffer } | { readonly enabled: false; readonly code: string };

/** Every other secret FloFi reads; the admin key must equal none of them. */
const OTHER_SECRETS = ['FLOFI_SESSION_SECRET', 'API_AUTH_TOKEN', 'FLOFI_CHANNEL_SECRET', 'FLOFI_AUTOMATION_SECRET', 'FLOFI_DEVELOPER_SECRET', 'FLOFI_MCP_OAUTH_SECRET',
  'FLOFI_WEBHOOK_SECRET', 'FLOFI_API_KEY', 'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET',
  'WHATSAPP_APP_SECRET_PREVIOUS', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'OBJECT_STORE_SECRET_ACCESS_KEY', 'LIFI_API_KEY', 'ACROSS_API_KEY',
  'JUPITER_API_KEY', 'GRYLOO_ALCHEMY_API_KEY', 'VERCEL_AUTOMATION_BYPASS_SECRET', 'CRON_SECRET'] as const;

export function adminConfig(env: Env): AdminConfig {
  if (env.FLOFI_ADMIN !== 'enabled') return { enabled: false, code: 'ADMIN_NOT_ENABLED' };
  const secret = env.FLOFI_ADMIN_SESSION_SECRET ?? '';
  if (secret.length < 32 || secret.length > 512 || /\s/.test(secret)) return { enabled: false, code: 'ADMIN_SESSION_SECRET_INVALID' };
  if (OTHER_SECRETS.some(name => env[name] === secret)) return { enabled: false, code: 'ADMIN_SESSION_SECRET_REUSED' };
  return { enabled: true, key: Buffer.from(hkdfSync('sha256', secret, 'flofi', 'flofi/admin-session/v1', 32)) };
}
