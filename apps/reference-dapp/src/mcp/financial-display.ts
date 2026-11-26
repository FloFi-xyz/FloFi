// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-POST-257-HOTFIX-001 (P1-5): one canonical presentation of a preview's amounts for MCP hosts.
 *
 * `simulate_strategy` returned base units ("Amounts are integer native units of the named tokens"), so every host did its own decimal
 * conversion and rounding, and the same quote read differently in ChatGPT, Claude and FloFi. These lines are built with the shared display
 * rule of the FloFi app and Telegram (`formatDisplayTokenAmount`: six significant digits, `≈` only on an estimate, a minimum rounded down),
 * from facts the preview already carries. Presentation only: the exact facts stay in the result; nothing here is a new quote.
 */
import { formatDisplayTokenAmount, type DisplayLanguage } from '../domain/token-amount-display.ts';

type Facts = Readonly<Record<string, unknown>>;
const obj = (value: unknown): Facts => value && typeof value === 'object' && !Array.isArray(value) ? value as Facts : {};
const units = (value: unknown): string | null => typeof value === 'string' && /^[0-9]{1,78}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const decimals = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
const symbol = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9.$_-]{1,24}$/.test(value) ? value : null;

const LABELS = {
  EN: { pay: 'You pay', receive: 'You receive (estimated)', minimum: 'Minimum received', provider: 'Route' },
  PT: { pay: 'Você paga', receive: 'Você recebe (estimado)', minimum: 'Mínimo recebido', provider: 'Rota' },
} as const;

type Amounts = { readonly in: { readonly units: string; readonly decimals: number; readonly symbol: string }; readonly expected: string | null;
  readonly minimum: string | null; readonly out: { readonly decimals: number; readonly symbol: string }; readonly provider: string | null };

function amountsOf(kind: string, facts: Facts): Amounts | null {
  if (kind === 'SWAP_QUOTE') {
    const amount = units(facts.amountIn), inDecimals = decimals(facts.inputDecimals), outDecimals = decimals(facts.outputDecimals);
    const inSymbol = symbol(facts.inputSymbol), outSymbol = symbol(facts.outputSymbol);
    if (!amount || inDecimals === null || outDecimals === null || !inSymbol || !outSymbol) return null;
    return { in: { units: amount, decimals: inDecimals, symbol: inSymbol }, expected: units(facts.expectedOut), minimum: units(facts.minimumOut),
      out: { decimals: outDecimals, symbol: outSymbol }, provider: null };
  }
  if (kind === 'CROSS_CHAIN_ROUTE') {
    const quote = obj(facts.quote), input = obj(quote.inputToken), output = obj(quote.outputToken);
    const amount = units(quote.inputAmount), inDecimals = decimals(input.decimals), outDecimals = decimals(output.decimals);
    const inSymbol = symbol(input.symbol), outSymbol = symbol(output.symbol);
    if (!amount || inDecimals === null || outDecimals === null || !inSymbol || !outSymbol) return null;
    return { in: { units: amount, decimals: inDecimals, symbol: inSymbol }, expected: units(quote.expectedOutput), minimum: units(quote.minimumOutput),
      out: { decimals: outDecimals, symbol: outSymbol }, provider: symbol(quote.provider) };
  }
  return null;
}

const MOCKED = { EN: 'Simulated with test data, not a live quote.', PT: 'Simulado com dados de teste, não é uma cotação real.' } as const;
/**
 * The lines a host shows for a preview, in EN and PT, or null when the preview carries no amounts of this shape. A host quotes the person's language
 * verbatim instead of converting base units itself. A mocked preview says so first (honest provenance on harness deployments).
 */
export function previewDisplay(kind: string, facts: unknown, provenance?: string): { readonly EN: readonly string[]; readonly PT: readonly string[] } | null {
  const en = previewLines(kind, facts, 'EN'), pt = previewLines(kind, facts, 'PT');
  if (!en || !pt) return null;
  return provenance === 'MOCKED' ? { EN: [MOCKED.EN, ...en], PT: [MOCKED.PT, ...pt] } : { EN: en, PT: pt };
}
function previewLines(kind: string, facts: unknown, language: DisplayLanguage): readonly string[] | null {
  const amounts = amountsOf(kind, obj(facts));
  if (!amounts) return null;
  const label = LABELS[language], out = (value: string | null, rounding: 'nearest' | 'down') => value === null ? null
    : formatDisplayTokenAmount({ units: value, decimals: amounts.out.decimals }, { rounding, language, symbol: amounts.out.symbol });
  const lines = [`${label.pay}: ${formatDisplayTokenAmount({ units: amounts.in.units, decimals: amounts.in.decimals }, { rounding: 'nearest', language, symbol: amounts.in.symbol, marker: false })}`];
  const expected = out(amounts.expected, 'nearest'), minimum = out(amounts.minimum, 'down');
  if (expected) lines.push(`${label.receive}: ${expected}`);
  if (minimum) lines.push(`${label.minimum}: ${minimum}`);
  if (amounts.provider) lines.push(`${label.provider}: ${amounts.provider}`);
  return lines;
}
