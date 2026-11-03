// SPDX-License-Identifier: AGPL-3.0-only
import type { Workflow } from './initial-workflow';
import { solanaSwapDetails } from './jupiter-authoring';
import { routerDetails } from './router-authoring';
import { universalBridgeDetails } from './universal-bridge-authoring';
import { formatSlippage } from './slippage-policy';

/**
 * BUILD-FLOFI-BUILDER-UX-002: the compact summary a Canvas step card states. Presentation only: every value is read from the step itself (or from
 * the draft the card already shows); nothing here edits, validates, quotes, links or orders a step, and a value the step does not hold is left out,
 * never estimated or invented.
 */
export type CanvasCardSummaryInput = {
  readonly action: string; readonly provider: string; readonly chain: string; readonly amount: string;
  readonly detail?: string | undefined; readonly bridgePair?: string | undefined;
};

/** Network labels carry their chain number elsewhere on the card; the flow line names the network only. */
const networkName = (label: string) => label.replace(/ \(\d+\)$/, '').trim();
const tokenOf = (amount: string) => /^\S+ (\S+)$/.exec(amount.trim())?.[1];

/**
 * The card's one-line flow: what goes in, and where it goes (`USDC → WETH`, `USDC · Base → Arbitrum`, `USDC → Aave V3`). It never repeats an
 * amount: the card's value boxes show the amount, drafts included, so the line cannot disagree with them. Liquidity cards have none (their two
 * value boxes already name both assets).
 */
export function canvasCardFlow(summary: CanvasCardSummaryInput, recipient?: string | null): string | null {
  const token = tokenOf(summary.amount);
  switch (summary.action) {
    case 'Swap': case 'Stocks': return summary.detail?.includes(' → ') ? summary.detail : null;
    case 'Bridge': {
      const [from, to] = (summary.bridgePair ?? '').split(' → ').map(side => side.trim());
      const [source, destination] = summary.chain.split(' → ').map(networkName);
      if (!source || !destination) return null;
      // An asset not chosen yet (a destination change can clear it) is left out: the route alone, never a same-asset bridge it is not.
      if (!from || !to) return `${source} → ${destination}`;
      return `${to !== from ? `${from} → ${to}` : from} · ${source} → ${destination}`;
    }
    case 'Supply': case 'Repay': return token && summary.provider ? `${token} → ${summary.provider}` : null;
    case 'Borrow': case 'Withdraw': return token && summary.provider ? `${summary.provider} → ${token}` : null;
    case 'Send': return token ? recipient ? `${token} → ${recipient}` : token : null;
    default: return null;
  }
}

/** A key parameter the step itself holds, with its display text. */
export type CanvasCardParam = { readonly key: 'slippage' | 'fee-tier'; readonly value: string };

/** A Uniswap/Orca fee tier (millionths: `500` → `0.05%`). */
const percent = (value: number, per: number) => `${(value / per).toFixed(2)}%`;
const basisPoints = (value: unknown) => {
  const parsed = typeof value === 'string' && /^[0-9]{1,5}$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * At most two short facts for the card's summary rows, each read from the canonical step: its configured maximum slippage (as FloFi shows a
 * slippage limit everywhere, `formatSlippage`: `0.5% (50 bps)`) and its liquidity fee tier. A step without one shows nothing for it (a 1:1
 * conversion has no slippage). Drafts that are not steps yet have none.
 */
export function canvasCardParams(node: Workflow['nodes'][number]): readonly CanvasCardParam[] {
  const params: CanvasCardParam[] = [];
  const constraint = node.userConstraints.find(item => item.kind === 'MAXIMUM_SLIPPAGE_BPS');
  const slippage = basisPoints(constraint?.kind === 'MAXIMUM_SLIPPAGE_BPS' ? constraint.maximumBps : undefined)
    ?? basisPoints(routerDetails(node)?.slippage) ?? basisPoints(universalBridgeDetails(node)?.slippage) ?? basisPoints(solanaSwapDetails(node)?.slippage);
  if (slippage !== null) params.push({ key: 'slippage', value: formatSlippage(slippage) });
  const fee = node.inputs.find(input => input.name === 'fee-tier');
  if (fee?.kind === 'INTEGER' && Number.isSafeInteger(fee.value) && fee.value > 0 && fee.value < 1_000_000) params.push({ key: 'fee-tier', value: percent(fee.value, 10_000) });
  return params;
}

/** A recipient as the flow line names it: a full address is shortened (the card's To field shows it whole). */
export function shortRecipient(address: string): string {
  const value = address.trim();
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
