// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A03): natural-language references to the steps of the canonical workflow, read by FloFi itself
 * (never by a model): "a segunda etapa", "o último card", "a bridge", "o depósito", "o pagamento anterior", "the second step", "the last card",
 * "the previous payment", "step 2". A reference is only a kind and an ordinal (`CopilotTarget`), exactly what the model may report; the conversation
 * engine resolves it against the canonical workflow and asks when it matches several steps.
 *
 *   readStepEdit(text)          "Altere a segunda etapa para 0,2." → the target and the exact amount (decimal comma kept exact), or null
 *   findStepReference(text)     the first step reference anywhere in a message (for read-only questions about a step)
 *   pickStep(target, steps)     the step a target names in a list of steps, the candidates when several match, or none
 *
 * Pure. Anything this grammar does not read exactly returns null and goes on to the normal flow; nothing here guesses a value.
 */
import type { CopilotOrdinal, CopilotStepKind, CopilotTarget } from './copilot-intent-v2';
import { amountReadings } from './copilot-authoring';
import type { WorkflowStep } from './workflow-steps';

const fold = (text: string) => text.normalize('NFC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[ºª]/g, 'o').replace(/\s+/g, ' ').trim();
const ORDINAL: readonly (readonly [RegExp, CopilotOrdinal])[] = [[/^(?:primeir[ao]|first|1st|1o|1)$/, 'FIRST'], [/^(?:segund[ao]|second|2nd|2o|2)$/, 'SECOND'],
  [/^(?:terceir[ao]|third|3rd|3o|3)$/, 'THIRD'], [/^(?:quart[ao]|fourth|4th|4o|4)$/, 'FOURTH'], [/^(?:quint[ao]|fifth|5th|5o|5)$/, 'FIFTH'], [/^(?:ultim[ao]|last)$/, 'LAST']];
const ordinalOf = (word: string): CopilotOrdinal | null => ORDINAL.find(([pattern]) => pattern.test(word))?.[1] ?? null;
const KIND: readonly (readonly [RegExp, CopilotStepKind])[] = [[/^(?:swap|troca)$/, 'SWAP'], [/^(?:bridge|ponte)$/, 'BRIDGE'],
  [/^(?:supply|deposito|deposit|fornecimento|aporte)$/, 'SUPPLY'], [/^(?:borrow|emprestimo)$/, 'BORROW'], [/^repay$/, 'REPAY'], [/^(?:withdraw|withdrawal|saque|retirada)$/, 'WITHDRAW'],
  [/^(?:liquidity|liquidez)$/, 'LIQUIDITY'], [/^(?:transfer|transferencia|envio|send|pagamento|payment)$/, 'TRANSFER']];
const kindOf = (word: string): CopilotStepKind | null => KIND.find(([pattern]) => pattern.test(word))?.[1] ?? null;

const ORD = '(primeir[ao]|segund[ao]|terceir[ao]|quart[ao]|quint[ao]|ultim[ao]|first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)';
const NOUN = '(?:etapa|passo|card|cartao|acao|bloco|step|action)';
const KINDS = '(swap|troca|bridge|ponte|supply|deposito|deposit|fornecimento|aporte|borrow|emprestimo|repay|withdraw|withdrawal|saque|retirada|liquidity|liquidez|transfer|transferencia|envio|send|pagamento|payment)';
const ARTICLE = '(?:(?:a|o|the|esse|essa|este|esta|this|that|do|da|no|na|of the|in the|on the)\\s+)?';
/** Reference shapes at the start of a text, most specific first. Each returns the target and how much it consumed. */
const SHAPES: readonly ((text: string) => { readonly target: CopilotTarget; readonly length: number } | null)[] = [
  text => { const m = new RegExp(`^${ARTICLE}${ORD}\\s+${KINDS}\\b`).exec(text); return m ? { target: { step: kindOf(m[2]!), ordinal: ordinalOf(m[1]!) }, length: m[0].length } : null; },
  text => { const m = new RegExp(`^${ARTICLE}${ORD}\\s+${NOUN}\\b`).exec(text); return m ? { target: { step: null, ordinal: ordinalOf(m[1]!) }, length: m[0].length } : null; },
  text => { const m = new RegExp(`^${ARTICLE}([1-5])[ao]?\\s+${NOUN}\\b`).exec(text); return m ? { target: { step: null, ordinal: ordinalOf(m[1]!) }, length: m[0].length } : null; },
  text => { const m = new RegExp(`^${ARTICLE}${NOUN}\\s+(?:n(?:o|umero)?\\.?\\s*)?([1-5])(?![\\d.,])`).exec(text); return m ? { target: { step: null, ordinal: ordinalOf(m[1]!) }, length: m[0].length } : null; },
  // "the previous payment", "o pagamento anterior", "a bridge", "esse supply": a kind; several of that kind are asked about, never guessed.
  text => { const m = new RegExp(`^${ARTICLE}(?:(?:previous|earlier)\\s+)?${KINDS}(?:\\s+(?:anterior|de antes|previous))?\\b`).exec(text);
    return m ? { target: { step: kindOf(m[1]!), ordinal: null }, length: m[0].length } : null; },
  text => { const m = /^(?:it|this|that|isso|isto)\b/.exec(text); return m ? { target: { step: null, ordinal: null }, length: m[0].length } : null; },
];
function referenceAt(text: string): { readonly target: CopilotTarget; readonly length: number } | null {
  for (const shape of SHAPES) { const found = shape(text); if (found && (found.target.step !== null || found.target.ordinal !== null || /^(?:it|this|that|isso|isto)\b/.test(text))) return found; }
  return null;
}

const VERB = '(?:altere|alterar|altera|mude|mudar|muda|ajuste|ajustar|ajusta|coloque|colocar|coloca|defina|definir|define|atualize|atualizar|atualiza|edite|editar|edita|passe|passar|passa|deixe|deixar|deixa|troque|trocar|troca|corrija|corrigir|corrige|change|set|update|edit|adjust|modify|make|put|correct)';
const LEAD = new RegExp(`^(?:(?:por favor|please|pode|voce pode|can you|could you|actually|na verdade|entao|then|ok|okay)\\s*,?\\s+)*${VERB}\\s+(?:(?:o valor|a quantidade|o montante|the amount|the value)\\s+(?:de|da|do|of|on|in|for)\\s+)?`);
const TAIL = /^(?:(?:do|of the|in the|no|on the) (?:fluxo|workflow)\s+)?(?:(?:amount|valor|quantidade|montante)\s+)?(?:para|pra|to)\s+(?:(?:o valor de|the amount of)\s+)?(\d(?:[\d.,]*\d)?)(?:\s*([a-z][a-z0-9.]{0,11}))?$/;

export type StepEdit =
  /** One exact amount: `amount` is canonical ("0,2" → "0.2", every digit kept); `asset` is the symbol written after it, if any (lowercase). */
  | { readonly kind: 'AMOUNT'; readonly target: CopilotTarget; readonly amount: string; readonly asset: string | null }
  /** "1,000" reads as 1 or 1000: FloFi asks which, never picks. */
  | { readonly kind: 'AMBIGUOUS_AMOUNT'; readonly target: CopilotTarget; readonly readings: readonly string[]; readonly written: string };
/** "Altere a segunda etapa para 0,2.", "Mude o supply para 0,2", "change the last card to 5 USDC": one step and one amount, or null. */
export function readStepEdit(raw: string): StepEdit | null {
  if (typeof raw !== 'string' || raw.length > 200 || /0x[0-9a-f]{6}/i.test(raw)) return null;
  const text = fold(raw).replace(/[.!]+$/, '').trim();
  const lead = LEAD.exec(text);
  if (!lead) return null;
  const rest = text.slice(lead[0].length), reference = referenceAt(rest);
  if (!reference) return null;
  const tail = TAIL.exec(rest.slice(reference.length).trim());
  if (!tail) return null;
  const written = tail[1]!, readings = amountReadings(written);
  if (!readings.length) return null;
  if (readings.length > 1) return { kind: 'AMBIGUOUS_AMOUNT', target: reference.target, readings, written };
  return { kind: 'AMOUNT', target: reference.target, amount: readings[0]!, asset: tail[2] ?? null };
}

/** The first explicit step reference in a message ("o que faz a segunda etapa?", "what does the bridge do?"); pronouns are not read here. */
export function findStepReference(raw: string): CopilotTarget | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const text = fold(raw).replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  for (let at = 0; at < words.length; at += 1) {
    const found = referenceAt(words.slice(at).join(' '));
    if (found && (found.target.step !== null || found.target.ordinal !== null)) return found.target;
  }
  return null;
}

