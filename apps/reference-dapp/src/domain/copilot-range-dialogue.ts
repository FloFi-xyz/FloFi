// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability: FloFi's own reading of a short answer to its open range question, in English or Portuguese.
 * Deterministic and local: "lower", "1usdc", "180", "±10%", "10% range", "faixa de 10%", "full range", "150 to 180", "upper 180", "ticks -600 to
 * 600". It only reads which range slot an answer fills; every value is still grounded in the user's words, validated and converted by the planner.
 * Anything it does not recognise as a range answer returns null and goes to the interpreter exactly as before (a new request, a deposit
 * correction, a question). It never reads an amount, a token or a network, and a value written in another token than the pool's price unit
 * ("0.1 SOL" for a USDC-per-SOL price) is not a range answer.
 */
import type { CopilotLiquidityAction } from './copilot-intent';
import { amountReadings } from './copilot-authoring';
import { isUsdStable } from './pool-range';

export type RangeSide = 'LOWER' | 'UPPER';
export type RangeAnswer =
  | { readonly kind: 'FULL' }
  /** A percentage around the current pool price; null when the user only chose the kind of range ("a percentage range"). */
  | { readonly kind: 'PERCENT'; readonly percent: string | null }
  | { readonly kind: 'UNIT'; readonly unit: 'PRICE' | 'TICK' }
  | { readonly kind: 'BOUNDS'; readonly unit: 'PRICE' | 'TICK'; readonly lower: string; readonly upper: string }
  /** A side, with its value and unit when the answer named them ("lower tick 600" is a tick; "upper 180 usdc" a price). */
  | { readonly kind: 'SIDE'; readonly side: RangeSide; readonly value: string | null; readonly unit?: 'PRICE' | 'TICK' | null }
  | { readonly kind: 'VALUE'; readonly value: string; readonly unit: 'PRICE' | 'TICK' | null };
/** The pool's price unit (quote per base), so "1usdc" or "180 USDC per SOL" is recognised and "0.1 SOL" is not. Null: unknown pool. */
export type RangeUnits = { readonly quote: string; readonly base: string };
/**
 * What FloFi holds between turns while the range is open: a value whose side is not known yet, or the side the next value is for, with the unit
 * the user named for it ("600 ticks", "lower tick"), so the next answer keeps it.
 */
export type RangeHold = { readonly value?: string; readonly side?: RangeSide; readonly unit?: 'PRICE' | 'TICK' };
export type RangeStep = { readonly action: CopilotLiquidityAction; readonly hold: RangeHold | null;
  /** FloFi asks next, itself: which side a held value is (SIDE), or the value of a named side (BOUND). Null: the planner decides. */
  readonly ask: 'SIDE' | 'BOUND' | null };

