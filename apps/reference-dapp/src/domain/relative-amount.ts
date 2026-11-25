// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001 (beta incident "Converta todo o USDC que tenho em ETH"): an amount the user stated RELATIVE to their own
 * wallet balance — "all my USDC", "todo o USDC que tenho", "half my ETH", "metade do meu SOL", "25% of my SOL", "25% do meu SOL".
 *
 * Deterministic and dependency-free. It never produces a number by itself: FloFi still asks its structured amount question, and the balance
 * shortcut (`amount-shortcuts.ts`) answers it from a fresh, consented read of the exact asset in the wallet that would sign — the same path and
 * the same checks as the person pressing 25% · 50% · 75% · Max. Without an authoritative balance nothing is answered and the person types it.
 */
export type RelativeAmount = { readonly kind: 'ALL' } | { readonly kind: 'PERCENT'; readonly percent: string };

const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** Words after "todo/toda" that make it a schedule or a quantity of time, never a balance ("todo dia", "toda semana", "todo mês"). */
const TIME = String.raw`(?:dia|dias|semana|semanas|mes|meses|ano|anos|hora|horas|minuto|minutos|segunda|terca|quarta|quinta|sexta|sabado|domingo|manha|tarde|noite|vez|momento|caso|mundo|lugar)\b`;
const ALL = [
  // "todo o USDC (que tenho)", "toda a minha WETH", "todo meu SOL", "todos os meus USDC"
  new RegExp(String.raw`\b(?:todo|toda|todos|todas)\s+(?:(?:o|a|os|as)\s+)?(?:(?:meu|minha|meus|minhas)\s+)?(?!${TIME})[a-z$][\w.$]*`),
  // "all my USDC", "all of my ETH", "all the USDC I have", "all of the SOL"
  /\ball\s+(?:of\s+)?(?:my|the)\s+[a-z$][\w.$]*/,
  // "my entire/whole USDC balance", "meu saldo inteiro/todo de USDC", "o máximo de USDC", "the max USDC"
  /\b(?:my\s+(?:entire|whole|full)|(?:meu|o)\s+saldo\s+(?:inteiro|todo|total)|(?:o|the)\s+(?:maximo|max|maximum)\s+(?:de|do|da|of)\s+(?:meu\s+|minha\s+|my\s+)?)/,
  /\beverything\s+i\s+have\b|\btudo\s+(?:o\s+)?que\s+(?:eu\s+)?tenho\b/,
];
const HALF = /\b(?:half\s+(?:of\s+)?(?:my|the)\b|metade\s+(?:do|da|dos|das|de)\b)/;
/** "25% of my SOL", "25 por cento do meu SOL"; never a slippage ("slippage 1%", "1% de slippage"). */
const PERCENT = /(?<![\w.,])(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s*cento|percent)\s+(?:of|do|da|dos|das|de)\s+(?!(?:slippage|deslizamento|desvio|price|preco|impacto)\b)(?:(?:my|meu|minha|meus|minhas|the|o|a)\s+)?[a-z$][\w.$]*/;
const SLIPPAGE_NEAR = /\b(?:slippage|deslizamento|price\s+difference|diferenca\s+de\s+preco)\b/;

/** The relative amount the user wrote, or null. A percentage must be in (0, 100]; anything else is not read as one. */
export function relativeAmountIn(raw: string): RelativeAmount | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  const text = fold(raw);
  const percent = PERCENT.exec(text);
  if (percent && !SLIPPAGE_NEAR.test(text.slice(Math.max(0, percent.index - 24), percent.index))) {
    const value = percent[1]!.replace(',', '.');
    const number = Number(value);
    if (Number.isFinite(number) && number > 0 && number <= 100) return number === 100 ? { kind: 'ALL' } : { kind: 'PERCENT', percent: value.replace(/\.?0+$/, '') || value };
  }
  if (HALF.test(text)) return { kind: 'PERCENT', percent: '50' };
  return ALL.some(pattern => pattern.test(text)) ? { kind: 'ALL' } : null;
}

/** The percentage in basis points of a hundred (12.5% → 1250), for integer math; ALL is 10000. */
export function relativeBasisPoints(relative: RelativeAmount): bigint {
  if (relative.kind === 'ALL') return 10_000n;
  const [whole, fraction = ''] = relative.percent.split('.');
  return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
}
