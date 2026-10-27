// SPDX-License-Identifier: AGPL-3.0-only
import type { CopilotAction } from './copilot-intent';
import { networkIdentity } from './network-registry';

/** User text with an explicit grammatical role. This is evidence, never a token whitelist or a route decision.
 * The model handles unrestricted language; these narrow clauses protect explicit values from model omission/substitution.
 * Unknown references are kept verbatim so the chain-scoped catalog can explain the actual failure. */
const END = /\s+(?:on|in|from|to|into|for|na|no|da|do|para|pra|por|via|using|usando|com|slippage|back|with)\s+|\s+e\s+|\s+and\s+|[,;!?\n]/i;
function reference(clause: string): string | null {
  const value = clause.split(END)[0]!.trim().replace(/^(?:some|a little|um pouco de|alguns?)\s+/i, '').replace(/[.!?]+$/, '');
  if (!value || value.length > 160 || networkIdentity(value) || /^(?:the|a|o|as|os|it|there|funds|fundos|money|dinheiro|mesm[oa]|same|of|into|usando|on|na|no|to|para)\b/i.test(value)) return null;
  return /^[\p{L}\p{N}$][\p{L}\p{N} .&'@_+*-]*$/u.test(value) ? value : null;
}
export function explicitOutputAsset(text: string): string | null {
  const clauses = [...text.matchAll(/\b(?:receiv(?:e|ing)|get(?:ting)?|recebendo|receber|receba|recebo)\s+(?:(?:as|in|em|como)\s+)?([^\n]+)/gi),
    ...text.matchAll(/\b(?:para|to|por|for)\s+([^\n]+?)\s+(?:na|no|on|in)\s+/gi)];
  clauses.sort((a, b) => a.index! - b.index!);
  for (const clause of clauses.reverse()) { const found = reference(clause[1]!); if (found) return found; }
  return null;
}
export function explicitInputAsset(text: string): string | null {
  const clauses = [...text.matchAll(/(?<![\w@.])\d+(?:[.,]\d+)*\s+([^\n]+?)(?=\s+(?:from|on|in|into|to|for|da|do|de|na|no|para|pra|por|using|usando)\s+|$)/gi)];
  // Multiple amounts/deposits need the model's action-specific interpretation.
  return clauses.length === 1 ? reference(clauses[0]![1]!) : null;
}
/** Only single actions have unambiguous source/destination roles in an entire message. Compositions keep per-step model extraction. */
export function groundExplicitAssets(action: CopilotAction, text: string, aliases: readonly { readonly term: string }[] = []): CopilotAction {
  if (action.type === 'LIQUIDITY') return action;
  const source = action.type === 'BRIDGE' ? action.sourceNetwork : action.network;
  if (source && networkIdentity(source)?.environment === 'TESTNET') return action;
  const writtenInput = explicitInputAsset(text);
  const input = writtenInput && !aliases.some(a => a.term.toLowerCase() === writtenInput.toLowerCase()) ? writtenInput : null, output = action.type === 'BRIDGE' || action.type === 'SWAP' ? explicitOutputAsset(text) : null;
  if (action.type === 'SWAP') return { ...action, ...input ? { inputAsset: input } : {}, ...output ? { outputAsset: output } : {} };
  if (action.type === 'BRIDGE') return { ...action, ...input ? { asset: input } : {}, ...output ? { outputAsset: output } : {} };
  return input ? { ...action, asset: input } : action;
}