const LOWER = String.raw`(?:lower|low|lowest|min|minimum|bottom|floor|inferior|m[ií]nim[oa]|menor|baixo|de baixo|piso)`;
const UPPER = String.raw`(?:upper|high|higher|highest|max|maximum|top|ceiling|superior|m[aá]xim[oa]|maior|alto|de cima|teto)`;
const NOUN = String.raw`(?:\s+(?:bound|price|limit|end|one|value|tick|limite|pre[cç]o|valor|ponta|extremo))*`;
const NUMBER = String.raw`(-?\d+(?:[.,]\d+)*)`;
// A value with an optional "$" and price unit: "1usdc", "180 USDC per SOL", "180 usdc/sol", "180 dólares".
// Link words ("150 as the lower", "lower 150 and upper 180") are never a unit.
const LINKS = String.raw`(?!(?:as|is|to|and|or|e|a|at[eé]|de|em|for|para|pra|como|the|o|through|per|por)(?![\p{L}\p{N}]))`;
const VALUE = String.raw`(\$\s*)?${NUMBER}(?:\s*${LINKS}([\p{L}][\p{L}\p{N}.]{0,11}))?(?:\s*(?:per|por|\/|a cada)\s*([\p{L}][\p{L}\p{N}.]{0,11}))?`;
const SIGN = String.raw`(?:±|\+\s*\/\s*-|\+-|-\s*\/\s*\+|plus or minus|plus\/minus|mais ou menos)`;
const PCT = String.raw`(?:%|percent|per\s?cent|por\s?cento)`;
const PREFIX = new RegExp(String.raw`^(?:ok(?:ay)?|sure|yes|sim|claro|then|ent[aã]o|actually|na verdade|please|por favor|use|usa|usar|i want|i'?d like|quero|prefiro|escolho|let'?s (?:do|use|go with)|go with|make it|vamos de|pode ser|coloca|set|choose|with|com|a|an|the|uma|um|o|de|of|range|faixa|band|intervalo)[,:]?\s+`, 'iu');
const SUFFIX = new RegExp(String.raw`\s+(?:range|faixa|band|wide|width|each side|on each side|either side|both sides|para cada lado|pra cada lado|de cada lado|nos dois lados|around(?: the)?(?: current)?(?: pool)?(?: price)?|em torno do pre[cç]o(?: atual)?(?: do pool)?|ao redor do pre[cç]o(?: atual)?(?: do pool)?|do pre[cç]o atual|around it|please|por favor|centered|centrad[ao]|instead|then|ent[aã]o)$`, 'iu');
const USD_WORDS = new Set(['usd', 'dollar', 'dollars', 'dólar', 'dólares', 'dolar', 'dolares', 'bucks']);
/** The pool's dollar stablecoins (the same list the pool's quote side uses), and the Devnet test dollar in engineering certification. */
const stable = (symbol: string): boolean => isUsdStable(symbol) || /^devusdc$/i.test(symbol);

/** The answer normalized (case, spaces, dashes, final punctuation) and without a model option's example: "A percentage range (for example, ±10%)". */
const light = (raw: string): string => raw.normalize('NFKC').trim().toLowerCase().replace(/[−–—]/g, '-').replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim()
  .replace(/\s*\((?:for example|for instance|e\.g\.|eg|por exemplo|ex\.?|like)[^)]*\)$/, '').trim();
/** Its core, without courtesy and framing words at either end ("ok, use a 10% range please" → "10%"). */
function core(text: string): string {
  for (let i = 0; i < 4 && PREFIX.test(text); i++) text = text.replace(PREFIX, '');
  for (let i = 0; i < 4 && SUFFIX.test(text); i++) text = text.replace(SUFFIX, '');
  return text.trim();
}
/** One canonical decimal for a written number, or null when it has several readings ("1,000"). */
function canonical(written: string): string | null {
  const negative = written.startsWith('-'), readings = amountReadings(negative ? written.slice(1) : written);
  return readings.length === 1 ? `${negative ? '-' : ''}${readings[0]}` : null;
}
/** A value's unit words are the pool's price unit (or US dollars for a dollar stablecoin quote); "ticks" means ticks. */
function valueOf(match: RegExpExecArray, at: number, units: RangeUnits | null): { value: string; unit: 'PRICE' | 'TICK' | null } | null {
  const dollar = Boolean(match[at]), value = canonical(match[at + 1]!), unit = match[at + 2]?.toLowerCase(), per = match[at + 3]?.toLowerCase();
  if (value === null) return null;
  if (unit === 'tick' || unit === 'ticks') return per ? null : { value, unit: 'TICK' };
  const quote = units?.quote.toLowerCase(), base = units?.base.toLowerCase();
  const dollarQuote = Boolean(quote && stable(quote));
  if (dollar && !dollarQuote) return null;
  if (unit !== undefined && !(unit === quote || (dollarQuote && (USD_WORDS.has(unit) || unit === 'usdc')))) return null;
  if (per !== undefined && !(per === base || (base === 'weth' && per === 'eth') || (base === 'eth' && per === 'weth'))) return null;
  if (value.startsWith('-') && (unit || dollar)) return null;
  return { value, unit: unit || dollar || per ? 'PRICE' : value.startsWith('-') ? 'TICK' : null };
}
const whole = (pattern: string) => new RegExp(`^${pattern}$`, 'iu');
/** The unit a side noun names in (part of) an answer: "tick" is a tick, "price"/"preço" a price; both at once is a contradiction (undefined). */
function nounUnit(text: string): 'PRICE' | 'TICK' | null | undefined {
  const tick = /\bticks?\b/u.test(text), price = /(?<![\p{L}])(?:price|pre[cç]o)s?(?![\p{L}])/u.test(text);
  return tick && price ? undefined : tick ? 'TICK' : price ? 'PRICE' : null;
}
/** One unit for values and the nouns around them, or undefined when they contradict each other ("lower tick 150 usdc", "min price 150 max tick 900"). */
function agreed(...units: ('PRICE' | 'TICK' | null | undefined)[]): 'PRICE' | 'TICK' | null | undefined {
  if (units.includes(undefined)) return undefined;
  const named = [...new Set(units.filter((unit): unit is 'PRICE' | 'TICK' => unit !== null))];
  return named.length > 1 ? undefined : named[0] ?? null;
}
const SEPARATOR = String.raw`\s*(?:to|and|a|at[eé]|e|through|-|até)\s*`;

