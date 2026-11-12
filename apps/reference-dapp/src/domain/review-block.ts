// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Board 06 ("Simular e revisar"): what the whole-workflow Review says the owner is authorizing, in plain words. Presentation only: every value
 * is the Editor's existing Review (`EditorExecutionReview`) — its steps, the first group's prepared calls and fee, and its wallet-request
 * counts. Nothing here quotes, estimates, rounds a limit in the owner's disfavour or decides anything; an amount shown shorter than its full
 * value carries the full value for a tooltip.
 */
import type { EditorExecutionReview, ReviewAmount } from '../editor/workflow-execution';

/** A catalog key and its parameters; `full` holds the untruncated amounts (tooltip). */
export type ReviewBlockText = { readonly key: string; readonly parameters: readonly string[]; readonly full: string | null };
export type ReviewBlockView = {
  readonly steps: readonly ReviewBlockText[];
  /** The workflow's final asset and its signed minimum (a bridge's exact delivery), or "quoted when due". */
  readonly minimum: ReviewBlockText | null;
  /** The maximum network fee of the prepared requests; `partial` when a later request is quoted only when it is due. */
  readonly fee: ReviewBlockText | null;
  /** One sentence per token approval in the prepared request ("Uniswap uses up to 2 USDC"); a fallback sentence when none is known. */
  readonly permissions: readonly ReviewBlockText[];
  readonly walletRequests: ReviewBlockText;
};

const SIGNIFICANT = 6;
/**
 * A decimal amount with at most 6 significant digits. `down` (a minimum, what the owner receives) never overstates; `up` (what the owner spends
 * or pays at most) never understates. The full value is kept for the tooltip.
 */
