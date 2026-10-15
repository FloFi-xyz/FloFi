// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: learning for FloFi's web chat (server actions only). The learning service runs on the deployment's platform-state
 * database (`platformStateHost`, the same pool as MCP, Developer, Channels and Admin) and only when `FLOFI_LEARNING=enabled` (`learning/config.ts`).
 * During a rolling deployment the platform state may refuse the schema (`SCHEMA_NOT_MIGRATED` before 0013 is applied, `MIGRATION_HISTORY_MISMATCH`
 * for an uncertified newer one): learning is then simply unavailable for that request, and the Copilot works exactly as without it.
 *
 * The principal is read from the sealed session cookies of this request (`session-principal.ts`): a request can choose between the wallets
 * proven in this browser (EVM or Solana), never name one.
 */
import { learningConfig } from '../learning/config.ts';
import type { LearningPrincipal } from '../learning/identity.ts';
import { createLearningService, type LearningService } from '../learning/service.ts';
import { platformStateHost } from './platform-state-host.ts';
import type { WalletPrincipal } from './session-principal.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type LearningNamespace = WalletPrincipal['namespace'];

/** The web learning service; 'OFF' when learning is off or misconfigured, 'UNAVAILABLE' when its storage is unavailable for this request. */
export async function webLearningService(env: Env, open: (env: Env) => Promise<{ db: Parameters<typeof createLearningService>[0]['host']['db']; tenantId: string }>
  = platformStateHost): Promise<LearningService | 'OFF' | 'UNAVAILABLE'> {
  const config = learningConfig(env);
  if (!config.enabled) return 'OFF';
  try { return createLearningService({ config, host: await open(env) }); } catch { return 'UNAVAILABLE'; }
}
/** The namespace a request asked for, if it is one (anything else means "no preference"). */
export const namespaceOf = (value: unknown): LearningNamespace | null => value === 'eip155' || value === 'solana' ? value : null;
/**
 * Which proven wallet a request's memory belongs to: exactly the requested namespace when one is requested (null if this browser has not proven
 * it — never another wallet instead); without a preference, the only proven wallet, or the EVM one when both are proven. Never merged; null when
 * no wallet is proven (anonymous).
 */
export function pickPrincipal(principals: readonly WalletPrincipal[], preferred: LearningNamespace | null): LearningPrincipal | null {
  const chosen = preferred ? principals.find(p => p.namespace === preferred) : principals.length === 1 ? principals[0] : principals.find(p => p.namespace === 'eip155');
  return chosen ? { kind: 'WALLET', namespace: chosen.namespace, account: chosen.address } : null;
}
