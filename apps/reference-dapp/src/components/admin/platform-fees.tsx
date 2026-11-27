// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE): the Overview's platform fee section (server component, no client script). It states the
 * canonical policy (0.80% per completed workflow), why collection is off (the first missing activation condition), and the ledger's aggregate facts:
 * rows per state, the fee owed and not collected per exact asset (native units shown exactly, never converted into money or summed across
 * tokens), collected fees (only from rows that carry collection transactions) and completed, accounted executions by origin. No identifier leaves.
 */
import type { FeeTotals } from '../../platform-fee/ledger';
import type { FeeActivation } from '../../platform-fee/activation';
import { PLATFORM_FEE_PERCENT_LABEL } from '../../platform-fee/policy';
import { decimalOf } from '../../engine/workflow-bindings';
import { resolveNetworkAsset } from '../../domain/asset-catalogs';
import type { Language } from '../../i18n/language';
import { finopsCopy } from './finops-copy';

const COLLECTION_REASONS: Readonly<Record<string, string>> = {
  PLATFORM_FEE_COLLECTION_DISABLED: 'Collection is switched off.',
  PLATFORM_FEE_TREASURY_NOT_CONFIGURED: 'No treasury is configured.',
  PLATFORM_FEE_TREASURY_INVALID: 'The configured treasury is invalid.',
  PLATFORM_FEE_POLICY_NOT_APPROVED: 'The financial accounting policy is not approved.',
  PLATFORM_FEE_COLLECTOR_NOT_IMPLEMENTED: 'No collection mechanism is implemented yet.',
};
const ORIGIN_LABELS: Readonly<Record<string, string>> = { web: 'FloFi Web (Chat or Editor)', web_chat: 'FloFi Web (Chat or Editor)', web_editor: 'FloFi Web (Chat or Editor)',
  legacy_web: 'Legacy Web (recovered history)', mcp_chatgpt: 'ChatGPT MCP', mcp_claude: 'Claude MCP', mcp_other: 'Unidentified MCP client', telegram: 'Telegram',
  developer_api: 'Developer API', automation: 'Automation', unknown: 'Unknown origin', unrecorded: 'Unknown origin' };
const STATES = ['DUE', 'COLLECTION_PENDING', 'COLLECTED', 'COLLECTION_FAILED', 'NOT_APPLICABLE', 'WAIVED', 'UNSUPPORTED'] as const;
const STATE_LABELS: Readonly<Record<(typeof STATES)[number], string>> = { DUE: 'Owed, not collected', COLLECTION_PENDING: 'Collection pending', COLLECTED: 'Collected',
  COLLECTION_FAILED: 'Collection failed', NOT_APPLICABLE: 'No feeable principal', WAIVED: 'Waived (not completed)', UNSUPPORTED: 'Not accountable (never charged)' };

const assetLabel = (line: { chainId: string; address: string; decimals: number }) => {
  const symbol = line.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? 'ETH' : resolveNetworkAsset(line.chainId, { address: line.address })?.symbol;
  return `${symbol ?? line.address.slice(0, 6) + '…' + line.address.slice(-4)} · ${line.chainId}`;
};

export function PlatformFees({ totals, activation, eligibleCompleted, environment, language }: { totals: FeeTotals | null; activation: FeeActivation;
  eligibleCompleted: number; environment: string; language: Language }) {
  const { copy, count } = finopsCopy(language);
  const accountingFrom = activation.accounting.from?.toISOString().replace('T', ' ').slice(0, 16);
  return <section className="admin-card" aria-labelledby="admin-fees">
    <header><h2 id="admin-fees">{copy('Platform fee')}</h2><p>{copy('{0} per completed workflow, on its independently introduced principal', PLATFORM_FEE_PERCENT_LABEL)}</p></header>
    <div className="admin-table-wrap"><table className="admin-table"><tbody>
      <tr><th scope="row">{copy('Completed workflows (this range)')}</th><td className="num">{count(eligibleCompleted)} <span className="admin-badge">{environment}</span></td></tr>
      <tr><th scope="row">{copy('Fee accounting')}</th><td>{activation.accounting.active && accountingFrom
        ? copy('Active for executions created from {0} UTC', accountingFrom) : <span className="admin-badge" data-tone="warn">{copy('Not activated')}</span>}</td></tr>
      <tr><th scope="row">{copy('Fee collection')}</th><td><span className="admin-badge" data-tone="warn">{copy('Not active')}</span>{' '}
        {copy(COLLECTION_REASONS[activation.collection.code] ?? activation.collection.code)} <code>{activation.collection.code}</code></td></tr>
      {!totals ? <tr><th scope="row">{copy('Fee ledger')}</th><td><span className="admin-badge" data-tone="bad">{copy('Unavailable')}</span></td></tr>
        : !totals.migrated ? <tr><th scope="row">{copy('Fee ledger')}</th><td><span className="admin-badge">{copy('Not installed (migration 0037)')}</span></td></tr>
          : STATES.map(state => <tr key={state}><th scope="row">{copy(STATE_LABELS[state])}</th><td className="num">{count(totals.byState[state] ?? 0)}</td></tr>)}
    </tbody></table></div>
    {totals?.migrated && totals.dueByAsset.length ? <div className="admin-table-wrap"><table className="admin-table">
      <caption className="admin-sr">{copy('Fees owed and not collected, per asset')}</caption>
      <thead><tr><th scope="col">{copy('Asset')}</th><th scope="col" className="num">{copy('Owed, not collected')}</th><th scope="col" className="num">{copy('Executions')}</th></tr></thead>
      <tbody>{totals.dueByAsset.map(line => <tr key={line.chainId + line.address}><td>{assetLabel(line)}</td>
        <td className="num admin-mono">{decimalOf(BigInt(line.fee), line.decimals)}</td><td className="num">{count(line.executions)}</td></tr>)}</tbody>
    </table></div> : null}
    {totals?.migrated && Object.keys(totals.byOrigin).length ? <p className="admin-diff">{copy('Accounted executions by origin:')}{' '}
      {Object.entries(totals.byOrigin).map(([origin, n], i) => <span key={origin}>{i ? ' · ' : ''}{copy(ORIGIN_LABELS[origin] ?? 'Unknown origin')} {count(n ?? 0)}</span>)}</p> : null}
    <p className="admin-diff">{copy('Collected revenue is reported only from ledger rows that carry their collection transactions; until collection is active it is zero. ' +
      'Amounts stay in each token’s own units and are never added across tokens or converted to money here.')}</p>
  </section>;
}
