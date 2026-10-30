// SPDX-License-Identifier: AGPL-3.0-only
import { isPristineDraft } from './initial-workflow';

/**
 * BUILD0-UX-001: Build 0, the intent entry before the existing builder (Build 1). It owns no workflow, interpreter or execution state: a request
 * typed here is sent to the same FloFi conversation the Build 1 chat uses, which commits to (or proposes on) the canonical workflow.
 */
export const BUILD_ENTRY = 'Build 0' as const;
export type BuildEntrySection = typeof BUILD_ENTRY;

/**
 * Only the public chat-first workspace opens on Build 0. Approval surfaces (/approve, MCP, channels), the engineering workspace, the Dashboard
 * and the secondary workspaces keep their own landing.
 */
export function buildEntryLanding(input: { pathname: string | null | undefined; engineering: boolean; approval: boolean; surface: 'workspace' | 'signing' }): boolean {
  return input.pathname === '/app' && !input.engineering && !input.approval && input.surface === 'workspace';
}

/**
 * Whether this visit is still a fresh start. A restored or reopened workflow, a run recovered from this browser, a live execution, a pending
 * proposal or an unfinished Canvas card belongs in Build 1 (or its own stage), never behind the entry. While the shell is still reading a run
 * persisted in this browser the answer is not known yet: the caller waits for that read to settle.
 */
export function buildEntryFresh(input: {
  workflow: { readonly revision: number; readonly nodes: readonly { readonly actionType: string }[] };
  restorationEpoch: number; authoringIncomplete: boolean; executionSurface: boolean; execution: boolean; proposal: boolean;
}): boolean {
  return isPristineDraft(input.workflow) && input.restorationEpoch === 0 && !input.authoringIncomplete && !input.executionSurface && !input.execution && !input.proposal;
}

type EntryMessage = { readonly role: 'you' | 'system' | 'ai' | 'flofi'; readonly text: string; readonly language?: 'EN' | 'PT' | undefined;
  readonly options?: readonly string[] | undefined; readonly question?: string | undefined; readonly review?: unknown };
export type BuildEntrySnapshot = {
  readonly workflowId: string; readonly revision: number; readonly proposal: unknown; readonly messages: number; readonly question: string | null; readonly automation: unknown;
};
export type BuildEntryOutcome =
  /** The request changed the canonical workflow, or left a proposal to review on the Canvas: continue in Build 1. */
  | { readonly kind: 'BUILT' | 'PROPOSED' }
  /** FloFi answered with a question or a conversational reply: the conversation continues in the Build 1 chat. */
  | { readonly kind: 'CONVERSATION' }
  /** Nothing changed and nothing is pending: the entry says why, keeping the request editable. */
  | { readonly kind: 'REFUSED'; readonly message: string | null; readonly language: 'EN' | 'PT' | null };

/** Classifies what the existing conversation did with one request typed in Build 0, from the stored workflow and FloFi's own reply. */
export function buildEntryOutcome(before: BuildEntrySnapshot, after: BuildEntrySnapshot & { readonly log: readonly EntryMessage[] }): BuildEntryOutcome {
  if (after.workflowId !== before.workflowId || after.revision !== before.revision) return { kind: 'BUILT' };
  if (after.proposal && after.proposal !== before.proposal) return { kind: 'PROPOSED' };
  const replies = after.log.slice(before.messages).filter(message => message.role !== 'you');
  if (after.question || (after.automation && after.automation !== before.automation)
    || replies.some(message => message.role === 'ai' || message.question || message.review || message.options?.length)) return { kind: 'CONVERSATION' };
  const last = replies.at(-1);
  return { kind: 'REFUSED', message: last?.text ?? null, language: last?.language ?? null };
}

/**
 * The suggestion chips only fill the composer with editable text: nothing is sent, simulated or signed until the owner submits it. Every example
 * names a mainnet (the public product never suggests a test network); amounts are illustrative, not recommendations.
 */
export const BUILD_ENTRY_SUGGESTIONS = Object.freeze([
  { id: 'yield', label: 'Earn yield', icon: 'yield', example: { EN: 'Supply 100 USDC to Aave on Base', PT: 'Quero colocar 100 USDC no Aave na Base' } },
  { id: 'swap', label: 'Swap assets', icon: 'swap', example: { EN: 'Swap 50 USDC to SOL on Solana', PT: 'Trocar 50 USDC por SOL na Solana' } },
  { id: 'liquidity', label: 'Provide liquidity', icon: 'liquidity', example: { EN: 'Provide liquidity with SOL and USDC on Solana', PT: 'Fornecer liquidez com SOL e USDC na Solana' } },
  { id: 'collateral', label: 'Use collateral', icon: 'collateral', example: { EN: 'Use my ETH as collateral on Aave to borrow USDC on Base', PT: 'Usar meu ETH como colateral no Aave para pegar USDC emprestado na Base' } },
  { id: 'multi', label: 'Multi-step strategy', icon: 'multi', example: { EN: 'Bridge 50 USDC from Base to Arbitrum, then swap it to WETH', PT: 'Fazer bridge de 50 USDC da Base para a Arbitrum e depois trocar por WETH' } },
] as const);
export type BuildEntrySuggestion = (typeof BUILD_ENTRY_SUGGESTIONS)[number];
