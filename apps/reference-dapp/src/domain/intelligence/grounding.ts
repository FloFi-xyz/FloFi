// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: grounded generated prose. The model may now write an explanation (a QUESTION or GOAL answer) from the
 * verified, scoped facts FloFi gave it — tool results, FloFi's sanitized workflow context and the user's own words. Its prose is shown only
 * when it passes these checks; otherwise FloFi's deterministic answer stands alone:
 *
 *  - FloFi's existing prose rule (`safeCopilotProse`): no link, no hex string or address, no claim that anything was executed, signed or sent;
 *  - every number in it (amount, fee, price, percentage, duration) appears in those facts — read the same way the Copilot reads amounts
 *    (`amountReadings`), with basis points and percentages interchangeable — so a model-made amount, fee, price, APY or status never shows;
 *  - bounded length and safe characters.
 *
 * The explanation is display copy: it never becomes a financial value, a capability or a proposal field. Pure.
 */
import { amountReadings, canonicalDecimal } from '../copilot-authoring';
import { hasUnsafeCharacters, safeCopilotProse } from '../copilot-intent';

export const GROUNDED_PROSE_LIMITS = Object.freeze({ maxLength: 900 });
export type ProseCheck = { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'EMPTY' | 'TOO_LONG' | 'UNSAFE' | 'UNGROUNDED_NUMBER' };

// Numbers as a reader sees them: never inside hex strings, node ids, chain ids, or words such as "v3", "ERC-20" or "L2".
const numberTokens = (text: string): string[] => [...text.replace(/0x[0-9a-fA-F]+|node-\d+|eip155:\d+|solana:[A-Za-z0-9]+/g, ' ')
  .matchAll(/(?<![A-Za-z0-9_.])(?<![A-Za-z]-)\d+(?:[.,]\d+)*(?![A-Za-z0-9])/g)].map(match => match[0]);
// Step positions and counts ("step 2", "2 steps", "passo 1") name the workflow's structure, not a financial value.
const STRUCTURE = /\b(?:steps?|passos?|etapas?|ordem)\s+\d\b|\b\d\s+(?:steps?|passos?|etapas?)\b|\b\d(?:st|nd|rd|th)\b/giu;
function readings(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of numberTokens(text)) for (const value of [...amountReadings(token), canonicalDecimal(token.replace(/,/g, ''))]) out.add(value);
  return out;
}
/** Every number reading the facts carry, and each basis-point value as a percentage (100 bps = 1%) and back. */
export function factNumbers(facts: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const fact of facts) for (const value of readings(fact)) {
    out.add(value);
    if (/^\d+$/.test(value) && value.length <= 5) out.add(canonicalDecimal((Number(value) / 100).toFixed(2)));
    if (/^\d+(?:\.\d{1,2})?$/.test(value)) out.add(String(Math.round(Number(value) * 100)));
  }
  return out;
}
/** `prose` if it is safe and every number in it is in `facts`; otherwise why not. */
export function groundedProse(prose: string | null | undefined, facts: readonly string[]): ProseCheck {
  const text = typeof prose === 'string' ? prose.trim() : '';
  if (!text) return { ok: false, reason: 'EMPTY' };
  if (text.length > GROUNDED_PROSE_LIMITS.maxLength) return { ok: false, reason: 'TOO_LONG' };
  if (hasUnsafeCharacters(text) || safeCopilotProse(text) === null) return { ok: false, reason: 'UNSAFE' };
  const allowed = factNumbers(facts);
  const ungrounded = numberTokens(text.replace(STRUCTURE, ' ')).filter(token => ![...amountReadings(token), canonicalDecimal(token.replace(/,/g, ''))].some(value => allowed.has(value)));
  return ungrounded.length ? { ok: false, reason: 'UNGROUNDED_NUMBER' } : { ok: true, text };
}