export function shortDecimal(units: string, decimals: number, mode: 'down' | 'up'): string {
  if (!/^[0-9]+$/.test(units)) return units;
  const value = BigInt(units);
  if (value === 0n) return '0';
  const digits = value.toString().length, drop = Math.max(0, digits - SIGNIFICANT);
  const step = 10n ** BigInt(drop);
  const kept = mode === 'down' ? value / step * step : (value + step - 1n) / step * step;
  const text = kept.toString().padStart(decimals + 1, '0');
  const whole = decimals ? text.slice(0, -decimals) : text, fraction = decimals ? text.slice(-decimals).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
const amount = (a: ReviewAmount, mode: 'down' | 'up') => `${shortDecimal(a.units, a.decimals, mode)} ${a.symbol}`;
/** The full value only when the short one differs from it. */
const fullOf = (values: readonly (ReviewAmount | null | undefined)[], mode: 'down' | 'up'): string | null => {
  const shown = values.filter((v): v is ReviewAmount => Boolean(v));
  return shown.some(v => amount(v, mode) !== v.text) ? shown.map(v => v.text).join(' · ') : null;
};
const text = (key: string, parameters: readonly string[] = [], full: string | null = null): ReviewBlockText => ({ key, parameters, full });

const ETH = 10n ** 18n;
/** A native amount in wei, rounded UP to 6 decimals (a ceiling is never understated). */
const ethUp = (wei: bigint) => {
  const step = 10n ** 12n, shown = (wei + step - 1n) / step * step;
  if (wei > 0n && shown === 0n) return '< 0.000001 ETH';
  const fraction = (shown % ETH).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${shown / ETH}${fraction ? `.${fraction}` : ''} ETH`;
};
/** Who a token approval lets spend: the protocol the step's call goes to (a batched bridge is always a direct Across deposit). */
const SPENDER: ReadonlyMap<string, string> = new Map([['swap', 'Uniswap'], ['bridge', 'Across'], ['supply', 'Aave'], ['repay', 'Aave']]);

/** One plain line per step: verb, amount, asset, network. */
function stepLine(step: EditorExecutionReview['steps'][number]): ReviewBlockText {
  const spend = step.spend, out = step.minimum ?? step.expected;
  const spent = spend ? amount(spend, 'up') : null, full = fullOf([spend], 'up');
  switch (step.action) {
    case 'swap': return spent && out ? text('Swap {0} → {1} · {2}', [spent, out.symbol, step.network], full)
      : spent ? text('Swap {0} · {1}', [spent, step.network], full) : text('Swap · {0}', [step.network]);
    case 'bridge': return spent && step.destination ? text('Bridge {0} to {1}', [spent, step.destination], full)
      : text('Bridge from {0} to {1}', [step.network, step.destination ?? '—']);
    case 'supply': return spent ? text('Supply {0} to Aave · {1}', [spent, step.network], full) : text('Supply to Aave · {0}', [step.network]);
    case 'repay': return spent ? text('Repay {0} to Aave · {1}', [spent, step.network], full) : text('Repay to Aave · {0}', [step.network]);
    case 'borrow': return out ? text('Borrow {0} from Aave · {1}', [amount(out, 'down'), step.network], fullOf([out], 'down')) : text('Borrow from Aave · {0}', [step.network]);
    case 'withdraw': return out ? text('Withdraw {0} from Aave · {1}', [amount(out, 'down'), step.network], fullOf([out], 'down')) : text('Withdraw from Aave · {0}', [step.network]);
    case 'transfer': return spent && step.recipient ? text('Send {0} to {1} · {2}', [spent, `${step.recipient.slice(0, 6)}…${step.recipient.slice(-4)}`, step.network], full)
      : text('Send · {0}', [step.network]);
    default: return spent ? text('{0} {1} · {2}', [step.action, spent, step.network], full) : text('{0} · {1}', [step.action, step.network]);
  }
}

export function reviewBlockView(review: EditorExecutionReview): ReviewBlockView {
  const last = review.steps[review.steps.length - 1];
  const received = last ? last.minimum ?? (last.action === 'bridge' || last.action === 'borrow' || last.action === 'withdraw' ? last.expected : null) : null;
  const minimum = !last ? null : received ? text('{0}', [amount(received, 'down')], fullOf([received], 'down'))
    : ['swap', 'bridge'].includes(last.action) ? text('Quoted when this step becomes due') : null;
  // The fee: the prepared requests' ceilings, summed (every one is paid in ETH on the EVM networks this path batches).
  const priced = review.groups.filter(g => g.fee), total = priced.reduce((sum, g) => sum + BigInt(g.fee!.maxWei), 0n);
  const fee = priced.length === 0 ? text('Quoted when each request is due')
    : priced.length < review.groups.length ? text('{0} + later requests, quoted when due', [ethUp(total)]) : text('{0}', [ethUp(total)]);
  // Token permissions: each step whose prepared calls include an approval lets its protocol spend exactly the step's amount.
  const prepared = review.groups.filter(g => g.calls);
  const approving = [...new Set(prepared.flatMap(g => g.calls!.filter(c => c.kind === 'ERC20_APPROVE').map(c => c.step)))].sort((a, b) => a - b);
  const permissions = approving.flatMap(index => {
    const step = review.steps.find(s => s.index === index);
    if (!step?.spend) return [];
    const spender = step.provider?.replace(/ V\d+$/, '') ?? SPENDER.get(step.action) ?? step.action;
    return [text('{0} uses up to {1}', [spender, amount(step.spend, 'up')], fullOf([step.spend], 'up'))];
  });
  const laterGroups = prepared.length < review.groups.length;
  const permissionLines = permissions.length ? [...permissions, ...laterGroups ? [text('Later steps ask when they are due')] : []]
    : [text(laterGroups ? 'Asked when each step is due' : 'None needed')];
  const counts = review.counts;
  return { steps: review.steps.map(stepLine), minimum, fee, permissions: permissionLines,
    walletRequests: counts.atLeast ? text('at least {0}', [String(counts.walletPrompts)]) : text('{0}', [String(counts.walletPrompts)]) };
}
