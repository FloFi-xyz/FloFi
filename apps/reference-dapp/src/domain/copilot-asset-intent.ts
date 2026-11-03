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
  // BUILD-FLOFI-INTELLIGENCE-001: a unit after a number ("slippage 50 bps", "1% de deslizamento") is never a token.
  if (/^(?:bps|bp|basis\s+points?|pontos?(?:\s+base)?|%|percent|por\s*cento|slippage|deslizamento)\b/i.test(value)) return null;
  return /^[\p{L}\p{N}$][\p{L}\p{N} .&'@_+*-]*$/u.test(value) ? value : null;
}
/**
 * BUILD-FLOFI-UX-FIX-003: words that give what follows the destination role ("bridge ETH *to* 1 USDC", "*receive* 1 USDC", "trocar ETH *por* 1 USDC").
 * An amount written in that role is what the user wants to receive, never the amount they send.
 */
// "get" is left out ("get 50 USDC to Solana" names what is sent), and so is "up to" (a limit on what is sent).
const DESTINATION_ROLE = '(?:to|into|for|para|pra|por|receiv(?:e|ing)|recebendo|receber|receba|recebo|obter)';
const OPTIONAL_APPROXIMATION = '(?:(?:about|around|approximately|roughly|exactly|cerca\\s+de|aproximadamente|exatamente|uns|umas)\\s+)?';
const AMOUNT = '\\d+(?:[.,]\\d+)*';
const DESTINATION_AMOUNT = new RegExp(`(?<!\\bup\\s+)\\b${DESTINATION_ROLE}\\s+(?:(?:as|in|em|como)\\s+)?${OPTIONAL_APPROXIMATION}(?<![\\w@.])(${AMOUNT})\\s+([^,;!?\\n]+)`, 'gid');
const LEADING_AMOUNT = new RegExp(`^${OPTIONAL_APPROXIMATION}${AMOUNT}\\s+`, 'i');
/**
 * An amount the user wants to receive, with the token written after it: "to 1 USDC", "receive about 0.5 SOL", "para 1 usd". `sent` (the asset the
 * request sends, when known): an amount of that same asset is never a received amount ("set it to 0.5 ETH" corrects how much ETH is sent).
 */
export type DestinationAmount = { readonly written: string; readonly asset: string; readonly index: number };
export function destinationAmounts(text: string, sent?: string | null): readonly DestinationAmount[] {
  const same = (asset: string) => typeof sent === 'string' && asset.toLowerCase() === sent.toLowerCase();
  return [...text.matchAll(DESTINATION_AMOUNT)].flatMap(match => {
    const asset = reference(match[2]!);
    return asset && !same(asset) ? [{ written: match[1]!, asset, index: match.indices![1]![0] }] : [];
  });
}
/** The text with every destination amount's number blanked out: amounts the user sends are grounded here, never a number they want to receive. */
export function withoutDestinationAmounts(text: string, sent?: string | null): string {
  let out = text;
  for (const found of [...destinationAmounts(text, sent)].reverse()) out = out.slice(0, found.index) + ' '.repeat(found.written.length) + out.slice(found.index + found.written.length);
  return out;
}
/**
 * `receiving`: the text describes a new action, so "to 1 USDC" names what the user wants to receive. An edit ("change the swap to 4 USDC") is never
 * read this way: there the number is the step's new amount (the model reads it; this module keeps its pre-existing reading).
 */
export function explicitOutputAsset(text: string, receiving = false, sent?: string | null): string | null {
  const clauses = [...text.matchAll(/\b(?:receiv(?:e|ing)|get(?:ting)?|recebendo|receber|receba|recebo)\s+(?:(?:as|in|em|como)\s+)?([^,;!?\n]+)/gi),
    ...text.matchAll(/(?=\b(?:para|to|por|for)\s+([^,;!?\n]+?)\s+(?:na|no|on|in)\s+)/gi)].map(match => ({ index: match.index, value: match[1]! }));
  // BUILD-FLOFI-UX-FIX-003: "bridge ETH to 1 USDC": the token after a destination amount is the destination asset.
  if (receiving) for (const found of destinationAmounts(text, sent)) clauses.push({ index: found.index, value: found.asset });
  clauses.sort((a, b) => a.index - b.index);
  for (const clause of clauses.reverse()) {
    // "receive 1 USDC": the number is the destination amount; the token follows it.
    const found = reference(clause.value.replace(LEADING_AMOUNT, ''));
    if (found) return found;
  }
  return null;
}
export function explicitInputAsset(text: string, receiving = false, sent?: string | null): string | null {
  // BUILD-FLOFI-UX-FIX-003: "bridge ETH to 1 USD" names 1 USD as what the user wants to receive; that clause never names the asset sent.
  const clauses = [...text.matchAll(/(?<![\w@.])\d+(?:[.,]\d+)*\s+([^\n]+?)(?=\s+(?:from|on|in|into|to|for|da|do|de|na|no|para|pra|por|using|usando)\s+|$)/gi)]
    .filter(clause => !receiving || !destinationAmounts(text, sent).some(found => found.index === clause.index));
  // Multiple amounts/deposits need the model's action-specific interpretation.
  return clauses.length === 1 ? reference(clauses[0]![1]!) : null;
}
/** Only single actions have unambiguous source/destination roles in an entire message. Compositions keep per-step model extraction. */
export function groundExplicitAssets(action: CopilotAction, text: string, aliases: readonly { readonly term: string }[] = [], receiving = false): CopilotAction {
  if (action.type === 'LIQUIDITY') return action;
  const source = action.type === 'BRIDGE' ? action.sourceNetwork : action.network;
  if (source && networkIdentity(source)?.environment === 'TESTNET') return action;
  const sent = action.type === 'SWAP' ? action.inputAsset : action.asset;
  const writtenInput = explicitInputAsset(text, receiving, sent);
  const input = writtenInput && !aliases.some(a => a.term.toLowerCase() === writtenInput.toLowerCase()) ? writtenInput : null, output = action.type === 'BRIDGE' || action.type === 'SWAP' ? explicitOutputAsset(text, receiving, sent) : null;
  if (action.type === 'SWAP') return { ...action, ...input ? { inputAsset: input } : {}, ...output ? { outputAsset: output } : {} };
  if (action.type === 'BRIDGE') return { ...action, ...input ? { asset: input } : {}, ...output ? { outputAsset: output } : {} };
  return input ? { ...action, asset: input } : action;
}