/** Reads a short answer to FloFi's open range question; null when it is not one. */
export function readRangeAnswer(raw: string, units: RangeUnits | null): RangeAnswer | null {
  if (typeof raw !== 'string' || raw.length > 120) return null;
  const plain = light(raw), text = core(plain);
  if (!text) return null;
  const kind = (pattern: string) => [plain, text].some(value => whole(String.raw`(?:(?:use|usa|usar|quero|prefiro|i want|go with|a|an|the|uma|um|o)\s+)*${pattern}`).test(value));
  if (kind(String.raw`(?:full(?:[- ]price)?(?:[- ]range)?|whole range|entire range|infinite range|faixa (?:completa|inteira|toda|total)|toda a faixa|range (?:completo|total|inteiro))`))
    return { kind: 'FULL' };
  if (kind(String.raw`(?:percent(?:age)?|percentual|porcentagem)(?: (?:range|faixa|band))?|(?:faixa|range) (?:percentual|em porcentagem|de porcentagem)`)) return { kind: 'PERCENT', percent: null };
  if (kind(String.raw`(?:prices?|price range|by price|faixa de pre[cç]os?|pre[cç]os?|por pre[cç]o)`)) return { kind: 'UNIT', unit: 'PRICE' };
  if (kind(String.raw`(?:specific |exact |by |em |por )?ticks?`)) return { kind: 'UNIT', unit: 'TICK' };
  const percent = whole(String.raw`${SIGN}?\s*(\d+(?:[.,]\d{1,2})?)\s*${PCT}`).exec(text);
  if (percent) { const value = canonical(percent[1]!); return value === null ? null : { kind: 'PERCENT', percent: value }; }
  // Both bounds: "150 to 180", "between 150 and 180", "de 150 a 180", "ticks -600 to 600", "lower 150 upper 180".
  const ticks = whole(String.raw`(?:ticks?\s+)?(?:from\s+|between\s+|entre\s+|de\s+)?${VALUE}${SEPARATOR}${VALUE}(?:\s+ticks?)?`).exec(text);
  if (ticks) {
    const a = valueOf(ticks, 1, units), b = valueOf(ticks, 5, units);
    // "ticks 150 to 180 usdc" names two units: not a range answer.
    const named = a && b ? agreed(/ticks?/.test(text) ? 'TICK' : null, a.unit, b.unit) : undefined;
    if (a && b && named !== undefined) {
      const unit = named ?? (a.value.startsWith('-') || b.value.startsWith('-') ? 'TICK' : 'PRICE');
      if (unit === 'PRICE' && (a.value.startsWith('-') || b.value.startsWith('-'))) return null;
      return { kind: 'BOUNDS', unit, lower: a.value, upper: b.value };
    }
    return null;
  }
  const pair = whole(String.raw`${LOWER}${NOUN}\s*(?:is|=|:|é|of|de|em)?\s*${VALUE}\s*(?:,|and|e)?\s*${UPPER}${NOUN}\s*(?:is|=|:|é|of|de|em)?\s*${VALUE}`).exec(text)
    ?? whole(String.raw`${UPPER}${NOUN}\s*(?:is|=|:|é|of|de|em)?\s*${VALUE}\s*(?:,|and|e)?\s*${LOWER}${NOUN}\s*(?:is|=|:|é|of|de|em)?\s*${VALUE}`).exec(text);
  if (pair) {
    const first = valueOf(pair, 1, units), second = valueOf(pair, 5, units), upperFirst = new RegExp(`^${UPPER}`, 'iu').test(text);
    if (!first || !second) return null;
    const lower = upperFirst ? second : first, upper = upperFirst ? first : second;
    // The side nouns name the unit too ("lower tick 600 upper tick 900" are ticks); nouns and values that disagree are not a range answer.
    const named = agreed(nounUnit(text), lower.unit, upper.unit);
    if (named === undefined) return null;
    const unit = named ?? (lower.value.startsWith('-') || upper.value.startsWith('-') ? 'TICK' : 'PRICE');
    if (unit === 'PRICE' && (lower.value.startsWith('-') || upper.value.startsWith('-'))) return null;
    return { kind: 'BOUNDS', unit, lower: lower.value, upper: upper.value };
  }
  // A side and its value: "lower 150", "upper is 180", "o superior é 180", "make the lower 120", "150 as the lower".
  const VERB = String.raw`(?:(?:make|set|change|use|move|put|muda(?:r)?|troca(?:r)?|altera(?:r)?|coloca(?:r)?|define|definir|deixa|ajusta(?:r)?)\s+)?(?:the\s+|o\s+|a\s+)?`;
  const LINK = String.raw`\s*(?:is|=|:|to|é|e|para|pra|em|de|as|at|should be|deve ser|ser[aá])?\s*`;
  for (const [side, word] of [['LOWER', LOWER], ['UPPER', UPPER]] as const) {
    const before = whole(String.raw`${VERB}(?:(?:price|pre[cç]o|ticks?)\s+)?${word}${NOUN}${LINK}${VALUE}`).exec(text);
    // A noun naming the unit ("lower tick", "preço inferior") counts as the value's own unit; a contradiction is not a range answer.
    // A noun before or after the value ("lower tick 600", "600 as the lower tick") names its unit as well.
    const named = (match: RegExpExecArray, value: { value: string; unit: 'PRICE' | 'TICK' | null }) => {
      const unit = agreed(nounUnit(match[0]), value.unit);
      if (unit === undefined) return null;
      return unit === 'PRICE' && value.value.startsWith('-') ? null : { kind: 'SIDE' as const, side, value: value.value, unit };
    };
    if (before) { const value = valueOf(before, 1, units); return value ? named(before, value) : null; }
    const after = whole(String.raw`${VALUE}\s*(?:is|é|as|como|for|para|pra)?\s*(?:the\s+|o\s+|a\s+)?${word}${NOUN}`).exec(text);
    if (after) { const value = valueOf(after, 1, units); return value ? named(after, value) : null; }
    if (whole(String.raw`(?:(?:it'?s|it is|that'?s|that is|é|e|eh|seria|is|as)\s+)?(?:the\s+|o\s+|a\s+|como\s+)?${word}${NOUN}`).test(text)) {
      const unit = nounUnit(text);
      return unit === undefined ? null : { kind: 'SIDE', side, value: null, ...unit ? { unit } : {} };
    }
  }
  const single = whole(String.raw`(?:(?:it'?s|it is|é|seria)\s+)?${VALUE}`).exec(text);
  if (single) { const value = valueOf(single, 1, units); return value ? { kind: 'VALUE', value: value.value, unit: value.unit } : null; }
  return null;
}

