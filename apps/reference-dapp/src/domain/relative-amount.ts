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
/** A written token, folded to compare: "Solana" is SOL, WETH is ETH (a balance question about either names the same coin family). */
const tokenKey = (value: string) => { const upper = value.replace(/[.!?,;:]+$/, '').toUpperCase(); return upper === 'SOLANA' ? 'SOL' : upper === 'WETH' ? 'ETH' : upper; };
const TOKEN = String.raw`([a-z$][\w.$]*)`;
/** "todo o USDC (que tenho)", "toda a minha WETH", "todo meu SOL", "todos os meus USDC" (never a schedule: "todo dia", "toda semana"). */
const ALL_PT = new RegExp(String.raw`\b(?:todo|toda|todos|todas)\s+(?:(?:o|a|os|as)\s+)?(?:(?:meu|minha|meus|minhas)\s+)?(?!${TIME})` + TOKEN);
/** "all my USDC", "all of my ETH", "all the USDC I have", "all of the SOL". */
const ALL_EN = new RegExp(String.raw`\ball\s+(?:of\s+)?(?:my|the)\s+` + TOKEN);
/** "everything I have", "tudo (o) que (eu) tenho", "my entire/whole balance", "meu saldo inteiro": the asset is named elsewhere in the sentence. */
const ALL_UNNAMED = /\beverything\s+i\s+have\b|\btudo\s+(?:o\s+)?que\s+(?:eu\s+)?tenho\b|\bmy\s+(?:entire|whole|full)\s+(?:balance|stack)\b|\bmeu\s+saldo\s+(?:inteiro|todo|total)\b/;
const HALF = new RegExp(String.raw`\b(?:half\s+(?:of\s+)?(?:my|the)|metade\s+(?:do|da|dos|das|de)(?:\s+(?:meu|minha|meus|minhas))?)\s+` + TOKEN);
/** "25% of my SOL", "25 por cento do meu SOL"; never a slippage ("slippage 1%", "1% de slippage"). */
const PERCENT = new RegExp(String.raw`(?<![\w.,])(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s*cento|percent)\s+(?:of|do|da|dos|das|de)\s+(?!(?:slippage|deslizamento|desvio|price|preco|impacto)\b)(?:(?:my|meu|minha|meus|minhas|the|o|a)\s+)?` + TOKEN);
const SLIPPAGE_NEAR = /\b(?:slippage|deslizamento|price\s+difference|diferenca\s+de\s+preco)\b/;

/**
 * The relative amount the user wrote about `asset` (the token FloFi is asking the amount of), or null. Without `asset`, any token counts (used
 * only to order FloFi's questions, never to answer one). A percentage must be in (0, 100]; anything else is not read as one.
 */
export function relativeAmountIn(raw: string, asset?: string | null): RelativeAmount | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  const text = fold(raw);
  const about = (written: string | undefined) => !asset || (written !== undefined && tokenKey(written) === tokenKey(asset));
  const percent = PERCENT.exec(text);
  if (percent && about(percent[2]) && !SLIPPAGE_NEAR.test(text.slice(Math.max(0, percent.index - 24), percent.index))) {
    const value = percent[1]!.replace(',', '.');
    const number = Number(value);
    // Only a fraction's trailing zeros go ("12.50" → "12.5"); a whole number keeps its own ("50" stays 50).
    if (Number.isFinite(number) && number > 0 && number <= 100) return number === 100 ? { kind: 'ALL' }
      : { kind: 'PERCENT', percent: value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value };
  }
  const half = HALF.exec(text);
  if (half && about(half[1])) return { kind: 'PERCENT', percent: '50' };
  for (const pattern of [ALL_PT, ALL_EN]) {
    const match = pattern.exec(text);
    if (match && about(match[1])) return { kind: 'ALL' };
  }
  const named = !asset || new RegExp(String.raw`(?<![\w$])(?:${tokenKey(asset) === 'SOL' ? 'sol|solana' : tokenKey(asset) === 'ETH' ? 'w?eth|ether' : asset.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\w$])`).test(text);
  return ALL_UNNAMED.test(text) && named ? { kind: 'ALL' } : null;
}

/** The percentage in basis points of a hundred (12.5% → 1250), for integer math; ALL is 10000. */
export function relativeBasisPoints(relative: RelativeAmount): bigint {
  if (relative.kind === 'ALL') return 10_000n;
  const [whole, fraction = ''] = relative.percent.split('.');
  return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
}