/** The step `target` names among `steps` (the workflow's actions, in order), or every candidate when it names several, or none. */
export function pickStep(target: CopilotTarget, steps: readonly WorkflowStep[]): { readonly step: WorkflowStep | null; readonly candidates: readonly WorkflowStep[] } {
  const actions = steps.filter(step => step.kind !== 'TEMPLATE');
  const pool = target.step ? actions.filter(step => step.kind === target.step || (target.step === 'TRANSFER' && step.kind === 'BATCH_PAYMENT')) : actions;
  const index: Readonly<Record<Exclude<CopilotOrdinal, 'LAST'>, number>> = { FIRST: 0, SECOND: 1, THIRD: 2, FOURTH: 3, FIFTH: 4 };
  if (target.ordinal) { const step = target.ordinal === 'LAST' ? pool.at(-1) : pool[index[target.ordinal]]; return { step: step ?? null, candidates: step ? [step] : [] }; }
  return { step: pool.length === 1 ? pool[0]! : null, candidates: pool };
}

/** FloFi's question when an amount reads two ways ("1,000"): each reading is one button, nothing is picked. */
export const STEP_EDIT_COPY = Object.freeze({
  EN: { amountReadsTwoWays: (written: string, readings: readonly string[]) => `“${written}” can be read as ${readings.join(' or ')}. Which amount do you mean?` },
  PT: { amountReadsTwoWays: (written: string, readings: readonly string[]) => `“${written}” pode ser ${readings.join(' ou ')}. Qual valor você quer?` },
});
