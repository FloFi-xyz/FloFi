// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PUBLIC_STRATEGY_ACTIONS, PublicStrategyInputSchema } from './strategy-spec';
import { supportedNetworks } from './capability-catalog';
import { STRATEGY_EXAMPLES } from './strategy-examples';

/**
 * P0-D (catalog coherence): what the public tool contract accepts and what discovery advertises are one list. Before this test, the strategy
 * schema accepted every directed bridge pair with Solana while `get_supported_networks` and `get_capabilities` listed none of them, and nothing
 * failed when either side drifted.
 */
type Branch = { properties?: Record<string, { const?: unknown; anyOf?: { const?: unknown }[] }>; anyOf?: Branch[] };
const schema = JSON.parse(JSON.stringify(PublicStrategyInputSchema)) as { anyOf: Branch[] };
const constsOf = (field?: { const?: unknown; anyOf?: { const?: unknown }[] }) =>
  field ? field.anyOf ? field.anyOf.map(item => item.const).filter((v): v is string => typeof v === 'string') : typeof field.const === 'string' ? [field.const] : [] : [];
// KAN-20: an action's branch may be a union of objects (the EVM and the Solana Batch Payment): every member's networks are accepted.
const members = (item: Branch): Branch[] => item.anyOf ? item.anyOf.flatMap(members) : [item];
function schemaNetworks(action: string): { source: string[]; destination: string[] } {
  const branches = schema.anyOf.flatMap(members).filter(item => item.properties?.action?.const === action);
  if (!branches.length) return { source: [], destination: [] };
  const all = (pick: (p: NonNullable<Branch['properties']>) => string[]) => [...new Set(branches.flatMap(b => pick(b.properties!)))].sort();
  return { source: all(p => constsOf(p.network ?? p.sourceNetwork)), destination: all(p => constsOf(p.destinationNetwork)) };
}

describe('P0-D: the public strategy contract and discovery advertise the same networks for every action', () => {
  const discovered = supportedNetworks('PUBLIC_MAINNET');
  for (const action of PUBLIC_STRATEGY_ACTIONS) it(action, () => {
    const accepted = schemaNetworks(action);
    const advertised = discovered.filter(n => n.actions.includes(action as never)).map(n => n.id).sort();
    expect(accepted.source.length).toBeGreaterThan(0);
    expect(advertised).toEqual(accepted.source);
    if (action === 'bridge') {
      // Every directed pair the contract accepts is a catalog row, so each one is discovered, composed and reported with its own status.
      const rows = STRATEGY_EXAMPLES.flatMap(e => e.strategy.action === 'bridge' && 'sourceNetwork' in e.strategy && accepted.source.includes(e.strategy.sourceNetwork)
        ? [`${e.strategy.sourceNetwork}>${e.strategy.destinationNetwork}`] : []);
      const pairs = accepted.source.flatMap(s => accepted.destination.filter(d => d !== s).map(d => `${s}>${d}`));
      expect([...new Set(rows)].sort()).toEqual(pairs.sort());
    }
  });
});
