// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Editor's server actions (Run workflow, whole-workflow Review and Authorize) read a Canvas workflow whose listed tokens must resolve exactly as
 * they did on the Canvas: the official catalogs of the networks its nodes use are registered first. Imported by server actions only (it is not one).
 */
import { NETWORK_CHAINS } from '../engine/capability-catalog';
import { NETWORK_IDS } from '../engine/strategy-spec';
import { prepareNetworkCatalogs } from '../platform/catalogs';
import { arbitrumAuthoringCatalog } from './arbitrum-mainnet';
import { baseAuthoringCatalog } from './base-mainnet';
import { ethereumAuthoringCatalog } from './ethereum-mainnet';
import { robinhoodAuthoringCatalog } from './robinhood-mainnet';
import { solanaAuthoringCatalog } from './solana-asset-catalog';

/** Registers the official catalogs of the networks the workflow's nodes use, so a listed token resolves exactly as it did on the Canvas. */
export async function prepareCatalogs(workflow: unknown): Promise<void> {
  const nodes = workflow && typeof workflow === 'object' && Array.isArray((workflow as { nodes?: unknown }).nodes) ? (workflow as { nodes: unknown[] }).nodes : [];
  const chains = new Set(nodes.slice(0, 64).flatMap(node => node && typeof node === 'object' && typeof (node as { chainId?: unknown }).chainId === 'string'
    ? [(node as { chainId: string }).chainId] : []));
  const networks = NETWORK_IDS.filter(id => chains.has(NETWORK_CHAINS[id]));
  if (!networks.length) return;
  const env = process.env;
  await prepareNetworkCatalogs({ version: 2, steps: networks.map(network => ({ network })) }, { solana: () => solanaAuthoringCatalog(env),
    ethereum: () => ethereumAuthoringCatalog(null, env), robinhood: () => robinhoodAuthoringCatalog(null, env), base: () => baseAuthoringCatalog(null, env),
    'arbitrum-one': () => arbitrumAuthoringCatalog(null, env) });
}
