// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { applyAction, applySettings, parseClientEvents, statusView, type LearningActionResult, type LearningStatusView } from '../learning/web-actions';
import { namespaceOf, webLearningService } from '../server/learning-web';
import { currentWalletPrincipals } from '../server/session-principal';

/**
 * BUILD-CHAT-LEARNING-001: the Copilot's Memory for FloFi's web chat. Every action reads the wallet sessions proven in this browser from their
 * sealed HttpOnly cookies; the browser may only choose WHICH proven wallet (`identity`: 'eip155' | 'solana'), never send an address. Off unless
 * the deployment enables learning; any storage problem reads as "unavailable" and the Copilot keeps working without memory.
 */
const principals = () => currentWalletPrincipals().catch(() => []);

/** This browser's learning context: its own memory (for its verified wallet), the active global glossary, and its settings. */
export async function learningStatus(identity?: unknown): Promise<LearningStatusView> {
  return statusView(await webLearningService(process.env), await principals(), namespaceOf(identity));
}
/** Performs a memory action the user just confirmed (Remember, forget, delete all, reply language). */
export async function learningApply(action: unknown, identity?: unknown): Promise<LearningActionResult> {
  return applyAction(await webLearningService(process.env), await principals(), namespaceOf(identity), action);
}
/** Pauses/resumes memory, or opts in/out of contributing generalized meanings (opting out withdraws past contributions). */
export async function learningSettings(change: unknown, identity?: unknown): Promise<LearningActionResult> {
  return applySettings(await webLearningService(process.env), await principals(), namespaceOf(identity), change);
}
/** Erases everything FloFi remembers for this browser's chosen wallet. */
export async function learningErase(identity?: unknown): Promise<LearningActionResult> {
  return applyAction(await webLearningService(process.env), await principals(), namespaceOf(identity), { op: 'FORGET_ALL' });
}
/** Content-free feedback the chat observed (closed kinds and codes, counts); never text. Best effort. */
export async function learningFeedback(events: unknown): Promise<void> {
  const service = await webLearningService(process.env), parsed = parseClientEvents(events);
  if (typeof service === 'string' || !parsed.length) return;
  await service.record('WEB', parsed);
}
