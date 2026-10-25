// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the capability matrix of the public, Mainnet-only product, generated from the certification matrix (one
 * truth for flows, web runtimes, channels and certification status), never kept by hand.
 *
 *  - `rows`: what the public product offers: every mainnet row (real funds), with its certification status unchanged. Whether a deployment
 *    actually runs a row is its own enablement and handoff policy, read live (MCP `get_capabilities`); code support is not deployment authority.
 *  - `perStepRows`: operations that apply to any network step (sequences): in the public product, to mainnet steps only.
 *  - `retired`: every test-network row. The public product neither offers nor executes them; their recorded runs, receipts and evidence stay
 *    readable, and their evidence never certifies a mainnet row.
 */
import { certificationMatrix, type CertificationRow, type Ledger, type LiveVerification } from './certification-matrix';
import { networkIdentity } from '../domain/network-registry';

export type RetiredRow = { readonly id: string; readonly action: string; readonly network: string; readonly destinationNetwork: string | null;
  readonly availability: 'TEST_NETWORK_NOT_AVAILABLE'; readonly history: 'READ_ONLY'; readonly previousStatus: CertificationRow['status'] };
export type MainnetProductMatrix = { readonly rows: readonly CertificationRow[]; readonly perStepRows: readonly CertificationRow[]; readonly retired: readonly RetiredRow[] };

/** The registry environments a row's network field names (a key, or a free-text list such as "base-sepolia, ethereum-sepolia (…)"). */
function environments(value: string | null): readonly string[] {
  if (!value) return [];
  const exact = networkIdentity(value);
  if (exact) return [exact.environment];
  return value.split(/[\s,()]+/).map(token => networkIdentity(token)?.environment).filter((environment): environment is 'MAINNET' | 'TESTNET' => Boolean(environment));
}
export function mainnetProductMatrix(ledger: Ledger, verification: LiveVerification): MainnetProductMatrix {
  const rows: CertificationRow[] = [], perStepRows: CertificationRow[] = [], retired: RetiredRow[] = [];
  for (const row of certificationMatrix(ledger, verification)) {
    const named = [...environments(row.network), ...environments(row.destinationNetwork)];
    if (named.includes('TESTNET')) retired.push({ id: row.id, action: row.action, network: row.network, destinationNetwork: row.destinationNetwork,
      availability: 'TEST_NETWORK_NOT_AVAILABLE', history: 'READ_ONLY', previousStatus: row.status });
    else if (named.length && named.every(environment => environment === 'MAINNET')) rows.push(row);
    // A sequence's steps are mainnet steps in the public product, so it moves real funds whatever its engineering certification used.
    else perStepRows.push({ ...row, funds: 'REAL_FUNDS' });
  }
  return { rows, perStepRows, retired };
}
