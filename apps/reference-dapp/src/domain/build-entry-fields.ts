// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PR #254 follow-up: the parts of a suggestion's sentence template ([amount] [token] … [network]) become fields filled in order INSIDE the same
 * request text — never a form, a modal or a second screen. The text stays the person's own: every part can be typed over, pasted, edited, or the
 * whole sentence rewritten. While the template's own words are still in place, each part is found again in the edited text (so a filled part can
 * be revisited); once those words change, the text is simply free text (only the remaining [placeholders] are still found).
 *
 * Nothing here submits, simulates, quotes, authorizes, signs or executes: it only reads and edits the request text.
 */
import { BUILD_ENTRY_SUGGESTIONS, type BuildEntrySuggestion } from './build-entry';
import { cryptoProfiles, validCryptoSelection, type CryptoAction } from './crypto-action-picker';
import { UNIVERSAL_BRIDGE_NETWORKS } from './universal-bridge-authoring';
import { classifyWalletEnvironment } from '../wallet/environment';

export type FieldKind = 'amount' | 'token' | 'network';
/** The placeholder words the templates use (EN and PT), and only those: brackets a person types for their own reasons are left alone. */
const KINDS: Readonly<Record<string, FieldKind>> = { amount: 'amount', valor: 'amount', token: 'token', network: 'network', rede: 'network' };
const PLACEHOLDER = /\[(amount|valor|token|network|rede)\]/g;
export type TemplateField = { readonly index: number; readonly kind: FieldKind; readonly start: number; readonly end: number; readonly value: string;
  /** Still the template's own placeholder text (nothing chosen for it yet). */ readonly placeholder: boolean };
export type TemplateSession = { readonly id: BuildEntrySuggestion['id']; readonly literals: readonly string[]; readonly kinds: readonly FieldKind[] };

export function templateSession(id: BuildEntrySuggestion['id'], template: string): TemplateSession {
  const literals: string[] = [], kinds: FieldKind[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) { literals.push(template.slice(last, match.index)); kinds.push(KINDS[match[1]!]!); last = match.index! + match[0].length; }
  literals.push(template.slice(last));
  return { id, literals, kinds };
}
const isPlaceholder = (value: string) => new RegExp(`^${PLACEHOLDER.source}$`).test(value);

/**
 * The fields of `text`: from the template's structure while its own words are still there, in order (a filled part is a field too); otherwise the
 * [placeholders] still in the text. Empty when there is none.
 */
export function templateFields(text: string, session: TemplateSession | null): readonly TemplateField[] {
  if (session) {
    const { literals, kinds } = session;
    if (text.startsWith(literals[0]!) && text.endsWith(literals.at(-1)!) && text.length >= literals[0]!.length + literals.at(-1)!.length) {
      const fields: TemplateField[] = [], limit = text.length - literals.at(-1)!.length;
      let at = literals[0]!.length, ok = true;
      for (let index = 0; index < kinds.length; index++) {
        // The value runs to the next literal (or the closing one for the last field); an empty value is allowed while editing.
        const next = index + 1 < kinds.length ? text.indexOf(literals[index + 1]!, at) : limit;
        if (next < 0 || next > limit) { ok = false; break; }
        const value = text.slice(at, next);
        fields.push({ index, kind: kinds[index]!, start: at, end: next, value, placeholder: isPlaceholder(value) });
        at = next + (index + 1 < kinds.length ? literals[index + 1]!.length : 0);
      }
      // A part whose value still carries a placeholder ("10 [token]" typed into [amount]) makes the structure ambiguous: the placeholders alone count.
      if (ok && at === limit && !fields.some(field => !field.placeholder && new RegExp(PLACEHOLDER.source).test(field.value))) return fields;
    }
  }
  return [...text.matchAll(PLACEHOLDER)].map((match, index) => ({ index, kind: KINDS[match[1]!]!, start: match.index!, end: match.index! + match[0].length,
    value: match[0], placeholder: true }));
}
/** The field the caret is in (its edges included), if any. */
export const fieldAt = (fields: readonly TemplateField[], caret: number) => fields.find(field => caret >= field.start && caret <= field.end) ?? null;
/** The next (or, backwards, the previous) field from the caret; null at either end, so Tab and Shift+Tab then leave the text as usual. */
export function adjacentField(fields: readonly TemplateField[], caret: number, direction: 1 | -1): TemplateField | null {
  const current = fieldAt(fields, caret);
  if (current) return fields[current.index + direction] ?? null;
  return direction === 1 ? fields.find(field => field.start > caret) ?? null : [...fields].reverse().find(field => field.end < caret) ?? null;
}
/** The next part still to fill after the caret (wrapping to the first one), or null when every part is filled. */
export function nextPlaceholder(fields: readonly TemplateField[], caret: number): TemplateField | null {
  const open = fields.filter(field => field.placeholder), current = fieldAt(fields, caret), from = current ? current.end : caret;
  return open.find(field => field !== current && field.start >= from) ?? open.find(field => field !== current) ?? open[0] ?? null;
}
/** `text` with `field` replaced by `value`, and where that value now ends. */
export function fillField(text: string, field: TemplateField, value: string): { readonly text: string; readonly end: number } {
  return { text: text.slice(0, field.start) + value + text.slice(field.end), end: field.start + value.length };
}

