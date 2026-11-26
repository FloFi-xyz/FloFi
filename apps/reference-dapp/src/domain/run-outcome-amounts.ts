// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (incident 10): what a reconciled workflow-run step received, in its token's own units, for the
 * `/approve` run panel that ChatGPT, Claude and Telegram open. The run's outcome records base units by CAIP-19 asset; the decimals and symbol come
 * only from the network's own asset catalog. An asset the catalog does not resolve is left out (never guessed); presentation only.
 */
import { resolveNetworkAsset } from './asset-catalogs';

export type ReceivedAmount = { readonly asset: string; readonly units: string; readonly decimals: number; readonly symbol: string };
const UNITS = /^(0|[1-9][0-9]*)$/;

export function reconciledReceived(step: { readonly state: string; readonly outcome: { readonly received: readonly { readonly asset: string; readonly amount: string }[] } | null },
  resolve: typeof resolveNetworkAsset = resolveNetworkAsset): readonly ReceivedAmount[] {
  if (step.state !== 'RECONCILED' || !step.outcome) return [];
  const out: ReceivedAmount[] = [];
  for (const fact of step.outcome.received.slice(0, 4)) {
    if (typeof fact?.asset !== 'string' || typeof fact.amount !== 'string' || !UNITS.test(fact.amount)) continue;
    const [chain, reference] = fact.asset.split('/');
    if (!chain || !reference) continue;
    const evm = chain.startsWith('eip155:');
    const id = evm && /^native:/i.test(reference) ? `${chain}/slip44:60` : evm ? `${chain}/${reference.toLowerCase()}` : fact.asset;
    let asset: ReturnType<typeof resolveNetworkAsset>;
    try { asset = resolve(chain, { id }); } catch { asset = null; }
    if (asset && Number.isInteger(asset.decimals)) out.push({ asset: fact.asset, units: fact.amount, decimals: asset.decimals, symbol: asset.symbol });
  }
  return out;
}
