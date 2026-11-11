// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { withFlightAccess } from '../server/flight-access';
import { learningConfig, sessionAdaptation } from '../learning/config';
import { applyAction, applyObservations, applySettings, parseClientEvents, statusView, type LearningActionResult, type LearningStatusView } from '../learning/web-actions';
import { createCopilotLimiter, type CopilotLimiter } from '../server/copilot-service';
import { namespaceOf, webLearningService } from '../server/learning-web';
import { memoryPrincipals } from '../server/history-principals';

/**
 * BUILD-CHAT-LEARNING-001: the Copilot's Memory for FloFi's web chat. Every action reads the wallet sessions proven in this browser from their
 * sealed HttpOnly cookies (BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: or the signed-in account's only wallet of an ecosystem, `memoryPrincipals`);
 * the browser may only choose WHICH ecosystem (`identity`: 'eip155' | 'solana'), never send an address. Off unless
 * the deployment enables learning; any storage problem reads as "unavailable" and the Copilot keeps working without memory.
 */
// BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: a signed-in person's own wallet counts too (a wallet proven in this browser first, else the signed-in
// account's only wallet of that ecosystem), so memory works without proving the same wallet again. Memory stays per wallet and is never guessed.
const principals = () => memoryPrincipals().catch(() => []);

/**
 * This browser's learning context: its own memory (for its verified wallet), the active global glossary, and its settings. BUILD-CHAT-LEARNING-002:
 * with FLOFI_LEARNING=session, only in-conversation adaptation (nothing is read or stored).
 */
export async function learningStatus(identity?: unknown): Promise<LearningStatusView> {
  return withFlightAccess(async () => {
  const service = await webLearningService(process.env);
  if (service === 'OFF' && sessionAdaptation(process.env)) return statusView('SESSION', [], null);
  return statusView(service, await principals(), namespaceOf(identity));

  });
}
/** BUILD-CHAT-LEARNING-002: which learning tier this deployment runs (no database read): what Settings links to. */
export async function learningAvailability(): Promise<'OFF' | 'SESSION' | 'ENABLED'> {
  return withFlightAccess(async () => {
  return learningConfig(process.env).enabled ? 'ENABLED' : sessionAdaptation(process.env) ? 'SESSION' : 'OFF';

  });
}
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: what the first-access Privacy & Memory notice must say — the learning tier and the deployment's basis
 * for automatic learning (consent, legitimate interest, or none). Configuration only; no database read.
 */
export async function learningNotice(): Promise<{ readonly tier: 'OFF' | 'SESSION' | 'ENABLED'; readonly automatic: 'OFF' | 'CONSENT' | 'LEGITIMATE_INTEREST' }> {
  return withFlightAccess(async () => {
  const config = learningConfig(process.env);
  return config.enabled ? { tier: 'ENABLED', automatic: config.automatic } : { tier: sessionAdaptation(process.env) ? 'SESSION' : 'OFF', automatic: 'OFF' };

  });
}
/** BUILD-CHAT-LEARNING-002: what the Copilot observed about the user's own words; stored only when permitted for the chosen proven wallet. Best effort. */
export async function learningObserve(observations: unknown, context: unknown, identity?: unknown): Promise<void> {
  return withFlightAccess(async () => {
  const release = feedbackLimiter().acquire();
  if (!release) return;
  try { await applyObservations(await webLearningService(process.env), await principals(), namespaceOf(identity), observations, context); }
  catch { /* learning never fails the chat */ } finally { release(); }

  });
}
/** Performs a memory action the user just confirmed (Remember, forget, delete all, reply language). */
export async function learningApply(action: unknown, identity?: unknown): Promise<LearningActionResult> {
  return withFlightAccess(async () => {
  return applyAction(await webLearningService(process.env), await principals(), namespaceOf(identity), action);

  });
}
/** Pauses/resumes memory, or opts in/out of contributing generalized meanings (opting out withdraws past contributions). */
export async function learningSettings(change: unknown, identity?: unknown): Promise<LearningActionResult> {
  return withFlightAccess(async () => {
  return applySettings(await webLearningService(process.env), await principals(), namespaceOf(identity), change);

  });
}
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the person just agreed, in the Privacy & Memory notice, to the same learning notice the Settings toggle
 * shows (LEARNING_NOTICE_VERSION). Under an opt-in basis (`CONSENT`) automatic learning is turned on for the wallet this browser can use at this
 * moment (proven here, or held by the signed-in account) — only when that wallet never made its own choice, so an earlier "off" is never
 * overridden. Called once, when the agreement is given: it is never applied to a wallet that appears later. Without a wallet nothing is stored.
 */
export async function learningAgree(identity?: unknown): Promise<{ readonly applied: boolean }> {
  return withFlightAccess(async () => {
  try {
    const service = await webLearningService(process.env), wallets = await principals(), namespace = namespaceOf(identity);
    const view = await statusView(service, wallets, namespace);
    if (!view.enabled || !view.identity || view.automatic.mode !== 'CONSENT' || view.automatic.setting !== null) return { applied: false };
    const result = await applySettings(service, wallets, namespace, { automatic: true });
    return { applied: result.ok };
  } catch { return { applied: false }; }

  });
}
/** Erases everything FloFi remembers for this browser's chosen wallet. */
export async function learningErase(identity?: unknown): Promise<LearningActionResult> {
  return withFlightAccess(async () => {
  return applyAction(await webLearningService(process.env), await principals(), namespaceOf(identity), { op: 'FORGET_ALL' });

  });
}
/** Feedback is best effort: a per-process admission window bounds the database work an anonymous caller can cause (before any query). */
function feedbackLimiter(): CopilotLimiter {
  const key = Symbol.for('flofi.learning.feedback-limiter'), holder = globalThis as unknown as Record<symbol, CopilotLimiter | undefined>;
  holder[key] ??= createCopilotLimiter({ windowMs: 60_000, maxConcurrent: 4, maxPerWindow: 240 });
  return holder[key];
}
/** Content-free feedback the chat observed (closed kinds and codes, counts); never text. Best effort. */
export async function learningFeedback(events: unknown): Promise<void> {
  return withFlightAccess(async () => {
  const parsed = parseClientEvents(events);
  if (!parsed.length) return;
  const release = feedbackLimiter().acquire();
  if (!release) return;
  try {
    const service = await webLearningService(process.env);
    if (typeof service !== 'string') await service.record('WEB', parsed);
  } finally { release(); }

  });
}
