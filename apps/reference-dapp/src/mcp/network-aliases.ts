// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 catalog reliability (P0-D, verified in production on 2026-11-08): `get_supported_networks` returns each network's `name` ("Ethereum") and
 * CAIP-2 `chainId` ("eip155:1"), but every tool's input schema accepts only the id ("ethereum"). A client that used the name it was just given was
 * refused before the engine with `/strategy/network const`. A network field is now read through FloFi's own network registry first: the id, the
 * registry name, a registry alias or the CAIP-2 chain id, compared case-insensitively, becomes the canonical id. Only networks of the tool's
 * scope are recognised (a test network never becomes a mainnet or the reverse), nothing is guessed (no "eth", "mainnet"), and any other value
 * still fails the closed schema exactly as before. The canonical id is what the engine composes, so the IR and its hash are unchanged.
 */
import { NETWORKS } from '../domain/network-registry';

const FIELDS = ['network', 'sourceNetwork', 'destinationNetwork', 'targetNetwork'] as const;
const NESTED = ['strategy', 'goal'] as const;

/** The canonical network id `value` names within `allowed`, or null. */
export function canonicalNetworkId(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  if (!wanted || wanted.length > 64) return null;
  const match = NETWORKS.filter(network => allowed.includes(network.key))
    .find(network => [network.key, network.name, network.chain, ...network.aliases].some(name => name.toLowerCase() === wanted));
  return match?.key ?? null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function withCanonicalFields(value: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const field of FIELDS) {
    if (!(field in value) || typeof value[field] !== 'string' || allowed.includes(value[field] as string)) continue;
    const id = canonicalNetworkId(value[field], allowed);
    if (id) (next ??= { ...value })[field] = id;
  }
  return next ?? value;
}

/**
 * A tool input with every network field canonicalised (a new object when anything changed; the input is never mutated). Covers the tool's own
 * filters, a strategy (version 1) and each step of a workflow (version 2), and a planning goal.
 */
export function canonicalNetworkFields<T>(input: T, allowed: readonly string[]): T {
  if (!isRecord(input)) return input;
  let result = withCanonicalFields(input, allowed);
  for (const key of NESTED) {
    const nested = result[key];
    if (!isRecord(nested)) continue;
    let next = withCanonicalFields(nested, allowed);
    if (Array.isArray(next.steps)) {
      const steps = next.steps.map(step => isRecord(step) ? withCanonicalFields(step, allowed) : step);
      if (steps.some((step, index) => step !== (next.steps as unknown[])[index])) next = { ...next, steps };
    }
    if (next !== nested) result = { ...result === input ? { ...input } : result, [key]: next };
  }
  return result as T;
}