const ACTIONS: Readonly<Record<BuildEntrySuggestion['id'], readonly CryptoAction[]>> = {
  swap: ['swap'], yield: ['supply'], liquidity: ['pool'], collateral: ['supply', 'borrow'], multi: ['swap'],
};
/** The public product suggests mainnets only (its test networks are never offered). */
const mainnet = (action: CryptoAction) => cryptoProfiles(action).filter(profile => classifyWalletEnvironment(profile.chain) === 'mainnet');
/** A catalog network's own ETH is a swap side of its own (native swap or wrap); it is suggested only where the picker itself accepts it. */
function tokensOf(action: CryptoAction, network: string, profileTokens: readonly string[]): readonly string[] {
  const nativeSwap = action === 'swap' && profileTokens[0] !== undefined && validCryptoSelection({ action, network, from: 'ETH', to: profileTokens[0] });
  return nativeSwap ? ['ETH', ...profileTokens] : profileTokens;
}
const unique = (values: readonly string[]) => [...new Set(values)];
const MAX_SUGGESTIONS = 8;

/**
 * Contextual choices for a field, from the existing supported networks and tokens of the template's own action: the networks that serve it, and the
 * tokens of the network already chosen in the sentence (else the tokens those networks share first). Amounts have none. A choice is only a
 * shortcut: any other text can be typed, and FloFi's conversation and Review still check everything.
 */
export function fieldSuggestions(session: TemplateSession, fields: readonly TemplateField[], field: TemplateField): readonly string[] {
  // Only while the sentence still follows its template: a rewritten one keeps its [placeholders] as parts, but which action or side each one
  // belongs to is no longer known, so nothing is suggested (chat review).
  if (field.kind === 'amount' || fields.length !== session.kinds.length || fields.some((item, index) => item.kind !== session.kinds[index])) return [];
  const position = session.kinds.slice(0, field.index + 1).filter(kind => kind === field.kind).length - 1;
  const actions = ACTIONS[session.id];
  // Multi-step: the second network is where the bridge delivers (any universal bridge network other than the first).
  if (field.kind === 'network' && session.id === 'multi' && position === 1) {
    const from = fields.filter(item => item.kind === 'network')[0];
    return UNIVERSAL_BRIDGE_NETWORKS.map(network => network.label).filter(label => !from || from.placeholder || label.toLowerCase() !== from.value.trim().toLowerCase());
  }
  // Collateral: the first token is supplied, the second borrowed.
  const action = session.id === 'collateral' && field.kind === 'token' && position === 1 ? actions[1]! : actions[0]!;
  const profiles = mainnet(action);
  if (field.kind === 'network') return profiles.map(profile => profile.network);
  const chosen = fields.find(item => item.kind === 'network' && !item.placeholder && item.value.trim());
  const network = chosen ? profiles.find(profile => profile.network.toLowerCase() === chosen.value.trim().toLowerCase()) : undefined;
  const others = fields.filter(item => item.kind === 'token' && item.index !== field.index && !item.placeholder).map(item => item.value.trim().toLowerCase());
  const tokens = network ? tokensOf(action, network.network, network.tokens) : unique(profiles.flatMap(profile => tokensOf(action, profile.network, profile.tokens.slice(0, 3))));
  return tokens.filter(token => !others.includes(token.toLowerCase())).slice(0, MAX_SUGGESTIONS);
}
/** The session of a suggestion's template in the shown language. */
export function sessionOf(id: BuildEntrySuggestion['id'], language: 'EN' | 'PT'): TemplateSession {
  return templateSession(id, BUILD_ENTRY_SUGGESTIONS.find(item => item.id === id)!.template[language]);
}