const bounded = (unit: CopilotLiquidityAction['rangeUnit']): unit is 'PRICE' | 'TICK' => unit === 'PRICE' || unit === 'TICK';
/** A bound unit for a value: the open range's own (prices or ticks), else ticks for a negative value, else prices. */
const unitFor = (action: CopilotLiquidityAction, value: string | null, unit: 'PRICE' | 'TICK' | null = null): 'PRICE' | 'TICK' =>
  unit ?? (bounded(action.rangeUnit) ? action.rangeUnit : value?.startsWith('-') ? 'TICK' : 'PRICE');
/**
 * The range after one answer. Only range fields change (deposits, network, fee tier and slippage stay exactly as they were); a bound already
 * given changes only when the answer names it. Null: the answer does not fit the open range (it goes to the interpreter).
 */
export function applyRangeAnswer(action: CopilotLiquidityAction, hold: RangeHold | null, answer: RangeAnswer,
  /** FloFi's open question asked for the percentage itself ("Which percentage range?"): a bare number answers it, replacing one it could not use. */
  percentAsked = false): RangeStep | null {
  const range = (rangeUnit: CopilotLiquidityAction['rangeUnit'], lower: string | null, upper: string | null): CopilotLiquidityAction => ({ ...action, rangeUnit, lower, upper });
  switch (answer.kind) {
    case 'FULL': return { action: range('FULL', null, null), hold: null, ask: null };
    // Choosing the kind already in use keeps the bounds given; another kind starts them afresh.
    case 'UNIT': return { action: action.rangeUnit === answer.unit ? action : range(answer.unit, null, null), hold: null, ask: null };
    // "a percentage range" again keeps a percentage already given.
    case 'PERCENT': return { action: answer.percent === null && action.rangeUnit === 'PERCENT' ? action : range('PERCENT', null, answer.percent), hold: null, ask: null };
    case 'BOUNDS': return { action: range(answer.unit, answer.lower, answer.upper), hold: null, ask: null };
    case 'SIDE': {
      // The unit named now, or the one named with the held value ("600 ticks" then "lower"); two different units are not an answer.
      const named = agreed(answer.unit ?? null, answer.value === null ? hold?.unit ?? null : null);
      if (named === undefined) return null;
      const value = answer.value ?? hold?.value ?? null, unit = unitFor(action, value, named);
      // Switching from a percentage or the full range to bounds starts the bounds afresh.
      const keep = bounded(action.rangeUnit) && action.rangeUnit === unit;
      const lower = keep ? action.lower : null, upper = keep ? action.upper : null;
      if (value === null) return { action: range(unit, lower, upper), hold: { side: answer.side, ...answer.unit ? { unit: answer.unit } : {} }, ask: 'BOUND' };
      return { action: answer.side === 'LOWER' ? range(unit, value, upper) : range(unit, lower, value), hold: null, ask: null };
    }
    case 'VALUE': {
      const named = agreed(answer.unit, hold?.side ? hold.unit ?? null : null);
      if (named === undefined) return null;
      const unit = unitFor(action, answer.value, named);
      if (hold?.side) {
        const keep = bounded(action.rangeUnit) && action.rangeUnit === unit;
        const lower = keep ? action.lower : null, upper = keep ? action.upper : null;
        return { action: hold.side === 'LOWER' ? range(unit, answer.value, upper) : range(unit, lower, answer.value), hold: null, ask: null };
      }
      // The percentage FloFi asked for ("10" after "which percentage?").
      if (action.rangeUnit === 'PERCENT' && (action.upper === null || percentAsked) && answer.unit === null && !answer.value.startsWith('-'))
        return { action: range('PERCENT', null, answer.value), hold: null, ask: null };
      if (bounded(action.rangeUnit) && action.rangeUnit === unit && (action.lower === null) !== (action.upper === null))
        return { action: action.lower === null ? range(unit, answer.value, action.upper) : range(unit, action.lower, answer.value), hold: null, ask: null };
      // A value whose side is not known: FloFi asks whether it is the lower or the upper bound (it never guesses).
      return { action, hold: { value: answer.value, ...answer.unit ? { unit: answer.unit } : {} }, ask: 'SIDE' };
    }
  }
}
